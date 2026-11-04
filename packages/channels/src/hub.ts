import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  type ConversationId,
  configure,
  type Harness,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { type EnvBuilder, messageContent } from "./attachments";
import { type BindTarget, bindAddress } from "./bind";
import {
  ChannelsDoc,
  conversationAddresses,
  deleteConversation,
  findBinding,
  setBinding,
} from "./doc";
import { type ProgressWatch, watchProgress } from "./progress";
import type { Reporter } from "./report";
import type { AdapterLookup } from "./send";
import { deliveryStatus } from "./status";
import { messageData, submission } from "./submission";
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

export type ChannelsHub = {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver(
    channel: string,
    message: InboundMessage,
    options?: DeliverOptions,
  ): Promise<DeliveryReceipt | undefined>;
  bind(target: BindTarget, conversationId: ConversationId): Promise<void>;
  addresses(conversationId: ConversationId): Promise<AddressKey[]>;
  conversationOf(key: AddressKey): Promise<ConversationId | undefined>;
  status(deliveryId: SubmissionId): Promise<DeliveryStatus | undefined>;
  cancel(key: AddressKey): Promise<void>;
  clear(key: AddressKey): Promise<void>;
  compact(key: AddressKey): Promise<void>;
  end(key: AddressKey): Promise<void>;
};

export type HubSetup = {
  options: ChannelsOptions;
  registration(channel: string): ChannelRegistration;
  adapterFor: AdapterLookup;
  report: Reporter;
  env: EnvBuilder | undefined;
};

export type HubOptions = { env?: EnvBuilder };

const cancel = (conversation: Conversation) =>
  conversation.abort(context, { background: true });

export function createHub(harness: Harness, setup: HubSetup): ChannelsHub {
  const tails = new Map<string, Promise<unknown>>();
  const controller = new AbortController();
  const adapters = Object.values(setup.options.channels).map(
    ({ adapter }) => adapter,
  );
  let starting: Promise<void> | undefined;
  let watcher: ProgressWatch | undefined;
  let stopping: Promise<void> | undefined;

  function serial<T>(key: AddressKey, run: () => Promise<T>): Promise<T> {
    if (stopping !== undefined)
      return Promise.reject(new Error("Channels hub is stopped"));
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
      const created = factory?.(message, { channel: key.channel });
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
    const create = options.run && options.create;
    const conversationId = await conversationFor(key, message, create);
    if (conversationId === undefined) {
      setup.report({ kind: "ignored", ...key });
      return undefined;
    }
    const conversation = await harness.conversation(conversationId, context);
    if (conversation === undefined)
      throw new Error(`Conversation ${conversationId} not found`);
    const content = await messageContent(
      message,
      {
        adapter: setup.registration(key.channel).adapter,
        env: setup.env,
        read: harness,
        conversationId,
      },
      context,
    );
    const admitted = await harness.commit(async (tx) => {
      const known = await tx.submissionByRequest(
        conversationId,
        message.requestId,
      );
      if (known !== undefined)
        return { submissionId: known.id, duplicate: true };
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
      const draft = submission(message.requestId, content, data, options);
      const submissionId = await conversation.submit(tx, draft);
      return { submissionId, duplicate: false };
    }, context);
    setup.report({ kind: "admitted", ...key, conversationId, ...admitted });
    return { submissionId: admitted.submissionId, conversationId };
  }

  const deliver: ChannelsHub["deliver"] = async (channel, message, options) => {
    setup.registration(channel);
    const key = { channel, address: message.address };
    const resolved = {
      whenBusy: options?.whenBusy ?? setup.options.whenBusy ?? "queue",
      run: options?.run ?? true,
      create: options?.create ?? true,
    };
    return serial(key, () => admit(key, message, resolved));
  };

  function start(): Promise<void> {
    if (starting !== undefined || stopping !== undefined)
      return Promise.reject(new Error("Channels hub can only start once"));
    starting = startAll();
    return starting;
  }

  async function startAll(): Promise<void> {
    const channels = Object.entries(setup.options.channels);
    if (adapters.some((adapter) => adapter.progress !== undefined))
      watcher = await watchProgress(harness, setup.adapterFor, setup.report);
    const { signal } = controller;
    await Promise.all(
      channels.map(([channel, { adapter }]) =>
        adapter.start?.({
          deliver: (message, options) => deliver(channel, message, options),
          cancel: (address) => cancelAt({ channel, address }),
          report: (report) => setup.report({ ...report, channel }),
          signal,
        }),
      ),
    );
  }

  async function drain(): Promise<void> {
    await starting?.catch(() => undefined);
    await Promise.all(tails.values());
    await watcher?.stop();
    controller.abort();
    if (starting === undefined) return;
    await Promise.all(adapters.map((adapter) => adapter.stop?.()));
  }

  function stop(): Promise<void> {
    stopping ??= drain();
    return stopping;
  }

  async function bind(target: BindTarget, conversationId: ConversationId) {
    setup.registration(target.channel);
    return serial(target, () =>
      harness.commit((tx) => bindAddress(tx, target, conversationId), context),
    );
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

  const cancelAt = (key: AddressKey) => atAddress(key, cancel);

  async function addresses(conversationId: ConversationId) {
    const state = await harness.snapshot(ChannelsDoc, context);
    return conversationAddresses(state, conversationId);
  }

  async function conversationOf(key: AddressKey) {
    const state = await harness.snapshot(ChannelsDoc, context);
    return findBinding(state, key)?.conversationId;
  }

  return {
    start,
    stop,
    deliver,
    bind,
    addresses,
    conversationOf,
    status: (deliveryId) => deliveryStatus(harness, deliveryId),
    cancel: cancelAt,
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
