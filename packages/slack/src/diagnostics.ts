import type { AdapterStart } from "@aliou/pi-durable-channels";
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema";
import { SlackApiError, type SlackCall, slackApi } from "./api";

const REQUIRED_EVENTS = [
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
];
const OPTIONAL_EVENTS = [
  "agent_session_stopped",
  "agent_session_title_changed",
];
const REQUIRED_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
];
const NOTICE_CODES = new Set([
  "missing_scope",
  "not_in_channel",
  "channel_not_found",
]);
const MAX_NOTICES = 1000;

const Manifest = compile(
  obj(
    {
      manifest: obj(
        {
          settings: obj(
            {
              event_subscriptions: obj(
                { bot_events: opt(arr(str())) },
                { open: true },
              ),
            },
            { open: true },
          ),
          oauth_config: obj(
            { scopes: obj({ bot: opt(arr(str())) }, { open: true }) },
            { open: true },
          ),
        },
        { open: true },
      ),
    },
    { open: true },
  ),
);

function missing(required: readonly string[], actual: readonly string[]) {
  return required.filter((item) => !actual.includes(item));
}

export async function validateManifest(input: {
  appId: string | undefined;
  configToken: string | undefined;
  apiUrl: string;
  report: AdapterStart["report"];
  signal: AbortSignal;
}): Promise<void> {
  if (input.appId === undefined || input.configToken === undefined) return;
  const call = slackApi(input.configToken, input.apiUrl);
  let response: Record<string, unknown>;
  try {
    response = await call(
      "apps.manifest.export",
      { app_id: input.appId },
      input.signal,
    );
  } catch (error) {
    input.report({ kind: "adapter_error", error });
    return;
  }
  if (!Manifest.check(response))
    throw new Error("Slack apps.manifest.export returned no usable manifest");
  const events =
    response.manifest.settings.event_subscriptions.bot_events ?? [];
  const scopes = response.manifest.oauth_config.scopes.bot ?? [];
  const missingEvents = missing(REQUIRED_EVENTS, events);
  const missingScopes = missing(REQUIRED_SCOPES, scopes);
  if (missingEvents.length > 0)
    throw new Error(
      `Slack app manifest lacks events: ${missingEvents.join(", ")}`,
    );
  if (missingScopes.length > 0)
    throw new Error(
      `Slack app manifest lacks scopes: ${missingScopes.join(", ")}`,
    );
  const optional = missing(OPTIONAL_EVENTS, events);
  if (optional.length > 0)
    input.report({
      kind: "adapter_error",
      error: new Error(
        `Slack app manifest lacks optional events: ${optional.join(", ")}`,
      ),
    });
}

function remedy(error: SlackApiError): string {
  if (error.code === "not_in_channel")
    return "Invite the bot to the conversation.";
  if (error.code === "channel_not_found")
    return "Check the conversation ID and the bot's access.";
  return `Grant the scope required by ${error.method} and reinstall the app.`;
}

export function createDiagnostics(
  call: SlackCall,
  report: AdapterStart["report"],
) {
  const notices = new Set<string>();

  return (error: unknown, address?: string): void => {
    report({
      kind: "adapter_error",
      error,
      ...(address === undefined ? {} : { address }),
    });
    if (!(error instanceof SlackApiError) || !NOTICE_CODES.has(error.code))
      return;
    if (address === undefined || error.method === "chat.postMessage") return;
    const key = `${address}:${error.method}:${error.code}`;
    if (notices.has(key)) return;
    if (notices.size >= MAX_NOTICES) {
      const [oldest] = notices;
      if (oldest !== undefined) notices.delete(oldest);
    }
    notices.add(key);
    const separator = address.indexOf(":");
    const channel = separator < 0 ? address : address.slice(0, separator);
    const text = `Slack adapter issue in ${error.method}: ${error.code}. ${remedy(error)}`;
    void call("chat.postMessage", { channel, markdown_text: text }).catch(
      (noticeError) =>
        report({ kind: "adapter_error", error: noticeError, address }),
    );
  };
}
