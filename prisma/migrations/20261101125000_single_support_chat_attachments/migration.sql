-- Preserve every message. The most recently active ordinary support thread stays ACTIVE;
-- older duplicate conversations become readable CLOSED archive entries.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "userId"
    ORDER BY COALESCE("lastMessageAt", "createdAt") DESC, "createdAt" DESC, "id" DESC
  ) AS position
  FROM "ChatThread"
  WHERE "kind" = 'SUPPORT' AND "status" = 'ACTIVE'
    AND "returnRequestId" IS NULL AND "deletedAt" IS NULL
)
UPDATE "ChatThread" AS thread SET "status" = 'CLOSED'
FROM ranked WHERE thread."id" = ranked."id" AND ranked.position > 1;

CREATE UNIQUE INDEX "ChatThread_one_active_ordinary_support_per_user"
ON "ChatThread" ("userId")
WHERE "kind" = 'SUPPORT' AND "status" = 'ACTIVE'
  AND "returnRequestId" IS NULL AND "deletedAt" IS NULL;

CREATE TABLE "ChatMessageAttachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'IMAGE',
  "url" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessageAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChatMessageAttachment_messageId_idx" ON "ChatMessageAttachment"("messageId");
ALTER TABLE "ChatMessageAttachment" ADD CONSTRAINT "ChatMessageAttachment_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
