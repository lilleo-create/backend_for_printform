import { Response } from 'express';

type ErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND';

const respondWithError = (res: Response, code: ErrorCode, message?: string) => {
  return res.status(code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : 404).json({
    error: {
      code,
      ...(message ? { message } : {})
    }
  });
};

export const unauthorized = (res: Response, message?: string) => respondWithError(res, 'UNAUTHORIZED', message);
export const forbidden = (res: Response, message?: string) => respondWithError(res, 'FORBIDDEN', message);
export const notFound = (res: Response, message?: string) => respondWithError(res, 'NOT_FOUND', message);
