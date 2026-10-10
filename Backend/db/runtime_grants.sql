-- REVIEW-ONLY TEMPLATE. Run separately as the schema owner after creating a
-- dedicated presence_runtime LOGIN role and configuring its password securely.
-- This file does not create users, passwords, or apply itself automatically.
GRANT USAGE ON SCHEMA attendance TO presence_runtime;
GRANT USAGE ON SCHEMA demo TO presence_runtime;
GRANT SELECT,INSERT,UPDATE ON demo.alerts TO presence_runtime;
GRANT SELECT ON demo.passengers TO presence_runtime;
GRANT SELECT(reference_key,group_id,person_id,is_active) ON attendance.team_face_references TO presence_runtime;
GRANT SELECT ON attendance.people,attendance.users,attendance.groups,
  attendance.group_memberships,attendance.group_staff,attendance.attendance_sessions,
  attendance.attendance_records,attendance.face_enrollments,attendance.attendance_events,
  attendance.student_history,attendance.student_absence_summary TO presence_runtime;
GRANT SELECT,INSERT,DELETE ON attendance.auth_sessions TO presence_runtime;
GRANT INSERT ON attendance.attendance_sessions,attendance.attendance_records,
  attendance.attendance_events,attendance.audit_logs TO presence_runtime;
GRANT UPDATE ON attendance.attendance_sessions,attendance.attendance_records TO presence_runtime;
GRANT UPDATE(email_notifications) ON attendance.users TO presence_runtime;
-- Admin routes authenticate role server-side before reaching these mutations.
-- Keep these credentials private: the SQL runtime itself is not an authorization boundary.
GRANT SELECT ON attendance.audit_logs,attendance.admin_settings TO presence_runtime;
GRANT INSERT,UPDATE ON attendance.people,attendance.users,attendance.groups,
  attendance.group_memberships TO presence_runtime;
GRANT INSERT,DELETE ON attendance.group_staff TO presence_runtime;
GRANT UPDATE ON attendance.admin_settings TO presence_runtime;
-- PostgreSQL row-locking SELECT FOR UPDATE / FOR SHARE requires UPDATE on at
-- least one column. Only the maintenance timestamp is editable here.
GRANT UPDATE(updated_at) ON attendance.groups,attendance.face_enrollments TO presence_runtime;
GRANT EXECUTE ON FUNCTION attendance.require_group_manager(uuid,uuid),
  attendance.open_session(uuid,uuid),attendance.close_session(uuid,uuid),
  attendance.record_check_in(uuid,uuid,uuid,text,numeric,uuid),
  attendance.correct_attendance(uuid,uuid,text,text,timestamptz),
  attendance.touch_updated_at(),attendance.capture_attendance_event() TO presence_runtime;
-- SECURITY INVOKER routines require these underlying writes. Runtime credentials
-- therefore remain private: direct SQL with this role can bypass API authorization.
-- The runtime cannot delete students/courses/attendance/audit history or alter schema.
