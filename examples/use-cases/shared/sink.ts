import type { OutboundMessage, SendContext } from "@aliou/pi-durable-channels";

export const IGNORE = "IGNORE";

export function postTo(url: string | undefined) {
  return async (
    message: OutboundMessage,
    ctx: SendContext,
  ): Promise<undefined> => {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    if (text === "" || text.trim() === IGNORE) return;
    if (url === undefined) {
      console.log(
        `\n--- ${message.address} (${ctx.idempotencyKey})\n${text}\n`,
      );
      return;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": ctx.idempotencyKey,
      },
      body: JSON.stringify({ text: `*${message.address}*\n${text}` }),
      redirect: "error",
      signal: ctx.signal,
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  };
}
