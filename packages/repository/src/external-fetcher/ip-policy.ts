import { BlockList, isIP } from "node:net";

const V4 = new BlockList();
const V6 = new BlockList();

function addV4(cidr: string, bits: number): void {
  V4.addSubnet(cidr, bits, "ipv4");
}

function addV6(cidr: string, bits: number): void {
  V6.addSubnet(cidr, bits, "ipv6");
}

addV4("0.0.0.0", 8);
addV4("10.0.0.0", 8);
addV4("100.64.0.0", 10);
addV4("127.0.0.0", 8);
addV4("169.254.0.0", 16);
addV4("172.16.0.0", 12);
addV4("192.0.0.0", 24);
addV4("192.0.2.0", 24);
addV4("192.88.99.0", 24);
addV4("192.168.0.0", 16);
addV4("198.18.0.0", 15);
addV4("198.51.100.0", 24);
addV4("203.0.113.0", 24);
addV4("224.0.0.0", 4);
addV4("240.0.0.0", 4);

addV6("::", 128);
addV6("::1", 128);
addV6("::ffff:0:0", 96);
addV6("64:ff9b::", 96);
addV6("64:ff9b:1::", 48);
addV6("100::", 64);
addV6("2001::", 23);
addV6("2001:db8::", 32);
addV6("2001:10::", 28);
addV6("2001:20::", 28);
addV6("2002::", 16);
addV6("fc00::", 7);
addV6("fe80::", 10);
addV6("ff00::", 8);

export type IpFamily = 4 | 6;

export function stripZone(address: string): string {
  const pct = address.indexOf("%");
  return pct === -1 ? address : address.slice(0, pct);
}

export function normalizeIp(address: string): { ip: string; family: IpFamily } | undefined {
  const trimmed = stripZone(address.trim().replace(/^\[/, "").replace(/\]$/, ""));
  const family = isIP(trimmed);
  if (family === 4) {
    return { ip: trimmed, family: 4 };
  }
  if (family === 6) {
    return { ip: trimmed, family: 6 };
  }
  return undefined;
}

export function isIpv4Mapped(address: string): boolean {
  return ipv4FromMapped(address) !== undefined;
}

export function ipv4FromMapped(address: string): string | undefined {
  const parsed = normalizeIp(address);
  if (parsed === undefined || parsed.family !== 6) {
    return undefined;
  }
  const lower = parsed.ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) {
    return undefined;
  }
  const rest = parsed.ip.slice("::ffff:".length);
  if (isIP(rest) === 4) {
    return rest;
  }
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (hex === null) {
    return undefined;
  }
  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return undefined;
  }
  return `${String((high >> 8) & 255)}.${String(high & 255)}.${String((low >> 8) & 255)}.${String(low & 255)}`;
}

export function canonicalPublicIp(address: string): string | undefined {
  if (classifyIp(address) !== "public") {
    return undefined;
  }
  const parsed = normalizeIp(address);
  if (parsed === undefined) {
    return undefined;
  }
  return ipv4FromMapped(parsed.ip) ?? parsed.ip;
}

export function isForbiddenIp(address: string): boolean {
  const parsed = normalizeIp(address);
  if (parsed === undefined) {
    return true;
  }
  if (parsed.family === 4) {
    return V4.check(parsed.ip, "ipv4");
  }
  const mapped = ipv4FromMapped(parsed.ip);
  if (mapped !== undefined) {
    return isForbiddenIp(mapped);
  }
  return V6.check(parsed.ip, "ipv6");
}

export function classifyIp(address: string): "public" | "forbidden" | "invalid" {
  if (normalizeIp(address) === undefined) {
    return "invalid";
  }
  return isForbiddenIp(address) ? "forbidden" : "public";
}

export function publicAddresses(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const address of addresses) {
    if (classifyIp(address) === "public") {
      out.push(normalizeIp(address)?.ip ?? address);
    }
  }
  return out;
}
