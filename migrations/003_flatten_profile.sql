-- Flatten profile JSONB into top-level columns
-- Run: psql -U your_user -d your_db -f migrations/003_flatten_profile.sql

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS business_name VARCHAR(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT '',
  ADD COLUMN IF NOT EXISTS manufacture TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS produce VARCHAR(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS location VARCHAR(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_urls JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';

-- Migrate existing data from profile JSONB to new columns
UPDATE users SET
  business_name = COALESCE(profile->>'businessName', ''),
  category      = COALESCE(profile->>'category', ''),
  manufacture   = COALESCE(profile->>'manufacture', ''),
  produce       = COALESCE(profile->>'produce', ''),
  location      = COALESCE(profile->>'location', ''),
  image_urls    = COALESCE(profile->'imageUrls', '[]'::jsonb),
  bio           = COALESCE(profile->>'bio', '')
WHERE profile IS NOT NULL AND profile != '{}'::jsonb;

COMMIT;
