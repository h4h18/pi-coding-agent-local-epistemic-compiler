import { expect, test } from "vitest";
import { classifyIp, isForbiddenIp, canonicalPublicIp } from "../src/index.js";

const forbiddenV4 = [
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "127.255.255.255",
  "169.254.169.254",
  "169.254.1.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.8",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
];

const forbiddenV6 = [
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "64:ff9b::1",
  "2001:db8::1",
  "fc00::1",
  "fd00:ec2::254",
  "fe80::1",
  "ff02::1",
];

test("IPv4 special ranges are forbidden", () => {
  for (const ip of forbiddenV4) {
    expect(classifyIp(ip), ip).toBe("forbidden");
    expect(isForbiddenIp(ip), ip).toBe(true);
  }
});

test("IPv6 special and mapped ranges are forbidden", () => {
  for (const ip of forbiddenV6) {
    expect(classifyIp(ip), ip).toBe("forbidden");
    expect(isForbiddenIp(ip), ip).toBe(true);
  }
});

test("public addresses are allowed by policy", () => {
  expect(classifyIp("8.8.8.8")).toBe("public");
  expect(classifyIp("1.1.1.1")).toBe("public");
  expect(classifyIp("2001:4860:4860::8888")).toBe("public");
});

test("IPv4-mapped public A-records are allowed and mapped loopback stays forbidden", () => {
  expect(classifyIp("::ffff:8.8.8.8")).toBe("public");
  expect(canonicalPublicIp("::ffff:8.8.8.8")).toBe("8.8.8.8");
  expect(classifyIp("::ffff:127.0.0.1")).toBe("forbidden");
  expect(classifyIp("::ffff:10.0.0.1")).toBe("forbidden");
  expect(classifyIp("::ffff:169.254.169.254")).toBe("forbidden");
});
