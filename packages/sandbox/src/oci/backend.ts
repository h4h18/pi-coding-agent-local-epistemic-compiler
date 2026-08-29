import type { CapabilityProbe, OciBackendPort, VmSession } from "../protocol.js";
import { specContainsDockerSocket, type RootlessOciSpec } from "./rootless.js";

export function guestUnshareFlags(hasNetwork: boolean): string {
  return hasNetwork ? "unshare -U -r -p -f --mount-proc" : "unshare -U -r -p -f --mount-proc -n";
}

export class OciBackend implements OciBackendPort {
  async probeInsideVm(session: VmSession | undefined, evidence?: { ns: number }): Promise<CapabilityProbe> {
    if (session === undefined || (session.kind !== "qemu-guest" && session.kind !== "hyperv-guest")) {
      return { available: false, missing: "trusted-vm" };
    }
    if (evidence?.ns !== 1) {
      return { available: false, missing: "guest-rootless-runtime" };
    }
    return { available: true };
  }

  rejectHostExecution(spec: RootlessOciSpec): CapabilityProbe {
    if (specContainsDockerSocket(spec)) {
      return { available: false, missing: "docker-socket-forbidden" };
    }
    return { available: false, missing: "trusted-vm" };
  }
}
