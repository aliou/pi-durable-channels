import { describe, expect, it } from "vitest";
import { inboundOf, stoppedAddressOf } from "../events";
import { slackTarget } from "../target";
import { verifySlackSignature } from "../verify";
import { message, SECRET, signed } from "./fake-slack";

describe("slack events", () => {
  it("runs on a mention, stores other thread messages, and skips the rest", () => {
    expect(
      inboundOf(message({ thread_ts: "100.000100", text: "fyi" }), "UBOT"),
    ).toEqual({
      message: {
        address: "C1:100.000100",
        text: "fyi",
        requestId: "slack:C1:200.000100",
        author: "U1",
        replyContext: { user: "U1" },
        files: [],
      },
      run: false,
    });
    expect(
      inboundOf(message({ text: "<@UBOT> help" }), "UBOT", "T1"),
    ).toMatchObject({
      message: {
        address: "C1:200.000100",
        replyContext: { user: "U1", team: "T1" },
      },
      run: true,
    });
    expect(inboundOf(message({}), "UBOT")).toBeUndefined();
    expect(
      inboundOf(message({ thread_ts: "1.1", bot_id: "B1" }), "UBOT"),
    ).toBeUndefined();
    expect(
      inboundOf(
        message({ thread_ts: "1.1", subtype: "message_changed" }),
        "UBOT",
      ),
    ).toBeUndefined();
    expect(inboundOf({ type: "reaction_added" }, "UBOT")).toBeUndefined();
  });

  it("runs every direct message and passes its files on", () => {
    const shared = message({
      channel: "D1",
      channel_type: "im",
      subtype: "file_share",
      files: [
        {
          id: "F1",
          name: "report.pdf",
          mimetype: "application/pdf",
          url_private: "https://files.slack.com/files-pri/T1-F1/report.pdf",
        },
        { id: "F2", name: "gdrive link" },
      ],
    });
    expect(inboundOf(shared, "UBOT")).toMatchObject({
      message: {
        address: "D1:200.000100",
        files: [
          {
            name: "report.pdf",
            mimeType: "application/pdf",
            url: "https://files.slack.com/files-pri/T1-F1/report.pdf",
          },
        ],
      },
      run: true,
    });
  });

  it("maps the stop button to the session thread", () => {
    expect(
      stoppedAddressOf({
        type: "agent_session_stopped",
        channel: "D1",
        thread_ts: "200.000100",
      }),
    ).toBe("D1:200.000100");
    expect(stoppedAddressOf(message({}))).toBeUndefined();
  });

  it("verifies the signature over the raw body and refuses stale requests", () => {
    const body = JSON.stringify({ a: 1 });
    const fresh = signed({ a: 1 });
    expect(verifySlackSignature(SECRET, fresh.headers, body)).toBe(true);
    expect(verifySlackSignature("other", fresh.headers, body)).toBe(false);
    expect(verifySlackSignature(SECRET, fresh.headers, `${body} `)).toBe(false);
    const stale = signed({ a: 1 }, { at: Date.now() - 600_000 });
    expect(verifySlackSignature(SECRET, stale.headers, body)).toBe(false);
    expect(verifySlackSignature(SECRET, new Headers(), body)).toBe(false);
  });

  it("targets a thread from the address or the stored thread, else the channel", () => {
    expect(slackTarget("C1:100.000100", undefined)).toEqual({
      channel: "C1",
      threadTs: "100.000100",
    });
    expect(slackTarget("C1:cus_acme", undefined)).toEqual({ channel: "C1" });
    expect(slackTarget("C1:cus_acme", { threadTs: "5.5" })).toEqual({
      channel: "C1",
      threadTs: "5.5",
    });
    expect(() => slackTarget("cus_acme", undefined)).toThrow("<channel>");
  });
});
