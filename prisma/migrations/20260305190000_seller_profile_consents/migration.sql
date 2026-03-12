ALTER TABLE "SellerProfile"
  ADD COLUMN "acceptedRulesAt" TIMESTAMP(3),
  ADD COLUMN "acceptedRulesSlug" TEXT,
  ADD COLUMN "acceptedPersonalDataAt" TIMESTAMP(3),
  ADD COLUMN "acceptedPersonalDataSlug" TEXT;
