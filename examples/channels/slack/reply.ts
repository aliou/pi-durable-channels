import type {
  OutboundMessage,
  ReplyProgress,
  ReplyTarget,
  SendContext,
  SendResult,
} from "@aliou/pi-durable-channels";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { SlackCall } from "./api";
import type { Naming } from "./naming";
import { createPlans } from "./plan";
import { type SessionStatus, setSessionStatus } from "./session";
import { slackTarget, type Thread, threadOf } from "./target";

const MAX_TEXT = 12_000;

const Posted = compile(obj({ ts: str() }, { open: true }));
const Requester = compile(obj({ user: str(), request: opt(str()) }));

function textOf(message: OutboundMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function report(what: string) {
  return (error: unknown) => console.error(`slack ${what}`, error);
}

function requesterOf(context: unknown) {
  return Requester.check(context) ? context : undefined;
}

export function slackReplies(call: SlackCall, naming: Naming) {
  const plans = createPlans(call, report("plan"));

  const status = (
    thread: Thread,
    value: SessionStatus,
    start?: Parameters<typeof setSessionStatus>[3],
  ) => setSessionStatus(call, thread, value, start).catch(report("session"));

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

  async function decline(thread: Thread | undefined, key: string) {
    await plans.discard(key).catch(report("plan"));
    if (thread !== undefined) await status(thread, "active");
  }

  async function send(
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<SendResult | undefined> {
    const text = textOf(message).slice(0, MAX_TEXT);
    const thread = threadOf({ ...message, addressData: ctx.addressData });
    if (text.trim() === "") {
      await decline(thread, ctx.idempotencyKey);
      return undefined;
    }
    await plans.finish(ctx.idempotencyKey, "done").catch(report("plan"));
    const result = await post(message, text, ctx);
    const request = requesterOf(ctx.replyContext)?.request;
    if (thread !== undefined && request !== undefined)
      naming.answered(thread, request, text);
    return result;
  }

  async function progress(
    target: ReplyTarget,
    update: ReplyProgress,
  ): Promise<void> {
    const thread = threadOf(target);
    if (thread === undefined) return;
    const requester = requesterOf(target.replyContext);
    if (update.type === "working") {
      const title = naming.initial(requester?.request);
      return status(thread, "processing", {
        ...(requester === undefined ? {} : { initiator: requester.user }),
        ...(title === undefined ? {} : { title }),
      });
    }
    if (update.type === "step")
      return plans.step(target.idempotencyKey, thread, update.step);
    const failed = update.reason === "failed";
    await plans
      .finish(target.idempotencyKey, failed ? "failed" : "stopped")
      .catch(report("plan"));
    await status(thread, failed ? "suspended" : "active");
  }

  return { send, progress };
}
