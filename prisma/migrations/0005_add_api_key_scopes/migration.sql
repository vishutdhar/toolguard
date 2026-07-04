-- Add per-key capability scopes. Existing keys are backfilled to full access
-- (["*"]) so nothing is locked out; least-privilege keys can now be minted with
-- a restricted scope list (e.g. omitting "approvals:resolve").
ALTER TABLE "ApiKey" ADD COLUMN "scopes" JSONB NOT NULL DEFAULT '["*"]';
