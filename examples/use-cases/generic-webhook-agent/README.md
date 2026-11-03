# generic-webhook-agent

An on-call first responder. Any system that sends webhooks (CI, error trackers, uptime monitors, GitHub) posts to one
inbox; the agent decides what is noise, what is worth a note, and what needs a person now.

## How it works

```text
service → POST /inbox?source=<name>  (any body)
  inbox.fetch (adapter.ts), mounted by index.ts
    requestId = delivery header, else sha256 of the body
    deliver({ address: source, text: headers + body })  → 202
  source conversation runs with instructions.md
    may call check_url to confirm an outage, on CHECK_URL_ORIGINS only
    answers PAGE: ..., NOTE: ..., or IGNORE
  reply → inboxChannel send → POST { text } to PAGER_URL (console when unset)
```

- **One conversation per source.** The agent sees that source's recent events, so it pages for a failing deploy of
  `main`, writes one note about a flaky job instead of three pages, and closes a page when the recovery arrives.
- **Redeliveries are deduplicated** through `X-GitHub-Delivery`, `webhook-id`, `X-Request-Id`, `Idempotency-Key`, or
  the body hash.
- **Bursts queue.** Events for a busy source wait for the current run and get their own.
- **Durable.** A crash mid-run or mid-send resumes on restart; pages carry an `Idempotency-Key` header.

The inbox does no authentication: it takes whatever webhook.site forwards, and the server listens on localhost only.
Treat every body as untrusted. Pages go to the fixed `PAGER_URL`, and `check_url` refuses origins outside
`CHECK_URL_ORIGINS` and does not follow redirects, so a crafted webhook cannot point the agent at internal services.
Configuration is in `.env.example`.

## Run with webhook.site

1. Open [webhook.site](https://webhook.site), copy its token, and point services at
   `https://webhook.site/<token>/inbox?source=github` (or `sentry`, `uptime`, ...).
2. Forward to the agent: `npx @webhooksite/cli forward --token=<token> --target=http://localhost:8787`. Path and query
   pass through.
3. Open a second webhook.site URL and set it as `PAGER_URL` in `.env` to watch pages arrive.

```sh
nix develop -c pnpm --filter @examples/generic-webhook-agent start
curl -X POST 'localhost:8787/inbox?source=github' -H 'X-GitHub-Delivery: d-1' \
  -d '{"workflow_run":{"name":"deploy","head_branch":"main","conclusion":"failure"}}'
```
