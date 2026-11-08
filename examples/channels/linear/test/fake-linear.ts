import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelAdapter } from "@aliou/pi-durable-channels";
import { afterEach } from "vitest";

export const SECRET = "linear-webhook-secret";
export const APP_USER_ID = "9f1d2b3c-0000-4000-8000-000000000001";

export type Call = {
  query: string;
  variables: unknown;
  token: string;
};

export type Answer = { status: number; body?: unknown };

export type Route = (variables: unknown, calls: Call[]) => Answer;

export type FakeLinear = { apiUrl: string; calls: Call[] };

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

const DEFAULT_ROUTES: Record<string, Route> = {
  "viewer { id }": () => ({
    status: 200,
    body: { data: { viewer: { id: APP_USER_ID } } },
  }),
  AgentActivityCreate: () => ({
    status: 200,
    body: {
      data: {
        agentActivityCreate: { success: true, agentActivity: { id: "a1" } },
      },
    },
  }),
};

function parse(raw: string): unknown {
  return raw === "" ? undefined : JSON.parse(raw);
}

export async function fakeLinear(
  routes: Record<string, Route> = {},
): Promise<FakeLinear> {
  const calls: Call[] = [];
  const all = { ...DEFAULT_ROUTES, ...routes };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = parse(Buffer.concat(chunks).toString()) as
        | { query?: string; variables?: unknown }
        | undefined;
      const call: Call = {
        query: body?.query ?? "",
        variables: body?.variables,
        token: request.headers.authorization ?? "",
      };
      calls.push(call);
      const route = Object.entries(all).find(([key]) =>
        call.query.includes(key),
      )?.[1];
      const answer = route?.(call.variables, calls) ?? {
        status: 200,
        body: {
          errors: [{ message: `unrouted query: ${call.query.slice(0, 60)}` }],
        },
      };
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
  payload: unknown,
  options: {
    event?: string;
    delivery?: string;
    secret?: string;
    timestamp?: number;
    signature?: string | null;
  } = {},
): Request {
  const raw = JSON.stringify(payload);
  const digest = createHmac("sha256", options.secret ?? SECRET)
    .update(raw)
    .digest("hex");
  const headers: Record<string, string> = {
    "linear-event": options.event ?? "AgentSessionEvent",
    "linear-delivery": options.delivery ?? crypto.randomUUID(),
    "linear-signature": options.signature ?? digest,
    "linear-timestamp": String(options.timestamp ?? Date.now()),
  };
  if (options.signature === null) delete headers["linear-signature"];
  return new Request("http://host/linear/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

export function served(
  adapter: ChannelAdapter,
): (request: Request) => Promise<Response> {
  if (adapter.fetch === undefined) throw new Error("The adapter has no fetch");
  return adapter.fetch;
}

const SESSION_ID = "51a2b3c4-0000-4000-8000-00000000abcd";

const issue = {
  id: "issue-1",
  identifier: "ENG-123",
  title: "Fix the login crash",
  description: "Users cannot log in.",
};

const user = (name: string) => ({ id: `u-${name}`, name, displayName: name });

export const payloads = {
  sessionId: SESSION_ID,
  created: (overrides: Record<string, unknown> = {}) => ({
    type: "AgentSessionEvent",
    action: "created",
    appUserId: APP_USER_ID,
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    createdAt: new Date().toISOString(),
    agentSession: {
      id: SESSION_ID,
      appUserId: APP_USER_ID,
      issue,
      creator: user("ana"),
    },
    promptContext: `<issue identifier="ENG-123"><title>Fix the login crash</title></issue>`,
    ...overrides,
  }),
  prompted: (body: string, overrides: Record<string, unknown> = {}) => ({
    type: "AgentSessionEvent",
    action: "prompted",
    appUserId: APP_USER_ID,
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    createdAt: new Date().toISOString(),
    agentSession: { id: SESSION_ID, appUserId: APP_USER_ID, issue },
    agentActivity: {
      id: crypto.randomUUID(),
      content: { type: "prompt", body },
      user: user("ana"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  }),
  comment: () => ({
    type: "Comment",
    action: "create",
    data: { id: "c1", body: "hello" },
    url: "https://linear.app/acme/issue/ENG-1#comment-c1",
    createdAt: new Date().toISOString(),
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
  }),
};
