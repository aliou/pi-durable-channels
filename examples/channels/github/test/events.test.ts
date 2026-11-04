import { describe, expect, it } from "vitest";
import { issueAddress, parseIssueAddress } from "../address";
import { inboundOf } from "../events";
import { verifyGitHubSignature } from "../verify";
import { BOT, payloads, SECRET, webhook } from "./fake-github";

const event = (name: string, payload: unknown) =>
  inboundOf({ name, delivery: "d1", payload }, BOT);

describe("github events", () => {
  it("opens issues with their event, title, link, and body", () => {
    expect(event("issues", payloads.issueOpened(3))).toEqual([
      {
        message: {
          address: "acme/app#3",
          text: "Issue #3 opened by @ana: Crash on save\nhttps://github.com/acme/app/issues/3\nSteps: save twice.",
          requestId: "github:d1",
          author: "ana",
          event: "issues.opened",
          replyContext: { reactions: "/repos/acme/app/issues/3/reactions" },
        },
        options: {},
      },
    ]);
    expect(
      event("issues", { ...payloads.issueOpened(3), action: "closed" }),
    ).toEqual([]);
  });

  it("runs on comments and reviews, and leaves line comments to their review", () => {
    expect(event("issue_comment", payloads.comment(7, "why?"))).toMatchObject([
      {
        message: {
          address: "acme/app#7",
          text: "@ana commented on pull request #7:\nwhy?\nhttps://github.com/acme/app/pull/7#c",
          event: "issue_comment.created",
          replyContext: {
            reactions: "/repos/acme/app/issues/comments/507/reactions",
          },
        },
        options: {},
      },
    ]);
    expect(
      event(
        "pull_request_review",
        payloads.review(7, "CHANGES_REQUESTED", null),
      ),
    ).toEqual([
      {
        message: expect.objectContaining({
          text: "@ana reviewed pull request #7: changes requested\nhttps://github.com/acme/app/pull/7#v",
        }),
        options: {},
        review: {
          comments:
            "/repos/acme/app/pulls/7/comments?sort=created&direction=desc&per_page=100",
          id: 907,
        },
      },
    ]);
    expect(
      event("pull_request_review_comment", payloads.reviewComment(7, "rename")),
    ).toEqual([]);
  });

  it("skips its own comments and other bots", () => {
    expect(event("issue_comment", payloads.comment(7, "done", BOT))).toEqual(
      [],
    );
    const bot = payloads.comment(7, "deployed");
    bot.comment.user.type = "Bot";
    expect(event("issue_comment", bot)).toEqual([]);
    const opened = payloads.issueOpened(3);
    opened.issue.user.type = "Bot";
    expect(event("issues", opened)).toEqual([]);
  });

  it("steers every pull request of a failed workflow run", () => {
    const steered = event("workflow_run", payloads.workflowFailed([7, 8]));
    expect(steered.map(({ message }) => message.requestId)).toEqual([
      "github:d1:7",
      "github:d1:8",
    ]);
    expect(steered[0]).toMatchObject({
      message: {
        address: "acme/app#7",
        text: 'CI failed: workflow "ci" on factory/abc.\nhttps://github.com/acme/app/actions/runs/1',
        author: "github-actions",
      },
      options: { whenBusy: "steer" },
    });
    const passed = payloads.workflowFailed([7]);
    passed.workflow_run.conclusion = "success";
    expect(event("workflow_run", passed)).toEqual([]);
  });

  it("ignores unknown events and malformed payloads", () => {
    expect(event("push", {})).toEqual([]);
    expect(event("issues", { action: "opened" })).toEqual([]);
    expect(event("constructor", {})).toEqual([]);
  });
});

describe("github addresses and signatures", () => {
  it("parses addresses it builds and rejects others", () => {
    expect(parseIssueAddress(issueAddress("acme/app", 7))).toEqual({
      owner: "acme",
      repo: "app",
      number: 7,
    });
    expect(() => parseIssueAddress("acme/app/../x#7")).toThrow();
    expect(() => parseIssueAddress("acme#7")).toThrow();
  });

  it("checks the body's HMAC", async () => {
    const request = webhook("ping", { zen: "hi" });
    const body = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    expect(verifyGitHubSignature(SECRET, signature, body)).toBe(true);
    expect(verifyGitHubSignature("other", signature, body)).toBe(false);
    expect(verifyGitHubSignature(SECRET, null, body)).toBe(false);
    expect(verifyGitHubSignature(SECRET, signature, `${body} `)).toBe(false);
  });
});
