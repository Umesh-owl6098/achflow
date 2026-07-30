ALTER TYPE "ReservationStatus" ADD VALUE 'RETURNED';
ALTER TABLE "Reservation" ADD COLUMN "returnedAt" TIMESTAMP(3), ADD COLUMN "returnCode" TEXT;
