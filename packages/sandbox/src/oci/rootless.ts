import type { ResolvedCommandSpec } from "@pi-hec/contracts";
import type { SafetyProfile } from "../protocol.js";

export type RootlessOciSpec = {
  ociVersion: "1.2.0";
  hostname: "sandbox";
  process: {
    terminal: false;
    user: { uid: 0; gid: 0 };
    args: readonly string[];
    cwd: string;
    env: readonly string[];
    noNewPrivileges: true;
  };
  root: { path: "rootfs"; readonly: true };
  linux: {
    namespaces: readonly { type: "pid" | "network" | "ipc" | "uts" | "mount" | "user" | "cgroup" }[];
    uidMappings: readonly { containerID: number; hostID: number; size: number }[];
    gidMappings: readonly { containerID: number; hostID: number; size: number }[];
    maskedPaths: readonly string[];
    readonlyPaths: readonly string[];
    resources: {
      pids: { limit: number };
      memory: { limit: number };
    };
  };
  mounts: readonly { destination: string; type: string; source: string; options: readonly string[] }[];
};

export function buildRootlessOciSpec(input: {
  command: ResolvedCommandSpec;
  safety: SafetyProfile;
  env: Readonly<Record<string, string>>;
}): RootlessOciSpec {
  const args = [input.command.executablePath, ...input.command.argv];
  const env = Object.entries(input.env).map(([key, value]) => `${key}=${value}`);
  return {
    ociVersion: "1.2.0",
    hostname: "sandbox",
    process: {
      terminal: false,
      user: { uid: 0, gid: 0 },
      args,
      cwd: `/${input.command.workingDirectory}`,
      env,
      noNewPrivileges: true,
    },
    root: { path: "rootfs", readonly: true },
    linux: {
      namespaces: [
        { type: "pid" },
        { type: "network" },
        { type: "ipc" },
        { type: "uts" },
        { type: "mount" },
        { type: "user" },
        { type: "cgroup" },
      ],
      uidMappings: [{ containerID: 0, hostID: 100000, size: 65536 }],
      gidMappings: [{ containerID: 0, hostID: 100000, size: 65536 }],
      maskedPaths: ["/proc/acpi", "/proc/kcore", "/proc/keys", "/proc/sysrq-trigger"],
      readonlyPaths: ["/proc/asound", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys"],
      resources: {
        pids: { limit: input.safety.processCount },
        memory: { limit: input.safety.memoryBytes },
      },
    },
    mounts: [
      { destination: "/proc", type: "proc", source: "proc", options: ["nosuid", "noexec", "nodev"] },
      { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["nosuid", "strictatime", "mode=755", "size=65536k"] },
      { destination: "/workspace", type: "bind", source: "workspace", options: ["rbind", "ro"] },
    ],
  };
}

export function specContainsDockerSocket(spec: RootlessOciSpec): boolean {
  return spec.mounts.some(
    (mount) =>
      mount.source.includes("docker.sock") ||
      mount.destination.includes("docker.sock") ||
      mount.source.includes("docker_engine"),
  );
}
