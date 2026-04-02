-- AlterTable
ALTER TABLE "SellerPayout"
  ALTER COLUMN "orderId" DROP NOT NULL,
  ADD COLUMN "externalStatus" TEXT,
  ADD COLUMN "metadata" JSONB;
