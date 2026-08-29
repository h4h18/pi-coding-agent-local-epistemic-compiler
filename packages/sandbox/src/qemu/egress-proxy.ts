import { createServer, connect as netConnect, isIP, type Socket, type Server } from "node:net";
import { promises as dns } from "node:dns";
import {
  hostnameFromDestination,
  inspectEgressAttempt,
  type NetworkPolicy,
} from "./network-proxy.js";

export type EgressProxyStats = {
  sent: number;
  received: number;
};

export type EgressProxyHandle = {
  host: string;
  port: number;
  stats: EgressProxyStats;
  close(): Promise<void>;
};

export type ConnectImpl = (ip: string, port: number) => Promise<Socket>;

const CONNECT_OK = "HTTP/1.1 200 Connection Established\r\n\r\n";
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

function defaultConnect(ip: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: ip, port });
    socket.once("connect", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function parseHostPort(authority: string): { host: string; port: number } | undefined {
  const trimmed = authority.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    const end = trimmed.indexOf("]");
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(":") ? Number.parseInt(rest.slice(1), 10) : 443;
    if (!Number.isFinite(port)) {
      return undefined;
    }
    return { host, port };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) {
    return { host: trimmed, port: 80 };
  }
  const host = trimmed.slice(0, colon);
  const port = Number.parseInt(trimmed.slice(colon + 1), 10);
  if (!Number.isFinite(port) || host.length === 0) {
    return undefined;
  }
  return { host, port };
}

function firstLine(headerBlock: string): string {
  return headerBlock.split("\r\n")[0] ?? "";
}

function locationHost(headers: string): string | undefined {
  const match = /(?:^|\r\n)location:\s*(\S+)/i.exec(headers);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const value = match[1];
  try {
    if (value.includes("://")) {
      return new URL(value).hostname.toLowerCase();
    }
  } catch {
    return undefined;
  }
  return value.split("/")[0]?.toLowerCase();
}

function pinFor(policy: NetworkPolicy, host: string): string | undefined {
  const pins = policy.pinnedIps.get(host.toLowerCase());
  if (pins === undefined) {
    return undefined;
  }
  for (const ip of pins) {
    const decision = inspectEgressAttempt(
      { kind: "tcp", host, port: 443, resolvedIp: ip },
      policy,
    );
    if (decision.allow) {
      return decision.pinnedIp;
    }
  }
  return undefined;
}

function decideTcp(policy: NetworkPolicy, host: string, port: number): { allow: true; ip: string } | { allow: false } {
  if (isIP(host)) {
    const decision = inspectEgressAttempt({ kind: "tcp", host, port, resolvedIp: host }, policy);
    return decision.allow ? { allow: true, ip: decision.pinnedIp } : { allow: false };
  }
  const pins = policy.pinnedIps.get(host.toLowerCase()) ?? [];
  for (const ip of pins) {
    const decision = inspectEgressAttempt({ kind: "tcp", host, port, resolvedIp: ip }, policy);
    if (decision.allow) {
      return { allow: true, ip: decision.pinnedIp };
    }
  }
  const fallback = pinFor(policy, host);
  if (fallback !== undefined) {
    const decision = inspectEgressAttempt({ kind: "tcp", host, port, resolvedIp: fallback }, policy);
    return decision.allow ? { allow: true, ip: decision.pinnedIp } : { allow: false };
  }
  return { allow: false };
}

function pipeCounted(
  client: Socket,
  origin: Socket,
  stats: EgressProxyStats,
  policy: NetworkPolicy,
  fromHost: string,
): void {
  client.on("data", (chunk: Buffer) => {
    stats.sent += chunk.byteLength;
    if (!origin.destroyed) {
      origin.write(chunk);
    }
  });
  origin.on("data", (chunk: Buffer) => {
    stats.received += chunk.byteLength;
    if (!revalidateRedirect(policy, fromHost, chunk) && !client.destroyed) {
      origin.destroy();
      client.destroy();
      return;
    }
    if (!client.destroyed) {
      client.write(chunk);
    }
  });
  const closeBoth = (): void => {
    if (!client.destroyed) {
      client.destroy();
    }
    if (!origin.destroyed) {
      origin.destroy();
    }
  };
  client.on("close", closeBoth);
  origin.on("close", closeBoth);
  client.on("error", closeBoth);
  origin.on("error", closeBoth);
}

function revalidateRedirect(policy: NetworkPolicy, fromHost: string, chunk: Buffer): boolean {
  const loc = locationHost(chunk.toString("utf8"));
  if (loc === undefined) {
    return true;
  }
  const decision = inspectEgressAttempt(
    { kind: "redirect", from: fromHost, to: loc, tlsName: loc },
    policy,
  );
  return decision.allow;
}

async function handleClient(
  client: Socket,
  policy: NetworkPolicy,
  connectImpl: ConnectImpl,
  stats: EgressProxyStats,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  const header = await new Promise<Buffer | undefined>((resolve) => {
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx !== -1) {
        client.off("data", onData);
        resolve(buffer.subarray(0, idx + 4));
        buffer = buffer.subarray(idx + 4);
      }
    };
    client.on("data", onData);
    client.once("error", () => {
      resolve(undefined);
    });
    client.once("close", () => {
      resolve(undefined);
    });
  });
  if (header === undefined) {
    client.destroy();
    return;
  }
  const requestLine = firstLine(header.toString("utf8"));
  const connectMatch = /^CONNECT\s+(\S+)\s+HTTP\//i.exec(requestLine);
  const getMatch = /^GET\s+(\S+)\s+HTTP\//i.exec(requestLine);
  let host: string;
  let port: number;
  if (connectMatch?.[1] !== undefined) {
    const parsed = parseHostPort(connectMatch[1]);
    if (parsed === undefined) {
      client.end(FORBIDDEN);
      return;
    }
    host = parsed.host;
    port = parsed.port;
  } else if (getMatch?.[1] !== undefined) {
    try {
      const url = getMatch[1].includes("://") ? new URL(getMatch[1]) : new URL(`http://${getMatch[1]}`);
      host = url.hostname.toLowerCase();
      port = url.port.length > 0 ? Number.parseInt(url.port, 10) : 80;
    } catch {
      client.end(FORBIDDEN);
      return;
    }
  } else {
    client.end(FORBIDDEN);
    return;
  }
  const decision = decideTcp(policy, host, port);
  if (!decision.allow) {
    client.end(FORBIDDEN);
    return;
  }
  let origin: Socket;
  try {
    origin = await connectImpl(decision.ip, port);
  } catch {
    client.end(FORBIDDEN);
    return;
  }
  if (connectMatch !== null) {
    client.write(CONNECT_OK);
    if (buffer.byteLength > 0) {
      stats.sent += buffer.byteLength;
      origin.write(buffer);
    }
    pipeCounted(client, origin, stats, policy, host);
    return;
  }
  const forwarded = Buffer.concat([header, buffer]);
  stats.sent += forwarded.byteLength;
  origin.write(forwarded);
  origin.once("data", (chunk: Buffer) => {
    if (!revalidateRedirect(policy, host, chunk)) {
      origin.destroy();
      client.destroy();
      return;
    }
    stats.received += chunk.byteLength;
    client.write(chunk);
    pipeCounted(client, origin, stats, policy, host);
  });
  origin.on("error", () => {
    client.destroy();
  });
}

export async function resolvePublicPins(
  destinations: readonly string[],
  protocolCapabilities: ReadonlySet<string>,
): Promise<Map<string, readonly string[]>> {
  const pinned = new Map<string, readonly string[]>();
  for (const destination of destinations) {
    const host = hostnameFromDestination(destination);
    if (isIP(host)) {
      continue;
    }
    try {
      const looked = await dns.lookup(host, { family: 4 });
      const trial: NetworkPolicy = {
        destinations,
        protocolCapabilities,
        pinnedIps: new Map([[host, [looked.address]]]),
      };
      const decision = inspectEgressAttempt(
        { kind: "tcp", host, port: 443, resolvedIp: looked.address },
        trial,
      );
      if (decision.allow) {
        pinned.set(host, [looked.address]);
      }
    } catch {
      continue;
    }
  }
  return pinned;
}

export async function startEgressProxy(input: {
  policy: NetworkPolicy;
  listenHost?: string;
  listenPort?: number;
  connectImpl?: ConnectImpl;
}): Promise<EgressProxyHandle> {
  const stats: EgressProxyStats = { sent: 0, received: 0 };
  const connectImpl = input.connectImpl ?? defaultConnect;
  const listenHost = input.listenHost ?? "127.0.0.1";
  const server: Server = createServer((client) => {
    void handleClient(client, input.policy, connectImpl, stats);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.listenPort ?? 0, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    server.close();
    throw new Error("egress-proxy-bind");
  }
  return {
    host: listenHost,
    port: addr.port,
    stats,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
