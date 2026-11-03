import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  EntryId,
  LiveRun,
  LiveState,
} from "@earendil-works/pi-durable";
import { ChannelMessage } from "./doc";
import { replyKey, runEntries } from "./hook";
import type { AdapterLookup } from "./send";
import type { ChannelAdapter, ReplyProgress, ReplyTarget } from "./types";

const context = BACKGROUND_CONTEXT;

type Recipient = { adapter: ChannelAdapter; target: ReplyTarget };

type Run = {
  first: EntryId;
  inputs: string;
  recipients: Recipient[];
  text: string;
};

async function notify(
  recipients: readonly Recipient[],
  update: ReplyProgress,
): Promise<void> {
  for (const { adapter, target } of recipients) {
    await Promise.resolve()
      .then(() => adapter.progress?.(target, update))
      .catch(() => undefined);
  }
}

function partialText(live: LiveState): string {
  const content = live.generation?.message?.content ?? [];
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
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
    const { channel: _channel, author: _author, ...target } = data;
    return [{ adapter, target: { ...target, idempotencyKey: replyKey(id) } }];
  });
}

export function runTracker(
  conversation: Conversation,
  adapterFor: AdapterLookup,
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
    await notify(added, { type: "working" });
  }

  async function stream(current: Run, live: LiveState): Promise<void> {
    const text = partialText(live);
    if (text === "" || text === current.text) return;
    current.text = text;
    await notify(current.recipients, { type: "text", text });
  }

  async function end(live: LiveState): Promise<void> {
    if (run === undefined) return;
    const stopped = stoppedOf(live, run);
    const { recipients } = run;
    run = undefined;
    if (stopped !== undefined) await notify(recipients, stopped);
  }

  return async (live: LiveState): Promise<void> => {
    const first = live.run?.first;
    if (run !== undefined && run.first !== first) await end(live);
    if (live.run === undefined || first === undefined) return;
    run ??= { first, inputs: "", recipients: [], text: "" };
    await admit(run, live.run);
    await stream(run, live);
  };
}
