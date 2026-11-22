import type { JsonValue } from "@earendil-works/chord/json";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";

const THREAD_TS = /^\d+\.\d+$/;

const ThreadData = compile(obj({ threadTs: str() }));
const ReplyContext = compile(obj({ threadTs: opt(str()) }, { open: true }));

export type Thread = { channel: string; threadTs: string };

export function slackTarget(
  address: string,
  addressData: JsonValue | undefined,
  replyContext?: JsonValue,
): { channel: string; threadTs?: string } {
  const separator = address.indexOf(":");
  if (separator < 0) {
    const threadTs = ReplyContext.check(replyContext)
      ? replyContext.threadTs
      : undefined;
    return {
      channel: address,
      ...(threadTs === undefined ? {} : { threadTs }),
    };
  }
  if (separator === 0)
    throw new Error("Slack addresses start with a conversation ID");
  const channel = address.slice(0, separator);
  const rest = address.slice(separator + 1);
  if (rest === "") throw new Error("Slack address keys cannot be empty");
  if (ThreadData.check(addressData))
    return { channel, threadTs: addressData.threadTs };
  return THREAD_TS.test(rest) ? { channel, threadTs: rest } : { channel };
}

export function threadOf(target: {
  address: string;
  addressData?: JsonValue;
  replyContext?: JsonValue;
}): Thread | undefined {
  const { channel, threadTs } = slackTarget(
    target.address,
    target.addressData,
    target.replyContext,
  );
  return threadTs === undefined ? undefined : { channel, threadTs };
}
