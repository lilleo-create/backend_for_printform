-- Нормализуем существующие variantGroupId в иерархию master -> variants.
-- Без удаления данных: только выставляем связи parentProductId/variantGroupId.

WITH grouped AS (
  SELECT
    "variantGroupId" AS group_id,
    COUNT(*) AS group_size
  FROM "Product"
  WHERE "variantGroupId" IS NOT NULL
  GROUP BY "variantGroupId"
  HAVING COUNT(*) > 1
),
masters AS (
  SELECT DISTINCT ON (p."variantGroupId")
    p."variantGroupId" AS group_id,
    p.id AS master_id
  FROM "Product" p
  INNER JOIN grouped g ON g.group_id = p."variantGroupId"
  ORDER BY p."variantGroupId", (p.id = p."variantGroupId") DESC, p."createdAt" ASC
)
UPDATE "Product" p
SET
  "variantGroupId" = m.master_id,
  "parentProductId" = CASE WHEN p.id = m.master_id THEN NULL ELSE m.master_id END
FROM masters m
WHERE p."variantGroupId" = m.group_id;

-- Если вариант уже ссылается на parentProductId, но у него не заполнен variantGroupId,
-- подставляем группу родителя.
UPDATE "Product" child
SET "variantGroupId" = COALESCE(parent."variantGroupId", parent.id)
FROM "Product" parent
WHERE child."parentProductId" = parent.id
  AND child."variantGroupId" IS NULL;

-- Для мастер-товаров в группах гарантируем variantGroupId = id.
UPDATE "Product" p
SET "variantGroupId" = p.id
WHERE p."parentProductId" IS NULL
  AND p."variantGroupId" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "Product" v
    WHERE v."variantGroupId" = p."variantGroupId"
      AND v.id <> p.id
  );
