ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "cdekOrderUuid" TEXT,
  ADD COLUMN IF NOT EXISTS "cdekNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryProvider" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryStatusCode" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryStatusRaw" JSONB,
  ADD COLUMN IF NOT EXISTS "deliveryStatusUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveryReceiptConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveredToRecipientAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fundsReleasedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "grossAmountMinor" INTEGER,
  ADD COLUMN IF NOT EXISTS "platformFeeMinor" INTEGER,
  ADD COLUMN IF NOT EXISTS "providerFeeMinor" INTEGER,
  ADD COLUMN IF NOT EXISTS "serviceFeeMinor" INTEGER,
  ADD COLUMN IF NOT EXISTS "sellerNetAmountMinor" INTEGER;

UPDATE "Order"
SET
  "cdekOrderUuid" = COALESCE("cdekOrderUuid", "cdekOrderId"),
  "cdekNumber" = COALESCE("cdekNumber", "trackingNumber"),
  "grossAmountMinor" = COALESCE("grossAmountMinor", "grossAmountKopecks"),
  "platformFeeMinor" = COALESCE("platformFeeMinor", "platformFeeKopecks"),
  "providerFeeMinor" = COALESCE("providerFeeMinor", "acquiringFeeKopecks"),
  "serviceFeeMinor" = COALESCE("serviceFeeMinor", COALESCE("platformFeeKopecks", 0) + COALESCE("acquiringFeeKopecks", 0)),
  "sellerNetAmountMinor" = COALESCE("sellerNetAmountMinor", "sellerNetAmountKopecks");

CREATE INDEX IF NOT EXISTS "Order_cdekOrderUuid_idx" ON "Order"("cdekOrderUuid");
CREATE INDEX IF NOT EXISTS "Order_cdekNumber_idx" ON "Order"("cdekNumber");
CREATE INDEX IF NOT EXISTS "Order_deliveryProvider_deliveryStatus_idx" ON "Order"("deliveryProvider", "deliveryStatus");
