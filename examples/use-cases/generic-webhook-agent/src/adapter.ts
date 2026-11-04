import { createHash } from "node:crypto";
import type { ChannelAdapter, Deliver } from "@aliou/pi-durable-channels";
import { postTo } from "@examples/shared/sink";

export type InboxChannelOptions = { pagerUrl: string | undefined };

const DELIVERY_ID_HEADERS = [
  "x-github-delivery",
  "webhook-id",
  "x-request-id",
  "idempotency-key",
  "x-gitlab-event-uuid",
];
const SHOWN_HEADERS = [
  "content-type",
  "user-agent",
  "x-github-event",
  "x-gitlab-event",
  "sentry-hook-resource",
];
const MAX_BODY = 20_000;

function requestIdOf(headers: Headers, body: string): string {
  const header = DELIVERY_ID_HEADERS.map((name) => headers.get(name)).find(
    (value) => value !== null,
  );
  return header ?? `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function describe(source: string, headers: Headers, body: string): string {
  const shown = SHOWN_HEADERS.flatMap((name) => {
    const value = headers.get(name);
    return value === null ? [] : [`${name}: ${value}`];
  });
  const truncated =
    body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[truncated]` : body;
  return [
    `Webhook from ${source} at ${new Date().toISOString()}`,
    ...shown,
    "",
    truncated,
  ].join("\n");
}

async function receive(request: Request, deliver: Deliver): Promise<Response> {
  const body = await request.text();
  const source = new URL(request.url).searchParams.get("source") ?? "default";
  const receipt = await deliver({
    address: source,
    text: describe(source, request.headers, body),
    requestId: requestIdOf(request.headers, body),
    author: source,
  });
  return Response.json(receipt ?? { ignored: true }, { status: 202 });
}

export function inboxChannel(options: InboxChannelOptions): ChannelAdapter {
  let deliver: Deliver | undefined;
  return {
    start: (ctx) => {
      deliver = ctx.deliver;
    },
    fetch: async (request) =>
      deliver === undefined
        ? new Response("Service Unavailable", { status: 503 })
        : receive(request, deliver),
    send: postTo(options.pagerUrl),
  };
}
