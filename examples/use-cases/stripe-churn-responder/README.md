# stripe-churn-responder

Turns Stripe churn signals into case threads in Slack. Each customer is a case: the agent gathers billing, CRM, and
support context, decides how serious the signal is, and posts a brief with a risk level, a recommended action,
discount guidance, and a draft email for the account owner. Customer success follows up in the thread.

## How it works

Stripe is an event source, not a conversation, so it is not a channel. A plain host route filters events and hands
churn signals to the `slack` channel (`@examples/slack-channel`, in `examples/channels/slack`):

```text
Stripe → POST /stripe/webhook                      host route (events.ts)
  verify Stripe-Signature, else 400
  churnSignal(event) (signals.ts), else 200 without a run
    invoice.payment_failed
    invoice.paid after a failed attempt
    customer.subscription.updated changing cancel_at_period_end, status, items, or quantity
    customer.subscription.deleted
  hub.deliver("slack", { address: <SLACK_CHANNEL_ID>:<customer id>, requestId: stripe:<event id> })  → 200
  case conversation runs with instructions.md + playbook.md
    crm_account, support_tickets (data/*.json), stripe_get (GET only)
    answers a brief, or IGNORE (dropped, nothing posted)
  reply → slack send
    first brief: posts a thread root in the channel, records the thread as the case's address
    later briefs: post in that thread

teammate writes in the case thread (Socket Mode, or POST /slack/events)
  without a mention → stored as context, no run
  with @bot        → run, answer in the thread
```

- **One conversation per customer.** The agent sees every earlier signal of the customer: a recovered payment closes
  the case it opened, and a cancellation after two failed payments reads differently from one out of the blue.
- **Tiers decide who acts.** `playbook.md` sorts signals into Observe (left to Stripe's retries and emails), Draft (the
  owner sends the outreach), and Save play (the owner calls). Discount limits and tone live there too; customer
  success can edit it without touching code.
- **Context beyond Stripe.** `crm_account` and `support_tickets` read `data/crm.json` and `data/support.json`. Replace
  them with your CRM and help desk.
- **Read-only.** The agent changes nothing in Stripe or elsewhere; a person reviews every brief.
- **Durable.** Stripe redeliveries start no second run (`stripe:<event id>` is the request ID), and a crash mid-run or
  mid-send resumes on restart.
- **Known gap.** Two signals for a new customer that arrive before the first brief is posted can open two threads.

## Try it

Set up a Slack app as the [Slack channel README](../../channels/slack/README.md#slack-app-setup) describes, invite it
to the case channel, and either use Socket Mode or point Event Subscriptions at `/slack/events`. Configuration is in
`.env.example`.

```sh
nix develop -c pnpm --filter @examples/stripe-churn-responder start
nix develop -c pnpm --filter @examples/stripe-churn-responder replay
```

`replay.ts` sends signed events for the two customers in `data/`: Acme's payment fails and later recovers, and
Northwind schedules a cancellation. Watch the case threads appear, then mention the bot in one of them.

With a Stripe test account, forward real events instead:
`stripe listen --forward-to localhost:8787/stripe/webhook`, then `stripe trigger invoice.payment_failed`.
