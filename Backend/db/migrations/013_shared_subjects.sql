CREATE TABLE attendance.subject_sync_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
 allowed_apps text[] NOT NULL DEFAULT ARRAY['subject-finder','attendance','parent-child'],
 is_active boolean NOT NULL DEFAULT true, last_success_at timestamptz,
 CHECK(allowed_apps <@ ARRAY['subject-finder','attendance','parent-child']::text[])
);
CREATE TABLE attendance.subject_api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES attendance.subject_sync_sources(id),
 key_hash text NOT NULL UNIQUE CHECK(key_hash ~ '^[a-f0-9]{64}$'),
 is_active boolean NOT NULL DEFAULT true, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE attendance.subjects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES attendance.subject_sync_sources(id),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 128), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,external_id)
);
CREATE TABLE attendance.subject_app_access (
 subject_id uuid NOT NULL REFERENCES attendance.subjects(id), app text NOT NULL CHECK(app IN ('subject-finder','attendance','parent-child')),
 PRIMARY KEY(subject_id,app)
);
CREATE TABLE attendance.subject_person_links (
 subject_id uuid NOT NULL REFERENCES attendance.subjects(id), person_id uuid NOT NULL UNIQUE REFERENCES attendance.people(id),
 PRIMARY KEY(subject_id,person_id)
);
CREATE TABLE attendance.subject_face_references (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_id uuid NOT NULL REFERENCES attendance.subjects(id),
 image_sha256 text NOT NULL CHECK(image_sha256 ~ '^[a-f0-9]{64}$'), image_bytes bytea NOT NULL CHECK(octet_length(image_bytes) BETWEEN 100 AND 4194304),
 is_active boolean NOT NULL DEFAULT true, model_version text NOT NULL DEFAULT 'sface-2021dec', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(subject_id,image_sha256)
);
CREATE TABLE attendance.subject_catalog_version (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version bigint NOT NULL DEFAULT 1);
INSERT INTO attendance.subject_catalog_version VALUES(true,1);
CREATE TABLE attendance.subject_sync_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES attendance.subject_sync_sources(id),
 subject_id uuid NOT NULL REFERENCES attendance.subjects(id), action text NOT NULL, version bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subject_sync_audit_append_only BEFORE UPDATE OR DELETE ON attendance.subject_sync_audit FOR EACH ROW EXECUTE FUNCTION attendance.reject_audit_edit();
INSERT INTO attendance.subject_sync_sources(id,name) VALUES('f3102026-0000-4000-8000-000000009000','existing-team');
INSERT INTO attendance.subjects(id,source_id,external_id,name)
 SELECT DISTINCT ON (r.reference_key) r.person_id,'f3102026-0000-4000-8000-000000009000',r.reference_key,p.full_name
 FROM attendance.team_face_references r JOIN attendance.people p ON p.id=r.person_id
 WHERE r.is_active AND p.is_active ORDER BY r.reference_key,r.group_id;
INSERT INTO attendance.subject_person_links(subject_id,person_id)
 SELECT s.id,r.person_id FROM attendance.team_face_references r JOIN attendance.subjects s ON s.external_id=r.reference_key ON CONFLICT DO NOTHING;
INSERT INTO attendance.subject_app_access SELECT s.id,a.app FROM attendance.subjects s CROSS JOIN unnest(ARRAY['subject-finder','attendance','parent-child']) a(app);
INSERT INTO attendance.subject_face_references(subject_id,image_sha256,image_bytes)
 SELECT s.id,r.image_sha256,r.image_bytes FROM attendance.team_face_references r JOIN attendance.subjects s ON s.external_id=r.reference_key ON CONFLICT DO NOTHING;
REVOKE ALL ON attendance.subject_sync_sources,attendance.subject_api_keys,attendance.subjects,attendance.subject_app_access,attendance.subject_person_links,attendance.subject_face_references,attendance.subject_catalog_version,attendance.subject_sync_audit FROM PUBLIC;
