import type { JsonValue } from "@earendil-works/chord/json";
import type { Tx } from "@earendil-works/pi-durable";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
} from "@earendil-works/pi-durable";
import { type BindTarget, bindAddress, EXTENSION } from "./bind";
import { replyHook } from "./hook";
import { type ChannelsHub, createHub, type HubOptions } from "./hub";
import { reporter } from "./report";
import { defineSendTask } from "./send";
import { defineChannelTools } from "./tools";
import type { ChannelRegistration, ChannelsOptions } from "./types";

const DEFAULT_RETRY = { attempts: 5, baseDelayMs: 1000 };

export type ChannelSend = {
  channel: string;
  address: string;
  text: string;
  idempotencyKey: string;
  addressData?: JsonValue;
};

export type Send = (
  tx: Tx,
  conversationId: ConversationId,
  input: ChannelSend,
) => Promise<void>;

export type Channels = {
  extension: Extension;
  tools: Extension;
  bind(
    tx: Tx,
    target: BindTarget,
    conversationId: ConversationId,
  ): Promise<void>;
  send: Send;
  hub(harness: Harness, options?: HubOptions): ChannelsHub;
};

export function createChannels(options: ChannelsOptions): Channels {
  const registration = (channel: string): ChannelRegistration => {
    if (!Object.hasOwn(options.channels, channel))
      throw new Error(`No channel ${channel}`);
    return options.channels[channel];
  };
  const adapterFor = (channel: string) =>
    Object.hasOwn(options.channels, channel)
      ? options.channels[channel].adapter
      : undefined;
  const report = reporter(options.onReport);
  const Send = defineSendTask(
    adapterFor,
    options.retry ?? DEFAULT_RETRY,
    report,
  );
  const send: Send = async (tx, conversationId, input) => {
    registration(input.channel);
    await tx.createTask(
      Send,
      {
        channel: input.channel,
        address: input.address,
        parts: [{ type: "text", text: input.text }],
        idempotencyKey: input.idempotencyKey,
        ...(input.addressData === undefined
          ? {}
          : { addressData: input.addressData }),
      },
      {
        ownership: { kind: "conversation" },
        conversationId,
        background: true,
      },
    );
  };

  return {
    extension: defineExtension({
      name: EXTENSION,
      tasks: [Send],
      hooks: [hook(GenerationTask, { afterRun: replyHook(Send) })],
    }),
    tools: defineChannelTools(
      send,
      adapterFor,
      Object.values(options.channels).some(
        ({ adapter }) => adapter.history !== undefined,
      ),
    ),
    bind: async (tx, target, conversationId) => {
      registration(target.channel);
      await bindAddress(tx, target, conversationId);
    },
    send,
    hub: (harness, hubOptions) =>
      createHub(harness, {
        options,
        registration,
        adapterFor,
        report,
        env: hubOptions?.env,
      }),
  };
}
