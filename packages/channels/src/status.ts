import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  EntryId,
  Harness,
  SubmissionId,
  TaskRecord,
} from "@earendil-works/pi-durable";
import { replyKey } from "./hook";
import { SEND_TASK } from "./send";
import type { DeliveryStatus } from "./types";

const context = BACKGROUND_CONTEXT;

type SendRecord = TaskRecord<{ idempotencyKey: string }, unknown, unknown>;

function sendOutcome(task: SendRecord): DeliveryStatus {
  if (task.state.status !== "terminal") return { state: "sending" };
  const outcome = task.state.outcome;
  switch (outcome.status) {
    case "completed":
      return { state: "done" };
    case "failed":
    case "faulted":
      return { state: "failed", error: outcome.error.message };
    default:
      return { state: "aborted" };
  }
}

async function findSend(
  harness: Harness,
  conversationId: ConversationId,
  key: string,
): Promise<SendRecord | undefined> {
  return harness.commit(async (tx) => {
    let cursor: Parameters<typeof tx.scanTasks>[2];
    do {
      const query = {
        conversationId,
        kind: SEND_TASK,
        order: "descending",
      } as const;
      const page = await tx.scanTasks(query, 100, cursor);
      const found = (page.items as SendRecord[]).find(
        (task) => task.input.idempotencyKey === key,
      );
      if (found !== undefined) return found;
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }, context);
}

async function replyStatus(
  harness: Harness,
  conversationId: ConversationId,
  entry: EntryId,
): Promise<DeliveryStatus> {
  const task = await findSend(harness, conversationId, replyKey(entry));
  if (task === undefined) return { state: "sending" };
  const inspection = await harness.inspect(context);
  const live = inspection.tasks.find((item) => item.record.id === task.id);
  if (live?.state.kind === "blocked")
    return { state: "blocked", reason: live.state.reason };
  return sendOutcome(task);
}

export async function deliveryStatus(
  harness: Harness,
  deliveryId: SubmissionId,
): Promise<DeliveryStatus | undefined> {
  const found = await harness.submission(deliveryId, context);
  if (found === undefined) return undefined;
  const record = await found.status(context);
  if (record.status === "queued") return { state: "queued" };
  if (record.status === "placed") return { state: "running" };
  if (record.status === "unanswered") {
    return record.reason === "aborted"
      ? { state: "aborted" }
      : { state: "failed", error: record.reason };
  }
  if (record.type === "write" || record.entry === undefined)
    return { state: "done" };
  return replyStatus(harness, record.conversationId, record.entry);
}
