export const packageName = "@pi-hec/sandbox";

export {
  REASON,
  asExecPort,
  boundOutput,
  evaluateSafety,
  executeSandboxJob,
  generateEphemeralX25519,
  guestEnvironment,
  hypervisorBinaryAllowed,
  envelopePayload,
  objectDigestOf,
  redactSecretMaterial,
  rejectedResult,
  sandboxOutputTreeDigest,
  sealSecretToRecipient,
  signEnvelope,
  toJsonValue,
  unknownResult,
  unsealSecret,
  verifyEnvelopeSignature,
} from "./protocol.js";
export type {
  CapabilityProbe,
  EphemeralX25519,
  ExecFilePort,
  HypervisorExec,
  JobAttestation,
  RecordingExec,
  SafetyProfile,
  SandboxBackend,
  SandboxExecutionContext,
  SandboxImageRef,
  SealedSecret,
  SignedSandboxJobResult,
  VmSession,
} from "./protocol.js";

export { QemuBackend } from "./qemu/backend.js";
export { createQcow2Overlay, qemuKernelArgv, qemuNoNetworkArgv, probeQemu } from "./qemu/overlay.js";
export { inspectEgressAttempt, hostnameFromDestination } from "./qemu/network-proxy.js";
export type { EgressAttempt, EgressDecision, NetworkPolicy } from "./qemu/network-proxy.js";
export { startEgressProxy, resolvePublicPins } from "./qemu/egress-proxy.js";
export type { EgressProxyHandle, EgressProxyStats } from "./qemu/egress-proxy.js";

export { OciBackend } from "./oci/backend.js";
export { buildRootlessOciSpec } from "./oci/rootless.js";

export { HyperVBackend } from "./hyperv/backend.js";
export { reapPiHecSandboxVms, sandboxVmName } from "./hyperv/boot.js";
export { buildDifferencingVhdPlan, hypervCreateCommands, selectWindowsIsolation } from "./hyperv/image-flow.js";
export { generateUserData, recipeRequiresOci } from "./hyperv/guest-agent.js";
export { seedCreateScript } from "./hyperv/seed.js";

export { MacosBackend } from "./macos/backend.js";
