-- Add seller-visible service fee and completed/release timestamps
ALTER TABLE "Order"
  ADD COLUMN "serviceFeeKopecks" INTEGER,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "fundsReleasedAt" TIMESTAMP(3);

UPDATE "Order"
SET "serviceFeeKopecks" = COALESCE("platformFeeKopecks", 0) + COALESCE("acquiringFeeKopecks", 0)
WHERE "serviceFeeKopecks" IS NULL;

-- Ledger entry for idempotent release tracking and audits
CREATE TABLE "SellerBalanceLedgerEntry" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "entryType" TEXT NOT NULL,
  "amountKopecks" INTEGER NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerBalanceLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SellerBalanceLedgerEntry_orderId_entryType_key"
  ON "SellerBalanceLedgerEntry"("orderId", "entryType");

CREATE INDEX "SellerBalanceLedgerEntry_sellerId_createdAt_idx"
  ON "SellerBalanceLedgerEntry"("sellerId", "createdAt");

ALTER TABLE "SellerBalanceLedgerEntry"
  ADD CONSTRAINT "SellerBalanceLedgerEntry_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SellerBalanceLedgerEntry"
  ADD CONSTRAINT "SellerBalanceLedgerEntry_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
