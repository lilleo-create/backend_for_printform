-- AlterTable
ALTER TABLE "Product"
ADD COLUMN "variantLabel" TEXT,
ADD COLUMN "variantSize" TEXT,
ADD COLUMN "variantAttributes" JSONB;
