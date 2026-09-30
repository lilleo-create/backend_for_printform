ALTER TABLE "User" ADD COLUMN "yandexId" TEXT;

CREATE UNIQUE INDEX "User_yandexId_key" ON "User"("yandexId");
