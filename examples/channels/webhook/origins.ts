export type OriginMatcher = (url: URL) => boolean;

const INVALID =
  "Allowed origins are http(s) origins without credentials, paths, queries, or fragments. A leading `*.` label " +
  "matches exactly one subdomain label and needs at least two labels after it.";

function isBareOrigin(url: URL): boolean {
  const httpLike = url.protocol === "https:" || url.protocol === "http:";
  const extras = url.username + url.password + url.search + url.hash;
  return httpLike && extras === "" && url.pathname === "/";
}

function wildcard(entry: URL): OriginMatcher {
  const suffix = entry.hostname.slice(2);
  const valid =
    entry.hostname.startsWith("*.") &&
    !suffix.includes("*") &&
    !suffix.endsWith(".") &&
    suffix.split(".").length >= 2;
  if (!valid) throw new Error(INVALID);
  return (url) => {
    const label = url.hostname.slice(0, -(suffix.length + 1));
    const sameScheme =
      url.protocol === entry.protocol && url.port === entry.port;
    return (
      sameScheme &&
      url.hostname.endsWith(`.${suffix}`) &&
      label !== "" &&
      !label.includes(".")
    );
  };
}

function matcher(entry: string): OriginMatcher {
  const url = URL.parse(entry.trim());
  if (url === null || !isBareOrigin(url)) throw new Error(INVALID);
  if (url.hostname.includes("*")) return wildcard(url);
  return (target) => target.origin === url.origin;
}

export function allowOrigins(
  entries: readonly string[],
): (url: string) => boolean {
  const matchers = entries.map(matcher);
  return (raw) => {
    const url = URL.parse(raw);
    if (url === null || url.username !== "" || url.password !== "")
      return false;
    return matchers.some((matches) => matches(url));
  };
}
