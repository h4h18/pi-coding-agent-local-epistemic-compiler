import { FetchError } from "./errors.js";
import { classifyIp, isForbiddenIp } from "./ip-policy.js";

const SECRET_QUERY_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "access_token",
  "refresh_token",
  "auth",
  "authorization",
  "client_secret",
  "private_key",
  "session",
  "cookie",
  "credential",
  "jwt",
]);

export type HostPolicy = {
  allowPorts?: readonly number[];
  allowHosts?: readonly string[];
};

export type NormalizedFetchUrl = {
  href: string;
  hostname: string;
  port: number;
  pathname: string;
  search: string;
};

export function evaluateFetchUrl(raw: string, policy: HostPolicy = {}): NormalizedFetchUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FetchError("URL_INVALID", "URL is not absolute");
  }
  if (parsed.protocol !== "https:") {
    throw new FetchError("SCHEME", "HTTPS only");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new FetchError("CREDENTIALS", "URL credentials are forbidden");
  }
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  if (port !== 443 && !(policy.allowPorts ?? []).includes(port)) {
    throw new FetchError("PORT", `non-default port ${String(port)} is not permitted`);
  }
  const hostAllow = policy.allowHosts;
  if (hostAllow !== undefined && !hostAllow.includes(parsed.hostname.toLowerCase())) {
    throw new FetchError("ORIGIN", `host ${parsed.hostname} is not in origin policy`);
  }
  if (classifyIp(parsed.hostname) !== "invalid" && isForbiddenIp(parsed.hostname)) {
    throw new FetchError("IP_POLICY", "hostname is a forbidden address literal");
  }
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      throw new FetchError("SECRET_QUERY", `secret-like query parameter ${key}`);
    }
  }
  return {
    href: parsed.href,
    hostname: parsed.hostname,
    port,
    pathname: parsed.pathname,
    search: parsed.search,
  };
}
