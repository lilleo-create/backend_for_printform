-- Drop Yandex OAuth from User
DROP INDEX IF EXISTS "User_yandexId_key";
ALTER TABLE "User" DROP COLUMN IF EXISTS "yandexId";

-- Drop Yandex merchant fields from SellerProfile
ALTER TABLE "SellerProfile" DROP COLUMN IF EXISTS "yandexMerchantRegistrationId";
ALTER TABLE "SellerProfile" DROP COLUMN IF EXISTS "yandexMerchantId";
ALTER TABLE "SellerProfile" DROP COLUMN IF EXISTS "yandexMerchantStatus";
ALTER TABLE "SellerProfile" DROP COLUMN IF EXISTS "yandexMerchantError";

-- Drop Yandex delivery fields from Order
ALTER TABLE "Order" DROP COLUMN IF EXISTS "yandexOfferId";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "yandexRequestId";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "yandexStatus";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "yandexSharingUrl";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "yandexCourierOrderId";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "yandexSelfPickupCode";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "yandexActualInfo";
