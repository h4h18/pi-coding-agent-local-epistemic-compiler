export class ChangeSetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChangeSetError";
    this.code = code;
  }
}
