import { readFile } from "node:fs/promises";
import {
  type ChannelAdapter,
  createChannels,
} from "@aliou/pi-durable-channels";
import { logReport } from "@examples/shared/log";
import { loadModel } from "@examples/shared/model";
import { adapterRoute, type Route, run } from "@examples/shared/run";
import { IGNORE } from "@examples/shared/sink";
import { httpEvents, slackChannel, socketMode } from "@examples/slack-channel";
import { stripeEvents } from "./src/events";
import { churnTools } from "./src/tools";

const env = process.env;
const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
const botToken = env.SLACK_BOT_TOKEN;
const slackChannelId = env.SLACK_CHANNEL_ID;

function slackTransport() {
  if (env.SLACK_APP_TOKEN) return socketMode(env.SLACK_APP_TOKEN);
  if (env.SLACK_SIGNING_SECRET) return httpEvents(env.SLACK_SIGNING_SECRET);
  return undefined;
}

const transport = slackTransport();
if (!webhookSecret || !botToken || !slackChannelId || !transport) {
  throw new Error(
    "Set STRIPE_WEBHOOK_SECRET, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, and SLACK_APP_TOKEN or SLACK_SIGNING_SECRET (see .env.example)",
  );
}

const role = await readFile(
  new URL("instructions.md", import.meta.url),
  "utf8",
);
const playbook = await readFile(
  new URL("playbook.md", import.meta.url),
  "utf8",
);
const instructions = `${role}\n${playbook}`;
const { models, model } = loadModel((prompt) =>
  prompt.includes("Stripe event")
    ? "**Risk:** medium\n**Tier:** Draft\n**Owner:** (scripted model)\n**What happened:** a churn signal arrived.\n**Recommended action:** review the case."
    : IGNORE,
);
const tools = churnTools(env.STRIPE_SECRET_KEY);

const slack = slackChannel({ botToken, transport });
const cases: ChannelAdapter = {
  ...slack,
  send: async (message, ctx) => {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    return text.trim() === IGNORE ? undefined : slack.send(message, ctx);
  },
};

const channels = createChannels({
  channels: {
    slack: {
      adapter: cases,
      conversation: () => ({
        agent: { model, instructions, extensions: [tools] },
      }),
    },
  },
  onReport: logReport,
});

const routes: Record<string, Route> = {
  "POST /stripe/webhook": stripeEvents({ webhookSecret, slackChannelId }),
  ...(transport.kind === "http"
    ? { "POST /slack/events": adapterRoute(slack) }
    : {}),
};

await run({
  name: "stripe-churn-responder",
  channels,
  models,
  extensions: [tools],
  routes,
});
