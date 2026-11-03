import {
  defineExtension,
  defineTool,
  type Extension,
  section,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { ChannelsDoc, conversationAddresses, findBinding } from "./doc";
import type { SendTask } from "./send";

export const TOOLS_EXTENSION = "channels-tools";

function text(value: string, isError = false) {
  return { output: [{ type: "text" as const, text: value }], isError };
}

export function defineChannelTools(Send: SendTask): Extension {
  const sendMessage = defineTool({
    name: "send_message",
    description:
      "Send a text message to one of your channel addresses, delivered in the background and retried on failure. Your final answer is already sent to the address of the message you are answering, so never use this to send that answer; use it to reach your other addresses, or to post an update before you finish.",
    parameters: obj({ channel: str(), address: str(), text: str() }),
    execute: async ({ channel, address, text: body }, api, context) => {
      const state = await api.snapshot(ChannelsDoc, context);
      const binding = findBinding(state, { channel, address });
      if (binding?.conversationId !== api.conversationId)
        return text(`Unknown address ${address} on channel ${channel}.`, true);
      const input = {
        channel,
        address,
        parts: [{ type: "text" as const, text: body }],
        idempotencyKey: `notify:${api.taskId}`,
        ...(binding.addressData === undefined
          ? {}
          : { addressData: binding.addressData }),
      };
      await api.createTask(
        Send,
        input,
        { ownership: { kind: "conversation" }, background: true },
        context,
      );
      return text(`Message queued for ${address} on ${channel}.`);
    },
  });

  const listAddresses = defineTool({
    name: "list_addresses",
    description: "List the channel addresses you can send messages to.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const state = await api.snapshot(ChannelsDoc, context);
      const addresses = conversationAddresses(state, api.conversationId);
      return text(JSON.stringify(addresses));
    },
  });

  const channelsSection = section(
    "channels",
    async ({ read, conversationId }, context) => {
      const state = await read.snapshot(ChannelsDoc, context);
      const addresses = conversationAddresses(state, conversationId);
      const lines = addresses.map(
        ({ channel, address }) => `- ${channel}: ${address}`,
      );
      return [
        "Your final answer goes to the address of the message you are answering. Use send_message only for your other addresses, or for an update before you finish. Your addresses:",
        ...(lines.length === 0 ? ["(none yet)"] : lines),
      ].join("\n");
    },
  );

  return defineExtension({
    name: TOOLS_EXTENSION,
    tools: [sendMessage, listAddresses],
    sections: [channelsSection],
  });
}
