# linear-channel

A Linear adapter built on the [Agent Session API](https://linear.app/developers/agents). Linear sends
`AgentSessionEvent` webhooks when the app user is mentioned or delegated an issue, and the adapter answers
with [agent activities](https://linear.app/developers/agent-interaction): a thinking indicator while the run
works, thoughts and actions as the model narrates and calls tools, and the final answer as a `response`
activity. An address is an agent session, `session:<agent session id>`.

```ts
import { createChannels } from "@aliou/pi-durable-channels";
import { linearChannel, linearTools } from "@examples/linear-channel";

const linear = linearChannel({ token, webhookSecret });
const channels = createChannels({
  channels: {
    linear: {
      adapter: linear,
      conversation: (message) =>
        message.event === "agent_session.created" ? { agent: coder } : undefined,
    },
  },
});
registry.install(channels.extension);
registry.install(channels.tools);
registry.install(linearTools({ token })); // adds the elicit tool
await channels.hub(harness).start();
// mount linear.fetch at the OAuth application's webhook URL
```

## How it works

```text
hub.start → linear.start({ deliver, cancel, report, signal })
  query { viewer { id } } → fails hub.start on bad credentials
  linear.fetch answers 503 before that

linear.fetch(request)
  body over 5 MiB → 413
  Linear-Signature does not match the raw body (hex HMAC-SHA256) → 401
  Linear-Timestamp outside the replay window (default 7 h) → 401
  no Linear-Delivery or no JSON → 400
  inboundOf(payload, "linear:<delivery>") (events.ts)
    AgentSessionEvent created  → run, event "agent_session.created",
                                 text = promptContext, or composed from the issue and comment
    AgentSessionEvent prompted → run, event "agent_session.prompted", text = prompt activity body;
                                 a prompt carrying the stop signal cancels the session's run instead
    anything else              → report skipped, "<type> <delivery>"
  deliver(message) for each → 202

events(target, event), for the session the run answers
  run_started   → ephemeral thought "Thinking…" (satisfies Linear's 10 s acknowledgement)
  text          → thought
  tool_started  → ephemeral action { action, parameter }
  tool_finished → action { action, result } ("Failed: …" for errors)
  run_ended     → failed: error activity; aborted: response "Stopped."; completed: nothing,
                  because send delivers the answer whole

send(reply)
  agentActivityCreate { type: "response", body } on the session, cut at 10,000 characters
```

- **Redeliveries.** Linear retries a failed push after 1 minute, 1 hour, and 6 hours. The default replay
  window (7 hours) accepts a redelivery that arrives after a crash before its acknowledgement; the
  `linear:<delivery>` request ID starts no second run. Set `timestampWindowMs` to tighten or disable the
  window.
- **At least once.** `agentActivityCreate` takes no idempotency key, so a crash between Linear accepting an
  activity and the send task recording it repeats the activity, as with any Linear post.
- **Unresponsive guard.** Linear marks a session unresponsive when no activity arrives within 10 seconds of
  `created`. The run's `run_started` event posts the thinking indicator as soon as the run starts; a message
  that maps to no run (the host's factory returned `undefined`) cannot satisfy it.
- **Stop.** A user's stop request arrives as a `prompted` webhook whose activity carries the `stop` signal.
  The adapter cancels the run instead of delivering it, and the run's `aborted` outcome posts a
  `response` activity confirming the stop, per the [AIG](https://linear.app/developers/aig).
- **Fixed origin.** GraphQL calls go to `https://api.linear.app/graphql` with no redirects and a 30 s
  timeout. `apiUrl` exists for tests.
- **Reports, not logs.** The adapter writes nothing to the console. A webhook that maps to no message
  reaches the host's `onReport` as `skipped`.

## Elicitation

`linearTools({ token })` installs the `elicit` tool for conversations bound to a Linear session. It posts an
`elicitation` activity, optionally with the `select` signal and fixed choices:

```ts
elicit({ address: "session:…", body: "Which database?", options: [{ label: "Postgres", value: "postgres" }] })
```

The user's answer arrives as the next `prompted` webhook — a new message in the same conversation — so the
tool instructs the model to end its turn with `no_reply`. Like the core's `send_message`, the tool refuses
addresses that are not bound to the calling conversation; it reads the same bindings through the package's
exported `ChannelsDoc` and `findBinding`. Activities carry no idempotency key, and the tool's default
`replay: "unsafe"` keeps a restart from re-asking a question, at the cost of losing the question when the
run is interrupted mid-call.

## Setup

1. Create an [application](https://linear.app/settings/api/applications/new). The name and icon become the
   agent's identity in mention and assignment menus.
2. Request the `app:assignable` and `app:mentionable` scopes and authorize with `actor=app`, which installs
   the app user into the workspace (workspace admins only). Store the OAuth access token and the app user
   ID (`viewer { id }`) together.
3. Enable webhooks on the application with content type `application/json`, and select the **Agent session
   events** category. Copy the signing secret into `webhookSecret`.
4. Mount `linear.fetch` at the webhook URL. The endpoint must answer within 5 seconds; `deliver` resolves
   after admission.

Security background: Linear signs webhooks with an HMAC-SHA256 of the raw body and recommends checking the
timestamp within a minute — a window that would reject every redelivery on the retry ladder, which is why
the default here is wider. Linear is SOC 2 Type II audited and ISO 27001 certified
([trust center](https://trust.linear.app/)); its [security page](https://linear.app/docs/security) lists
the outbound webhook IP addresses if you want to allowlist those too.

## Tests

`test/verify.test.ts` covers signatures and timestamps. `test/events.test.ts` covers payload mapping,
addresses, and the stop signal. `test/linear.test.ts` runs a real harness against a local fake Linear API:
delegation with a redelivery and a follow-up prompt, the thinking indicator, skipped events, the elicitation
tool including its refusal of foreign addresses, and the stop signal. Run
`nix develop -c pnpm --filter @examples/linear-channel test`.
