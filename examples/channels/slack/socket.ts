import { setTimeout as delay } from "node:timers/promises";
import { compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { parseJson } from "./body";

const RECONNECT_MS = 1000;

const Frame = compile(
  obj(
    { type: str(), envelope_id: opt(str()), payload: opt(unknown()) },
    { open: true },
  ),
);

export type SocketModeOptions = {
  open(): Promise<string>;
  onPayload(payload: unknown): Promise<void>;
  signal: AbortSignal;
};

async function handleFrame(
  socket: WebSocket,
  data: string,
  onPayload: SocketModeOptions["onPayload"],
): Promise<void> {
  const frame = parseJson(data);
  if (!Frame.check(frame)) return;
  if (frame.type === "disconnect") {
    socket.close();
    return;
  }
  if (frame.envelope_id === undefined) return;
  await onPayload(frame.payload);
  socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
}

async function connect(url: string, options: SocketModeOptions): Promise<void> {
  const socket = new WebSocket(url);
  const close = () => socket.close();
  options.signal.addEventListener("abort", close, { once: true });
  socket.addEventListener("message", (event) => {
    handleFrame(socket, String(event.data), options.onPayload).catch(
      (error: unknown) => console.error("slack event not delivered", error),
    );
  });
  await new Promise((resolve) => socket.addEventListener("close", resolve));
  options.signal.removeEventListener("abort", close);
}

async function openAndConnect(options: SocketModeOptions): Promise<void> {
  const url = await options.open();
  await connect(url, options);
}

export async function runSocketMode(options: SocketModeOptions): Promise<void> {
  while (!options.signal.aborted) {
    await openAndConnect(options).catch((error: unknown) =>
      console.error("slack socket mode", error),
    );
    await delay(RECONNECT_MS, undefined, { signal: options.signal }).catch(
      () => undefined,
    );
  }
}
