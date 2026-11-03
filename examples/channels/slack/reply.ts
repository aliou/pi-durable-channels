import type {
  OutboundMessage,
  ReplyProgress,
  ReplyTarget,
  SendContext,
  SendResult,
} from "@aliou/pi-durable-channels";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { SlackCall } from "./api";
import { type SessionStatus, setSessionStatus } from "./session";
import { createStreams } from "./stream";
import { slackTarget, type Thread, threadOf } from "./target";

const MAX_TEXT = 12_000;

const Posted = compile(obj({ ts: str() }, { open: true }));
const Recipient = compile(obj({ user: str(), team: opt(str()) }));

function textOf(message: OutboundMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function report(what: string) {
  return (error: unknown) => console.error(`slack ${what}`, error);
}

export function slackReplies(call: SlackCall) {
  const streams = createStreams(call, report("stream"));

  const status = (thread: Thread, value: SessionStatus, initiator?: string) =>
    setSessionStatus(call, thread, value, initiator).catch(report("session"));

  const finishStream = (key: string, text: string) =>
    streams.stop(key, { text, status: "active" }).catch((error: unknown) => {
      report("stream")(error);
      return false;
    });

  async function post(
    message: OutboundMessage,
    text: string,
    ctx: SendContext,
  ): Promise<SendResult | undefined> {
    const { channel, threadTs } = slackTarget(message.address, ctx.addressData);
    const thread = threadTs === undefined ? {} : { thread_ts: threadTs };
    const posted = await call(
      "chat.postMessage",
      { channel, markdown_text: text, ...thread },
      ctx.signal,
    );
    const root = Posted.check(posted) ? posted.ts : undefined;
    const sessionTs = threadTs ?? root;
    if (sessionTs !== undefined)
      await status({ channel, threadTs: sessionTs }, "active");
    if (threadTs !== undefined || root === undefined) return undefined;
    return { addressData: { threadTs: root }, alias: `${channel}:${root}` };
  }

  async function send(
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<SendResult | undefined> {
    const text = textOf(message).slice(0, MAX_TEXT);
    if (text.trim() === "") return undefined;
    if (await finishStream(ctx.idempotencyKey, text)) return undefined;
    return post(message, text, ctx);
  }

  async function progress(
    target: ReplyTarget,
    update: ReplyProgress,
  ): Promise<void> {
    const thread = threadOf(target);
    if (thread === undefined) return;
    const recipient = Recipient.check(target.replyContext)
      ? target.replyContext
      : undefined;
    if (update.type === "working")
      return status(thread, "processing", recipient?.user);
    if (update.type === "text")
      return streams.text(
        target.idempotencyKey,
        { ...thread, recipient },
        update.text,
      );
    const end = update.reason === "failed" ? "suspended" : "active";
    await streams
      .stop(target.idempotencyKey, { status: end })
      .catch(report("stream"));
    await status(thread, end);
  }

  return { send, progress };
}
