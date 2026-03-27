-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PAYMENT_EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "ChatThread" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'PENDING_PAYMENT';
ALTER TABLE "Order" ADD COLUMN "paymentExpiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "expiredAt" TIMESTAMP(3);

-- Backfill existing PAID orders
UPDATE "Order"
SET "paymentStatus" = 'PAID'
WHERE "paidAt" IS NOT NULL OR "status" = 'PAID';
