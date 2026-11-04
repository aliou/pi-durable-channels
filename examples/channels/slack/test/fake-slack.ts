import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelAdapter } from "@aliou/pi-durable-channels";
import { afterEach } from "vitest";

export const SECRET = "slack-signing-secret";

export type Call = {
  method: string;
  token: string;
  body: Record<string, unknown>;
};

export type FakeSlack = { apiUrl: string; origin: string; calls: Call[] };

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

function reply(method: string, ts: () => string): Record<string, unknown> {
  if (method === "auth.test") return { ok: true, user_id: "UBOT" };
  return { ok: true, ts: ts() };
}

export async function fakeSlack(
  files: Record<string, string> = {},
): Promise<FakeSlack> {
  const calls: Call[] = [];
  let next = 100;
  const ts = () => `${next++}.000100`;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      const token = request.headers.authorization ?? "";
      const file = files[path];
      if (file !== undefined) {
        calls.push({ method: `GET ${path}`, token, body: {} });
        response.writeHead(200);
        response.end(file);
        return;
      }
      const method = path.replace(/^\/api\//, "");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ method, token, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply(method, ts)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { apiUrl: `${origin}/api`, origin, calls };
}

export function signed(
  body: unknown,
  options: { secret?: string; at?: number } = {},
): Request {
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

export const message = (fields: Record<string, unknown>) => ({
  type: "message",
  channel: "C1",
  user: "U1",
  ts: "200.000100",
  text: "hello",
  ...fields,
});

export function served(
  adapter: ChannelAdapter,
): (request: Request) => Promise<Response> {
  if (adapter.fetch === undefined) throw new Error("The adapter has no fetch");
  return adapter.fetch;
}
