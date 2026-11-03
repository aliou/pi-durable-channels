export async function readBytes(
  source: { body: ReadableStream<Uint8Array<ArrayBuffer>> | null },
  limit: number,
): Promise<Blob | undefined> {
  const reader = source.body?.getReader();
  if (reader === undefined) return new Blob([]);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

export async function readBody(
  request: Request,
  limit: number,
): Promise<string | undefined> {
  const blob = await readBytes(request, limit);
  return blob?.text();
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
