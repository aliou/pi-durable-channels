import type { SlackCall } from "./api";
import type { Thread } from "./target";

export type SessionStatus = "processing" | "active" | "suspended";

export async function setSessionStatus(
  call: SlackCall,
  thread: Thread,
  status: SessionStatus,
  initiator?: string,
): Promise<void> {
  await call("agents.sessions.setStatus", {
    channel_id: thread.channel,
    thread_ts: thread.threadTs,
    status,
    ...(initiator === undefined ? {} : { initiator_user_id: initiator }),
  });
}
