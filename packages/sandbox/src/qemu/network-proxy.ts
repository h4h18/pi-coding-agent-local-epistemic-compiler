import { isIP } from "node:net";

export type EgressAttempt =
  | { kind: "dns"; name: string }
  | { kind: "tcp"; host: string; port: number; resolvedIp: string }
  | { kind: "udp"; host: string; port: number; resolvedIp: string }
  | { kind: "quic"; host: string; port: number; resolvedIp: string }
  | { kind: "raw-ip"; ip: string }
  | { kind: "unix"; path: string }
  | { kind: "doh"; host: string; resolvedIp: string }
  | { kind: "redirect"; from: string; to: string; tlsName: string };

export type NetworkPolicy = {
  destinations: readonly string[];
  protocolCapabilities: ReadonlySet<string>;
  pinnedIps: ReadonlyMap<string, readonly string[]>;
};

export type EgressDecision = { allow: true; pinnedIp: string } | { allow: false; reason: string };

function hostnameOf(destination: string): string {
  const trimmed = destination.trim().toLowerCase();
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return trimmed;
    }
  }
  const host = trimmed.split("/")[0] ?? trimmed;
  const withoutPort = host.includes("]")
    ? host
        .slice(0, host.indexOf("]") + 1)
        .replaceAll("[", "")
        .replaceAll("]", "")
    : (host.split(":")[0] ?? host);
  return withoutPort;
}

function allowedHosts(policy: NetworkPolicy): Set<string> {
  return new Set(policy.destinations.map(hostnameOf));
}

function parseV4(ip: string): readonly number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const value = Number.parseInt(part, 10);
    if (value > 255) {
      return undefined;
    }
    octets.push(value);
  }
  return octets;
}

function mappedV4(ip: string): readonly number[] | undefined {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    return parseV4(lower.slice("::ffff:".length));
  }
  return undefined;
}

function isMulticast(ip: string): boolean {
  const v4 = parseV4(ip) ?? mappedV4(ip);
  if (v4 !== undefined) {
    const first = v4[0];
    return first !== undefined && first >= 224 && first <= 239;
  }
  const version = isIP(ip);
  if (version !== 6) {
    return false;
  }
  return ip.toLowerCase().startsWith("ff");
}

function isPrivateOrLinkLocal(ip: string): boolean {
  const v4 = parseV4(ip) ?? mappedV4(ip);
  if (v4 !== undefined) {
    const a = v4[0] ?? 0;
    const b = v4[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return true;
    }
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1") {
    return true;
  }
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  return false;
}

function isMetadata(ip: string): boolean {
  const v4 = parseV4(ip) ?? mappedV4(ip);
  if (v4 !== undefined) {
    return v4[0] === 169 && v4[1] === 254 && v4[2] === 169;
  }
  return ip.toLowerCase() === "fd00:ec2::254";
}

function isIpv6(ip: string): boolean {
  return isIP(ip) === 6 && mappedV4(ip) === undefined;
}

function pinnedOk(policy: NetworkPolicy, host: string, ip: string): boolean {
  const pins = policy.pinnedIps.get(host);
  if (pins === undefined) {
    return false;
  }
  return pins.includes(ip);
}

function deny(reason: string): EgressDecision {
  return { allow: false, reason };
}

export function inspectEgressAttempt(
  attempt: EgressAttempt,
  policy: NetworkPolicy,
): EgressDecision {
  const hosts = allowedHosts(policy);
  switch (attempt.kind) {
    case "unix":
      return deny("unix-or-host-socket");
    case "raw-ip": {
      if (!policy.protocolCapabilities.has("protocol:raw-ip")) {
        return deny("raw-ip");
      }
      if (!hosts.has(attempt.ip)) {
        return deny("raw-ip-not-destined");
      }
      if (isPrivateOrLinkLocal(attempt.ip) || isMetadata(attempt.ip) || isMulticast(attempt.ip)) {
        return deny("raw-ip-range");
      }
      return deny("raw-ip");
    }
    case "dns":
      if (!hosts.has(attempt.name.toLowerCase())) {
        return deny("dns-name");
      }
      return { allow: true, pinnedIp: "proxy-dns" };
    case "doh": {
      if (!policy.protocolCapabilities.has("protocol:doh")) {
        return deny("doh");
      }
      if (!hosts.has(attempt.host.toLowerCase())) {
        return deny("doh-name");
      }
      if (isPrivateOrLinkLocal(attempt.resolvedIp) || isMetadata(attempt.resolvedIp)) {
        return deny("doh-range");
      }
      if (!pinnedOk(policy, attempt.host.toLowerCase(), attempt.resolvedIp)) {
        return deny("doh-pin");
      }
      return { allow: true, pinnedIp: attempt.resolvedIp };
    }
    case "quic":
      if (!policy.protocolCapabilities.has("protocol:quic")) {
        return deny("quic");
      }
      return deny("quic");
    case "udp": {
      if (!policy.protocolCapabilities.has("protocol:udp")) {
        return deny("udp");
      }
      if (
        isMulticast(attempt.resolvedIp) ||
        isPrivateOrLinkLocal(attempt.resolvedIp) ||
        isMetadata(attempt.resolvedIp)
      ) {
        return deny("udp-range");
      }
      if (!hosts.has(attempt.host.toLowerCase())) {
        return deny("udp-name");
      }
      if (!pinnedOk(policy, attempt.host.toLowerCase(), attempt.resolvedIp)) {
        return deny("udp-pin");
      }
      return { allow: true, pinnedIp: attempt.resolvedIp };
    }
    case "tcp": {
      if (!hosts.has(attempt.host.toLowerCase())) {
        return deny("tcp-name");
      }
      if (isIpv6(attempt.resolvedIp) && !policy.protocolCapabilities.has("protocol:ipv6")) {
        return deny("ipv6");
      }
      if (
        isPrivateOrLinkLocal(attempt.resolvedIp) ||
        isMetadata(attempt.resolvedIp) ||
        isMulticast(attempt.resolvedIp)
      ) {
        return deny("tcp-range");
      }
      if (!pinnedOk(policy, attempt.host.toLowerCase(), attempt.resolvedIp)) {
        return deny("tcp-pin");
      }
      return { allow: true, pinnedIp: attempt.resolvedIp };
    }
    case "redirect": {
      if (!hosts.has(attempt.to.toLowerCase()) || !hosts.has(attempt.tlsName.toLowerCase())) {
        return deny("redirect-name");
      }
      if (attempt.to.toLowerCase() !== attempt.tlsName.toLowerCase()) {
        return deny("redirect-tls");
      }
      return { allow: true, pinnedIp: "redirect" };
    }
    default: {
      const exhaustive: never = attempt;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function hostnameFromDestination(destination: string): string {
  return hostnameOf(destination);
}
