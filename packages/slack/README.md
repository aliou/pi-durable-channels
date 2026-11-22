# @aliou/pi-durable-channels-slack

A Slack adapter for durable conversations. Messages arrive over Socket Mode or the Events API. Runtime configuration chooses whether a Slack thread or an entire Slack conversation shares one core conversation, which messages trigger runs, and how much Slack history the agent can read. Replies include Slack agent-session status, stop and title handling, and a folded plan of tool calls and narration.

```sh
pnpm add @aliou/pi-durable-channels @aliou/pi-durable-channels-slack
```

```ts
import { httpEvents, slackChannel, socketMode } from "@aliou/pi-durable-channels-slack";

const slack = slackChannel({
  botToken,
  transport: socketMode(appToken),
  config: async (target) => ({
    scope: target.conversationType === "im" ? "conversation" : "thread",
    trigger:
      target.conversationType === "im" || target.threadTs !== undefined
        ? "every_message"
        : "mention",
    context: { maxMessages: 30, maxBytes: 30_000, maxFiles: 10 },
    readTool: true,
  }),
  nameThread: async ({ request, answer }) => "Fix stale README claims",
});
```

Use `httpEvents(signingSecret)` instead of `socketMode(appToken)` for HTTP events and mount `slack.fetch` at the Event Subscriptions URL. Socket Mode adapters have no `fetch`. Register the adapter with `createChannels`, install the channel extensions, and start the hub as described in the core package README.

## Runtime configuration

`config(target)` is required and may be asynchronous. It runs for every accepted inbound message and every history-tool read. The target contains:

- `teamId` and `teamName` from the Events API envelope and `auth.test`.
- `conversationId`, optional `conversationName`, and `conversationType` (`channel`, `group`, `im`, or `mpim`). Slack conversations include public and private channels, DMs, and group DMs.
- `threadTs` from the event, or from a thread address during a history read. It is `undefined` for a top-level message.
- `userId` of the inbound author. It is `undefined` for history-tool authorization because the core history interface has no acting Slack user. Configure `readTool` at conversation level.

Key application configuration by `teamId` and `conversationId`. Names are descriptive and can change; do not use them as persistence keys. Configuration failures reject inbound handling before durable admission so Slack can retry. History configuration failures become tool errors.

The adapter calls `config` on the event path and does not cache its result. An application may cache configuration in memory or an external store, but must invalidate entries when configuration changes and bound stale entries. Updates to `trigger`, context limits, and `readTool` affect subsequent operations. A `scope` update affects only addresses without an exact binding; an existing Slack address never moves silently to another core conversation.

Conversation metadata has a separate bounded adapter cache keyed by team and conversation ID. A metadata failure leaves `conversationName` undefined when the event supplies its type, reports the problem, and is retried on a later event.

### Scope and reply routing

| Scope | Slack location | Core address | `conversationAddress` |
| --- | --- | --- | --- |
| `thread` | Top-level message | `<conversationId>:<messageTs>` | None |
| `thread` | Thread message | `<conversationId>:<threadTs>` | None |
| `conversation` | Top-level message | `<conversationId>` | None |
| `conversation` | Thread message | `<conversationId>:<threadTs>` | `<conversationId>` |

Each Slack timeline has its own admission cursor, even when several timelines share durable agent state. An inbound answer and its run presentation use the triggering message as their Slack thread. Stop and title actions on a thread alias affect the shared core conversation.

A proactive send to a bare conversation ID posts at top level and does not acquire a persistent reply thread. A keyed address such as `C0123:cus_acme` retains its keyed behavior: the first reply creates a thread, stores its timestamp, and binds the real Slack thread as an alias.

### Triggers and history batches

`trigger: "every_message"` delivers every accepted message directly. Out-of-order events still run, and their address cursor never moves backward.

`trigger: "mention"` acknowledges non-mention messages without core delivery. A later mention performs one bounded `conversations.history` or `conversations.replies` read after the address cursor and before the triggering timestamp, then admits the retained history and trigger as one batch. Bot posts and unsupported subtypes are omitted. If that read fails or exceeds its short deadline, the trigger is admitted alone with a header saying earlier history was unavailable. Durable admission still precedes acknowledgement.

The `context` limits apply to each history read:

- `maxMessages` retains the latest messages in the window.
- `maxBytes` bounds UTF-8 formatted history.
- `maxFiles` bounds attachments admitted with a mention batch.

The formatted batch reports omissions. A repeated or already-admitted trigger does not admit another batch.

With `readTool: true` and `channels.tools` installed, the model can call `read_history` for an owned Slack address. The adapter applies the same source selection, filtering, formatting, and bounds without delivering messages or advancing the admission cursor. The core also enforces its output limit.

## Slack app setup

1. Create an app and declare it as an agent on the **Agent** tab. Sessions, streaming, and the stop button need it.
2. Grant bot token scopes `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, and `mpim:read`. Add `files:read` for attachments.
3. Subscribe to bot events `message.channels`, `message.groups`, `message.im`, and `message.mpim`. Add `agent_session_stopped` and `agent_session_title_changed` for stop and title handling.
4. For Socket Mode, enable it and create an app-level token with `connections:write` (`xapp-…`). For HTTP events, set the request URL to the host's mounted `slack.fetch` route and use the signing secret.
5. Install the app, copy the bot token (`xoxb-…`), and invite the bot to the channels it should read.

Supplying both `appId` and `configToken` enables startup validation through `apps.manifest.export`. The configuration token needs `app_configurations:read`. Missing required message events or scopes reject startup; missing stop or title events produce a warning. Without these credentials the adapter skips manifest validation and never infers missing subscriptions from event silence.

## Diagnostics

`auth.test` failures reject startup. Runtime Slack permission, membership, and metadata failures reach the host's `onReport` as `adapter_error`, with the affected address when known. Errors identify the Slack method and failure code; retained OAuth scope headers are available on Slack API errors.

For `missing_scope`, `not_in_channel`, and `channel_not_found`, the adapter also makes a best-effort short post in the affected Slack conversation with the required remedy. Notices are deduplicated by target, method, and issue. They are adapter-owned: they never become inbound messages, durable transcript entries, or model input, and they do not replace the agent's durable answer. A notice failure is reported separately. Missing `chat:write` cannot produce a channel notice.

## Presentation and delivery

A new session is titled with the request, mention removed, cut to 60 characters. Slack rejects characters such as `` ` `` `:` `/` `#` `@` `*` and newlines in titles, so titles are cleaned first. With `nameThread`, the adapter asks the host for a title after the first answer and renames the session once. A person renaming the session stops automatic naming for that thread.

```text
inbound event
  verify transport and parse the complete event envelope
  resolve conversation metadata and live application configuration
  choose scope address and trigger
  read the address binding and admission cursor in its adapter lane
  every_message → deliver directly with a monotonic cursor
  mention → read bounded earlier history, then deliver history plus trigger
  core admits durably → acknowledge Slack

events(target, event)
  run_started → agents.sessions.setStatus processing
  text → narration step before the tool call it explains
  tool_started / tool_finished → create or update a folded plan
  run_ended failed or aborted → finish the plan and update session status

send(reply, ctx)
  empty answer → discard the plan, set the session active, and post nothing
  otherwise → finish the plan and post the complete answer in the resolved Slack thread
```

Tool-call plans post once and update at most every two seconds. Long runs do not depend on Slack streaming. A run without tool calls posts only its answer. Text next to a tool call is narration, not part of the final answer.

Files download only from `https://files.slack.com`, without redirects, with a 30-second timeout and a 50 MiB default limit (`maxFileBytes`). API calls use `https://slack.com/api`, no redirects, and a 30-second timeout. `apiUrl` and `filesUrl` support tests. Answers are cut at Slack's 12,000-character `markdown_text` limit.

Outbound sends are at least once. A crash after Slack accepts a post but before the send task records it can post again after restart. HTTP bodies over 1 MiB return 413; invalid signatures and timestamps older than five minutes return 401.

## Block Kit replies

The adapter declares `SLACK_BLOCK_KIT` (`slack.block-kit`) and exports the `SlackBlockKit` representation type. Supply native Block Kit alongside required readable fallback text on an outbound part:

```ts
const part: OutboundPart = {
  type: "text",
  text: "Deployment completed for api.",
  representations: {
    [SLACK_BLOCK_KIT]: {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Deployment completed* for api." },
        },
      ],
    },
  },
};
```

A represented reply uses top-level `text` and `blocks`; text-only replies use `markdown_text`. Mixed replies preserve part order and convert plain-text parts to `mrkdwn` sections. Unknown formats and malformed representations use the complete Markdown message.

If Slack answers `invalid_blocks`, `invalid_blocks_format`, or `msg_blocks_too_long`, the adapter posts the complete Markdown message once. Other errors throw for durable retries. Block Kit delivery is display-only; interaction events are not admitted.

## Tests

Run from the repository root after building the core package:

```sh
pnpm --filter @aliou/pi-durable-channels-slack test
```

Tests cover event mapping, signatures, address parsing, file downloads, bounded Slack history, both scopes and triggers, runtime configuration changes and failures, out-of-order cursors, cross-thread replies, history authorization, diagnostics and notices, Block Kit fallback, session presentation, and Socket Mode lifecycle through a real Harness and local fake Slack services.
