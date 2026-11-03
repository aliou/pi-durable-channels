---
name: writing-channel-adapters
description: Write a channel adapter for @aliou/pi-durable-channels, which connects a messaging platform (Slack, email, Discord, webhooks, files) to durable pi-durable conversations. Use when creating or reviewing an adapter, wiring a channel into a host, or binding platform addresses to conversations from application code.
---

# Writing channel adapters

An adapter connects one platform to the channels core. The core owns conversations, deduplication, busy handling, replies, and retries. The adapter owns the transport, the platform's auth, and the address format.

## Contract

```ts
type ChannelAdapter = {
  start?(ctx: { deliver: Deliver; signal: AbortSignal }): void | Promise<void>;
  send(message: OutboundMessage, ctx: SendContext): Promise<SendResult | undefined | void>;
};
```

- `start` runs once from `hub.start(signal)`. Open sockets, watchers, or pollers here and stop them when `signal` aborts. An HTTP adapter keeps `deliver` and exposes its own `fetch(request): Promise<Response>` for the host to mount; answer 503 until `start` ran.
- `deliver(message, { whenBusy?, run? })` admits one inbound message. It resolves to a receipt, or to `undefined` when no conversation takes the address. `run: false` stores the message as context without a run or a reply, and never creates a conversation.
- `send` posts one outbound message: a reply, or a `send_message` notification. Throwing retries it with backoff and the same `idempotencyKey`.
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
const hub = channels.hub(harness);
await hub.start(signal);
```

`conversation` is optional. Without it, only addresses bound by application code reach a conversation. Bind from a tool in its own commit:

```ts
await api.commit((tx) => channels.bind(tx, { channel: "github", address: "acme/app#42" }, api.conversationId), context);
```

Host code uses `hub.bind(target, conversationId)`. An address belongs to one conversation; binding it to another throws.

## Messages

- `address`: the platform's conversation identity, such as `<channel>:<thread ts>`. Pick a format the adapter can parse back in `send`.
- `requestId`: the platform's stable ID for this message, so redeliveries are ignored. Use the event or message ID, or a delivery header. Fall back to a hash of the body. Never use a timestamp of receipt.
- `author`: who wrote it, from the verified payload.
- `addressData`: per-address data `send` needs later, such as a callback URL. It is stored on the binding and replaced by the next delivery that carries it, so only send it when it changes.
- `replyContext`: per-message data the reply needs, such as a reply URL. It is not stored on the binding.

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

- `deliver` returns once the message is durable. Acknowledge the platform after that, so a crash before the acknowledgement makes the platform redeliver; `requestId` drops the duplicate. Platforms with short deadlines (Slack: 3 seconds) are fine because `deliver` only commits.
- Sends are at least once. A crash after the platform accepted a post but before the task recorded it posts again with the same `idempotencyKey`. Pass the key to platforms that accept one. Otherwise accept the rare duplicate, or look for an earlier post carrying the key before posting.
- `send` has no permanent failure path: every throw retries until the attempts run out. Return without posting for content you choose not to send.
- Drop the platform's echoes of your own posts in the adapter, such as bot messages.

## Testing

Test through a real `Harness` with `MemoryStorage` and the faux provider from `@earendil-works/pi-ai`. Point the adapter's API base URL at a local `node:http` server that records calls, call `hub.start()`, feed signed requests to the adapter's `fetch`, and assert on the recorded posts after `harness.waitForIdle(context)`. Unit-test the pure parts (event mapping, signature checks, address parsing) directly.
