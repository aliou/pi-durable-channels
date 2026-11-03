import type {
  ChannelAdapter,
  OutboundMessage,
  SendContext,
  SendResult,
} from "@aliou/pi-durable-channels";
import type { JsonValue } from "@earendil-works/chord";
import { compile, lit, obj, str, unknown } from "@earendil-works/pi-schema";
import { slackApi } from "./api";
import { parseJson, readBody } from "./body";
import { inboundOf } from "./events";
import { runSocketMode } from "./socket";
import { verifySlackSignature } from "./verify";

export type SlackTransport =
  | { kind: "socket"; appToken: string }
  | { kind: "http"; signingSecret: string };

export const socketMode = (appToken: string): SlackTransport => ({
  kind: "socket",
  appToken,
});

export const httpEvents = (signingSecret: string): SlackTransport => ({
  kind: "http",
  signingSecret,
});

export type SlackOptions = {
  botToken: string;
  transport: SlackTransport;
  apiUrl?: string;
  maxBodyBytes?: number;
};

export type SlackChannel = ChannelAdapter & {
  fetch(request: Request): Promise<Response>;
};

type OnEvent = (event: unknown) => Promise<void>;

const SLACK_API = "https://slack.com/api";
const MAX_TEXT = 12_000;
const MAX_BODY_BYTES = 1024 * 1024;
const THREAD_TS = /^\d+\.\d+$/;

const ThreadData = compile(obj({ threadTs: str() }));
const Auth = compile(obj({ user_id: str() }, { open: true }));
const Connection = compile(obj({ url: str() }, { open: true }));
const Posted = compile(obj({ ts: str() }, { open: true }));
const UrlVerification = compile(
  obj({ type: lit("url_verification"), challenge: str() }, { open: true }),
);
const EventCallback = compile(
  obj({ type: lit("event_callback"), event: unknown() }, { open: true }),
);

function textOf(message: OutboundMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

export function slackTarget(
  address: string,
  addressData: JsonValue | undefined,
): { channel: string; threadTs?: string } {
  const separator = address.indexOf(":");
  if (separator < 1)
    throw new Error("Slack addresses look like <channel>:<thread ts or key>");
  const channel = address.slice(0, separator);
  const rest = address.slice(separator + 1);
  if (ThreadData.check(addressData))
    return { channel, threadTs: addressData.threadTs };
  return THREAD_TS.test(rest) ? { channel, threadTs: rest } : { channel };
}

async function receiveHttp(
  request: Request,
  http: { signingSecret: string; onEvent: OnEvent; maxBodyBytes: number },
): Promise<Response> {
  const raw = await readBody(request, http.maxBodyBytes);
  if (raw === undefined)
    return new Response("Payload Too Large", { status: 413 });
  if (!verifySlackSignature(http.signingSecret, request.headers, raw))
    return new Response("Unauthorized", { status: 401 });
  const body = parseJson(raw);
  if (UrlVerification.check(body))
    return Response.json({ challenge: body.challenge });
  if (EventCallback.check(body)) await http.onEvent(body.event);
  return new Response(null, { status: 200 });
}

export function slackChannel(options: SlackOptions): SlackChannel {
  const apiUrl = options.apiUrl ?? SLACK_API;
  const call = slackApi(options.botToken, apiUrl);
  const { transport } = options;
  let onHttpEvent: OnEvent | undefined;

  async function send(
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<SendResult | undefined> {
    const text = textOf(message).slice(0, MAX_TEXT);
    if (text.trim() === "") return undefined;
    const { channel, threadTs } = slackTarget(message.address, ctx.addressData);
    const thread = threadTs === undefined ? {} : { thread_ts: threadTs };
    const posted = await call(
      "chat.postMessage",
      { channel, markdown_text: text, ...thread },
      ctx.signal,
    );
    if (threadTs !== undefined || !Posted.check(posted)) return undefined;
    return {
      addressData: { threadTs: posted.ts },
      alias: `${channel}:${posted.ts}`,
    };
  }

  function listen(appToken: string, onEvent: OnEvent, signal: AbortSignal) {
    const open = slackApi(appToken, apiUrl);
    void runSocketMode({
      open: async () => {
        const opened = await open("apps.connections.open", {}, signal);
        if (!Connection.check(opened))
          throw new Error("Slack apps.connections.open returned no url");
        return opened.url;
      },
      onPayload: async (payload) => {
        if (EventCallback.check(payload)) await onEvent(payload.event);
      },
      signal,
    });
  }

  return {
    start: async ({ deliver, signal }) => {
      const auth = await call("auth.test", {}, signal);
      if (!Auth.check(auth))
        throw new Error("Slack auth.test returned no user_id");
      const onEvent = async (event: unknown) => {
        const inbound = inboundOf(event, auth.user_id);
        if (inbound !== undefined)
          await deliver(inbound.message, { run: inbound.run });
      };
      if (transport.kind === "socket")
        listen(transport.appToken, onEvent, signal);
      else onHttpEvent = onEvent;
    },
    fetch: async (request) =>
      transport.kind === "http" && onHttpEvent !== undefined
        ? receiveHttp(request, {
            signingSecret: transport.signingSecret,
            onEvent: onHttpEvent,
            maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
          })
        : new Response("Service Unavailable", { status: 503 }),
    send,
  };
}
