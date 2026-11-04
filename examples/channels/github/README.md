# github-channel

A GitHub adapter. Repository webhooks come in, and replies go out as issue or pull request comments. An address is an
issue or pull request, `<owner>/<repo>#<number>`; both share GitHub's number space.

```ts
import { appInstallation, githubChannel, personalToken } from "@examples/github-channel";

const auth = appInstallation({ appId, privateKey, repository: "acme/app" }); // or personalToken(token)
const github = githubChannel({ auth, webhookSecret });
const channels = createChannels({
  channels: {
    github: {
      adapter: github,
      conversation: (message) => (message.event === "issues.opened" ? { agent: triage } : undefined),
    },
  },
});
await channels.hub(harness).start(signal);
// mount github.fetch at the repository webhook's URL
```

Pull requests usually reach a conversation through binding: the tool that opens one calls
`channels.bind(tx, { channel: "github", address: "acme/app#7" }, api.conversationId)` in its commit.

## How it works

```text
hub.start → github.start({ deliver, signal })
  auth.login() → its own login, whose comments are skipped
    personalToken: GET /user
    appInstallation: GET /app with the app's JWT → <slug>[bot]
  github.fetch answers 503 before that

github.fetch(request)
  body over 5 MiB → 413; X-Hub-Signature-256 does not match → 401
  no X-GitHub-Delivery or no JSON → 400
  inboundOf({ name: X-GitHub-Event, delivery, payload }) (events.ts)
    issues.opened                       → run, event "issues.opened"
    issue_comment.created               → run
    pull_request_review.submitted       → run, with the review's line comments fetched and listed after its body
                                          (GET /repos/<owner>/<repo>/pulls/<n>/comments, those of this review)
    pull_request_review_comment.created → skipped; every line comment belongs to a review, and GitHub may
                                          deliver it after the review
    workflow_run.completed, failure     → one message per pull request, whenBusy: "steer"
    anything else, and anything by its own login or by bots → skipped
    requestId = github:<delivery>[:<pull request>]
  deliver(message, options) for each → 202
    unbound address and the factory returns undefined → ignored, still 202

send(reply)
  POST /repos/<owner>/<repo>/issues/<number>/comments, cut at 65,000 characters
```

- **Redeliveries.** GitHub resends a delivery with the same `X-GitHub-Delivery`, so a redelivery starts no second
  run. GitHub signs no timestamp; the delivery ID is the replay guard.
- **CI failures steer.** A failed workflow run joins the run that is working on the pull request, or starts one.
- **At least once.** GitHub comments take no idempotency key. A crash between GitHub accepting a comment and the send
  task recording it posts the comment again.
- **Two kinds of auth.** `appInstallation` signs a JWT with the app's private key, finds the app's installation on the
  repository, and mints installation tokens, reused until five minutes before they expire. `personalToken` sends one
  token as is. `githubApi(auth.token)` gives host code, such as tools, the same authenticated client.
- **Debugging.** `debug: true` logs every event the adapter skips.
- **Fixed origin.** API calls go to `https://api.github.com` with no redirects and a 30 s timeout. `apiUrl` exists
  for tests and GitHub Enterprise.

## Setup

1. Auth, either:
   - A GitHub App (recommended) with repository permissions Issues and Pull requests read/write, Actions read, and
     Contents read/write if the host pushes. Install it on the repository and keep its ID and private key.
   - A classic token of a separate account, with the `public_repo` scope (`repo` for private repositories). Its own
     comments are skipped, so not your own account. A fine-grained token only reaches repositories its owner owns,
     not ones where the account is a collaborator.
2. Webhooks: the app's webhook, or a repository webhook. Content type `application/json`, a secret, and the events
   Issues, Issue comment, Pull request review, and Workflow run. Use only one of them, or
   every event arrives twice under two delivery IDs.

## Tests

`test/events.test.ts` covers event mapping, addresses, and signatures. `test/auth.test.ts` covers app JWTs, the
installation lookup, and token reuse. `test/github.test.ts` runs a real harness against
a local fake GitHub API: triage of a new issue with a redelivery and an unbound pull request, and a review run once
with its line comments even when GitHub delivers the review first. `nix develop -c pnpm --filter @examples/github-channel test`.
