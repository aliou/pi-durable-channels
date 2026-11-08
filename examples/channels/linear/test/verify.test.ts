import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isStaleTimestamp, verifyLinearSignature } from "../verify";

const SECRET = "secret";

function signed(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyLinearSignature", () => {
  it("accepts a valid hex signature", () => {
    expect(verifyLinearSignature(SECRET, signed("body"), "body")).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, and a missing header", () => {
    expect(verifyLinearSignature("other", signed("body"), "body")).toBe(false);
    expect(verifyLinearSignature(SECRET, signed("body"), "body2")).toBe(false);
    expect(verifyLinearSignature(SECRET, null, "body")).toBe(false);
  });
});

describe("isStaleTimestamp", () => {
  it("accepts timestamps inside the window and rejects older ones", () => {
    const now = 1_000_000;
    expect(isStaleTimestamp(now - 59_000, now, 60_000)).toBe(false);
    expect(isStaleTimestamp(now + 59_000, now, 60_000)).toBe(false);
    expect(isStaleTimestamp(now - 61_000, now, 60_000)).toBe(true);
    expect(isStaleTimestamp(now + 61_000, now, 60_000)).toBe(true);
  });

  it("never rejects when the window is disabled", () => {
    expect(isStaleTimestamp(0, 1_000_000, 0)).toBe(false);
  });
});
