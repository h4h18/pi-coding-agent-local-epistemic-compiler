import { createServer, connect } from "node:net";
import { expect, test } from "vitest";
import {
  inspectEgressAttempt,
  startEgressProxy,
  type NetworkPolicy,
} from "../../../packages/sandbox/src/index.js";

const publicIp = "93.184.216.34";
const pinned = new Map<string, readonly string[]>([["example.com", [publicIp]]]);

function policy(overrides: Partial<NetworkPolicy> = {}): NetworkPolicy {
  return {
    destinations: ["example.com"],
    protocolCapabilities: new Set<string>(),
    pinnedIps: pinned,
    ...overrides,
  };
}

test("default deny: DNS only via proxy for allowlisted names", () => {
  const allow = inspectEgressAttempt({ kind: "dns", name: "example.com" }, policy());
  expect(allow.allow).toBe(true);
  const deny = inspectEgressAttempt({ kind: "dns", name: "evil.example" }, policy());
  expect(deny.allow).toBe(false);
});

test("raw IP is blocked without protocol:raw-ip", () => {
  const denied = inspectEgressAttempt({ kind: "raw-ip", ip: publicIp }, policy());
  expect(denied.allow).toBe(false);
  const allowed = inspectEgressAttempt(
    { kind: "raw-ip", ip: publicIp },
    policy({ protocolCapabilities: new Set(["protocol:raw-ip"]) }),
  );
  expect(allowed.allow).toBe(false);
});

test("UDP and QUIC are blocked without exact protocol capability", () => {
  expect(
    inspectEgressAttempt(
      { kind: "udp", host: "example.com", port: 53, resolvedIp: publicIp },
      policy(),
    ).allow,
  ).toBe(false);
  expect(
    inspectEgressAttempt(
      { kind: "quic", host: "example.com", port: 443, resolvedIp: publicIp },
      policy(),
    ).allow,
  ).toBe(false);
  expect(
    inspectEgressAttempt(
      { kind: "udp", host: "example.com", port: 53, resolvedIp: publicIp },
      policy({ protocolCapabilities: new Set(["protocol:udp"]) }),
    ).allow,
  ).toBe(true);
});

test("LAN and private ranges fail closed", () => {
  for (const ip of [
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.2",
    "127.0.0.1",
    "fc00::1",
    "::1",
    "fe80::1",
  ]) {
    const decision = inspectEgressAttempt(
      { kind: "tcp", host: "example.com", port: 443, resolvedIp: ip },
      policy({ pinnedIps: new Map([["example.com", [ip]]]) }),
    );
    expect(decision.allow, ip).toBe(false);
  }
});

test("metadata endpoints fail closed", () => {
  for (const ip of ["169.254.169.254", "169.254.169.253", "fd00:ec2::254"]) {
    const decision = inspectEgressAttempt(
      { kind: "tcp", host: "metadata", port: 80, resolvedIp: ip },
      policy(),
    );
    expect(decision.allow, ip).toBe(false);
  }
});

test("IPv6 and IPv4-mapped private addresses fail closed", () => {
  expect(
    inspectEgressAttempt(
      { kind: "tcp", host: "example.com", port: 443, resolvedIp: "::ffff:192.168.0.1" },
      policy({ pinnedIps: new Map([["example.com", ["::ffff:192.168.0.1"]]]) }),
    ).allow,
  ).toBe(false);
  expect(
    inspectEgressAttempt(
      { kind: "tcp", host: "example.com", port: 443, resolvedIp: "2001:4860:4860::8888" },
      policy({ pinnedIps: new Map([["example.com", ["2001:4860:4860::8888"]]]) }),
    ).allow,
  ).toBe(false);
});

test("DoH is blocked unless protocol:doh is granted", () => {
  const doh = inspectEgressAttempt(
    { kind: "doh", host: "dns.google", resolvedIp: "8.8.8.8" },
    policy({ destinations: ["dns.google"], pinnedIps: new Map([["dns.google", ["8.8.8.8"]]]) }),
  );
  expect(doh.allow).toBe(false);
  const granted = inspectEgressAttempt(
    { kind: "doh", host: "dns.google", resolvedIp: "8.8.8.8" },
    policy({
      destinations: ["dns.google"],
      pinnedIps: new Map([["dns.google", ["8.8.8.8"]]]),
      protocolCapabilities: new Set(["protocol:doh"]),
    }),
  );
  expect(granted.allow).toBe(true);
});

test("unix and host sockets fail closed", () => {
  expect(inspectEgressAttempt({ kind: "unix", path: "/var/run/docker.sock" }, policy()).allow).toBe(
    false,
  );
  expect(
    inspectEgressAttempt({ kind: "unix", path: "//./pipe/docker_engine" }, policy()).allow,
  ).toBe(false);
  expect(inspectEgressAttempt({ kind: "unix", path: "/tmp/user-proxy.sock" }, policy()).allow).toBe(
    false,
  );
});

test("HTTPS to pinned public IP is allowed and redirect TLS name is revalidated", () => {
  const tcp = inspectEgressAttempt(
    { kind: "tcp", host: "example.com", port: 443, resolvedIp: publicIp },
    policy(),
  );
  expect(tcp.allow).toBe(true);
  const badRedirect = inspectEgressAttempt(
    { kind: "redirect", from: "example.com", to: "evil.example", tlsName: "evil.example" },
    policy(),
  );
  expect(badRedirect.allow).toBe(false);
  const goodRedirect = inspectEgressAttempt(
    { kind: "redirect", from: "example.com", to: "example.com", tlsName: "example.com" },
    policy(),
  );
  expect(goodRedirect.allow).toBe(true);
});

test("pinned IP mismatch is denied", () => {
  const decision = inspectEgressAttempt(
    { kind: "tcp", host: "example.com", port: 443, resolvedIp: "1.2.3.4" },
    policy(),
  );
  expect(decision.allow).toBe(false);
});

test("multicast is blocked", () => {
  expect(
    inspectEgressAttempt(
      { kind: "udp", host: "all-systems", port: 1900, resolvedIp: "224.0.0.1" },
      policy({
        protocolCapabilities: new Set(["protocol:udp"]),
      }),
    ).allow,
  ).toBe(false);
});

test("host-side proxy denies metadata and records pin plus byte counts for allowlisted TCP", async () => {
  const origin = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nping");
    });
  });
  await new Promise<void>((resolve) => {
    origin.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const originAddr = origin.address();
  if (originAddr === null || typeof originAddr === "string") {
    origin.close();
    throw new Error("origin-bind");
  }
  const proxy = await startEgressProxy({
    policy: policy(),
    listenHost: "127.0.0.1",
    listenPort: 0,
    connectImpl: () =>
      new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: originAddr.port });
        socket.once("connect", () => {
          resolve(socket);
        });
        socket.once("error", reject);
      }),
  });
  try {
    const denied = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: proxy.port });
      let data = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      socket.on("end", () => {
        resolve(data);
      });
      socket.write("CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n");
    });
    expect(denied.startsWith("HTTP/1.1 403")).toBe(true);

    const allowed = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: proxy.port });
      let data = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (data.includes("HTTP/1.1 200") && !data.includes("ping")) {
          socket.write("GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
        }
      });
      socket.on("end", () => {
        resolve(data);
      });
      socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    });
    expect(allowed.includes("HTTP/1.1 200")).toBe(true);
    expect(allowed.includes("ping")).toBe(true);
    expect(proxy.stats.sent).toBeGreaterThan(0);
    expect(proxy.stats.received).toBeGreaterThan(0);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => {
      origin.close(() => {
        resolve();
      });
    });
  }
});
