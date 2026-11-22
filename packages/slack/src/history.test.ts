import { describe, expect, it } from "vitest";
import { fakeSlack, message } from "../test/fake-slack";
import { slackApi } from "./api";
import { readHistory } from "./history";

const limits = { maxMessages: 2, maxBytes: 500, maxFiles: 1 };
const signal = () => new AbortController().signal;

describe("slack history", () => {
  it("uses numeric range bounds, keeps the latest messages, and filters bot posts", async () => {
    const api = await fakeSlack(
      {},
      {
        respond: (method, _body, fallback) =>
          method === "conversations.replies"
            ? {
                ok: true,
                messages: [
                  message({ ts: "9.9", text: "too old" }),
                  message({ ts: "10.05", text: "older retained" }),
                  message({ ts: "10.07", text: "omitted middle" }),
                  message({ ts: "10.1", text: "latest retained" }),
                  message({ ts: "10.15", text: "bot", bot_id: "B1" }),
                  message({ ts: "10.2", text: "trigger" }),
                ],
              }
            : fallback,
      },
    );
    const call = slackApi("xoxb-test", api.apiUrl);
    const result = await readHistory(call, {
      botUserId: "UBOT",
      address: "C1:1.1",
      after: "9.9",
      before: "10.2",
      limits,
      signal: signal(),
    });
    expect(result.content).toContain("omitted middle");
    expect(result.content).toContain("latest retained");
    expect(result.content).not.toContain("too old");
    expect(result.content).not.toContain("trigger");
    expect(result.content).not.toContain("bot");
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe("10.07");
    expect(api.calls[0]?.body).toMatchObject({
      channel: "C1",
      ts: "1.1",
      oldest: "9.9",
      latest: "10.2",
      limit: 3,
    });
  });

  it("bounds files and UTF-8 bytes and reports omissions", async () => {
    const api = await fakeSlack(
      {},
      {
        respond: (method, _body, fallback) =>
          method === "conversations.history"
            ? {
                ok: true,
                messages: [
                  message({
                    ts: "2.1",
                    text: "\u{1F642}".repeat(30),
                    files: [
                      {
                        id: "F1",
                        name: "one.txt",
                        url_private: "https://files.slack.com/one",
                      },
                      {
                        id: "F2",
                        name: "two.txt",
                        url_private: "https://files.slack.com/two",
                      },
                    ],
                  }),
                ],
              }
            : fallback,
      },
    );
    const call = slackApi("xoxb-test", api.apiUrl);
    const result = await readHistory(call, {
      botUserId: "UBOT",
      address: "C1",
      limits: { maxMessages: 5, maxBytes: 200, maxFiles: 1 },
      signal: signal(),
    });
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(200);
    expect(result.content).not.toContain("two.txt");
    expect(result.content).toContain("omitted");
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(api.calls[0]?.method).toBe("conversations.history");
  });

  it("advances past a truncated page containing only filtered messages", async () => {
    const api = await fakeSlack(
      {},
      {
        respond: (method, _body, fallback) =>
          method === "conversations.history"
            ? {
                ok: true,
                has_more: true,
                messages: [
                  message({ ts: "4.1", text: "new bot", bot_id: "B1" }),
                  message({ ts: "3.1", text: "old bot", bot_id: "B1" }),
                ],
              }
            : fallback,
      },
    );
    const call = slackApi("xoxb-test", api.apiUrl);
    const result = await readHistory(call, {
      botUserId: "UBOT",
      address: "C1",
      limits,
      signal: signal(),
    });
    expect(result).toMatchObject({
      content: expect.stringContaining("history was omitted"),
      cursor: "3.1",
      truncated: true,
    });
  });
});
