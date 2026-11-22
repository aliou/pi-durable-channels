export type SlackConversationType = "channel" | "group" | "im" | "mpim";

export type SlackConfigTarget = {
  teamId: string;
  teamName: string;
  conversationId: string;
  conversationName: string | undefined;
  conversationType: SlackConversationType;
  threadTs: string | undefined;
  userId: string | undefined;
};

export type SlackConfig = {
  scope: "thread" | "conversation";
  trigger: "every_message" | "mention";
  context: {
    maxMessages: number;
    maxBytes: number;
    maxFiles: number;
  };
  readTool: boolean;
};
