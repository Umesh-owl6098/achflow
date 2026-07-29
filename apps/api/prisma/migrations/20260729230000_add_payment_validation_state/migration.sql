-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'VALIDATION_FAILED';

-- AlterTable
ALTER TABLE "Payment"
ADD COLUMN "validationCode" TEXT,
ADD COLUMN "validationMessage" TEXT,
ADD COLUMN "validatedAt" TIMESTAMP(3);
