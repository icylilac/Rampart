/** An error that maps to an HTTP response with a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const unauthorized = (message = "Missing or invalid API key.") => new ApiError(401, "unauthorized", message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found.`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const upstream = (code: string, message: string, details?: unknown) => new ApiError(502, code, message, details);
