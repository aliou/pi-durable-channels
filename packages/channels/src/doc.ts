import type { JsonValue } from "@earendil-works/chord";
import type { Draft } from "@earendil-works/chord/delta";
import {
  type ConversationId,
  defineDoc,
  defineEntry,
} from "@earendil-works/pi-durable";
import type { AddressKey } from "./types";

export type Binding = {
  conversationId: ConversationId;
  addressData?: JsonValue;
};

type Bindings = Record<string, Record<string, Binding>>;

export type ChannelsState = { bindings: Bindings };

export const ChannelsDoc = defineDoc<ChannelsState>({
  kind: "channels.bindings",
  version: 1,
  scope: "session",
  initial: () => ({ bindings: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

export type ChannelMessageData = AddressKey & {
  author: string;
  addressData?: JsonValue;
  replyContext?: JsonValue;
};

export const ChannelMessage =
  defineEntry<ChannelMessageData>("channel.message");

export const ChannelNote = defineEntry<ChannelMessageData>("channel.note");

function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined;
  return record[key];
}

export function findBinding(
  state: Readonly<ChannelsState> | undefined,
  key: AddressKey,
): Binding | undefined {
  return own(own(state?.bindings, key.channel), key.address);
}

export function setBinding(
  state: Draft<ChannelsState>,
  key: AddressKey,
  binding: Binding,
): void {
  if (!Object.hasOwn(state.bindings, key.channel))
    state.bindings[key.channel] = {};
  state.bindings[key.channel][key.address] = binding;
}
