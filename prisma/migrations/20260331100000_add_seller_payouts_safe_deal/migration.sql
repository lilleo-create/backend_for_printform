-- CreateTable
CREATE TABLE "SellerPayoutMethod" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'YOOKASSA',
    "methodType" TEXT NOT NULL,
    "payoutToken" TEXT,
    "cardFirst6" TEXT,
    "cardLast4" TEXT,
    "cardType" TEXT,
    "cardIssuerCountry" TEXT,
    "cardIssuerName" TEXT,
    "yoomoneyAccountNumber" TEXT,
    "maskedLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPayoutMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPayout" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "dealId" TEXT,
    "payoutMethodId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'YOOKASSA',
    "externalPayoutId" TEXT,
    "amountKopecks" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "cancellationParty" TEXT,
    "cancellationReason" TEXT,
    "description" TEXT,
    "idempotenceKey" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rawResponse" JSONB,

    CONSTRAINT "SellerPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerPayoutMethod_sellerId_isDefault_idx" ON "SellerPayoutMethod"("sellerId", "isDefault");

-- CreateIndex
CREATE INDEX "SellerPayoutMethod_sellerId_status_idx" ON "SellerPayoutMethod"("sellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayout_idempotenceKey_key" ON "SellerPayout"("idempotenceKey");

-- CreateIndex
CREATE INDEX "SellerPayout_sellerId_status_idx" ON "SellerPayout"("sellerId", "status");

-- CreateIndex
CREATE INDEX "SellerPayout_orderId_status_idx" ON "SellerPayout"("orderId", "status");

-- CreateIndex
CREATE INDEX "SellerPayout_externalPayoutId_idx" ON "SellerPayout"("externalPayoutId");

-- AddForeignKey
ALTER TABLE "SellerPayoutMethod" ADD CONSTRAINT "SellerPayoutMethod_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "SellerPayoutMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
