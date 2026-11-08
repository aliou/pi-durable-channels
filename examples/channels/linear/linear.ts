import type {
  AdapterStart,
  ChannelAdapter,
  ChannelEvent,
  Deliver,
  OutboundMessage,
  ReplyTarget,
  SendContext,
} from "@aliou/pi-durable-channels";
import { compile, obj, str } from "@earendil-works/pi-schema";
import { parseSessionAddress } from "./address";
import { LINEAR_API, type LinearCall, linearApi } from "./api";
import { parseJson, readBody } from "./body";
import { inboundOf } from "./events";
import { isStaleTimestamp, verifyLinearSignature } from "./verify";

export type LinearOptions = {
  token: string;
  webhookSecret: string;
  apiUrl?: string;
  maxBodyBytes?: number;
  timestampWindowMs?: number;
};

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_ACTIVITY = 10_000;
const MAX_ACTION = 200;

const TIMESTAMP_WINDOW_MS = 7 * 60 * 60 * 1000;

const VIEWER_QUERY = "query { viewer { id } }";

const ACTIVITY_MUTATION = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity { id }
  }
}`;

const Viewer = compile(obj({ viewer: obj({ id: str() }, { open: true }) }));

type Receiver = {
  deliver: Deliver;
  cancel: AdapterStart["cancel"];
  report: AdapterStart["report"];
};

function textOf(message: OutboundMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function preview(value: unknown, limit: number): string {
  const text = JSON.stringify(value) ?? "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function linearChannel(options: LinearOptions): ChannelAdapter {
  const call: LinearCall = linearApi(
    options.token,
    options.apiUrl ?? LINEAR_API,
  );
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const windowMs = options.timestampWindowMs ?? TIMESTAMP_WINDOW_MS;
  let receiver: Receiver | undefined;
  const seenEvents = new Set<string>();

  const activity = (
    sessionId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    call(
      ACTIVITY_MUTATION,
      { input: { agentSessionId: sessionId, ...input } },
      signal,
    );

  function remember(key: string): boolean {
    if (seenEvents.has(key)) return false;
    if (seenEvents.size > 10_000) seenEvents.clear();
    seenEvents.add(key);
    return true;
  }

  async function receive(request: Request, to: Receiver): Promise<Response> {
    const raw = await readBody(request, maxBodyBytes);
    if (raw === undefined)
      return new Response("Payload Too Large", { status: 413 });
    if (
      !verifyLinearSignature(
        options.webhookSecret,
        request.headers.get("linear-signature"),
        raw,
      )
    )
      return new Response("Unauthorized", { status: 401 });
    const sent = Number(request.headers.get("linear-timestamp"));
    if (!Number.isFinite(sent) || isStaleTimestamp(sent, Date.now(), windowMs))
      return new Response("Unauthorized", { status: 401 });
    const delivery = request.headers.get("linear-delivery") ?? "";
    const payload = parseJson(raw);
    if (delivery === "" || payload === undefined)
      return new Response("Bad Request", { status: 400 });
    const inbounds = inboundOf(payload, `linear:${delivery}`);
    if (inbounds.length === 0)
      to.report({ kind: "skipped", detail: `${typeOf(payload)} ${delivery}` });
    for (const inbound of inbounds) {
      if (inbound.kind === "stop") await to.cancel(inbound.address);
      else await to.deliver(inbound.message, inbound.options);
    }
    return new Response(null, { status: 202 });
  }

  async function send(
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<undefined> {
    const text = textOf(message).trim();
    if (text === "") return;
    await activity(
      parseSessionAddress(message.address),
      { content: { type: "response", body: text.slice(0, MAX_ACTIVITY) } },
      ctx.signal,
    );
  }

  async function events(target: ReplyTarget, event: ChannelEvent) {
    const sessionId = parseSessionAddress(target.address);
    if (event.type === "run_started") {
      if (!remember(`${event.type}:${target.idempotencyKey}`)) return;
      await activity(sessionId, {
        content: { type: "thought", body: "Thinking…" },
        ephemeral: true,
      });
      return;
    }
    if (event.type === "run_ended") {
      if (!remember(`${event.type}:${target.idempotencyKey}`)) return;
      if (event.outcome === "failed")
        await activity(sessionId, {
          content: { type: "error", body: "The run failed." },
        });
      if (event.outcome === "aborted")
        await activity(sessionId, {
          content: { type: "response", body: "Stopped." },
        });
      return;
    }
    if (!remember(`${event.type}:${event.id}`)) return;
    if (event.type === "text")
      await activity(sessionId, {
        content: { type: "thought", body: event.text.slice(0, MAX_ACTIVITY) },
      });
    if (event.type === "tool_started")
      await activity(sessionId, {
        content: {
          type: "action",
          action: event.name,
          parameter: preview(event.args, MAX_ACTION),
        },
        ephemeral: true,
      });
    if (event.type === "tool_finished")
      await activity(sessionId, {
        content: {
          type: "action",
          action: event.name,
          parameter: "",
          result: event.isError
            ? `Failed: ${event.output.slice(0, MAX_ACTIVITY)}`
            : event.output.slice(0, MAX_ACTIVITY),
        },
      });
  }

  return {
    start: async (ctx) => {
      const viewer = await call(VIEWER_QUERY, undefined, ctx.signal);
      if (!Viewer.check(viewer) || viewer.viewer.id === "")
        throw new Error("Linear API did not return the app user's id");
      receiver = {
        deliver: ctx.deliver,
        cancel: ctx.cancel,
        report: ctx.report,
      };
    },
    fetch: async (request) =>
      receiver === undefined
        ? new Response("Service Unavailable", { status: 503 })
        : receive(request, receiver),
    send,
    events,
  };
}

function typeOf(payload: unknown): string {
  return typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    typeof payload.type === "string"
    ? payload.type
    : "unknown";
}
