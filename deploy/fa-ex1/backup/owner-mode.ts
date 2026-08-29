import { execFileSync } from "node:child_process";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";

export function writeOwnerOnlyFile(filePath: string, data: string | Uint8Array): void {
  writeFileSync(filePath, data, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  hardenWindowsOwnerOnly(filePath);
}

export function chmodOwnerOnly(filePath: string): void {
  chmodSync(filePath, 0o600);
  hardenWindowsOwnerOnly(filePath);
}

export function assertOwnerOnlyMode(filePath: string): void {
  const mode = statSync(filePath).mode & 0o777;
  if (process.platform !== "win32") {
    if (mode !== 0o600) {
      throw new Error(`file mode must be 0600, got ${mode.toString(8)}`);
    }
    return;
  }
  if (windowsWorldReadable(filePath)) {
    throw new Error("file ACL must be owner-only equivalent of 0600");
  }
}

function hardenWindowsOwnerOnly(filePath: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const account = userInfo().username;
  execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${account}:(F)`], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function windowsWorldReadable(filePath: string): boolean {
  try {
    const output = execFileSync("icacls", [filePath], { encoding: "utf8", windowsHide: true });
    return /Everyone:\([^\)]*R/i.test(output) || /BUILTIN\\Users:\([^\)]*R/i.test(output);
  } catch {
    return true;
  }
}
