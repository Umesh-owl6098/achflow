CREATE TABLE "AchFile" (
  "id" TEXT NOT NULL, "fileName" TEXT NOT NULL, "companyId" TEXT NOT NULL,
  "effectiveEntryDate" DATE NOT NULL, "status" TEXT NOT NULL, "totalEntries" INTEGER NOT NULL,
  "debitTotalCents" BIGINT NOT NULL, "creditTotalCents" BIGINT NOT NULL, "entryHash" TEXT NOT NULL,
  "sha256" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AchFile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AchFile_fileName_key" ON "AchFile"("fileName");
CREATE INDEX "AchFile_companyId_effectiveEntryDate_idx" ON "AchFile"("companyId", "effectiveEntryDate");
ALTER TABLE "Payment" ADD COLUMN "exportedAt" TIMESTAMP(3), ADD COLUMN "achFileId" TEXT;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_achFileId_fkey" FOREIGN KEY ("achFileId") REFERENCES "AchFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Payment_achFileId_idx" ON "Payment"("achFileId");
