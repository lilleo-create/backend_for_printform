-- 1) Add new publicNumber column (temporarily nullable for backfill)
ALTER TABLE "Order" ADD COLUMN "publicNumber" TEXT;

-- 2) Add counter table for stable incremental numbers
CREATE TABLE "OrderPublicNumberCounter" (
  "scope" TEXT NOT NULL,
  "lastValue" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderPublicNumberCounter_pkey" PRIMARY KEY ("scope")
);

-- keep updatedAt fresh on update
CREATE OR REPLACE FUNCTION set_order_public_number_counter_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_public_number_counter_updated_at
BEFORE UPDATE ON "OrderPublicNumberCounter"
FOR EACH ROW
EXECUTE FUNCTION set_order_public_number_counter_updated_at();

-- 3) Backfill existing orders in deterministic creation order
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS seq
  FROM "Order"
)
UPDATE "Order" o
SET "publicNumber" = 'PF-' || ordered.seq::text
FROM ordered
WHERE o.id = ordered.id
  AND o."publicNumber" IS NULL;

-- 4) Align counter with max assigned number
INSERT INTO "OrderPublicNumberCounter" ("scope", "lastValue")
VALUES (
  'ORDER',
  COALESCE((SELECT MAX(CAST(REPLACE("publicNumber", 'PF-', '') AS INTEGER)) FROM "Order"), 0)
)
ON CONFLICT ("scope")
DO UPDATE SET "lastValue" = EXCLUDED."lastValue";

-- 5) Make field required and unique
ALTER TABLE "Order" ALTER COLUMN "publicNumber" SET NOT NULL;
CREATE UNIQUE INDEX "Order_publicNumber_key" ON "Order"("publicNumber");
