import { ChannelsDoc, findBinding } from "@aliou/pi-durable-channels";
import {
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { parseSessionAddress } from "./address";
import { LINEAR_API, linearApi } from "./api";

export type LinearToolsOptions = {
  token: string;
  apiUrl?: string;
  channel?: string;
};

const ELICIT_MUTATION = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity { id }
  }
}`;

function text(value: string, isError = false) {
  return { output: [{ type: "text" as const, text: value }], isError };
}

export function linearTools(options: LinearToolsOptions): Extension {
  const channel = options.channel ?? "linear";
  const call = linearApi(options.token, options.apiUrl ?? LINEAR_API);

  const elicit = defineTool({
    name: "elicit",
    description:
      "Ask the Linear user you are working with a clarifying question. Posts an elicitation to their agent session; their answer arrives as a new message in this conversation. End your turn after calling this: call no_reply without writing text, so the question stays open. Use options to offer fixed choices.",
    parameters: obj({
      address: str(),
      body: str(),
      options: opt(arr(obj({ label: str(), value: str() }, { open: true }))),
    }),
    execute: async (args, api, context) => {
      const state = await api.snapshot(ChannelsDoc, context);
      const binding = findBinding(state, { channel, address: args.address });
      if (binding?.conversationId !== api.conversationId)
        return text(
          `Unknown address ${args.address} on channel ${channel}.`,
          true,
        );
      const choices = args.options ?? [];
      await call(
        ELICIT_MUTATION,
        {
          input: {
            agentSessionId: parseSessionAddress(args.address),
            content: { type: "elicitation", body: args.body },
            ...(choices.length === 0
              ? {}
              : { signal: "select", signalMetadata: { options: choices } }),
          },
        },
        AbortSignal.timeout(30_000),
      );
      return text(
        `Elicitation posted to ${args.address}. Call no_reply without writing text; the answer arrives as a new message.`,
      );
    },
  });

  return defineExtension({
    name: "linear-tools",
    tools: [elicit],
  });
}
