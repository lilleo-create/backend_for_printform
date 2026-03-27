-- AlterTable
ALTER TABLE "ReviewReply"
  ADD COLUMN "moderationStatus" "ReviewModerationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "moderationNotes" TEXT,
  ADD COLUMN "moderatedAt" TIMESTAMP(3),
  ADD COLUMN "moderatedById" TEXT;

-- CreateIndex
CREATE INDEX "ReviewReply_reviewId_moderationStatus_createdAt_idx" ON "ReviewReply"("reviewId", "moderationStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "ReviewReply" ADD CONSTRAINT "ReviewReply_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
