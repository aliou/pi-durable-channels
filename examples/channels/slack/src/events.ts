import type {
  DeliverOptions,
  InboundFile,
  InboundMessage,
} from "@aliou/pi-durable-channels";
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
import type { Thread } from "./target";

const SlackFile = obj(
  {
    id: str(),
    name: opt(str()),
    mimetype: opt(str()),
    url_private: opt(str()),
  },
  { open: true },
);

const UserMessageShape = obj(
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
);

const UserMessage = compile(UserMessageShape);

const TitleChanged = compile(
  obj(
    {
      type: lit("agent_session_title_changed"),
      channel: str(),
      thread_ts: str(),
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

export type SlackInbound = { message: InboundMessage; options: DeliverOptions };

export type ThreadMessages = "context" | "run";

export type InboundSettings = {
  botUserId: string;
  threadMessages?: ThreadMessages;
};

const THREAD_MESSAGES: Readonly<Record<ThreadMessages, DeliverOptions>> = {
  context: { run: false },
  run: { run: true, create: false },
};

export type Requester = { user: string; request: string };

const MAX_REQUEST = 500;

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

function deliverOptions(
  event: Static<typeof UserMessageShape>,
  settings: InboundSettings,
): DeliverOptions | undefined {
  if (event.channel_type === "im") return {};
  if (event.text.includes(`<@${settings.botUserId}>`)) return {};
  if (event.thread_ts === undefined) return undefined;
  return THREAD_MESSAGES[settings.threadMessages ?? "context"];
}

function unescapeText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function inboundOf(
  event: unknown,
  settings: InboundSettings,
): SlackInbound | undefined {
  if (!UserMessage.check(event)) return undefined;
  if (!USER_SUBTYPES.has(event.subtype)) return undefined;
  if (event.bot_id !== undefined) return undefined;
  const options = deliverOptions(event, settings);
  if (options === undefined) return undefined;
  const text = unescapeText(event.text);
  const requester: Requester = {
    user: event.user,
    request: text.slice(0, MAX_REQUEST),
  };
  return {
    message: {
      address: `${event.channel}:${event.thread_ts ?? event.ts}`,
      text,
      requestId: `slack:${event.channel}:${event.ts}`,
      author: event.user,
      replyContext: requester,
      files: filesOf(event.files),
    },
    options,
  };
}

export function stoppedAddressOf(event: unknown): string | undefined {
  return SessionStopped.check(event)
    ? `${event.channel}:${event.thread_ts}`
    : undefined;
}

export function renamedThreadOf(event: unknown): Thread | undefined {
  return TitleChanged.check(event)
    ? { channel: event.channel, threadTs: event.thread_ts }
    : undefined;
}

const AnyEvent = compile(
  obj(
    {
      type: str(),
      subtype: opt(str()),
      channel: opt(str()),
      ts: opt(str()),
      bot_id: opt(unknown()),
    },
    { open: true },
  ),
);

export function describeEvent(event: unknown): string {
  if (!AnyEvent.check(event)) return "unknown event";
  const kind = [event.type, event.subtype].filter(Boolean).join("/");
  const from = event.bot_id === undefined ? "" : " from a bot";
  return `${kind} ${event.channel ?? ""} ${event.ts ?? ""}${from}`.trim();
}
