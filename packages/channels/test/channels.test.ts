import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import type { Deliver } from "../src";
import {
  accepted,
  context,
  conversationOf,
  createWeb,
  entriesOf,
  eventually,
  type Gate,
  gate,
  holdTool,
  inbound,
  killable,
  MODEL,
  setup,
  sqliteStorage,
  stateOf,
  testAdapter,
  textOf,
} from "./support";

describe("delivery", () => {
  it("creates a conversation for a new address with the host's config and replies to it", async () => {
    const work = holdTool({});
    const test = setup({
      extensions: [work],
      conversation: (message) => ({
        agent: {
          model: MODEL,
          extensions: [work],
          instructions: `web/${message.address}`,
        },
      }),
    });
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const message = inbound("hello", "evt-1", {
      replyContext: { url: "r1" },
      addressData: { team: "t1" },
    });
    const receipt = await deliver(message);

    await harness.waitForIdle(context);
    const conversation = await conversationOf(harness, receipt.conversationId);
    const agent = await conversation.agent(context);
    expect(agent.instructions).toBe("web/thread-1");
    expect(agent.extensions.map((extension) => extension.name)).toEqual([
      "test-work",
      "channels",
    ]);
    const entries = await entriesOf(conversation);
    const input = entries.find((entry) => entry.kind === "channel.message");
    expect(input?.data).toEqual({
      author: "ana",
      channel: "web",
      address: "thread-1",
      addressData: { team: "t1" },
      replyContext: { url: "r1" },
    });
    expect(test.adapter.sent).toEqual([
      {
        message: {
          address: "thread-1",
          parts: [{ type: "text", text: "echo hello" }],
        },
        ctx: {
          addressData: { team: "t1" },
          replyContext: { url: "r1" },
          idempotencyKey: `reply:${input?.id}`,
        },
      },
    ]);
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });

  it("continues the same conversation for the same address and keeps address data", async () => {
    const test = setup();
    const { harness, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(
      inbound("one", "evt-1", { addressData: { team: "t1" } }),
    );
    await harness.waitForIdle(context);
    const second = await deliver(
      inbound("two", "evt-2", { replyContext: { url: "r2" } }),
    );
    await harness.waitForIdle(context);
    const other = await deliver(
      inbound("three", "evt-3", { address: "thread-2" }),
    );
    await harness.waitForIdle(context);

    expect(second.conversationId).toBe(first.conversationId);
    expect(other.conversationId).not.toBe(first.conversationId);
    expect(
      test.adapter.sent.map(({ message, ctx }) => [
        message.address,
        message.parts[0]?.text,
        ctx.addressData,
      ]),
    ).toEqual([
      ["thread-1", "echo one", { team: "t1" }],
      ["thread-1", "echo two", { team: "t1" }],
      ["thread-2", "echo three", undefined],
    ]);
    expect(test.adapter.sent[1]?.ctx.replyContext).toEqual({ url: "r2" });
    await harness.close(context);
  });

  it("keeps addresses and request IDs with separators distinct", async () => {
    const test = setup();
    const { harness, deliver } = await test.open(new MemoryStorage());
    const a = await deliver(inbound("a", "x/y", { address: "a/b" }));
    const b = await deliver(inbound("b", "x/y", { address: "a" }));
    const c = await deliver(inbound("c", "x", { address: "a/b" }));
    await harness.waitForIdle(context);
    expect(new Set([a.conversationId, b.conversationId]).size).toBe(2);
    expect(c.conversationId).toBe(a.conversationId);
    expect(c.submissionId).not.toBe(a.submissionId);
    expect(test.adapter.sent).toHaveLength(3);
    await harness.close(context);
  });

  it("returns the original receipt for a repeated request ID, without another run or reply", async () => {
    const test = setup();
    const { harness, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("hello", "evt-1"));
    const inFlight = await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    const after = await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(inFlight).toEqual(first);
    expect(after).toEqual(first);
    expect(test.adapter.sent).toHaveLength(1);
    await harness.close(context);
  });

  it("keeps address data when a repeated request ID carries other data", async () => {
    const test = setup();
    const { harness, deliver } = await test.open(new MemoryStorage());
    const first = inbound("one", "evt-1", { addressData: { url: "a" } });
    await deliver(first);
    await harness.waitForIdle(context);
    const retry = inbound("one", "evt-1", { addressData: { url: "b" } });
    await deliver(retry);
    await deliver(inbound("two", "evt-2"));
    await harness.waitForIdle(context);
    expect(test.adapter.sent.map(({ ctx }) => ctx.addressData)).toEqual([
      { url: "a" },
      { url: "a" },
    ]);
    await harness.close(context);
  });

  it("binds one conversation per address across hubs of one harness", async () => {
    const test = setup();
    const { harness, deliver } = await test.open(new MemoryStorage());
    const other = test.channels.hub(harness);
    const [a, b] = await Promise.all([
      deliver(inbound("one", "evt-1")),
      accepted(other.deliver("web", inbound("two", "evt-2"))),
    ]);
    await harness.waitForIdle(context);
    expect(b.conversationId).toBe(a.conversationId);
    await harness.close(context);
  });

  it("rejects a delivery for an unknown channel", async () => {
    const test = setup();
    const { harness, hub } = await test.open(new MemoryStorage());
    await expect(hub.deliver("slack", inbound("hi", "evt-1"))).rejects.toThrow(
      "No channel slack",
    );
    const root = await harness.root(context, { agent: { model: MODEL } });
    await expect(
      hub.bind({ channel: "slack", address: "x" }, root.id),
    ).rejects.toThrow("No channel slack");
    await harness.close(context);
  });
});

describe("busy conversations", () => {
  async function busySetup(whenBusy?: "queue" | "steer") {
    const held: { gate?: ReturnType<typeof gate> } = { gate: gate() };
    const work = holdTool(held);
    const test = setup({
      extensions: [work],
      ...(whenBusy === undefined ? {} : { whenBusy }),
      respond: (text, last) =>
        last?.role === "user" && text === "start"
          ? fauxAssistantMessage(fauxToolCall("work", {}), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage(`answer to ${text}`),
    });
    const opened = await test.open(new MemoryStorage());
    const first = await opened.deliver(inbound("start", "evt-1"));
    await eventually(async () => {
      const state = await stateOf(opened.hub, first.submissionId);
      return state === "running";
    });
    return { ...opened, test, held, first };
  }

  it("queues a message by default: it gets its own run and reply", async () => {
    const { harness, hub, deliver, test, held } = await busySetup();
    const second = await deliver(inbound("later", "evt-2"));
    await expect(hub.status(second.submissionId)).resolves.toEqual({
      state: "queued",
    });
    held.gate?.open();
    await harness.waitForIdle(context);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["answer to worked", "answer to later"]);
    await harness.close(context);
  });

  it("steers the current run when the delivery asks for it", async () => {
    const { harness, deliver, test, held } = await busySetup();
    await deliver(inbound("also this", "evt-2"), {
      whenBusy: "steer",
    });
    held.gate?.open();
    await harness.waitForIdle(context);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["answer to also this", "answer to also this"]);
    await harness.close(context);
  });

  it("uses the createChannels default", async () => {
    const { harness, deliver, test, held } = await busySetup("steer");
    await deliver(inbound("also this", "evt-2"));
    held.gate?.open();
    await harness.waitForIdle(context);
    expect(test.adapter.sent).toHaveLength(2);
    expect(
      new Set(test.adapter.sent.map(({ message }) => message.parts[0]?.text)),
    ).toEqual(new Set(["answer to also this"]));
    await harness.close(context);
  });
});

describe("send failures and recovery", () => {
  it("retries a failed send with the same idempotency key", async () => {
    const test = setup();
    test.adapter.failures = 2;
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const receipt = await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(test.adapter.sent).toHaveLength(3);
    expect(
      new Set(test.adapter.sent.map(({ ctx }) => ctx.idempotencyKey)).size,
    ).toBe(1);
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });

  it("fails the delivery after the last attempt and reports the error", async () => {
    const test = setup();
    test.adapter.failures = 10;
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const receipt = await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(test.adapter.sent).toHaveLength(3);
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "failed",
      error: "platform unavailable",
    });
    expect(test.reports.map((report) => report.kind)).toContain("task_error");
    await harness.close(context);
  });

  it("sends again with the same key after a crash cut off an accepted send", async () => {
    const storage = await sqliteStorage();
    const test = setup();
    test.adapter.hold = true;
    const inner = await storage();
    const crashing = killable(inner);
    const first = await test.open(crashing.storage);
    const receipt = await first.deliver(inbound("hello", "evt-1"));
    await eventually(() => test.adapter.sent.length === 1);
    await expect(first.hub.status(receipt.submissionId)).resolves.toEqual({
      state: "sending",
    });
    crashing.kill();

    test.adapter.hold = false;
    const reopened = await storage();
    const second = await test.open(reopened);
    second.harness.resume();
    await second.harness.waitForIdle(context);
    const keys = test.adapter.sent.map(({ ctx }) => ctx.idempotencyKey);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    await expect(second.hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    await second.harness.close(context);
  });

  it("answers and replies once after a crash in the middle of a run", async () => {
    const storage = await sqliteStorage();
    const model = gate();
    const started = gate();
    const test = setup({
      respond: async (text) => {
        started.open();
        await model.promise;
        return fauxAssistantMessage(`echo ${text}`);
      },
    });
    const inner = await storage();
    const crashing = killable(inner);
    const first = await test.open(crashing.storage);
    const receipt = await first.deliver(inbound("hello", "evt-1"));
    await started.promise;
    crashing.kill();
    expect(test.adapter.sent).toEqual([]);

    model.open();
    const reopened = await storage();
    const second = await test.open(reopened);
    second.harness.resume();
    await second.harness.waitForIdle(context);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["echo hello"]);
    await expect(second.hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    await second.harness.close(context);
  });

  it("replies once after a crash while the answer's hooks run, before the reply task exists", async () => {
    const storage = await sqliteStorage();
    const asked = { count: 0, gate: gate() as Gate | undefined };
    const slowHook = defineExtension({
      name: "test-slow-hook",
      hooks: [
        hook(GenerationTask, {
          afterRun: async () => {
            asked.count++;
            await asked.gate?.promise;
            return undefined;
          },
        }),
      ],
    });
    const test = setup({ extensions: [slowHook] });
    const inner = await storage();
    const crashing = killable(inner);
    const first = await test.open(crashing.storage);
    const receipt = await first.deliver(inbound("hello", "evt-1"));
    await eventually(() => asked.count === 1);
    await expect(first.hub.status(receipt.submissionId)).resolves.toEqual({
      state: "sending",
    });
    crashing.kill();
    expect(test.adapter.sent).toEqual([]);

    asked.gate = undefined;
    const reopened = await storage();
    const second = await test.open(reopened);
    second.harness.resume();
    await second.harness.waitForIdle(context);
    expect(asked.count).toBe(2);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["echo hello"]);
    await expect(second.hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    await second.harness.close(context);
  });

  it("reports a reply as blocked when a restart lacks the send task's definition", async () => {
    const storage = await sqliteStorage();
    const test = setup({ retry: { attempts: 3, baseDelayMs: 50 } });
    test.adapter.failures = 1;
    const opened = await storage();
    const first = await test.open(opened);
    const receipt = await first.deliver(inbound("hello", "evt-1"));
    await eventually(() => test.adapter.sent.length === 1);
    await first.harness.close(context);

    const reopened = await storage();
    const harness = await Harness.open(
      reopened,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    const hub = test.channels.hub(harness);
    harness.resume();
    await eventually(async () => {
      const state = await stateOf(hub, receipt.submissionId);
      return state === "blocked";
    });
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "blocked",
      reason: "missing_task",
    });
    await harness.close(context);
  });
});

describe("binding", () => {
  it("routes a bound address to an existing conversation and refuses to move it", async () => {
    const test = setup();
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const root = await harness.root(context, { agent: { model: MODEL } });
    await hub.bind({ channel: "web", address: "pr-42" }, root.id);
    await hub.bind({ channel: "web", address: "pr-42" }, root.id);
    const receipt = await deliver(
      inbound("CI failed", "ci-1", { address: "pr-42" }),
    );
    await harness.waitForIdle(context);
    expect(receipt.conversationId).toBe(root.id);
    expect(
      test.adapter.sent.map(({ message }) => [
        message.address,
        message.parts[0]?.text,
      ]),
    ).toEqual([["pr-42", "echo CI failed"]]);
    const other = await deliver(inbound("hi", "evt-1"));
    await expect(
      hub.bind({ channel: "web", address: "pr-42" }, other.conversationId),
    ).rejects.toThrow("belongs to another conversation");
    await harness.close(context);
  });

  it("binds from a tool in the tool's own commit", async () => {
    const test = setup({
      extend: (channels) => [
        defineExtension({
          name: "test-pr",
          tools: [
            defineTool({
              name: "open_pr",
              description: "Open a pull request",
              parameters: obj({}),
              execute: async (_args, api, ctx) => {
                await api.commit(
                  (tx) =>
                    channels.bind(
                      tx,
                      { channel: "web", address: "pr-7" },
                      api.conversationId,
                    ),
                  ctx,
                );
                return { output: [{ type: "text", text: "opened pr-7" }] };
              },
            }),
          ],
        }),
      ],
      respond: (text, last) =>
        last?.role === "user" && text === "open"
          ? fauxAssistantMessage(fauxToolCall("open_pr", {}), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage(`echo ${text}`),
    });
    const { harness, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("open", "evt-1"));
    await harness.waitForIdle(context);
    const review = await deliver(
      inbound("please rename x", "review-1", { address: "pr-7" }),
    );
    await harness.waitForIdle(context);
    expect(review.conversationId).toBe(first.conversationId);
    expect(
      test.adapter.sent.map(({ message }) => [
        message.address,
        message.parts[0]?.text,
      ]),
    ).toEqual([
      ["thread-1", "echo opened pr-7"],
      ["pr-7", "echo please rename x"],
    ]);
    await harness.close(context);
  });

  it("ignores unbound addresses without a conversation factory, or when it declines", async () => {
    const quiet = testAdapter();
    const picky = testAdapter();
    const test = setup({
      channels: {
        quiet: { adapter: quiet },
        picky: {
          adapter: picky,
          conversation: (message) =>
            message.address.startsWith("case:") ? createWeb() : undefined,
        },
      },
    });
    const { harness, hub } = await test.open(new MemoryStorage());
    await expect(
      hub.deliver("quiet", inbound("hi", "evt-1")),
    ).resolves.toBeUndefined();
    await expect(
      hub.deliver("picky", inbound("hi", "evt-2")),
    ).resolves.toBeUndefined();
    const accepted = await hub.deliver(
      "picky",
      inbound("hi", "evt-3", { address: "case:1" }),
    );
    await harness.waitForIdle(context);
    expect(accepted).toBeDefined();
    expect(quiet.sent).toEqual([]);
    expect(picky.sent.map(({ message }) => message.address)).toEqual([
      "case:1",
    ]);
    await harness.close(context);
  });

  it("records the address data and alias a send returns, for later replies and deliveries", async () => {
    const test = setup();
    test.adapter.result = ({ ctx }) =>
      ctx.addressData === undefined
        ? { addressData: { thread: "t9" }, alias: "t9" }
        : undefined;
    const { harness, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("one", "evt-1", { address: "case:1" }));
    await harness.waitForIdle(context);
    const second = await deliver(
      inbound("two", "evt-2", { address: "case:1" }),
    );
    const third = await deliver(inbound("three", "evt-3", { address: "t9" }));
    await harness.waitForIdle(context);
    expect(
      new Set([first, second, third].map((r) => r.conversationId)).size,
    ).toBe(1);
    expect(
      test.adapter.sent.map(({ message, ctx }) => [
        message.address,
        ctx.addressData,
      ]),
    ).toEqual([
      ["case:1", undefined],
      ["case:1", { thread: "t9" }],
      ["t9", { thread: "t9" }],
    ]);
    await harness.close(context);
  });
});

describe("adapters", () => {
  it("start hands each adapter a deliver bound to its channel", async () => {
    const adapter = testAdapter();
    const started: { deliver?: Deliver; signal?: AbortSignal } = {};
    adapter.start = (ctx) => {
      Object.assign(started, ctx);
    };
    const test = setup({
      channels: { web: { adapter, conversation: createWeb } },
    });
    const { harness, hub } = await test.open(new MemoryStorage());
    const controller = new AbortController();
    await hub.start(controller.signal);
    expect(started.signal).toBe(controller.signal);
    const receipt = await started.deliver?.(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(receipt?.conversationId).toBeDefined();
    expect(adapter.sent.map(({ message }) => message.parts[0]?.text)).toEqual([
      "echo hello",
    ]);
    await harness.close(context);
  });

  it("never creates a conversation for a stored message", async () => {
    const test = setup();
    const { harness, hub } = await test.open(new MemoryStorage());
    await expect(
      hub.deliver("web", inbound("chatter", "evt-1"), { run: false }),
    ).resolves.toBeUndefined();
    await harness.close(context);
  });

  it("stores a message without a run, and the next run sees it", async () => {
    const test = setup();
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("hi", "evt-0"));
    await harness.waitForIdle(context);
    test.adapter.sent.length = 0;
    const note = await deliver(
      inbound("the customer is on vacation", "evt-1"),
      {
        run: false,
      },
    );
    await harness.waitForIdle(context);
    await expect(hub.status(note.submissionId)).resolves.toEqual({
      state: "done",
    });
    expect(test.adapter.sent).toEqual([]);
    await deliver(inbound("what do we know?", "evt-2"));
    await harness.waitForIdle(context);
    const conversation = await conversationOf(harness, note.conversationId);
    const view = await conversation.context(context);
    expect(
      view.messages
        .filter((message) => message.role === "user")
        .map((message) => textOf({ model: [message] })),
    ).toEqual(["hi", "the customer is on vacation", "what do we know?"]);
    expect(note.conversationId).toBe(first.conversationId);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["echo what do we know?"]);
    await harness.close(context);
  });
});

describe("lifecycle", () => {
  async function busy() {
    const held: { gate?: ReturnType<typeof gate> } = { gate: gate() };
    const work = holdTool(held);
    const test = setup({
      extensions: [work],
      respond: (text, last) =>
        last?.role === "user" && text.startsWith("start")
          ? fauxAssistantMessage(fauxToolCall("work", {}), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage(`answer to ${text}`),
    });
    const opened = await test.open(new MemoryStorage());
    const first = await opened.deliver(inbound("start", "evt-1"));
    await eventually(async () => {
      const state = await stateOf(opened.hub, first.submissionId);
      return state === "running";
    });
    const queued = await opened.deliver(inbound("queued", "evt-2"));
    return { ...opened, test, held, first, queued };
  }

  const key = { channel: "web", address: "thread-1" };

  it("cancel stops the run and withdraws queued messages, leaving the binding", async () => {
    const { harness, hub, test, deliver, first, queued, held } = await busy();
    await hub.cancel(key);
    held.gate?.open();
    await harness.waitForIdle(context);
    await expect(hub.status(first.submissionId)).resolves.toEqual({
      state: "aborted",
    });
    await expect(hub.status(queued.submissionId)).resolves.toEqual({
      state: "aborted",
    });
    expect(test.adapter.sent).toEqual([]);
    const next = await deliver(inbound("again", "evt-3"));
    await harness.waitForIdle(context);
    expect(next.conversationId).toBe(first.conversationId);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["answer to again"]);
    await harness.close(context);
  });

  it("cancel aborts a reply that is still being sent", async () => {
    const test = setup();
    test.adapter.hold = true;
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const receipt = await deliver(inbound("hello", "evt-1"));
    await eventually(() => test.adapter.sent.length === 1);
    await hub.cancel(key);
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "aborted",
    });
    await harness.close(context);
  });

  it("clear starts a fresh context in the same conversation", async () => {
    const test = setup();
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("one", "evt-1"));
    await harness.waitForIdle(context);
    await hub.clear(key);
    const second = await deliver(inbound("two", "evt-2"));
    await harness.waitForIdle(context);
    expect(second.conversationId).toBe(first.conversationId);
    const conversation = await conversationOf(harness, first.conversationId);
    const view = await conversation.context(context);
    expect(
      view.messages
        .filter((message) => message.role === "user")
        .map((message) => textOf({ model: [message] })),
    ).toEqual(["two"]);
    await harness.close(context);
  });

  it("compact summarizes the conversation", async () => {
    const test = setup({
      settings: { compaction: { keepRecentTokens: 1 } },
      respond: (text) =>
        fauxAssistantMessage(
          text.includes("summar") ? "summary" : `echo ${text}`,
        ),
    });
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("one", "evt-1"));
    await harness.waitForIdle(context);
    await hub.compact(key);
    await harness.waitForIdle(context);
    const conversation = await conversationOf(harness, first.conversationId);
    const entries = await entriesOf(conversation);
    expect(entries.map((entry) => entry.kind)).toContain("pi.compaction");
    await harness.close(context);
  });

  it("end cancels outstanding work and unmaps every address; the next message starts fresh", async () => {
    const { harness, hub, test, deliver, first, held } = await busy();
    await hub.bind(
      { channel: "web", address: "alias-1" },
      first.conversationId,
    );
    await hub.end(key);
    held.gate?.open();
    await harness.waitForIdle(context);
    expect(test.adapter.sent).toEqual([]);
    const next = await deliver(inbound("again", "evt-3"));
    await harness.waitForIdle(context);
    expect(next.conversationId).not.toBe(first.conversationId);
    const aliased = await deliver(
      inbound("hi", "evt-5", { address: "alias-1" }),
    );
    expect(aliased.conversationId).not.toBe(first.conversationId);
    expect(aliased.conversationId).not.toBe(next.conversationId);
    await harness.waitForIdle(context);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["answer to again", "answer to hi"]);
    await harness.close(context);
  });

  it("end racing a delivery leaves no reply from the old binding", async () => {
    const { harness, hub, test, deliver, first, held } = await busy();
    const ending = hub.end(key);
    const late = deliver(inbound("late", "evt-4"));
    held.gate?.open();
    await ending;
    const receipt = await late;
    await harness.waitForIdle(context);
    expect(receipt.conversationId).not.toBe(first.conversationId);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["answer to late"]);
    await harness.close(context);
  });

  it("ignores an address without a binding", async () => {
    const test = setup();
    const { harness, hub } = await test.open(new MemoryStorage());
    await hub.end(key);
    await hub.cancel(key);
    await harness.close(context);
  });
});
