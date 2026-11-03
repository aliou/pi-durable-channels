import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createChannels } from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { inboundOf } from "./events";
import { httpEvents, slackChannel, slackTarget } from "./slack";
import { verifySlackSignature } from "./verify";

const SECRET = "slack-signing-secret";

type Call = { method: string; token: string; body: Record<string, unknown> };

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

async function fakeSlack(): Promise<{ apiUrl: string; calls: Call[] }> {
  const calls: Call[] = [];
  let ts = 100;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").replace(/^\/api\//, "");
      const token = request.headers.authorization ?? "";
      calls.push({
        method,
        token,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      const reply =
        method === "auth.test"
          ? { ok: true, user_id: "UBOT" }
          : { ok: true, ts: `${ts++}.000100` };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { apiUrl: `http://127.0.0.1:${port}/api`, calls };
}

function signed(body: unknown, options: { secret?: string; at?: number } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor((options.at ?? Date.now()) / 1000);
  const digest = createHmac("sha256", options.secret ?? SECRET)
    .update(`v0:${timestamp}:${raw}`)
    .digest("hex");
  return new Request("http://host/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${digest}`,
    },
    body: raw,
  });
}

const message = (fields: Record<string, unknown>) => ({
  type: "message",
  channel: "C1",
  user: "U1",
  ts: "200.000100",
  text: "hello",
  ...fields,
});

describe("slack events", () => {
  it("runs on a mention, stores other thread messages, and skips the rest", () => {
    expect(
      inboundOf(message({ thread_ts: "100.000100", text: "fyi" }), "UBOT"),
    ).toEqual({
      message: {
        address: "C1:100.000100",
        text: "fyi",
        requestId: "slack:C1:200.000100",
        author: "U1",
      },
      run: false,
    });
    expect(inboundOf(message({ text: "<@UBOT> help" }), "UBOT")).toEqual({
      message: {
        address: "C1:200.000100",
        text: "<@UBOT> help",
        requestId: "slack:C1:200.000100",
        author: "U1",
      },
      run: true,
    });
    expect(inboundOf(message({}), "UBOT")).toBeUndefined();
    expect(
      inboundOf(message({ thread_ts: "1.1", bot_id: "B1" }), "UBOT"),
    ).toBeUndefined();
    expect(
      inboundOf(
        message({ thread_ts: "1.1", subtype: "message_changed" }),
        "UBOT",
      ),
    ).toBeUndefined();
    expect(inboundOf({ type: "reaction_added" }, "UBOT")).toBeUndefined();
  });

  it("verifies the signature over the raw body and refuses stale requests", () => {
    const body = JSON.stringify({ a: 1 });
    const fresh = signed({ a: 1 });
    expect(verifySlackSignature(SECRET, fresh.headers, body)).toBe(true);
    expect(verifySlackSignature("other", fresh.headers, body)).toBe(false);
    expect(verifySlackSignature(SECRET, fresh.headers, `${body} `)).toBe(false);
    const stale = signed({ a: 1 }, { at: Date.now() - 600_000 });
    expect(verifySlackSignature(SECRET, stale.headers, body)).toBe(false);
    expect(verifySlackSignature(SECRET, new Headers(), body)).toBe(false);
  });

  it("targets a thread from the address or the stored thread, else the channel", () => {
    expect(slackTarget("C1:100.000100", undefined)).toEqual({
      channel: "C1",
      threadTs: "100.000100",
    });
    expect(slackTarget("C1:cus_acme", undefined)).toEqual({ channel: "C1" });
    expect(slackTarget("C1:cus_acme", { threadTs: "5.5" })).toEqual({
      channel: "C1",
      threadTs: "5.5",
    });
    expect(() => slackTarget("cus_acme", undefined)).toThrow("<channel>");
  });
});

describe("slack channel end to end", () => {
  async function open() {
    const { apiUrl, calls } = await fakeSlack();
    const slack = slackChannel({
      botToken: "xoxb-test",
      transport: httpEvents(SECRET),
      apiUrl,
    });
    const channels = createChannels({
      channels: {
        slack: {
          adapter: slack,
          conversation: () => ({
            agent: { model: { provider: "faux", modelId: "faux-1" } },
          }),
        },
      },
    });
    const seen: string[][] = [];
    const answer: FauxResponseFactory = (transcript) => {
      const users = transcript.messages.flatMap((each) =>
        each.role === "user" && typeof each.content === "string"
          ? [each.content]
          : [],
      );
      seen.push(users);
      return fauxAssistantMessage(`re: ${users.at(-1)}`);
    };
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 20 }, () => answer));
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(channels.extension);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      context,
    );
    const hub = channels.hub(harness);
    return { slack, hub, harness, calls, seen };
  }

  const posts = (calls: Call[]) =>
    calls
      .filter(({ method }) => method === "chat.postMessage")
      .map(({ body }) => body);

  it("answers 503 before start", async () => {
    const { slack, harness } = await open();
    const response = await slack.fetch(signed({ type: "url_verification" }));
    expect(response.status).toBe(503);
    await harness.close(context);
  });

  it("opens a case thread, then follows the thread: notes as context, mentions as questions", async () => {
    const { slack, hub, harness, calls, seen } = await open();
    await hub.start();
    expect(calls[0]).toMatchObject({
      method: "auth.test",
      token: "Bearer xoxb-test",
    });

    const challenge = await slack.fetch(
      signed({ type: "url_verification", challenge: "c-1" }),
    );
    await expect(challenge.json()).resolves.toEqual({ challenge: "c-1" });
    const forged = await slack.fetch(
      signed({ type: "url_verification", challenge: "c-1" }, { secret: "x" }),
    );
    expect(forged.status).toBe(401);

    const signal = (id: string) =>
      hub.deliver("slack", {
        address: "C1:cus_acme",
        text: `payment failed ${id}`,
        requestId: `stripe:${id}`,
        author: "stripe",
      });
    const first = await signal("evt_1");
    if (first === undefined) throw new Error("case was ignored");
    await harness.waitForIdle(context);
    await signal("evt_2");
    await harness.waitForIdle(context);
    expect(posts(calls)).toEqual([
      { channel: "C1", markdown_text: "re: payment failed evt_1" },
      {
        channel: "C1",
        markdown_text: "re: payment failed evt_2",
        thread_ts: "100.000100",
      },
    ]);

    const event = (fields: Record<string, unknown>) =>
      slack.fetch(
        signed({
          type: "event_callback",
          event_id: "Ev1",
          event: message({ thread_ts: "100.000100", ...fields }),
        }),
      );
    const note = await event({ ts: "300.1", text: "they emailed us" });
    const question = await event({ ts: "300.2", text: "<@UBOT> next step?" });
    const retried = await event({ ts: "300.2", text: "<@UBOT> next step?" });
    expect([note.status, question.status, retried.status]).toEqual([
      200, 200, 200,
    ]);
    await harness.waitForIdle(context);

    expect(posts(calls).slice(2)).toEqual([
      {
        channel: "C1",
        markdown_text: "re: <@UBOT> next step?",
        thread_ts: "100.000100",
      },
    ]);
    expect(seen.at(-1)).toEqual([
      "payment failed evt_1",
      "payment failed evt_2",
      "they emailed us",
      "<@UBOT> next step?",
    ]);
    await expect(hub.status(first.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });
});
