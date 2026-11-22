import { describe, expect, it } from "vitest";
import { message, SECRET, signed } from "../test/fake-slack";
import type { SlackConfig } from "./config";
import {
  describeEvent,
  inboundOf,
  mentionsBot,
  renamedThreadOf,
  slackMessageOf,
  stoppedAddressOf,
} from "./events";
import { slackTarget } from "./target";
import { verifySlackSignature } from "./verify";

const config: SlackConfig = {
  scope: "thread",
  trigger: "mention",
  context: { maxMessages: 20, maxBytes: 20_000, maxFiles: 5 },
  readTool: true,
};

function parsed(fields: Record<string, unknown> = {}) {
  const event = slackMessageOf(message(fields));
  if (event === undefined) throw new Error("message was rejected");
  return event;
}

describe("slack events", () => {
  it("filters bot messages and unsupported subtypes", () => {
    expect(slackMessageOf(message({ bot_id: "B1" }))).toBeUndefined();
    expect(
      slackMessageOf(message({ subtype: "message_changed" })),
    ).toBeUndefined();
    expect(slackMessageOf({ type: "reaction_added" })).toBeUndefined();
    expect(mentionsBot(parsed({ text: "<@UBOT> help" }), "UBOT")).toBe(true);
  });

  it("maps thread scope and keeps the triggering reply thread", () => {
    expect(inboundOf(parsed({ text: "<@UBOT> help" }), config)).toEqual({
      message: {
        address: "C1:200.000100",
        text: "<@UBOT> help",
        requestId: "slack:C1:200.000100",
        author: "U1",
        replyContext: {
          user: "U1",
          request: "<@UBOT> help",
          threadTs: "200.000100",
        },
        files: [],
      },
      options: { run: true, create: true },
    });
    expect(
      inboundOf(parsed({ thread_ts: "100.000100", text: "and also" }), config),
    ).toMatchObject({
      message: { address: "C1:100.000100" },
      options: { run: true, create: true },
    });
    expect(
      inboundOf(parsed({ thread_ts: "100.000100" }), {
        ...config,
        trigger: "every_message",
      }).options,
    ).toEqual({ run: true, create: false });
  });

  it("maps conversation scope to bare roots and thread aliases", () => {
    const shared = { ...config, scope: "conversation" as const };
    expect(inboundOf(parsed(), shared).message).toMatchObject({
      address: "C1",
    });
    expect(
      inboundOf(parsed({ thread_ts: "100.000100" }), shared).message,
    ).toMatchObject({ address: "C1:100.000100", conversationAddress: "C1" });
    expect(
      inboundOf(parsed({ thread_ts: "100.000100" }), {
        ...shared,
        trigger: "every_message",
      }).options,
    ).toEqual({ run: true, create: true });
  });

  it("decodes Slack's escapes and passes files on", () => {
    const event = parsed({
      channel: "D1",
      channel_type: "im",
      subtype: "file_share",
      text: "<@UBOT> run `a &amp;&amp; b 2&gt;&amp;1 &lt;in`",
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
    expect(inboundOf(event, config).message).toMatchObject({
      text: "<@UBOT> run `a && b 2>&1 <in`",
      files: [
        {
          name: "report.pdf",
          mimeType: "application/pdf",
          url: "https://files.slack.com/files-pri/T1-F1/report.pdf",
        },
      ],
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

  it("targets timestamp threads, keyed threads, and bare conversations", () => {
    expect(slackTarget("C1:100.000100", undefined)).toEqual({
      channel: "C1",
      threadTs: "100.000100",
    });
    expect(slackTarget("C1:cus_acme", undefined)).toEqual({ channel: "C1" });
    expect(slackTarget("C1:cus_acme", { threadTs: "5.5" })).toEqual({
      channel: "C1",
      threadTs: "5.5",
    });
    expect(slackTarget("C1", undefined)).toEqual({ channel: "C1" });
    expect(slackTarget("C1", undefined, { threadTs: "5.5" })).toEqual({
      channel: "C1",
      threadTs: "5.5",
    });
  });
});
