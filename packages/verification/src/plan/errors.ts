export class PlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PlanError";
    this.code = code;
  }
}
