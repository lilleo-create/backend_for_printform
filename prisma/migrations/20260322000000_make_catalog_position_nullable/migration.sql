-- Make legacy seller profile field optional now that seller onboarding no longer accepts catalogPosition.
ALTER TABLE "SellerProfile"
ALTER COLUMN "catalogPosition" DROP NOT NULL;
