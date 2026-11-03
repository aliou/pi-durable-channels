import { copyJson, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  type ConversationId,
  configure,
  type EntryId,
  type Harness,
  type SubmissionDraft,
  type SubmissionId,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { type BindTarget, bindAddress } from "./bind";
import {
  ChannelMessage,
  type ChannelMessageData,
  ChannelNote,
  ChannelsDoc,
  deleteConversation,
  findBinding,
  setBinding,
} from "./doc";
import { replyKey } from "./hook";
import { SEND_TASK } from "./send";
import type {
  AddressKey,
  ChannelRegistration,
  ChannelsOptions,
  DeliverOptions,
  DeliveryReceipt,
  DeliveryStatus,
  InboundMessage,
} from "./types";

const context = BACKGROUND_CONTEXT;

const WHEN_BUSY = { queue: "followUp", steer: "steer" } as const;

export type ChannelsHub = {
  start(signal?: AbortSignal): Promise<void>;
  deliver(
    channel: string,
    message: InboundMessage,
    options?: DeliverOptions,
  ): Promise<DeliveryReceipt | undefined>;
  bind(target: BindTarget, conversationId: ConversationId): Promise<void>;
  status(deliveryId: SubmissionId): Promise<DeliveryStatus | undefined>;
  cancel(key: AddressKey): Promise<void>;
  clear(key: AddressKey): Promise<void>;
  compact(key: AddressKey): Promise<void>;
  end(key: AddressKey): Promise<void>;
};

export type HubSetup = {
  options: ChannelsOptions;
  registration(channel: string): ChannelRegistration;
};

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

function messageData(
  key: AddressKey,
  message: InboundMessage,
  addressData: JsonValue | undefined,
): ChannelMessageData {
  return {
    author: message.author,
    ...key,
    ...(addressData === undefined ? {} : { addressData }),
    ...(message.replyContext === undefined
      ? {}
      : { replyContext: message.replyContext }),
  };
}

function submission(
  message: InboundMessage,
  data: ChannelMessageData,
  options: Required<DeliverOptions>,
): SubmissionDraft {
  const { requestId, text } = message;
  if (options.run) {
    return {
      type: "input",
      content: text,
      requestId,
      whenBusy: WHEN_BUSY[options.whenBusy],
      entry: { kind: ChannelMessage.kind, data },
    };
  }
  const model = [
    { role: "user" as const, content: text, timestamp: Date.now() },
  ];
  return {
    type: "write",
    requestId,
    entry: { kind: ChannelNote.kind, data, model },
  };
}

export function createHub(harness: Harness, setup: HubSetup): ChannelsHub {
  const tails = new Map<string, Promise<unknown>>();

  function serial<T>(key: AddressKey, run: () => Promise<T>): Promise<T> {
    const id = JSON.stringify([key.channel, key.address]);
    const result = (tails.get(id) ?? Promise.resolve()).then(run);
    const tail = result.catch(() => undefined);
    tails.set(id, tail);
    void tail.then(() => tails.get(id) === tail && tails.delete(id));
    return result;
  }

  async function conversationFor(
    key: AddressKey,
    message: InboundMessage,
    create: boolean,
  ): Promise<ConversationId | undefined> {
    const factory = create
      ? setup.registration(key.channel).conversation
      : undefined;
    return harness.commit(async (tx) => {
      const state = await tx.doc(ChannelsDoc);
      const existing = findBinding(state, key);
      if (existing !== undefined) return existing.conversationId;
      const created = factory?.(message);
      if (created === undefined) return undefined;
      const record = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await configure(tx, record.id, created.agent ?? {});
      await bindAddress(tx, key, record.id);
      return record.id;
    }, context);
  }

  async function admit(
    key: AddressKey,
    message: InboundMessage,
    options: Required<DeliverOptions>,
  ): Promise<DeliveryReceipt | undefined> {
    const conversationId = await conversationFor(key, message, options.run);
    if (conversationId === undefined) return undefined;
    const conversation = await harness.conversation(conversationId, context);
    if (conversation === undefined)
      throw new Error(`Conversation ${conversationId} not found`);
    const submissionId = await harness.commit(async (tx) => {
      const known = await tx.submissionByRequest(
        conversationId,
        message.requestId,
      );
      if (known !== undefined) return known.id;
      const state = await tx.doc(ChannelsDoc);
      const stored = findBinding(state, key)?.addressData;
      if (message.addressData !== undefined) {
        setBinding(state, key, {
          conversationId,
          addressData: message.addressData,
        });
      }
      const addressData =
        message.addressData ??
        (stored === undefined ? undefined : copyJson(stored));
      const data = messageData(key, message, addressData);
      return conversation.submit(tx, submission(message, data, options));
    }, context);
    return { submissionId, conversationId };
  }

  const deliver: ChannelsHub["deliver"] = async (channel, message, options) => {
    setup.registration(channel);
    const key = { channel, address: message.address };
    const resolved = {
      whenBusy: options?.whenBusy ?? setup.options.whenBusy ?? "queue",
      run: options?.run ?? true,
    };
    return serial(key, () => admit(key, message, resolved));
  };

  async function start(signal = new AbortController().signal): Promise<void> {
    const channels = Object.entries(setup.options.channels);
    await Promise.all(
      channels.map(([channel, { adapter }]) =>
        adapter.start?.({
          deliver: (message, options) => deliver(channel, message, options),
          signal,
        }),
      ),
    );
  }

  async function bind(target: BindTarget, conversationId: ConversationId) {
    setup.registration(target.channel);
    return serial(target, () =>
      harness.commit((tx) => bindAddress(tx, target, conversationId), context),
    );
  }

  async function findSend(
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
    conversationId: ConversationId,
    entry: EntryId,
  ): Promise<DeliveryStatus> {
    const task = await findSend(conversationId, replyKey(entry));
    if (task === undefined) return { state: "sending" };
    const inspection = await harness.inspect(context);
    const live = inspection.tasks.find((item) => item.record.id === task.id);
    if (live?.state.kind === "blocked")
      return { state: "blocked", reason: live.state.reason };
    return sendOutcome(task);
  }

  async function status(
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
    return replyStatus(record.conversationId, record.entry);
  }

  function atAddress(
    key: AddressKey,
    run: (conversation: Conversation) => Promise<void>,
  ): Promise<void> {
    return serial(key, async () => {
      const state = await harness.snapshot(ChannelsDoc, context);
      const binding = findBinding(state, key);
      if (binding === undefined) return;
      const conversation = await harness.conversation(
        binding.conversationId,
        context,
      );
      if (conversation !== undefined) await run(conversation);
    });
  }

  const cancel = (conversation: Conversation) =>
    conversation.abort(context, { background: true });

  return {
    start,
    deliver,
    bind,
    status,
    cancel: (key) => atAddress(key, cancel),
    clear: (key) =>
      atAddress(key, async (conversation) => {
        await cancel(conversation);
        await conversation.reset(undefined, context);
      }),
    compact: (key) =>
      atAddress(key, async (conversation) => {
        await conversation.compact(undefined, context);
      }),
    end: (key) =>
      atAddress(key, async (conversation) => {
        await cancel(conversation);
        await harness.commit(async (tx) => {
          const state = await tx.doc(ChannelsDoc);
          deleteConversation(state, conversation.id);
        }, context);
      }),
  };
}
