export class ChronicleError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ChronicleError";
  }
}

export class NotFoundError extends ChronicleError {
  public constructor(resource: string) {
    super(`${resource} was not found`, "not_found", 404);
  }
}

export class ConflictError extends ChronicleError {
  public constructor(message: string) {
    super(message, "conflict", 409);
  }
}

export class ValidationError extends ChronicleError {
  public constructor(message: string) {
    super(message, "validation_error", 400);
  }
}
