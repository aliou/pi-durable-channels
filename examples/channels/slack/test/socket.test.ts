import { describe, expect, it } from "vitest";
import { type SocketModeOptions, startSocketMode } from "../socket";
import { type FakeOptions, fakeSlack, until } from "./fake-slack";

function gate() {
  let open: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

async function socketMode(
  fake: FakeOptions = {},
  options: (url: string) => Partial<SocketModeOptions> = () => ({}),
) {
  const slack = await fakeSlack({}, fake);
  const controller = new AbortController();
  const errors: unknown[] = [];
  const url = `${slack.origin.replace("http", "ws")}/socket`;
  const started = startSocketMode({
    open: async () => url,
    onPayload: async () => undefined,
    onError: (error) => errors.push(error),
    signal: controller.signal,
    ...options(url),
  });
  return { server: slack.socket, started, controller, errors };
}

const envelope = (id: string) => ({
  type: "events_api",
  envelope_id: id,
  payload: { type: "event_callback", event: {} },
});

const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("slack socket mode connection", () => {
  it("acks a frame it is still handling before it closes at stop", async () => {
    const held = gate();
    let handling = false;
    const { server, started, controller } = await socketMode({}, () => ({
      onPayload: async () => {
        handling = true;
        await held.promise;
      },
    }));
    const { done } = await started;
    server.send(envelope("E1"));
    await until(() => handling);
    controller.abort();
    await pause();
    expect(server.log).toEqual(["connected"]);
    held.open();
    await done;
    await until(() => server.log.includes("closed"));
    expect(server.log).toEqual(["connected", "ack E1", "closed"]);
  });

  it("acks the frames it is handling on disconnect, then reconnects", async () => {
    const held = gate();
    let handling = false;
    const { server, started, controller } = await socketMode({}, () => ({
      onPayload: async () => {
        handling = true;
        await held.promise;
      },
    }));
    const { done } = await started;
    server.send(envelope("E1"));
    await until(() => handling);
    server.send({ type: "disconnect" });
    server.send(envelope("E2"));
    await pause();
    expect(server.log).toEqual(["connected"]);
    held.open();
    await until(() => server.log.length === 4);
    expect(server.log).toEqual(["connected", "ack E1", "closed", "connected"]);
    controller.abort();
    await done;
  });

  it("rejects when the socket closes before hello", async () => {
    const { server, started } = await socketMode({ hello: false });
    await until(() => server.log.includes("connected"));
    server.close();
    await expect(started).rejects.toThrow("closed before hello");
  });

  it("rejects when hello does not arrive in time", async () => {
    const { started } = await socketMode({ hello: false }, () => ({
      helloMs: 50,
    }));
    await expect(started).rejects.toThrow("closed before hello");
  });

  it("reports nothing once stopped: neither a frame failing nor a reconnect cut short", async () => {
    const held = gate();
    let handling = false;
    let opened = 0;
    const controller = new AbortController();
    const aborted = new Promise<string>((_, reject) =>
      controller.signal.addEventListener("abort", () =>
        reject(new Error("aborted")),
      ),
    );
    aborted.catch(() => undefined);
    const { server, started, errors } = await socketMode({}, (url) => ({
      signal: controller.signal,
      open: async () => {
        opened += 1;
        return opened === 1 ? url : aborted;
      },
      onPayload: async () => {
        handling = true;
        await held.promise;
      },
    }));
    const { done } = await started;
    server.send(envelope("E1"));
    await until(() => handling);
    server.close();
    await until(() => opened === 2);
    controller.abort();
    held.fail(new Error("Channels hub is stopped"));
    await done;
    expect(errors).toEqual([]);
  });
});
