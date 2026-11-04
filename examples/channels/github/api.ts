import { compile, obj, str } from "@earendil-works/pi-schema";

export const GITHUB_API = "https://api.github.com";

const TIMEOUT_MS = 30_000;

export type TokenSource = (signal?: AbortSignal) => Promise<string>;

export type GitHubCall = (
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function headers(token: string, json: boolean): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "pi-durable-channels",
    "x-github-api-version": "2022-11-28",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

const PERMISSION_HEADERS = [
  "x-accepted-github-permissions",
  "x-accepted-oauth-scopes",
  "x-oauth-scopes",
];

const Failure = compile(obj({ message: str() }, { open: true }));

async function failure(
  method: string,
  path: string,
  response: Response,
): Promise<GitHubError> {
  const body: unknown = await response.json().catch(() => undefined);
  const message = Failure.check(body) ? `: ${body.message.slice(0, 200)}` : "";
  const hints = PERMISSION_HEADERS.flatMap((header) => {
    const value = response.headers.get(header);
    return value === null ? [] : [`${header}: ${value || "none"}`];
  });
  const details = hints.length === 0 ? "" : ` (${hints.join("; ")})`;
  return new GitHubError(
    response.status,
    `GitHub ${method} ${path} answered ${response.status}${message}${details}`,
  );
}

export function githubApi(token: TokenSource, apiUrl = GITHUB_API): GitHubCall {
  return async (method, path, body, signal) => {
    const signals = [AbortSignal.timeout(TIMEOUT_MS), signal ?? []].flat();
    const bearer = await token(signal);
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: headers(bearer, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) throw await failure(method, path, response);
    return response.status === 204 ? undefined : response.json();
  };
}
