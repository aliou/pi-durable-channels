# software-factory

Coding agents that take work from Slack and see it through on GitHub. Mention the bot in a Slack thread with a
change request: an agent makes the change in its own git worktree, opens a pull request, and follows the pull request's
comments, reviews, and CI failures. New GitHub issues get a triage agent that tries to reproduce them, labels them,
and comments.

```text
Slack mention → slack channel → new conversation, build persona (build.md)
  env: git worktree per conversation, branch factory/<conversation id>     (workspace.ts)
  bash, read, write, edit in the worktree; git commit
  open_pr({ title, body })                                                  (tools.ts)
    uncommitted changes or no commits → error for the model
    workspace.push → git push with a fresh installation token (or the token), fast-forward only
    GET open pull request for the branch, else POST /pulls
    channels.bind(tx, github: <owner>/<repo>#<number>) in the tool's commit
  reply → Slack thread

GitHub webhook → github channel
  comment or review on the bound pull request → same conversation, queued → reply as a PR comment
  failed workflow run on it                   → same conversation, steers the current run
  pull request the factory did not open       → ignored
  issues.opened → new conversation, triage persona (triage.md)
    own worktree of the base branch; bash to reproduce
    label_issue({ issue, labels }), labels from TRIAGE_LABELS
    reply → issue comment; later comments on the issue reach it too
```

- **One conversation, two channels.** The Slack thread and the pull request share a conversation, so the agent keeps
  the request, its work, and the review in one context. It answers each message on the channel it came from and can
  reach the thread with `send_message`.
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

1. Set up a Slack app as the [Slack channel README](../../channels/slack/README.md#slack-app-setup) describes.
2. Set up GitHub auth and a webhook as the [GitHub channel README](../../channels/github/README.md#setup) describes;
   the factory pushes, so the app needs Contents read/write. Point the webhook at `/github/webhook`; for a local run,
   forward it with a tunnel or `gh webhook forward`.
3. Copy `.env.example` to `.env` and fill it in.

```sh
nix develop -c pnpm --filter @examples/software-factory start
```

Mention the bot in a channel with a change request, then review the pull request it opens. Open an issue to see the
triage agent.

## Tests

`test/factory.test.ts` runs the factory against a local bare repository and a fake GitHub API, with a recording Slack
adapter and a scripted model: a Slack request that commits, pushes, opens a pull request, and gets a review comment on
it, and the triage of a new issue. `nix develop -c pnpm --filter @examples/software-factory test`.
