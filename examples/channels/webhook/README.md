# webhook-channel

A reference channel adapter: JSON messages in over HTTP, replies posted back to URLs the sender names. Copy it as a
starting point for an HTTP adapter.

```ts
import { bearerToken, webhook } from "@examples/webhook-channel";

const web = webhook({
  verify: bearerToken(token),
  allowedOrigins: ["https://hooks.example.com", "https://*.preview.example.com"],
});
const channels = createChannels({ channels: { web: { adapter: web, conversation } } });
await channels.hub(harness).start();
// mount web.fetch on any path of the host's server
```

## How it works

```text
hub.start → web.start keeps deliver; web.fetch answers 503 before that

web.fetch(request)
  read the raw body; over maxBodyBytes (1 MiB) → 413
  verify(request, rawBody); false → 401
  parse and validate the JSON body → 400 on failure
  replyUrl / callbackUrl outside allowedOrigins → 400
  deliver({ address, text, requestId, author, replyContext: { replyUrl }, addressData: { callbackUrl } })
  → 202 { submissionId, conversationId }          stored, not yet answered
  → 202 { ignored: true }                          no conversation takes the address

send(reply, ctx)
  url = replyContext.replyUrl, else addressData.callbackUrl
  url outside allowedOrigins → throw (no request)
  POST { address, text }  Idempotency-Key: <ctx.idempotencyKey>
    no redirects, timeoutMs (30 s), response body discarded
  network error or non-2xx → throw; the core retries with the same key
```

- **`verify` is required.** It receives the request and the exact raw body, so it can check an HMAC signature, a
  bearer token, or a header set by a proxy in front. `bearerToken(token)` is a constant-time bearer check that refuses tokens under 16 characters.
- **`allowedOrigins` is required.** Entries are origins such as `https://hooks.example.com` or
  `http://localhost:8793`: scheme, host, and port must match exactly. A leading `*.` label matches exactly one
  subdomain label (`https://*.preview.example.com` matches `pr-1.preview.example.com`, not `preview.example.com` or
  `a.b.preview.example.com`) and needs at least two labels after it. URLs with credentials never match.
- **Checked twice.** Inbound URLs are checked before anything is stored, and `send` checks again, which covers
  `addressData` a host passes to `hub.deliver` and origins removed since.
- **No URLs in errors.** Reply URLs may carry tokens; error messages name only the status.

## Inbound body

| Field | Required | Meaning |
| --- | --- | --- |
| `address` | yes | Conversation address. The same address always reaches the same conversation. |
| `text` | yes | Message text. |
| `requestId` | yes | Event ID. A retry with the same ID returns the original receipt and starts no second run. |
| `author` | yes | Sender name, stored with the message. |
| `replyUrl` | no | Where the reply to this message is posted. |
| `callbackUrl` | no | Stable URL for this address. Used for replies without a `replyUrl` and for `send_message`. Kept until replaced. |

## Receivers must deduplicate

Delivery is at least once. A crash after a receiver accepted a reply, but before the sender recorded it, sends the same
reply again with the same `Idempotency-Key`. Store the keys you processed and ignore repeats. Keys look like
`reply:<entry>` for replies and `notify:<task>` for `send_message`; treat them as opaque strings.

## Tests

`webhook.test.ts` covers `fetch`, `send`, origin matching, and a run through a real harness:
`nix develop -c pnpm --filter @examples/webhook-channel test`.
