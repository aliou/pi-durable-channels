# slack-channel

A Slack adapter. Messages arrive over Socket Mode or the Events API. Replies stream into the thread as an agent
session, with Slack's "Working…" status and stop button. Each thread is one conversation, in channels and DMs.

```ts
import { httpEvents, slackChannel, socketMode } from "@examples/slack-channel";

const slack = slackChannel({ botToken, transport: socketMode(appToken) });
// or transport: httpEvents(signingSecret), and mount slack.fetch at the Event Subscriptions URL
const channels = createChannels({ channels: { slack: { adapter: slack, conversation } } });
await channels.hub(harness, { env }).start(signal);
```

## Slack app setup

1. Create an app and declare it as an agent (the **Agent** tab). Sessions, streaming, and the stop button need it.
2. Bot token scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, and `files:read` for attachments.
3. Event subscriptions (bot events): `message.channels`, `message.groups`, `message.im`, `message.mpim`, and
   `agent_session_stopped`.
4. Socket Mode: enable it and create an app-level token with `connections:write` (`xapp-…`). For the Events API
   instead, set the request URL to wherever the host mounts `slack.fetch`, and use the signing secret.
5. Install the app, copy the bot token (`xoxb-…`), and invite the bot to the channels it should read.

## How it works

```text
hub.start → slack.start({ deliver, cancel, signal })
  auth.test → the bot's user ID
  socketMode: apps.connections.open → WebSocket; reconnects until the signal aborts      (transport.ts, socket.ts)
  httpEvents: slack.fetch accepts requests (503 before start)

inbound event
  httpEvents: body over 1 MiB → 413; bad signature or timestamp older than 5 min → 401  (verify.ts)
              url_verification → echo the challenge
  agent_session_stopped → cancel(<channel>:<thread ts>) → the run aborts
  message → inboundOf(event) (events.ts)
    bot messages, edits, and subtypes other than file_share → skip
    top-level channel message without a mention → skip
    address = <channel>:<thread ts, or the message ts for a new thread>
    requestId = slack:<channel>:<message ts>
    replyContext = { user, team }, the stream's recipient
    files = the message's Slack files
    mention or DM → deliver(message)                 run, reply in the thread
    else          → deliver(message, { run: false }) context only; ignored for unbound threads
  core: fetchFile(url) for each file (files.ts) → saved in the conversation's env, images inline
  socketMode: acknowledge the envelope after deliver; a failed deliver is redelivered by Slack

progress(target, update) (reply.ts)
  working → agents.sessions.setStatus processing (session.ts)
  text    → chat.startStream, then chat.appendStream with the new text (stream.ts)
  stopped → chat.stopStream, agents.sessions.setStatus active (aborted) or suspended (failed)

send(reply, ctx) (reply.ts)
  a stream exists for ctx.idempotencyKey → chat.stopStream with the rest of the answer
  address <channel>:<thread ts>  → chat.postMessage in the thread, session active
  address <channel>:<any key>    → post a thread root in the channel
    → returns { addressData: { threadTs }, alias: <channel>:<root ts> }
    later replies to the key go to the thread, and thread messages reach the same conversation
```

- **Proactive cases.** Host code delivers to `<channel>:<key>`, such as `C0123:cus_acme`. The first reply opens the
  thread, and the key keeps pointing at it. Proactive deliveries have no recipient, so their replies post instead of
  streaming.
- **Streaming in channels.** Slack needs the recipient's user and team to stream outside DMs. Both come from the event
  that asked.
- **Files.** Downloads send the bot token to `https://files.slack.com` only, with no redirects, a 30 s timeout, and a
  50 MiB limit (`maxFileBytes`). Files shared from Google Drive and similar stay links in the text.
- **Fixed origins.** API calls go to `https://slack.com/api` with no redirects and a 30 s timeout. `apiUrl` and
  `filesUrl` exist for tests.
- **At least once.** A crash between Slack accepting a post and the send task recording it posts again on restart. A
  crash mid-stream leaves the partial stream for Slack to finalize, and the reply posts in full.
- **Long answers.** Text is cut at Slack's 12,000-character `markdown_text` limit.
- **Debugging.** `debug: true` logs every event the adapter skips. Failed status and stream calls always log.

## Tests

`test/` covers event mapping, signature checks, and address parsing (`events.test.ts`), file downloads
(`files.test.ts`), and through a real harness against a local fake Slack API (`slack.test.ts`): a case thread, a DM
with an image and a PDF saved in the conversation's environment and a streamed reply, and the stop button.
`nix develop -c pnpm --filter @examples/slack-channel test`. Socket Mode has no automated test.
