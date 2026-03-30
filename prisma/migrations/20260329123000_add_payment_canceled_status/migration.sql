-- Add CANCELED payment status for YooKassa webhook idempotent cancellation handling
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELED';
