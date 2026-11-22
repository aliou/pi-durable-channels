import { bool, compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { SlackCall } from "./api";
import type { SlackConversationType } from "./config";

const Conversation = obj(
  {
    id: str(),
    name: opt(str()),
    is_channel: opt(bool()),
    is_group: opt(bool()),
    is_im: opt(bool()),
    is_mpim: opt(bool()),
  },
  { open: true },
);
const Info = compile(obj({ channel: Conversation }, { open: true }));

export type ConversationMetadata = {
  name: string | undefined;
  type: SlackConversationType;
};

function typeOf(channel: {
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}): SlackConversationType | undefined {
  if (channel.is_im === true) return "im";
  if (channel.is_mpim === true) return "mpim";
  if (channel.is_group === true) return "group";
  if (channel.is_channel === true) return "channel";
  return undefined;
}

const MAX_CONVERSATIONS = 1000;

export function conversationMetadata(call: SlackCall) {
  const cache = new Map<string, ConversationMetadata>();

  return async (
    teamId: string,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ConversationMetadata> => {
    const key = `${teamId}:${conversationId}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const response = await call(
      "conversations.info",
      { channel: conversationId },
      signal,
    );
    if (!Info.check(response))
      throw new Error("Slack conversations.info returned no conversation");
    const type = typeOf(response.channel);
    if (type === undefined)
      throw new Error("Slack conversations.info returned an unknown type");
    const metadata = { name: response.channel.name, type };
    if (cache.size >= MAX_CONVERSATIONS) {
      const [oldest] = cache.keys();
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, metadata);
    return metadata;
  };
}
