import { readFile } from "node:fs/promises";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  compile,
  map,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import Stripe from "stripe";

const READABLE = [
  "/v1/customers",
  "/v1/subscriptions",
  "/v1/invoices",
  "/v1/charges",
  "/v1/payment_intents",
];
const API_PATH = /^\/v1\/[a-z_]+(?:\/[A-Za-z0-9_]+)?$/;

function isReadable(path: string): boolean {
  const collection = path.split("/").slice(0, 3).join("/");
  return API_PATH.test(path) && READABLE.includes(collection);
}

const Records = compile(map(unknown()));

function text(value: string, isError = false) {
  return { output: [{ type: "text" as const, text: value }], isError };
}

async function readRecords(name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(
    new URL(`../data/${name}.json`, import.meta.url),
    "utf8",
  );
  const records: unknown = JSON.parse(raw);
  if (!Records.check(records))
    throw new Error(`data/${name}.json must map customer IDs to records`);
  return records;
}

function lookup(name: string, file: string, description: string) {
  return defineTool({
    name,
    description,
    parameters: obj({
      customer: str({ description: "Stripe customer ID, such as cus_123" }),
    }),
    replay: "safe",
    execute: async ({ customer }) => {
      const records = await readRecords(file);
      if (!Object.hasOwn(records, customer))
        return text(`No ${name} record for ${customer}.`);
      return text(JSON.stringify(records[customer], null, 2));
    },
  });
}

export function churnTools(secretKey: string | undefined) {
  const stripe = secretKey === undefined ? undefined : new Stripe(secretKey);
  const stripeGet = defineTool({
    name: "stripe_get",
    description:
      "Read from the Stripe API with GET. `path` is an API path such as /v1/customers/cus_123 or /v1/invoices; `query` " +
      `holds list filters such as { customer: 'cus_123', limit: '5' }. Allowed: ${READABLE.join(", ")}`,
    parameters: obj({ path: str(), query: opt(map(str())) }),
    replay: "safe",
    execute: async ({ path, query }) => {
      if (stripe === undefined)
        return text(
          "STRIPE_SECRET_KEY is not set; Stripe lookups are unavailable.",
          true,
        );
      if (!isReadable(path)) {
        return text(
          `${path} is not readable here. Allowed: ${READABLE.join(", ")}`,
          true,
        );
      }
      const result = await stripe.rawRequest("GET", path, query ?? {});
      return text(JSON.stringify(result, null, 2));
    },
  });
  const crmAccount = lookup(
    "crm_account",
    "crm",
    "The CRM account of a Stripe customer: company, account owner, segment, ARR, renewal date, seat usage, notes.",
  );
  const supportTickets = lookup(
    "support_tickets",
    "support",
    "Support tickets of a Stripe customer, newest last.",
  );
  return defineExtension({
    name: "churn-tools",
    tools: [stripeGet, crmAccount, supportTickets],
  });
}
