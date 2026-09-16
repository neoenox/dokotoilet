-- D1 schema for the Pages/Workers community backend (#114).
-- Mirrors docs/durable-community-backend.md data model.
-- JSON Text columns store sanitized user content (same textPolicy guarantees).

CREATE TABLE IF NOT EXISTS community_toilets (
  facility_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  floor_info TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL,
  -- 'community' = community-registered toilet, 'external' = osm-*/google-*/od-*
  facility_kind TEXT NOT NULL DEFAULT 'community',
  user_name TEXT NOT NULL,
  overall_score REAL,
  cleanliness_score REAL NOT NULL,
  odor_score REAL NOT NULL,
  supplies_score REAL NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  comment_hash TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reviews_facility ON reviews (facility_id, deleted, created_at);

CREATE TABLE IF NOT EXISTS facility_aggregates (
  facility_id TEXT PRIMARY KEY,
  review_count INTEGER NOT NULL DEFAULT 0,
  overall_sum REAL NOT NULL DEFAULT 0,
  cleanliness_sum REAL NOT NULL DEFAULT 0,
  odor_sum REAL NOT NULL DEFAULT 0,
  supplies_sum REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review_dedup (
  dedup_key TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  comment_hash TEXT NOT NULL,
  valid_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_expiry ON review_dedup (valid_until);

CREATE TABLE IF NOT EXISTS helpful_votes (
  vote_key TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_review ON helpful_votes (review_id);

CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at);

CREATE TABLE IF NOT EXISTS external_facilities (
  facility_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'manual',
  first_seen_at TEXT NOT NULL
);
