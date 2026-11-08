import { describe, expect, it } from "vitest";
import { sessionAddress } from "../address";
import { inboundOf } from "../events";
import { payloads } from "./fake-linear";

describe("inboundOf", () => {
  it("maps a created session to a message with the prompt context", () => {
    const [inbound] = inboundOf(payloads.created(), "linear:d1");
    expect(inbound).toEqual({
      kind: "message",
      message: {
        address: sessionAddress(payloads.sessionId),
        text: `<issue identifier="ENG-123"><title>Fix the login crash</title></issue>`,
        requestId: "linear:d1",
        author: "ana",
        event: "agent_session.created",
      },
      options: {},
    });
  });

  it("composes a fallback prompt when the payload has none", () => {
    const payload = payloads.created({ promptContext: undefined });
    const [inbound] = inboundOf(payload, "linear:d1");
    expect(inbound?.kind === "message" && inbound.message.text).toBe(
      "Issue ENG-123 Fix the login crash\nUsers cannot log in.",
    );
  });

  it("ignores a created session with no usable prompt", () => {
    const payload = payloads.created({
      promptContext: undefined,
      agentSession: { id: payloads.sessionId },
    });
    expect(inboundOf(payload, "linear:d1")).toEqual([]);
  });

  it("maps a prompted activity to a message from its author", () => {
    const [inbound] = inboundOf(payloads.prompted("use postgres"), "linear:d2");
    expect(inbound).toEqual({
      kind: "message",
      message: {
        address: sessionAddress(payloads.sessionId),
        text: "use postgres",
        requestId: "linear:d2",
        author: "ana",
        event: "agent_session.prompted",
      },
      options: {},
    });
  });

  it("maps a stop signal to a stop, not a message", () => {
    const payload = payloads.prompted("stop", {
      agentActivity: {
        id: "a2",
        content: { type: "prompt", body: "stop" },
        signal: "stop",
        user: { id: "u-ana", name: "ana" },
      },
    });
    expect(inboundOf(payload, "linear:d3")).toEqual([
      { kind: "stop", address: sessionAddress(payloads.sessionId) },
    ]);
  });

  it("returns nothing for other webhook types and actions", () => {
    expect(inboundOf(payloads.comment(), "linear:d4")).toEqual([]);
    expect(
      inboundOf(payloads.created({ action: "removed" }), "linear:d5"),
    ).toEqual([]);
    expect(inboundOf({}, "linear:d6")).toEqual([]);
  });
});
