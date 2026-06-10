DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SessionKind') THEN
    CREATE TYPE "SessionKind" AS ENUM ('user', 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SessionClientType') THEN
    CREATE TYPE "SessionClientType" AS ENUM ('web', 'app', 'desktop');
  END IF;
END $$;

ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "kind" "SessionKind" NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS "clientType" "SessionClientType" NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT;

CREATE INDEX IF NOT EXISTS "Session_userId_kind_clientType_idx" ON "Session"("userId", "kind", "clientType");
