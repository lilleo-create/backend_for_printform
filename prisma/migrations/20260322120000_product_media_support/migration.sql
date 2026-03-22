-- CreateEnum
CREATE TYPE "ProductMediaType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateTable
CREATE TABLE "ProductMedia" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "ProductMediaType" NOT NULL,
    "url" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("id")
);

-- Seed legacy image/video data into ProductMedia without changing existing columns.
INSERT INTO "ProductMedia" ("id", "productId", "type", "url", "isPrimary", "sortOrder", "createdAt", "updatedAt")
SELECT
    'pm_img_' || md5(p.id || ':image:' || COALESCE(pi.url, p.image) || ':' || image_data.sort_order::text),
    p.id,
    'IMAGE'::"ProductMediaType",
    COALESCE(pi.url, p.image) AS url,
    image_data.is_primary,
    image_data.sort_order,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Product" p
LEFT JOIN LATERAL (
    SELECT pi."url", pi."sortOrder"
    FROM "ProductImage" pi
    WHERE pi."productId" = p.id
) pi ON true
CROSS JOIN LATERAL (
    SELECT
        COALESCE(pi."sortOrder", 0) AS sort_order,
        CASE
            WHEN pi."url" IS NOT NULL THEN COALESCE(pi."sortOrder", 0) = 0
            ELSE true
        END AS is_primary
) image_data
WHERE COALESCE(pi."url", p.image) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "ProductMedia" ("id", "productId", "type", "url", "isPrimary", "sortOrder", "createdAt", "updatedAt")
SELECT
    'pm_vid_' || md5(p.id || ':video:' || video_url || ':' || (video_ordinal + legacy_image_count - 1)::text),
    p.id,
    'VIDEO'::"ProductMediaType",
    video_url,
    false,
    video_ordinal + legacy_image_count - 1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Product" p
CROSS JOIN LATERAL unnest(COALESCE(p."videoUrls", ARRAY[]::TEXT[])) WITH ORDINALITY AS v(video_url, video_ordinal)
CROSS JOIN LATERAL (
    SELECT GREATEST(
      COALESCE((SELECT COUNT(*)::int FROM "ProductImage" pi WHERE pi."productId" = p.id), 0),
      CASE WHEN p.image IS NULL OR p.image = '' THEN 0 ELSE 1 END
    ) AS legacy_image_count
) counts
ON CONFLICT DO NOTHING;

-- Backfill a primary flag if a product ended up with media rows but none marked as primary.
WITH ranked AS (
    SELECT
        pm.id,
        ROW_NUMBER() OVER (PARTITION BY pm."productId" ORDER BY pm."sortOrder" ASC, pm."createdAt" ASC, pm.id ASC) AS rn
    FROM "ProductMedia" pm
)
UPDATE "ProductMedia" pm
SET "isPrimary" = true
FROM ranked
WHERE pm.id = ranked.id
  AND ranked.rn = 1
  AND NOT EXISTS (
      SELECT 1
      FROM "ProductMedia" existing_primary
      WHERE existing_primary."productId" = pm."productId"
        AND existing_primary."isPrimary" = true
  );

-- CreateIndex
CREATE INDEX "ProductMedia_productId_sortOrder_idx" ON "ProductMedia"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductMedia_productId_type_sortOrder_idx" ON "ProductMedia"("productId", "type", "sortOrder");

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
