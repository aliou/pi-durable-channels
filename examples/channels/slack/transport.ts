import { compile, lit, obj, str, unknown } from "@earendil-works/pi-schema";
import { slackApi } from "./api";
import { parseJson, readBody } from "./body";
import { runSocketMode } from "./socket";
import { verifySlackSignature } from "./verify";

export type SlackTransport =
  | { kind: "socket"; appToken: string }
  | { kind: "http"; signingSecret: string };

export const socketMode = (appToken: string): SlackTransport => ({
  kind: "socket",
  appToken,
});

export const httpEvents = (signingSecret: string): SlackTransport => ({
  kind: "http",
  signingSecret,
});

export type OnEvent = (event: unknown) => Promise<void>;

const Connection = compile(obj({ url: str() }, { open: true }));
const UrlVerification = compile(
  obj({ type: lit("url_verification"), challenge: str() }, { open: true }),
);
const EventCallback = compile(
  obj({ type: lit("event_callback"), event: unknown() }, { open: true }),
);

export async function receiveHttp(
  request: Request,
  http: { signingSecret: string; onEvent: OnEvent; maxBodyBytes: number },
): Promise<Response> {
  const raw = await readBody(request, http.maxBodyBytes);
  if (raw === undefined)
    return new Response("Payload Too Large", { status: 413 });
  if (!verifySlackSignature(http.signingSecret, request.headers, raw))
    return new Response("Unauthorized", { status: 401 });
  const body = parseJson(raw);
  if (UrlVerification.check(body))
    return Response.json({ challenge: body.challenge });
  if (EventCallback.check(body)) await http.onEvent(body.event);
  return new Response(null, { status: 200 });
}

export function listenSocket(socket: {
  apiUrl: string;
  appToken: string;
  onEvent: OnEvent;
  onError(error: unknown): void;
  signal: AbortSignal;
}): void {
  const open = slackApi(socket.appToken, socket.apiUrl);
  void runSocketMode({
    open: async () => {
      const opened = await open("apps.connections.open", {}, socket.signal);
      if (!Connection.check(opened))
        throw new Error("Slack apps.connections.open returned no url");
      return opened.url;
    },
    onPayload: async (payload) => {
      if (EventCallback.check(payload)) await socket.onEvent(payload.event);
    },
    onError: socket.onError,
    signal: socket.signal,
  });
}
