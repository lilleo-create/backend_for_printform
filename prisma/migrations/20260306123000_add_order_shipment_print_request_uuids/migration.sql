-- AlterTable
ALTER TABLE "OrderShipment"
ADD COLUMN "actPrintRequestUuid" TEXT,
ADD COLUMN "labelPrintRequestUuid" TEXT,
ADD COLUMN "barcodePrintRequestUuid" TEXT;
