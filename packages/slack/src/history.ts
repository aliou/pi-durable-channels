import type {
  ChannelHistoryResult,
  InboundFile,
} from "@aliou/pi-durable-channels";
import {
  arr,
  bool,
  compile,
  obj,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import type { SlackCall } from "./api";
import type { SlackConfig } from "./config";
import { filesOf, unescapeText } from "./events";
import { slackTarget } from "./target";

const HISTORY_DEADLINE_MS = 1500;
const encoder = new TextEncoder();

const HistoryMessage = obj(
  {
    type: str(),
    user: opt(str()),
    text: str(),
    ts: str(),
    subtype: opt(str()),
    bot_id: opt(unknown()),
    files: opt(
      arr(
        obj(
          {
            id: str(),
            name: opt(str()),
            mimetype: opt(str()),
            url_private: opt(str()),
          },
          { open: true },
        ),
      ),
    ),
  },
  { open: true },
);
const History = compile(
  obj({ messages: arr(HistoryMessage), has_more: opt(bool()) }, { open: true }),
);

type SourceMessage = Static<typeof HistoryMessage>;

export type SlackHistory = ChannelHistoryResult & {
  files: InboundFile[];
};

function timestamp(value: string): number {
  return Number(value);
}

function afterCursor(ts: string, cursor: string | undefined): boolean {
  return cursor === undefined || timestamp(ts) > timestamp(cursor);
}

function beforeCursor(ts: string, cursor: string | undefined): boolean {
  return cursor === undefined || timestamp(ts) < timestamp(cursor);
}

function supported(message: SourceMessage, botUserId: string): boolean {
  return (
    message.type === "message" &&
    (message.subtype === undefined || message.subtype === "file_share") &&
    message.bot_id === undefined &&
    message.user !== botUserId &&
    message.user !== undefined
  );
}

function format(message: SourceMessage, files: readonly InboundFile[]): string {
  const attachments = files.map((file) => ` [file: ${file.name}]`).join("");
  return `[${message.ts}] <@${message.user ?? "unknown"}> ${unescapeText(message.text)}${attachments}`;
}

function cutUtf8(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text;
  let result = "";
  for (const character of text) {
    if (encoder.encode(result + character).length > maxBytes) break;
    result += character;
  }
  return result;
}

function bounded(
  messages: readonly SourceMessage[],
  limits: SlackConfig["context"],
  hasMore: boolean,
): SlackHistory {
  const selected =
    limits.maxMessages === 0 ? [] : messages.slice(-limits.maxMessages);
  let truncated = hasMore || selected.length < messages.length;
  const entries: { ts: string; text: string; files: InboundFile[] }[] = [];
  let fileCount = 0;
  for (const message of selected) {
    const allFiles = filesOf(message.files);
    const remaining = Math.max(0, limits.maxFiles - fileCount);
    const files = allFiles.slice(0, remaining);
    fileCount += files.length;
    if (files.length < allFiles.length) truncated = true;
    entries.push({ ts: message.ts, text: format(message, files), files });
  }
  let content = entries.map(({ text }) => text).join("\n");
  while (
    entries.length > 0 &&
    encoder.encode(content).length > limits.maxBytes
  ) {
    entries.shift();
    truncated = true;
    content = entries.map(({ text }) => text).join("\n");
  }
  if (encoder.encode(content).length > limits.maxBytes) {
    content = cutUtf8(content, limits.maxBytes);
    truncated = true;
  }
  if (truncated && limits.maxBytes > 0) {
    const notice = "[Some Slack history was omitted.]";
    content = cutUtf8(`${notice}\n${content}`, limits.maxBytes);
  }
  return {
    content,
    cursor: entries[0]?.ts ?? selected.at(-1)?.ts,
    truncated,
    files: entries.flatMap(({ files }) => files),
  };
}

function oldestTimestamp(
  messages: readonly SourceMessage[],
): string | undefined {
  let oldest: string | undefined;
  for (const message of messages) {
    if (oldest === undefined || timestamp(message.ts) < timestamp(oldest))
      oldest = message.ts;
  }
  return oldest;
}

export async function readHistory(
  call: SlackCall,
  input: {
    botUserId: string;
    address: string;
    after?: string;
    before?: string;
    limits: SlackConfig["context"];
    signal: AbortSignal;
    boundedDeadline?: boolean;
  },
): Promise<SlackHistory> {
  const target = slackTarget(input.address, undefined);
  const method =
    target.threadTs === undefined
      ? "conversations.history"
      : "conversations.replies";
  const signals = [input.signal];
  if (input.boundedDeadline === true)
    signals.push(AbortSignal.timeout(HISTORY_DEADLINE_MS));
  const response = await call(
    method,
    {
      channel: target.channel,
      ...(target.threadTs === undefined ? {} : { ts: target.threadTs }),
      ...(input.after === undefined ? {} : { oldest: input.after }),
      ...(input.before === undefined ? {} : { latest: input.before }),
      limit: input.limits.maxMessages + 1,
    },
    AbortSignal.any(signals),
  );
  if (!History.check(response))
    throw new Error(`Slack ${method} returned no messages`);
  const messages = response.messages
    .filter(
      (message) =>
        supported(message, input.botUserId) &&
        afterCursor(message.ts, input.after) &&
        beforeCursor(message.ts, input.before),
    )
    .sort((left, right) => timestamp(left.ts) - timestamp(right.ts));
  const result = bounded(messages, input.limits, response.has_more === true);
  if (result.cursor === undefined && result.truncated)
    result.cursor = oldestTimestamp(response.messages);
  return result;
}
