import type {
  AdapterStart,
  ChannelAdapter,
  InboundMessage,
} from "@aliou/pi-durable-channels";
import { compile, obj, str } from "@earendil-works/pi-schema";
import { slackApi } from "./api";
import { SLACK_BLOCK_KIT } from "./block-kit";
import type {
  SlackConfig,
  SlackConfigTarget,
  SlackConversationType,
} from "./config";
import { createDiagnostics, validateManifest } from "./diagnostics";
import {
  describeEvent,
  inboundOf,
  mentionsBot,
  renamedThreadOf,
  type SlackMessage,
  slackMessageOf,
  stoppedAddressOf,
} from "./events";
import { fetchSlackFile } from "./files";
import { readHistory } from "./history";
import { conversationMetadata } from "./metadata";
import { createNaming, type NameThread } from "./naming";
import { slackReplies } from "./reply";
import type { SocketMode } from "./socket";
import { slackTarget, type Thread } from "./target";
import {
  listenSocket,
  type OnEvent,
  receiveHttp,
  type SlackTransport,
} from "./transport";

export type SlackOptions = {
  botToken: string;
  transport: SlackTransport;
  config(target: SlackConfigTarget): SlackConfig | Promise<SlackConfig>;
  nameThread?: NameThread;
  maxFileBytes?: number;
  apiUrl?: string;
  filesUrl?: string;
  maxBodyBytes?: number;
  appId?: string;
  configToken?: string;
};

const SLACK_API = "https://slack.com/api";
const SLACK_FILES = "https://files.slack.com";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

const Auth = compile(
  obj({ user_id: str(), team_id: str(), team: str() }, { open: true }),
);
function laterTimestamp(left: string | undefined, right: string): string {
  return left !== undefined && Number(left) > Number(right) ? left : right;
}

function atOrBefore(ts: string, cursor: string | undefined): boolean {
  return cursor !== undefined && Number(ts) <= Number(cursor);
}

function conversationType(
  value: string | undefined,
): SlackConversationType | undefined {
  switch (value) {
    case "channel":
    case "group":
    case "im":
    case "mpim":
      return value;
    default:
      return undefined;
  }
}

export function slackChannel(options: SlackOptions): ChannelAdapter {
  const apiUrl = options.apiUrl ?? SLACK_API;
  const call = slackApi(options.botToken, apiUrl);
  const metadata = conversationMetadata(call);
  const { transport } = options;
  let report: AdapterStart["report"] = () => undefined;
  const diagnose = createDiagnostics(call, (value) => report(value));
  const reportError = (thread?: Thread) => (error: unknown) =>
    report({
      kind: "adapter_error",
      error,
      ...(thread === undefined
        ? {}
        : { address: `${thread.channel}:${thread.threadTs}` }),
    });
  const naming = createNaming(call, options.nameThread, reportError);
  const replies = slackReplies(call, naming, reportError);
  const files = {
    botToken: options.botToken,
    origin: options.filesUrl ?? SLACK_FILES,
    maxBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
  };
  let onHttpEvent: OnEvent | undefined;
  let socket: SocketMode | undefined;
  let identity:
    | { teamId: string; teamName: string; botUserId: string }
    | undefined;
  const lanes = new Map<string, Promise<void>>();

  const receive = async (request: Request) =>
    transport.kind === "http" && onHttpEvent !== undefined
      ? receiveHttp(request, {
          signingSecret: transport.signingSecret,
          onEvent: onHttpEvent,
          maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
        })
      : new Response("Service Unavailable", { status: 503 });

  async function inLane(address: string, operation: () => Promise<void>) {
    const previous = lanes.get(address) ?? Promise.resolve();
    const lane = previous.catch(() => undefined).then(operation);
    lanes.set(address, lane);
    try {
      await lane;
    } finally {
      if (lanes.get(address) === lane) lanes.delete(address);
    }
  }

  async function configTarget(
    teamId: string,
    teamName: string,
    event: SlackMessage,
  ): Promise<SlackConfigTarget> {
    let name: string | undefined;
    let type = conversationType(event.channel_type);
    let metadataError: unknown;
    try {
      const conversation = await metadata(teamId, event.channel);
      name = conversation.name;
      type ??= conversation.type;
    } catch (error) {
      metadataError = error;
      diagnose(error, event.channel);
    }
    if (type === undefined)
      throw metadataError ?? new Error("Slack event has no conversation type");
    return {
      teamId,
      teamName,
      conversationId: event.channel,
      conversationName: name,
      conversationType: type,
      threadTs: event.thread_ts,
      userId: event.user,
    };
  }

  function receiver(
    ctx: AdapterStart,
    auth: { teamId: string; teamName: string; botUserId: string },
  ): OnEvent {
    return async ({ teamId, event }) => {
      const stopped = stoppedAddressOf(event);
      if (stopped !== undefined) {
        const exact = await ctx.binding(stopped);
        if (exact !== undefined) return ctx.cancel(stopped);
        return ctx.cancel(stopped.slice(0, stopped.indexOf(":")));
      }
      const renamed = renamedThreadOf(event);
      if (renamed !== undefined) return naming.renamedByUser(renamed);
      const slackMessage = slackMessageOf(event);
      if (slackMessage === undefined) {
        ctx.report({ kind: "skipped", detail: describeEvent(event) });
        return;
      }
      const target = await configTarget(teamId, auth.teamName, slackMessage);
      const config = await options.config(target);
      if (
        config.trigger === "mention" &&
        !mentionsBot(slackMessage, auth.botUserId)
      ) {
        ctx.report({ kind: "skipped", detail: describeEvent(event) });
        return;
      }
      const inbound = inboundOf(slackMessage, config);
      await inLane(inbound.message.address, async () => {
        const binding = await ctx.binding(inbound.message.address);
        if (
          config.trigger === "mention" &&
          atOrBefore(slackMessage.ts, binding?.cursor)
        )
          return;
        let message: InboundMessage = {
          ...inbound.message,
          cursor: laterTimestamp(binding?.cursor, slackMessage.ts),
        };
        if (config.trigger === "mention") {
          try {
            const history = await readHistory(call, {
              botUserId: auth.botUserId,
              address: inbound.message.address,
              after: binding?.cursor,
              before: slackMessage.ts,
              limits: config.context,
              signal: ctx.signal,
              boundedDeadline: true,
            });
            message = {
              ...message,
              text:
                history.content === ""
                  ? message.text
                  : `Earlier Slack history:\n${history.content}\n\nTriggering message:\n${message.text}`,
              files: [...history.files, ...(message.files ?? [])],
            };
          } catch (error) {
            diagnose(error, inbound.message.address);
            message = {
              ...message,
              text: `Earlier Slack history was unavailable.\n\nTriggering message:\n${message.text}`,
            };
          }
        }
        await ctx.deliver(message, inbound.options);
      });
    };
  }

  return {
    formats: [SLACK_BLOCK_KIT],
    start: async (ctx) => {
      report = ctx.report;
      const auth = await call("auth.test", {}, ctx.signal);
      if (!Auth.check(auth))
        throw new Error("Slack auth.test returned incomplete identity");
      identity = {
        teamId: auth.team_id,
        teamName: auth.team,
        botUserId: auth.user_id,
      };
      await validateManifest({
        appId: options.appId,
        configToken: options.configToken,
        apiUrl,
        report: ctx.report,
        signal: ctx.signal,
      });
      const onEvent = receiver(ctx, identity);
      if (transport.kind === "http") onHttpEvent = onEvent;
      else
        socket = await listenSocket({
          apiUrl,
          appToken: transport.appToken,
          onEvent,
          onError: reportError(),
          signal: ctx.signal,
        });
    },
    ...(transport.kind === "http"
      ? { fetch: receive }
      : {
          stop: async () => {
            await socket?.done;
          },
        }),
    send: replies.send,
    events: replies.events,
    history: async (request, ctx) => {
      if (identity === undefined)
        throw new Error("Slack adapter is not started");
      const target = slackTarget(request.address, undefined);
      const conversation = await metadata(
        identity.teamId,
        target.channel,
        ctx.signal,
      ).catch((error: unknown) => {
        diagnose(error, request.address);
        throw error;
      });
      const config = await options.config({
        teamId: identity.teamId,
        teamName: identity.teamName,
        conversationId: target.channel,
        conversationName: conversation.name,
        conversationType: conversation.type,
        threadTs: target.threadTs,
        userId: undefined,
      });
      if (!config.readTool)
        throw new Error("Slack history is disabled for this conversation");
      return readHistory(call, {
        botUserId: identity.botUserId,
        address: request.address,
        after: request.after,
        before: request.before,
        limits: {
          ...config.context,
          maxBytes: Math.min(config.context.maxBytes, request.maxBytes),
        },
        signal: ctx.signal,
      }).catch((error: unknown) => {
        diagnose(error, request.address);
        throw error;
      });
    },
    fetchFile: (url) => fetchSlackFile(url, files),
  };
}
