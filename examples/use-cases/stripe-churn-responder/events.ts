import type { ChannelsHub } from "@aliou/pi-durable-channels";
import Stripe from "stripe";
import { churnSignal } from "./signals";

export type StripeEventsOptions = {
  webhookSecret: string;
  slackChannelId: string;
};

function describe(event: Stripe.Event): string {
  const changes = event.data.previous_attributes;
  return [
    `Stripe event ${event.type} (${event.id}) at ${new Date(event.created * 1000).toISOString()}`,
    "```json",
    JSON.stringify(event.data.object, null, 2),
    "```",
    ...(changes === undefined
      ? []
      : [
          "Previous values:",
          "```json",
          JSON.stringify(changes, null, 2),
          "```",
        ]),
  ].join("\n");
}

export function stripeEvents(options: StripeEventsOptions) {
  return async (request: Request, hub: ChannelsHub): Promise<Response> => {
    const payload = await request.text();
    const signature = request.headers.get("stripe-signature") ?? "";
    const event = await Stripe.webhooks
      .constructEventAsync(payload, signature, options.webhookSecret)
      .catch(() => undefined);
    if (event === undefined)
      return new Response("Invalid signature", { status: 400 });
    const signal = churnSignal(event);
    if (signal === undefined)
      return Response.json({ received: true, signal: false });
    await hub.deliver("slack", {
      address: `${options.slackChannelId}:${signal.customer}`,
      text: describe(event),
      requestId: `stripe:${event.id}`,
      author: "stripe",
    });
    return Response.json({ received: true, signal: true });
  };
}
