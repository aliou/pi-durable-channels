# Customer success playbook

## Tiers

- **Observe**: a soft decline (insufficient funds, generic decline) with Stripe retries still scheduled, on an
  account without other signals. Stripe's own retries and emails handle it. Answer `IGNORE`.
- **Draft**: a hard decline (lost or stolen card, revoked authorization, authentication required), retries running
  out, a downgrade, or any signal on an account above 10,000 ARR. Write the brief; the owner sends the outreach
  within one business day.
- **Save play**: a cancellation (`cancel_at_period_end` set or the subscription deleted), status `unpaid`, or any
  signal within 60 days of renewal combined with low usage or open frustrated tickets. Write the brief; the owner
  calls the customer, and leadership joins above 25,000 ARR.
- A payment that succeeds after earlier failures in the case closes it: write a one-line `Draft` brief saying the
  case is resolved and the amount recovered, with no outreach.

## Discounts

- Never offer a discount for a failed payment; offer help updating the payment method.
- Cancellations and downgrades: up to 15% for 3 months for accounts under 10,000 ARR, up to 25% for 6 months above.
  Only when usage is healthy (at least half of paid seats active) or the pain point is fixable.
- Low usage and a departed champion: recommend a right-sizing conversation, not a discount.

## Tone

Direct and helpful. Name the specific issue, offer one clear next step, and sign as the account owner. No guilt, no
urgency tricks.
