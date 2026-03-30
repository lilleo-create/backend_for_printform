-- AlterTable
ALTER TABLE "Order"
ADD COLUMN "yookassaDealId" TEXT,
ADD COLUMN "yookassaDealStatus" TEXT,
ADD COLUMN "yookassaPayoutId" TEXT,
ADD COLUMN "yookassaRefundId" TEXT,
ADD COLUMN "platformFeeAmount" INTEGER,
ADD COLUMN "sellerNetAmount" INTEGER;
