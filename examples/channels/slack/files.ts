import { readBytes } from "./body";

const TIMEOUT_MS = 30_000;

export type FileAccess = { botToken: string; origin: string; maxBytes: number };

export async function fetchSlackFile(
  url: string,
  access: FileAccess,
): Promise<Uint8Array> {
  if (new URL(url).origin !== access.origin)
    throw new Error("file is not on Slack's file host");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${access.botToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Slack file download answered ${response.status}`);
  const blob = await readBytes(response, access.maxBytes);
  if (blob === undefined) throw new Error("file is too large");
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
