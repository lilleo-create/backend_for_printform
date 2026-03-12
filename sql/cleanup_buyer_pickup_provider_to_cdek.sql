-- Normalize historical non-CDEK pickup provider records to CDEK.
UPDATE "Order"
SET "buyerPickupPvzMeta" = jsonb_set(
  jsonb_set(
    jsonb_set(COALESCE("buyerPickupPvzMeta", '{}'::jsonb), '{provider}', '"CDEK"'::jsonb, true),
    '{pvzId}',
    to_jsonb(COALESCE(NULLIF("buyerPickupPvzId", ''), COALESCE("buyerPickupPvzMeta"->>'pvzId', ''))),
    true
  ),
  '{raw}',
  (
    COALESCE("buyerPickupPvzMeta"->'raw', '{}'::jsonb)
    || jsonb_build_object('id', COALESCE(NULLIF("buyerPickupPvzId", ''), COALESCE("buyerPickupPvzMeta"->>'pvzId', '')))
    || jsonb_build_object('type', 'PVZ')
  ),
  true
)
WHERE COALESCE(UPPER("buyerPickupPvzMeta"->>'provider'), '') <> 'CDEK'
  AND COALESCE("buyerPickupPvzId", '') ~ '^[A-Z]{3}[0-9]+$';
