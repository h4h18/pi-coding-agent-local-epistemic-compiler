import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KERNEL_URL = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/netboot/vmlinuz-virt";
const INITRAMFS_URL = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/netboot/initramfs-virt";
const QCOW2_URL =
  "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/cloud/generic_alpine-3.24.1-x86_64-uefi-tiny-r0.qcow2";
const YAML_URL =
  "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/cloud/generic_alpine-3.24.1-x86_64-uefi-tiny-r0.yaml";
const QCOW2_SHA512 =
  "351b9f573086416f9096007fc4c5c40977475e3a7d2ac00701011092fe8528cb31fba3ce23865d0dec4b35ed66f2774fe9948564adf874ce62e0a09e11bf54f5";
const QEMU_DIR = "C:\\Program Files\\qemu";

const here = path.dirname(fileURLToPath(import.meta.url));

async function fetchTo(url, dest, algorithm) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`fetch failed ${url} ${String(response.status)}`);
  }
  const hash = createHash(algorithm);
  const file = createWriteStream(dest);
  const nodeStream = Readable.fromWeb(response.body);
  nodeStream.on("data", (chunk) => {
    hash.update(chunk);
  });
  await pipeline(nodeStream, file);
  return hash.digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const data = await readFile(filePath);
  hash.update(data);
  return `sha256:${hash.digest("hex")}`;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const kernelPath = path.join(here, "vmlinuz-virt");
const initramfsPath = path.join(here, "initramfs-virt");
const qcow2Path = path.join(here, "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.qcow2");
const vhdxPath = path.join(here, "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx");
const yamlPath = path.join(here, "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.yaml");
await mkdir(here, { recursive: true });

const kernelDigest = `sha256:${await fetchTo(KERNEL_URL, kernelPath, "sha256")}`;
const initramfsDigest = `sha256:${await fetchTo(INITRAMFS_URL, initramfsPath, "sha256")}`;

let qcow2Sha512;
if (await fileExists(qcow2Path)) {
  const existing = createHash("sha512");
  existing.update(await readFile(qcow2Path));
  qcow2Sha512 = existing.digest("hex");
  if (qcow2Sha512 !== QCOW2_SHA512) {
    qcow2Sha512 = await fetchTo(QCOW2_URL, qcow2Path, "sha512");
  }
} else {
  qcow2Sha512 = await fetchTo(QCOW2_URL, qcow2Path, "sha512");
}
if (qcow2Sha512 !== QCOW2_SHA512) {
  throw new Error(`qcow2 sha512 mismatch: ${qcow2Sha512}`);
}

try {
  await fetchTo(YAML_URL, yamlPath, "sha256");
} catch {
  await writeFile(
    yamlPath,
    "firmware: uefi\nbootstrap: tiny\ncloud: generic\narch: x86_64\nversion: 3.24.1\n",
  );
}

const provenancePath = path.join(here, "provenance.json");
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const expectedVhdx = provenance.digests?.["generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx"];
const vhdxExists = await fileExists(vhdxPath);
let vhdxMatches = false;
if (vhdxExists && typeof expectedVhdx === "string") {
  const actualVhdx = await sha256File(vhdxPath);
  vhdxMatches = actualVhdx === expectedVhdx;
}
if (!vhdxExists || !vhdxMatches) {
  if (vhdxExists) {
    await rm(vhdxPath);
  }
  const qemuImg = path.join(QEMU_DIR, "qemu-img.exe");
  await execFileAsync(
    qemuImg,
    ["convert", "-p", "-f", "qcow2", "-O", "vhdx", "-o", "subformat=dynamic", qcow2Path, vhdxPath],
    {
      cwd: QEMU_DIR,
      timeout: 300_000,
      windowsHide: true,
      env: { ...process.env, PATH: `${QEMU_DIR}${path.delimiter}${process.env.PATH ?? ""}` },
    },
  );
  const unsparsePath = `${vhdxPath}.nonsparse`;
  await execFileAsync("cmd.exe", ["/c", "copy", "/b", "/y", vhdxPath, unsparsePath], {
    windowsHide: true,
    timeout: 120_000,
  });
  await rm(vhdxPath);
  await rename(unsparsePath, vhdxPath);
  await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(here, "scratch", "patch-parent.ps1"),
    ],
    { timeout: 180_000, windowsHide: true },
  );
}

const qcow2Sha256 = await sha256File(qcow2Path);
const vhdxSha256 = await sha256File(vhdxPath);
provenance.imageId = "pi-hec-linux-sandbox-alpine-3.24.1-x86_64-uefi-tiny";
provenance.source = {
  kind: "alpine-generic-uefi-tiny",
  version: "3.24.1",
  kernelUrl: KERNEL_URL,
  initramfsUrl: INITRAMFS_URL,
  isoUrl: "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-virt-3.24.1-x86_64.iso",
  qcow2Url: QCOW2_URL,
  yamlUrl: YAML_URL,
  firmware: "uefi",
  bootstrap: "tiny",
  cloud: "generic",
};
provenance.hyperv = {
  parentVhdx: "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx",
  convert: ["qemu-img", "convert", "-f", "qcow2", "-O", "vhdx", "-o", "subformat=dynamic"],
  qemuWorkingDirectory: QEMU_DIR,
};
provenance.digests = {
  "vmlinuz-virt": kernelDigest,
  "initramfs-virt": initramfsDigest,
  "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.qcow2": qcow2Sha256,
  "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx": vhdxSha256,
};
provenance.sha512 = {
  "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.qcow2": `sha512:${qcow2Sha512}`,
};
provenance.fetchedAt = new Date().toISOString();
await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(
  JSON.stringify(
    { kernelDigest, initramfsDigest, qcow2Sha256, qcow2Sha512: `sha512:${qcow2Sha512}`, vhdxSha256 },
    null,
    2,
  ),
);
