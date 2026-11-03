import {
  compile,
  int,
  map,
  obj,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import type Stripe from "stripe";

const WithCustomer = compile(obj({ customer: str() }, { open: true }));
const RetriedInvoice = compile(
  obj({ attempt_count: int({ minimum: 2 }) }, { open: true }),
);
const Changes = compile(map(unknown()));

const CHANGE_FIELDS = ["cancel_at_period_end", "status", "items", "quantity"];

function changedSubscription(event: Stripe.Event): boolean {
  const previous = event.data.previous_attributes;
  if (!Changes.check(previous)) return false;
  return CHANGE_FIELDS.some((field) => Object.hasOwn(previous, field));
}

const SIGNALS: Record<string, (event: Stripe.Event) => boolean> = {
  "invoice.payment_failed": () => true,
  "invoice.paid": (event) => RetriedInvoice.check(event.data.object),
  "customer.subscription.updated": changedSubscription,
  "customer.subscription.deleted": () => true,
};

export function churnSignal(
  event: Stripe.Event,
): { customer: string } | undefined {
  const isSignal = SIGNALS[event.type];
  if (isSignal === undefined || !isSignal(event)) return undefined;
  const object = event.data.object;
  return WithCustomer.check(object) ? { customer: object.customer } : undefined;
}
