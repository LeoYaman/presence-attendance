-- Keep each finalized round and link its one successor without rewriting history.
ALTER TABLE attendance.attendance_sessions
  ADD COLUMN previous_session_id uuid,
  ADD CONSTRAINT attendance_sessions_previous_session_id_key UNIQUE (previous_session_id),
  ADD CONSTRAINT attendance_sessions_previous_session_id_fkey
    FOREIGN KEY (previous_session_id) REFERENCES attendance.attendance_sessions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT attendance_sessions_previous_session_distinct CHECK (previous_session_id <> id);
