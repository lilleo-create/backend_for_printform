-- CreateTable
CREATE TABLE "SellerPayoutAllocation" (
  "id" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amountKopecks" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SellerPayoutAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerPayoutAllocation_orderId_createdAt_idx" ON "SellerPayoutAllocation"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "SellerPayoutAllocation_payoutId_idx" ON "SellerPayoutAllocation"("payoutId");

-- AddForeignKey
ALTER TABLE "SellerPayoutAllocation" ADD CONSTRAINT "SellerPayoutAllocation_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "SellerPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutAllocation" ADD CONSTRAINT "SellerPayoutAllocation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
