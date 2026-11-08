# @aliou/pi-durable-channels-slack

A Slack adapter. Messages arrive over Socket Mode or the Events API. Each thread is one conversation, in channels and
DMs, and an agent session with Slack's "Working…" status, stop button, and title. While the agent works, its tool calls
and its narration between them show in a folded plan ("Done: 12 steps ›"), and the answer follows as its own message.

```sh
pnpm add @aliou/pi-durable-channels @aliou/pi-durable-channels-slack
```

```ts
import { httpEvents, slackChannel, socketMode } from "@aliou/pi-durable-channels-slack";

const slack = slackChannel({
  botToken,
  transport: socketMode(appToken),
  nameThread: async ({ request, answer }) => "Fix stale README claims", // optional, e.g. one small model call
});
// or transport: httpEvents(signingSecret), and mount slack.fetch at the Event Subscriptions URL;
// over Socket Mode the adapter has no fetch
const channels = createChannels({ channels: { slack: { adapter: slack, conversation } } });
await channels.hub(harness, { env }).start();
```

Which messages start a run:

| Where | Mentions the bot | Doesn't mention it |
| --- | --- | --- |
| DM, top level or in a thread | Runs | Runs |
| Channel thread | Runs | `threadMessages: "context"` (default): stored as context. `"run"`: runs, and the agent answers or calls `no_reply`. Only threads that already have a conversation. |
| Channel top level | Runs, and opens a thread | Skipped |

With `threadMessages: "run"`, install `channels.tools` so the agent has `no_reply`, and tell it in its instructions when
to stay quiet.

Session titles: a new session is titled with the request, mention removed, cut to 60 characters. Slack rejects titles
with characters such as `` ` `` `:` `/` `#` `@` `*` or a newline (`invalid_name`), so every title is cleaned first. With `nameThread`,
the adapter asks the host for a better title after the first answer and renames the session once. A person renaming
the session (`agent_session_title_changed`) stops that for the thread.

## Slack app setup

1. Create an app and declare it as an agent (the **Agent** tab). Sessions, streaming, and the stop button need it.
2. Bot token scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, and `files:read` for attachments.
3. Event subscriptions (bot events): `message.channels`, `message.groups`, `message.im`, `message.mpim`,
   `agent_session_stopped`, and `agent_session_title_changed`.
4. Socket Mode: enable it and create an app-level token with `connections:write` (`xapp-…`). For the Events API
   instead, set the request URL to wherever the host mounts `slack.fetch`, and use the signing secret.
5. Install the app, copy the bot token (`xoxb-…`), and invite the bot to the channels it should read.

## How it works

```text
hub.start → slack.start({ deliver, cancel, report, signal })
  auth.test → the bot's user ID; failure rejects start
  socketMode: apps.connections.open → WebSocket → resolve on hello                       (transport.ts, socket.ts)
    refused, closed, or no hello within 10 s → reject start
    disconnect frame: open a replacement and keep handling events until it has hello; then stop taking events,
      terminate once the events being handled are acked
    later drops: reconnect at once in the background, 1 s between failed attempts, failures reported as adapter_error
  httpEvents: slack.fetch accepts requests (503 before start)

hub.stop → signal aborts → each socket stops taking events and terminates once the events it is handling are acked,
           without waiting for Slack to answer a close frame
  events arriving after that are not acked; Slack resends them
  failures after the abort are not reported
  slack.stop resolves when the reconnect loop has exited

inbound event
  httpEvents: body over 1 MiB → 413; bad signature or timestamp older than 5 min → 401  (verify.ts)
              url_verification → echo the challenge
  agent_session_stopped → cancel(<channel>:<thread ts>) → the run aborts
  agent_session_title_changed → never rename that thread again (naming.ts)
  message → inboundOf(event) (events.ts)
    bot messages, edits, and subtypes other than file_share → report skipped
    top-level channel message without a mention → report skipped
    text: Slack's &amp; &lt; &gt; escapes decoded; mentions keep their <@U…> form
    address = <channel>:<thread ts, or the message ts for a new thread>
    requestId = slack:<channel>:<message ts>
    replyContext = { user, request }: the session's initiator, and the request for its title
    files = the message's Slack files
    mention or DM → deliver(message)                 run, reply in the thread
    else, by threadMessages:
      "context" (default) → deliver(message, { run: false })               context only
      "run"               → deliver(message, { run: true, create: false }) run; the agent may answer or call no_reply
      either way, threads without a conversation ignore it
  core: fetchFile(url) for each file (files.ts) → saved in the conversation's env, images inline
  socketMode: acknowledge the envelope after deliver; a failed deliver is redelivered by Slack

events(target, event) (reply.ts)
  run_started   → agents.sessions.setStatus processing, with the request as the title of a new session (session.ts)
  text          → a complete task with its title hidden and the narration as its details, before the call it explains
  tool_started  → a task in progress, titled from the tool's name and first string argument
                  the first task: chat.postMessage in the thread with a plan block titled "Working…" (plan.ts)
                  later tasks: chat.update, at most every 2 s; past 50 tasks, the middle folds into "… N more steps"
  tool_finished → the step's task complete or error
  run_ended     → failed or aborted: plan titled "Stopped after N steps" or "Failed after N steps" (N counts tool
                  calls), session active
                  (aborted) or suspended; completed: nothing, send already finished the plan

send(reply, ctx) (reply.ts)
  no text (no_reply)  → delete the plan message, set the session active; post nothing
  otherwise           → plan titled "Done: N steps", then the answer as its own message
                        steps that arrive after the reply are dropped
                        first answer in a thread, with nameThread → rename the session in the background
  address <channel>:<thread ts>  → chat.postMessage in the thread, session active
  address <channel>:<any key>    → post a thread root in the channel
    → returns { addressData: { threadTs }, alias: <channel>:<root ts> }
    later replies to the key go to the thread, and thread messages reach the same conversation
```

- **Proactive cases.** Host code delivers to `<channel>:<key>`, such as `C0123:cus_acme`. The first reply opens the
  thread, and the key keeps pointing at it. Until then there is no thread, so no plan and no session.
- **Posted, not streamed.** Steps live in a posted message that is updated, so runs longer than Slack's 10-minute
  stream limit work, and so do threads without a known recipient. A run without tool calls posts only its answer.
- **The answer is posted whole.** Text the model writes next to a tool call is narration, shown as its own
  entry between the steps, never mixed into the answer.
- **Files.** Downloads send the bot token to `https://files.slack.com` only, with no redirects, a 30 s timeout, and a
  50 MiB limit (`maxFileBytes`). Files shared from Google Drive and similar stay links in the text.
- **Fixed origins.** API calls go to `https://slack.com/api` with no redirects and a 30 s timeout. `apiUrl` and
  `filesUrl` exist for tests.
- **At least once.** A crash between Slack accepting a post and the send task recording it posts again on restart. A
  crash mid-run leaves the plan message as it was, and the reply posts in full.
- **Long answers.** Text is cut at Slack's 12,000-character `markdown_text` limit.
- **Reports, not logs.** The adapter writes nothing to the console. Each event it skips reaches the host's `onReport`
  as `skipped`, with a one-line description. Failed status, plan, naming, and Socket Mode calls arrive as
  `adapter_error`, with the thread's address when there is one.

## Tests

`src/` holds the adapter with its tests colocated: event mapping, signature checks, and address parsing (`events.test.ts`), file downloads
(`files.test.ts`), and through a real harness against a local fake Slack API (`slack.test.ts`): a case thread, a DM
with an image and a PDF saved in the conversation's environment, its narration and tool calls as plan tasks, and the answer after them,
session naming and a person's rename, a thread where the agent declines with `no_reply`, and the stop button.
Socket Mode runs against a local WebSocket server: `start` waits for `hello`, a bad bot token or a refused
`apps.connections.open` rejects it, and an event in flight at stop is acked before the socket closes.
`socket.test.ts` drives the connection on its own: a socket that closes before `hello` or sends none in time rejects
`start`, events being handled are acked before the socket closes at stop, stop does not wait on a server that ignores
close frames, a `disconnect` opens the replacement before the old socket closes, an unexpected drop reconnects at once,
and nothing is reported once stopped.
`nix develop -c pnpm --filter @aliou/pi-durable-channels-slack test`.
