import { createChannels } from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { personalToken } from "../auth";
import { githubChannel } from "../github";
import {
  type Call,
  fakeGitHub,
  payloads,
  served,
  webhook,
} from "./fake-github";

const MODEL = { provider: "faux", modelId: "faux-1" };

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((each) => {
    if (each.role !== "user") return [];
    if (typeof each.content === "string") return [each.content];
    return each.content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
  });
}

async function open(routes: Parameters<typeof fakeGitHub>[0] = {}) {
  const api = await fakeGitHub(routes);
  const github = githubChannel({
    auth: personalToken("ghp-test", api.apiUrl),
    webhookSecret: "github-webhook-secret",
    apiUrl: api.apiUrl,
  });
  const channels = createChannels({
    channels: {
      github: {
        adapter: github,
        conversation: (message) =>
          message.event === "issues.opened"
            ? { agent: { model: MODEL, instructions: "triage" } }
            : undefined,
      },
    },
  });
  const seen: string[][] = [];
  const faux = fauxProvider();
  faux.setResponses(
    Array.from(
      { length: 10 },
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
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    context,
  );
  const hub = channels.hub(harness);
  return { github: served(github), hub, harness, seen, ...api };
}

const comments = (calls: Call[]) =>
  calls
    .filter(
      ({ method, path }) => method === "POST" && path.endsWith("/comments"),
    )
    .map(({ path, body }) => ({ path, body }));

describe("github channel end to end", () => {
  it("answers 503 before start and 401 for a bad signature", async () => {
    const { github, hub, harness } = await open();
    const early = await github(webhook("ping", {}));
    expect(early.status).toBe(503);
    await hub.start();
    const forged = await github(webhook("ping", {}, { secret: "other" }));
    expect(forged.status).toBe(401);
    await harness.close(context);
  });

  it("triages a new issue, follows its comments, and ignores unbound pull requests", async () => {
    const { github, hub, harness, calls, seen } = await open();
    await hub.start();
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/user",
      token: "Bearer ghp-test",
    });

    const opened = webhook("issues", payloads.issueOpened(3), {
      delivery: "d1",
    });
    const redelivered = webhook("issues", payloads.issueOpened(3), {
      delivery: "d1",
    });
    const unbound = webhook("issue_comment", payloads.comment(9, "hi"));
    const statuses: number[] = [];
    for (const request of [opened, redelivered, unbound]) {
      const response = await github(request);
      statuses.push(response.status);
    }
    expect(statuses).toEqual([202, 202, 202]);
    await harness.waitForIdle(context);

    await github(webhook("issue_comment", payloads.comment(3, "still broken")));
    await harness.waitForIdle(context);

    expect(comments(calls)).toEqual([
      { path: "/repos/acme/app/issues/3/comments", body: { body: "answer 1" } },
      { path: "/repos/acme/app/issues/3/comments", body: { body: "answer 2" } },
    ]);
    expect(seen.at(-1)?.at(-1)).toBe(
      "@ana commented on pull request #3:\nstill broken\nhttps://github.com/acme/app/pull/3#c",
    );
    await harness.close(context);
  });

  it("runs a review once with its line comments, whatever order GitHub delivers them in", async () => {
    const { github, hub, harness, calls, seen } = await open({
      "GET /repos/acme/app/pulls/5/comments": () => ({
        status: 200,
        body: [
          {
            pull_request_review_id: 905,
            path: "README.md",
            line: null,
            original_line: 3,
            body: "typo",
          },
          {
            pull_request_review_id: 905,
            path: "src/save.ts",
            line: 12,
            body: "rename",
          },
          {
            pull_request_review_id: 1,
            path: "README.md",
            line: 9,
            body: "from an older review",
          },
        ],
      }),
    });
    await hub.start();
    await github(webhook("issues", payloads.issueOpened(5)));
    await harness.waitForIdle(context);
    await github(
      webhook(
        "pull_request_review",
        payloads.review(5, "CHANGES_REQUESTED", "see notes"),
      ),
    );
    await github(
      webhook(
        "pull_request_review_comment",
        payloads.reviewComment(5, "rename"),
      ),
    );
    await harness.waitForIdle(context);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.at(-1)).toBe(
      "@ana reviewed pull request #5: changes requested\nsee notes\nhttps://github.com/acme/app/pull/5#v\nsrc/save.ts:12: rename\nREADME.md:3: typo",
    );
    expect(comments(calls)).toHaveLength(2);
    await harness.close(context);
  });
});
