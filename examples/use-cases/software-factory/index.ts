import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  httpEvents,
  slackChannel,
  socketMode,
} from "@aliou/pi-durable-channels-slack";
import {
  appInstallation,
  githubApi,
  githubChannel,
  personalToken,
} from "@examples/github-channel";
import { activityLog, logged, logReport } from "@examples/shared/log";
import { loadModel } from "@examples/shared/model";
import { adapterRoute, run } from "@examples/shared/run";
import { softwareFactory } from "./src/factory";
import { threadNamer } from "./src/naming";
import { factoryReplies } from "./src/replies";
import { createWorkspace } from "./src/workspace";

const env = process.env;

function secret(name: string): string | undefined {
  const value = env[name];
  delete env[name];
  return value === "" ? undefined : value;
}

const botToken = secret("SLACK_BOT_TOKEN");
const appToken = secret("SLACK_APP_TOKEN");
const signingSecret = secret("SLACK_SIGNING_SECRET");
const token = secret("GITHUB_TOKEN");
const appId = env.GITHUB_APP_ID;
const keyPath = secret("GITHUB_APP_PRIVATE_KEY_PATH");
const webhookSecret = secret("GITHUB_WEBHOOK_SECRET");
const [owner, name] = (env.GITHUB_REPO ?? "").split("/");

async function githubAuth() {
  if (appId && keyPath) {
    const privateKey = await readFile(keyPath, "utf8");
    const repository = `${owner}/${name}`;
    return appInstallation({ appId, privateKey, repository });
  }
  return token === undefined ? undefined : personalToken(token);
}

function slackTransport() {
  if (appToken !== undefined) return socketMode(appToken);
  if (signingSecret !== undefined) return httpEvents(signingSecret);
  return undefined;
}

const transport = slackTransport();
const auth = await githubAuth();
if (!botToken || !transport || !auth || !webhookSecret || !owner || !name) {
  throw new Error(
    "Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN or SLACK_SIGNING_SECRET, GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, and GITHUB_REPO (see .env.example)",
  );
}

const base = env.BASE_BRANCH || "main";
const repo = { owner, name, base };
const instructions = async (file: string) => {
  const text = await readFile(new URL(file, import.meta.url), "utf8");
  return `${text}\nRepository: ${owner}/${name}, base branch ${base}.`;
};

const workspace = createWorkspace({
  root: join(env.DATA_DIR ?? join("tmp", "software-factory"), "workspace"),
  remote: env.REPO_URL || `https://github.com/${owner}/${name}.git`,
  base,
  token: auth.token,
  author: {
    name: env.FACTORY_GIT_NAME || "pi factory",
    email: env.FACTORY_GIT_EMAIL || "factory@example.com",
  },
});
await workspace.prepare();

const { models, model } = loadModel(
  () => "Scripted model: set MODEL to a real model to build or triage.",
);
const slack = slackChannel({
  botToken,
  transport,
  threadMessages: "run",
  nameThread: threadNamer(
    models,
    model,
    await readFile(new URL("title.md", import.meta.url), "utf8"),
  ),
});
const github = githubChannel({ auth, webhookSecret });
const factory = softwareFactory({
  slack: logged("slack", factoryReplies(slack, `${owner}/${name}`)),
  github: logged("github", github),
  observers: [activityLog],
  onReport: logReport,
  call: githubApi(auth.token),
  repo,
  workspace,
  model,
  instructions: {
    build: await instructions("build.md"),
    triage: await instructions("triage.md"),
  },
  labels: (env.TRIAGE_LABELS ?? "bug,cannot-reproduce,needs-info,question")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== ""),
});

await run({
  name: "software-factory",
  channels: factory.channels,
  models,
  extensions: factory.extensions,
  env: workspace.env,
  routes: {
    ...(transport.kind === "http"
      ? { "POST /slack/events": adapterRoute(slack) }
      : {}),
    "POST /github/webhook": adapterRoute(github),
  },
});
