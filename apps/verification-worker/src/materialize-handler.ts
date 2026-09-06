import { materializeCandidateTree } from "@pi-hec/repository";
import {
  ChangeSetError,
  validateAndApplyChangeSet,
  type AppliedCandidateTree,
  type ChangeSetBaseline,
} from "@pi-hec/verification";

export type MaterializeCandidateInput = {
  changeSet: unknown;
  baseline: ChangeSetBaseline;
  destRoot: string;
};

export type MaterializeCandidateResult = AppliedCandidateTree & {
  writtenPaths: readonly string[];
};

export async function materializeCandidate(
  input: MaterializeCandidateInput,
): Promise<MaterializeCandidateResult> {
  const applied = validateAndApplyChangeSet({
    changeSet: input.changeSet,
    baseline: input.baseline,
  });
  const written = await materializeCandidateTree({
    destRoot: input.destRoot,
    entries: applied.entries,
  });
  if (written.materializedTreeDigest !== applied.materializedTreeDigest) {
    throw new ChangeSetError(
      "ROOT_DIGEST_MISMATCH",
      "candidate tree digest mismatch after materialize",
    );
  }
  return {
    ...applied,
    writtenPaths: written.writtenPaths,
  };
}
