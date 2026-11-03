import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SECONDS = 300;

export function verifySlackSignature(
  secret: string,
  headers: Headers,
  body: string,
  now = Date.now(),
): boolean {
  const timestamp = Number(headers.get("x-slack-request-timestamp"));
  const skew = Math.abs(now / 1000 - timestamp);
  if (!(skew <= MAX_SKEW_SECONDS)) return false;
  const digest = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  const expected = Buffer.from(`v0=${digest}`);
  const given = Buffer.from(headers.get("x-slack-signature") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
