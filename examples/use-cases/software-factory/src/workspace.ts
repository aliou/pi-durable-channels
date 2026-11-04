import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ConversationId,
  HarnessOptions,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createGit, type TokenSource } from "./git";

export type WorkspaceOptions = {
  root: string;
  remote: string;
  base: string;
  token?: TokenSource;
  author: { name: string; email: string };
};

export type Changes = { uncommitted: boolean; commits: number };

export type Workspace = {
  prepare(): Promise<void>;
  branch(id: ConversationId): string;
  worktree(id: ConversationId): Promise<string>;
  changes(id: ConversationId): Promise<Changes>;
  push(id: ConversationId): Promise<void>;
  env: NonNullable<HarnessOptions["env"]>;
};

const SCRATCH = "scratch/";

async function ignoreScratch(repo: string): Promise<void> {
  const exclude = join(repo, ".git", "info", "exclude");
  const current = await readFile(exclude, "utf8").catch(() => "");
  if (current.split("\n").includes(SCRATCH)) return;
  await mkdir(join(repo, ".git", "info"), { recursive: true });
  await appendFile(exclude, `\n${SCRATCH}\n`);
}

export function createWorkspace(options: WorkspaceOptions): Workspace {
  const git = createGit(options.remote, options.token);
  const root = resolve(options.root);
  const repo = join(root, "repo");
  const base = `origin/${options.base}`;
  const trees = new Map<ConversationId, Promise<string>>();
  let queue: Promise<unknown> = Promise.resolve();

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }

  const branch = (id: ConversationId) => `factory/${id}`;

  async function prepare(): Promise<void> {
    if (!existsSync(join(repo, ".git"))) {
      await mkdir(root, { recursive: true });
      await git(["clone", "--no-checkout", options.remote, repo], root);
    }
    await ignoreScratch(repo);
    await git(["config", "user.name", options.author.name], repo);
    await git(["config", "user.email", options.author.email], repo);
  }

  async function create(id: ConversationId): Promise<string> {
    const path = join(root, "worktrees", String(id));
    if (existsSync(path)) return path;
    await git(["fetch", "origin", options.base], repo);
    await git(["worktree", "add", "-B", branch(id), path, base], repo);
    return path;
  }

  function worktree(id: ConversationId): Promise<string> {
    const known = trees.get(id);
    if (known !== undefined) return known;
    const created = serial(() => create(id));
    trees.set(id, created);
    created.catch(() => trees.delete(id));
    return created;
  }

  async function changes(id: ConversationId): Promise<Changes> {
    const path = await worktree(id);
    const status = await git(["status", "--porcelain"], path);
    const ahead = await git(["rev-list", "--count", `${base}..HEAD`], path);
    return { uncommitted: status !== "", commits: Number(ahead) };
  }

  async function push(id: ConversationId): Promise<void> {
    const path = await worktree(id);
    const target = `HEAD:refs/heads/${branch(id)}`;
    await git(["push", options.remote, target], path);
  }

  return {
    prepare,
    branch,
    worktree,
    changes,
    push,
    env: async ({ conversationId }) =>
      new NodeExecutionEnv({ cwd: await worktree(conversationId) }),
  };
}
