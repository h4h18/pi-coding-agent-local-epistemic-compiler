import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isJsonObject, toJsonValue, type JsonObject, type JsonValue } from "@pi-hec/contracts";
import { parseHostInventory, type HostInventory } from "@pi-hec/models";

export type GpuNameVram = {
  names: string[];
  vram: (number | null)[];
};

function osFamily(): HostInventory["osFamily"] {
  const platform = process.platform;
  if (platform === "win32") {
    return "windows";
  }
  if (platform === "linux") {
    return "linux";
  }
  if (platform === "darwin") {
    return "darwin";
  }
  return "other";
}

function envPresent(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function spawnTimeout(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const child = spawn(command, [...args], { windowsHide: true });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      done("");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      done("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function parseNvidiaSmi(stdout: string): GpuNameVram {
  const names: string[] = [];
  const vram: (number | null)[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(",").map((part) => part.trim());
    const name = parts[0];
    const mem = parts[1];
    if (name === undefined || name.length === 0) {
      continue;
    }
    names.push(name);
    const mega = mem === undefined ? Number.NaN : Number.parseFloat(mem);
    vram.push(Number.isFinite(mega) ? Math.round(mega * 1024 * 1024) : null);
  }
  return { names, vram };
}

function readStringField(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readAdapterRam(record: JsonObject): number | null {
  const value = record.AdapterRAM ?? record.adapterRAM;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

export function parseCimVideoControllers(stdout: string): GpuNameVram {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { names: [], vram: [] };
  }
  let parsed: JsonValue;
  try {
    parsed = toJsonValue(JSON.parse(trimmed));
  } catch {
    return { names: [], vram: [] };
  }
  const items: JsonValue[] = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  const vram: (number | null)[] = [];
  for (const item of items) {
    if (!isJsonObject(item)) {
      continue;
    }
    const record = item;
    const name = readStringField(record, "Name") ?? readStringField(record, "name");
    if (name === undefined) {
      continue;
    }
    names.push(name);
    vram.push(readAdapterRam(record));
  }
  return { names, vram };
}

export function mergeGpuInventories(primary: GpuNameVram, extra: GpuNameVram): GpuNameVram {
  const names = [...primary.names];
  const vram = [...primary.vram];
  const seen = new Set(primary.names.map((name) => name.toLowerCase()));
  for (let index = 0; index < extra.names.length; index += 1) {
    const name = extra.names[index];
    if (name === undefined) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
    const extraVram: unknown = extra.vram[index];
    vram.push(typeof extraVram === "number" ? extraVram : null);
  }
  return { names, vram };
}

async function nvidiaSmi(): Promise<GpuNameVram> {
  const stdout = await spawnTimeout(
    "nvidia-smi",
    ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    1500,
  );
  return parseNvidiaSmi(stdout);
}

async function win32VideoControllers(): Promise<GpuNameVram> {
  const stdout = await spawnTimeout(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM | ConvertTo-Json -Compress",
    ],
    1500,
  );
  return parseCimVideoControllers(stdout);
}

export async function collectHostInventory(): Promise<HostInventory> {
  const nvidia = await nvidiaSmi();
  const cim =
    process.platform === "win32" ? await win32VideoControllers() : { names: [], vram: [] };
  const gpus = mergeGpuInventories(nvidia, cim);
  const hipPresent = envPresent("HIP_PATH") || envPresent("ROCM_PATH");
  const rocmPresent = envPresent("ROCM_PATH");
  const amdGpuNames = gpus.names.filter((name) => /radeon|amd /i.test(name));
  const notes: string[] = [];
  if (process.platform === "win32") {
    notes.push("Windows host; FA-EX1 production local runtime is native Linux + official ROCm");
  }
  if (gpus.names.some((name) => /rtx 4050/i.test(name))) {
    notes.push("NVIDIA GeForce RTX 4050 Laptop class GPU is not an AMD gfx1150/gfx1151 device");
  }
  if (!rocmPresent) {
    notes.push("ROCM_PATH is empty; this host is unqualified for vLLM-ROCm and llama.cpp-HIP");
  }
  const collectedAt = new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(collectedAt)) {
    throw new Error("host inventory timestamp is not canonical UTC");
  }
  const inventory: HostInventory = {
    kind: "host-inventory",
    schemaVersion: 1,
    collectedAt,
    osFamily: osFamily(),
    osRelease: os.release(),
    gpuNames: gpus.names,
    vramBytesByGpu: gpus.vram,
    amdGpuNames,
    nvidiaPresent: nvidia.names.length > 0,
    cudaPresent: nvidia.names.length > 0,
    rocmPresent,
    hipPresent,
    notes,
  };
  return inventory;
}

export async function loadCommittedHostInventory(filePath: string): Promise<HostInventory> {
  const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
  return parseHostInventory(raw, path.basename(filePath));
}
