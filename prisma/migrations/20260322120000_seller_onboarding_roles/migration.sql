-- CreateEnum
CREATE TYPE "SellerType" AS ENUM ('IP', 'SELF_EMPLOYED', 'LLC');

-- AlterTable
ALTER TABLE "SellerProfile"
  ADD COLUMN "sellerType" "SellerType",
  ALTER COLUMN "status" SET DEFAULT 'PENDING',
  ALTER COLUMN "referenceCategory" DROP NOT NULL;

-- Backfill sellerType from legacy mixed fields and normalize lifecycle status.
UPDATE "SellerProfile"
SET
  "sellerType" = CASE
    WHEN COALESCE("legalType", "status") IN ('ИП', 'IP') THEN 'IP'::"SellerType"
    WHEN COALESCE("legalType", "status") IN ('Самозанятый', 'SELF_EMPLOYED') THEN 'SELF_EMPLOYED'::"SellerType"
    WHEN COALESCE("legalType", "status") IN ('ООО', 'LLC') THEN 'LLC'::"SellerType"
    ELSE "sellerType"
  END,
  "status" = CASE
    WHEN "status" IN ('ИП', 'IP', 'ООО', 'LLC', 'Самозанятый', 'SELF_EMPLOYED') THEN 'PENDING'
    ELSE COALESCE(NULLIF("status", ''), 'PENDING')
  END
WHERE "sellerType" IS NULL
   OR "status" IN ('ИП', 'IP', 'ООО', 'LLC', 'Самозанятый', 'SELF_EMPLOYED')
   OR "referenceCategory" IS NULL;
