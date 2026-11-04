import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessOptions,
  type HarnessSettings,
  type Report,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import { afterEach } from "vitest";
import {
  type ChannelAdapter,
  type ChannelRegistration,
  type ChannelReport,
  type Channels,
  type ChannelsHub,
  type ChannelsOptions,
  createChannels,
  type DeliverOptions,
  type InboundMessage,
  type OutboundMessage,
  type SendContext,
  type SendResult,
} from "../src";

export const context = BACKGROUND_CONTEXT;
export const MODEL = { provider: "faux", modelId: "faux-1" };

export type Sent = {
  message: OutboundMessage;
  ctx: Omit<SendContext, "signal">;
};

export type TestAdapter = ChannelAdapter & {
  sent: Sent[];
  failures: number;
  hold?: boolean;
  result?: (sent: Sent) => SendResult | undefined;
};

export function testAdapter(): TestAdapter {
  const adapter: TestAdapter = {
    sent: [],
    failures: 0,
    send: async (message, { signal, ...ctx }) => {
      adapter.sent.push({ message, ctx });
      if (adapter.hold === true) {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      }
      if (adapter.failures > 0) {
        adapter.failures--;
        throw new Error("platform unavailable");
      }
      return adapter.result?.({ message, ctx });
    },
  };
  return adapter;
}

export type Gate = { promise: Promise<void>; open(): void };

export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function messageText(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

export type Responder = (
  lastText: string,
  last: Message | undefined,
) => AssistantMessage | Promise<AssistantMessage>;

export const echo: Responder = (text, last) =>
  fauxAssistantMessage(
    last?.role === "toolResult" ? `tool said ${text}` : `echo ${text}`,
  );

export function textOf(
  entry: { model?: readonly Message[] } | undefined,
): string {
  return messageText(entry?.model?.[0]);
}

export const holdTool = (held: { gate?: Gate }) =>
  defineExtension({
    name: "test-work",
    tools: [
      defineTool({
        name: "work",
        description: "Work for a while",
        parameters: obj({}),
        execute: async () => {
          await held.gate?.promise;
          return { output: [{ type: "text", text: "worked" }] };
        },
      }),
    ],
  });

const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
  directories.clear();
});

export async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-channels-"));
  directories.add(directory);
  return directory;
}

export async function sqliteStorage(): Promise<() => Promise<Storage>> {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-channels-"));
  directories.add(directory);
  return () => openNodeSqliteStorage(join(directory, "session.sqlite"));
}

export function killable(inner: Storage): { storage: Storage; kill(): void } {
  let dead = false;
  const storage = new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        dead ? new Promise(() => {}) : value.apply(target, args);
    },
  });
  return {
    storage,
    kill: () => {
      dead = true;
    },
  };
}

export const createWeb = () => ({ agent: { model: MODEL } });

export type SetupOptions = Partial<ChannelsOptions> & {
  faux?: Parameters<typeof fauxProvider>[0];
  env?: HarnessOptions["env"];
  conversation?: ChannelRegistration["conversation"];
  respond?: Responder;
  settings?: HarnessSettings;
  extensions?: Extension[];
  extend?: (channels: Channels) => Extension[];
};

export function setup(options: SetupOptions = {}) {
  const adapter = testAdapter();
  const channelReports: ChannelReport[] = [];
  const channelsOptions: ChannelsOptions = {
    channels: options.channels ?? {
      web: { adapter, conversation: options.conversation ?? createWeb },
    },
    retry: options.retry ?? { attempts: 3, baseDelayMs: 1 },
    onReport: (report) => {
      channelReports.push(report);
      options.onReport?.(report);
    },
    ...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
  };
  const channels = createChannels(channelsOptions);
  const state = { respond: options.respond ?? echo };
  const faux = fauxProvider(options.faux);
  const factory: FauxResponseFactory = (transcript) => {
    const last = transcript.messages
      .filter((message) => message.role !== "system")
      .at(-1);
    return state.respond(messageText(last), last);
  };
  faux.setResponses(Array.from({ length: 200 }, () => factory));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(channels.extension);
  registry.install(channels.tools);
  const extensions = [
    ...(options.extensions ?? []),
    ...(options.extend?.(channels) ?? []),
  ];
  for (const extension of extensions) registry.install(extension);
  const reports: Report[] = [];

  async function open(storage: Storage) {
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: options.settings ?? {},
        onReport: (report) => reports.push(report),
        env: options.env,
      },
      context,
    );
    const hub = channels.hub(harness, { env: options.env });
    const deliver = (
      message: InboundMessage,
      deliverOptions?: DeliverOptions,
      channel = "web",
    ) => accepted(hub.deliver(channel, message, deliverOptions));
    return { harness, hub, deliver };
  }

  return { adapter, channels, state, open, reports, channelReports };
}

export async function accepted<T>(receipt: Promise<T | undefined>): Promise<T> {
  const value = await receipt;
  if (value === undefined) throw new Error("delivery was ignored");
  return value;
}

export function inbound(
  text: string,
  requestId: string,
  extra: {
    address?: string;
    replyContext?: JsonValue;
    addressData?: JsonValue;
  } = {},
) {
  return {
    address: extra.address ?? "thread-1",
    text,
    requestId,
    author: "ana",
    ...extra,
  };
}

export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const done = await check();
    if (done) return;
    if (Date.now() - start > timeoutMs)
      throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function conversationOf(
  harness: Harness,
  id: ConversationId,
): Promise<Conversation> {
  const conversation = await harness.conversation(id, context);
  if (conversation === undefined) throw new Error(`no conversation ${id}`);
  return conversation;
}

export async function entriesOf(
  conversation: Conversation,
): Promise<readonly EntryRecord[]> {
  const page = await conversation.entries(
    { order: "ascending" },
    100,
    undefined,
    context,
  );
  return page.items;
}

export async function stateOf(
  hub: ChannelsHub,
  id: Parameters<ChannelsHub["status"]>[0],
) {
  const status = await hub.status(id);
  return status?.state;
}
