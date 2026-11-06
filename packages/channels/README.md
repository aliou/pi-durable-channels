# @aliou/pi-durable-channels

Durable messaging for [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) hosts. Platform messages become persistent conversations; replies run as durable tasks that survive crashes.

This is a pi-durable Harness extension, not a Pi coding-agent extension. Adapters bring HTTP, socket, or polling transports. The package owns address bindings, inbound deduplication, queue and steer policies, replies, retries, and conversation-scoped messaging tools.

## Install

Requires Node 24+ and pi-durable 1.5.0. Hosts using the example below also import pi-ai and Chord directly:

```sh
pnpm add @aliou/pi-durable-channels @earendil-works/pi-durable@1.5.0 @earendil-works/pi-ai@1.5.0 @earendil-works/chord@1.5.0
```

## Quick start

This complete example uses an in-memory store, a scripted model, and an adapter that prints replies. Save it as `demo.mjs` and run `node demo.mjs`; it needs no platform credentials or model API key.

```js
import { createChannels } from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("Hello from pi-durable.")]);
const models = createModels();
models.setProvider(faux.provider);

const channels = createChannels({
  channels: {
    inbox: {
      adapter: {
        async send(message) {
          for (const part of message.parts) console.log(part.text);
        },
      },
      conversation: () => ({
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      }),
    },
  },
});
const registry = createRegistry();
registry.install(channels.extension);
registry.install(channels.tools);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const hub = channels.hub(harness);

try {
  await hub.start();
  await hub.deliver("inbox", {
    address: "thread-1",
    text: "Say hello.",
    requestId: "message-1",
    author: "reader",
  });
  await harness.waitForIdle(context);
} finally {
  await hub.stop();
  await harness.close(context);
}
```

It prints `Hello from pi-durable.`. For crash recovery, use a persistent pi-durable store and reinstall the same extensions when opening the Harness.

## Host registration

`createChannels(options)` returns `extension`, `tools`, transactional `bind`, and a `hub` factory. Install `channels.extension` in the Harness registry for durable sends and reply hooks. Install `channels.tools` when the agent needs messaging tools and the address prompt section.

A channel is a host-assigned name, not an agent persona. Its optional `conversation(message, { channel })` factory creates a conversation for an unknown address. Returning `undefined` ignores the message. Without a factory, only bound addresses accept messages. `message.event` can select an agent, but is not stored in the channel entry.

The factory returns `agent` creation defaults and an optional `init(tx, conversationId)` callback. Creation, configuration, initialization, and address binding share one commit. `init` runs after the agent is configured and before the address is bound; it can read and write conversation documents, and asynchronous work finishes before message admission continues. Table reads are unavailable after creation, so use `tx.doc()` for document access. A failure rolls back the conversation and binding. An existing binding skips the factory and initialization.

If an agent selects extensions through an explicit list, binding adds `channels` to that list. Select `channels-tools` separately if the agent needs its tools. Without an explicit list, pi-durable selects installed extensions according to its defaults.

Start the hub after opening the Harness. On shutdown, stop the hub before closing the Harness.

## Admission and bindings

- `whenBusy: "queue"` is the default: a message gets its own run after the current one. `"steer"` joins the current run. Set a default on `createChannels` or override per delivery.
- `run: false` stores a message as context without starting a run or creating a conversation.
- `create: false` permits a run only for an already-bound address.
- A repeated `requestId` within the same conversation returns the original receipt without starting another run. IDs must distinguish messages from all addresses sharing that conversation.
- `deliver` resolves after admission, not after the reply. Attachments are fetched before admission and can delay acknowledgement.

An address identifies a destination within a channel, such as a Slack thread. Several addresses can bind to the same conversation, but an address belongs to only one conversation at a time. Bind from host code with `hub.bind(target, conversationId)`, or from a tool's commit with `channels.bind(tx, target, api.conversationId)`. Binding an address owned by another conversation throws.

## Adapter contract

Implement the exported `ChannelAdapter` type:

| Method | Contract |
| --- | --- |
| `start(ctx)` | Optional. Keep `deliver`, `cancel`, and `report`; resolve once the transport is ready. A rejection fails `hub.start()` |
| `stop()` | Optional. Resolve once the transport is closed |
| `fetch(request)` | Optional HTTP entry point, mounted by the host. Socket and polling adapters omit it |
| `send(message, ctx)` | Required. Post the outbound parts; throwing retries the send |
| `events(target, event)` | Optional best-effort run presentation |
| `fetchFile(url)` | Optional authenticated attachment download |

The start context's `signal` aborts during hub shutdown. The send context has its own task signal; wire it into outbound I/O. `cancel(address)` stops the run, sends, and notifications for the bound conversation.

`send` receives `addressData`, `replyContext`, and a stable `idempotencyKey`. It can return `{ addressData?, alias? }`: the data updates the binding, and an unbound alias is attached to the same conversation. Use this when an initial platform post creates the actual thread.

Address data persists until replaced. Reply context belongs to one message, and is also passed to its run events. A reply with no parts means `no_reply`; post nothing and clear the adapter's presentation state.

[Slack, GitHub, and webhook adapters](https://github.com/aliou/pi-durable-channels/tree/main/examples/channels) are copyable examples, not published adapter packages. The [examples guide](https://github.com/aliou/pi-durable-channels/tree/main/examples) covers complete platform integrations.

## Delivery and retries

Inbound acknowledgement must follow successful `deliver`. A crash before acknowledgement lets the platform redeliver with the same request ID. A receipt confirms that the message was stored, not that the agent answered or the platform accepted a reply.

Outbound sends are at least once. A crash after the platform accepts a post but before the task records success can repeat it with the same key. Replies use `reply:<entry>`; tool notifications use `notify:<task>`. Treat those keys as opaque and pass them to platforms that support deduplication.

The default retry policy is five attempts with a one-second initial delay and exponential backoff. Override it with `retry: { attempts, baseDelayMs }`. Every thrown send error consumes an attempt; there is no adapter-supplied permanent-error category.

## Run events

Adapters receive `run_started`, narration `text`, `tool_started`, `tool_finished`, and `run_ended` with `completed`, `failed`, or `aborted`. Events follow committed state; the final answer arrives through `send`, not a run event. A lone `no_reply` call and its accompanying text produce no activity events.

Events can be lost while the host is down and can repeat after restart. Activity events have an `id`; use it for deduplication. `run_started` and `run_ended` have no event ID: use the event type and `target.idempotencyKey`. That target key matches the corresponding reply's send key. Anything requiring durable delivery belongs in `send`.

## Attachments

Pass the host's environment builder to `channels.hub(harness, { env })`. The core downloads files through `fetchFile` and saves them under `.channels/attachments/<hash>/` in the conversation's environment. It appends paths after the inbound text, and includes supported images inline within pi-durable's image limit. Without an environment, files are named to the model but not saved. Download or save failures are included with the file description.

The adapter must validate a file URL's origin before sending credentials. Verify signatures over raw inbound bodies, enforce timestamp windows when supported, cap body size, and use fixed or allowlisted outbound origins with no redirects and a timeout. Treat inbound text as untrusted model input.

## Hub operations

| Method | Effect |
| --- | --- |
| `start()` | Start adapters and the run-events watcher; a hub starts once |
| `stop()` | Reject further changes, drain deliveries and events, then abort and stop transports |
| `deliver(channel, message, options?)` | Admit an inbound message, returning a receipt or `undefined` when ignored |
| `bind(target, conversationId)` | Attach an address to a conversation |
| `addresses(conversationId)` | Return all bound addresses, including aliases |
| `conversationOf(key)` | Return the bound conversation ID or `undefined` |
| `status(submissionId)` | Return `queued`, `running`, `sending`, `done`, `aborted`, `failed`, or `blocked`; unknown submissions return `undefined` |
| `cancel(key)` | Abort the run and sends, and withdraw queued messages |
| `clear(key)` | Cancel, then reset context in the same conversation |
| `compact(key)` | Compact the conversation |
| `end(key)` | Cancel and unbind all addresses of the conversation |

After `end`, another message creates a conversation only if the channel's factory accepts it.

## Model tools

`channels.tools` adds `send_message({ channel, address, text })`, `list_addresses()`, `no_reply()`, and an address prompt section. Sending and listing are restricted to addresses bound to the calling conversation. `send_message` queues a background notification; the final answer already goes to the inbound address.

## Reports

`onReport` receives `admitted` with a duplicate flag, `ignored`, `send_retry`, `send_failed`, and adapter-supplied `skipped` or `adapter_error`, each with its channel. Send reports may repeat after restart; use them for logs, not accounting. A throwing report callback is ignored. The core writes nothing to the console.

## License

MIT. See `LICENSE`.
