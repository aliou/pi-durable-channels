import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TIMEOUT_MS = 120_000;

export type Git = (args: readonly string[], cwd: string) => Promise<string>;

function tokenHelper(host: string): string {
  return [
    '!f() { test "$1" = get || exit 0;',
    `grep -qx "host=${host}" || exit 0;`,
    "echo username=x-access-token;",
    'echo "password=$FACTORY_GIT_TOKEN"; }; f',
  ].join(" ");
}

export type TokenSource = () => Promise<string>;

function authArgs(remote: string, token: TokenSource | undefined): string[] {
  if (token === undefined || !remote.startsWith("https://")) return [];
  const helper = tokenHelper(new URL(remote).host);
  return ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];
}

async function environment(token: TokenSource | undefined) {
  const secret =
    token === undefined ? {} : { FACTORY_GIT_TOKEN: await token() };
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", ...secret };
}

export function createGit(remote: string, token: TokenSource | undefined): Git {
  const args = ["-c", "core.hooksPath=/dev/null", ...authArgs(remote, token)];
  return async (command, cwd) => {
    const env = await environment(token);
    const { stdout } = await exec("git", [...args, ...command], {
      cwd,
      env,
      timeout: TIMEOUT_MS,
    });
    return stdout.trim();
  };
}
