import type {
  ChannelEvent,
  OutboundMessage,
  ReplyTarget,
  SendContext,
  SendResult,
} from "@aliou/pi-durable-channels";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import { SlackApiError, type SlackCall } from "./api";
import { blockKitBlocks } from "./block-kit";
import type { Naming } from "./naming";
import { createPlans, narrationStep, titleOf } from "./plan";
import { type SessionStatus, setSessionStatus } from "./session";
import { slackTarget, type Thread, threadOf } from "./target";

const MAX_TEXT = 12_000;
const CONTENT_ERRORS = new Set([
  "invalid_blocks",
  "invalid_blocks_format",
  "msg_blocks_too_long",
]);

const Posted = compile(obj({ ts: str() }, { open: true }));
const Requester = compile(obj({ user: str(), request: opt(str()) }));

function textOf(message: OutboundMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function requesterOf(context: unknown) {
  return Requester.check(context) ? context : undefined;
}

export type ReportError = (thread?: Thread) => (error: unknown) => void;

export function slackReplies(
  call: SlackCall,
  naming: Naming,
  reportError: ReportError,
) {
  const plans = createPlans(call, reportError);

  const status = (
    thread: Thread,
    value: SessionStatus,
    start?: Parameters<typeof setSessionStatus>[3],
  ) => setSessionStatus(call, thread, value, start).catch(reportError(thread));

  async function post(
    message: OutboundMessage,
    text: string,
    ctx: SendContext,
  ): Promise<SendResult | undefined> {
    const { channel, threadTs } = slackTarget(message.address, ctx.addressData);
    const thread = threadTs === undefined ? {} : { thread_ts: threadTs };
    const blocks = blockKitBlocks(message);
    const content =
      blocks === undefined ? { markdown_text: text } : { text, blocks };
    let posted: Record<string, unknown>;
    try {
      posted = await call(
        "chat.postMessage",
        { channel, ...content, ...thread },
        ctx.signal,
      );
    } catch (error) {
      if (
        blocks === undefined ||
        !(error instanceof SlackApiError) ||
        !CONTENT_ERRORS.has(error.code)
      )
        throw error;
      posted = await call(
        "chat.postMessage",
        { channel, markdown_text: text, ...thread },
        ctx.signal,
      );
    }
    const root = Posted.check(posted) ? posted.ts : undefined;
    const sessionTs = threadTs ?? root;
    if (sessionTs !== undefined)
      await status({ channel, threadTs: sessionTs }, "active");
    if (threadTs !== undefined || root === undefined) return undefined;
    return { addressData: { threadTs: root }, alias: `${channel}:${root}` };
  }

  async function decline(thread: Thread | undefined, key: string) {
    await plans.discard(key).catch(reportError(thread));
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
    await plans.finish(ctx.idempotencyKey, "done").catch(reportError(thread));
    const result = await post(message, text, ctx);
    const request = requesterOf(ctx.replyContext)?.request;
    if (thread !== undefined && request !== undefined)
      naming.answered(thread, request, text);
    return result;
  }

  function started(target: ReplyTarget, thread: Thread) {
    const requester = requesterOf(target.replyContext);
    const title = naming.initial(requester?.request);
    return status(thread, "processing", {
      ...(requester === undefined ? {} : { initiator: requester.user }),
      ...(title === undefined ? {} : { title }),
    });
  }

  async function ended(
    key: string,
    thread: Thread,
    outcome: "completed" | "failed" | "aborted",
  ) {
    if (outcome === "completed") return;
    const failed = outcome === "failed";
    await plans
      .finish(key, failed ? "failed" : "stopped")
      .catch(reportError(thread));
    await status(thread, failed ? "suspended" : "active");
  }

  async function events(
    target: ReplyTarget,
    event: ChannelEvent,
  ): Promise<void> {
    const thread = threadOf(target);
    if (thread === undefined) return;
    const key = target.idempotencyKey;
    switch (event.type) {
      case "run_started":
        return started(target, thread);
      case "text":
        return plans.step(key, thread, narrationStep(event.id, event.text));
      case "tool_started":
        return plans.step(key, thread, {
          id: event.id,
          title: titleOf(event.name, event.args),
          status: "in_progress",
        });
      case "tool_finished":
        return plans.finishStep(
          key,
          event.id,
          event.isError ? "error" : "complete",
        );
      case "run_ended":
        return ended(key, thread, event.outcome);
    }
  }

  return { send, events };
}
