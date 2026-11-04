import type { EntryRecord } from "@earendil-works/pi-durable";
import { NO_REPLY } from "./tools";
import type { ReplyStep } from "./types";

const MAX_TITLE = 60;

type Message = NonNullable<EntryRecord["model"]>[number];

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE)}…` : flat;
}

function titleOf(name: string, args: unknown): string {
  const values =
    typeof args === "object" && args !== null ? Object.values(args) : [];
  const first = values.find((value) => typeof value === "string");
  return typeof first === "string" ? oneLine(`${name} ${first}`) : name;
}

function startedSteps(message: Message, titles: Map<string, string>) {
  if (message.role !== "assistant") return [];
  const narration = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  const calls = message.content.flatMap((part) =>
    part.type === "toolCall" && part.name !== NO_REPLY ? [part] : [],
  );
  return calls.map((call, index): ReplyStep => {
    const title = titleOf(call.name, call.arguments);
    titles.set(call.id, title);
    const details =
      index === 0 && narration !== "" ? { details: narration } : {};
    return { id: call.id, title, status: "in_progress", ...details };
  });
}

function finishedSteps(message: Message, titles: Map<string, string>) {
  if (message.role !== "toolResult") return [];
  const title = titles.get(message.toolCallId);
  if (title === undefined) return [];
  const status = message.isError ? "error" : "complete";
  return [{ id: message.toolCallId, title, status } satisfies ReplyStep];
}

export function stepsOf(
  entries: readonly EntryRecord[],
  titles: Map<string, string>,
): ReplyStep[] {
  return entries
    .flatMap((entry) => entry.model ?? [])
    .flatMap((message) => [
      ...startedSteps(message, titles),
      ...finishedSteps(message, titles),
    ]);
}
