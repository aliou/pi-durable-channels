import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";

export type ScriptedAnswer = (prompt: string) => string;

function lastPrompt(
  messages: readonly { role: string; content: unknown }[],
): string {
  const last = messages.filter((message) => message.role === "user").at(-1);
  return typeof last?.content === "string"
    ? last.content
    : JSON.stringify(last?.content ?? "");
}

export function loadModel(scripted: ScriptedAnswer): {
  models: Models;
  model: ModelRef;
} {
  const spec = process.env.MODEL;
  if (spec === undefined)
    throw new Error(
      "Set MODEL to provider/modelId, for example anthropic/claude-sonnet-4-5, or faux/faux-1",
    );
  const [provider, ...rest] = spec.split("/");
  const model = { provider: provider ?? "", modelId: rest.join("/") };
  const models = createModels();
  if (model.provider !== "faux") {
    for (const each of builtinProviders()) models.setProvider(each);
    return { models, model };
  }
  const faux = fauxProvider();
  const answer = (transcript: {
    messages: readonly { role: string; content: unknown }[];
  }): AssistantMessage =>
    fauxAssistantMessage(scripted(lastPrompt(transcript.messages)));
  faux.setResponses(Array.from({ length: 1000 }, () => answer));
  models.setProvider(faux.provider);
  return { models, model };
}
