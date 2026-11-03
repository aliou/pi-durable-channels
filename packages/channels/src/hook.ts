import type { Context } from "@earendil-works/chord/context";
import {
  type EntryId,
  type EntryRecord,
  type GenerationHooks,
  type HookApi,
  runEndTask,
} from "@earendil-works/pi-durable";
import { ChannelMessage } from "./doc";
import type { SendTask } from "./send";
import type { OutboundPart } from "./types";

export function replyKey(entryId: EntryId): string {
  return `reply:${entryId}`;
}

async function runEntries(
  api: HookApi,
  first: EntryId,
  last: EntryId,
  context: Context,
): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Parameters<HookApi["entries"]>[2];
  do {
    const query = {
      minEntryId: first,
      maxEntryId: last,
      order: "ascending",
    } as const;
    const page = await api.entries(query, 100, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

function answerParts(entry: EntryRecord | undefined): OutboundPart[] {
  const messages = entry?.model ?? [];
  const text = messages
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  return text === "" ? [] : [{ type: "text", text }];
}

export function replyHook(Send: SendTask): GenerationHooks["afterRun"] {
  return async (run, api, context) => {
    const entries = await runEntries(api, run.first, run.last, context);
    const messages = entries.filter(ChannelMessage.is);
    if (messages.length === 0) return undefined;
    const answer = await api.entry(run.answer, context);
    const parts = answerParts(answer);
    const tasks = messages.map(({ id, data: { author: _author, ...target } }) =>
      runEndTask(Send, { ...target, parts, idempotencyKey: replyKey(id) }),
    );
    return { tasks };
  };
}
