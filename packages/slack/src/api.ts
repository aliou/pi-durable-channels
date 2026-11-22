import { bool, compile, obj, opt, str } from "@earendil-works/pi-schema";

const TIMEOUT_MS = 30_000;

const Reply = compile(obj({ ok: bool(), error: opt(str()) }, { open: true }));
const scopes = new WeakMap<Record<string, unknown>, readonly string[]>();

export type SlackCall = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly scopes: readonly string[] = [],
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export function oauthScopes(
  response: Record<string, unknown>,
): readonly string[] {
  return scopes.get(response) ?? [];
}

export function slackApi(token: string, apiUrl: string): SlackCall {
  return async (method, body, signal) => {
    const signals = [AbortSignal.timeout(TIMEOUT_MS), signal ?? []].flat();
    const response = await fetch(`${apiUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
    if (!response.ok)
      throw new Error(`Slack ${method} answered ${response.status}`);
    const reply: unknown = await response.json();
    if (!Reply.check(reply)) throw new Error(`Slack ${method} answered badly`);
    const granted = response.headers.get("x-oauth-scopes");
    const grantedScopes =
      granted === null ? [] : granted.split(",").map((scope) => scope.trim());
    scopes.set(reply, grantedScopes);
    if (!reply.ok)
      throw new SlackApiError(method, reply.error ?? "unknown", grantedScopes);
    return reply;
  };
}
