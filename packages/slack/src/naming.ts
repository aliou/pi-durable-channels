import type { SlackCall } from "./api";
import { renameSession } from "./session";
import type { Thread } from "./target";

const MAX_INITIAL = 60;
const MAX_TITLE = 200;

export type NameThread = (input: {
  request: string;
  answer: string;
}) => Promise<string | undefined>;

export type Naming = {
  initial(request: string | undefined): string | undefined;
  answered(thread: Thread, request: string, answer: string): void;
  renamedByUser(thread: Thread): void;
};

const REJECTED = /[^\p{L}\p{N} .,\-_'"?!=|()&\u2014\u2019]/gu;

const key = (thread: Thread) => `${thread.channel}:${thread.threadTs}`;

export function sessionTitle(text: string, limit: number): string | undefined {
  const clean = text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(REJECTED, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") return undefined;
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}…` : clean;
}

function initial(request: string | undefined): string | undefined {
  return sessionTitle(request ?? "", MAX_INITIAL);
}

export function createNaming(
  call: SlackCall,
  nameThread: NameThread | undefined,
  onError: (thread: Thread) => (error: unknown) => void,
): Naming {
  const settled = new Set<string>();

  async function rename(thread: Thread, request: string, answer: string) {
    const title = await nameThread?.({ request, answer });
    const clean = sessionTitle(title ?? "", MAX_TITLE);
    if (clean !== undefined) await renameSession(call, thread, clean);
  }

  return {
    initial,
    answered: (thread, request, answer) => {
      if (nameThread === undefined || settled.has(key(thread))) return;
      settled.add(key(thread));
      void rename(thread, request, answer).catch(onError(thread));
    },
    renamedByUser: (thread) => {
      settled.add(key(thread));
    },
  };
}
