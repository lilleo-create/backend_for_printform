ALTER TABLE "SellerProfile"
  ADD COLUMN IF NOT EXISTS "acceptedRulesAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acceptedRulesSlug" TEXT,
  ADD COLUMN IF NOT EXISTS "acceptedPersonalDataAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acceptedPersonalDataSlug" TEXT;
