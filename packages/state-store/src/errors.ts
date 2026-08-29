export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export class ReadOnlyRecoveryError extends StoreError {
  constructor() {
    super("READ_ONLY_RECOVERY", "control store is in read-only recovery mode");
    this.name = "ReadOnlyRecoveryError";
  }
}

export class StoreLookupError extends StoreError {
  constructor() {
    super("NOT_FOUND", "not found");
    this.name = "StoreLookupError";
  }
}

export class ConflictError extends StoreError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConflictError";
  }
}

export class StateVersionConflictError extends ConflictError {
  constructor() {
    super("STATE_VERSION_CONFLICT", "run state version conflict");
    this.name = "StateVersionConflictError";
  }
}

export class IdempotencyConflictError extends ConflictError {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "idempotency key reused with a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class ReconcileRequiredError extends StoreError {
  constructor() {
    super("RECONCILE_REQUIRED", "idempotency record requires reconciliation");
    this.name = "ReconcileRequiredError";
  }
}

export class LeaseError extends StoreError {
  constructor(message: string) {
    super("LEASE_REJECTED", message);
    this.name = "LeaseError";
  }
}

export class CardinalityError extends StoreError {
  constructor(message: string) {
    super("CARDINALITY", message);
    this.name = "CardinalityError";
  }
}

export class UntrustedProjectError extends StoreError {
  constructor() {
    super("PROJECT_UNTRUSTED", "workspace and run writes require a trusted project");
    this.name = "UntrustedProjectError";
  }
}

export class StoreClosedError extends StoreError {
  constructor() {
    super("STORE_CLOSED", "control store connection is closed");
    this.name = "StoreClosedError";
  }
}
