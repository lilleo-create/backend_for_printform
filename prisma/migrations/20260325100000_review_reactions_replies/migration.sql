-- CreateEnum
CREATE TYPE "ReviewReactionType" AS ENUM ('LIKE', 'DISLIKE');

-- CreateEnum
CREATE TYPE "ReviewReplyAuthorType" AS ENUM ('BUYER', 'SELLER', 'ADMIN');

-- CreateTable
CREATE TABLE "ReviewReaction" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReviewReactionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewReply" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorType" "ReviewReplyAuthorType" NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReaction_reviewId_userId_key" ON "ReviewReaction"("reviewId", "userId");

-- CreateIndex
CREATE INDEX "ReviewReaction_reviewId_type_idx" ON "ReviewReaction"("reviewId", "type");

-- CreateIndex
CREATE INDEX "ReviewReaction_userId_idx" ON "ReviewReaction"("userId");

-- CreateIndex
CREATE INDEX "ReviewReply_reviewId_createdAt_idx" ON "ReviewReply"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewReply_authorId_idx" ON "ReviewReply"("authorId");

-- AddForeignKey
ALTER TABLE "ReviewReaction" ADD CONSTRAINT "ReviewReaction_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReaction" ADD CONSTRAINT "ReviewReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReply" ADD CONSTRAINT "ReviewReply_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReply" ADD CONSTRAINT "ReviewReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
