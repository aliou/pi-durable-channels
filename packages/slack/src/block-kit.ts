import type { OutboundMessage } from "@aliou/pi-durable-channels";
import type { JsonValue } from "@earendil-works/chord";
import {
  arr,
  compile,
  obj,
  type Schema,
  type Static,
  unknown,
} from "@earendil-works/pi-schema";

export const SLACK_BLOCK_KIT = "slack.block-kit";

const BlockKit = obj({ blocks: arr(unknown() as Schema<JsonValue>) });
const Representation = compile(BlockKit);

export type SlackBlockKit = Static<typeof BlockKit>;

export function blockKitBlocks(
  message: OutboundMessage,
): unknown[] | undefined {
  let represented = false;
  const blocks: unknown[] = [];
  for (const part of message.parts) {
    const representation = part.representations?.[SLACK_BLOCK_KIT];
    if (representation === undefined) {
      if (part.representations !== undefined) return undefined;
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: part.text },
      });
      continue;
    }
    if (!Representation.check(representation)) return undefined;
    represented = true;
    blocks.push(...representation.blocks);
  }
  return represented ? blocks : undefined;
}
