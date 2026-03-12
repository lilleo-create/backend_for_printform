-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryCalculatedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryDaysMax" INTEGER,
ADD COLUMN     "deliveryDaysMin" INTEGER,
ADD COLUMN     "deliveryTariffCode" INTEGER;
