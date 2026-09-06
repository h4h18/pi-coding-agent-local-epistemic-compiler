import { ReadOnlyRecoveryError, StoreClosedError } from "./errors.js";
import type { SqliteDatabase } from "./sqlite.js";

export type CrashMode = "before-commit" | "after-commit";

export class SimulatedProcessTermination extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`simulated process termination after ${method}`);
    this.name = "SimulatedProcessTermination";
    this.method = method;
  }
}

export class CrashBeforeCommitError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`simulated crash before commit of ${method}`);
    this.name = "CrashBeforeCommitError";
    this.method = method;
  }
}

export class CrashController {
  readonly #pending = new Map<string, CrashMode>();

  request(method: string, mode: CrashMode): void {
    this.#pending.set(method, mode);
  }

  consume(method: string): CrashMode | undefined {
    const mode = this.#pending.get(method);
    if (mode !== undefined) {
      this.#pending.delete(method);
    }
    return mode;
  }
}

export type WriteRuntime = {
  db: SqliteDatabase;
  readOnly: boolean;
  closed: boolean;
  crash: CrashController;
  closeConnection: () => void;
};

export function executeWrite<T>(
  runtime: WriteRuntime,
  method: string,
  work: () => T,
  begin: "deferred" | "immediate" = "immediate",
): T {
  if (runtime.closed) {
    throw new StoreClosedError();
  }
  if (runtime.readOnly) {
    throw new ReadOnlyRecoveryError();
  }
  const mode = runtime.crash.consume(method);
  const wrapped = runtime.db.transaction(() => {
    const result = work();
    if (mode === "before-commit") {
      throw new CrashBeforeCommitError(method);
    }
    return result;
  });
  const result = begin === "deferred" ? wrapped.deferred() : wrapped.immediate();
  if (mode === "after-commit") {
    runtime.closeConnection();
    throw new SimulatedProcessTermination(method);
  }
  return result;
}
