import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  asExecPort,
  hypervisorBinaryAllowed,
  type CapabilityProbe,
  type ExecFilePort,
  type HypervisorExec,
} from "../protocol.js";

const QEMU_DIR = "C:\\Program Files\\qemu";

export type OverlayRequest = {
  backingFile: string;
  overlayPath: string;
  exec: HypervisorExec;
};

export type OverlayResult =
  | { ok: true; overlayPath: string }
  | { ok: false; missing: string };

export function qemuKernelArgv(kernelPath: string, initrdPath: string, memoryMiB: number): string[] {
  return [
    "-machine",
    "q35",
    "-m",
    String(memoryMiB),
    "-smp",
    "1",
    "-nic",
    "none",
    "-nographic",
    "-display",
    "none",
    "-no-reboot",
    "-kernel",
    kernelPath,
    "-initrd",
    initrdPath,
    "-append",
    "console=ttyS0 panic=1",
  ];
}

export function qemuNoNetworkArgv(overlayPath: string, memoryMiB: number): string[] {
  return [
    "-machine",
    "q35",
    "-m",
    String(memoryMiB),
    "-smp",
    "1",
    "-nic",
    "none",
    "-nographic",
    "-display",
    "none",
    "-no-reboot",
    "-drive",
    `file=${overlayPath},if=virtio,format=qcow2`,
  ];
}

async function resolveHypervisorFile(file: string): Promise<{ file: string; cwd?: string; env?: NodeJS.ProcessEnv }> {
  const base = path.basename(file).toLowerCase();
  const qemuName = base === "qemu-img" || base === "qemu-img.exe" ? "qemu-img.exe" : undefined;
  const qemuSystem = base === "qemu-system-x86_64" || base === "qemu-system-x86_64.exe";
  if ((qemuName !== undefined || qemuSystem) && process.platform === "win32") {
    const resolved = path.join(QEMU_DIR, qemuName ?? "qemu-system-x86_64.exe");
    try {
      await access(resolved);
      return {
        file: resolved,
        cwd: QEMU_DIR,
        env: { ...process.env, PATH: `${QEMU_DIR}${path.delimiter}${process.env.PATH ?? ""}` },
      };
    } catch {
      return { file };
    }
  }
  return { file };
}

export async function defaultHypervisorExec(
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!hypervisorBinaryAllowed(file)) {
    throw new Error(`refusing host exec of ${file}`);
  }
  const resolved = await resolveHypervisorFile(file);
  const base = path.basename(resolved.file).toLowerCase();
  const qemuSystem = base === "qemu-system-x86_64" || base === "qemu-system-x86_64.exe";
  const timeout = options?.timeout ?? (qemuSystem ? 2_000 : 8_000);
  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = execFile(
      resolved.file,
      [...args],
      {
        timeout,
        windowsHide: true,
        encoding: "utf8",
        cwd: resolved.cwd,
        env: resolved.env,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure: Error = error;
          reject(failure);
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
    child.once("error", (error: Error) => {
      reject(error);
    });
    if (qemuSystem && child.pid !== undefined) {
      const killer = setTimeout(() => {
        child.kill();
        if (process.platform === "win32") {
          execFile("taskkill", ["/F", "/PID", String(child.pid), "/T"], { windowsHide: true }, () => undefined);
        }
      }, timeout);
      child.once("exit", () => {
        clearTimeout(killer);
      });
    }
  });
  return result;
}

export async function createQcow2Overlay(request: OverlayRequest): Promise<OverlayResult> {
  const exec = asExecPort(request.exec);
  try {
    await access(request.backingFile);
  } catch {
    return { ok: false, missing: "linux-vm-image" };
  }
  try {
    await exec("qemu-img", [
      "create",
      "-f",
      "qcow2",
      request.overlayPath,
      "-b",
      request.backingFile,
      "-F",
      "qcow2",
    ]);
    return { ok: true, overlayPath: request.overlayPath };
  } catch {
    return { ok: false, missing: "qemu-img" };
  }
}

export async function probeQemu(exec: ExecFilePort, imagePath: string): Promise<CapabilityProbe> {
  if (imagePath.length === 0) {
    return { available: false, missing: "linux-vm-image" };
  }
  try {
    await access(imagePath);
  } catch {
    return { available: false, missing: "linux-vm-image" };
  }
  try {
    await exec("qemu-system-x86_64", ["-version"]);
    await exec("qemu-img", ["--version"]);
    return { available: true };
  } catch {
    return { available: false, missing: "qemu" };
  }
}

export function overlayPathFor(jobNonce: string, tmpDir: string): string {
  const safe = jobNonce.replaceAll(/[^A-Za-z0-9_-]/g, "");
  return path.join(tmpDir, `pi-hec-overlay-${safe}.qcow2`);
}
