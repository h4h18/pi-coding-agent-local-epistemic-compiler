import type { CheckNode, CommandSpec, ObjectDigest, VerificationCapability } from "@pi-hec/contracts";
import { mintCheckId, mintGeneralId } from "../plan/ids.js";
import { approvalForCommand } from "../plan/command-authority.js";
import type { ProducerHost } from "./types.js";

export function capability(
  producerId: string,
  kinds: readonly string[],
  platform = "linux",
): VerificationCapability {
  return {
    schemaVersion: 1,
    id: mintGeneralId("cap", `${producerId}:${kinds.join(",")}`),
    producerId,
    subjectKinds: [...kinds],
    platform,
    sourceRefs: [],
  };
}

export function hostHasPath(host: ProducerHost, matcher: (path: string) => boolean): boolean {
  return host.listPaths().some(matcher);
}

export function commandCheck(
  obligationIds: CheckNode["obligationIds"],
  spec: CommandSpec,
  subject: CheckNode["subject"],
  dependencies: readonly CheckNode["id"][] = [],
): CheckNode {
  const recipe = spec;
  return {
    id: mintCheckId({ obligationIds, subject, recipe }),
    obligationIds,
    subject,
    recipe,
    dependencies: [...dependencies],
    mandatory: true,
    approval: approvalForCommand(spec),
  };
}

export function intrinsicCheck(
  obligationIds: CheckNode["obligationIds"],
  intrinsicCheckId: string,
  configurationObjectDigest: ObjectDigest,
  subject: CheckNode["subject"],
): CheckNode {
  const recipe = { intrinsicCheckId, configurationObjectDigest };
  return {
    id: mintCheckId({ obligationIds, subject, recipe }),
    obligationIds,
    subject,
    recipe,
    dependencies: [],
    mandatory: true,
    approval: "AUTO",
  };
}

export function isCommandRecipe(recipe: CheckNode["recipe"]): recipe is CommandSpec {
  return "executable" in recipe;
}
