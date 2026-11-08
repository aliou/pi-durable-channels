import type { JsonValue } from "@earendil-works/chord";
import { compile, obj, str } from "@earendil-works/pi-schema";

const THREAD_TS = /^\d+\.\d+$/;

const ThreadData = compile(obj({ threadTs: str() }));

export type Thread = { channel: string; threadTs: string };

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

export function threadOf(target: {
  address: string;
  addressData?: JsonValue;
}): Thread | undefined {
  const { channel, threadTs } = slackTarget(target.address, target.addressData);
  return threadTs === undefined ? undefined : { channel, threadTs };
}
