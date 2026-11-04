# Examples

Every directory here is a private workspace package. None of them is published.

## Channels

Adapters for `@aliou/pi-durable-channels`. Use cases import them by package name.

| Package | Directory | What it does |
| --- | --- | --- |
| `@examples/slack-channel` | `channels/slack/` | Socket Mode or HTTP events in, thread replies out |
| `@examples/github-channel` | `channels/github/` | Repository webhooks in, issue and pull request comments out |
| `@examples/webhook-channel` | `channels/webhook/` | Reference HTTP adapter: JSON webhooks in, replies posted to allowed origins |

## Use cases

Runnable agents built on the channels.

| Package | Directory | What it does |
| --- | --- | --- |
| `@examples/stripe-churn-responder` | `use-cases/stripe-churn-responder/` | Turns Stripe churn signals into per-customer case threads in Slack |
| `@examples/generic-webhook-agent` | `use-cases/generic-webhook-agent/` | On-call first responder: triages any webhook and pages when it matters |
| `@examples/software-factory` | `use-cases/software-factory/` | Coding agents: Slack requests become pull requests they follow; new issues get triaged |

`use-cases/shared/` (`@examples/shared`) holds what the use cases have in common: the runner, which serves
any HTTP adapter through `adapterRoute(adapter)`, the model loader, and the console or HTTP sink. Channel packages depend on nothing here, so each one can be copied on its own.

```sh
nix develop -c pnpm install
nix develop -c pnpm build
cp examples/use-cases/<name>/.env.example examples/use-cases/<name>/.env   # then fill it in
nix develop -c pnpm --filter @examples/<name> start
nix develop -c pnpm test
```
