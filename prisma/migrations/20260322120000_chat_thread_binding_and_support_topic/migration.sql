ALTER TABLE "ChatThread"
  ADD COLUMN "sellerId" TEXT,
  ADD COLUMN "shopId" TEXT,
  ADD COLUMN "supportTopic" TEXT;

CREATE INDEX "ChatThread_sellerId_idx" ON "ChatThread"("sellerId");
CREATE INDEX "ChatThread_shopId_idx" ON "ChatThread"("shopId");
CREATE INDEX "ChatThread_kind_userId_sellerId_shopId_idx" ON "ChatThread"("kind", "userId", "sellerId", "shopId");
CREATE INDEX "ChatThread_kind_supportTopic_idx" ON "ChatThread"("kind", "supportTopic");

CREATE UNIQUE INDEX "ChatThread_seller_binding_unique_idx"
  ON "ChatThread"("userId", "sellerId", "shopId")
  WHERE "kind" = 'SELLER' AND "returnRequestId" IS NULL AND "sellerId" IS NOT NULL AND "shopId" IS NOT NULL;
