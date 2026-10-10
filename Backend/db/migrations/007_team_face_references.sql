-- Explicitly mapped team demo photographs, separate from anonymous ORL data.
CREATE TABLE attendance.team_face_references (
  reference_key text PRIMARY KEY CHECK (reference_key IN ('team_anthony','team_leo','team_rebbeca','team_olivia')),
  group_id uuid NOT NULL REFERENCES attendance.groups(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL UNIQUE REFERENCES attendance.people(id) ON DELETE RESTRICT,
  source_path text NOT NULL UNIQUE CHECK (source_path ~ '^face_data/people_faces/WIN_[0-9_]+_Pro\.jpg$'),
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) BETWEEN 100 AND 4194304),
  is_active boolean NOT NULL DEFAULT true,
  imported_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE attendance.team_face_references IS 'User-confirmed repository name/photo mappings for teacher-reviewed team demo recognition; not verified automatic attendance.';
REVOKE ALL ON attendance.team_face_references FROM PUBLIC;
