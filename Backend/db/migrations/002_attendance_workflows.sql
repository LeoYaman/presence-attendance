-- Actor IDs must come from the authenticated backend, never from request bodies.
-- All routines are SECURITY INVOKER: they do not grant additional DB privileges.
CREATE FUNCTION attendance.require_group_manager(p_actor uuid, p_group uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM attendance.users u
    WHERE u.id = p_actor AND u.is_active AND
      (u.role = 'admin' OR (u.role = 'teacher' AND EXISTS (
        SELECT 1 FROM attendance.group_staff gs WHERE gs.group_id = p_group AND gs.user_id = u.id
      )))
  ) THEN
    RAISE EXCEPTION 'Not authorized to manage this group' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION attendance.open_session(p_session uuid, p_actor uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
DECLARE
  v_session attendance.attendance_sessions;
  v_opened timestamptz;
  v_count integer;
BEGIN
  SELECT * INTO v_session FROM attendance.attendance_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  PERFORM attendance.require_group_manager(p_actor, v_session.group_id);
  IF v_session.status = 'open' THEN
    RETURN (SELECT count(*)::integer FROM attendance.attendance_records WHERE session_id = p_session);
  END IF;
  IF v_session.status <> 'planned' THEN RAISE EXCEPTION 'Only planned sessions can be opened'; END IF;
  PERFORM 1 FROM attendance.groups WHERE id = v_session.group_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Group is inactive';
  END IF;
  v_opened := clock_timestamp();
  IF v_opened >= v_session.ends_at THEN RAISE EXCEPTION 'Session has already ended'; END IF;
  INSERT INTO attendance.attendance_records (session_id, person_id)
    SELECT p_session, m.person_id FROM attendance.group_memberships m
    JOIN attendance.people p ON p.id = m.person_id AND p.is_active
    WHERE m.group_id = v_session.group_id AND m.joined_at <= v_opened
      AND (m.left_at IS NULL OR m.left_at > v_opened);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE attendance.attendance_sessions SET status = 'open', opened_at = v_opened WHERE id = p_session;
  INSERT INTO attendance.audit_logs (actor_user_id, entity_type, entity_id, action, before_value, after_value)
    VALUES (p_actor, 'session', p_session, 'session_opened', to_jsonb(v_session),
      jsonb_build_object('status', 'open', 'opened_at', v_opened, 'participants', v_count));
  RETURN v_count;
END;
$$;

CREATE FUNCTION attendance.record_check_in(
  p_session uuid, p_person uuid, p_actor uuid,
  p_method text DEFAULT 'manual', p_confidence numeric DEFAULT NULL, p_enrollment uuid DEFAULT NULL
) RETURNS attendance.attendance_records
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
DECLARE
  v_session attendance.attendance_sessions;
  v_before attendance.attendance_records;
  v_result attendance.attendance_records;
  v_now timestamptz;
BEGIN
  SELECT * INTO v_session FROM attendance.attendance_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  PERFORM attendance.require_group_manager(p_actor, v_session.group_id);
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'Session is not open'; END IF;
  v_now := clock_timestamp();
  IF v_now >= v_session.ends_at THEN RAISE EXCEPTION 'Session has ended; finalize it before making corrections'; END IF;
  SELECT * INTO v_before FROM attendance.attendance_records
    WHERE session_id = p_session AND person_id = p_person FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Person is not on the session roster'; END IF;
  IF p_method IS NULL OR p_method NOT IN ('manual', 'face') THEN RAISE EXCEPTION 'Invalid check-in method'; END IF;
  IF p_method = 'face' THEN
    IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN RAISE EXCEPTION 'Face confidence must be between 0 and 1'; END IF;
    PERFORM 1 FROM attendance.face_enrollments
      WHERE id = p_enrollment AND person_id = p_person AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active face enrollment required'; END IF;
  ELSIF p_confidence IS NOT NULL OR p_enrollment IS NOT NULL THEN
    RAISE EXCEPTION 'Manual check-in cannot contain face matching data';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM attendance.people WHERE id = p_person AND is_active) THEN RAISE EXCEPTION 'Person is inactive'; END IF;
  -- Returning the existing result preserves the first check-in and manual decisions.
  IF v_before.status <> 'pending' THEN RETURN v_before; END IF;
  UPDATE attendance.attendance_records SET
    status = CASE WHEN v_now > v_session.starts_at + make_interval(mins => v_session.late_after_minutes)
      THEN 'late' ELSE 'present' END,
    checked_in_at = v_now, method = p_method, confidence = p_confidence, recorded_by = p_actor
    WHERE id = v_before.id RETURNING * INTO v_result;
  INSERT INTO attendance.audit_logs (actor_user_id, entity_type, entity_id, action, before_value, after_value)
    VALUES (p_actor, 'attendance_record', v_result.id, 'checked_in', to_jsonb(v_before), to_jsonb(v_result));
  RETURN v_result;
END;
$$;

CREATE FUNCTION attendance.close_session(p_session uuid, p_actor uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
DECLARE
  v_session attendance.attendance_sessions;
  v_count integer;
  v_closed timestamptz;
BEGIN
  SELECT * INTO v_session FROM attendance.attendance_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  PERFORM attendance.require_group_manager(p_actor, v_session.group_id);
  IF v_session.status = 'closed' THEN
    RETURN (SELECT count(*)::integer FROM attendance.attendance_records WHERE session_id = p_session AND status = 'absent');
  END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'Only open sessions can be closed'; END IF;
  v_closed := clock_timestamp();
  WITH pending AS MATERIALIZED (
    SELECT r.* FROM attendance.attendance_records r WHERE r.session_id = p_session AND r.status = 'pending'
  ), finalized AS (
    UPDATE attendance.attendance_records r SET status = 'absent', method = 'system', recorded_by = p_actor
    FROM pending p WHERE r.id = p.id RETURNING r.*, to_jsonb(p) AS previous
  )
  INSERT INTO attendance.audit_logs (actor_user_id, entity_type, entity_id, action, before_value, after_value)
    SELECT p_actor, 'attendance_record', f.id, 'absence_finalized', f.previous, to_jsonb(f) - 'previous' FROM finalized f;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE attendance.attendance_sessions SET status = 'closed', closed_at = v_closed WHERE id = p_session;
  INSERT INTO attendance.audit_logs (actor_user_id, entity_type, entity_id, action, before_value, after_value)
    VALUES (p_actor, 'session', p_session, 'session_closed', to_jsonb(v_session),
      jsonb_build_object('status', 'closed', 'closed_at', v_closed, 'new_absences', v_count));
  RETURN (SELECT count(*)::integer FROM attendance.attendance_records WHERE session_id = p_session AND status = 'absent');
END;
$$;

CREATE FUNCTION attendance.correct_attendance(
  p_record uuid, p_actor uuid, p_status text, p_reason text, p_checked_in_at timestamptz DEFAULT NULL
) RETURNS attendance.attendance_records
LANGUAGE plpgsql SET search_path = pg_catalog, attendance AS $$
DECLARE
  v_session attendance.attendance_sessions;
  v_before attendance.attendance_records;
  v_result attendance.attendance_records;
BEGIN
  SELECT s.* INTO v_session FROM attendance.attendance_sessions s
    JOIN attendance.attendance_records r ON r.session_id = s.id WHERE r.id = p_record FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attendance record not found'; END IF;
  PERFORM attendance.require_group_manager(p_actor, v_session.group_id);
  IF v_session.status NOT IN ('open', 'closed') THEN RAISE EXCEPTION 'Session cannot be corrected'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('present', 'late', 'absent') THEN RAISE EXCEPTION 'Invalid correction status'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Correction reason required'; END IF;
  IF p_status = 'absent' AND p_checked_in_at IS NOT NULL THEN RAISE EXCEPTION 'Absence cannot have a check-in time'; END IF;
  IF p_status IN ('present', 'late') AND (p_checked_in_at IS NULL OR p_checked_in_at < v_session.opened_at OR
    p_checked_in_at > coalesce(v_session.closed_at, clock_timestamp()) OR p_checked_in_at >= v_session.ends_at) THEN
    RAISE EXCEPTION 'Supply a valid check-in time inside the attendance window';
  END IF;
  SELECT * INTO v_before FROM attendance.attendance_records WHERE id = p_record FOR UPDATE;
  UPDATE attendance.attendance_records SET status = p_status, checked_in_at = p_checked_in_at,
    method = 'manual', confidence = NULL, recorded_by = p_actor WHERE id = p_record RETURNING * INTO v_result;
  INSERT INTO attendance.audit_logs (actor_user_id, entity_type, entity_id, action, before_value, after_value, reason)
    VALUES (p_actor, 'attendance_record', p_record, 'attendance_corrected', to_jsonb(v_before), to_jsonb(v_result), btrim(p_reason));
  RETURN v_result;
END;
$$;

-- These are backend views, NOT authorization boundaries. Filter by authenticated person.
CREATE VIEW attendance.student_history AS
SELECT r.id AS record_id, r.person_id, s.id AS session_id, g.id AS group_id,
  g.code AS group_code, g.course_code, g.name AS group_name, g.time_zone,
  s.starts_at, s.ends_at, s.status AS session_status, r.status, r.checked_in_at, r.method
FROM attendance.attendance_records r
JOIN attendance.attendance_sessions s ON s.id = r.session_id
JOIN attendance.groups g ON g.id = s.group_id
WHERE s.status <> 'cancelled';

CREATE VIEW attendance.student_absence_summary AS
WITH student_groups AS (
  SELECT DISTINCT group_id, person_id FROM attendance.group_memberships
  UNION SELECT s.group_id, r.person_id FROM attendance.attendance_records r
    JOIN attendance.attendance_sessions s ON s.id = r.session_id
), absence_counts AS (
  SELECT s.group_id, r.person_id, count(*)::integer AS used_absences
  FROM attendance.attendance_records r JOIN attendance.attendance_sessions s ON s.id = r.session_id
  WHERE s.status = 'closed' AND r.status = 'absent' GROUP BY s.group_id, r.person_id
)
SELECT sg.person_id, g.id AS group_id, g.code AS group_code, g.course_code, g.term_ends_on,
  g.allowed_absences, coalesce(a.used_absences, 0) AS used_absences,
  greatest(g.allowed_absences - coalesce(a.used_absences, 0), 0) AS remaining_absences
FROM student_groups sg JOIN attendance.groups g ON g.id = sg.group_id
LEFT JOIN absence_counts a ON a.group_id = sg.group_id AND a.person_id = sg.person_id;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA attendance FROM PUBLIC;
