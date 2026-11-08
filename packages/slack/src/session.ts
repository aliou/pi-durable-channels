import type { SlackCall } from "./api";
import type { Thread } from "./target";

export type SessionStatus = "processing" | "active" | "suspended";

export type SessionStart = { initiator?: string; title?: string };

export async function setSessionStatus(
  call: SlackCall,
  thread: Thread,
  status: SessionStatus,
  start: SessionStart = {},
): Promise<void> {
  await call("agents.sessions.setStatus", {
    channel_id: thread.channel,
    thread_ts: thread.threadTs,
    status,
    ...(start.initiator === undefined
      ? {}
      : { initiator_user_id: start.initiator }),
    ...(start.title === undefined ? {} : { title: start.title }),
  });
}

export async function renameSession(
  call: SlackCall,
  thread: Thread,
  title: string,
): Promise<void> {
  await call("agents.sessions.rename", {
    channel_id: thread.channel,
    thread_ts: thread.threadTs,
    title,
  });
}
