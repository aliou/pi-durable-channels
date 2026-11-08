import type { NameThread } from "@aliou/pi-durable-channels-slack";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

const MAX_INPUT = 2_000;

export function threadNamer(
  models: Models,
  ref: ModelRef,
  prompt: string,
): NameThread {
  return async ({ request, answer }) => {
    const model = models.getModel(ref.provider, ref.modelId);
    if (model === undefined) return undefined;
    const content = `Request:\n${request.slice(0, MAX_INPUT)}\n\nAnswer:\n${answer.slice(0, MAX_INPUT)}`;
    const reply = await models.completeSimple(model, {
      systemPrompt: prompt,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    });
    const text = reply.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    const [title = ""] = text.trim().split("\n");
    return title.replace(/^["'`]+|["'`]+$/g, "").trim() || undefined;
  };
}
