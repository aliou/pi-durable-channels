import { setTimeout as delay } from "node:timers/promises";
import {
  compile,
  obj,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import WebSocket from "ws";
import { parseJson } from "./body";

const RECONNECT_MS = 1000;
const HELLO_MS = 10_000;

const FrameSchema = obj(
  { type: str(), envelope_id: opt(str()), payload: opt(unknown()) },
  { open: true },
);
const Frame = compile(FrameSchema);

export type SocketModeOptions = {
  open(): Promise<string>;
  onPayload(payload: unknown): Promise<void>;
  onError(error: unknown): void;
  signal: AbortSignal;
  helloMs?: number;
};

export type SocketMode = { done: Promise<void> };

type Connection = {
  retiring: Promise<void>;
  closed: Promise<void>;
  retire(): void;
};

async function handleFrame(
  socket: WebSocket,
  frame: Static<typeof FrameSchema>,
  onPayload: SocketModeOptions["onPayload"],
): Promise<void> {
  if (frame.envelope_id === undefined) return;
  await onPayload(frame.payload);
  socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
}

function connect(url: string, options: SocketModeOptions): Promise<Connection> {
  const socket = new WebSocket(url);
  const handling = new Set<Promise<void>>();
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  let requestReplacement = () => {};
  const retiring = new Promise<void>((resolve) => {
    requestReplacement = resolve;
  });
  let draining = false;
  const retire = () => {
    draining = true;
    void Promise.allSettled(handling).then(() => socket.terminate());
  };
  socket.on("error", () => undefined);
  options.signal.addEventListener("abort", retire, { once: true });
  void closed.then(() => options.signal.removeEventListener("abort", retire));
  if (options.signal.aborted) retire();

  function handle(frame: Static<typeof FrameSchema>): void {
    if (draining) return;
    const handled = handleFrame(socket, frame, options.onPayload).catch(
      options.onError,
    );
    handling.add(handled);
    void handled.then(() => handling.delete(handled));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => socket.terminate(),
      options.helloMs ?? HELLO_MS,
    );
    void closed.then(() => {
      clearTimeout(timer);
      reject(new Error("Slack Socket Mode closed before hello"));
    });
    socket.on("message", (data) => {
      const frame = parseJson(String(data));
      if (!Frame.check(frame)) return;
      if (frame.type === "disconnect") return requestReplacement();
      if (frame.type !== "hello") return handle(frame);
      clearTimeout(timer);
      resolve({ retiring, closed, retire });
    });
  });
}

async function openAndConnect(options: SocketModeOptions): Promise<Connection> {
  const url = await options.open();
  return connect(url, options);
}

async function keepConnected(
  first: Connection,
  options: SocketModeOptions,
): Promise<void> {
  let current = first;
  while (true) {
    await Promise.race([current.retiring, current.closed]);
    if (options.signal.aborted) return current.closed;
    const next = await openAndConnect(options).catch(options.onError);
    if (next === undefined) {
      await delay(RECONNECT_MS, undefined, { signal: options.signal }).catch(
        () => undefined,
      );
      continue;
    }
    current.retire();
    current = next;
  }
}

export async function startSocketMode(
  options: SocketModeOptions,
): Promise<SocketMode> {
  const quiet = {
    ...options,
    onError: (error: unknown) => {
      if (!options.signal.aborted) options.onError(error);
    },
  };
  const first = await openAndConnect(quiet);
  return { done: keepConnected(first, quiet) };
}
