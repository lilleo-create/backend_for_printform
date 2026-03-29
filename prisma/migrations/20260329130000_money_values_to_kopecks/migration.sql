UPDATE "Product" SET price = price * 100;
UPDATE "Order" SET total = total * 100;
UPDATE "OrderItem" SET "priceAtPurchase" = "priceAtPurchase" * 100;
UPDATE "Payment" SET amount = amount * 100;
UPDATE "Payout" SET amount = amount * 100;
