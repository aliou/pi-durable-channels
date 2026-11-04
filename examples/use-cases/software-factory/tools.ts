import type { BindTarget } from "@aliou/pi-durable-channels";
import {
  type ConversationId,
  defineExtension,
  defineTool,
  type Tx,
} from "@earendil-works/pi-durable";
import { arr, compile, int, obj, str } from "@earendil-works/pi-schema";
import { type GitHubCall, issueAddress } from "@examples/github-channel";
import type { Workspace } from "./workspace";

export type Repo = { owner: string; name: string; base: string };

export type Bind = (
  tx: Tx,
  target: BindTarget,
  conversationId: ConversationId,
) => Promise<void>;

const Pull = obj({ number: int(), html_url: str() }, { open: true });
const Created = compile(Pull);
const Found = compile(arr(Pull));

function text(value: string, isError = false) {
  return { output: [{ type: "text" as const, text: value }], isError };
}

async function pullFor(
  call: GitHubCall,
  repo: Repo,
  draft: { head: string; title: string; body: string },
) {
  const path = `/repos/${repo.owner}/${repo.name}/pulls`;
  const query = new URLSearchParams({
    head: `${repo.owner}:${draft.head}`,
    state: "open",
  });
  const open = await call("GET", `${path}?${query}`);
  const [existing] = Found.check(open) ? open : [];
  if (existing !== undefined) return existing;
  const created = await call("POST", path, { ...draft, base: repo.base });
  if (!Created.check(created))
    throw new Error("GitHub returned no pull request");
  return created;
}

export function buildTools(options: {
  call: GitHubCall;
  repo: Repo;
  workspace: Workspace;
  bind: Bind;
}) {
  const { call, repo, workspace } = options;
  const openPr = defineTool({
    name: "open_pr",
    description:
      "Push your committed work and open a pull request for it, or update the one you opened. Commit everything first. " +
      "Comments, reviews, and CI failures on the pull request then reach this conversation.",
    parameters: obj({ title: str(), body: str() }),
    execute: async ({ title, body }, api, context) => {
      const id = api.conversationId;
      const changes = await workspace.changes(id);
      if (changes.uncommitted)
        return text("Commit or discard your changes first.", true);
      if (changes.commits === 0)
        return text(`No commits ahead of ${repo.base}.`, true);
      await workspace.push(id);
      const head = workspace.branch(id);
      const pull = await pullFor(call, repo, { head, title, body });
      const address = issueAddress(`${repo.owner}/${repo.name}`, pull.number);
      await api.commit(
        (tx) => options.bind(tx, { channel: "github", address }, id),
        context,
      );
      return text(`Pull request #${pull.number}: ${pull.html_url}`);
    },
  });
  return defineExtension({ name: "factory-build", tools: [openPr] });
}

export function triageTools(options: {
  call: GitHubCall;
  repo: Repo;
  labels: readonly string[];
}) {
  const { call, repo, labels } = options;
  const labelIssue = defineTool({
    name: "label_issue",
    description: `Add labels to an issue of ${repo.owner}/${repo.name}. Allowed labels: ${labels.join(", ")}`,
    parameters: obj({ issue: int(), labels: arr(str()) }),
    execute: async ({ issue, labels: added }) => {
      const unknown = added.filter((label) => !labels.includes(label));
      if (unknown.length > 0)
        return text(`Not allowed: ${unknown.join(", ")}`, true);
      const path = `/repos/${repo.owner}/${repo.name}/issues/${issue}/labels`;
      await call("POST", path, { labels: added });
      return text(`Labeled #${issue}: ${added.join(", ")}`);
    },
  });
  return defineExtension({ name: "factory-triage", tools: [labelIssue] });
}
