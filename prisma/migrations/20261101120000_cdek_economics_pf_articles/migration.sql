BEGIN;

ALTER TABLE "Order"
  ADD COLUMN "cdekBaseDeliveryAmountKopecks" INTEGER,
  ADD COLUMN "cdekAdditionalServicesAmountKopecks" INTEGER,
  ADD COLUMN "cdekCurrentTotalAmountKopecks" INTEGER;

CREATE TABLE "PrintFormArticleCounter" (
  "id" INTEGER NOT NULL,
  "lastValue" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintFormArticleCounter_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PrintFormArticleCounter" ("id", "lastValue", "updatedAt")
SELECT 1, COALESCE(MAX(article_number), 0), NOW()
FROM (
  SELECT (substring("sku" FROM '^PF-([0-9]+)'))::INTEGER AS article_number FROM "Product"
  UNION ALL
  SELECT (substring("sku" FROM '-V([0-9]+)$'))::INTEGER FROM "Product"
  UNION ALL
  SELECT (substring("sku" FROM '-V([0-9]+)$'))::INTEGER FROM "ProductVariant"
) existing;

DO $$
DECLARE
  record_row RECORD;
  next_number INTEGER;
  parent_article TEXT;
BEGIN
  FOR record_row IN
    SELECT "id" FROM "Product"
    WHERE "parentProductId" IS NULL AND "sku" !~ '^PF-[0-9]{6,}$'
    ORDER BY "createdAt", "id"
  LOOP
    UPDATE "PrintFormArticleCounter" SET "lastValue" = "lastValue" + 1, "updatedAt" = NOW()
      WHERE "id" = 1 RETURNING "lastValue" INTO next_number;
    UPDATE "Product" SET "sku" = 'PF-' || REPEAT('0', GREATEST(0, 6 - LENGTH(next_number::TEXT))) || next_number
      WHERE "id" = record_row."id";
  END LOOP;

  FOR record_row IN
    SELECT "id", "parentProductId" FROM "Product"
    WHERE "parentProductId" IS NOT NULL AND "sku" !~ '^PF-[0-9]{6,}-V[0-9]+$'
    ORDER BY "createdAt", "id"
  LOOP
    SELECT "sku" INTO parent_article FROM "Product" WHERE "id" = record_row."parentProductId";
    IF parent_article IS NULL OR parent_article !~ '^PF-[0-9]{6,}$' THEN
      RAISE EXCEPTION 'Product variant parent has no PF article';
    END IF;
    UPDATE "PrintFormArticleCounter" SET "lastValue" = "lastValue" + 1, "updatedAt" = NOW()
      WHERE "id" = 1 RETURNING "lastValue" INTO next_number;
    UPDATE "Product" SET "sku" = parent_article || '-V' || next_number
      WHERE "id" = record_row."id";
  END LOOP;

  FOR record_row IN
    SELECT "id", "productId" FROM "ProductVariant"
    WHERE "sku" IS NULL OR "sku" !~ '^PF-[0-9]{6,}-V[0-9]+$'
    ORDER BY "createdAt", "id"
  LOOP
    SELECT "sku" INTO parent_article FROM "Product" WHERE "id" = record_row."productId";
    IF parent_article IS NULL OR parent_article !~ '^PF-[0-9]{6,}$' THEN
      RAISE EXCEPTION 'ProductVariant parent has no PF article';
    END IF;
    UPDATE "PrintFormArticleCounter" SET "lastValue" = "lastValue" + 1, "updatedAt" = NOW()
      WHERE "id" = 1 RETURNING "lastValue" INTO next_number;
    UPDATE "ProductVariant" SET "sku" = parent_article || '-V' || next_number
      WHERE "id" = record_row."id";
  END LOOP;
END $$;

ALTER TABLE "ProductVariant" ALTER COLUMN "sku" SET NOT NULL;
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");

COMMIT;
