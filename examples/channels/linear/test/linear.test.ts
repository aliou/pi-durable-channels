import { type ChannelReport, createChannels } from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { sessionAddress } from "../address";
import { linearChannel } from "../linear";
import { linearTools } from "../tools";
import {
  type Call,
  fakeLinear,
  payloads,
  served,
  webhook,
} from "./fake-linear";

const MODEL = { provider: "faux", modelId: "faux-1" };
const ADDRESS = sessionAddress(payloads.sessionId);

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((each) => {
    if (each.role !== "user") return [];
    if (typeof each.content === "string") return [each.content];
    return each.content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
  });
}

async function open() {
  const api = await fakeLinear();
  const linear = linearChannel({
    token: "lin_test",
    webhookSecret: "linear-webhook-secret",
    apiUrl: api.apiUrl,
  });
  const reports: ChannelReport[] = [];
  const channels = createChannels({
    onReport: (report) => {
      reports.push(report);
    },
    channels: {
      linear: {
        adapter: linear,
        conversation: (message) =>
          message.event === "agent_session.created"
            ? { agent: { model: MODEL, instructions: "code" } }
            : undefined,
      },
    },
  });
  const seen: string[][] = [];
  const faux = fauxProvider();
  faux.setResponses(
    Array.from(
      { length: 20 },
      () => (transcript: { messages: readonly Message[] }) => {
        const texts = userTexts(transcript.messages);
        seen.push(texts);
        return fauxAssistantMessage(`answer ${seen.length}`);
      },
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(channels.extension);
  registry.install(channels.tools);
  registry.install(linearTools({ token: "lin_test", apiUrl: api.apiUrl }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    context,
  );
  const hub = channels.hub(harness);
  const close = async () => {
    await hub.stop();
    await harness.close(context);
  };
  return {
    linear: served(linear),
    hub,
    harness,
    faux,
    seen,
    reports,
    close,
    ...api,
  };
}

async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const activities = (calls: Call[]) =>
  calls
    .filter(({ query }) => query.includes("agentActivityCreate"))
    .map(({ variables }) => {
      const input = (variables as { input: Record<string, unknown> }).input;
      return { ...input, content: input.content as Record<string, unknown> };
    });

describe("linear channel end to end", () => {
  it("answers 503 before start, 401 for a bad signature, and 401 for a stale timestamp", async () => {
    const { linear, hub, close } = await open();
    const early = await linear(webhook(payloads.created()));
    expect(early.status).toBe(503);
    await hub.start();
    const forged = await linear(
      webhook(payloads.created(), { secret: "other" }),
    );
    expect(forged.status).toBe(401);
    const stale = await linear(
      webhook(payloads.created(), {
        timestamp: Date.now() - 8 * 60 * 60 * 1000,
      }),
    );
    expect(stale.status).toBe(401);
    const unsigned = await linear(
      webhook(payloads.created(), { signature: null }),
    );
    expect(unsigned.status).toBe(401);
    await close();
  });

  it("reports the events it skips", async () => {
    const { linear, hub, reports, close } = await open();
    await hub.start();
    await linear(webhook(payloads.comment(), { delivery: "d0" }));
    expect(reports).toEqual([
      { kind: "skipped", channel: "linear", detail: "Comment d0" },
    ]);
    await close();
  });

  it("answers a delegated session and follows the user's prompts without repeating a redelivery", async () => {
    const { linear, hub, harness, calls, seen, close } = await open();
    await hub.start();
    expect(calls[0]).toMatchObject({
      query: expect.stringContaining("viewer"),
      token: "Bearer lin_test",
    });

    const created = payloads.created();
    for (const _ of [1, 2]) await linear(webhook(created, { delivery: "d1" }));
    await harness.waitForIdle(context);

    await linear(
      webhook(payloads.prompted("use postgres"), { delivery: "d2" }),
    );
    await harness.waitForIdle(context);

    const contents = activities(calls).map(({ content }) => content.type);
    expect(contents).toEqual(["thought", "response", "thought", "response"]);
    expect(activities(calls)[1]?.content.body).toBe("answer 1");
    expect(activities(calls)[3]?.content.body).toBe("answer 2");
    expect(seen.at(-1)?.at(-1)).toBe("use postgres");
    await close();
  });

  it("shows a thinking indicator while the run works and nothing after it ends cleanly", async () => {
    const { linear, hub, harness, calls, close } = await open();
    await hub.start();
    await linear(webhook(payloads.created()));
    await until(() => activities(calls).length > 0);
    await harness.waitForIdle(context);
    const thought = activities(calls)[0];
    expect(thought).toMatchObject({
      agentSessionId: payloads.sessionId,
      content: { type: "thought", body: "Thinking…" },
      ephemeral: true,
    });
    await close();
  });

  it("posts an elicitation through the elicit tool and ends the run without an answer", async () => {
    const { linear, hub, harness, faux, calls, close } = await open();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Which database?"),
          fauxToolCall("elicit", {
            address: ADDRESS,
            body: "Which database should I target?",
            options: [
              { label: "Postgres", value: "postgres" },
              { label: "SQLite", value: "sqlite" },
            ],
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("no_reply", {}), {
        stopReason: "toolUse",
      }),
    ]);
    await hub.start();
    await linear(webhook(payloads.created()));
    await harness.waitForIdle(context);

    const posted = activities(calls);
    const elicitation = posted.find(
      ({ content }) => content.type === "elicitation",
    );
    expect(elicitation).toMatchObject({
      agentSessionId: payloads.sessionId,
      content: { type: "elicitation", body: "Which database should I target?" },
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Postgres", value: "postgres" },
          { label: "SQLite", value: "sqlite" },
        ],
      },
    });
    expect(
      posted.find(({ content }) => content.type === "response"),
    ).toBeUndefined();
    await close();
  });

  it("refuses to elicit on an address outside the conversation", async () => {
    const { linear, hub, harness, faux, calls, close } = await open();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("elicit", {
          address: "session:00000000-0000-4000-8000-00000000ffff",
          body: "Which database?",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("no_reply", {}), {
        stopReason: "toolUse",
      }),
    ]);
    await hub.start();
    await linear(webhook(payloads.created()));
    await harness.waitForIdle(context);
    expect(
      activities(calls).some(({ content }) => content.type === "elicitation"),
    ).toBe(false);
    await close();
  });

  it("cancels the run when the user sends a stop signal", async () => {
    const { linear, hub, harness, calls, close } = await open();
    await hub.start();
    await linear(webhook(payloads.created()));
    await harness.waitForIdle(context);
    await linear(
      webhook(
        payloads.prompted("stop", {
          agentActivity: {
            id: "a-stop",
            content: { type: "prompt", body: "stop" },
            signal: "stop",
            user: { id: "u-ana", name: "ana" },
          },
        }),
        { delivery: "d3" },
      ),
    );
    await harness.waitForIdle(context);
    expect(
      activities(calls).filter(({ content }) => content.type === "response"),
    ).toHaveLength(1);
    await close();
  });
});
