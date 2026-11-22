import type { Context } from "@earendil-works/chord/context";
import {
  type EntryId,
  type EntryRecord,
  type GenerationHooks,
  type HookApi,
  hookTask,
} from "@earendil-works/pi-durable";
import { ChannelMessage } from "./doc";
import type { SendTask } from "./send";
import type { OutboundPart } from "./types";

export function replyKey(entryId: EntryId): string {
  return `reply:${entryId}`;
}

export type EntrySource = Pick<HookApi, "entries">;

export async function runEntries(
  source: EntrySource,
  range: { first: EntryId; last?: EntryId },
  context: Context,
): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Parameters<HookApi["entries"]>[2];
  do {
    const query = {
      minEntryId: range.first,
      ...(range.last === undefined ? {} : { maxEntryId: range.last }),
      order: "ascending",
    } as const;
    const page = await source.entries(query, 100, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

export function latestMessageIds(
  entries: readonly EntryRecord[],
): Set<EntryId> {
  const latest = new Map<string, EntryId>();
  for (const entry of entries) {
    if (!ChannelMessage.is(entry)) continue;
    const key = JSON.stringify([entry.data.channel, entry.data.address]);
    latest.set(key, entry.id);
  }
  return new Set(latest.values());
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
    const entries = await runEntries(api, run, context);
    const messages = entries.filter(ChannelMessage.is);
    if (messages.length === 0) return undefined;
    const answer = await api.entry(run.answer, context);
    const parts = run.reason === "terminate" ? [] : answerParts(answer);
    const latest = latestMessageIds(messages);
    const tasks = messages.map(({ id, data: { author: _author, ...target } }) =>
      hookTask(Send, {
        ...target,
        parts: latest.has(id) ? parts : [],
        idempotencyKey: replyKey(id),
      }),
    );
    return { tasks };
  };
}
