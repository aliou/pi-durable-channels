import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { ChannelsDoc, findBinding, setBinding } from "./doc";
import type { Reporter } from "./report";
import type {
  ChannelAdapter,
  OutboundPart,
  SendResult,
  SendRetry,
} from "./types";

export type SendInput = {
  channel: string;
  address: string;
  parts: OutboundPart[];
  idempotencyKey: string;
  addressData?: JsonValue;
  replyContext?: JsonValue;
};

type SendState = { phase: "send"; attempt: number };

type Attempt = { result: SendResult | undefined } | { error: Error };

export type AdapterLookup = (channel: string) => ChannelAdapter | undefined;

export const SEND_TASK = "channels.send";

async function attemptSend(
  adapterFor: AdapterLookup,
  input: SendInput,
  addressData: JsonValue | undefined,
  signal: AbortSignal,
): Promise<Attempt> {
  try {
    const adapter = adapterFor(input.channel);
    if (adapter === undefined) throw new Error(`No channel ${input.channel}`);
    const { address, parts, replyContext, idempotencyKey } = input;
    const result = await adapter.send(
      { address, parts },
      { addressData, replyContext, idempotencyKey, signal },
    );
    return { result: result || undefined };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function recordResult(
  tx: Tx,
  conversationId: ConversationId,
  input: SendInput,
  result: SendResult | undefined,
): Promise<void> {
  if (result === undefined) return;
  const state = await tx.doc(ChannelsDoc);
  const current = findBinding(state, input);
  if (current?.conversationId !== conversationId) return;
  const addressData = result.addressData ?? current.addressData;
  const binding = () => ({
    conversationId,
    ...(addressData === undefined
      ? {}
      : { addressData: copyJson(addressData) }),
  });
  setBinding(state, input, binding());
  if (result.alias === undefined) return;
  const alias = { channel: input.channel, address: result.alias };
  if (findBinding(state, alias) === undefined)
    setBinding(state, alias, binding());
}

export function defineSendTask(
  adapterFor: AdapterLookup,
  retry: SendRetry,
  report: Reporter,
) {
  return defineTask<SendInput, SendState, null>({
    name: SEND_TASK,
    version: 1,
    initial: () => ({ phase: "send", attempt: 1 }),
    phases: {
      send: async (task, runtime, context) => {
        const { attempt } = task.state.checkpoint;
        const state = await runtime.snapshot(ChannelsDoc, context);
        const binding = findBinding(state, task.input);
        const addressData =
          binding?.conversationId === runtime.conversationId
            ? binding.addressData
            : task.input.addressData;
        const outcome = await attemptSend(
          adapterFor,
          task.input,
          addressData,
          runtime.signal,
        );
        if ("result" in outcome) {
          await runtime.commit(async (tx) => {
            await recordResult(
              tx,
              runtime.conversationId,
              task.input,
              outcome.result,
            );
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            };
          }, context);
          return;
        }
        const { channel, address } = task.input;
        const { error } = outcome;
        if (attempt < retry.attempts) {
          report({ kind: "send_retry", channel, address, attempt, error });
          const until = runtime.now() + retry.baseDelayMs * 2 ** (attempt - 1);
          await runtime.sleepUntil(
            until,
            { phase: "send", attempt: attempt + 1 },
            context,
          );
          return;
        }
        report({ kind: "send_failed", channel, address, error });
        const failure = { message: error.message };
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "failed", error: failure },
          }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
}

export type SendTask = ReturnType<typeof defineSendTask>;
