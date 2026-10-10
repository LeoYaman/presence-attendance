-- Anonymous reference images are archival data, never student enrollments.
CREATE TABLE attendance.face_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  attribution text NOT NULL CHECK (btrim(attribution) <> ''),
  source_readme text NOT NULL CHECK (btrim(source_readme) <> ''),
  test_only boolean NOT NULL DEFAULT true CHECK (test_only),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance.face_dataset_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES attendance.face_datasets(id) ON DELETE RESTRICT,
  subject_key text NOT NULL CHECK (subject_key ~ '^s([1-9]|[1-3][0-9]|40)$'),
  UNIQUE (dataset_id, subject_key)
);

CREATE TABLE attendance.face_dataset_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES attendance.face_dataset_subjects(id) ON DELETE RESTRICT,
  image_key text NOT NULL CHECK (image_key ~ '^([1-9]|10)\.pgm$'),
  original_path text NOT NULL CHECK (original_path ~ '^s([1-9]|[1-3][0-9]|40)/([1-9]|10)\.pgm$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK (width = 92),
  height integer NOT NULL CHECK (height = 112),
  mime_type text NOT NULL CHECK (mime_type = 'image/x-portable-graymap'),
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) >= 10304 AND octet_length(image_bytes) <= 11328),
  UNIQUE (subject_id, image_key)
);

COMMENT ON TABLE attendance.face_datasets IS 'Source archives for anonymous reference face data; no association with attendance people.';
COMMENT ON TABLE attendance.face_dataset_subjects IS 'Original anonymous archive identifiers, not student identities.';
REVOKE ALL ON attendance.face_datasets, attendance.face_dataset_subjects, attendance.face_dataset_images FROM PUBLIC;
