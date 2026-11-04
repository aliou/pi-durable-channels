import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOT, fakeGitHub } from "../test/fake-github";
import { githubApi } from "./api";
import { appInstallation, personalToken } from "./auth";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function verified(authorization: string): Record<string, unknown> {
  const [header = "", claims = "", signature = ""] = authorization
    .replace("Bearer ", "")
    .split(".");
  const valid = createVerify("RSA-SHA256")
    .update(`${header}.${claims}`)
    .verify(publicKey, signature, "base64url");
  if (!valid) throw new Error("bad JWT signature");
  return JSON.parse(Buffer.from(claims, "base64url").toString());
}

describe("github auth", () => {
  it("uses a personal token as is and reads its login", async () => {
    const api = await fakeGitHub();
    const auth = personalToken("ghp-test", api.apiUrl);
    await expect(auth.token()).resolves.toBe("ghp-test");
    await expect(auth.login()).resolves.toBe(BOT);
  });

  it("mints installation tokens with an app JWT and reuses them until they near expiry", async () => {
    let minted = 0;
    const expiresIn = { ms: 60 * 60_000 };
    const api = await fakeGitHub({
      "GET /app": () => ({ status: 200, body: { slug: "factory" } }),
      "GET /repos/acme/app/installation": () => ({
        status: 200,
        body: { id: 9 },
      }),
      "POST /app/installations/9/access_tokens": () => {
        minted += 1;
        const expires = new Date(Date.now() + expiresIn.ms).toISOString();
        return {
          status: 201,
          body: { token: `ghs-${minted}`, expires_at: expires },
        };
      },
    });
    const auth = appInstallation({
      appId: "123",
      privateKey,
      repository: "acme/app",
      apiUrl: api.apiUrl,
    });
    const call = githubApi(auth.token, api.apiUrl);
    await Promise.all([call("GET", "/rate_limit"), call("GET", "/rate_limit")]);
    expect(minted).toBe(1);
    expect(
      api.calls
        .filter(({ path }) => path === "/rate_limit")
        .map(({ token }) => token),
    ).toEqual(["Bearer ghs-1", "Bearer ghs-1"]);

    const jwt = api.calls.find(({ path }) => path.startsWith("/repos/"));
    expect(verified(jwt?.token ?? "")).toMatchObject({ iss: "123" });
    await expect(auth.login()).resolves.toBe("factory[bot]");

    expiresIn.ms = 60_000;
    const shortLived = appInstallation({
      appId: "123",
      privateKey,
      repository: "acme/app",
      apiUrl: api.apiUrl,
    });
    await expect(shortLived.token()).resolves.toBe("ghs-2");
    await expect(shortLived.token()).resolves.toBe("ghs-3");
  });

  it("names the repository when the app is not installed on it", async () => {
    const api = await fakeGitHub({
      "GET /repos/acme/app/installation": () => ({ status: 404 }),
    });
    const auth = appInstallation({
      appId: "123",
      privateKey,
      repository: "acme/app",
      apiUrl: api.apiUrl,
    });
    await expect(auth.token()).rejects.toThrow(
      "GitHub GET /repos/acme/app/installation answered 404",
    );
  });
});
