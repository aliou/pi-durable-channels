import {
  defineExtension,
  defineTool,
  type Extension,
  section,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Send } from "./core";
import {
  ChannelsDoc,
  canonicalConversationAddresses,
  conversationAddresses,
  findBinding,
} from "./doc";
import type { AdapterLookup } from "./send";

export const TOOLS_EXTENSION = "channels-tools";

export const NO_REPLY = "no_reply";

const HISTORY_BYTES = 32 * 1024;

function text(value: string, isError = false) {
  return { output: [{ type: "text" as const, text: value }], isError };
}

function boundedContent(content: string): {
  content: string;
  truncated: boolean;
} {
  const encoder = new TextEncoder();
  let end = 0;
  let size = 0;
  let truncated = false;
  for (const character of content) {
    const length = encoder.encode(character).length;
    if (size + length > HISTORY_BYTES) {
      truncated = true;
      break;
    }
    size += length;
    end += character.length;
  }
  return { content: truncated ? content.slice(0, end) : content, truncated };
}

export function defineChannelTools(
  send: Send,
  adapterFor: AdapterLookup,
  historyAvailable: boolean,
): Extension {
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
      await api.commit(
        (tx) =>
          send(tx, api.conversationId, {
            channel,
            address,
            text: body,
            idempotencyKey: `notify:${api.taskId}`,
            ...(binding.addressData === undefined
              ? {}
              : { addressData: binding.addressData }),
          }),
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

  const readHistory = defineTool({
    name: "read_history",
    description:
      "Read bounded source history for one of your channel addresses. Use after or before to continue from an opaque cursor returned by the channel.",
    parameters: obj({
      channel: str(),
      address: str(),
      after: opt(str()),
      before: opt(str()),
    }),
    replay: "safe",
    execute: async ({ channel, address, after, before }, api, context) => {
      const state = await api.snapshot(ChannelsDoc, context);
      const binding = findBinding(state, { channel, address });
      if (binding?.conversationId !== api.conversationId)
        return text(`Unknown address ${address} on channel ${channel}.`, true);
      const adapter = adapterFor(channel);
      if (adapter?.history === undefined)
        return text(`History is unavailable on channel ${channel}.`, true);
      try {
        const result = await adapter.history(
          {
            address,
            ...(after === undefined ? {} : { after }),
            ...(before === undefined ? {} : { before }),
            maxBytes: HISTORY_BYTES,
          },
          { signal: context.abortSignal ?? new AbortController().signal },
        );
        const bounded = boundedContent(result.content);
        return text(
          JSON.stringify({
            content: bounded.content,
            ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
            truncated: result.truncated || bounded.truncated,
          }),
        );
      } catch (error) {
        return text(
          `History read failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    },
  });

  const noReply = defineTool({
    name: NO_REPLY,
    description:
      "End this run without answering. Use it when the latest message needs no answer from you, such as a thread message meant for someone else. Call it alone, without writing text.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => ({
      ...text("No reply sent."),
      control: { terminate: true },
    }),
  });

  const channelsSection = section(
    "channels",
    async ({ read, conversationId }, context) => {
      const state = await read.snapshot(ChannelsDoc, context);
      const addresses = canonicalConversationAddresses(state, conversationId);
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
    tools: [
      sendMessage,
      listAddresses,
      ...(historyAvailable ? [readHistory] : []),
      noReply,
    ],
    sections: [channelsSection],
  });
}
