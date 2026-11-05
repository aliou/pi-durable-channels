import {
  arr,
  compile,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";

export const LINEAR_API = "https://api.linear.app/graphql";

const TIMEOUT_MS = 30_000;

export type LinearCall = (
  query: string,
  variables?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

export class LinearError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const Failure = compile(obj({ errors: opt(arr(unknown())) }, { open: true }));

const GraphQLError = compile(obj({ message: str() }, { open: true }));

function messages(errors: unknown[]): string {
  return errors
    .flatMap((error) => {
      if (typeof error === "string") return [error];
      return GraphQLError.check(error) ? [error.message] : [];
    })
    .map((message) => message.slice(0, 200))
    .join("; ");
}

export function linearApi(token: string, apiUrl = LINEAR_API): LinearCall {
  return async (query, variables, signal) => {
    const signals = [AbortSignal.timeout(TIMEOUT_MS), signal ?? []].flat();
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "pi-durable-channels",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
    if (!response.ok)
      throw new LinearError(
        response.status,
        `Linear API answered ${response.status}`,
      );
    const body: unknown = await response.json().catch(() => undefined);
    if (!Failure.check(body)) return undefined;
    const errors = body.errors ?? [];
    if (errors.length > 0)
      throw new LinearError(
        200,
        `Linear API rejected the call: ${messages(errors)}`,
      );
    return (body as { data?: unknown }).data;
  };
}
