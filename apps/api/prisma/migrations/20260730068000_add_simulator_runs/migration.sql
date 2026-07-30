CREATE TYPE "SimulatorRunStatus" AS ENUM ('RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED', 'FAILED');

CREATE TABLE "SimulatorRun" (
    "id" TEXT NOT NULL,
    "status" "SimulatorRunStatus" NOT NULL DEFAULT 'RUNNING',
    "configuration" JSONB NOT NULL,
    "merchantIds" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "generatedCount" INTEGER NOT NULL DEFAULT 0,
    "successfulCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "returnedCount" INTEGER NOT NULL DEFAULT 0,
    "averageLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "failureSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SimulatorRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SimulatorRun_createdAt_idx" ON "SimulatorRun"("createdAt");
CREATE INDEX "SimulatorRun_status_idx" ON "SimulatorRun"("status");
