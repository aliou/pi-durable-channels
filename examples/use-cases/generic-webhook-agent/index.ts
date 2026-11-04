import { readFile } from "node:fs/promises";
import { createChannels } from "@aliou/pi-durable-channels";
import { logReport } from "@examples/shared/log";
import { loadModel } from "@examples/shared/model";
import { adapterRoute, run } from "@examples/shared/run";
import { IGNORE } from "@examples/shared/sink";
import { inboxChannel } from "./src/adapter";
import { responderTools as createResponderTools } from "./src/tools";

const instructions = await readFile(
  new URL("instructions.md", import.meta.url),
  "utf8",
);
const { models, model } = loadModel((prompt) =>
  /fail|down|error/i.test(prompt)
    ? "PAGE: the source reports a failure. Check the latest deploy first."
    : IGNORE,
);

const responderTools = createResponderTools(
  (process.env.CHECK_URL_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
);

const inbox = inboxChannel({ pagerUrl: process.env.PAGER_URL });

const channels = createChannels({
  channels: {
    inbox: {
      adapter: inbox,
      conversation: () => ({
        agent: { model, instructions, extensions: [responderTools] },
      }),
    },
  },
  onReport: logReport,
});

await run({
  name: "generic-webhook-agent",
  channels,
  models,
  extensions: [responderTools],
  routes: { "POST /inbox": adapterRoute(inbox) },
});
