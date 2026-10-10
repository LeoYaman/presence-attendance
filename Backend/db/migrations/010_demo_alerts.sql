-- Isolated fictional alert feed for local demonstrations. It has no links to
-- attendance people, users, sessions, records, or biometric data.
CREATE SCHEMA IF NOT EXISTS demo;
CREATE TABLE IF NOT EXISTS demo.alerts (
  id text PRIMARY KEY CHECK (id ~ '^demo-[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scenario text NOT NULL CHECK (length(scenario) BETWEEN 1 AND 240),
  synthetic boolean NOT NULL DEFAULT true CHECK (synthetic),
  fictional boolean NOT NULL DEFAULT true CHECK (fictional),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_alerts_active_idx ON demo.alerts(active, id);
