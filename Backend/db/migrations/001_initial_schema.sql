CREATE SCHEMA attendance;
REVOKE ALL ON SCHEMA attendance FROM PUBLIC;

CREATE TABLE attendance.people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_code text NOT NULL UNIQUE CHECK (btrim(person_code) <> ''),
  full_name text NOT NULL CHECK (btrim(full_name) <> ''),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid UNIQUE REFERENCES attendance.people(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (btrim(email) <> ''),
  password_hash text NOT NULL CHECK (btrim(password_hash) <> ''),
  role text NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  email_notifications boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'student' OR person_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_unique ON attendance.users (lower(btrim(email)));

-- A group represents one class section in one term, not every offering of a course.
CREATE TABLE attendance.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  course_code text NOT NULL CHECK (btrim(course_code) <> ''),
  term_name text NOT NULL CHECK (btrim(term_name) <> ''),
  term_starts_on date NOT NULL,
  term_ends_on date NOT NULL,
  time_zone text NOT NULL DEFAULT 'UTC',
  allowed_absences integer NOT NULL DEFAULT 10 CHECK (allowed_absences >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (term_ends_on >= term_starts_on)
);

CREATE TABLE attendance.group_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES attendance.groups(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES attendance.people(id) ON DELETE RESTRICT,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (left_at IS NULL OR left_at > joined_at),
  UNIQUE (group_id, person_id, joined_at)
);
CREATE UNIQUE INDEX memberships_one_active ON attendance.group_memberships (group_id, person_id) WHERE left_at IS NULL;
CREATE INDEX memberships_person_idx ON attendance.group_memberships (person_id, group_id);

CREATE TABLE attendance.group_staff (
  group_id uuid NOT NULL REFERENCES attendance.groups(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES attendance.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_staff_user_idx ON attendance.group_staff (user_id, group_id);

CREATE TABLE attendance.attendance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES attendance.groups(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  late_after_minutes integer NOT NULL DEFAULT 10 CHECK (late_after_minutes >= 0),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'open', 'closed', 'cancelled')),
  opened_at timestamptz,
  closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES attendance.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (closed_at IS NULL OR (opened_at IS NOT NULL AND closed_at >= opened_at)),
  CHECK (
    (status = 'planned' AND opened_at IS NULL AND closed_at IS NULL) OR
    (status = 'open' AND opened_at IS NOT NULL AND closed_at IS NULL) OR
    (status = 'closed' AND opened_at IS NOT NULL AND closed_at IS NOT NULL) OR
    (status = 'cancelled' AND opened_at IS NULL AND closed_at IS NULL)
  )
);
CREATE INDEX sessions_group_time_idx ON attendance.attendance_sessions (group_id, starts_at DESC);

-- Rows are the immutable participant snapshot as well as the attendance result.
CREATE TABLE attendance.attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES attendance.attendance_sessions(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES attendance.people(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'present', 'late', 'absent')),
  checked_in_at timestamptz,
  method text CHECK (method IN ('face', 'manual', 'system')),
  confidence numeric(6,5) CHECK (confidence >= 0 AND confidence <= 1),
  recorded_by uuid REFERENCES attendance.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, person_id),
  CHECK (
    (status = 'pending' AND checked_in_at IS NULL AND method IS NULL AND confidence IS NULL AND recorded_by IS NULL) OR
    (status IN ('present', 'late') AND checked_in_at IS NOT NULL AND method IS NOT NULL AND method IN ('face', 'manual') AND recorded_by IS NOT NULL) OR
    (status = 'absent' AND checked_in_at IS NULL AND method IS NOT NULL AND method IN ('manual', 'system') AND confidence IS NULL AND recorded_by IS NOT NULL)
  ),
  CHECK ((method = 'face' AND confidence IS NOT NULL) OR (method IS DISTINCT FROM 'face' AND confidence IS NULL))
);
CREATE INDEX records_person_session_idx ON attendance.attendance_records (person_id, session_id);

CREATE TABLE attendance.face_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES attendance.people(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  template_ref text CHECK (template_ref IS NULL OR btrim(template_ref) <> ''),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed', 'deletion_pending', 'deleted')),
  consent_recorded_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES attendance.users(id) ON DELETE RESTRICT,
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR template_ref IS NOT NULL),
  CHECK (status <> 'deletion_pending' OR deletion_requested_at IS NOT NULL),
  CHECK ((status = 'deleted' AND deleted_at IS NOT NULL AND deletion_requested_at IS NOT NULL AND template_ref IS NULL) OR
         (status <> 'deleted' AND deleted_at IS NULL)),
  CHECK (deleted_at IS NULL OR deleted_at >= deletion_requested_at)
);
CREATE UNIQUE INDEX face_one_active_per_person ON attendance.face_enrollments (person_id) WHERE status = 'active';
CREATE UNIQUE INDEX face_template_unique ON attendance.face_enrollments (provider, template_ref) WHERE template_ref IS NOT NULL;
CREATE INDEX face_person_idx ON attendance.face_enrollments (person_id);

CREATE TABLE attendance.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES attendance.users(id) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type IN ('session', 'attendance_record', 'face_enrollment')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (btrim(action) <> ''),
  before_value jsonb,
  after_value jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON attendance.audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_actor_idx ON attendance.audit_logs (actor_user_id, created_at DESC);

CREATE FUNCTION attendance.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION attendance.validate_group_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown group time zone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER groups_timezone BEFORE INSERT OR UPDATE ON attendance.groups
FOR EACH ROW EXECUTE FUNCTION attendance.validate_group_timezone();

-- Serialize membership edits for a person and reject overlapping historical ranges.
CREATE FUNCTION attendance.validate_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.person_id <> OLD.person_id OR NEW.group_id <> OLD.group_id) THEN
    RAISE EXCEPTION 'End the old membership and create a new membership instead';
  END IF;
  -- Opening a session takes this same group lock before choosing its roster.
  PERFORM 1 FROM attendance.groups WHERE id = NEW.group_id FOR UPDATE;
  PERFORM 1 FROM attendance.people WHERE id = NEW.person_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM attendance.group_memberships m
    WHERE m.group_id = NEW.group_id AND m.person_id = NEW.person_id AND m.id <> NEW.id
      AND tstzrange(m.joined_at, m.left_at, '[)') && tstzrange(NEW.joined_at, NEW.left_at, '[)')
  ) THEN
    RAISE EXCEPTION 'Membership periods cannot overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER membership_periods BEFORE INSERT OR UPDATE ON attendance.group_memberships
FOR EACH ROW EXECUTE FUNCTION attendance.validate_membership();

CREATE FUNCTION attendance.reject_audit_edit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
BEGIN
  RAISE EXCEPTION 'Audit history is append-only';
END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON attendance.audit_logs
FOR EACH ROW EXECUTE FUNCTION attendance.reject_audit_edit();

CREATE TRIGGER people_updated BEFORE UPDATE ON attendance.people FOR EACH ROW EXECUTE FUNCTION attendance.touch_updated_at();
CREATE TRIGGER users_updated BEFORE UPDATE ON attendance.users FOR EACH ROW EXECUTE FUNCTION attendance.touch_updated_at();
CREATE TRIGGER groups_updated BEFORE UPDATE ON attendance.groups FOR EACH ROW EXECUTE FUNCTION attendance.touch_updated_at();
CREATE TRIGGER sessions_updated BEFORE UPDATE ON attendance.attendance_sessions FOR EACH ROW EXECUTE FUNCTION attendance.touch_updated_at();
CREATE TRIGGER records_updated BEFORE UPDATE ON attendance.attendance_records FOR EACH ROW EXECUTE FUNCTION attendance.touch_updated_at();
CREATE TRIGGER enrollments_updated BEFORE UPDATE ON attendance.face_enrollments FOR EACH ROW EXECUTE FUNCTION attendance.touch_updated_at();

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA attendance FROM PUBLIC;
