-- AlterTable
ALTER TABLE "Product"
ADD COLUMN "variantGroupId" TEXT,
ADD COLUMN "variantLabel" TEXT,
ADD COLUMN "variantSize" TEXT,
ADD COLUMN "variantAttributes" JSONB;

-- CreateIndex
CREATE INDEX "Product_variantGroupId_idx" ON "Product"("variantGroupId");
