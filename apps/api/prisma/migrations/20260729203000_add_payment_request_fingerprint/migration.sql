-- Add request fingerprint after the Payment table is created. IF NOT EXISTS
-- keeps this safe for databases updated by the earlier migration name.
ALTER TABLE "Payment"
ADD COLUMN IF NOT EXISTS "requestFingerprint" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Payment"
ALTER COLUMN "requestFingerprint" DROP DEFAULT;
