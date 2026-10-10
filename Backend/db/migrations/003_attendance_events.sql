-- Production requires TimescaleDB. Tests use an explicitly separate local shim.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    RAISE EXCEPTION 'TimescaleDB is required for migration 003; use a Timescale-enabled PostgreSQL service' USING ERRCODE = '0A000';
  END IF;
END;
$$;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE attendance.attendance_events (
  event_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES attendance.attendance_records(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES attendance.attendance_sessions(id) ON DELETE RESTRICT,
  group_id uuid NOT NULL REFERENCES attendance.groups(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES attendance.people(id) ON DELETE RESTRICT,
  -- Pending snapshot rows have no record actor. The session-opening audit entry
  -- identifies the actual opener; the session creator need not be that person.
  actor_user_id uuid REFERENCES attendance.users(id) ON DELETE RESTRICT,
  event_kind text NOT NULL CHECK (event_kind IN ('roster_snapshot', 'state_change')),
  status text NOT NULL CHECK (status IN ('pending','present','late','absent')),
  checked_in_at timestamptz,
  method text,
  confidence numeric(6,5),
  previous_status text,
  PRIMARY KEY (event_time, event_id)
);
SELECT create_hypertable('attendance.attendance_events', 'event_time', chunk_time_interval => interval '7 days');
CREATE INDEX events_record_time_idx ON attendance.attendance_events (record_id, event_time DESC);
CREATE INDEX events_group_time_idx ON attendance.attendance_events (group_id, event_time DESC);
CREATE INDEX events_session_time_idx ON attendance.attendance_events (session_id, event_time DESC);

CREATE FUNCTION attendance.capture_attendance_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
DECLARE v_session attendance.attendance_sessions;
BEGIN
  IF TG_OP = 'UPDATE' AND
    ROW(NEW.status, NEW.checked_in_at, NEW.method, NEW.confidence) IS NOT DISTINCT FROM
    ROW(OLD.status, OLD.checked_in_at, OLD.method, OLD.confidence) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT v_session FROM attendance.attendance_sessions WHERE id = NEW.session_id;
  INSERT INTO attendance.attendance_events
    (record_id,session_id,group_id,person_id,actor_user_id,event_kind,status,checked_in_at,method,confidence,previous_status)
  VALUES (NEW.id,NEW.session_id,v_session.group_id,NEW.person_id,NEW.recorded_by,
    CASE WHEN TG_OP = 'INSERT' THEN 'roster_snapshot' ELSE 'state_change' END,
    NEW.status,NEW.checked_in_at,NEW.method,NEW.confidence,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END);
  RETURN NEW;
END;
$$;
CREATE TRIGGER records_event AFTER INSERT OR UPDATE ON attendance.attendance_records
FOR EACH ROW EXECUTE FUNCTION attendance.capture_attendance_event();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON attendance.attendance_events
FOR EACH ROW EXECUTE FUNCTION attendance.reject_audit_edit();

-- Import existing relational states when upgrading, without inventing older history.
INSERT INTO attendance.attendance_events
  (record_id,session_id,group_id,person_id,actor_user_id,event_kind,status,checked_in_at,method,confidence)
SELECT r.id,r.session_id,s.group_id,r.person_id,r.recorded_by,
  'roster_snapshot',r.status,r.checked_in_at,r.method,r.confidence
FROM attendance.attendance_records r JOIN attendance.attendance_sessions s ON s.id=r.session_id;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA attendance FROM PUBLIC;
