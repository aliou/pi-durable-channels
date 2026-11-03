import type { JsonValue } from "@earendil-works/chord";
import type { SubmissionDraft, UserInput } from "@earendil-works/pi-durable";
import { ChannelMessage, type ChannelMessageData, ChannelNote } from "./doc";
import type { AddressKey, DeliverOptions, InboundMessage } from "./types";

const WHEN_BUSY = { queue: "followUp", steer: "steer" } as const;

export function messageData(
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

export function submission(
  requestId: string,
  content: UserInput,
  data: ChannelMessageData,
  options: Required<DeliverOptions>,
): SubmissionDraft {
  if (options.run) {
    return {
      type: "input",
      content,
      requestId,
      whenBusy: WHEN_BUSY[options.whenBusy],
      entry: { kind: ChannelMessage.kind, data },
    };
  }
  const model = [{ role: "user" as const, content, timestamp: Date.now() }];
  return {
    type: "write",
    requestId,
    entry: { kind: ChannelNote.kind, data, model },
  };
}
