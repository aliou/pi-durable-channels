import { timingSafeEqual } from "node:crypto";
import type {
  ChannelAdapter,
  Deliver,
  OutboundMessage,
  SendContext,
} from "@aliou/pi-durable-channels";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import { parseJson, readBody } from "./body";
import { allowOrigins } from "./origins";

export type Verify = (
  request: Request,
  body: string,
) => boolean | Promise<boolean>;

export type WebhookOptions = {
  verify: Verify;
  allowedOrigins: readonly string[];
  maxBodyBytes?: number;
  timeoutMs?: number;
};

const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;

const Inbound = compile(
  obj({
    address: str({ minLength: 1 }),
    text: str(),
    requestId: str({ minLength: 1 }),
    author: str(),
    replyUrl: opt(str({ minLength: 1 })),
    callbackUrl: opt(str({ minLength: 1 })),
  }),
);

const ReplyContext = compile(obj({ replyUrl: str() }));
const AddressData = compile(obj({ callbackUrl: str() }));

export function bearerToken(token: string): Verify {
  if (token.length < 16)
    throw new Error("Bearer tokens need at least 16 characters");
  const expected = Buffer.from(`Bearer ${token}`);
  return (request) => {
    const given = Buffer.from(request.headers.get("authorization") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
}

function targetUrl(ctx: SendContext): string {
  if (ReplyContext.check(ctx.replyContext)) return ctx.replyContext.replyUrl;
  if (AddressData.check(ctx.addressData)) return ctx.addressData.callbackUrl;
  throw new Error("No replyUrl or callbackUrl for this address");
}

function textOf(message: OutboundMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

export function webhook(options: WebhookOptions): ChannelAdapter {
  const allowed = allowOrigins(options.allowedOrigins);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  let deliver: Deliver | undefined;

  async function send(
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<void> {
    const text = textOf(message);
    if (text === "") return;
    const url = targetUrl(ctx);
    if (!allowed(url)) throw new Error("Reply URL is not an allowed origin");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": ctx.idempotencyKey,
      },
      body: JSON.stringify({ address: message.address, text }),
      redirect: "error",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
    }).catch(() => undefined);
    if (response === undefined) throw new Error("Webhook reply request failed");
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`Webhook reply failed with status ${response.status}`);
  }

  async function receive(request: Request, to: Deliver): Promise<Response> {
    const raw = await readBody(request, maxBodyBytes);
    if (raw === undefined)
      return new Response("Payload Too Large", { status: 413 });
    const verified = await options.verify(request, raw);
    if (!verified) return new Response("Unauthorized", { status: 401 });
    const body = parseJson(raw);
    if (!Inbound.check(body))
      return Response.json({ errors: Inbound.errors(body) }, { status: 400 });
    const { replyUrl, callbackUrl, ...message } = body;
    const urls = [replyUrl, callbackUrl].filter((url) => url !== undefined);
    if (!urls.every(allowed))
      return Response.json(
        { errors: ["URL is not an allowed origin"] },
        { status: 400 },
      );
    const receipt = await to({
      ...message,
      ...(replyUrl === undefined ? {} : { replyContext: { replyUrl } }),
      ...(callbackUrl === undefined ? {} : { addressData: { callbackUrl } }),
    });
    return Response.json(receipt ?? { ignored: true }, { status: 202 });
  }

  return {
    start: (ctx) => {
      deliver = ctx.deliver;
    },
    fetch: async (request) =>
      deliver === undefined
        ? new Response("Service Unavailable", { status: 503 })
        : receive(request, deliver),
    send,
  };
}
