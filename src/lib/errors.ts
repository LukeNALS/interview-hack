/** Error chuẩn hoá cho route handler — throw new AppError(...) trong handler, withAuth bắt và convert response. */
export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message?: string;
  };
}

export function errorResponseBody(code: string, message?: string): ErrorBody {
  return { error: { code, message } };
}
