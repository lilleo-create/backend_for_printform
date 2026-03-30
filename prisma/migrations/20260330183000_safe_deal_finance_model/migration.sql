-- AlterTable
ALTER TABLE "Order"
RENAME COLUMN "platformFeeAmount" TO "platformFeeKopecks";

ALTER TABLE "Order"
RENAME COLUMN "sellerNetAmount" TO "sellerNetAmountKopecks";

ALTER TABLE "Order"
ADD COLUMN "grossAmountKopecks" INTEGER,
ADD COLUMN "acquiringFeeKopecks" INTEGER;

UPDATE "Order"
SET
  "grossAmountKopecks" = COALESCE("grossAmountKopecks", "total"),
  "platformFeeKopecks" = COALESCE("platformFeeKopecks", 0),
  "sellerNetAmountKopecks" = COALESCE("sellerNetAmountKopecks", GREATEST("total" - COALESCE("platformFeeKopecks", 0), 0)),
  "acquiringFeeKopecks" = COALESCE("acquiringFeeKopecks", 0);
