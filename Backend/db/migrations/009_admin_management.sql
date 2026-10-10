-- Add administrative configuration without changing historical attendance data.
ALTER TABLE attendance.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE attendance.audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN ('session','attendance_record','face_enrollment','student','user','course','membership','staff_assignment','settings'));
CREATE TABLE IF NOT EXISTS attendance.admin_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  recording_retention_days integer NOT NULL DEFAULT 7 CHECK (recording_retention_days BETWEEN 1 AND 90),
  recording_max_mb integer NOT NULL DEFAULT 1024 CHECK (recording_max_mb BETWEEN 1 AND 1024),
  recording_storage_max_mb integer NOT NULL DEFAULT 10240 CHECK (recording_storage_max_mb BETWEEN 1 AND 1048576),
  storage_mode text NOT NULL DEFAULT 'local' CHECK (storage_mode='local'),
  default_allowed_absences integer NOT NULL DEFAULT 10 CHECK (default_allowed_absences BETWEEN 0 AND 100),
  default_late_after_minutes integer NOT NULL DEFAULT 10 CHECK (default_late_after_minutes BETWEEN 0 AND 180),
  default_time_zone text NOT NULL DEFAULT 'America/New_York',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO attendance.admin_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
CREATE OR REPLACE TRIGGER admin_settings_updated BEFORE UPDATE ON attendance.admin_settings
FOR EACH ROW EXECUTE FUNCTION attendance.touch_updated_at();
-- Serialize all privilege changes so simultaneous admin demotions cannot strand the system.
CREATE OR REPLACE FUNCTION attendance.protect_last_admin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,attendance AS $$
BEGIN
  IF OLD.role='admin' AND OLD.is_active AND (TG_OP='DELETE' OR NEW.role<>'admin' OR NOT NEW.is_active) THEN
    PERFORM pg_advisory_xact_lock(710202611);
    IF NOT EXISTS (SELECT 1 FROM attendance.users WHERE role='admin' AND is_active AND id<>OLD.id) THEN
      RAISE EXCEPTION 'The last active administrator cannot be deactivated or demoted' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE OR REPLACE TRIGGER users_last_admin BEFORE UPDATE OR DELETE ON attendance.users
FOR EACH ROW EXECUTE FUNCTION attendance.protect_last_admin();
REVOKE EXECUTE ON FUNCTION attendance.protect_last_admin() FROM PUBLIC;
