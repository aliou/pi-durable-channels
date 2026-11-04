import type {
  DeliverOptions,
  InboundMessage,
} from "@aliou/pi-durable-channels";
import {
  arr,
  compile,
  int,
  lit,
  nullable,
  obj,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import { issueAddress } from "./address";

const User = obj({ login: str(), type: opt(str()) }, { open: true });
const Repository = obj({ full_name: str() }, { open: true });
const Text = opt(nullable(str()));

const IssueOpened = compile(
  obj(
    {
      action: lit("opened"),
      issue: obj(
        {
          number: int(),
          title: str(),
          body: Text,
          html_url: str(),
          user: User,
        },
        { open: true },
      ),
      repository: Repository,
    },
    { open: true },
  ),
);

const IssueComment = compile(
  obj(
    {
      action: lit("created"),
      issue: obj(
        { number: int(), pull_request: opt(unknown()) },
        { open: true },
      ),
      comment: obj(
        { body: str(), html_url: str(), user: User },
        { open: true },
      ),
      repository: Repository,
    },
    { open: true },
  ),
);

const Review = compile(
  obj(
    {
      action: lit("submitted"),
      pull_request: obj({ number: int() }, { open: true }),
      review: obj(
        { id: int(), body: Text, state: str(), html_url: str(), user: User },
        { open: true },
      ),
      repository: Repository,
    },
    { open: true },
  ),
);

const WorkflowRun = compile(
  obj(
    {
      action: lit("completed"),
      workflow_run: obj(
        {
          name: str(),
          conclusion: opt(nullable(str())),
          head_branch: opt(nullable(str())),
          html_url: str(),
          pull_requests: arr(obj({ number: int() }, { open: true })),
        },
        { open: true },
      ),
      repository: Repository,
    },
    { open: true },
  ),
);

export type GitHubEvent = { name: string; delivery: string; payload: unknown };

export type GitHubInbound = {
  message: InboundMessage;
  options: DeliverOptions;
  review?: { comments: string; id: number };
};

type Source = { requestId: string; self: string };

type Handler = (payload: unknown, source: Source) => GitHubInbound[];

function human(user: Static<typeof User>, self: string): boolean {
  return user.login !== self && user.type !== "Bot";
}

function lines(...parts: (string | null | undefined)[]): string {
  return parts.filter((part) => (part ?? "") !== "").join("\n");
}

const issues: Handler = (payload, { requestId, self }) => {
  if (!IssueOpened.check(payload)) return [];
  const { issue } = payload;
  if (!human(issue.user, self)) return [];
  const text = lines(
    `Issue #${issue.number} opened by @${issue.user.login}: ${issue.title}`,
    issue.html_url,
    issue.body,
  );
  const message = {
    address: issueAddress(payload.repository.full_name, issue.number),
    text,
    requestId,
    author: issue.user.login,
    event: "issues.opened",
  };
  return [{ message, options: {} }];
};

const issueComment: Handler = (payload, { requestId, self }) => {
  if (!IssueComment.check(payload)) return [];
  const { issue, comment } = payload;
  if (!human(comment.user, self)) return [];
  const kind = issue.pull_request === undefined ? "issue" : "pull request";
  const message = {
    address: issueAddress(payload.repository.full_name, issue.number),
    text: lines(
      `@${comment.user.login} commented on ${kind} #${issue.number}:`,
      comment.body,
      comment.html_url,
    ),
    requestId,
    author: comment.user.login,
    event: "issue_comment.created",
  };
  return [{ message, options: {} }];
};

const review: Handler = (payload, { requestId, self }) => {
  if (!Review.check(payload)) return [];
  const { pull_request: pull, review: submitted } = payload;
  if (!human(submitted.user, self)) return [];
  const state = submitted.state.toLowerCase().replace("_", " ");
  const message = {
    address: issueAddress(payload.repository.full_name, pull.number),
    text: lines(
      `@${submitted.user.login} reviewed pull request #${pull.number}: ${state}`,
      submitted.body,
      submitted.html_url,
    ),
    requestId,
    author: submitted.user.login,
    event: "pull_request_review.submitted",
  };
  const pulls = `/repos/${payload.repository.full_name}/pulls/${pull.number}`;
  const comments = `${pulls}/comments?sort=created&direction=desc&per_page=100`;
  return [{ message, options: {}, review: { comments, id: submitted.id } }];
};

const workflowRun: Handler = (payload, { requestId }) => {
  if (!WorkflowRun.check(payload)) return [];
  const run = payload.workflow_run;
  if (run.conclusion !== "failure") return [];
  const branch = run.head_branch ?? "unknown branch";
  return run.pull_requests.map((pull) => ({
    message: {
      address: issueAddress(payload.repository.full_name, pull.number),
      text: lines(
        `CI failed: workflow "${run.name}" on ${branch}.`,
        run.html_url,
      ),
      requestId: `${requestId}:${pull.number}`,
      author: "github-actions",
      event: "workflow_run.completed",
    },
    options: { whenBusy: "steer" },
  }));
};

const HANDLERS: Readonly<Record<string, Handler>> = {
  issues,
  issue_comment: issueComment,
  pull_request_review: review,
  workflow_run: workflowRun,
};

export function inboundOf(event: GitHubEvent, self: string): GitHubInbound[] {
  if (!Object.hasOwn(HANDLERS, event.name)) return [];
  const source = { requestId: `github:${event.delivery}`, self };
  return HANDLERS[event.name](event.payload, source);
}
