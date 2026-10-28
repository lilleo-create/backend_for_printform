ALTER TABLE "Order" ADD COLUMN "deliveryChargedToBuyerKopecks" INTEGER;

-- Historical orders used both price contracts. Keep total untouched and infer
-- the amount paid by the buyer only when it matches an unambiguous subtotal.
WITH subtotals AS (
  SELECT "orderId", SUM("priceAtPurchase" * "quantity")::INTEGER AS subtotal
  FROM "OrderItem"
  GROUP BY "orderId"
)
UPDATE "Order" AS orders
SET "deliveryChargedToBuyerKopecks" = CASE
  WHEN orders."total" = subtotals.subtotal + COALESCE(orders."deliveryAmountKopecks", 0)
    THEN COALESCE(orders."deliveryAmountKopecks", 0)
  WHEN orders."total" = subtotals.subtotal THEN 0
  ELSE NULL
END
FROM subtotals
WHERE orders."id" = subtotals."orderId";
