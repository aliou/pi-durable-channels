# pi-durable-channels

Durable messaging for [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) hosts. Connect platform messages to persistent conversations, queue or steer messages while an agent works, and send replies through durable tasks that resume after a crash.

This is a pi-durable Harness extension, not a Pi coding-agent extension. Bring an adapter for your platform; the package handles bindings, deduplication, replies, retries, and conversation-scoped messaging tools.

See [the package README](packages/channels/README.md) for installation, a complete quick start, and the adapter and hub APIs.

## Examples

The [examples guide](examples/README.md) covers setup and commands. All adapters and agents are private workspace packages; copy and adapt them for your host.

Adapters:

- [Slack](examples/channels/slack/README.md): Socket Mode or HTTP events, thread replies, status, and tool-call timelines.
- [GitHub](examples/channels/github/README.md): repository webhooks, issue and pull request comments, and run reactions.
- [Webhook](examples/channels/webhook/README.md): authenticated JSON messages and replies to allowlisted origins.

Runnable agents:

- [Generic webhook agent](examples/use-cases/generic-webhook-agent/README.md): triage incoming alerts and page when they need attention.
- [Software factory](examples/use-cases/software-factory/README.md): turn Slack requests into pull requests and triage GitHub issues.
- [Stripe churn responder](examples/use-cases/stripe-churn-responder/README.md): handle churn signals in per-customer Slack threads.

## Development

Requires Node 24+. Run from the repository root:

```sh
nix develop -c pnpm install
nix develop -c pnpm build
nix develop -c pnpm typecheck
nix develop -c pnpm test
nix develop -c pnpm lint
```

Build before typechecking; examples consume the package's generated declarations. Add a changeset with `pnpm changeset` for releasable changes.

Public packages under `packages/*` are discovered automatically for staging. Each package supplies its own manifest, README, license, changelog, and build/check/test scripts. Configure npm trusted publishing for each package; no per-package workflow entry is needed. GitHub release tags use `<package-name>@<version>`.

## License

MIT. See `LICENSE`.
