import type { AdapterStart, ChannelAdapter } from "@aliou/pi-durable-channels";
import { compile, obj, str } from "@earendil-works/pi-schema";
import { slackApi } from "./api";
import {
  describeEvent,
  inboundOf,
  renamedThreadOf,
  stoppedAddressOf,
  type ThreadMessages,
} from "./events";
import { fetchSlackFile } from "./files";
import { createNaming, type NameThread } from "./naming";
import { slackReplies } from "./reply";
import {
  listenSocket,
  type OnEvent,
  receiveHttp,
  type SlackTransport,
} from "./transport";

export type SlackOptions = {
  botToken: string;
  transport: SlackTransport;
  threadMessages?: ThreadMessages;
  nameThread?: NameThread;
  maxFileBytes?: number;
  debug?: boolean;
  apiUrl?: string;
  filesUrl?: string;
  maxBodyBytes?: number;
};

export type SlackChannel = ChannelAdapter & {
  fetch(request: Request): Promise<Response>;
};

const SLACK_API = "https://slack.com/api";
const SLACK_FILES = "https://files.slack.com";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

const Auth = compile(obj({ user_id: str() }, { open: true }));

export function slackChannel(options: SlackOptions): SlackChannel {
  const apiUrl = options.apiUrl ?? SLACK_API;
  const call = slackApi(options.botToken, apiUrl);
  const { transport } = options;
  const naming = createNaming(call, options.nameThread, (error) =>
    console.error("slack naming", error),
  );
  const replies = slackReplies(call, naming);
  const files = {
    botToken: options.botToken,
    origin: options.filesUrl ?? SLACK_FILES,
    maxBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
  };
  let onHttpEvent: OnEvent | undefined;

  function receiver(ctx: AdapterStart, botUserId: string): OnEvent {
    return async (event) => {
      const stopped = stoppedAddressOf(event);
      if (stopped !== undefined) return ctx.cancel(stopped);
      const renamed = renamedThreadOf(event);
      if (renamed !== undefined) return naming.renamedByUser(renamed);
      const inbound = inboundOf(event, {
        botUserId,
        threadMessages: options.threadMessages,
      });
      if (inbound !== undefined) {
        await ctx.deliver(inbound.message, inbound.options);
        return;
      }
      if (options.debug === true)
        console.error("slack skipped", describeEvent(event));
    };
  }

  return {
    start: async (ctx) => {
      const auth = await call("auth.test", {}, ctx.signal);
      if (!Auth.check(auth))
        throw new Error("Slack auth.test returned no user_id");
      const onEvent = receiver(ctx, auth.user_id);
      if (transport.kind === "http") onHttpEvent = onEvent;
      else
        listenSocket({
          apiUrl,
          appToken: transport.appToken,
          onEvent,
          signal: ctx.signal,
        });
    },
    fetch: async (request) =>
      transport.kind === "http" && onHttpEvent !== undefined
        ? receiveHttp(request, {
            signingSecret: transport.signingSecret,
            onEvent: onHttpEvent,
            maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
          })
        : new Response("Service Unavailable", { status: 503 }),
    send: replies.send,
    progress: replies.progress,
    fetchFile: (url) => fetchSlackFile(url, files),
  };
}
