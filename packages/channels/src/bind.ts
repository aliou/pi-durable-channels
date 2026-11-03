import { copyJson, type JsonValue } from "@earendil-works/chord";
import {
  AgentDoc,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { ChannelsDoc, findBinding, setBinding } from "./doc";
import type { AddressKey } from "./types";

export const EXTENSION = "channels";

export type BindTarget = AddressKey & { addressData?: JsonValue };

async function selectChannels(tx: Tx, id: ConversationId): Promise<void> {
  const state = await tx.doc(AgentDoc, id);
  const selected = state.extensions;
  if (!Array.isArray(selected) || selected.includes(EXTENSION)) return;
  state.extensions = [...selected, EXTENSION];
}

export async function bindAddress(
  tx: Tx,
  target: BindTarget,
  conversationId: ConversationId,
): Promise<void> {
  const state = await tx.doc(ChannelsDoc);
  const existing = findBinding(state, target);
  if (existing !== undefined && existing.conversationId !== conversationId) {
    throw new Error(
      `Address ${target.address} on channel ${target.channel} belongs to another conversation`,
    );
  }
  const addressData = target.addressData ?? existing?.addressData;
  setBinding(state, target, {
    conversationId,
    ...(addressData === undefined
      ? {}
      : { addressData: copyJson(addressData) }),
  });
  await selectChannels(tx, conversationId);
}
