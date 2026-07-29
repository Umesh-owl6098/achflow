-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "requestFingerprint" TEXT NOT NULL DEFAULT '';

-- Remove temporary default after backfill for any existing rows
ALTER TABLE "Payment" ALTER COLUMN "requestFingerprint" DROP DEFAULT;
