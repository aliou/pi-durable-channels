import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { ChannelAdapter } from "@aliou/pi-durable-channels";
import { afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

export const SECRET = "slack-signing-secret";

export type Call = {
  method: string;
  token: string;
  body: Record<string, unknown>;
};

export type FakeSocket = {
  log: string[];
  send(frame: unknown, connection?: number): void;
  close(): void;
};

export type FakeSlack = {
  apiUrl: string;
  origin: string;
  calls: Call[];
  socket: FakeSocket;
};

export type FakeOptions = {
  refuse?: string[];
  postErrors?: string[];
  postStatus?: number;
  hello?: boolean;
  dropAfterMs?: number;
  holdFiles?: Promise<void>;
};

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

function reply(
  method: string,
  host: string,
  ts: () => string,
): Record<string, unknown> {
  if (method === "auth.test") return { ok: true, user_id: "UBOT" };
  if (method === "apps.connections.open")
    return { ok: true, url: `ws://${host}/socket` };
  return { ok: true, ts: ts() };
}

function dropLikeSlack(socket: WsSocket, afterMs: number): void {
  const raw = (socket as unknown as { _socket: Socket })._socket;
  socket.close = () => {
    const timer = setTimeout(() => raw.destroy(), afterMs);
    raw.once("close", () => clearTimeout(timer));
  };
}

function socketMode(
  sockets: WebSocketServer,
  options: FakeOptions,
): FakeSocket {
  const log: string[] = [];
  const clients: WsSocket[] = [];
  sockets.on("connection", (socket) => {
    clients.push(socket);
    log.push("connected");
    if (options.dropAfterMs !== undefined)
      dropLikeSlack(socket, options.dropAfterMs);
    if (options.hello ?? true) socket.send(JSON.stringify({ type: "hello" }));
    socket.on("message", (data) => {
      log.push(`ack ${JSON.parse(String(data)).envelope_id}`);
    });
    socket.on("close", () => log.push("closed"));
  });
  return {
    log,
    send: (frame, connection = clients.length - 1) =>
      clients[connection]?.send(JSON.stringify(frame)),
    close: () => clients.at(-1)?.close(),
  };
}

export async function fakeSlack(
  files: Record<string, string> = {},
  options: FakeOptions = {},
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
        void (options.holdFiles ?? Promise.resolve()).then(() => {
          response.writeHead(200);
          response.end(file);
        });
        return;
      }
      const method = path.replace(/^\/api\//, "");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ method, token, body });
      if (method === "chat.postMessage" && options.postStatus !== undefined) {
        response.writeHead(options.postStatus);
        response.end();
        return;
      }
      const postError =
        method === "chat.postMessage" ? options.postErrors?.shift() : undefined;
      const answer = postError
        ? { ok: false, error: postError }
        : options.refuse?.includes(method)
          ? { ok: false, error: "invalid_auth" }
          : reply(method, request.headers.host ?? "", ts);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  const sockets = new WebSocketServer({ server, path: "/socket" });
  const socket = socketMode(sockets, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { apiUrl: `${origin}/api`, origin, calls, socket };
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

export async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
