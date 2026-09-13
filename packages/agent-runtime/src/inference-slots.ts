export type InferenceSlot = {
  id: number;
  isProcessing: boolean;
  idTask: number;
};

export type CancelBusySlotsResult = {
  origin: string;
  busy: number;
  cancelled: number;
};

export function inferenceOriginFromBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}`;
}

export const INFERENCE_SLOT_FETCH_TIMEOUT_MS = 1_500;

function abortAfter(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export async function listInferenceSlots(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly InferenceSlot[]> {
  const response = await fetchImpl(`${stripTrailingSlash(origin)}/slots`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: abortAfter(INFERENCE_SLOT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`inference slots ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("inference slots is not an array");
  }
  return body.map(parseSlot);
}

export async function cancelBusyInferenceSlots(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelBusySlotsResult> {
  const normalized = stripTrailingSlash(origin);
  let slots: readonly InferenceSlot[];
  try {
    slots = await listInferenceSlots(normalized, fetchImpl);
  } catch {
    return { origin: normalized, busy: 0, cancelled: 0 };
  }
  const busy = slots.filter((slot) => slot.isProcessing);
  let cancelled = 0;
  for (const slot of busy) {
    try {
      const erased = await fetchImpl(`${normalized}/slots/${String(slot.id)}?action=erase`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "0" },
        body: "",
        signal: abortAfter(INFERENCE_SLOT_FETCH_TIMEOUT_MS),
      });
      if (erased.ok) {
        cancelled += 1;
      }
    } catch {
      continue;
    }
  }
  return { origin: normalized, busy: busy.length, cancelled };
}

function stripTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function parseSlot(value: unknown): InferenceSlot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("inference slot is not an object");
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const isProcessing = record.is_processing;
  const idTask = record.id_task;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new Error("inference slot id missing");
  }
  return {
    id,
    isProcessing: isProcessing === true,
    idTask: typeof idTask === "number" && Number.isInteger(idTask) ? idTask : -1,
  };
}
