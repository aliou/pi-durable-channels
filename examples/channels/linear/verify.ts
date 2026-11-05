import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLinearSignature(
  secret: string,
  signature: string | null,
  body: string,
): boolean {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  const expected = Buffer.from(digest, "hex");
  const given = Buffer.from(signature ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function isStaleTimestamp(
  timestamp: number,
  now: number,
  windowMs: number,
): boolean {
  return windowMs > 0 && Math.abs(now - timestamp) > windowMs;
}
