# pi-durable-channels

Platform messages in, durable pi-durable conversations out. Each channel address (a thread, a channel, a DM) maps to
one persistent conversation. Inbound messages are stored before they are acknowledged, busy conversations queue or
steer them, and replies go out through durable tasks that survive crashes.

`packages/channels` (`@aliou/pi-durable-channels`) holds the adapter contract, `createChannels`, the hub, the send
task, and model tools. It has no transport of its own: adapters bring HTTP, sockets, or pollers. The skill
`skills/writing-channel-adapters/SKILL.md` covers writing adapters. `examples/channels/` has Slack, GitHub, and
webhook adapters, and `examples/use-cases/` has three agents built on them, all as private workspace packages.

Requires `@earendil-works/pi-durable` 1.5.0.

## Usage

```ts
import { createChannels } from "@aliou/pi-durable-channels";

const channels = createChannels({
  channels: {
    slack: { adapter: slack, conversation: (message) => ({ agent: { model, instructions } }) },
    github: { adapter: github },
  },
});
registry.install(channels.extension);
registry.install(channels.tools);
const harness = await Harness.open(storage, { models, registry }, context);
const hub = channels.hub(harness);
await hub.start(signal);
```

- **Channels are names.** Each conversation's persona comes from its own config, so several personas share one
  harness without extra setup.
- **`conversation` is optional.** With it, a message to an unknown address creates a conversation, or is ignored when
  it returns `undefined`. It can pick the agent from the message's `event`, such as `issues.opened`. Without it, only
  bound addresses reach a conversation.
- **Binding.** Application code attaches an address to any conversation: `hub.bind(target, conversationId)` from the
  host, or `channels.bind(tx, target, api.conversationId)` inside a tool's commit, for example after opening a pull
  request.

## How a message flows

```text
adapter (socket event, HTTP request, file)   verify, parse
  deliver(message, { whenBusy?, run? })      serialized per address
    commit: unknown address → conversation(message) → create conversation, bind the address
    files → adapter.fetchFile(url) → save in the conversation's env → paths after the text, images inline
    commit: conversation.submit(tx, input as a channel.message entry, or a channel.note write when run is false)
  → { submissionId, conversationId }, or undefined when no conversation takes the address

conversation runs (queue or steer, model, tools)
  progress watcher (adapters with progress)
    run starts → progress(target, working); each tool call → progress(target, step); failure or abort → stopped
  afterRun hook
    one channels.send task per channel.message entry in the run
      adapter.send(reply, { replyContext, addressData, idempotencyKey: reply:<entry> })
        returns { addressData?, alias? } → stored on the address, alias bound to the same conversation
      failure → sleep with backoff → retry → terminal failed after the last attempt
```

- **Busy policy.** `whenBusy: "queue"` (default) gives a message its own run after the current one. `"steer"` joins
  the current run. Set the default on `createChannels`, override per `deliver`.
- **Context only.** `run: false` stores a message for the next run without starting one. It never creates a
  conversation.
- **Bound addresses only.** `create: false` runs a message only when its address already has a conversation, such as
  a thread message the agent may or may not need to answer.
- **Retries.** A repeated `requestId` returns the original receipt and starts no run.
- **At-least-once sends.** A crash after the platform accepted a send can repeat it with the same `idempotencyKey`.
- **Address data vs reply context.** `addressData` is durable per address (kept until replaced). `replyContext` is
  per message, used only for that message's reply.

## Adapters

```ts
type ChannelAdapter = {
  start?(ctx: { deliver; cancel; signal }): void | Promise<void>;
  send(message, ctx): Promise<{ addressData?; alias? } | undefined | void>;
  progress?(target, update): void | Promise<void>;
  fetchFile?(url): Promise<Uint8Array>;
};
```

`start` opens the adapter's inbound transport and keeps `deliver` and `cancel`. HTTP adapters expose a
`fetch(request)` the host mounts. `progress` drives typing indicators, session status, or a timeline of tool calls. `fetchFile`
downloads attachments with the platform's credentials; the hub saves them in the conversation's environment, so pass
the host's `env` builder: `channels.hub(harness, { env })`. Read the skill in `skills/` before writing one; it covers the security checklist, acknowledgement order, and
testing.

## Hub

| Method | Effect |
| --- | --- |
| `start(signal?)` | Start every adapter with a `deliver` and `cancel` bound to its channel, and watch runs for `progress` |
| `deliver(channel, message, options?)` | Admit a message; resolves once it is stored |
| `bind(target, conversationId)` | Attach an address to a conversation |
| `status(submissionId)` | `queued`, `running`, `sending`, `done`, `aborted`, `failed`, or `blocked` |
| `cancel(key)` | Stop the run, its sends, and notifications; withdraw queued messages |
| `clear(key)` | Cancel, then start a fresh context in the same conversation |
| `compact(key)` | Compact the conversation |
| `end(key)` | Cancel, then unbind every address of the conversation; the next message starts a new one |

## Model tools

`channels.tools` adds `send_message({ channel, address, text })`, which sends a background notification,
`list_addresses()`, and `no_reply()`, plus a prompt section listing addresses. `send_message` and `list_addresses` only
see the addresses bound to the calling conversation. `no_reply` ends the run without an answer: the reply goes out with
no parts, so adapters post nothing and clear their typing or session state.

## Development

```sh
nix develop -c pnpm install
nix develop -c pnpm build
nix develop -c pnpm typecheck
nix develop -c pnpm test
nix develop -c pnpm lint
```

`typecheck` reads the core package's build output, so build first.
