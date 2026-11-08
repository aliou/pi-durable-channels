import { describe, expect, it } from "vitest";
import { type FakeOptions, fakeSlack, until } from "../test/fake-slack";
import { type SocketModeOptions, startSocketMode } from "./socket";

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

  it("stops without waiting for Slack to answer the close", async () => {
    const { server, started, controller } = await socketMode({
      dropAfterMs: 2000,
    });
    const { done } = await started;
    const stopping = Date.now();
    controller.abort();
    await done;
    expect(Date.now() - stopping).toBeLessThan(500);
    await until(() => server.log.includes("closed"));
  });

  it("opens the replacement on disconnect and retires the old socket once it has hello", async () => {
    const held = gate();
    let handling = false;
    const { server, started, controller } = await socketMode(
      { hello: false },
      () => ({
        onPayload: async () => {
          handling = true;
          await held.promise;
        },
      }),
    );
    await until(() => server.log.includes("connected"));
    server.send({ type: "hello" });
    const { done } = await started;
    server.send(envelope("E1"));
    await until(() => handling);
    server.send({ type: "disconnect", reason: "warning" }, 0);
    server.send(envelope("E2"), 0);
    await until(() => server.log.length === 2);
    await pause();
    expect(server.log).toEqual(["connected", "connected"]);
    held.open();
    await until(() => server.log.length === 4);
    await pause();
    expect(server.log).toEqual(["connected", "connected", "ack E1", "ack E2"]);
    server.send({ type: "hello" }, 1);
    await until(() => server.log.includes("closed"));
    expect(server.log).toEqual([
      "connected",
      "connected",
      "ack E1",
      "ack E2",
      "closed",
    ]);
    controller.abort();
    await done;
  });

  it("reconnects at once after an unexpected drop", async () => {
    const { server, started, controller } = await socketMode();
    const { done } = await started;
    const dropped = Date.now();
    server.close();
    await until(() => server.log.length === 3);
    expect(server.log).toEqual(["connected", "closed", "connected"]);
    expect(Date.now() - dropped).toBeLessThan(500);
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
