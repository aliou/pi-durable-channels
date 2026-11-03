import { compile, obj, str } from "@earendil-works/pi-schema";
import type { SlackCall } from "./api";
import type { Recipient } from "./events";
import type { SessionStatus } from "./session";
import type { Thread } from "./target";

const Started = compile(obj({ ts: str() }, { open: true }));

export type StreamTarget = Thread & { recipient?: Recipient };

type Stream = {
  target: StreamTarget;
  ts?: string;
  segment: string;
  chain: Promise<void>;
};

function recipientFields(target: StreamTarget): Record<string, string> {
  const { recipient } = target;
  if (target.channel.startsWith("D") || recipient?.team === undefined)
    return {};
  return {
    recipient_user_id: recipient.user,
    recipient_team_id: recipient.team,
  };
}

function deltaOf(segment: string, text: string): string {
  return text.startsWith(segment) ? text.slice(segment.length) : `\n\n${text}`;
}

function canStream(target: StreamTarget): boolean {
  return target.channel.startsWith("D") || target.recipient?.team !== undefined;
}

export function createStreams(
  call: SlackCall,
  onError: (error: unknown) => void,
) {
  const streams = new Map<string, Stream>();

  async function open(stream: Stream, text: string): Promise<void> {
    const started = await call("chat.startStream", {
      channel: stream.target.channel,
      thread_ts: stream.target.threadTs,
      markdown_text: text,
      ...recipientFields(stream.target),
    });
    if (!Started.check(started))
      throw new Error("Slack chat.startStream returned no ts");
    stream.ts = started.ts;
    stream.segment = text;
  }

  async function push(stream: Stream, text: string): Promise<void> {
    if (stream.ts === undefined) return open(stream, text);
    const delta = deltaOf(stream.segment, text);
    if (delta === "") return;
    await call("chat.appendStream", {
      channel: stream.target.channel,
      ts: stream.ts,
      markdown_text: delta,
    });
    stream.segment = text;
  }

  function text(key: string, target: StreamTarget, value: string): void {
    if (!canStream(target)) return;
    const stream = streams.get(key) ?? {
      target,
      segment: "",
      chain: Promise.resolve(),
    };
    streams.set(key, stream);
    stream.chain = stream.chain.then(() => push(stream, value)).catch(onError);
  }

  async function stop(
    key: string,
    end: { text?: string; status: SessionStatus },
  ): Promise<boolean> {
    const stream = streams.get(key);
    streams.delete(key);
    await stream?.chain;
    if (stream?.ts === undefined) return false;
    const tail =
      end.text === undefined ? "" : deltaOf(stream.segment, end.text);
    await call("chat.stopStream", {
      channel: stream.target.channel,
      ts: stream.ts,
      session_status: end.status,
      ...(tail === "" ? {} : { markdown_text: tail }),
    });
    return true;
  }

  return { text, stop };
}
