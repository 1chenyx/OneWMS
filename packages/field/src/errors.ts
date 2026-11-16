/** 与桌面 ApiError 同一形：code 做分支，message 给操作员看。 */
export class FieldApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FieldApiError';
  }
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof FieldApiError ? err.message : fallback;
}
