# slack-channel

A Slack adapter. Messages arrive over Socket Mode or the Events API; replies go out with `chat.postMessage` as
Markdown. Each thread is one conversation.

```ts
import { httpEvents, slackChannel, socketMode } from "@examples/slack-channel";

const slack = slackChannel({ botToken, transport: socketMode(appToken) });
// or transport: httpEvents(signingSecret), and mount slack.fetch at the Event Subscriptions URL
const channels = createChannels({ channels: { slack: { adapter: slack, conversation } } });
await channels.hub(harness).start(signal);
```

## How it works

```text
hub.start → slack.start
  auth.test → the bot's user ID
  socketMode: apps.connections.open → WebSocket; reconnects until the signal aborts
  httpEvents: slack.fetch accepts requests (503 before start)

inbound (socket.ts or slack.fetch)
  httpEvents: body over 1 MiB → 413; bad signature or timestamp older than 5 min → 401
              url_verification → echo the challenge
  event_callback → inboundOf(event) (events.ts)
    bot messages, edits, and other subtypes → skip
    top-level message without a mention → skip
    address = <channel>:<thread ts, or the message ts for a top-level mention>
    requestId = slack:<channel>:<message ts>
    mention → deliver(message)                 run, reply in the thread
    else    → deliver(message, { run: false }) context only; ignored for unbound threads
  socketMode: acknowledge the envelope after deliver; a failed deliver is redelivered by Slack

send(reply, ctx)
  address <channel>:<thread ts>  → post in the thread
  address <channel>:<any key>    → post a thread root in the channel
    → returns { addressData: { threadTs }, alias: <channel>:<root ts> }
    later replies to the key go to the thread, and thread messages reach the same conversation
```

- **Proactive cases.** Host code delivers to `<channel>:<key>`, such as `C0123:cus_acme`. The first reply opens the
  thread, and the key keeps pointing at it.
- **Fixed origin.** Calls go to `https://slack.com/api` with no redirects and a 30 s timeout. `apiUrl` exists for
  tests.
- **At least once.** A crash between Slack accepting a post and the send task recording it posts again on restart.
- **Long answers.** Text is cut at Slack's 12,000-character `markdown_text` limit.

## Tests

`slack.test.ts` covers event mapping, signature checks, address parsing, and a case thread through a real harness
against a local fake Slack API: `nix develop -c pnpm --filter @examples/slack-channel test`. Socket Mode has no automated test.
