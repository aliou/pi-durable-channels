import { createSign } from "node:crypto";
import { compile, int, obj, str } from "@earendil-works/pi-schema";
import { GITHUB_API, githubApi, type TokenSource } from "./api";

export type GitHubAuth = {
  token: TokenSource;
  login(signal?: AbortSignal): Promise<string>;
};

export type AppOptions = {
  appId: string;
  privateKey: string;
  repository: string;
  apiUrl?: string;
};

type Minted = { token: string; expiresAt: number };

const REFRESH_MS = 5 * 60_000;

const Login = compile(obj({ login: str() }, { open: true }));
const App = compile(obj({ slug: str() }, { open: true }));
const Installation = compile(obj({ id: int() }, { open: true }));
const AccessToken = compile(
  obj({ token: str(), expires_at: str() }, { open: true }),
);

export function personalToken(value: string, apiUrl = GITHUB_API): GitHubAuth {
  const token = async () => value;
  const call = githubApi(token, apiUrl);
  return {
    token,
    login: async (signal) => {
      const user = await call("GET", "/user", undefined, signal);
      if (!Login.check(user)) throw new Error("GitHub /user returned no login");
      return user.login;
    },
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({ iat: now - 60, exp: now + 540, iss: appId });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(privateKey, "base64url");
  return `${header}.${claims}.${signature}`;
}

export function appInstallation(options: AppOptions): GitHubAuth {
  const asApp = githubApi(
    async () => appJwt(options.appId, options.privateKey),
    options.apiUrl ?? GITHUB_API,
  );
  let current: Promise<Minted> | undefined;

  async function mint(signal?: AbortSignal): Promise<Minted> {
    const path = `/repos/${options.repository}/installation`;
    const installation = await asApp("GET", path, undefined, signal);
    if (!Installation.check(installation))
      throw new Error(
        `The GitHub App is not installed on ${options.repository}`,
      );
    const tokens = `/app/installations/${installation.id}/access_tokens`;
    const created = await asApp("POST", tokens, {}, signal);
    if (!AccessToken.check(created))
      throw new Error("GitHub returned no installation token");
    return { token: created.token, expiresAt: Date.parse(created.expires_at) };
  }

  async function token(signal?: AbortSignal): Promise<string> {
    const known = current;
    const minted = await known?.catch(() => undefined);
    if (minted !== undefined && minted.expiresAt - Date.now() > REFRESH_MS)
      return minted.token;
    const pending =
      current === known || current === undefined ? mint(signal) : current;
    current = pending;
    const fresh = await pending;
    return fresh.token;
  }

  return {
    token,
    login: async (signal) => {
      const app = await asApp("GET", "/app", undefined, signal);
      if (!App.check(app)) throw new Error("GitHub /app returned no slug");
      return `${app.slug}[bot]`;
    },
  };
}
