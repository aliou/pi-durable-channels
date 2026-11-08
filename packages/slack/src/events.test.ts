import { describe, expect, it } from "vitest";
import { message, SECRET, signed } from "../test/fake-slack";
import {
  describeEvent,
  inboundOf,
  renamedThreadOf,
  stoppedAddressOf,
} from "./events";
import { slackTarget } from "./target";
import { verifySlackSignature } from "./verify";

const bot = { botUserId: "UBOT" };

describe("slack events", () => {
  it("runs on a mention, stores other thread messages, and skips the rest", () => {
    expect(
      inboundOf(message({ thread_ts: "100.000100", text: "fyi" }), bot),
    ).toEqual({
      message: {
        address: "C1:100.000100",
        text: "fyi",
        requestId: "slack:C1:200.000100",
        author: "U1",
        replyContext: { user: "U1", request: "fyi" },
        files: [],
      },
      options: { run: false },
    });
    expect(inboundOf(message({ text: "<@UBOT> help" }), bot)).toMatchObject({
      message: {
        address: "C1:200.000100",
        replyContext: { user: "U1", request: "<@UBOT> help" },
      },
      options: {},
    });
    expect(inboundOf(message({}), bot)).toBeUndefined();
    expect(
      inboundOf(message({ thread_ts: "1.1", bot_id: "B1" }), bot),
    ).toBeUndefined();
    expect(
      inboundOf(message({ thread_ts: "1.1", subtype: "message_changed" }), bot),
    ).toBeUndefined();
    expect(inboundOf({ type: "reaction_added" }, bot)).toBeUndefined();
  });

  it("runs thread messages without a mention when asked, only in threads that have a conversation", () => {
    const reply = message({ thread_ts: "100.000100", text: "and also" });
    expect(
      inboundOf(reply, { ...bot, threadMessages: "run" })?.options,
    ).toEqual({ run: true, create: false });
    expect(
      inboundOf(message({ text: "top level" }), {
        ...bot,
        threadMessages: "run",
      }),
    ).toBeUndefined();
  });

  it("decodes Slack's escapes, leaving mentions alone", () => {
    const escaped = message({
      channel: "D1",
      channel_type: "im",
      text: "<@UBOT> run `a &amp;&amp; b 2&gt;&amp;1 &lt;in`",
    });
    expect(inboundOf(escaped, bot)?.message.text).toBe(
      "<@UBOT> run `a && b 2>&1 <in`",
    );
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
    expect(inboundOf(shared, bot)).toMatchObject({
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
      options: {},
    });
  });

  it("notices a person renaming a session, and describes skipped events in one line", () => {
    expect(
      renamedThreadOf({
        type: "agent_session_title_changed",
        channel: "C1",
        thread_ts: "200.000100",
        title: "Mine",
        user: "U1",
      }),
    ).toEqual({ channel: "C1", threadTs: "200.000100" });
    expect(renamedThreadOf(message({}))).toBeUndefined();
    expect(
      describeEvent(message({ bot_id: "B1", subtype: "bot_message" })),
    ).toBe("message/bot_message C1 200.000100 from a bot");
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
