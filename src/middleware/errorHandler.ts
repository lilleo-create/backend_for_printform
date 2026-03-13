import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';

type AppError = Error & {
  status?: number;
  code?: string;
  details?: unknown;
  issues?: unknown[];
};

const mapMulterErrorCode = (code: string): string => {
  switch (code) {
    case 'LIMIT_FILE_SIZE':
      return 'RETURN_UPLOAD_FILE_TOO_LARGE';
    case 'LIMIT_FILE_COUNT':
      return 'RETURN_UPLOAD_TOO_MANY_FILES';
    default:
      return 'RETURN_UPLOAD_FILE_TYPE_INVALID';
  }
};

const isAppError = (error: unknown): error is AppError => {
  return error instanceof Error;
};

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message
        }))
      }
    });
  }

  if (error instanceof MulterError) {
    const multerCode =
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'LIMIT_UNEXPECTED_FILE';

    return res.status(400).json({
      error: { code: mapMulterErrorCode(multerCode) }
    });
  }

  if (isAppError(error) && error.message === 'RETURN_UPLOAD_FILE_TYPE_INVALID') {
    return res.status(400).json({
      error: { code: 'RETURN_UPLOAD_FILE_TYPE_INVALID' }
    });
  }

  if (isAppError(error)) {
    const errorCode = typeof error.code === 'string' ? error.code : undefined;

    if (errorCode?.startsWith('NDD_')) {
      return res.status(error.status ?? 502).json({
        error: {
          code: errorCode,
          details: error.details ?? null,
          ...(Array.isArray(error.issues) && error.issues.length
            ? { issues: error.issues }
            : {})
        }
      });
    }
  }

  const message =
    isAppError(error) && typeof error.message === 'string' && error.message.length
      ? error.message
      : 'SERVER_ERROR';

  const status =
    message === 'INVALID_CREDENTIALS' || message === 'UNAUTHORIZED'
      ? 401
      : message === 'OTP_TOKEN_REQUIRED'
      ? 401
      : message === 'FORBIDDEN' || message === 'PHONE_NOT_VERIFIED'
      ? 403
      : message === 'USER_EXISTS' ||
        message === 'EMAIL_EXISTS' ||
        message === 'PHONE_EXISTS'
      ? 409
      : message === 'ORDER_NOT_FOUND'
      ? 404
      : message.startsWith('TELEGRAM_SEND_FAILED') ||
        message.startsWith('TELEGRAM_CANNOT_SEND') ||
        message.startsWith('TELEGRAM_GATEWAY_ERROR')
      ? 502
      : message === 'OTP_INVALID' ||
        message === 'OTP_EXPIRED' ||
        message === 'OTP_TOO_MANY' ||
        message === 'INVALID_PHONE' ||
        message === 'CORS_NOT_ALLOWED' ||
        message === 'PHONE_MISMATCH' ||
        message === 'KYC_FILE_TYPE_INVALID' ||
        message === 'AMOUNT_MISMATCH' ||
        message === 'PAYMENT_REQUIRED' ||
        message === 'SELLER_DROPOFF_REQUIRED' ||
        message === 'SELLER_DROPOFF_PVZ_REQUIRED' ||
        message === 'BUYER_PICKUP_REQUIRED' ||
        message === 'BUYER_PVZ_REQUIRED' ||
        message === 'SELLER_STATION_ID_REQUIRED' ||
        message === 'BUYER_STATION_ID_REQUIRED' ||
        message === 'ORDER_DELIVERY_OFFER_FAILED' ||
        message === 'VALIDATION_ERROR' ||
        message === 'SHIPPING_ADDRESS_REQUIRED' ||
        message === 'DELIVERY_DESTINATION_REQUIRED' ||
        message === 'DELIVERY_METHOD_NOT_SUPPORTED' ||
        message === 'REGISTRATION_SESSION_INVALID'
      ? 400
      : message === 'ORDER_NOT_PAID' || message === 'PICKUP_POINT_REQUIRED'
      ? 409
      : 500;

  if (status === 500) {
    console.error('[errorHandler] unexpected error', {
      message: isAppError(error) ? error.message : String(error),
      stack: isAppError(error) ? error.stack : undefined,
      code: isAppError(error) ? error.code : undefined,
      details: isAppError(error) ? error.details : undefined
    });
  }

  return res.status(status).json({
    error: { code: message }
  });
};