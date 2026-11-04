import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  EntryId,
  LiveRun,
  LiveState,
} from "@earendil-works/pi-durable";
import { ChannelMessage } from "./doc";
import { replyKey, runEntries } from "./hook";
import type { Reporter } from "./report";
import type { AdapterLookup } from "./send";
import { stepsOf } from "./steps";
import type { ChannelAdapter, ReplyProgress, ReplyTarget } from "./types";

const context = BACKGROUND_CONTEXT;

type Recipient = {
  channel: string;
  adapter: ChannelAdapter;
  target: ReplyTarget;
};

type Run = {
  first: EntryId;
  inputs: string;
  recipients: Recipient[];
  titles: Map<string, string>;
  cursor?: EntryId;
};

async function notify(
  recipients: readonly Recipient[],
  update: ReplyProgress,
  report: Reporter,
): Promise<void> {
  for (const { channel, adapter, target } of recipients) {
    await Promise.resolve()
      .then(() => adapter.progress?.(target, update))
      .catch((error: unknown) =>
        report({
          kind: "adapter_error",
          channel,
          address: target.address,
          error,
        }),
      );
  }
}

function stoppedOf(live: LiveState, run: Run): ReplyProgress | undefined {
  const failure = live.runFailure;
  if (failure?.first !== run.first) return undefined;
  const aborted = failure.reason === "aborted" || failure.reason === "reset";
  return { type: "stopped", reason: aborted ? "aborted" : "failed" };
}

async function recipientsOf(
  conversation: Conversation,
  first: EntryId,
  adapterFor: AdapterLookup,
): Promise<Recipient[]> {
  const entries = await runEntries(conversation, { first }, context);
  return entries.filter(ChannelMessage.is).flatMap(({ id, data }) => {
    const adapter = adapterFor(data.channel);
    if (adapter?.progress === undefined) return [];
    const { channel, author: _author, ...target } = data;
    const idempotencyKey = replyKey(id);
    return [{ channel, adapter, target: { ...target, idempotencyKey } }];
  });
}

export function runTracker(
  conversation: Conversation,
  adapterFor: AdapterLookup,
  report: Reporter,
) {
  let run: Run | undefined;

  async function admit(current: Run, live: LiveRun): Promise<void> {
    const inputs = live.inputs.join(",");
    if (inputs === "" || inputs === current.inputs) return;
    current.inputs = inputs;
    const known = new Set(
      current.recipients.map(({ target }) => target.idempotencyKey),
    );
    current.recipients = await recipientsOf(
      conversation,
      current.first,
      adapterFor,
    );
    const added = current.recipients.filter(
      ({ target }) => !known.has(target.idempotencyKey),
    );
    await notify(added, { type: "working" }, report);
  }

  async function freshEntries(current: Run) {
    const previous = current.cursor;
    const first = previous ?? current.first;
    const entries = await runEntries(conversation, { first }, context);
    current.cursor = entries.at(-1)?.id ?? previous;
    if (previous === undefined) return entries;
    return entries.filter(({ id }) => id > previous);
  }

  async function steps(current: Run): Promise<void> {
    const entries = await freshEntries(current);
    for (const step of stepsOf(entries, current.titles))
      await notify(current.recipients, { type: "step", step }, report);
  }

  async function end(live: LiveState): Promise<void> {
    if (run === undefined) return;
    const stopped = stoppedOf(live, run);
    const ended = run;
    run = undefined;
    await steps(ended);
    const { recipients } = ended;
    if (stopped !== undefined) await notify(recipients, stopped, report);
  }

  return async (live: LiveState): Promise<void> => {
    const first = live.run?.first;
    if (run !== undefined && run.first !== first) await end(live);
    if (live.run === undefined || first === undefined) return;
    run ??= {
      first,
      inputs: "",
      recipients: [],
      titles: new Map(),
    };
    await admit(run, live.run);
    await steps(run);
  };
}
