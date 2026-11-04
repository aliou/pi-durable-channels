import type {
  ChannelEvent,
  OutboundMessage,
  ReplyTarget,
  SendContext,
  SendResult,
} from "@aliou/pi-durable-channels";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { SlackCall } from "./api";
import type { Naming } from "./naming";
import { createPlans, titleOf } from "./plan";
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

  const narration = new Map<string, string>();

  function started(target: ReplyTarget, thread: Thread) {
    const requester = requesterOf(target.replyContext);
    const title = naming.initial(requester?.request);
    return status(thread, "processing", {
      ...(requester === undefined ? {} : { initiator: requester.user }),
      ...(title === undefined ? {} : { title }),
    });
  }

  function toolStarted(
    key: string,
    thread: Thread,
    name: string,
    id: string,
    args: unknown,
  ) {
    const details = narration.get(key);
    narration.delete(key);
    plans.step(key, thread, {
      id,
      title: titleOf(name, args),
      status: "in_progress",
      ...(details === undefined ? {} : { details }),
    });
  }

  async function ended(
    key: string,
    thread: Thread,
    outcome: "completed" | "failed" | "aborted",
  ) {
    narration.delete(key);
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
        narration.set(key, event.text);
        return;
      case "tool_started":
        return toolStarted(key, thread, event.name, event.id, event.args);
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
