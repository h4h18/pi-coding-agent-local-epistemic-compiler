import { verifyDecisionAndIssueGrant, type FaIdentityLookup } from "./approval.js";

export type { FaIdentityLookup };

export function issueGrantIfFaActive(
  input: Parameters<typeof verifyDecisionAndIssueGrant>[0] & {
    store: FaIdentityLookup;
    faRunnerId: string;
  },
): ReturnType<typeof verifyDecisionAndIssueGrant> {
  return verifyDecisionAndIssueGrant(input);
}
