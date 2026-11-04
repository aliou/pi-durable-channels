import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelAdapter } from "@aliou/pi-durable-channels";
import { afterEach } from "vitest";

export const SECRET = "github-webhook-secret";
export const BOT = "factory-bot";

export type Call = {
  method: string;
  path: string;
  token: string;
  body: unknown;
};

export type Answer = { status: number; body?: unknown };

export type Route = (body: unknown, calls: Call[]) => Answer;

export type FakeGitHub = { apiUrl: string; calls: Call[] };

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

const DEFAULT_ROUTES: Record<string, Route> = {
  "GET /user": () => ({ status: 200, body: { login: BOT } }),
};

function parse(raw: string): unknown {
  return raw === "" ? undefined : JSON.parse(raw);
}

export async function fakeGitHub(
  routes: Record<string, Route> = {},
): Promise<FakeGitHub> {
  const calls: Call[] = [];
  const all = { ...DEFAULT_ROUTES, ...routes };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const call = {
        method: request.method ?? "GET",
        path: request.url ?? "",
        token: request.headers.authorization ?? "",
        body: parse(Buffer.concat(chunks).toString()),
      };
      calls.push(call);
      const route =
        all[`${call.method} ${call.path}`] ??
        all[`${call.method} ${call.path.split("?")[0]}`];
      const answer = route?.(call.body, calls) ?? { status: 201, body: {} };
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { apiUrl: `http://127.0.0.1:${port}`, calls };
}

export function webhook(
  event: string,
  payload: unknown,
  options: { delivery?: string; secret?: string } = {},
): Request {
  const raw = JSON.stringify(payload);
  const digest = createHmac("sha256", options.secret ?? SECRET)
    .update(raw)
    .digest("hex");
  return new Request("http://host/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": options.delivery ?? crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${digest}`,
    },
    body: raw,
  });
}

const repository = { full_name: "acme/app" };
const user = (login: string) => ({ login, type: "User" });

export const payloads = {
  issueOpened: (number: number, title = "Crash on save") => ({
    action: "opened",
    issue: {
      number,
      title,
      body: "Steps: save twice.",
      html_url: `https://github.com/acme/app/issues/${number}`,
      user: user("ana"),
    },
    repository,
  }),
  comment: (number: number, body: string, login = "ana") => ({
    action: "created",
    issue: { number, pull_request: {} },
    comment: {
      body,
      html_url: `https://github.com/acme/app/pull/${number}#c`,
      user: user(login),
    },
    repository,
  }),
  reviewComment: (number: number, body: string) => ({
    action: "created",
    pull_request: { number },
    comment: {
      body,
      path: "src/save.ts",
      line: 12,
      html_url: `https://github.com/acme/app/pull/${number}#r`,
      user: user("ana"),
    },
    repository,
  }),
  review: (number: number, state: string, body: string | null) => ({
    action: "submitted",
    pull_request: { number },
    review: {
      id: 900 + number,
      body,
      state,
      html_url: `https://github.com/acme/app/pull/${number}#v`,
      user: user("ana"),
    },
    repository,
  }),
  workflowFailed: (numbers: number[]) => ({
    action: "completed",
    workflow_run: {
      name: "ci",
      conclusion: "failure",
      head_branch: "factory/abc",
      html_url: "https://github.com/acme/app/actions/runs/1",
      pull_requests: numbers.map((number) => ({ number })),
    },
    repository,
  }),
};

export function served(
  adapter: ChannelAdapter,
): (request: Request) => Promise<Response> {
  if (adapter.fetch === undefined) throw new Error("The adapter has no fetch");
  return adapter.fetch;
}
