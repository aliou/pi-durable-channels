import type {
  ChannelAdapter,
  Deliver,
  OutboundMessage,
  SendContext,
} from "@aliou/pi-durable-channels";
import {
  arr,
  compile,
  int,
  nullable,
  obj,
  opt,
  str,
} from "@earendil-works/pi-schema";
import { issuePath, parseIssueAddress } from "./address";
import { GITHUB_API, githubApi } from "./api";
import type { GitHubAuth } from "./auth";
import { parseJson, readBody } from "./body";
import { type GitHubInbound, inboundOf } from "./events";
import { verifyGitHubSignature } from "./verify";

export type GitHubOptions = {
  auth: GitHubAuth;
  webhookSecret: string;
  apiUrl?: string;
  maxBodyBytes?: number;
  debug?: boolean;
};

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_COMMENT = 65_000;

const ReviewComments = compile(
  arr(
    obj(
      {
        pull_request_review_id: opt(nullable(int())),
        path: str(),
        line: opt(nullable(int())),
        original_line: opt(nullable(int())),
        body: str(),
      },
      { open: true },
    ),
  ),
);

type Receiver = { deliver: Deliver; self: string };

function textOf(message: OutboundMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

export function githubChannel(options: GitHubOptions): ChannelAdapter {
  const call = githubApi(options.auth.token, options.apiUrl ?? GITHUB_API);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  let receiver: Receiver | undefined;

  async function withReviewComments(inbound: GitHubInbound) {
    const { review } = inbound;
    if (review === undefined) return inbound.message;
    const comments = await call("GET", review.comments).catch(() => undefined);
    if (!ReviewComments.check(comments)) return inbound.message;
    const notes = comments
      .filter(({ pull_request_review_id: id }) => id === review.id)
      .reverse()
      .map(({ path, line, original_line: original, body }) => {
        const at = line ?? original;
        return at == null ? `${path}: ${body}` : `${path}:${at}: ${body}`;
      });
    return {
      ...inbound.message,
      text: [inbound.message.text, ...notes].join("\n"),
    };
  }

  async function receive(request: Request, to: Receiver): Promise<Response> {
    const raw = await readBody(request, maxBodyBytes);
    if (raw === undefined)
      return new Response("Payload Too Large", { status: 413 });
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyGitHubSignature(options.webhookSecret, signature, raw))
      return new Response("Unauthorized", { status: 401 });
    const name = request.headers.get("x-github-event") ?? "";
    const delivery = request.headers.get("x-github-delivery") ?? "";
    const payload = parseJson(raw);
    if (delivery === "" || payload === undefined)
      return new Response("Bad Request", { status: 400 });
    const inbounds = inboundOf({ name, delivery, payload }, to.self);
    if (inbounds.length === 0 && options.debug === true)
      console.error("github skipped", name, delivery);
    for (const inbound of inbounds) {
      const message = await withReviewComments(inbound);
      await to.deliver(message, inbound.options);
    }
    return new Response(null, { status: 202 });
  }

  async function send(
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<undefined> {
    const text = textOf(message).trim();
    if (text === "") return;
    const path = `${issuePath(parseIssueAddress(message.address))}/comments`;
    await call("POST", path, { body: text.slice(0, MAX_COMMENT) }, ctx.signal);
  }

  return {
    start: async (ctx) => {
      const self = await options.auth.login(ctx.signal);
      receiver = { deliver: ctx.deliver, self };
    },
    fetch: async (request) =>
      receiver === undefined
        ? new Response("Service Unavailable", { status: 503 })
        : receive(request, receiver),
    send,
  };
}
