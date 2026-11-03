import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createChannels,
  type Deliver,
  type DeliveryReceipt,
  type InboundMessage,
  type OutboundPart,
  type SendContext,
} from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { allowOrigins } from "./origins";
import { bearerToken, webhook } from "./webhook";

type Received = { path: string; headers: IncomingHttpHeaders; body: unknown };

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

async function receiver(
  status = 200,
  location?: string,
): Promise<{ origin: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        body: raw === "" ? undefined : JSON.parse(raw),
      });
      response
        .writeHead(status, location === undefined ? {} : { location })
        .end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, received };
}

const receipt = {
  submissionId: 3,
  conversationId: "c1",
} as unknown as DeliveryReceipt;

function recorder() {
  const delivered: InboundMessage[] = [];
  const deliver = async (message: InboundMessage) => {
    delivered.push(message);
    return receipt;
  };
  return { delivered, deliver };
}

function post(body: string, token = "s3cret-s3cret-s3cret"): Request {
  return new Request("http://host/hooks/journal", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
}

const message = {
  address: "thread-1",
  text: "hello",
  requestId: "evt-1",
  author: "ana",
};

describe("webhook fetch", () => {
  const adapter = webhook({
    verify: bearerToken("s3cret-s3cret-s3cret"),
    allowedOrigins: ["https://acme.test"],
    maxBodyBytes: 512,
  });
  const route = {
    handle: async (request: Request, ctx: { deliver: Deliver }) => {
      await adapter.start?.({
        ...ctx,
        cancel: async () => undefined,
        signal: new AbortController().signal,
      });
      return adapter.fetch(request);
    },
  };

  it("answers 503 until the hub starts the adapter", async () => {
    const idle = webhook({ verify: () => true, allowedOrigins: [] });
    const response = await idle.fetch(post(JSON.stringify(message)));
    expect(response.status).toBe(503);
  });

  it("delivers a verified message and answers 202 with the receipt", async () => {
    const { delivered, deliver } = recorder();
    const body = {
      ...message,
      replyUrl: "https://acme.test/r",
      callbackUrl: "https://acme.test/c",
    };
    const response = await route.handle(post(JSON.stringify(body)), {
      deliver,
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(receipt);
    expect(delivered).toEqual([
      {
        ...message,
        replyContext: { replyUrl: "https://acme.test/r" },
        addressData: { callbackUrl: "https://acme.test/c" },
      },
    ]);
  });

  it("refuses bearer tokens too short to resist guessing", () => {
    expect(() => bearerToken("")).toThrow("at least 16");
  });

  it("rejects an unverified request with 401, before reading it as a message", async () => {
    const { delivered, deliver } = recorder();
    const wrong = await route.handle(post(JSON.stringify(message), "guess"), {
      deliver,
    });
    const missing = await route.handle(
      new Request("http://host/hooks/journal", { method: "POST", body: "{}" }),
      {
        deliver,
      },
    );
    expect([wrong.status, missing.status]).toEqual([401, 401]);
    expect(delivered).toEqual([]);
  });

  it("rejects a body over the size limit with 413", async () => {
    const { delivered, deliver } = recorder();
    const response = await route.handle(
      post(JSON.stringify({ ...message, text: "x".repeat(600) })),
      { deliver },
    );
    expect(response.status).toBe(413);
    expect(delivered).toEqual([]);
  });

  it("rejects invalid bodies and reply URLs outside the allowed origins with 400", async () => {
    const { delivered, deliver } = recorder();
    const bodies = [
      "hello",
      JSON.stringify({ address: "thread-1", text: "hi" }),
      JSON.stringify({
        ...message,
        replyUrl: "http://169.254.169.254/latest/meta-data",
      }),
      JSON.stringify({
        ...message,
        callbackUrl: "https://acme.test.evil.example/c",
      }),
      JSON.stringify({ ...message, replyUrl: "https://user:pass@acme.test/r" }),
    ];
    const statuses = [];
    for (const body of bodies) {
      const response = await route.handle(post(body), { deliver });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400]);
    expect(delivered).toEqual([]);
  });
});

describe("webhook send", () => {
  const parts: OutboundPart[] = [
    { type: "text", text: "hello " },
    { type: "image", url: "x" } as unknown as OutboundPart,
    { type: "text", text: "there" },
  ];

  function adapterFor(origin: string) {
    return webhook({
      verify: () => true,
      allowedOrigins: [origin],
    });
  }

  function sendContext(ctx: Partial<SendContext>): SendContext {
    return {
      idempotencyKey: "reply:7",
      signal: new AbortController().signal,
      ...ctx,
    };
  }

  it("posts the text parts to the reply URL with the idempotency key", async () => {
    const { origin, received } = await receiver();
    await adapterFor(origin).send(
      { address: "thread-1", parts },
      sendContext({
        replyContext: { replyUrl: `${origin}/reply` },
        addressData: { callbackUrl: `${origin}/other` },
      }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/reply");
    expect(received[0]?.headers["idempotency-key"]).toBe("reply:7");
    expect(received[0]?.body).toEqual({
      address: "thread-1",
      text: "hello there",
    });
  });

  it("falls back to the address callback URL for proactive sends", async () => {
    const { origin, received } = await receiver();
    await adapterFor(origin).send(
      { address: "thread-1", parts },
      sendContext({ addressData: { callbackUrl: `${origin}/c` } }),
    );
    expect(received.map(({ path }) => path)).toEqual(["/c"]);
  });

  it("sends nothing when no part is supported", async () => {
    const { origin, received } = await receiver();
    const image = [{ type: "image", url: "x" } as unknown as OutboundPart];
    await adapterFor(origin).send(
      { address: "thread-1", parts: image },
      sendContext({ replyContext: { replyUrl: origin } }),
    );
    expect(received).toEqual([]);
  });

  it("refuses a URL outside the allowed origins without connecting", async () => {
    const { origin, received } = await receiver();
    await expect(
      adapterFor("https://acme.test").send(
        { address: "thread-1", parts },
        sendContext({ replyContext: { replyUrl: origin } }),
      ),
    ).rejects.toThrow("not an allowed origin");
    expect(received).toEqual([]);
  });

  it("does not follow redirects, and keeps URLs out of errors", async () => {
    const target = await receiver();
    const redirecting = await receiver(302, `${target.origin}/internal`);
    const adapter = webhook({
      verify: () => true,
      allowedOrigins: [redirecting.origin, target.origin],
    });
    const sent = adapter.send(
      { address: "thread-1", parts },
      sendContext({
        replyContext: { replyUrl: `${redirecting.origin}/secret-token` },
      }),
    );
    await expect(sent).rejects.toThrow("Webhook reply request failed");
    await sent.catch((error: Error) =>
      expect(error.message).not.toContain("secret-token"),
    );
    expect(target.received).toEqual([]);
  });

  it("fails without a URL and when the receiver rejects the reply", async () => {
    const { origin } = await receiver(500);
    const adapter = adapterFor(origin);
    await expect(
      adapter.send({ address: "thread-1", parts }, sendContext({})),
    ).rejects.toThrow("No replyUrl or callbackUrl");
    await expect(
      adapter.send(
        { address: "thread-1", parts },
        sendContext({ replyContext: { replyUrl: origin } }),
      ),
    ).rejects.toThrow("status 500");
  });
});

describe("allowed origins", () => {
  it("matches exact origins, including scheme and port", () => {
    const allowed = allowOrigins([
      "https://hooks.acme.test",
      "http://localhost:8793",
    ]);
    expect(allowed("https://hooks.acme.test/a/b?c=1")).toBe(true);
    expect(allowed("http://localhost:8793/sink")).toBe(true);
    expect(allowed("http://hooks.acme.test/a")).toBe(false);
    expect(allowed("https://hooks.acme.test:8443/a")).toBe(false);
    expect(allowed("http://localhost:8794/sink")).toBe(false);
    expect(allowed("https://hooks.acme.test.evil.example/a")).toBe(false);
    expect(allowed("not a url")).toBe(false);
  });

  it("matches exactly one label under a wildcard", () => {
    const allowed = allowOrigins(["https://*.preview.acme.test"]);
    expect(allowed("https://pr-12.preview.acme.test/hook")).toBe(true);
    expect(allowed("https://preview.acme.test/hook")).toBe(false);
    expect(allowed("https://a.b.preview.acme.test/hook")).toBe(false);
    expect(allowed("http://pr-12.preview.acme.test/hook")).toBe(false);
    expect(allowed("https://pr-12.preview.acme.test:8443/hook")).toBe(false);
  });

  it("rejects entries that are not bare origins or have a loose wildcard", () => {
    for (const entry of [
      "https://acme.test/path",
      "https://user@acme.test",
      "ftp://acme.test",
      "https://*.test",
      "https://*.acme.test.",
      "https://a.*.acme.test",
      "nope",
    ]) {
      expect(() => allowOrigins([entry]), entry).toThrow("Allowed origins");
    }
  });
});

describe("webhook channel end to end", () => {
  it("turns a verified request into one run and posts the answer back to the reply URL", async () => {
    const { origin, received } = await receiver();
    const web = webhook({
      verify: bearerToken("s3cret-s3cret-s3cret"),
      allowedOrigins: [origin],
    });
    const channels = createChannels({
      channels: {
        web: {
          adapter: web,
          conversation: () => ({
            agent: { model: { provider: "faux", modelId: "faux-1" } },
          }),
        },
      },
    });
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("noted")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(channels.extension);
    registry.install(channels.tools);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      context,
    );
    const hub = channels.hub(harness);
    await hub.start();

    const body = JSON.stringify({ ...message, replyUrl: `${origin}/reply` });
    const first = await web.fetch(post(body));
    const retry = await web.fetch(post(body));
    const forged = await web.fetch(post(body, "guess"));
    expect([first.status, retry.status, forged.status]).toEqual([
      202, 202, 401,
    ]);
    const json: unknown = await first.json();
    const accepted = json as DeliveryReceipt;
    await expect(retry.json()).resolves.toEqual(accepted);

    await harness.waitForIdle(context);
    expect(received.map(({ path, body }) => [path, body])).toEqual([
      ["/reply", { address: "thread-1", text: "noted" }],
    ]);
    expect(received[0]?.headers["idempotency-key"]).toMatch(/^reply:/);
    await expect(hub.status(accepted.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });
});
