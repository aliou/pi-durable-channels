import type {
  AdapterStart,
  ChannelAdapter,
  ChannelReport,
  OutboundMessage,
} from "@aliou/pi-durable-channels";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";

const PREVIEW = 300;

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat;
}

function log(scope: string, ...parts: unknown[]): void {
  const time = new Date().toISOString().slice(11, 19);
  console.log(time, scope, ...parts);
}

const conversation = (id: ConversationId) => `[c${id}]`;

export function logReport(report: ChannelReport): void {
  const { kind, channel, ...details } = report;
  const shown = Object.entries(details).map(
    ([key, value]) =>
      `${key}=${value instanceof Error ? value.message : preview(value)}`,
  );
  log(`[${channel}]`, kind, ...shown);
}

function describeResponse(message: AssistantMessage): string {
  const parts = message.content.flatMap((part) => {
    if (part.type === "text") return [`text: ${preview(part.text)}`];
    if (part.type === "toolCall") return [`call ${part.name}`];
    return [];
  });
  const error =
    message.errorMessage === undefined
      ? []
      : [`error: ${message.errorMessage}`];
  return [`stop=${message.stopReason}`, ...parts, ...error].join(" | ");
}

export const activityLog = defineExtension({
  name: "activity-log",
  hooks: [
    hook(GenerationTask, {
      afterResponse: (message, api) => {
        log(
          conversation(api.conversationId),
          "model",
          describeResponse(message),
        );
      },
    }),
    hook(ToolTask, {
      beforeTool: (call, api) => {
        log(
          conversation(api.conversationId),
          "tool",
          call.name,
          preview(call.arguments),
        );
        return undefined;
      },
      afterTool: (call, result, api) => {
        const status = result.isError === true ? "failed" : "done";
        const problems = (result.diagnostics ?? []).map(
          ({ message }) => message,
        );
        const shown = problems.length > 0 ? problems : result.output;
        log(
          conversation(api.conversationId),
          "tool",
          call.name,
          status,
          preview(shown),
        );
        return undefined;
      },
    }),
  ],
});

function textOf(message: OutboundMessage): string {
  return message.parts.map((part) => part.text).join("");
}

export function logged(
  channel: string,
  adapter: ChannelAdapter,
): ChannelAdapter {
  const start = (ctx: AdapterStart) =>
    adapter.start?.({
      ...ctx,
      deliver: async (message, options) => {
        const receipt = await ctx.deliver(message, options);
        const outcome =
          receipt === undefined ? "ignored" : `c${receipt.conversationId}`;
        log(
          `[${channel}]`,
          "in",
          message.address,
          message.event ?? "",
          `@${message.author}`,
          JSON.stringify(options ?? {}),
          "→",
          outcome,
          preview(message.text),
        );
        return receipt;
      },
      cancel: async (address) => {
        log(`[${channel}]`, "cancel", address);
        await ctx.cancel(address);
      },
    });
  return {
    ...adapter,
    start,
    send: (message, ctx) => {
      log(
        `[${channel}]`,
        "out",
        message.address,
        ctx.idempotencyKey,
        preview(textOf(message)),
      );
      return adapter.send(message, ctx);
    },
  };
}
