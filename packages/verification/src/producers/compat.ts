export function setRemoved(
  baseline: ReadonlySet<string>,
  candidate: ReadonlySet<string>,
): readonly string[] {
  const removed: string[] = [];
  for (const key of baseline) {
    if (!candidate.has(key)) {
      removed.push(key);
    }
  }
  return removed;
}

export function relationFromKeySets(
  baseline: ReadonlySet<string>,
  candidate: ReadonlySet<string>,
): "SUPPORTS" | "REFUTES" | undefined {
  if (baseline.size === 0 && candidate.size === 0) {
    return undefined;
  }
  return setRemoved(baseline, candidate).length > 0 ? "REFUTES" : "SUPPORTS";
}

export function splitPairedBlocks(
  text: string,
): { baseline: string; candidate: string } | undefined {
  const marker = "\n---CANDIDATE---\n";
  const index = text.indexOf(marker);
  if (index === -1) {
    const alt = text.indexOf("\n----- candidate -----\n");
    if (alt === -1) {
      return undefined;
    }
    return {
      baseline: text.slice(0, alt),
      candidate: text.slice(alt + "\n----- candidate -----\n".length),
    };
  }
  return { baseline: text.slice(0, index), candidate: text.slice(index + marker.length) };
}
