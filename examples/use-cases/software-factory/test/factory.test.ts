import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ChannelAdapter,
  OutboundMessage,
} from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import {
  githubApi,
  githubChannel,
  personalToken,
} from "@examples/github-channel";
import {
  type Call,
  fakeGitHub,
  payloads,
  SECRET,
  webhook,
} from "@examples/github-channel/test/fake-github";
import { afterEach, describe, expect, it } from "vitest";
import { softwareFactory } from "../factory";
import { createWorkspace } from "../workspace";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
};

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function origin(root: string): Promise<string> {
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  await git(root, "init", "-q", "--bare", "-b", "main", bare);
  await git(root, "init", "-q", "-b", "main", seed);
  await writeFile(join(seed, "save.ts"), "export const save = () => 1;\n");
  await git(seed, "add", ".");
  await git(
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  await git(seed, "push", "-q", bare, "main");
  return bare;
}

const PULL = { number: 7, html_url: "https://github.com/acme/app/pull/7" };

const turn = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function open() {
  const root = await mkdtemp(join(tmpdir(), "factory-"));
  directories.push(root);
  const remote = await origin(root);
  const api = await fakeGitHub({
    "GET /repos/acme/app/pulls": (_body, calls) => ({
      status: 200,
      body: calls.some(({ method }) => method === "POST") ? [PULL] : [],
    }),
    "POST /repos/acme/app/pulls": () => ({ status: 201, body: PULL }),
  });
  const slackPosts: OutboundMessage[] = [];
  const slack: ChannelAdapter = {
    send: async (message) => {
      slackPosts.push(message);
    },
  };
  const github = githubChannel({
    auth: personalToken("ghp-test", api.apiUrl),
    webhookSecret: SECRET,
    apiUrl: api.apiUrl,
  });
  const workspace = createWorkspace({
    root: join(root, "workspace"),
    remote,
    base: "main",
    author: { name: "factory", email: "factory@example.com" },
  });
  await workspace.prepare();
  const factory = softwareFactory({
    slack,
    github,
    call: githubApi(async () => "ghp-test", api.apiUrl),
    repo: { owner: "acme", name: "app", base: "main" },
    workspace,
    model: { provider: "faux", modelId: "faux-1" },
    instructions: { build: "build", triage: "triage" },
    labels: ["bug", "cannot-reproduce"],
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(factory.channels.extension);
  registry.install(factory.channels.tools);
  for (const extension of factory.extensions) registry.install(extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: workspace.env },
    context,
  );
  const hub = factory.channels.hub(harness, { env: workspace.env });
  await hub.start();
  return { faux, harness, hub, github, slackPosts, remote, ...api };
}

const comments = (calls: Call[]) =>
  calls
    .filter(({ path }) => /\/issues\/\d+\/comments$/.test(path))
    .map(({ path, body }) => ({ path, body }));

const textOf = (message: OutboundMessage | undefined) =>
  message?.parts.map((part) => part.text).join("");

describe("software factory", () => {
  it("builds from a Slack thread, opens a pull request, and follows it", async () => {
    const { faux, harness, hub, github, slackPosts, remote, calls } =
      await open();
    faux.setResponses([
      turn("bash", {
        command:
          "echo 'export const save = () => 2;' > save.ts && git commit -qam 'Fix save'",
      }),
      turn("open_pr", { title: "Fix save", body: "Saves return 2." }),
      fauxAssistantMessage("Opened https://github.com/acme/app/pull/7"),
      fauxAssistantMessage("Renamed as asked."),
    ]);

    const asked = await hub.deliver("slack", {
      address: "C1:100.000100",
      text: "<@UBOT> make save return 2",
      requestId: "slack:C1:100.000100",
      author: "U1",
    });
    expect(asked).toBeDefined();
    await harness.waitForIdle(context);

    const branches = await git(remote, "branch", "--list", "factory/*");
    const branch = branches.replace("*", "").trim();
    const saved = await git(remote, "show", `${branch}:save.ts`);
    expect(saved).toBe("export const save = () => 2;");
    expect(calls.find(({ method }) => method === "POST")).toMatchObject({
      path: "/repos/acme/app/pulls",
      body: { title: "Fix save", head: branch, base: "main" },
    });
    expect(textOf(slackPosts[0])).toBe(
      "Opened https://github.com/acme/app/pull/7",
    );

    await github.fetch(
      webhook("issue_comment", payloads.comment(7, "please rename")),
    );
    await github.fetch(webhook("issue_comment", payloads.comment(99, "hi")));
    await harness.waitForIdle(context);
    expect(comments(calls)).toEqual([
      {
        path: "/repos/acme/app/issues/7/comments",
        body: { body: "Renamed as asked." },
      },
    ]);
    expect(slackPosts).toHaveLength(1);
    await harness.close(context);
  });

  it("triages a new issue in its own worktree and labels it", async () => {
    const { faux, harness, github, calls } = await open();
    faux.setResponses([
      turn("bash", { command: "cat save.ts" }),
      turn("label_issue", { issue: 3, labels: ["cannot-reproduce"] }),
      fauxAssistantMessage("Could not reproduce: save returns 1."),
    ]);
    await github.fetch(webhook("issues", payloads.issueOpened(3)));
    await harness.waitForIdle(context);
    expect(calls.filter(({ method }) => method === "POST")).toEqual([
      expect.objectContaining({
        path: "/repos/acme/app/issues/3/labels",
        body: { labels: ["cannot-reproduce"] },
      }),
      expect.objectContaining({
        path: "/repos/acme/app/issues/3/comments",
        body: { body: "Could not reproduce: save returns 1." },
      }),
    ]);
    await harness.close(context);
  });
});
