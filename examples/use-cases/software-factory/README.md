# software-factory

A coding agent takes work from Slack and GitHub and sees it through in one conversation. Mention the bot in a Slack
thread with a change request: the agent makes the change in its own git worktree, opens a pull request, and follows
comments, reviews, and CI failures. New GitHub issues get reproduced, labeled, and answered. Human-opened pull requests
also start conversations. New GitHub issues and pull requests post an alert to `SLACK_ALERT_CHANNEL_ID`; the resulting
Slack thread joins the same conversation.

```text
Slack mention → slack channel → new conversation
  env: git worktree per conversation, branch factory/<conversation id>     (workspace.ts)
  bash, read, write, edit in the worktree; git commit
  open_pr({ title, body })                                                  (tools.ts)
    uncommitted changes or no commits → error for the model
    workspace.push → git push with a fresh installation token (or the token), fast-forward only
    GET open pull request for the branch, else POST /pulls
    channels.bind(tx, github: <owner>/<repo>#<number>) in the tool's commit
  reply → Slack thread

GitHub webhook → github channel
  issues.opened or pull_request.opened → new conversation
    channels.bind(tx, slack: <alert channel>/<issue address>)
    channels.send(tx, ...) → durable alert, Slack thread alias joins the conversation
  issues.opened → bash to reproduce in the worktree
    label_issue({ labels }), labels from TRIAGE_LABELS and current issue from the conversation binding
  comment or review on a bound pull request → same conversation, queued → reply as a PR comment
  failed workflow run on it                → same conversation, steers the current run
```

One agent handles every source. `index.ts` joins `instructions/role.md`, `build.md`, `triage.md`, and `review.md` in
that order and appends the repository and base branch.

- **One conversation, two channels.** Slack threads and GitHub issues or pull requests share a conversation, so the
  agent keeps the request, its work, and the review in one context. It answers each message on the channel it came
  from and can reach another bound thread with `send_message`. GitHub alert tasks are admitted with the conversation,
  retain their idempotency keys on retry, and bind the Slack thread returned by the alert post.
- **Native Slack replies.** `factoryReplies` adds Block Kit with a Software factory header, the agent's answer, and repository context. The answer remains the required text fallback, and Slack content rejections fall back to Markdown through the channel adapter.
- **Tokens stay in the host.** The agent's tools never see the GitHub token or the app's private key. Pushes run in the host with a credential
  helper that gives the token only to the remote's host, and with git hooks off. The entry point removes the Slack and
  GitHub secrets from `process.env` before tools run, so `bash` does not inherit them.
- **Not a sandbox.** Worktrees run with the local `NodeExecutionEnv`: `bash` can read any file the host can,
  `.env` and the model provider's key included. Run the factory in a container or VM, or return a sandboxed
  `ExecutionEnv` from `workspace.env`.
- **Thread titles.** New sessions take the request as their title. After the first answer, one small call to the same
  model names the thread, guided by `title.md`. Rename it yourself and the factory leaves it.
- **Scratch files.** The prompt names the worktree and asks the agent to keep scratch files in its `scratch/` folder,
  which git ignores. Nothing enforces it; see "Not a sandbox".
- **Logs.** Every delivery and its conversation, every send, each model response, and each tool call with its result
  go to stdout, tagged `[slack]`, `[github]`, or `[c<conversation id>]`. Events the channels skip go to stderr.
- **Restarts.** Worktrees and the clone live under `DATA_DIR/workspace` next to the session database, and a
  conversation finds its worktree again after a restart.

## Try it

1. Set up a Slack app as the [Slack channel README](../../../packages/slack/README.md#slack-app-setup) describes.
2. Set up GitHub auth and a webhook as the [GitHub channel README](../../channels/github/README.md#setup) describes;
   the factory pushes, so the app needs Contents read/write. Point the webhook at `/github/webhook`; for a local run,
   forward it with a tunnel or `gh webhook forward`.
3. Copy `.env.example` to `.env` and fill it in.

```sh
nix develop -c pnpm --filter @examples/software-factory start
```

Mention the bot in a channel with a change request, then review the pull request it opens. Open an issue or pull
request on GitHub to see its Slack alert thread and the agent's response.

## Tests

`src/factory.test.ts` runs the factory against a local bare repository and a fake GitHub API, with a recording Slack
adapter and a scripted model. It covers Slack builds, issue triage, durable alert binding and webhook redelivery,
human-opened pull requests, and refusal to label without a bound issue.
`nix develop -c pnpm --filter @examples/software-factory test`.
