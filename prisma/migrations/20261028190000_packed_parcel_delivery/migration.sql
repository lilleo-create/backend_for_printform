ALTER TABLE "Order"
  ADD COLUMN "checkoutDeliveryEstimateKopecks" INTEGER,
  ADD COLUMN "packedDeliveryAmountKopecks" INTEGER,
  ADD COLUMN "actualDeliveryAmountKopecks" INTEGER,
  ADD COLUMN "packedWeightGrams" INTEGER,
  ADD COLUMN "packedLengthCm" DOUBLE PRECISION,
  ADD COLUMN "packedWidthCm" DOUBLE PRECISION,
  ADD COLUMN "packedHeightCm" DOUBLE PRECISION,
  ADD COLUMN "packedAt" TIMESTAMP(3),
  ADD COLUMN "packedQuoteCalculatedAt" TIMESTAMP(3),
  ADD COLUMN "actualDeliveryUpdatedAt" TIMESTAMP(3);

-- Legacy deliveryAmountKopecks can be treated as the checkout estimate only
-- while the order still has its checkout product snapshot and no CDEK order.
UPDATE "Order"
SET "checkoutDeliveryEstimateKopecks" = "deliveryAmountKopecks"
WHERE "shippingSnapshot" IS NOT NULL
  AND "cdekOrderId" IS NULL
  AND "isPacked" = false
  AND "deliveryAmountKopecks" IS NOT NULL;
