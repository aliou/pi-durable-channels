import type { InboundFile, InboundMessage } from "@aliou/pi-durable-channels";
import {
  arr,
  compile,
  lit,
  obj,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema";

const SlackFile = obj(
  {
    id: str(),
    name: opt(str()),
    mimetype: opt(str()),
    url_private: opt(str()),
  },
  { open: true },
);

const UserMessage = compile(
  obj(
    {
      type: lit("message"),
      user: str(),
      text: str(),
      channel: str(),
      ts: str(),
      thread_ts: opt(str()),
      channel_type: opt(str()),
      subtype: opt(str()),
      bot_id: opt(unknown()),
      files: opt(arr(SlackFile)),
    },
    { open: true },
  ),
);

const SessionStopped = compile(
  obj(
    { type: lit("agent_session_stopped"), channel: str(), thread_ts: str() },
    { open: true },
  ),
);

export type SlackInbound = { message: InboundMessage; run: boolean };

export type Recipient = { user: string; team?: string };

const USER_SUBTYPES = new Set<string | undefined>([undefined, "file_share"]);

function filesOf(
  files: readonly Static<typeof SlackFile>[] = [],
): InboundFile[] {
  return files.flatMap((file) =>
    file.url_private === undefined
      ? []
      : [
          {
            name: file.name ?? file.id,
            mimeType: file.mimetype ?? "application/octet-stream",
            url: file.url_private,
          },
        ],
  );
}

export function inboundOf(
  event: unknown,
  botUserId: string,
  team?: string,
): SlackInbound | undefined {
  if (!UserMessage.check(event)) return undefined;
  if (!USER_SUBTYPES.has(event.subtype)) return undefined;
  if (event.bot_id !== undefined) return undefined;
  const direct = event.channel_type === "im";
  const run = direct || event.text.includes(`<@${botUserId}>`);
  if (event.thread_ts === undefined && !run) return undefined;
  const recipient: Recipient =
    team === undefined ? { user: event.user } : { user: event.user, team };
  return {
    message: {
      address: `${event.channel}:${event.thread_ts ?? event.ts}`,
      text: event.text,
      requestId: `slack:${event.channel}:${event.ts}`,
      author: event.user,
      replyContext: recipient,
      files: filesOf(event.files),
    },
    run,
  };
}

export function stoppedAddressOf(event: unknown): string | undefined {
  return SessionStopped.check(event)
    ? `${event.channel}:${event.thread_ts}`
    : undefined;
}
