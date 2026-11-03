import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Channels, ChannelsHub } from "@aliou/pi-durable-channels";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  type Extension,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { serve } from "./serve";

export type Route = (request: Request, hub: ChannelsHub) => Promise<Response>;

export type RunOptions = {
  name: string;
  channels: Channels;
  models: Models;
  extensions: readonly Extension[];
  routes?: Record<string, Route>;
};

function serveRoutes(routes: Record<string, Route>, hub: ChannelsHub): void {
  serve(Number(process.env.PORT ?? 8787), async (request) => {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    return route === undefined
      ? new Response("Not Found", { status: 404 })
      : route(request, hub);
  });
}

export async function run(options: RunOptions): Promise<void> {
  const directory = process.env.DATA_DIR ?? join("tmp", options.name);
  await mkdir(directory, { recursive: true });
  const registry = createRegistry();
  registry.install(options.channels.extension);
  registry.install(options.channels.tools);
  for (const extension of options.extensions) registry.install(extension);
  const storage = await openNodeSqliteStorage(
    join(directory, "session.sqlite"),
  );
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry,
      onReport: (report) => console.error(report.kind, report.error),
    },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  const hub = options.channels.hub(harness);
  const stop = new AbortController();
  await hub.start(stop.signal);
  if (options.routes !== undefined) serveRoutes(options.routes, hub);
  process.once("SIGINT", () => {
    stop.abort();
    void harness.close(BACKGROUND_CONTEXT).then(() => process.exit(0));
  });
}
