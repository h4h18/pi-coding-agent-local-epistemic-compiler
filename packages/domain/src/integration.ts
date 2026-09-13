import type { ChangeManifest, ChangeShard } from "@pi-hec/contracts";

export type IntegrationCheck = {
  ok: boolean;
  outOfScope: readonly string[];
  conflictMarkers: readonly string[];
  sharedResourceCollision: boolean;
};

export function pathsOutsideScope(
  changedPaths: readonly string[],
  allowedPaths: readonly string[],
): string[] {
  if (allowedPaths.length === 0) {
    return [];
  }
  return changedPaths.filter(
    (path) => !allowedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)),
  );
}

export function detectConflictMarkers(contents: Readonly<Record<string, string>>): string[] {
  return Object.entries(contents)
    .filter(([, body]) => body.includes("<<<<<<<") || body.includes(">>>>>>>"))
    .map(([path]) => path);
}

export function shardsShareResources(shards: readonly ChangeShard[]): boolean {
  const seen = new Set<string>();
  for (const shard of shards) {
    for (const resource of [...shard.files, ...shard.sharedResources, ...shard.generatedOutputs]) {
      if (seen.has(resource)) {
        return true;
      }
      seen.add(resource);
    }
  }
  return false;
}

export function checkIntegration(input: {
  manifest: ChangeManifest;
  fileContents: Readonly<Record<string, string>>;
  shards?: readonly ChangeShard[];
}): IntegrationCheck {
  const outOfScope = pathsOutsideScope(input.manifest.changedPaths, input.manifest.allowedPaths);
  const conflictMarkers = detectConflictMarkers(input.fileContents);
  const sharedResourceCollision =
    input.shards === undefined ? false : shardsShareResources(input.shards);
  return {
    ok: outOfScope.length === 0 && conflictMarkers.length === 0 && !sharedResourceCollision,
    outOfScope,
    conflictMarkers,
    sharedResourceCollision,
  };
}

export function shardOrder(shards: readonly ChangeShard[]): string[] {
  const remaining = new Map(shards.map((shard) => [shard.id, shard]));
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((shard) =>
      shard.dependsOn.every((dep) => !remaining.has(dep)),
    );
    if (ready.length === 0) {
      throw new Error("change shard cycle");
    }
    ready.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const shard of ready) {
      ordered.push(shard.id);
      remaining.delete(shard.id);
    }
  }
  return ordered;
}
