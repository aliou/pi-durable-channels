import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChannelReport,
  createChannels,
  type OutboundPart,
  type SendContext,
} from "@aliou/pi-durable-channels";
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
import {
  type Call,
  type FakeOptions,
  fakeSlack,
  message,
  SECRET,
  served,
  signed,
  until,
} from "../test/fake-slack";
import { SLACK_BLOCK_KIT, type SlackBlockKit } from "./block-kit";
import type { ThreadMessages } from "./events";
import type { NameThread } from "./naming";
import { slackChannel } from "./slack";
import { httpEvents, type SlackTransport, socketMode } from "./transport";

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
  transport?: SlackTransport;
  fake?: FakeOptions;
};

async function open(options: OpenOptions = {}) {
  const slackApi = await fakeSlack(FILES, options.fake);
  const slack = slackChannel({
    botToken: "xoxb-test",
    transport: options.transport ?? httpEvents(SECRET),
    apiUrl: slackApi.apiUrl,
    filesUrl: slackApi.origin,
    threadMessages: options.threadMessages,
    nameThread: options.nameThread,
  });
  const reports: ChannelReport[] = [];
  const channels = createChannels({
    channels: {
      slack: {
        adapter: slack,
        conversation: () => ({
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        }),
      },
    },
    onReport: (report) => {
      reports.push(report);
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
  const post = (request: Request) => served(slack)(request);
  const event = (body: Record<string, unknown>) =>
    post(signed({ type: "event_callback", team_id: "T1", event: body }));
  return { post, hub, harness, seen, event, reports, ...slackApi };
}

const posts = (calls: Call[]) =>
  calls
    .filter(({ method }) => method === "chat.postMessage")
    .map(({ body }) => body);

const methods = (calls: Call[]) =>
  calls
    .map(({ method }) => method)
    .filter((method, index, all) => all[index - 1] !== method);

const nativeBlock = {
  type: "section",
  text: { type: "mrkdwn", text: "*Deployment completed*" },
};

function represented(
  text: string,
  blocks: SlackBlockKit["blocks"] = [nativeBlock],
): OutboundPart {
  return {
    type: "text",
    text,
    representations: { [SLACK_BLOCK_KIT]: { blocks } },
  };
}

async function direct(
  options: { fake?: FakeOptions; nameThread?: NameThread } = {},
) {
  const api = await fakeSlack({}, options.fake);
  const slack = slackChannel({
    botToken: "xoxb-test",
    transport: httpEvents(SECRET),
    apiUrl: api.apiUrl,
    nameThread: options.nameThread,
  });
  const send = (
    parts: OutboundPart[],
    address = "D1:200.000100",
    replyContext?: SendContext["replyContext"],
  ) =>
    slack.send(
      { address, parts },
      {
        idempotencyKey: "reply:native",
        replyContext,
        signal: new AbortController().signal,
      },
    );
  return { ...api, slack, send };
}

describe("slack channel end to end", () => {
  it("answers 503 before start", async () => {
    const { post, harness } = await open();
    const response = await post(signed({ type: "url_verification" }));
    expect(response.status).toBe(503);
    await harness.close(context);
  });

  it("reports the events it skips", async () => {
    const { hub, harness, event, reports } = await open();
    await hub.start();
    await event(message({ bot_id: "B1", subtype: "bot_message" }));
    await event(message({ ts: "300.1", text: "no mention" }));
    expect(reports).toEqual([
      {
        kind: "skipped",
        channel: "slack",
        detail: "message/bot_message C1 200.000100 from a bot",
      },
      { kind: "skipped", channel: "slack", detail: "message C1 300.1" },
    ]);
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

  it("answers a direct message with files, showing its narration between its tool calls as steps before the answer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-env-"));
    directories.push(cwd);
    const env = new NodeExecutionEnv({ cwd });
    const reply = "Here is what I see in the picture and the report.";
    const { hub, harness, calls, seen, event, origin } = await open({
      env: () => env,
      faux: { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
      extensions: [lookTool],
      respond: (transcript) => {
        const looked = transcript.messages.filter(
          ({ role }) => role === "toolResult",
        ).length;
        const turns = [
          ["Let me look.", "report.pdf"],
          ["Now the picture.", "cat.png"],
        ];
        const [text, file] = turns[looked] ?? [];
        if (text === undefined || file === undefined)
          return fauxAssistantMessage(reply);
        return fauxAssistantMessage(
          [fauxText(text), fauxToolCall("look", { file })],
          { stopReason: "toolUse" },
        );
      },
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
      blocks: [{ type: "plan" }],
    });
    const updates = calls.filter(({ method }) => method === "chat.update");
    const done = updates.at(-1)?.body;
    expect(done).toMatchObject({
      text: "Done: 2 steps",
      blocks: [{ title: "Done: 2 steps" }],
    });
    const narration = (text: string) => ({
      title: text,
      status: "complete",
      hide_title: true,
      details: {
        type: "rich_text",
        elements: [
          { type: "rich_text_section", elements: [{ type: "text", text }] },
        ],
      },
    });
    const tool = (title: string) => ({ title, status: "complete" });
    const [block] = (done?.blocks ?? []) as {
      tasks: Record<string, unknown>[];
    }[];
    expect(block?.tasks.map(({ task_id: _, ...task }) => task)).toEqual([
      narration("Let me look."),
      tool("look report.pdf"),
      narration("Now the picture."),
      tool("look cat.png"),
    ]);
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

describe("slack block kit", () => {
  it("declares the format and preserves text-only posts", async () => {
    const { slack, calls, send } = await direct();
    expect(slack.formats).toEqual(["slack.block-kit"]);
    await send([{ type: "text", text: "Deployment completed." }]);
    expect(posts(calls)).toEqual([
      {
        channel: "D1",
        thread_ts: "200.000100",
        markdown_text: "Deployment completed.",
      },
    ]);
  });

  it("posts native blocks, fallback text, and thread arguments", async () => {
    const { calls, send } = await direct();
    await send([represented("Deployment completed.")]);
    expect(posts(calls)).toEqual([
      {
        channel: "D1",
        thread_ts: "200.000100",
        text: "Deployment completed.",
        blocks: [nativeBlock],
      },
    ]);
  });

  it("retains plain and represented parts in order", async () => {
    const { calls, send } = await direct();
    await send([
      represented("First."),
      { type: "text", text: "Second." },
      represented("Third."),
    ]);
    expect(posts(calls)).toEqual([
      {
        channel: "D1",
        thread_ts: "200.000100",
        text: "First.Second.Third.",
        blocks: [
          nativeBlock,
          {
            type: "section",
            text: { type: "mrkdwn", text: "Second." },
          },
          nativeBlock,
        ],
      },
    ]);
  });

  it("uses Markdown for unknown formats", async () => {
    const { calls, send } = await direct();
    await send([
      {
        type: "text",
        text: "Readable fallback.",
        representations: { "test.other": { blocks: [nativeBlock] } },
      },
      represented("Native part."),
    ]);
    expect(posts(calls)).toEqual([
      {
        channel: "D1",
        thread_ts: "200.000100",
        markdown_text: "Readable fallback.Native part.",
      },
    ]);
  });

  it("uses Markdown for a malformed representation", async () => {
    const { calls, send } = await direct();
    await send([
      {
        type: "text",
        text: "Readable fallback.",
        representations: { "slack.block-kit": { blocks: "invalid" } },
      },
    ]);
    expect(posts(calls)).toEqual([
      {
        channel: "D1",
        thread_ts: "200.000100",
        markdown_text: "Readable fallback.",
      },
    ]);
  });

  it("posts nothing for empty text with a representation", async () => {
    const { calls, send } = await direct();
    await send([represented("")]);
    expect(posts(calls)).toEqual([]);
    expect(
      calls.find(({ method }) => method === "agents.sessions.setStatus")?.body,
    ).toEqual({
      channel_id: "D1",
      thread_ts: "200.000100",
      status: "active",
    });
  });

  it.each(["invalid_blocks", "invalid_blocks_format", "msg_blocks_too_long"])(
    "posts Markdown after Slack rejects content with %s",
    async (error) => {
      const { calls, send } = await direct({ fake: { postErrors: [error] } });
      await send([represented("Deployment completed.")]);
      expect(posts(calls)).toEqual([
        {
          channel: "D1",
          thread_ts: "200.000100",
          text: "Deployment completed.",
          blocks: [nativeBlock],
        },
        {
          channel: "D1",
          thread_ts: "200.000100",
          markdown_text: "Deployment completed.",
        },
      ]);
    },
  );

  it.each([
    ["Slack error", { postErrors: ["rate_limited"] }, "failed: rate_limited"],
    ["transport error", { postStatus: 503 }, "answered 503"],
  ])("does not fall back after a %s", async (_, fake, error) => {
    const { calls, send } = await direct({ fake });
    await expect(send([represented("Deployment completed.")])).rejects.toThrow(
      error,
    );
    expect(posts(calls)).toEqual([
      {
        channel: "D1",
        thread_ts: "200.000100",
        text: "Deployment completed.",
        blocks: [nativeBlock],
      },
    ]);
  });

  it("creates a thread alias for a represented thread root", async () => {
    const { send } = await direct();
    await expect(
      send([represented("Deployment completed.")], "C1:cus_acme"),
    ).resolves.toEqual({
      addressData: { threadTs: "100.000100" },
      alias: "C1:100.000100",
    });
  });

  it("finishes plans, activates the session, and names represented replies", async () => {
    const { slack, calls, send } = await direct({
      nameThread: async () => "Deployment checked",
    });
    const target = {
      address: "D1:200.000100",
      idempotencyKey: "reply:native",
      replyContext: { user: "U1", request: "Check deployment" },
    };
    await slack.events?.(target, { type: "run_started" });
    await slack.events?.(target, {
      type: "tool_started",
      id: "deploy-1",
      name: "deploy",
      args: { service: "api" },
    });
    await send(
      [represented("Deployment completed.")],
      target.address,
      target.replyContext,
    );
    await until(() =>
      calls.some(({ method }) => method === "agents.sessions.rename"),
    );

    expect(
      calls.find(({ method }) => method === "chat.update")?.body,
    ).toMatchObject({ text: "Done: 1 step" });
    const statuses = calls
      .filter(({ method }) => method === "agents.sessions.setStatus")
      .map(({ body }) => body.status);
    expect(statuses).toEqual(["processing", "active"]);
    expect(
      calls.find(({ method }) => method === "agents.sessions.rename")?.body,
    ).toEqual({
      channel_id: "D1",
      thread_ts: "200.000100",
      title: "Deployment checked",
    });
  });
});

describe("slack socket mode", () => {
  const socket = (fake: FakeOptions = {}) =>
    open({ transport: socketMode("xapp-test"), fake });

  it("is ready once Slack says hello, and stop closes the socket", async () => {
    const {
      hub,
      harness,
      calls,
      socket: server,
    } = await socket({
      hello: false,
    });
    let ready = false;
    const starting = hub.start().then(() => {
      ready = true;
    });
    await until(() => server.log.includes("connected"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ready).toBe(false);
    server.send({ type: "hello" });
    await starting;
    expect(calls.map(({ method, token }) => [method, token])).toEqual([
      ["auth.test", "Bearer xoxb-test"],
      ["apps.connections.open", "Bearer xapp-test"],
    ]);
    await hub.stop();
    await until(() => server.log.includes("closed"));
    expect(server.log).toEqual(["connected", "closed"]);
    await harness.close(context);
  });

  it("fails to start on a bad bot token or a refused connection", async () => {
    for (const method of ["auth.test", "apps.connections.open"]) {
      const { hub, harness } = await socket({ refuse: [method] });
      await expect(hub.start()).rejects.toThrow(
        `Slack ${method} failed: invalid_auth`,
      );
      await hub.stop();
      await harness.close(context);
    }
  });

  it("acks a delivery in flight at stop before it closes the socket", async () => {
    let release: () => void = () => undefined;
    const holdFiles = new Promise<void>((resolve) => {
      release = resolve;
    });
    const {
      hub,
      harness,
      calls,
      origin,
      socket: server,
    } = await socket({
      holdFiles,
    });
    await hub.start();
    server.send({
      type: "events_api",
      envelope_id: "E1",
      payload: {
        type: "event_callback",
        event: message({
          channel: "D1",
          channel_type: "im",
          subtype: "file_share",
          text: "see attached",
          files: [
            {
              id: "F1",
              name: "report.pdf",
              mimetype: "application/pdf",
              url_private: `${origin}/files/report.pdf`,
            },
          ],
        }),
      },
    });
    await until(() =>
      calls.some(({ method }) => method === "GET /files/report.pdf"),
    );
    const stopping = hub.stop();
    release();
    await stopping;
    await until(() => server.log.includes("closed"));
    expect(server.log).toEqual(["connected", "ack E1", "closed"]);
    await expect(
      hub.conversationOf({ channel: "slack", address: "D1:200.000100" }),
    ).resolves.toBeDefined();
    await harness.waitForIdle(context);
    await harness.close(context);
  });
});
