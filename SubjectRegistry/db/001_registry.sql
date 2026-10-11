CREATE SCHEMA IF NOT EXISTS registry;
CREATE TABLE registry.sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
 allowed_apps text[] NOT NULL, is_active boolean NOT NULL DEFAULT true,
 last_success_at timestamptz,
 CHECK (cardinality(allowed_apps)>0 AND allowed_apps <@ ARRAY['subject-finder','attendance','parent-child']::text[])
);
CREATE TABLE registry.api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid REFERENCES registry.sources(id),
 key_hash text NOT NULL UNIQUE CHECK(key_hash ~ '^[a-f0-9]{64}$'),
 privilege text NOT NULL CHECK(privilege IN ('read','write')), allowed_apps text[],
 is_active boolean NOT NULL DEFAULT true, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((privilege='write' AND source_id IS NOT NULL AND allowed_apps IS NULL) OR
 (privilege='read' AND source_id IS NULL AND cardinality(allowed_apps)>0 AND allowed_apps <@ ARRAY['subject-finder','attendance','parent-child']::text[]))
);
CREATE TABLE registry.subjects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES registry.sources(id),
 external_id text NOT NULL CHECK(external_id ~ '^[A-Za-z0-9._-]{1,128}$'),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,external_id)
);
CREATE TABLE registry.app_access (
 subject_id uuid NOT NULL REFERENCES registry.subjects(id) ON DELETE CASCADE,
 app text NOT NULL CHECK(app IN ('subject-finder','attendance','parent-child')), PRIMARY KEY(subject_id,app)
);
CREATE TABLE registry.face_references (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_id uuid NOT NULL REFERENCES registry.subjects(id) ON DELETE CASCADE,
 image_sha256 text NOT NULL CHECK(image_sha256 ~ '^[a-f0-9]{64}$'),
 image_bytes bytea NOT NULL CHECK(octet_length(image_bytes) BETWEEN 100 AND 262500),
 is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(subject_id,image_sha256)
);
CREATE TABLE registry.catalog_version (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version bigint NOT NULL DEFAULT 1);
INSERT INTO registry.catalog_version VALUES(true,1);
-- Immutable snapshots deliberately have no subject/source foreign keys and contain no face bytes.
CREATE TABLE registry.audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid, subject_id uuid,
 action text NOT NULL, version bigint NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION registry.reject_audit_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Registry audit is append-only'; END; $$;
CREATE TRIGGER registry_audit_append_only BEFORE UPDATE OR DELETE ON registry.audit
 FOR EACH ROW EXECUTE FUNCTION registry.reject_audit_edit();
REVOKE ALL ON ALL TABLES IN SCHEMA registry FROM PUBLIC;
