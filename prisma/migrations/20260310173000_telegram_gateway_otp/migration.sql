-- Expand OTP purposes and delivery metadata for Telegram Gateway transport
CREATE TYPE "OtpPurpose_new" AS ENUM (
  'BUYER_REGISTER_PHONE',
  'BUYER_CHANGE_PHONE',
  'BUYER_SENSITIVE_ACTION',
  'SELLER_CONNECT_PHONE',
  'SELLER_CHANGE_PAYOUT_DETAILS',
  'SELLER_PAYOUT_SETTINGS_VERIFY',
  'PASSWORD_RESET'
);

ALTER TABLE "PhoneOtp"
  ALTER COLUMN "purpose" DROP DEFAULT,
  ALTER COLUMN "purpose" TYPE "OtpPurpose_new"
  USING (
    CASE "purpose"::text
      WHEN 'LOGIN' THEN 'BUYER_REGISTER_PHONE'::"OtpPurpose_new"
      WHEN 'REGISTER' THEN 'BUYER_REGISTER_PHONE'::"OtpPurpose_new"
      WHEN 'SELLER_VERIFY' THEN 'SELLER_CONNECT_PHONE'::"OtpPurpose_new"
      WHEN 'PASSWORD_RESET' THEN 'PASSWORD_RESET'::"OtpPurpose_new"
      ELSE 'BUYER_REGISTER_PHONE'::"OtpPurpose_new"
    END
  );

ALTER TYPE "OtpPurpose" RENAME TO "OtpPurpose_old";
ALTER TYPE "OtpPurpose_new" RENAME TO "OtpPurpose";
DROP TYPE "OtpPurpose_old";

CREATE TYPE "OtpChannel" AS ENUM ('TELEGRAM', 'SMS', 'CONSOLE');
CREATE TYPE "OtpProvider" AS ENUM ('TELEGRAM_GATEWAY', 'TWILIO', 'CONSOLE');
CREATE TYPE "OtpDeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'EXPIRED', 'REVOKED');

ALTER TABLE "PhoneOtp"
  ADD COLUMN "channel" "OtpChannel" NOT NULL DEFAULT 'TELEGRAM',
  ADD COLUMN "provider" "OtpProvider" NOT NULL DEFAULT 'TELEGRAM_GATEWAY',
  ADD COLUMN "providerRequestId" TEXT,
  ADD COLUMN "providerPayload" JSONB,
  ADD COLUMN "deliveryStatus" "OtpDeliveryStatus" NOT NULL DEFAULT 'SENT';
