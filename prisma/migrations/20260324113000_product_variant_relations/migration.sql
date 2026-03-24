-- Add product-level variant grouping relations for public product page selectors.
ALTER TABLE "Product"
ADD COLUMN "variantGroupId" TEXT,
ADD COLUMN "parentProductId" TEXT;

CREATE INDEX "Product_variantGroupId_idx" ON "Product"("variantGroupId");
CREATE INDEX "Product_parentProductId_idx" ON "Product"("parentProductId");

ALTER TABLE "Product"
ADD CONSTRAINT "Product_parentProductId_fkey"
FOREIGN KEY ("parentProductId") REFERENCES "Product"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
