---
name: writing-channel-adapters
description: Write a channel adapter for @aliou/pi-durable-channels, which connects a messaging platform (Slack, email, Discord, webhooks, files) to durable pi-durable conversations. Use when creating or reviewing an adapter, wiring a channel into a host, or binding platform addresses to conversations from application code.
---

# Writing channel adapters

An adapter connects one platform to the channels core. The core owns conversations, deduplication, busy handling, replies, and retries. The adapter owns the transport, the platform's auth, and the address format.

## Contract

```ts
type ChannelAdapter = {
  start?(ctx: {
    deliver: Deliver;
    cancel(address: string): Promise<void>;
    report(report: AdapterReport): void;
    signal: AbortSignal;
  }): void | Promise<void>;
  stop?(): Promise<void>;
  fetch?(request: Request): Promise<Response>;
  send(message: OutboundMessage, ctx: SendContext): Promise<SendResult | undefined | void>;
  progress?(target: ReplyTarget, update: ReplyProgress): void | Promise<void>;
  fetchFile?(url: string): Promise<Uint8Array>;
};
```

- `start` runs once from `hub.start()`. Open sockets, watchers, or pollers here, and resolve once they are ready: `hub.start()` resolves when every adapter's `start` does, and rejects when one rejects, so fail it on bad credentials. `stop` runs from `hub.stop()` after deliveries in flight are stored and `signal` has aborted; resolve it once the transport is closed. Use `signal` to cancel calls in flight. An HTTP adapter keeps `deliver` and implements `fetch`, the one HTTP entry point a host mounts for any adapter; answer 503 until `start` ran. Socket and polling adapters leave `fetch` out.
- `deliver(message, { whenBusy?, run?, create? })` admits one inbound message. It resolves to a receipt, or to `undefined` when no conversation takes the address. `run: false` stores the message as context without a run or a reply, and never creates a conversation. `create: false` runs the message only on an address that already has a conversation; use it for chatter the agent may join but should never start a conversation from.
- `send` posts one outbound message: a reply, or a `send_message` notification. Throwing retries it with backoff and the same `idempotencyKey`. A reply with no parts means the run chose not to answer (`no_reply`): post nothing, and clear any typing indicator, stream, or session status.
- `cancel(address)` stops the run of the conversation bound to `address`, as `hub.cancel` does. Map a platform stop button to it.
- `progress` reports a reply while the model works on it: `{ type: "working" }` when the run starts, `{ type: "step", step }` for each tool call (`{ id, title, status: "in_progress" | "complete" | "error", details? }`, where `details` is the text the model wrote before the call), and `{ type: "stopped", reason }` when the run fails or is aborted. Use it for typing indicators, session status, or a progress timeline. The answer's text is never streamed: text written before a tool call is narration, not the answer, and `send` delivers the answer whole. `target.idempotencyKey` equals the `idempotencyKey` the reply's `send` gets, so `send` can finish what progress opened instead of posting separately. A step can arrive after `send`; drop it. Progress is best effort: errors are reported as `adapter_error`, nothing is stored, and after a crash `send` still posts the full answer.
- `report` hands the host a `{ kind: "skipped", detail }` for a platform event that maps to no message, or a `{ kind: "adapter_error", address?, error }` for a failure outside `send`, such as a dropped socket. The hub adds the channel and passes it to `onReport`. Never write to the console; the host decides what to log. `send` failures need no report: the core reports them as `send_retry` and `send_failed`.
- `fetchFile` downloads a file a message listed in `files`, with the platform's credentials. Check the URL's host before sending a token.
- `send` may return `{ addressData?, alias? }`. `addressData` replaces the stored data of the address it sent to. `alias` binds another address of the same channel to the same conversation. Use both when the first post creates the real thread, as Slack does.

Host wiring:

```ts
const channels = createChannels({
  channels: {
    slack: { adapter: slack, conversation: (message) => ({ agent: { model, instructions } }) },
  },
});
registry.install(channels.extension);
registry.install(channels.tools);
const hub = channels.hub(harness, { env });
await hub.start();
```

`env` is the same environment builder the host passes to `Harness.open`. Without it, attachments are named to the model but not saved.

`conversation` is optional and receives the message and `{ channel }`, so one factory can serve every channel. Without it, only addresses bound by application code reach a conversation. Bind from a tool in its own commit:

```ts
await api.commit((tx) => channels.bind(tx, { channel: "github", address: "acme/app#42" }, api.conversationId), context);
```

Host code uses `hub.bind(target, conversationId)`, and reads bindings with `hub.addresses(conversationId)` and `hub.conversationOf(key)`. An address belongs to one conversation; binding it to another throws.

## Messages

- `address`: the platform's conversation identity, such as `<channel>:<thread ts>`. Pick a format the adapter can parse back in `send`.
- `requestId`: the platform's stable ID for this message, so redeliveries are ignored. Use the event or message ID, or a delivery header. Fall back to a hash of the body. Never use a timestamp of receipt.
- `author`: who wrote it, from the verified payload.
- `event`: the platform's event type, such as `issues.opened`. The conversation factory reads it to decide whether the message opens a conversation and with which agent. It is not stored.
- `addressData`: per-address data `send` needs later, such as a callback URL. It is stored on the binding and replaced by the next delivery that carries it, so only send it when it changes.
- `replyContext`: per-message data the reply needs, such as a reply URL or the recipient of a stream. It is not stored on the binding, and `progress` gets it too.
- `files`: attachments as `{ name, mimeType, url }`. Before admitting the message, the core downloads each through `fetchFile`, saves it in the conversation's environment under `.channels/attachments/<hash>/`, and lists its path after the text, so the agent's tools can open it. PNG, JPEG, GIF, and WebP images within pi-durable's image limit also reach the model inline. A file that fails to download or save is named with the reason.

The tools extension shows the model only the addresses bound to its own conversation, so personas stay isolated.

## Security checklist

- Verify every inbound request before parsing it: signature over the raw body, a constant-time comparison, and a timestamp window when the platform signs one.
- Cap the body size before reading it fully.
- Take identity from verified fields, never from free text.
- Call platform APIs at fixed origins. When a URL comes from a payload, check it against an operator-configured allowlist, at inbound and again in `send`.
- Use `redirect: "error"` and a timeout on every outbound request. Discard response bodies you don't need.
- Keep URLs and tokens out of error messages; errors end up in task records and reports.
- Treat message text as untrusted input to the model.

## Delivery semantics

- `deliver` returns once the message is durable. Acknowledge the platform after that, so a crash before the acknowledgement makes the platform redeliver; `requestId` drops the duplicate. `deliver` only commits, unless the message has files: it downloads them first, which can exceed short acknowledgement deadlines (Slack: 3 seconds). The platform then redelivers, and `requestId` drops the duplicate.
- Sends are at least once. A crash after the platform accepted a post but before the task recorded it posts again with the same `idempotencyKey`. Pass the key to platforms that accept one. Otherwise accept the rare duplicate, or look for an earlier post carrying the key before posting.
- `send` has no permanent failure path: every throw retries until the attempts run out. Return without posting for content you choose not to send.
- Drop the platform's echoes of your own posts in the adapter, such as bot messages.

## Testing

Test through a real `Harness` with `MemoryStorage` and the faux provider from `@earendil-works/pi-ai`. Point the adapter's API base URL at a local `node:http` server that records calls, call `hub.start()`, feed signed requests to the adapter's `fetch`, and assert on the recorded posts after `harness.waitForIdle(context)`. Unit-test the pure parts (event mapping, signature checks, address parsing) directly.
