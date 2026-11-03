import Stripe from "stripe";

const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (secret === undefined)
  throw new Error("Set STRIPE_WEBHOOK_SECRET (see .env.example)");
const url = `http://localhost:${process.env.PORT ?? 8787}/stripe/webhook`;
const now = Math.floor(Date.now() / 1000);
const day = 86_400;

const events = [
  {
    type: "invoice.finalized",
    object: {
      object: "invoice",
      id: "in_acme_11",
      customer: "cus_acme",
      amount_due: 240000,
      currency: "usd",
    },
  },
  {
    type: "invoice.payment_failed",
    object: {
      object: "invoice",
      id: "in_acme_11",
      customer: "cus_acme",
      amount_due: 240000,
      currency: "usd",
      attempt_count: 1,
      next_payment_attempt: now + 3 * day,
      billing_reason: "subscription_cycle",
    },
  },
  {
    type: "customer.subscription.updated",
    object: {
      object: "subscription",
      id: "sub_northwind",
      customer: "cus_northwind",
      status: "active",
      cancel_at_period_end: true,
      current_period_end: now + 29 * day,
      items: {
        data: [
          {
            price: {
              nickname: "Team",
              unit_amount: 1980,
              recurring: { interval: "month" },
            },
            quantity: 5,
          },
        ],
      },
    },
    previous: { cancel_at_period_end: false },
  },
  {
    type: "invoice.paid",
    object: {
      object: "invoice",
      id: "in_acme_11",
      customer: "cus_acme",
      amount_paid: 240000,
      currency: "usd",
      attempt_count: 2,
    },
  },
];

for (const [index, event] of events.entries()) {
  const payload = JSON.stringify({
    id: `evt_replay_${index + 1}`,
    object: "event",
    type: event.type,
    created: now + index,
    data: {
      object: event.object,
      ...(event.previous === undefined
        ? {}
        : { previous_attributes: event.previous }),
    },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
  const body = await response.text();
  console.log(event.type, event.object.customer, response.status, body);
}
