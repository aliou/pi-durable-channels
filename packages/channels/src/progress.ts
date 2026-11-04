import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  GenerationTask,
  type Harness,
  LiveDoc,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import type { Reporter } from "./report";
import { runTracker } from "./run-tracker";
import type { AdapterLookup } from "./send";

const context = BACKGROUND_CONTEXT;

type Follower = {
  closed: Promise<void>;
  stop(): void;
  close(): void;
  keep(): void;
};

async function follow(
  harness: Harness,
  id: ConversationId,
  adapterFor: AdapterLookup,
  report: Reporter,
): Promise<Follower | undefined> {
  const conversation = await harness.conversation(id, context);
  const watch = await harness.watchDoc(LiveDoc, id, context);
  if (conversation === undefined || watch === undefined) return undefined;
  const track = runTracker(conversation, adapterFor, report);
  let closing = false;
  let idle = false;
  const stopWhenIdle = () => closing && idle && void watch.stop();
  watch.start(async (call) => {
    if (call.kind !== "value") return;
    const live = call.value;
    await track(live);
    idle = live.run === undefined;
    stopWhenIdle();
  });
  return {
    closed: watch.closed.then(() => undefined),
    stop: () => void watch.stop(),
    close: () => {
      closing = true;
      stopWhenIdle();
    },
    keep: () => {
      closing = false;
    },
  };
}

function generating(graph: TaskGraph): Set<ConversationId> {
  return new Set(
    Object.values(graph.tasks)
      .filter((node) => node.kind === GenerationTask.definition.name)
      .map((node) => node.conversationId),
  );
}

export async function watchProgress(
  harness: Harness,
  adapterFor: AdapterLookup,
  report: Reporter,
  signal: AbortSignal,
): Promise<void> {
  const followers = new Map<ConversationId, Promise<Follower | undefined>>();
  const graph = await harness.watchTaskGraph(context);

  function start(id: ConversationId): void {
    const follower = follow(harness, id, adapterFor, report);
    followers.set(id, follower);
    void follower.then(async (found) => {
      if (found === undefined) return followers.delete(id);
      if (signal.aborted) found.stop();
      await found.closed;
      followers.delete(id);
      if (!signal.aborted && generating(graph.value).has(id)) start(id);
    });
  }

  function update(active: Set<ConversationId>): void {
    for (const id of active) {
      const existing = followers.get(id);
      if (existing === undefined) start(id);
      else void existing.then((follower) => follower?.keep());
    }
    for (const [id, follower] of followers)
      if (!active.has(id)) void follower.then((found) => found?.close());
  }

  graph.start(async (call) => {
    if (call.kind === "value" && !signal.aborted)
      update(generating(call.value));
  });
  signal.addEventListener(
    "abort",
    () => {
      void graph.stop();
      for (const follower of followers.values())
        void follower.then((found) => found?.stop());
    },
    { once: true },
  );
}
