import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

const OID = {
  ecdsaWithSha256: Buffer.from("2a8648ce3d040302", "hex"),
  ed25519: Buffer.from("2b6570", "hex"),
  commonName: Buffer.from("550403", "hex"),
  basicConstraints: Buffer.from("551d13", "hex"),
  keyUsage: Buffer.from("551d0f", "hex"),
  san: Buffer.from("551d11", "hex"),
  eku: Buffer.from("551d25", "hex"),
  serverAuth: Buffer.from("2b06010505070301", "hex"),
  clientAuth: Buffer.from("2b06010505070302", "hex"),
};

function encodeLength(length: number): Buffer {
  if (length < 128) {
    return Buffer.from([length]);
  }
  if (length < 256) {
    return Buffer.from([0x81, length]);
  }
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

function seq(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function setOf(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function oid(body: Buffer): Buffer {
  return tlv(0x06, body);
}

function integerFromNumber(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return integerFromBytes(bytes);
}

function integerFromBytes(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  let payload = bytes.subarray(start);
  const first = payload[0] ?? 0;
  if ((first & 0x80) !== 0) {
    payload = Buffer.concat([Buffer.from([0x00]), payload]);
  }
  return tlv(0x02, payload);
}

function bitString(bytes: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
}

function octetString(bytes: Buffer): Buffer {
  return tlv(0x04, bytes);
}

function bool(value: boolean): Buffer {
  return Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
}

function utf8String(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, "utf8"));
}

function utcTime(date: Date): Buffer {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return tlv(0x17, Buffer.from(`${yy}${mo}${dd}${hh}${mm}${ss}Z`, "ascii"));
}

function name(commonName: string): Buffer {
  return seq(setOf(seq(oid(OID.commonName), utf8String(commonName))));
}

function extension(id: Buffer, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octetString(value));
}

export function pem(kind: string, der: Buffer): string {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${kind}-----\n${lines.join("\n")}\n-----END ${kind}-----\n`;
}

function parsePemBlock(pemText: string, kind: string): Buffer {
  const begin = `-----BEGIN ${kind}-----`;
  const end = `-----END ${kind}-----`;
  const start = pemText.indexOf(begin);
  const stop = pemText.indexOf(end);
  if (start < 0 || stop < 0 || stop <= start) {
    throw new Error(`missing pem ${kind}`);
  }
  const b64 = pemText.slice(start + begin.length, stop).replaceAll(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

function keyUsage(bits: number): Buffer {
  return bitString(Buffer.from([bits]));
}

function readLength(buf: Buffer, offset: number): { length: number; next: number } {
  const first = buf[offset];
  if (first === undefined) {
    throw new Error("truncated der length");
  }
  if (first < 128) {
    return { length: first, next: offset + 1 };
  }
  const count = first & 0x7f;
  if (count === 0 || count > 2 || offset + count >= buf.length) {
    throw new Error("invalid der length");
  }
  let length = 0;
  for (let index = 1; index <= count; index += 1) {
    const part = buf[offset + index];
    if (part === undefined) {
      throw new Error("truncated der length");
    }
    length = (length << 8) | part;
  }
  return { length, next: offset + 1 + count };
}

function readTlv(
  buf: Buffer,
  offset: number,
): { tag: number; value: Buffer; der: Buffer; next: number } {
  const tag = buf[offset];
  if (tag === undefined) {
    throw new Error("truncated der tag");
  }
  const sized = readLength(buf, offset + 1);
  const end = sized.next + sized.length;
  if (end > buf.length) {
    throw new Error("truncated der value");
  }
  return {
    tag,
    value: buf.subarray(sized.next, end),
    der: buf.subarray(offset, end),
    next: end,
  };
}

function seqChildren(body: Buffer): { tag: number; value: Buffer; der: Buffer }[] {
  const children: { tag: number; value: Buffer; der: Buffer }[] = [];
  let offset = 0;
  while (offset < body.length) {
    const item = readTlv(body, offset);
    children.push({ tag: item.tag, value: item.value, der: item.der });
    offset = item.next;
  }
  return children;
}

export type IssuedCert = {
  certPem: string;
  keyPem: string;
  der: Buffer;
  privateKey: KeyObject;
  serial: string;
};

export type TestPki = {
  ca: IssuedCert;
  server: IssuedCert;
  admin: IssuedCert;
  broker: IssuedCert;
  runner: IssuedCert;
  worker: IssuedCert;
  unknown: IssuedCert;
};

function finish(der: Buffer, privateKey: KeyObject): IssuedCert {
  const x509 = new X509Certificate(der);
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  if (typeof keyPem !== "string") {
    throw new Error("expected pem private key");
  }
  return {
    certPem: pem("CERTIFICATE", Buffer.from(x509.raw)),
    keyPem,
    der: Buffer.from(x509.raw),
    privateKey,
    serial: x509.serialNumber.replaceAll(":", "").toLowerCase(),
  };
}

function issue(input: {
  serial: Buffer;
  subject: string;
  issuerName: Buffer;
  issuerKey: KeyObject;
  subjectPrivateKey: KeyObject;
  subjectPublicKeyDer: Buffer;
  isCa: boolean;
  server: boolean;
  client: boolean;
  san?: Buffer;
  notBefore: Date;
  notAfter: Date;
}): IssuedCert {
  const extensions: Buffer[] = [
    extension(OID.basicConstraints, true, seq(bool(input.isCa))),
    extension(OID.keyUsage, true, keyUsage(input.isCa ? 0x06 : 0x80)),
  ];
  const eku: Buffer[] = [];
  if (input.server) {
    eku.push(oid(OID.serverAuth));
  }
  if (input.client) {
    eku.push(oid(OID.clientAuth));
  }
  if (eku.length > 0) {
    extensions.push(extension(OID.eku, false, seq(...eku)));
  }
  if (input.san !== undefined) {
    extensions.push(extension(OID.san, false, input.san));
  }
  const tbs = seq(
    tlv(0xa0, integerFromNumber(2)),
    integerFromBytes(input.serial),
    seq(oid(OID.ecdsaWithSha256)),
    input.issuerName,
    seq(utcTime(input.notBefore), utcTime(input.notAfter)),
    name(input.subject),
    input.subjectPublicKeyDer,
    tlv(0xa3, seq(...extensions)),
  );
  const signature = createSign("SHA256").update(tbs).sign(input.issuerKey);
  const der = seq(tbs, seq(oid(OID.ecdsaWithSha256)), bitString(signature));
  return finish(der, input.subjectPrivateKey);
}

function ipSan(ip: readonly [number, number, number, number]): Buffer {
  return tlv(0x87, Buffer.from(ip));
}

function dnsSan(host: string): Buffer {
  return tlv(0x82, Buffer.from(host, "ascii"));
}

function serialFromNumber(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

export function parseCaPrivateKey(keyPem: string): KeyObject {
  return createPrivateKey(keyPem);
}

export function issuerNameFromCertPem(certPem: string): Buffer {
  const der = parsePemBlock(certPem, "CERTIFICATE");
  const outer = readTlv(der, 0);
  if (outer.tag !== 0x30) {
    throw new Error("certificate is not a sequence");
  }
  const tbs = readTlv(outer.value, 0);
  const children = seqChildren(tbs.value);
  const issuer = children[3];
  if (issuer === undefined || issuer.tag !== 0x30) {
    throw new Error("certificate issuer missing");
  }
  return issuer.der;
}

export function parseSpkiPemOrB64(input: string): Buffer {
  const trimmed = input.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    return parsePemBlock(trimmed, "PUBLIC KEY");
  }
  return Buffer.from(trimmed.replaceAll(/\s+/g, ""), "base64");
}

export type ParsedCsr = {
  spkiDer: Buffer;
  publicKey: KeyObject;
  infoDer: Buffer;
};

export function parseAndVerifyCsr(csrPem: string): ParsedCsr {
  const der = parsePemBlock(csrPem, "CERTIFICATE REQUEST");
  const outer = readTlv(der, 0);
  if (outer.tag !== 0x30) {
    throw new Error("csr is not a sequence");
  }
  const children = seqChildren(outer.value);
  const info = children[0];
  const alg = children[1];
  const signature = children[2];
  if (info === undefined || alg === undefined || signature === undefined) {
    throw new Error("csr fields missing");
  }
  if (info.tag !== 0x30 || signature.tag !== 0x03) {
    throw new Error("csr encoding invalid");
  }
  const infoChildren = seqChildren(info.value);
  const spki = infoChildren[2];
  if (spki === undefined || spki.tag !== 0x30) {
    throw new Error("csr spki missing");
  }
  const unused = signature.value[0];
  if (unused === undefined) {
    throw new Error("csr signature empty");
  }
  const signatureBytes = signature.value.subarray(1);
  const publicKey = createPublicKey({ key: spki.der, format: "der", type: "spki" });
  const algChildren = seqChildren(alg.value);
  const algOid = algChildren[0];
  const ecdsa = algOid !== undefined && algOid.value.equals(OID.ecdsaWithSha256);
  const ed = algOid !== undefined && algOid.value.equals(OID.ed25519);
  const ok = ecdsa
    ? cryptoVerify("sha256", info.der, publicKey, signatureBytes)
    : ed
      ? cryptoVerify(null, info.der, publicKey, signatureBytes)
      : false;
  if (!ok) {
    throw new Error("csr proof of possession failed");
  }
  return { spkiDer: spki.der, publicKey, infoDer: info.der };
}

export function verifyProofOfPossession(input: {
  publicKey: KeyObject;
  message: string;
  proofOfPossession: string;
}): boolean {
  const signature = Buffer.from(input.proofOfPossession, "base64url");
  if (signature.byteLength === 0) {
    return false;
  }
  const data = Buffer.from(input.message, "utf8");
  const type = input.publicKey.asymmetricKeyType;
  if (type === "ed25519") {
    return cryptoVerify(null, data, input.publicKey, signature);
  }
  if (type === "ec") {
    return cryptoVerify("sha256", data, input.publicKey, signature);
  }
  return false;
}

export function createCsrPem(input: {
  subject: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}): string {
  const spki = input.publicKey.export({ type: "spki", format: "der" });
  const info = seq(integerFromNumber(0), name(input.subject), spki, Buffer.from([0xa0, 0x00]));
  const type = input.privateKey.asymmetricKeyType;
  const signature =
    type === "ed25519"
      ? cryptoSign(null, info, input.privateKey)
      : createSign("SHA256").update(info).sign(input.privateKey);
  const alg = type === "ed25519" ? seq(oid(OID.ed25519)) : seq(oid(OID.ecdsaWithSha256));
  const der = seq(info, alg, bitString(signature));
  return pem("CERTIFICATE REQUEST", der);
}

export function signProofOfPossession(privateKey: KeyObject, message: string): string {
  const data = Buffer.from(message, "utf8");
  const type = privateKey.asymmetricKeyType;
  const signature =
    type === "ed25519"
      ? cryptoSign(null, data, privateKey)
      : createSign("SHA256").update(data).sign(privateKey);
  return signature.toString("base64url");
}

export type IssuedLeaf = {
  certificatePem: string;
  certificateChainPem: readonly string[];
  serial: string;
  spkiSha256: string;
  notBefore: string;
  notAfter: string;
  expiresAt: string;
};

export function issueLeafCertificate(input: {
  caCertPem: string;
  caPrivateKey: KeyObject;
  spkiDer: Buffer;
  subject: string;
  notBefore: Date;
  notAfter: Date;
}): IssuedLeaf {
  const issuerName = issuerNameFromCertPem(input.caCertPem);
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  if (serial[0] === 0) {
    serial[0] = 1;
  }
  const placeholderKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const issued = issue({
    serial,
    subject: input.subject,
    issuerName,
    issuerKey: input.caPrivateKey,
    subjectPrivateKey: placeholderKey,
    subjectPublicKeyDer: input.spkiDer,
    isCa: false,
    server: false,
    client: true,
    notBefore: input.notBefore,
    notAfter: input.notAfter,
  });
  const x509 = new X509Certificate(issued.certPem);
  const notBefore = new Date(x509.validFrom).toISOString();
  const notAfter = new Date(x509.validTo).toISOString();
  const spki = x509.publicKey.export({ type: "spki", format: "der" });
  return {
    certificatePem: issued.certPem,
    certificateChainPem: [issued.certPem, input.caCertPem],
    serial: issued.serial,
    spkiSha256: createHash("sha256").update(spki).digest("hex"),
    notBefore,
    notAfter,
    expiresAt: notAfter,
  };
}

export function issueSelfSignedCa(subject = "pi-hec-restore-ca"): IssuedCert {
  const caPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const caName = name(subject);
  const notBefore = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const notAfter = new Date(Date.UTC(2049, 11, 31, 23, 59, 59));
  return issue({
    serial: serialFromNumber(1),
    subject,
    issuerName: caName,
    issuerKey: caPair.privateKey,
    subjectPrivateKey: caPair.privateKey,
    subjectPublicKeyDer: caPair.publicKey.export({ type: "spki", format: "der" }),
    isCa: true,
    server: false,
    client: false,
    notBefore,
    notAfter,
  });
}

export function generateTestPki(): TestPki {
  const generated = generateHostPki({
    caSubject: "pi-hec-test-ca",
    ipv4Sans: [[127, 0, 0, 1]],
    dnsNames: ["localhost"],
  });
  return {
    ca: generated.ca,
    server: generated.server,
    admin: generated.admin,
    broker: generated.broker,
    runner: generated.runner,
    worker: generated.worker,
    unknown: generated.unknown,
  };
}

export type HostPki = TestPki & {
  piAgent: IssuedCert;
};

export function generateHostPki(input: {
  caSubject?: string;
  ipv4Sans?: readonly (readonly [number, number, number, number])[];
  dnsNames?: readonly string[];
} = {}): HostPki {
  const caSubject = input.caSubject ?? "pi-hec-faex1-ca";
  const ipv4Sans = input.ipv4Sans ?? [
    [127, 0, 0, 1],
    [10, 10, 10, 184],
  ];
  const dnsNames = input.dnsNames ?? ["localhost", "faex1"];
  const caPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const caName = name(caSubject);
  const notBefore = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const notAfter = new Date(Date.UTC(2049, 11, 31, 23, 59, 59));
  const caSpki = caPair.publicKey.export({ type: "spki", format: "der" });
  const ca = issue({
    serial: serialFromNumber(1),
    subject: caSubject,
    issuerName: caName,
    issuerKey: caPair.privateKey,
    subjectPrivateKey: caPair.privateKey,
    subjectPublicKeyDer: caSpki,
    isCa: true,
    server: false,
    client: false,
    notBefore,
    notAfter,
  });
  const newEc = (): ReturnType<typeof generateKeyPairSync> =>
    generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serverPair = newEc();
  const sanParts: Buffer[] = [
    ...dnsNames.map((host) => dnsSan(host)),
    ...ipv4Sans.map((ip) =>
      ipSan([ip[0] ?? 0, ip[1] ?? 0, ip[2] ?? 0, ip[3] ?? 0] as [number, number, number, number]),
    ),
  ];
  const san = seq(...sanParts);
  const server = issue({
    serial: serialFromNumber(2),
    subject: dnsNames[0] ?? "localhost",
    issuerName: caName,
    issuerKey: caPair.privateKey,
    subjectPrivateKey: serverPair.privateKey,
    subjectPublicKeyDer: serverPair.publicKey.export({ type: "spki", format: "der" }),
    isCa: false,
    server: true,
    client: false,
    san,
    notBefore,
    notAfter,
  });
  const leaf = (serial: number, subject: string): IssuedCert => {
    const pair = newEc();
    return issue({
      serial: serialFromNumber(serial),
      subject,
      issuerName: caName,
      issuerKey: caPair.privateKey,
      subjectPrivateKey: pair.privateKey,
      subjectPublicKeyDer: pair.publicKey.export({ type: "spki", format: "der" }),
      isCa: false,
      server: false,
      client: true,
      notBefore,
      notAfter,
    });
  };
  return {
    ca,
    server,
    admin: leaf(3, "admin"),
    broker: leaf(4, "broker"),
    runner: leaf(5, "runner"),
    worker: leaf(6, "worker"),
    unknown: leaf(7, "unknown"),
    piAgent: leaf(8, "pi-agent"),
  };
}
