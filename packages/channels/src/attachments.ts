import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type ConversationId,
  type DocumentReader,
  type HarnessOptions,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import type { ChannelAdapter, InboundFile, InboundMessage } from "./types";

const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type EnvBuilder = NonNullable<HarnessOptions["env"]>;

type FileSource = {
  adapter: ChannelAdapter;
  env: ExecutionEnv | undefined;
  requestId: string;
};

export type ContentSource = {
  adapter: ChannelAdapter;
  env: EnvBuilder | undefined;
  read: DocumentReader;
  conversationId: ConversationId;
};

function safeName(name: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = last.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? "file" : cleaned;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function save(
  env: ExecutionEnv,
  folder: string,
  file: InboundFile,
  bytes: Uint8Array,
  context: Context,
): Promise<string> {
  const dir = await env.joinPath([env.cwd, folder], context);
  if (!dir.ok) throw dir.error;
  const created = await env.createDir(dir.value, { recursive: true }, context);
  if (!created.ok) throw created.error;
  const path = await env.joinPath([dir.value, safeName(file.name)], context);
  if (!path.ok) throw path.error;
  const written = await env.writeFile(path.value, bytes, context);
  if (!written.ok) throw written.error;
  return path.value;
}

function imagesOf(file: InboundFile, bytes: Uint8Array): ImageContent[] {
  if (!INLINE_IMAGE_TYPES.has(file.mimeType)) return [];
  const data = Buffer.from(bytes).toString("base64");
  if (data.length > DEFAULT_IMAGE_LIMITS.maxBytes) return [];
  return [{ type: "image", data, mimeType: file.mimeType }];
}

async function placed(
  file: InboundFile,
  bytes: Uint8Array,
  source: FileSource,
  context: Context,
): Promise<string> {
  const label = `${file.name} (${file.mimeType})`;
  if (source.env === undefined)
    return `Attached file ${label}, not saved: no environment`;
  const folder = `.channels/attachments/${attachmentKey(source.requestId, file.url)}`;
  const path = await save(source.env, folder, file, bytes, context).catch(
    (error: unknown) => error,
  );
  if (typeof path !== "string")
    return `Attached file ${label}, not saved: ${messageOf(path)}`;
  return `Attached file ${path} (${file.mimeType})`;
}

type Attached = { line: string; images: ImageContent[] };

async function attach(
  file: InboundFile,
  source: FileSource,
  context: Context,
): Promise<Attached> {
  const label = `${file.name} (${file.mimeType})`;
  if (source.adapter.fetchFile === undefined)
    return { line: `Attached file ${label}, not downloaded`, images: [] };
  const bytes = await source.adapter
    .fetchFile(file.url)
    .catch((error: unknown) => error);
  if (!(bytes instanceof Uint8Array)) {
    const line = `Attached file ${label}, not downloaded: ${messageOf(bytes)}`;
    return { line, images: [] };
  }
  const line = await placed(file, bytes, source, context);
  return { line, images: imagesOf(file, bytes) };
}

function attachmentKey(requestId: string, url: string): string {
  const hash = createHash("sha256").update(JSON.stringify([requestId, url]));
  return hash.digest("hex").slice(0, 16);
}

async function conversationEnv(
  source: ContentSource,
  context: Context,
): Promise<ExecutionEnv | undefined> {
  if (source.env === undefined) return undefined;
  const { conversationId, read } = source;
  const agent = await read.snapshot(AgentDoc, conversationId, context);
  const cwd = agent?.cwd;
  const target = {
    conversationId,
    read,
    ...(cwd === undefined ? {} : { cwd }),
  };
  return source.env(target, context);
}

export async function messageContent(
  message: InboundMessage,
  source: ContentSource,
  context: Context,
): Promise<UserInput> {
  const files = message.files ?? [];
  if (files.length === 0) return message.text;
  const env = await conversationEnv(source, context);
  const fileSource = {
    adapter: source.adapter,
    env,
    requestId: message.requestId,
  };
  const lines = [message.text];
  const images: ImageContent[] = [];
  for (const file of files) {
    const attached = await attach(file, fileSource, context);
    lines.push(attached.line);
    images.push(...attached.images);
  }
  const text: TextContent = { type: "text", text: lines.join("\n") };
  return [text, ...images];
}
