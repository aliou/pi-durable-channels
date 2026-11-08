import type {
  DeliverOptions,
  InboundMessage,
} from "@aliou/pi-durable-channels";
import {
  compile,
  lit,
  nullable,
  obj,
  opt,
  str,
} from "@earendil-works/pi-schema";
import { sessionAddress } from "./address";

const UserRef = obj(
  { id: str(), name: opt(nullable(str())), displayName: opt(nullable(str())) },
  { open: true },
);
const IssueRef = obj(
  {
    identifier: opt(str()),
    title: opt(str()),
    description: opt(nullable(str())),
  },
  { open: true },
);
const CommentRef = obj({ id: str(), body: str() }, { open: true });
const PromptContent = obj({ type: lit("prompt"), body: str() }, { open: true });
const Activity = obj(
  {
    id: str(),
    content: PromptContent,
    signal: opt(nullable(str())),
    user: UserRef,
  },
  { open: true },
);
const Session = obj(
  {
    id: str(),
    issue: opt(IssueRef),
    comment: opt(CommentRef),
    creator: opt(UserRef),
  },
  { open: true },
);
const AgentSessionEvent = compile(
  obj(
    {
      type: lit("AgentSessionEvent"),
      action: str(),
      appUserId: str(),
      agentSession: Session,
      agentActivity: opt(Activity),
      promptContext: opt(nullable(str())),
    },
    { open: true },
  ),
);

export type LinearInbound =
  | { kind: "message"; message: InboundMessage; options: DeliverOptions }
  | { kind: "stop"; address: string };

function nameOf(
  user: { name?: string | null; displayName?: string | null } | undefined,
): string {
  return user?.displayName ?? user?.name ?? "linear";
}

function lines(...parts: (string | null | undefined)[]): string {
  return parts.filter((part) => (part ?? "") !== "").join("\n");
}

function created(
  payload: unknown,
  requestId: string,
): LinearInbound | undefined {
  if (!AgentSessionEvent.check(payload)) return undefined;
  const session = payload.agentSession;
  const author = nameOf(session.creator);
  const issue = session.issue;
  const prompt =
    payload.promptContext ??
    lines(
      issue && `Issue ${issue.identifier ?? ""} ${issue.title ?? ""}`.trim(),
      issue?.description,
      session.comment && `@${author}: ${session.comment.body}`,
    );
  if (prompt === "") return undefined;
  return {
    kind: "message",
    message: {
      address: sessionAddress(session.id),
      text: prompt,
      requestId,
      author,
      event: "agent_session.created",
    },
    options: {},
  };
}

function prompted(
  payload: unknown,
  requestId: string,
): LinearInbound | undefined {
  if (!AgentSessionEvent.check(payload)) return undefined;
  const session = payload.agentSession;
  const activity = payload.agentActivity;
  if (activity === undefined) return undefined;
  const address = sessionAddress(session.id);
  if (activity.signal === "stop") return { kind: "stop", address };
  return {
    kind: "message",
    message: {
      address,
      text: activity.content.body,
      requestId,
      author: nameOf(activity.user),
      event: "agent_session.prompted",
    },
    options: {},
  };
}

export function inboundOf(
  payload: unknown,
  requestId: string,
): LinearInbound[] {
  if (!AgentSessionEvent.check(payload)) return [];
  if (payload.action === "created") {
    const inbound = created(payload, requestId);
    return inbound === undefined ? [] : [inbound];
  }
  if (payload.action === "prompted") {
    const inbound = prompted(payload, requestId);
    return inbound === undefined ? [] : [inbound];
  }
  return [];
}
