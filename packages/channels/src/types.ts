import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-ai";
import type {
  AgentChange,
  ConversationId,
  ConversationInit,
  SubmissionId,
} from "@earendil-works/pi-durable";

export type BusyPolicy = "queue" | "steer";

export type InboundFile = { name: string; mimeType: string; url: string };

export type InboundMessage = {
  address: string;
  text: string;
  requestId: string;
  author: string;
  event?: string;
  files?: readonly InboundFile[];
  addressData?: JsonValue;
  replyContext?: JsonValue;
};

export type DeliverOptions = {
  whenBusy?: BusyPolicy;
  run?: boolean;
  create?: boolean;
};

export type OutboundPart = {
  type: "text";
  text: string;
  representations?: Readonly<Record<string, JsonValue>>;
};

export type OutboundMessage = {
  address: string;
  parts: readonly OutboundPart[];
};

export type SendContext = {
  addressData?: JsonValue;
  replyContext?: JsonValue;
  idempotencyKey: string;
  signal: AbortSignal;
};

export type SendResult = { addressData?: JsonValue; alias?: string };

export type DeliveryReceipt = {
  submissionId: SubmissionId;
  conversationId: ConversationId;
};

export type Deliver = (
  message: InboundMessage,
  options?: DeliverOptions,
) => Promise<DeliveryReceipt | undefined>;

export type ReplyTarget = {
  address: string;
  addressData?: JsonValue;
  replyContext?: JsonValue;
  idempotencyKey: string;
};

export type ChannelEvent =
  | { type: "run_started" }
  | { type: "text"; id: string; text: string }
  | { type: "tool_started"; id: string; name: string; args: JsonObject }
  | {
      type: "tool_finished";
      id: string;
      name: string;
      isError: boolean;
      output: string;
    }
  | { type: "run_ended"; outcome: "completed" | "failed" | "aborted" };

export type AdapterReport =
  | { kind: "skipped"; detail: string }
  | { kind: "adapter_error"; address?: string; error: unknown };

export type ChannelReport =
  | {
      kind: "admitted";
      channel: string;
      address: string;
      conversationId: ConversationId;
      submissionId: SubmissionId;
      duplicate: boolean;
    }
  | { kind: "ignored"; channel: string; address: string }
  | {
      kind: "send_retry";
      channel: string;
      address: string;
      attempt: number;
      error: unknown;
    }
  | { kind: "send_failed"; channel: string; address: string; error: unknown }
  | (AdapterReport & { channel: string });

export type AdapterStart = {
  deliver: Deliver;
  cancel(address: string): Promise<void>;
  report(report: AdapterReport): void;
  signal: AbortSignal;
};

export type ChannelAdapter = {
  start?(ctx: AdapterStart): void | Promise<void>;
  stop?(): Promise<void>;
  fetch?(request: Request): Promise<Response>;
  formats?: readonly string[];
  send(
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<SendResult | undefined | void>;
  events?(target: ReplyTarget, event: ChannelEvent): void | Promise<void>;
  fetchFile?(url: string): Promise<Uint8Array>;
};

export type AddressKey = { channel: string; address: string };

export type ConversationSetup = {
  agent?: AgentChange;
  init?: ConversationInit;
};

export type ChannelRegistration = {
  adapter: ChannelAdapter;
  conversation?(
    message: InboundMessage,
    source: { channel: string },
  ): ConversationSetup | undefined;
};

export type SendRetry = { attempts: number; baseDelayMs: number };

export type ChannelsOptions = {
  channels: Readonly<Record<string, ChannelRegistration>>;
  whenBusy?: BusyPolicy;
  retry?: SendRetry;
  onReport?(report: ChannelReport): void;
};

export type DeliveryStatus =
  | { state: "queued" | "running" | "sending" | "done" | "aborted" }
  | { state: "failed"; error: string }
  | { state: "blocked"; reason: string };
