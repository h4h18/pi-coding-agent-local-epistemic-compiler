export const PI_HEC_TOKENIZER_REVISION = "pi-hec-conservative-v1";

export const KNOWN_TOKENIZER_REVISIONS: ReadonlySet<string> = new Set([PI_HEC_TOKENIZER_REVISION]);

export type CompilationPurpose = "initial" | "context-followup" | "repair";

export type ContextCapacityState =
  | "WAITING_INITIAL_CONTEXT_CAPACITY"
  | "WAITING_DELTA_CONTEXT_CAPACITY"
  | "WAITING_REPAIR_CONTEXT_CAPACITY";

export type OutputCapacityState =
  | "WAITING_INITIAL_OUTPUT_CAPACITY"
  | "WAITING_DELTA_OUTPUT_CAPACITY"
  | "WAITING_REPAIR_OUTPUT_CAPACITY";

export type CapacityWaitingState = ContextCapacityState | OutputCapacityState;

const PRETINY = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export class TokenizerError extends Error {
  readonly code = "UNKNOWN_TOKENIZER";

  constructor(revision: string) {
    super(`unknown tokenizerRevision ${revision}`);
    this.name = "TokenizerError";
  }
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff)
  );
}

export function countTokens(text: string, tokenizerRevision: string): number {
  if (!KNOWN_TOKENIZER_REVISIONS.has(tokenizerRevision)) {
    throw new TokenizerError(tokenizerRevision);
  }
  const normalized = text.normalize("NFC");
  if (normalized.length === 0) {
    return 0;
  }
  PRETINY.lastIndex = 0;
  let tokens = 0;
  let match = PRETINY.exec(normalized);
  while (match !== null) {
    const piece = match[0];
    const bytes = Buffer.byteLength(piece, "utf8");
    let cjk = 0;
    for (const char of piece) {
      const code = char.codePointAt(0);
      if (code !== undefined && isCjk(code)) {
        cjk += 1;
      }
    }
    const latinBytes = Math.max(0, bytes - cjk * 3);
    tokens += cjk + Math.max(1, Math.ceil(latinBytes / 3));
    if (PRETINY.lastIndex === match.index) {
      PRETINY.lastIndex += 1;
    }
    match = PRETINY.exec(normalized);
  }
  return tokens;
}

export type OutputReserveInput = {
  purpose: CompilationPurpose;
  requiredFileCount: number;
  requiredInterfaceCount: number;
  expectedOperationTypes: readonly string[];
  fullReplacementRepair: boolean;
  schemaOverheadTokens: number;
  historicalOutputTokens: readonly number[];
  evidenceTokens: number;
};

export function estimateReservedOutput(input: OutputReserveInput): number {
  const fileReserve = input.requiredFileCount * 512;
  const interfaceReserve = input.requiredInterfaceCount * 128;
  const operationReserve = input.expectedOperationTypes.length * 256;
  const replacement = input.fullReplacementRepair || input.purpose === "repair" ? 2 : 1;
  const evidence = Math.ceil(input.evidenceTokens * (replacement === 2 ? 1.5 : 0.35));
  let historical = 0;
  if (input.historicalOutputTokens.length > 0) {
    const sorted = [...input.historicalOutputTokens].sort((left, right) => left - right);
    const last = sorted[sorted.length - 1];
    historical = Math.ceil((last ?? 0) * 1.2);
  }
  return Math.max(
    1,
    input.schemaOverheadTokens +
      fileReserve +
      interfaceReserve +
      operationReserve +
      evidence +
      historical,
  );
}

export function capacityStatesFor(purpose: CompilationPurpose): {
  context: ContextCapacityState;
  output: OutputCapacityState;
} {
  switch (purpose) {
    case "initial":
      return {
        context: "WAITING_INITIAL_CONTEXT_CAPACITY",
        output: "WAITING_INITIAL_OUTPUT_CAPACITY",
      };
    case "context-followup":
      return {
        context: "WAITING_DELTA_CONTEXT_CAPACITY",
        output: "WAITING_DELTA_OUTPUT_CAPACITY",
      };
    case "repair":
      return {
        context: "WAITING_REPAIR_CONTEXT_CAPACITY",
        output: "WAITING_REPAIR_OUTPUT_CAPACITY",
      };
    default: {
      const exhaustive: never = purpose;
      throw new Error(`unhandled purpose ${String(exhaustive)}`);
    }
  }
}

export type CapacityDecision =
  | { kind: "ok"; inputTokens: number; reservedOutputTokens: number }
  | {
      kind: "waiting";
      state: CapacityWaitingState;
      inputTokens: number;
      reservedOutputTokens: number;
    };

export function evaluateCapacity(input: {
  purpose: CompilationPurpose;
  serializedInputTokens: number;
  reservedOutputTokens: number;
  contextLimitTokens: number;
  maxOutputTokens: number;
}): CapacityDecision {
  const states = capacityStatesFor(input.purpose);
  if (input.reservedOutputTokens > input.maxOutputTokens) {
    return {
      kind: "waiting",
      state: states.output,
      inputTokens: input.serializedInputTokens,
      reservedOutputTokens: input.reservedOutputTokens,
    };
  }
  if (input.serializedInputTokens + input.reservedOutputTokens > input.contextLimitTokens) {
    return {
      kind: "waiting",
      state: states.context,
      inputTokens: input.serializedInputTokens,
      reservedOutputTokens: input.reservedOutputTokens,
    };
  }
  return {
    kind: "ok",
    inputTokens: input.serializedInputTokens,
    reservedOutputTokens: input.reservedOutputTokens,
  };
}
