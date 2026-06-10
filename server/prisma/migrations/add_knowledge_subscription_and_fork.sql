-- Add new fields to KnowledgeAsset for fork lineage and metadata
ALTER TABLE "KnowledgeAsset" ADD COLUMN IF NOT EXISTS "forkedFromId" TEXT;
ALTER TABLE "KnowledgeAsset" ADD COLUMN IF NOT EXISTS "lineageRootId" TEXT;
ALTER TABLE "KnowledgeAsset" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Add foreign key indexes
CREATE INDEX IF NOT EXISTS "KnowledgeAsset_forkedFromId_idx" ON "KnowledgeAsset" ("forkedFromId");
CREATE INDEX IF NOT EXISTS "KnowledgeAsset_lineageRootId_idx" ON "KnowledgeAsset" ("lineageRootId");

-- Create KnowledgeSubscription table
CREATE TABLE IF NOT EXISTS "KnowledgeSubscription" (
  "id" TEXT NOT NULL,
  "knowledgeAssetId" TEXT NOT NULL,
  "ownerType" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "updatePolicy" TEXT NOT NULL DEFAULT 'notify',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "KnowledgeSubscription_pkey" PRIMARY KEY ("id")
);

-- Add unique constraint and indexes
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeSubscription_knowledgeAssetId_ownerType_ownerId_key"
  ON "KnowledgeSubscription" ("knowledgeAssetId", "ownerType", "ownerId");

CREATE INDEX IF NOT EXISTS "KnowledgeSubscription_ownerType_ownerId_idx"
  ON "KnowledgeSubscription" ("ownerType", "ownerId");

-- Add foreign key constraint
ALTER TABLE "KnowledgeSubscription"
  ADD CONSTRAINT "KnowledgeSubscription_knowledgeAssetId_fkey"
  FOREIGN KEY ("knowledgeAssetId") REFERENCES "KnowledgeAsset"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
