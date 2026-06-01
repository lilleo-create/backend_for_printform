-- AlterTable
ALTER TABLE "Order" ADD COLUMN "deliveryAmountKopecks" INTEGER DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "platformFeePercent" DOUBLE PRECISION;
