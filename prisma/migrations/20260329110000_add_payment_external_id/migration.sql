-- Add YooKassa external payment id for webhook mapping
ALTER TABLE "Payment"
ADD COLUMN "externalId" TEXT;

CREATE UNIQUE INDEX "Payment_externalId_key" ON "Payment"("externalId");
