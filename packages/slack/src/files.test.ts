import { describe, expect, it } from "vitest";
import { fakeSlack } from "../test/fake-slack";
import { fetchSlackFile } from "./files";

describe("slack files", () => {
  it("downloads with the bot token from Slack's file host only", async () => {
    const { origin, calls } = await fakeSlack({ "/files/report.pdf": "%PDF" });
    const access = { botToken: "xoxb-test", origin, maxBytes: 1024 };
    const bytes = await fetchSlackFile(`${origin}/files/report.pdf`, access);
    expect(new TextDecoder().decode(bytes)).toBe("%PDF");
    await expect(
      fetchSlackFile("http://other.test/report.pdf", access),
    ).rejects.toThrow("not on Slack's file host");
    expect(calls).toEqual([
      { method: "GET /files/report.pdf", token: "Bearer xoxb-test", body: {} },
    ]);
  });

  it("refuses files over the size limit", async () => {
    const { origin } = await fakeSlack({ "/files/big.bin": "x".repeat(64) });
    const access = { botToken: "xoxb-test", origin, maxBytes: 16 };
    await expect(
      fetchSlackFile(`${origin}/files/big.bin`, access),
    ).rejects.toThrow("too large");
  });
});
