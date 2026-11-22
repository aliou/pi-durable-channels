import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import type {
  AdapterStart,
  ChannelAdapter,
  ChannelEvent,
  ChannelHistoryRequest,
  OutboundPart,
  ReplyTarget,
} from "../src";
import { ChannelsDoc, findBinding } from "../src";
import { defineSendTask } from "../src/send";
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
  type Responder,
  type SetupOptions,
  setup,
  sqliteStorage,
  stateOf,
  tempDir,
  testAdapter,
  textOf,
} from "./support";

const representedParts = [
  {
    type: "text",
    text: "Deployment completed.",
    representations: {
      "test.blocks": {
        blocks: [
          {
            type: "section",
            text: { type: "markdown", text: "*Deployment completed.*" },
          },
        ],
      },
      "test.metadata": { service: "api", attempts: [1, 2] },
    },
  },
] satisfies OutboundPart[];

async function openSendHarness(storage: Storage, adapter: ChannelAdapter) {
  const Send = defineSendTask(
    () => adapter,
    { attempts: 3, baseDelayMs: 1 },
    () => {},
  );
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-send", tasks: [Send] }));
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry },
    context,
  );
  const createSend = () =>
    harness.commit(async (tx) => {
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await tx.createTask(
        Send,
        {
          channel: "web",
          address: "thread-1",
          parts: representedParts,
          idempotencyKey: "reply:represented",
        },
        {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
        },
      );
    }, context);
  return { createSend, harness };
}

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

  it("initializes documents with the configured agent in the creating commit", async () => {
    const InitDoc = defineDoc<{ agent: string | null }>({
      kind: "test.channel-init",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "current",
      initial: () => ({ agent: null }),
      checkpointWhen: () => false,
    });
    const test = setup({
      conversation: () => ({
        agent: { model: MODEL, instructions: "Configured during creation" },
        init: async (tx, conversationId) => {
          const agent = await tx.doc(AgentDoc, conversationId);
          const state = await tx.doc(InitDoc, conversationId);
          state.agent = agent.instructions ?? null;
        },
      }),
    });
    const { harness, deliver } = await test.open(new MemoryStorage());
    const receipt = await deliver(inbound("hello", "evt-1"));
    await expect(
      harness.snapshot(InitDoc, receipt.conversationId, context),
    ).resolves.toEqual({
      agent: "Configured during creation",
    });
    await harness.close(context);
  });

  it("rolls back conversation creation and binding when init fails", async () => {
    const test = setup({
      conversation: () => ({
        agent: { model: MODEL },
        init: () => {
          throw new Error("init failed");
        },
      }),
    });
    const { harness, hub } = await test.open(new MemoryStorage());
    await expect(
      hub.deliver("web", {
        ...inbound("hello", "evt-1", { cursor: "cursor-1" }),
        conversationAddress: "canonical",
      }),
    ).rejects.toThrow("init failed");
    await expect(
      hub.conversationOf({ channel: "web", address: "thread-1" }),
    ).resolves.toBeUndefined();
    await expect(
      hub.conversationOf({ channel: "web", address: "canonical" }),
    ).resolves.toBeUndefined();
    const conversations = await harness.commit(
      (tx) => tx.scanConversations({}, 10),
      context,
    );
    expect(conversations.items).toEqual([]);
    await harness.close(context);
  });

  it("runs neither the factory nor init for an existing binding", async () => {
    const calls = { factory: 0, init: 0 };
    const test = setup({
      conversation: () => {
        calls.factory++;
        return {
          agent: { model: MODEL },
          init: () => {
            calls.init++;
          },
        };
      },
    });
    const { harness, deliver } = await test.open(new MemoryStorage());
    await deliver(inbound("one", "evt-1"));
    await deliver(inbound("two", "evt-2"));
    expect(calls).toEqual({ factory: 1, init: 1 });
    await harness.close(context);
  });

  it("finishes asynchronous init before admitting the message", async () => {
    const entered = gate();
    const finish = gate();
    const test = setup({
      conversation: () => ({
        agent: { model: MODEL },
        init: async () => {
          entered.open();
          await finish.promise;
        },
      }),
    });
    const storage = new MemoryStorage();
    const { harness, hub } = await test.open(storage);
    let admitted = false;
    const delivery = accepted(
      hub.deliver("web", inbound("hello", "evt-1")),
    ).then((receipt) => {
      admitted = true;
      return receipt;
    });
    await entered.promise;
    expect(admitted).toBe(false);
    const pending = await storage.scanSubmissions({}, 10, undefined, context);
    expect(pending.items).toEqual([]);
    finish.open();
    const receipt = await delivery;
    const stored = await storage.scanSubmissions({}, 10, undefined, context);
    expect(stored.items.map(({ id }) => id)).toEqual([receipt.submissionId]);
    await expect(
      hub.conversationOf({ channel: "web", address: "thread-1" }),
    ).resolves.toBe(receipt.conversationId);
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
    const admitted = { kind: "admitted", channel: "web", address: "thread-1" };
    expect(
      test.channelReports.filter(({ kind }) => kind === "admitted"),
    ).toEqual([
      { ...admitted, ...first, duplicate: false },
      { ...admitted, ...first, duplicate: true },
      { ...admitted, ...first, duplicate: true },
    ]);
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

  it("tells a shared conversation factory which channel a message came from", async () => {
    const seen: string[] = [];
    const factory = (_message: unknown, { channel }: { channel: string }) => {
      seen.push(channel);
      return { agent: { model: MODEL, instructions: channel } };
    };
    const test = setup({
      channels: {
        web: { adapter: testAdapter(), conversation: factory },
        chat: { adapter: testAdapter(), conversation: factory },
      },
    });
    const { harness, deliver } = await test.open(new MemoryStorage());
    const web = await deliver(inbound("hi", "evt-1"), undefined, "web");
    const chat = await deliver(inbound("hi", "evt-2"), undefined, "chat");
    await harness.waitForIdle(context);
    expect(seen).toEqual(["web", "chat"]);
    const instructions = await Promise.all(
      [web, chat].map(async ({ conversationId }) => {
        const conversation = await conversationOf(harness, conversationId);
        const agent = await conversation.agent(context);
        return agent.instructions;
      }),
    );
    expect(instructions).toEqual(["web", "chat"]);
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

  it("joins an unbound alias to its conversation address without creating a conversation", async () => {
    const test = setup();
    const { harness, deliver } = await test.open(new MemoryStorage());
    const canonical = await deliver(
      inbound("canonical", "evt-1", {
        addressData: { source: "canonical" },
        cursor: "canonical-cursor",
      }),
    );
    const alias = await deliver(
      inbound("alias", "evt-2", {
        address: "alias-1",
        conversationAddress: "thread-1",
        addressData: { source: "alias" },
        cursor: "alias-cursor",
      }),
      { create: false },
    );
    await harness.waitForIdle(context);

    expect(alias.conversationId).toBe(canonical.conversationId);
    const state = await harness.snapshot(ChannelsDoc, context);
    expect(findBinding(state, { channel: "web", address: "thread-1" })).toEqual(
      {
        conversationId: canonical.conversationId,
        addressData: { source: "canonical" },
        cursor: "canonical-cursor",
      },
    );
    expect(findBinding(state, { channel: "web", address: "alias-1" })).toEqual({
      conversationId: canonical.conversationId,
      addressData: { source: "alias" },
      via: "thread-1",
      cursor: "alias-cursor",
    });
    expect(test.adapter.sent.map(({ message }) => message.address)).toEqual([
      "thread-1",
      "alias-1",
    ]);
    await harness.close(context);
  });

  it("creates one conversation for concurrent aliases of one new canonical address", async () => {
    let created = 0;
    const test = setup({
      conversation: () => {
        created++;
        return createWeb();
      },
    });
    const { harness, hub } = await test.open(new MemoryStorage());
    const delivery = (address: string, requestId: string) =>
      accepted(
        hub.deliver("web", {
          ...inbound(address, requestId, { address }),
          conversationAddress: "canonical",
          addressData: { address },
          cursor: `cursor-${address}`,
        }),
      );
    const [first, second] = await Promise.all([
      delivery("alias-1", "evt-1"),
      delivery("alias-2", "evt-2"),
    ]);
    await harness.waitForIdle(context);

    expect(second.conversationId).toBe(first.conversationId);
    expect(created).toBe(1);
    await expect(hub.addresses(first.conversationId)).resolves.toEqual([
      { channel: "web", address: "canonical" },
      { channel: "web", address: "alias-1" },
      { channel: "web", address: "alias-2" },
    ]);
    const state = await harness.snapshot(ChannelsDoc, context);
    expect(
      findBinding(state, { channel: "web", address: "canonical" }),
    ).toEqual({ conversationId: first.conversationId });
    expect(findBinding(state, { channel: "web", address: "alias-1" })).toEqual({
      conversationId: first.conversationId,
      via: "canonical",
      addressData: { address: "alias-1" },
      cursor: "cursor-alias-1",
    });
    const conversation = await conversationOf(harness, first.conversationId);
    const view = await conversation.context(context);
    const prompt = JSON.stringify(
      view.messages.find(({ role }) => role === "system"),
    );
    expect(prompt).toContain("web: canonical");
    expect(prompt).not.toContain("web: alias-1");
    expect(prompt).not.toContain("web: alias-2");
    await harness.close(context);
  });

  it("prefers an exact binding over another conversation address", async () => {
    const test = setup();
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("one", "evt-1"));
    const other = await deliver(
      inbound("two", "evt-2", { address: "thread-2" }),
    );
    const exact = await deliver(
      inbound("three", "evt-3", { conversationAddress: "thread-2" }),
      { create: false },
    );
    await expect(
      hub.deliver(
        "web",
        {
          ...inbound("ignored", "evt-4", { address: "unknown" }),
          conversationAddress: "missing",
        },
        { create: false },
      ),
    ).resolves.toBeUndefined();
    await harness.waitForIdle(context);

    expect(exact.conversationId).toBe(first.conversationId);
    expect(exact.conversationId).not.toBe(other.conversationId);
    const state = await harness.snapshot(ChannelsDoc, context);
    expect(
      findBinding(state, { channel: "web", address: "thread-1" })?.via,
    ).toBeUndefined();
    await harness.close(context);
  });

  it("serializes first deliveries to one address across different conversation addresses", async () => {
    const downloading = gate();
    const downloaded = gate();
    const test = setup();
    test.adapter.fetchFile = async (url) => {
      if (url === "slow") {
        downloading.open();
        await downloaded.promise;
      }
      return new TextEncoder().encode("notes");
    };
    const { harness, hub } = await test.open(new MemoryStorage());
    const first = hub.deliver("web", {
      ...inbound("slow", "evt-2", {
        conversationAddress: "fallback-a",
        cursor: "cursor-slow",
      }),
      files: [{ name: "notes.txt", mimeType: "text/plain", url: "slow" }],
    });
    await downloading.promise;
    let secondAdmitted = false;
    const second = hub
      .deliver(
        "web",
        inbound("fast", "evt-3", {
          conversationAddress: "fallback-b",
          cursor: "cursor-fast",
        }),
      )
      .then((receipt) => {
        secondAdmitted = true;
        return receipt;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAdmitted).toBe(false);

    downloaded.open();
    const [slow, fast] = await Promise.all([first, second]);
    await harness.waitForIdle(context);
    expect(fast?.conversationId).toBe(slow?.conversationId);
    const state = await harness.snapshot(ChannelsDoc, context);
    expect(
      findBinding(state, { channel: "web", address: "thread-1" })?.cursor,
    ).toBe("cursor-fast");
    await harness.close(context);
  });

  it("advances cursors only for new admissions and preserves them in binding updates", async () => {
    const test = setup();
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(
      inbound("one", "evt-1", {
        conversationAddress: "canonical",
        addressData: { version: 1 },
        cursor: "cursor-1",
      }),
    );
    const duplicate = await deliver(
      inbound("one", "evt-1", {
        conversationAddress: "canonical",
        addressData: { version: 2 },
        cursor: "cursor-2",
      }),
    );
    await deliver(
      inbound("two", "evt-2", {
        conversationAddress: "canonical",
        addressData: { version: 3 },
      }),
    );
    expect(duplicate).toEqual(first);
    await hub.bind(
      { channel: "web", address: "thread-1", addressData: { version: 4 } },
      first.conversationId,
    );
    test.adapter.result = () => ({ addressData: { version: 5 } });
    await deliver(
      inbound("three", "evt-3", {
        conversationAddress: "canonical",
        cursor: "cursor-3",
      }),
    );
    await harness.waitForIdle(context);

    const state = await harness.snapshot(ChannelsDoc, context);
    expect(findBinding(state, { channel: "web", address: "thread-1" })).toEqual(
      {
        conversationId: first.conversationId,
        addressData: { version: 5 },
        via: "canonical",
        cursor: "cursor-3",
      },
    );
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
    const { harness, hub, deliver, test, held, first } = await busySetup();
    const second = await deliver(inbound("also this", "evt-2"), {
      whenBusy: "steer",
    });
    held.gate?.open();
    await harness.waitForIdle(context);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual([undefined, "answer to also this"]);
    expect(test.adapter.sent.map(({ message }) => message.parts)).toEqual([
      [],
      [{ type: "text", text: "answer to also this" }],
    ]);
    expect(test.adapter.sent.map(({ ctx }) => ctx.idempotencyKey)).toEqual([
      expect.stringMatching(/^reply:/),
      expect.stringMatching(/^reply:/),
    ]);
    expect(test.adapter.sent[0]?.ctx.idempotencyKey).not.toBe(
      test.adapter.sent[1]?.ctx.idempotencyKey,
    );
    await expect(hub.status(first.submissionId)).resolves.toEqual({
      state: "done",
    });
    await expect(hub.status(second.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });

  it("uses the createChannels default", async () => {
    const { harness, deliver, test, held } = await busySetup("steer");
    await deliver(inbound("also this", "evt-2"));
    held.gate?.open();
    await harness.waitForIdle(context);
    expect(test.adapter.sent).toHaveLength(2);
    expect(test.adapter.sent.map(({ message }) => message.parts)).toEqual([
      [],
      [{ type: "text", text: "answer to also this" }],
    ]);
    await harness.close(context);
  });

  it("answers once at each address sharing a steered run", async () => {
    const { harness, hub, deliver, test, held, first } = await busySetup();
    await hub.bind(
      { channel: "web", address: "thread-2" },
      first.conversationId,
    );
    await deliver(inbound("second address", "evt-2", { address: "thread-2" }), {
      whenBusy: "steer",
    });
    held.gate?.open();
    await harness.waitForIdle(context);

    expect(
      test.adapter.sent.map(({ message }) => [message.address, message.parts]),
    ).toEqual([
      ["thread-1", [{ type: "text", text: "answer to second address" }]],
      ["thread-2", [{ type: "text", text: "answer to second address" }]],
    ]);
    await harness.close(context);
  });
});

describe("send failures and recovery", () => {
  it("preserves representations and the idempotency key through a retry", async () => {
    const adapter = testAdapter();
    adapter.failures = 1;
    const { createSend, harness } = await openSendHarness(
      new MemoryStorage(),
      adapter,
    );
    await createSend();
    await harness.waitForIdle(context);

    expect(adapter.sent.map(({ message }) => message.parts)).toEqual([
      representedParts,
      representedParts,
    ]);
    expect(adapter.sent.map(({ ctx }) => ctx.idempotencyKey)).toEqual([
      "reply:represented",
      "reply:represented",
    ]);
    await harness.close(context);
  });

  it("recovers stored representations and the original key after a crash", async () => {
    const storage = await sqliteStorage();
    const adapter = testAdapter();
    adapter.hold = true;
    const opened = await storage();
    const crashing = killable(opened);
    const first = await openSendHarness(crashing.storage, adapter);
    await first.createSend();
    first.harness.resume();
    await eventually(() => adapter.sent.length === 1);
    crashing.kill();

    adapter.hold = false;
    const reopened = await storage();
    const second = await openSendHarness(reopened, adapter);
    second.harness.resume();
    await second.harness.waitForIdle(context);

    expect(adapter.sent.map(({ message }) => message.parts)).toEqual([
      representedParts,
      representedParts,
    ]);
    expect(adapter.sent.map(({ ctx }) => ctx.idempotencyKey)).toEqual([
      "reply:represented",
      "reply:represented",
    ]);
    await second.harness.close(context);
  });

  it("recovers a host send with its original idempotency key", async () => {
    const storage = await sqliteStorage();
    const test = setup();
    test.adapter.hold = true;
    const opened = await storage();
    const crashing = killable(opened);
    const first = await test.open(crashing.storage);
    await first.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await test.channels.send(tx, conversation.id, {
        channel: "web",
        address: "thread-1",
        text: "New work started.",
        idempotencyKey: "alert:github:d1",
      });
    }, context);
    first.harness.resume();
    await eventually(() => test.adapter.sent.length === 1);
    crashing.kill();

    test.adapter.hold = false;
    const reopened = await storage();
    const second = await test.open(reopened);
    second.harness.resume();
    await eventually(() => test.adapter.sent.length === 2);
    expect(test.adapter.sent.map(({ ctx }) => ctx.idempotencyKey)).toEqual([
      "alert:github:d1",
      "alert:github:d1",
    ]);
    await second.hub.stop();
    await second.harness.close(context);
  });

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
    const failure = {
      channel: "web",
      address: "thread-1",
      error: expect.any(Error),
    };
    expect(
      test.channelReports.filter(({ kind }) => kind.startsWith("send_")),
    ).toEqual([
      { kind: "send_retry", ...failure, attempt: 1 },
      { kind: "send_retry", ...failure, attempt: 2 },
    ]);
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });

  it("fails the delivery after the last attempt and reports it once, as send_failed", async () => {
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
    expect(
      test.channelReports.flatMap((report) =>
        report.kind.startsWith("send_") ? [report.kind] : [],
      ),
    ).toEqual(["send_retry", "send_retry", "send_failed"]);
    expect(test.channelReports.at(-1)).toEqual({
      kind: "send_failed",
      channel: "web",
      address: "thread-1",
      error: new Error("platform unavailable"),
    });
    expect(test.reports.map((report) => report.kind)).not.toContain(
      "task_error",
    );
    await harness.close(context);
  });

  it("delivers and sends when onReport throws", async () => {
    const test = setup({
      onReport: () => {
        throw new Error("sink down");
      },
    });
    test.adapter.failures = 1;
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const receipt = await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(test.adapter.sent).toHaveLength(2);
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    expect(test.channelReports.map(({ kind }) => kind)).toEqual([
      "admitted",
      "send_retry",
    ]);
    expect(test.reports).toEqual([]);
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

describe("tools", () => {
  const callTool = (name: string, args: Record<string, string>) =>
    ((text, last) =>
      last?.role === "user" && text.startsWith("call")
        ? fauxAssistantMessage(fauxToolCall(name, args), {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage(`done: ${text}`)) satisfies Responder;

  it("send_message delivers to an address of the conversation with its address data, retrying failures", async () => {
    const test = setup();
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("hi", "evt-0"));
    await harness.waitForIdle(context);
    await hub.bind(
      { channel: "web", address: "thread-2", addressData: { team: "t2" } },
      first.conversationId,
    );
    test.adapter.sent.length = 0;
    test.state.respond = callTool("send_message", {
      channel: "web",
      address: "thread-2",
      text: "ping",
    });
    test.adapter.failures = 1;

    await deliver(inbound("call", "evt-1"));
    await harness.waitForIdle(context);
    await eventually(
      () =>
        test.adapter.sent.filter(
          ({ message }) => message.address === "thread-2",
        ).length === 2,
    );
    const notifications = test.adapter.sent.filter(
      ({ message }) => message.address === "thread-2",
    );
    expect(
      notifications.map(({ message, ctx }) => [
        message.parts,
        ctx.addressData,
        ctx.replyContext,
      ]),
    ).toEqual([
      [[{ type: "text", text: "ping" }], { team: "t2" }, undefined],
      [[{ type: "text", text: "ping" }], { team: "t2" }, undefined],
    ]);
    expect(notifications[0]?.ctx.idempotencyKey).toMatch(/^notify:/);
    expect(notifications[1]?.ctx.idempotencyKey).toBe(
      notifications[0]?.ctx.idempotencyKey,
    );
    const reply = test.adapter.sent.find(
      ({ message }) => message.address === "thread-1",
    );
    expect(reply?.message.parts[0]?.text).toMatch(
      /^done: Message queued for thread-2/,
    );
    await harness.close(context);
  });

  it("send_message refuses unknown addresses and addresses of other conversations", async () => {
    const test = setup();
    const { harness, deliver } = await test.open(new MemoryStorage());
    await deliver(inbound("hi", "evt-0", { address: "thread-2" }));
    await harness.waitForIdle(context);
    test.adapter.sent.length = 0;
    for (const address of ["nobody", "thread-2"]) {
      test.state.respond = callTool("send_message", {
        channel: "web",
        address,
        text: "ping",
      });
      await deliver(inbound("call", `evt-${address}`));
      await harness.waitForIdle(context);
    }
    expect(
      test.adapter.sent.map(({ message }) => [
        message.address,
        message.parts[0]?.text,
      ]),
    ).toEqual([
      ["thread-1", "done: Unknown address nobody on channel web."],
      ["thread-1", "done: Unknown address thread-2 on channel web."],
    ]);
    await harness.close(context);
  });

  it("no_reply ends the run with an empty reply, which the adapter can use to clear its state", async () => {
    const test = setup({ respond: callTool("no_reply", {}) });
    const { harness, deliver } = await test.open(new MemoryStorage());
    const receipt = await deliver(inbound("call nobody", "evt-1"));
    await harness.waitForIdle(context);
    expect(test.adapter.sent.map(({ message }) => message.parts)).toEqual([[]]);
    const conversation = await conversationOf(harness, receipt.conversationId);
    const entries = await entriesOf(conversation);
    expect(entries.some((entry) => textOf(entry).startsWith("done"))).toBe(
      false,
    );
    await harness.close(context);
  });

  it("list_addresses lists the conversation's own addresses, without transport data", async () => {
    const test = setup({ respond: callTool("list_addresses", {}) });
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await deliver(inbound("x", "evt-0", { address: "ops-room" }));
    const first = await deliver(
      inbound("hi", "evt-1", { addressData: { secret: "s" } }),
    );
    await harness.waitForIdle(context);
    await hub.bind({ channel: "web", address: "pr-1" }, first.conversationId);
    await deliver(inbound("call", "evt-2"));
    await harness.waitForIdle(context);
    const reply = test.adapter.sent.at(-1)?.message.parts[0]?.text ?? "";
    expect(JSON.parse(reply.replace(/^done: /, ""))).toEqual([
      { channel: "web", address: "thread-1" },
      { channel: "web", address: "pr-1" },
    ]);
    await harness.close(context);
  });

  it("registers read_history only when an adapter supports it", () => {
    expect(setup().channels.tools.tools?.map(({ name }) => name)).not.toContain(
      "read_history",
    );
    const adapter = testAdapter();
    adapter.history = async () => ({ content: "", truncated: false });
    const test = setup({ channels: { web: { adapter } } });
    expect(test.channels.tools.tools?.map(({ name }) => name)).toContain(
      "read_history",
    );
  });

  it("reads history through an owned alias without changing admission state", async () => {
    const adapter = testAdapter();
    const requests: ChannelHistoryRequest[] = [];
    let signal: AbortSignal | undefined;
    adapter.history = async (request, ctx) => {
      requests.push(request);
      signal = ctx.signal;
      return { content: "earlier messages", cursor: "next", truncated: false };
    };
    const test = setup({
      channels: { web: { adapter, conversation: createWeb } },
      respond: callTool("read_history", {
        channel: "web",
        address: "alias-1",
        after: "opaque-after",
        before: "opaque-before",
      }),
    });
    const storage = new MemoryStorage();
    const { harness, deliver } = await test.open(storage);
    await deliver(
      inbound("hello", "evt-1", {
        address: "alias-1",
        conversationAddress: "canonical",
        cursor: "admission-cursor",
      }),
    );
    await harness.waitForIdle(context);
    await deliver(
      inbound("call", "evt-2", {
        address: "alias-1",
        conversationAddress: "canonical",
      }),
      { create: false },
    );
    await harness.waitForIdle(context);

    expect(requests).toEqual([
      {
        address: "alias-1",
        after: "opaque-after",
        before: "opaque-before",
        maxBytes: 32768,
      },
    ]);
    expect(signal).toBeInstanceOf(AbortSignal);
    const reply = adapter.sent.at(-1)?.message.parts[0]?.text ?? "";
    expect(JSON.parse(reply.replace(/^done: /, ""))).toEqual({
      content: "earlier messages",
      cursor: "next",
      truncated: false,
    });
    const state = await harness.snapshot(ChannelsDoc, context);
    expect(
      findBinding(state, { channel: "web", address: "alias-1" })?.cursor,
    ).toBe("admission-cursor");
    const submissions = await storage.scanSubmissions(
      {},
      10,
      undefined,
      context,
    );
    expect(submissions.items).toHaveLength(2);
    await harness.close(context);
  });

  it("bounds history content without splitting UTF-8 and keeps the continuation cursor", async () => {
    const adapter = testAdapter();
    const content = `${"a".repeat(32767)}\u{1f600}tail`;
    adapter.history = async () => ({
      content,
      cursor: "continue",
      truncated: false,
    });
    const test = setup({
      channels: { web: { adapter, conversation: createWeb } },
      respond: callTool("read_history", {
        channel: "web",
        address: "thread-1",
      }),
    });
    const { harness, deliver } = await test.open(new MemoryStorage());
    await deliver(inbound("call", "evt-1"));
    await harness.waitForIdle(context);

    const reply = adapter.sent.at(-1)?.message.parts[0]?.text ?? "";
    const result = JSON.parse(reply.replace(/^done: /, "")) as {
      content: string;
      cursor: string;
      truncated: boolean;
    };
    expect(result).toEqual({
      content: "a".repeat(32767),
      cursor: "continue",
      truncated: true,
    });
    expect(new TextEncoder().encode(result.content)).toHaveLength(32767);
    await harness.close(context);
  });

  it("rejects history for another conversation and for an adapter without history", async () => {
    const adapter = testAdapter();
    adapter.history = async () => ({ content: "secret", truncated: false });
    const quiet = testAdapter();
    const test = setup({
      channels: {
        web: { adapter, conversation: createWeb },
        chat: { adapter: quiet },
      },
    });
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const own = await deliver(inbound("own", "evt-1"));
    await deliver(inbound("other", "evt-2", { address: "other" }));
    await hub.bind({ channel: "chat", address: "chat-1" }, own.conversationId);
    await harness.waitForIdle(context);

    for (const [channel, address] of [
      ["web", "other"],
      ["chat", "chat-1"],
    ]) {
      test.state.respond = callTool("read_history", { channel, address });
      await deliver(inbound("call", `evt-${channel}`));
      await harness.waitForIdle(context);
    }
    const replies = adapter.sent
      .slice(-2)
      .map(({ message }) => message.parts[0]?.text);
    expect(replies).toEqual([
      "done: Unknown address other on channel web.",
      "done: History is unavailable on channel chat.",
    ]);
    await harness.close(context);
  });

  it("returns adapter history failures as tool errors", async () => {
    const adapter = testAdapter();
    adapter.history = async () => {
      throw new Error("source denied");
    };
    const test = setup({
      channels: { web: { adapter, conversation: createWeb } },
      respond: callTool("read_history", {
        channel: "web",
        address: "thread-1",
      }),
    });
    const { harness, deliver } = await test.open(new MemoryStorage());
    await deliver(inbound("call", "evt-1"));
    await harness.waitForIdle(context);
    expect(adapter.sent.at(-1)?.message.parts[0]?.text).toBe(
      "done: History read failed: source denied",
    );
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
    expect(
      test.channelReports.filter(({ kind }) => kind === "ignored"),
    ).toEqual([
      { kind: "ignored", channel: "quiet", address: "thread-1" },
      { kind: "ignored", channel: "picky", address: "thread-1" },
    ]);
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

  it("reads the addresses of a conversation, aliases included, and the conversation of an address", async () => {
    const test = setup();
    test.adapter.result = () => ({ alias: "t9" });
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const first = await deliver(inbound("one", "evt-1", { address: "case:1" }));
    await harness.waitForIdle(context);
    await expect(hub.addresses(first.conversationId)).resolves.toEqual([
      { channel: "web", address: "case:1" },
      { channel: "web", address: "t9" },
    ]);
    await expect(
      hub.conversationOf({ channel: "web", address: "t9" }),
    ).resolves.toBe(first.conversationId);
    await expect(
      hub.conversationOf({ channel: "web", address: "nobody" }),
    ).resolves.toBeUndefined();
    await hub.end({ channel: "web", address: "case:1" });
    await expect(hub.addresses(first.conversationId)).resolves.toEqual([]);
    await expect(
      hub.conversationOf({ channel: "web", address: "t9" }),
    ).resolves.toBeUndefined();
    await harness.close(context);
  });
});

describe("adapters", () => {
  it("start hands each adapter a deliver bound to its channel", async () => {
    const adapter = testAdapter();
    const started: Partial<AdapterStart> = {};
    adapter.start = (ctx) => {
      Object.assign(started, ctx);
    };
    const test = setup({
      channels: { web: { adapter, conversation: createWeb } },
    });
    const { harness, hub } = await test.open(new MemoryStorage());
    await hub.start();
    const receipt = await started.deliver?.(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(receipt?.conversationId).toBeDefined();
    expect(adapter.sent.map(({ message }) => message.parts[0]?.text)).toEqual([
      "echo hello",
    ]);
    await expect(started.binding?.("thread-1")).resolves.toEqual({
      conversationId: receipt?.conversationId,
    });
    expect(started.signal?.aborted).toBe(false);
    await hub.stop();
    expect(started.signal?.aborted).toBe(true);
    await harness.close(context);
  });

  it("passes an adapter's reports to onReport with its channel", async () => {
    const adapter = testAdapter();
    adapter.start = ({ report }) => {
      report({ kind: "skipped", detail: "bot message" });
      report({ kind: "adapter_error", error: "socket closed" });
    };
    const test = setup({
      channels: { chat: { adapter, conversation: createWeb } },
    });
    const { harness, hub } = await test.open(new MemoryStorage());
    await hub.start();
    expect(test.channelReports).toEqual([
      { kind: "skipped", channel: "chat", detail: "bot message" },
      { kind: "adapter_error", channel: "chat", error: "socket closed" },
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

  it("runs a message that may not create a conversation only on a bound address", async () => {
    const test = setup();
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    const options = { create: false };
    await expect(
      hub.deliver("web", inbound("chatter", "evt-1"), options),
    ).resolves.toBeUndefined();
    const first = await deliver(inbound("hi", "evt-2"));
    const followUp = await deliver(inbound("more", "evt-3"), options);
    await harness.waitForIdle(context);
    expect(followUp.conversationId).toBe(first.conversationId);
    expect(
      test.adapter.sent.map(({ message }) => message.parts[0]?.text),
    ).toEqual(["echo hi", "echo more"]);
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

describe("stop", () => {
  function stoppable(test: ReturnType<typeof setup>) {
    const log: string[] = [];
    const started: Partial<AdapterStart> = {};
    test.adapter.start = (ctx) => {
      Object.assign(started, ctx);
    };
    test.adapter.stop = async () => {
      log.push("adapter stopped");
    };
    return { log, started };
  }

  it("stores a delivery in flight before closing adapters, and resolves after it", async () => {
    const test = setup();
    const { log, started } = stoppable(test);
    const download = gate();
    test.adapter.fetchFile = async () => {
      log.push("downloading");
      await download.promise;
      return new TextEncoder().encode("notes");
    };
    const { harness, hub } = await test.open(new MemoryStorage());
    await hub.start();
    const file = { name: "a.txt", mimeType: "text/plain", url: "u" };
    const delivery = started.deliver?.({
      ...inbound("hi", "evt-1"),
      files: [file],
    });
    void delivery?.then(() =>
      log.push(`stored, open=${!started.signal?.aborted}`),
    );
    await eventually(() => log.includes("downloading"));
    const stopping = hub.stop().then(() => log.push("hub stopped"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(["downloading"]);
    download.open();
    await stopping;
    expect(log).toEqual([
      "downloading",
      "stored, open=true",
      "adapter stopped",
      "hub stopped",
    ]);
    const receipt = await accepted(delivery ?? Promise.resolve(undefined));
    await expect(hub.status(receipt.submissionId)).resolves.toBeDefined();
    await harness.close(context);
  });

  it("rejects every change after stop and keeps the reads", async () => {
    const test = setup();
    const { started } = stoppable(test);
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    const receipt = await deliver(inbound("hi", "evt-1"));
    await harness.waitForIdle(context);
    await hub.stop();
    const key = { channel: "web", address: "thread-1" };
    const changes = [
      hub.deliver("web", inbound("again", "evt-2")),
      started.deliver?.(inbound("again", "evt-3")),
      hub.bind({ channel: "web", address: "other" }, receipt.conversationId),
      hub.cancel(key),
      hub.clear(key),
      hub.compact(key),
      hub.end(key),
      started.cancel?.("thread-1"),
    ];
    for (const change of changes)
      await expect(change).rejects.toThrow("Channels hub is stopped");
    await expect(hub.conversationOf(key)).resolves.toBe(receipt.conversationId);
    await expect(hub.addresses(receipt.conversationId)).resolves.toEqual([key]);
    await expect(hub.status(receipt.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });

  it("starts once: a second start or a start after stop rejects", async () => {
    const test = setup();
    const { harness, hub } = await test.open(new MemoryStorage());
    await hub.start();
    await expect(hub.start()).rejects.toThrow("can only start once");
    await hub.stop();
    const unstarted = test.channels.hub(harness);
    await unstarted.stop();
    await expect(unstarted.start()).rejects.toThrow("can only start once");
    await harness.close(context);
  });

  it("waits for a start in progress before stopping, and stops what it started", async () => {
    const test = setup();
    const { log, started } = stoppable(test);
    const ready = gate();
    test.adapter.start = async (ctx) => {
      Object.assign(started, ctx);
      await ready.promise;
      log.push(`started, open=${!ctx.signal.aborted}`);
    };
    test.adapter.events = (_target, event) => {
      log.push(event.type);
    };
    const { harness, hub } = await test.open(new MemoryStorage());
    const starting = hub.start();
    await eventually(() => started.signal !== undefined);
    const stopping = hub.stop();
    ready.open();
    await starting;
    await stopping;
    expect(log).toEqual(["started, open=true", "adapter stopped"]);
    const other = test.channels.hub(harness);
    await other.deliver("web", inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(test.adapter.sent).toHaveLength(1);
    expect(log).toEqual(["started, open=true", "adapter stopped"]);
    await harness.close(context);
  });

  it("rejects start when an adapter fails to start", async () => {
    const test = setup();
    test.adapter.start = async () => {
      throw new Error("bad token");
    };
    const { harness, hub } = await test.open(new MemoryStorage());
    await expect(hub.start()).rejects.toThrow("bad token");
    await hub.stop();
    await harness.close(context);
  });

  it("stops adapters after the events calls in flight finish", async () => {
    const test = setup();
    const { log } = stoppable(test);
    const rendering = gate();
    test.adapter.events = async (_target, event) => {
      if (event.type !== "run_started") return;
      log.push("rendering");
      await rendering.promise;
      log.push("rendered");
    };
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    await deliver(inbound("hi", "evt-1"));
    await eventually(() => log.includes("rendering"));
    const stopping = hub.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(["rendering"]);
    rendering.open();
    await stopping;
    expect(log).toEqual(["rendering", "rendered", "adapter stopped"]);
    await harness.waitForIdle(context);
    await harness.close(context);
  });
});

type Seen = { target: ReplyTarget; event: ChannelEvent };

describe("attachments", () => {
  const files = [
    { name: "cat.png", mimeType: "image/png", url: "https://files.test/cat" },
    {
      name: "../report.pdf",
      mimeType: "application/pdf",
      url: "https://files.test/report",
    },
  ];
  const bytes: Record<string, string> = {
    "https://files.test/cat": "png-bytes",
    "https://files.test/report": "%PDF quarterly numbers",
  };

  function withFiles(options: SetupOptions = {}) {
    const seen: { text: string; images: string[] } = { text: "", images: [] };
    const test = setup({
      ...options,
      respond: (text, last) => {
        const parts =
          typeof last?.content === "string" ? [] : (last?.content ?? []);
        seen.text = text;
        seen.images = parts.flatMap((part) =>
          part.type === "image" ? [part.mimeType] : [],
        );
        return fauxAssistantMessage("got it");
      },
    });
    test.adapter.fetchFile = async (url) => {
      const body = bytes[url];
      if (body === undefined) throw new Error("gone");
      return new TextEncoder().encode(body);
    };
    return { test, seen };
  }

  it("saves files in the conversation's environment and shows images", async () => {
    const cwd = await tempDir();
    const env = new NodeExecutionEnv({ cwd });
    const { test, seen } = withFiles({ env: () => env });
    const { harness, deliver } = await test.open(new MemoryStorage());
    await deliver({ ...inbound("look", "evt-1"), files });
    await harness.waitForIdle(context);
    const lines = seen.text.split("\n");
    expect(lines[0]).toBe("look");
    const paths = lines
      .slice(1)
      .map((line) => /^Attached file (\S+) \(/.exec(line)?.[1]);
    expect(paths.map((path) => path && basename(path))).toEqual([
      "cat.png",
      "report.pdf",
    ]);
    expect(
      paths.every((path) =>
        path?.startsWith(join(cwd, ".channels", "attachments")),
      ),
    ).toBe(true);
    await expect(readFile(paths[1] ?? "", "utf8")).resolves.toBe(
      "%PDF quarterly numbers",
    );
    expect(seen.images).toEqual(["image/png"]);
    await harness.close(context);
  });

  it("keeps files with the same name apart", async () => {
    const env = new NodeExecutionEnv({ cwd: await tempDir() });
    const { test, seen } = withFiles({ env: () => env });
    const { harness, deliver } = await test.open(new MemoryStorage());
    const twins = [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        url: "https://files.test/cat",
      },
      {
        name: "notes.txt",
        mimeType: "text/plain",
        url: "https://files.test/report",
      },
    ];
    await deliver({ ...inbound("look", "evt-1"), files: twins });
    await harness.waitForIdle(context);
    const paths = seen.text
      .split("\n")
      .slice(1)
      .map((line) => /^Attached file (\S+) \(/.exec(line)?.[1] ?? "");
    const contents = await Promise.all(
      paths.map((path) => readFile(path, "utf8")),
    );
    expect(contents).toEqual(["png-bytes", "%PDF quarterly numbers"]);
    await harness.close(context);
  });

  it("names files it cannot download or save", async () => {
    const { test, seen } = withFiles();
    const { harness, deliver } = await test.open(new MemoryStorage());
    const lost = {
      name: "old.txt",
      mimeType: "text/plain",
      url: "https://files.test/old",
    };
    await deliver({ ...inbound("look", "evt-1"), files: [...files, lost] });
    await harness.waitForIdle(context);
    expect(seen.text.split("\n")).toEqual([
      "look",
      "Attached file cat.png (image/png), not saved: no environment",
      "Attached file ../report.pdf (application/pdf), not saved: no environment",
      "Attached file old.txt (text/plain), not downloaded: gone",
    ]);
    expect(seen.images).toEqual(["image/png"]);
    await harness.close(context);
  });
});

describe("events", () => {
  function withEvents(test: ReturnType<typeof setup>) {
    const seen: Seen[] = [];
    const started: Partial<AdapterStart> = {};
    const sentAtEnd: number[] = [];
    test.adapter.events = (target, event) => {
      seen.push({ target, event });
      if (event.type === "run_ended") sentAtEnd.push(test.adapter.sent.length);
    };
    test.adapter.start = (ctx) => {
      Object.assign(started, ctx);
    };
    return { seen, started, sentAtEnd };
  }

  const eventsOf = (seen: Seen[]) => seen.map(({ event }) => event);
  const ended = (seen: Seen[]) => () =>
    seen.some(({ event }) => event.type === "run_ended");

  const toolThenAnswer =
    (first: AssistantMessage, answer = "done"): Responder =>
    (_text, last) =>
      last?.role === "user" ? first : fauxAssistantMessage(answer);

  it("reports a run's narration and tool calls in order, without the answer, keyed like the reply", async () => {
    const test = setup({
      extensions: [holdTool({})],
      respond: toolThenAnswer(
        fauxAssistantMessage(
          [fauxText("Let me check."), fauxToolCall("work", {})],
          { stopReason: "toolUse" },
        ),
      ),
    });
    const { seen, sentAtEnd } = withEvents(test);
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    const receipt = await deliver(
      inbound("hello", "evt-1", { replyContext: { ts: "1" } }),
    );
    await harness.waitForIdle(context);
    await eventually(ended(seen));
    const conversation = await conversationOf(harness, receipt.conversationId);
    const entries = await entriesOf(conversation);
    const narrated = entries.find((entry) =>
      entry.model?.some((message) => message.role === "assistant"),
    );
    const call = narrated?.model?.[0];
    const callId =
      call?.role === "assistant"
        ? call.content.find((part) => part.type === "toolCall")?.id
        : undefined;
    expect(eventsOf(seen)).toEqual([
      { type: "run_started" },
      { type: "text", id: String(narrated?.id), text: "Let me check." },
      { type: "tool_started", id: callId, name: "work", args: {} },
      {
        type: "tool_finished",
        id: callId,
        name: "work",
        isError: false,
        output: "worked",
      },
      { type: "run_ended", outcome: "completed" },
    ]);
    expect(sentAtEnd).toEqual([1]);
    const [sent] = test.adapter.sent;
    expect(sent?.message.parts).toEqual([{ type: "text", text: "done" }]);
    expect(new Set(seen.map(({ target }) => JSON.stringify(target)))).toEqual(
      new Set([
        JSON.stringify({
          address: "thread-1",
          replyContext: { ts: "1" },
          idempotencyKey: sent?.ctx.idempotencyKey,
        }),
      ]),
    );
    await harness.close(context);
  });

  it("moves run events to the newest input at each address", async () => {
    const held: { gate?: Gate } = { gate: gate() };
    const test = setup({
      extensions: [holdTool(held)],
      respond: toolThenAnswer(
        fauxAssistantMessage(fauxToolCall("work", {}), {
          stopReason: "toolUse",
        }),
        "done",
      ),
    });
    const { seen } = withEvents(test);
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    await deliver(inbound("start", "evt-1", { replyContext: { input: 1 } }));
    await eventually(() =>
      seen.some(({ event }) => event.type === "tool_started"),
    );
    await deliver(inbound("steered", "evt-2", { replyContext: { input: 2 } }), {
      whenBusy: "steer",
    });
    held.gate?.open();
    await eventually(() =>
      seen.some(
        ({ target, event }) =>
          event.type === "run_started" &&
          JSON.stringify(target.replyContext) === JSON.stringify({ input: 2 }),
      ),
    );
    await harness.waitForIdle(context);
    await eventually(ended(seen));

    const starts = seen.filter(({ event }) => event.type === "run_started");
    expect(starts.map(({ target }) => target.replyContext)).toEqual([
      { input: 1 },
      { input: 2 },
    ]);
    const secondStart = seen.findIndex(
      ({ target, event }) =>
        event.type === "run_started" &&
        JSON.stringify(target.replyContext) === JSON.stringify({ input: 2 }),
    );
    expect(
      seen
        .slice(secondStart)
        .every(
          ({ target }) =>
            JSON.stringify(target.replyContext) ===
            JSON.stringify({ input: 2 }),
        ),
    ).toBe(true);
    expect(test.adapter.sent.map(({ message }) => message.parts)).toEqual([
      [],
      [{ type: "text", text: "done" }],
    ]);
    await harness.close(context);
  });

  it("hides no_reply and the text next to it", async () => {
    const test = setup({
      respond: toolThenAnswer(
        fauxAssistantMessage(
          [fauxText("Not for me."), fauxToolCall("no_reply", {})],
          { stopReason: "toolUse" },
        ),
      ),
    });
    const { seen } = withEvents(test);
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    await eventually(ended(seen));
    expect(eventsOf(seen)).toEqual([
      { type: "run_started" },
      { type: "run_ended", outcome: "completed" },
    ]);
    await harness.close(context);
  });

  it("joins the text parts of a tool result and skips its images", async () => {
    const picture = defineExtension({
      name: "test-picture",
      tools: [
        defineTool({
          name: "picture",
          description: "Take a picture",
          parameters: obj({}),
          execute: async () => ({
            output: [
              { type: "text", text: "before " },
              { type: "image", data: "aGk=", mimeType: "image/png" },
              { type: "text", text: "after" },
            ],
          }),
        }),
      ],
    });
    const test = setup({
      extensions: [picture],
      respond: toolThenAnswer(
        fauxAssistantMessage(fauxToolCall("picture", {}), {
          stopReason: "toolUse",
        }),
      ),
    });
    const { seen } = withEvents(test);
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    await eventually(ended(seen));
    expect(
      eventsOf(seen).find(({ type }) => type === "tool_finished"),
    ).toMatchObject({ name: "picture", output: "before after" });
    await harness.close(context);
  });

  it("ends a run the adapter cancels as aborted", async () => {
    const held: { gate?: ReturnType<typeof gate> } = { gate: gate() };
    const test = setup({
      extensions: [holdTool(held)],
      respond: () =>
        fauxAssistantMessage(fauxToolCall("work", {}), {
          stopReason: "toolUse",
        }),
    });
    const { seen, started } = withEvents(test);
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    await deliver(inbound("start", "evt-1"));
    await eventually(() =>
      seen.some(({ event }) => event.type === "tool_started"),
    );
    const cancelled = started.cancel?.("thread-1");
    held.gate?.open();
    await cancelled;
    await harness.waitForIdle(context);
    await eventually(ended(seen));
    const events = eventsOf(seen);
    expect(events.slice(0, 2)).toEqual([
      { type: "run_started" },
      { type: "tool_started", id: expect.any(String), name: "work", args: {} },
    ]);
    expect(events.at(-1)).toEqual({ type: "run_ended", outcome: "aborted" });
    expect(test.adapter.sent).toEqual([]);
    await harness.close(context);
  });

  it("ends a run the model fails as failed", async () => {
    const test = setup({
      respond: () =>
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "model down",
        }),
    });
    const { seen } = withEvents(test);
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    await eventually(ended(seen));
    expect(eventsOf(seen)).toEqual([
      { type: "run_started" },
      { type: "run_ended", outcome: "failed" },
    ]);
    await harness.close(context);
  });

  it("reports a throwing events as an adapter error with its channel and address", async () => {
    const test = setup();
    test.adapter.events = () => {
      throw new Error("render failed");
    };
    const { harness, hub, deliver } = await test.open(new MemoryStorage());
    await hub.start();
    await deliver(inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    await eventually(
      () =>
        test.channelReports.filter(({ kind }) => kind === "adapter_error")
          .length === 2,
    );
    expect(
      test.channelReports.filter(({ kind }) => kind === "adapter_error"),
    ).toEqual(
      ["run_started", "run_ended"].map(() => ({
        kind: "adapter_error",
        channel: "web",
        address: "thread-1",
        error: new Error("render failed"),
      })),
    );
    expect(test.adapter.sent).toHaveLength(1);
    await harness.close(context);
  });

  it("sends no events to channels without events", async () => {
    const watching = testAdapter();
    const quiet = testAdapter();
    const seen: ChannelEvent[] = [];
    watching.events = (_target, event) => {
      seen.push(event);
    };
    const test = setup({
      channels: {
        web: { adapter: watching, conversation: createWeb },
        chat: { adapter: quiet, conversation: createWeb },
      },
    });
    const { harness, hub } = await test.open(new MemoryStorage());
    await hub.start();
    await hub.deliver("chat", inbound("hello", "evt-1"));
    await harness.waitForIdle(context);
    expect(quiet.sent).toHaveLength(1);
    expect(seen).toEqual([]);
    await harness.close(context);
  });
});
