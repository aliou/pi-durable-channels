import type { ChannelAdapter } from "@aliou/pi-durable-channels";
import {
  SLACK_BLOCK_KIT,
  type SlackBlockKit,
} from "@aliou/pi-durable-channels-slack";

export function factoryReplies(
  adapter: ChannelAdapter,
  repository: string,
): ChannelAdapter {
  return {
    ...adapter,
    send: (message, ctx) =>
      adapter.send(
        {
          ...message,
          parts: message.parts.map((part) => {
            const representation: SlackBlockKit = {
              blocks: [
                {
                  type: "header",
                  text: { type: "plain_text", text: "Software factory" },
                },
                {
                  type: "section",
                  text: { type: "mrkdwn", text: part.text },
                },
                {
                  type: "context",
                  elements: [
                    { type: "mrkdwn", text: `Repository: ${repository}` },
                  ],
                },
              ],
            };
            return {
              ...part,
              representations: {
                ...part.representations,
                [SLACK_BLOCK_KIT]: representation,
              },
            };
          }),
        },
        ctx,
      ),
  };
}
