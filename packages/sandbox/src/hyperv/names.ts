export function sandboxVmName(nonce: string): string {
  const safe = nonce.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 16);
  const suffix = safe.length > 0 ? safe : "job";
  return `pi-hec-sb-${suffix}`;
}

export function comPipePath(vmName: string): string {
  return `\\\\.\\pipe\\${vmName}`;
}
