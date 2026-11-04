import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannels } from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  type HarnessOptions,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { obj, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessages } from "../events";
import type { NameThread } from "../naming";
import { slackChannel } from "../slack";
import { httpEvents, socketMode } from "../transport";
import {
  type Call,
  fakeSlack,
  message,
  SECRET,
  served,
  signed,
} from "./fake-slack";

const FILES = {
  "/files/cat.png": "png-bytes",
  "/files/report.pdf": "%PDF quarterly numbers",
};

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const held: { release?: () => void } = {};

const holdTool = defineExtension({
  name: "test-hold",
  tools: [
    defineTool({
      name: "hold",
      description: "Wait",
      parameters: obj({}),
      execute: async () => {
        await new Promise<void>((resolve) => {
          held.release = resolve;
        });
        return { output: [{ type: "text", text: "held" }] };
      },
    }),
  ],
});

const lookTool = defineExtension({
  name: "test-look",
  tools: [
    defineTool({
      name: "look",
      description: "Look at a file",
      parameters: obj({ file: str() }),
      execute: async () => ({ output: [{ type: "text", text: "seen" }] }),
    }),
  ],
});

async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Seen = { texts: string[][]; images: string[] };

function record(seen: Seen, messages: readonly Message[]): string | undefined {
  const users = messages.flatMap((each) => {
    if (each.role !== "user") return [];
    if (typeof each.content === "string") return [each.content];
    seen.images.push(
      ...each.content.flatMap((part) =>
        part.type === "image" ? [part.mimeType] : [],
      ),
    );
    return each.content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
  });
  seen.texts.push(users);
  return users.at(-1);
}

type OpenOptions = {
  respond?: (
    ...args: Parameters<FauxResponseFactory>
  ) => AssistantMessage | undefined;
  faux?: Parameters<typeof fauxProvider>[0];
  env?: HarnessOptions["env"];
  extensions?: Extension[];
  threadMessages?: ThreadMessages;
  nameThread?: NameThread;
};

async function open(options: OpenOptions = {}) {
  const slackApi = await fakeSlack(FILES);
  const slack = slackChannel({
    botToken: "xoxb-test",
    transport: httpEvents(SECRET),
    apiUrl: slackApi.apiUrl,
    filesUrl: slackApi.origin,
    threadMessages: options.threadMessages,
    nameThread: options.nameThread,
  });
  const channels = createChannels({
    channels: {
      slack: {
        adapter: slack,
        conversation: () => ({
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        }),
      },
    },
  });
  const seen: Seen = { texts: [], images: [] };
  const answer: FauxResponseFactory = (transcript, ...rest) => {
    const last = record(seen, transcript.messages);
    return (
      options.respond?.(transcript, ...rest) ??
      fauxAssistantMessage(`re: ${last}`)
    );
  };
  const faux = fauxProvider(options.faux);
  faux.setResponses(Array.from({ length: 20 }, () => answer));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(channels.extension);
  registry.install(channels.tools);
  for (const extension of options.extensions ?? []) registry.install(extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: options.env,
      settings: { progress: { partialIntervalMs: 0 } },
    },
    context,
  );
  const hub = channels.hub(harness, { env: options.env });
  const post = served(slack);
  const event = (body: Record<string, unknown>) =>
    post(signed({ type: "event_callback", team_id: "T1", event: body }));
  return { post, hub, harness, seen, event, ...slackApi };
}

const posts = (calls: Call[]) =>
  calls
    .filter(({ method }) => method === "chat.postMessage")
    .map(({ body }) => body);

const methods = (calls: Call[]) =>
  calls
    .map(({ method }) => method)
    .filter((method, index, all) => all[index - 1] !== method);

describe("slack channel end to end", () => {
  it("answers 503 before start", async () => {
    const { post, harness } = await open();
    const response = await post(signed({ type: "url_verification" }));
    expect(response.status).toBe(503);
    await harness.close(context);
  });

  it("serves no requests over Socket Mode", () => {
    const slack = slackChannel({
      botToken: "xoxb-test",
      transport: socketMode("xapp-test"),
    });
    expect(slack.fetch).toBeUndefined();
  });

  it("opens a case thread, then follows the thread: notes as context, mentions as questions", async () => {
    const { post, hub, harness, calls, seen } = await open();
    await hub.start();
    expect(calls[0]).toMatchObject({
      method: "auth.test",
      token: "Bearer xoxb-test",
    });

    const challenge = await post(
      signed({ type: "url_verification", challenge: "c-1" }),
    );
    await expect(challenge.json()).resolves.toEqual({ challenge: "c-1" });
    const forged = await post(
      signed({ type: "url_verification", challenge: "c-1" }, { secret: "x" }),
    );
    expect(forged.status).toBe(401);

    const signal = (id: string) =>
      hub.deliver("slack", {
        address: "C1:cus_acme",
        text: `payment failed ${id}`,
        requestId: `stripe:${id}`,
        author: "stripe",
      });
    const first = await signal("evt_1");
    if (first === undefined) throw new Error("case was ignored");
    await harness.waitForIdle(context);
    await signal("evt_2");
    await harness.waitForIdle(context);
    expect(posts(calls)).toEqual([
      { channel: "C1", markdown_text: "re: payment failed evt_1" },
      {
        channel: "C1",
        markdown_text: "re: payment failed evt_2",
        thread_ts: "100.000100",
      },
    ]);

    const event = (fields: Record<string, unknown>) =>
      post(
        signed({
          type: "event_callback",
          event_id: "Ev1",
          event: message({ thread_ts: "100.000100", ...fields }),
        }),
      );
    const note = await event({ ts: "300.1", text: "they emailed us" });
    const question = await event({ ts: "300.2", text: "<@UBOT> next step?" });
    const retried = await event({ ts: "300.2", text: "<@UBOT> next step?" });
    expect([note.status, question.status, retried.status]).toEqual([
      200, 200, 200,
    ]);
    await harness.waitForIdle(context);

    expect(posts(calls).slice(2)).toEqual([
      {
        channel: "C1",
        markdown_text: "re: <@UBOT> next step?",
        thread_ts: "100.000100",
      },
    ]);
    expect(seen.texts.at(-1)).toEqual([
      "payment failed evt_1",
      "payment failed evt_2",
      "they emailed us",
      "<@UBOT> next step?",
    ]);
    await expect(hub.status(first.submissionId)).resolves.toEqual({
      state: "done",
    });
    await harness.close(context);
  });

  it("answers a direct message with files, showing its tool calls as steps before the answer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-env-"));
    directories.push(cwd);
    const env = new NodeExecutionEnv({ cwd });
    const reply = "Here is what I see in the picture and the report.";
    const { hub, harness, calls, seen, event, origin } = await open({
      env: () => env,
      faux: { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
      extensions: [lookTool],
      respond: (transcript) =>
        transcript.messages.at(-1)?.role === "user"
          ? fauxAssistantMessage(
              [
                fauxText("Let me look."),
                fauxToolCall("look", { file: "report.pdf" }),
              ],
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage(reply),
    });
    await hub.start();
    const file = (name: string, mimetype: string) => ({
      id: name,
      name,
      mimetype,
      url_private: `${origin}/files/${name}`,
    });
    const response = await event(
      message({
        channel: "D1",
        channel_type: "im",
        subtype: "file_share",
        text: "what is this?",
        files: [
          file("cat.png", "image/png"),
          file("report.pdf", "application/pdf"),
        ],
      }),
    );
    expect(response.status).toBe(200);
    await harness.waitForIdle(context);

    const [text = ""] = seen.texts.at(-1) ?? [];
    const lines = text.split("\n");
    expect(lines[0]).toBe("what is this?");
    const pdf = /^Attached file (\S+) \(application\/pdf\)$/.exec(
      lines[2] ?? "",
    )?.[1];
    await expect(readFile(pdf ?? "", "utf8")).resolves.toBe(
      FILES["/files/report.pdf"],
    );
    expect(seen.images).toContain("image/png");

    const used = methods(calls).filter((method) => !method.startsWith("GET"));
    expect(used.slice(0, 3)).toEqual([
      "auth.test",
      "agents.sessions.setStatus",
      "chat.postMessage",
    ]);
    expect(used.slice(-3)).toEqual([
      "chat.update",
      "chat.postMessage",
      "agents.sessions.setStatus",
    ]);
    const body = (method: string) =>
      calls.find((call) => call.method === method)?.body;
    expect(body("agents.sessions.setStatus")).toEqual({
      channel_id: "D1",
      thread_ts: "200.000100",
      status: "processing",
      initiator_user_id: "U1",
      title: "what is this?",
    });
    const [plan, answer] = posts(calls);
    expect(plan).toMatchObject({
      channel: "D1",
      thread_ts: "200.000100",
      text: "Working…",
      blocks: [
        {
          type: "plan",
          tasks: [
            {
              title: "look report.pdf",
              details: {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "Let me look." }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const updates = calls.filter(({ method }) => method === "chat.update");
    expect(updates.at(-1)?.body).toMatchObject({
      text: "Done: 1 step",
      blocks: [{ title: "Done: 1 step", tasks: [{ status: "complete" }] }],
    });
    expect(answer).toEqual({
      channel: "D1",
      markdown_text: reply,
      thread_ts: "200.000100",
    });
    await harness.close(context);
  });

  it("names a session from the request, renames it once from the answer, and leaves a person's title alone", async () => {
    const asked: { request: string; answer: string }[] = [];
    const { hub, harness, calls, event } = await open({
      nameThread: async (input) => {
        asked.push(input);
        return "Picture: triage `cat.png`\n";
      },
    });
    await hub.start();
    const ask = (ts: string, text: string) =>
      event(
        message({
          channel: "D1",
          channel_type: "im",
          ts,
          text,
          thread_ts: "200.000100",
        }),
      );
    await event(
      message({
        channel: "D1",
        channel_type: "im",
        text: "<@UBOT>   what is   this?",
      }),
    );
    await harness.waitForIdle(context);
    await until(() =>
      calls.some(({ method }) => method === "agents.sessions.rename"),
    );
    await ask("300.1", "and that?");
    await harness.waitForIdle(context);
    await event({
      type: "agent_session_title_changed",
      channel: "D1",
      thread_ts: "200.000100",
      title: "Mine",
    });
    await ask("300.2", "one more");
    await harness.waitForIdle(context);

    const body = (method: string) =>
      calls.find((call) => call.method === method)?.body;
    expect(body("agents.sessions.setStatus")).toMatchObject({
      title: "what is this?",
    });
    expect(asked).toEqual([
      {
        request: "<@UBOT>   what is   this?",
        answer: "re: <@UBOT>   what is   this?",
      },
    ]);
    expect(
      calls
        .filter(({ method }) => method === "agents.sessions.rename")
        .map(({ body }) => body),
    ).toEqual([
      {
        channel_id: "D1",
        thread_ts: "200.000100",
        title: "Picture triage cat.png",
      },
    ]);
    await harness.close(context);
  });

  it("runs every message of a thread it belongs to, and stays quiet when the agent declines", async () => {
    const { hub, harness, calls, event } = await open({
      threadMessages: "run",
      respond: (transcript) => {
        const last = transcript.messages.at(-1);
        const quiet =
          last?.role === "user" &&
          JSON.stringify(last.content).includes("lunch");
        return quiet
          ? fauxAssistantMessage(fauxToolCall("no_reply", {}), {
              stopReason: "toolUse",
            })
          : undefined;
      },
    });
    await hub.start();
    await event(message({ text: "<@UBOT> what broke?" }));
    await harness.waitForIdle(context);
    await event(
      message({ thread_ts: "200.000100", ts: "300.1", text: "and the api?" }),
    );
    await harness.waitForIdle(context);
    await event(
      message({ thread_ts: "200.000100", ts: "300.2", text: "lunch anyone?" }),
    );
    await event(message({ thread_ts: "999.1", ts: "300.3", text: "hi" }));
    await harness.waitForIdle(context);

    expect(posts(calls).map((post) => post.markdown_text)).toEqual([
      "re: <@UBOT> what broke?",
      "re: and the api?",
    ]);
    const statuses = calls
      .filter(({ method }) => method === "agents.sessions.setStatus")
      .map(({ body }) => body.status);
    expect(statuses.slice(-2)).toEqual(["processing", "active"]);
    await harness.close(context);
  });

  it("stops the run when the user presses stop", async () => {
    const { hub, harness, calls, event } = await open({
      extensions: [holdTool],
      respond: (transcript) =>
        transcript.messages.at(-1)?.role === "user"
          ? fauxAssistantMessage(fauxToolCall("hold", {}), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage("done"),
    });
    await hub.start();
    await event(message({ channel: "D1", channel_type: "im", text: "dig in" }));
    await until(() => held.release !== undefined);
    const stopped = event({
      type: "agent_session_stopped",
      channel: "D1",
      thread_ts: "200.000100",
    });
    held.release?.();
    const response = await stopped;
    expect(response.status).toBe(200);
    await harness.waitForIdle(context);
    const statuses = () =>
      calls
        .filter(({ method }) => method === "agents.sessions.setStatus")
        .map(({ body }) => body.status);
    await until(() => statuses().length === 2);
    expect(statuses()).toEqual(["processing", "active"]);
    expect(posts(calls).map(({ markdown_text }) => markdown_text)).toEqual([
      undefined,
    ]);
    await until(() => calls.some(({ method }) => method === "chat.update"));
    const update = calls.find(({ method }) => method === "chat.update");
    expect(update?.body).toMatchObject({ text: "Stopped after 1 step" });
    await harness.close(context);
  });
});
