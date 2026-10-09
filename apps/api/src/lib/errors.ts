export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const unauthorized = (code = 'unauthorized', message = 'Authentication required') =>
  new HttpError(401, code, message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooManyRequests = (message = 'Too many attempts, try again later') =>
  new HttpError(429, 'too_many_requests', message);
