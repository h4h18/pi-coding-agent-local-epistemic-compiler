export const packageName = "@pi-hec/secret-broker";

export { startSecretBroker } from "./main.js";
export type { InjectRequest, InjectResult, SecretBrokerConfig, SecretBrokerHandle } from "./main.js";
export { verifyGrant } from "./grant-verifier.js";
export type { GrantExpected, GrantVerifyResult } from "./grant-verifier.js";
export { sealAndZeroize } from "./sealed-injection.js";
