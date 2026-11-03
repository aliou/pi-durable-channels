import type { InboundMessage } from "@aliou/pi-durable-channels";
import {
  compile,
  lit,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";

const UserMessage = compile(
  obj(
    {
      type: lit("message"),
      user: str(),
      text: str(),
      channel: str(),
      ts: str(),
      thread_ts: opt(str()),
      subtype: opt(unknown()),
      bot_id: opt(unknown()),
    },
    { open: true },
  ),
);

export type SlackInbound = { message: InboundMessage; run: boolean };

export function inboundOf(
  event: unknown,
  botUserId: string,
): SlackInbound | undefined {
  if (!UserMessage.check(event)) return undefined;
  if (event.subtype !== undefined || event.bot_id !== undefined)
    return undefined;
  const mentioned = event.text.includes(`<@${botUserId}>`);
  if (event.thread_ts === undefined && !mentioned) return undefined;
  return {
    message: {
      address: `${event.channel}:${event.thread_ts ?? event.ts}`,
      text: event.text,
      requestId: `slack:${event.channel}:${event.ts}`,
      author: event.user,
    },
    run: mentioned,
  };
}
