import type { EntryRecord } from "@earendil-works/pi-durable";
import { NO_REPLY } from "./tools";
import type { ChannelEvent } from "./types";

type Message = NonNullable<EntryRecord["model"]>[number];

function startedEvents(entry: EntryRecord, message: Message): ChannelEvent[] {
  if (message.role !== "assistant") return [];
  const calls = message.content.flatMap((part) =>
    part.type === "toolCall" && part.name !== NO_REPLY ? [part] : [],
  );
  if (calls.length === 0) return [];
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  const narration: ChannelEvent[] =
    text === "" ? [] : [{ type: "text", id: String(entry.id), text }];
  return [
    ...narration,
    ...calls.map(
      (call): ChannelEvent => ({
        type: "tool_started",
        id: call.id,
        name: call.name,
        args: call.arguments,
      }),
    ),
  ];
}

function finishedEvents(message: Message): ChannelEvent[] {
  if (message.role !== "toolResult" || message.toolName === NO_REPLY) return [];
  return [
    {
      type: "tool_finished",
      id: message.toolCallId,
      name: message.toolName,
      isError: message.isError,
      output: message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(""),
    },
  ];
}

export function eventsOf(entries: readonly EntryRecord[]): ChannelEvent[] {
  return entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => [
      ...startedEvents(entry, message),
      ...finishedEvents(message),
    ]),
  );
}
