import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { allowOrigins } from "@examples/webhook-channel";

const TIMEOUT_MS = 10_000;
const MAX_TEXT = 2_000;

function report(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

async function probe(url: string): Promise<string> {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
  const elapsed = `${Date.now() - started}ms`;
  if (response === undefined) return `request failed after ${elapsed}`;
  const body = await response.text();
  return `status ${response.status} in ${elapsed}\n${body.slice(0, MAX_TEXT)}`;
}

export function responderTools(origins: readonly string[]) {
  const allowed = allowOrigins(origins);
  const checkUrl = defineTool({
    name: "check_url",
    description:
      "GET an http(s) URL and report its status, latency, and the start of its body. Use it to confirm an outage. " +
      `Only these origins can be checked: ${origins.length === 0 ? "none" : origins.join(", ")}`,
    parameters: obj({ url: str() }),
    replay: "safe",
    execute: async ({ url }) =>
      report(
        allowed(url) ? await probe(url) : `${url} is not an allowed origin.`,
      ),
  });
  return defineExtension({ name: "responder-tools", tools: [checkUrl] });
}
