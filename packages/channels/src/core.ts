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

export type Channels = {
  extension: Extension;
  tools: Extension;
  bind(
    tx: Tx,
    target: BindTarget,
    conversationId: ConversationId,
  ): Promise<void>;
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

  return {
    extension: defineExtension({
      name: EXTENSION,
      tasks: [Send],
      hooks: [hook(GenerationTask, { afterRun: replyHook(Send) })],
    }),
    tools: defineChannelTools(Send),
    bind: async (tx, target, conversationId) => {
      registration(target.channel);
      await bindAddress(tx, target, conversationId);
    },
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
