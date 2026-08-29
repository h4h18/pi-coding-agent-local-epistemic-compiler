import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

function encodeLength(length: number): Buffer {
  if (length < 128) {
    return Buffer.from([length]);
  }
  if (length < 256) {
    return Buffer.from([0x81, length]);
  }
  if (length < 65536) {
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  }
  throw new Error("DER length too large");
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.byteLength), value]);
}

function seq(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

function oid(value: string): Buffer {
  const parts = value.split(".").map((part) => Number(part));
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) {
    throw new Error("invalid oid");
  }
  const bytes = [first * 40 + second];
  for (const part of parts.slice(2)) {
    if (part < 128) {
      bytes.push(part);
      continue;
    }
    const stack: number[] = [];
    let remaining = part;
    stack.push(remaining & 0x7f);
    remaining >>= 7;
    while (remaining > 0) {
      stack.push((remaining & 0x7f) | 0x80);
      remaining >>= 7;
    }
    bytes.push(...stack.reverse());
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integerFromBytes(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.byteLength - 1 && bytes[start] === 0) {
    start += 1;
  }
  const trimmed = Buffer.from(bytes.subarray(start));
  if (((trimmed[0] ?? 0) & 0x80) !== 0) {
    return tlv(0x02, Buffer.concat([Buffer.from([0x00]), trimmed]));
  }
  return tlv(0x02, trimmed);
}

function bitString(bytes: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
}

function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, "utf8"));
}

function generalizedTime(date: Date): Buffer {
  const iso = date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return tlv(0x18, Buffer.from(iso, "ascii"));
}

function nameCn(cn: string): Buffer {
  return seq(tlv(0x31, seq(seq(oid("2.5.4.3"), utf8(cn)))));
}

function algorithmId(): Buffer {
  return seq(oid("1.2.840.10045.4.3.2"));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  const parts = [oid(id)];
  if (critical) {
    parts.push(tlv(0x01, Buffer.from([0xff])));
  }
  parts.push(tlv(0x04, value));
  return seq(...parts);
}

function subjectKeyId(spki: Buffer): Buffer {
  const hash = createHash("sha256").update(spki).digest().subarray(0, 20);
  return extension("2.5.29.14", false, tlv(0x04, hash));
}

function authorityKeyId(issuerSpki: Buffer): Buffer {
  const hash = createHash("sha256").update(issuerSpki).digest().subarray(0, 20);
  return extension("2.5.29.35", false, seq(tlv(0x80, hash)));
}

function basicConstraints(ca: boolean): Buffer {
  const inner = ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq();
  return extension("2.5.29.19", true, inner);
}

function keyUsage(ca: boolean): Buffer {
  const bits = ca ? tlv(0x03, Buffer.from([0x01, 0x06])) : tlv(0x03, Buffer.from([0x07, 0x80]));
  return extension("2.5.29.15", true, bits);
}

function extKeyUsage(kind: "server" | "client"): Buffer {
  const eku = kind === "server" ? seq(oid("1.3.6.1.5.5.7.3.1")) : seq(oid("1.3.6.1.5.5.7.3.2"));
  return extension("2.5.29.37", false, eku);
}

function sanLocalhost(): Buffer {
  const dns = tlv(0x82, Buffer.from("localhost", "ascii"));
  const ip = tlv(0x87, Buffer.from([127, 0, 0, 1]));
  return extension("2.5.29.17", false, seq(dns, ip));
}

function pem(type: string, der: Buffer): string {
  const b64 = der.toString("base64").replaceAll(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${type}-----\n${b64}\n-----END ${type}-----\n`;
}

export type IssuedCert = {
  certPem: string;
  keyPem: string;
  der: Buffer;
  serial: string;
  spkiSha256: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

export type TestPki = {
  ca: IssuedCert;
  server: IssuedCert;
  admin: IssuedCert;
  broker: IssuedCert;
  runner: IssuedCert;
  worker: IssuedCert;
  foreign: IssuedCert;
  adminSign: { publicKey: KeyObject; privateKey: KeyObject };
  brokerSign: { publicKey: KeyObject; privateKey: KeyObject };
  runnerSign: { publicKey: KeyObject; privateKey: KeyObject };
};

function issue(input: {
  cn: string;
  issuerCn: string;
  issuerKey: KeyObject;
  issuerSpki: Buffer;
  subjectKey: KeyObject;
  serial: Buffer;
  ca: boolean;
  kind: "server" | "client";
  notBefore: Date;
  notAfter: Date;
}): IssuedCert {
  const spki = Buffer.from(input.subjectKey.export({ type: "spki", format: "der" }));
  const serialHex = Buffer.from(input.serial).toString("hex");
  const extensions = [
    basicConstraints(input.ca),
    keyUsage(input.ca),
    extKeyUsage(input.kind),
    subjectKeyId(spki),
    authorityKeyId(input.issuerSpki),
  ];
  if (input.kind === "server") {
    extensions.push(sanLocalhost());
  }
  const tbs = seq(
    tlv(0xa0, integerFromBytes(Buffer.from([0x02]))),
    integerFromBytes(input.serial),
    algorithmId(),
    nameCn(input.issuerCn),
    seq(generalizedTime(input.notBefore), generalizedTime(input.notAfter)),
    nameCn(input.cn),
    spki,
    tlv(0xa3, seq(...extensions)),
  );
  const signature = cryptoSign("sha256", tbs, { key: input.issuerKey, dsaEncoding: "der" });
  const der = seq(tbs, algorithmId(), bitString(signature));
  return {
    certPem: pem("CERTIFICATE", der),
    keyPem: input.subjectKey.export({ type: "pkcs8", format: "pem" }).toString(),
    der,
    serial: serialHex,
    spkiSha256: createHash("sha256").update(spki).digest("hex"),
    privateKey: input.subjectKey,
    publicKey: createPublicKey(input.subjectKey),
  };
}

function ecPair(): KeyObject {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
}

export function generateTestPki(now = new Date("2026-08-28T00:00:00.000Z")): TestPki {
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
  const caKey = ecPair();
  const caSpki = Buffer.from(caKey.export({ type: "spki", format: "der" }));
  const ca = issue({
    cn: "pi-hec-test-ca",
    issuerCn: "pi-hec-test-ca",
    issuerKey: caKey,
    issuerSpki: caSpki,
    subjectKey: caKey,
    serial: Buffer.from([0x01]),
    ca: true,
    kind: "server",
    notBefore,
    notAfter,
  });
  function leaf(cn: string, serial: number, kind: "server" | "client"): IssuedCert {
    return issue({
      cn,
      issuerCn: "pi-hec-test-ca",
      issuerKey: caKey,
      issuerSpki: caSpki,
      subjectKey: ecPair(),
      serial: Buffer.from([serial]),
      ca: false,
      kind,
      notBefore,
      notAfter,
    });
  }
  return {
    ca,
    server: leaf("localhost", 2, "server"),
    admin: leaf("admin", 3, "client"),
    broker: leaf("broker", 4, "client"),
    runner: leaf("runner", 5, "client"),
    worker: leaf("worker", 6, "client"),
    foreign: leaf("foreign", 7, "client"),
    adminSign: generateKeyPairSync("ed25519"),
    brokerSign: generateKeyPairSync("ed25519"),
    runnerSign: generateKeyPairSync("ed25519"),
  };
}
