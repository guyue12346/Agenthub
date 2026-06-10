CREATE TABLE IF NOT EXISTS "HubAssetLike" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "HubAssetLike_kind_assetId_userId_key"
  ON "HubAssetLike" ("kind", "assetId", "userId");

CREATE INDEX IF NOT EXISTS "HubAssetLike_kind_assetId_idx"
  ON "HubAssetLike" ("kind", "assetId");

CREATE INDEX IF NOT EXISTS "HubAssetLike_userId_idx"
  ON "HubAssetLike" ("userId");
