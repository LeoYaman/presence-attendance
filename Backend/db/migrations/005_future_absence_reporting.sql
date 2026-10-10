-- Preserve historical memberships while excluding legacy prematurely closed
-- future sessions from absence allowance calculations.
CREATE OR REPLACE VIEW attendance.student_absence_summary AS
WITH student_groups AS (
  SELECT DISTINCT group_id, person_id FROM attendance.group_memberships
  UNION SELECT s.group_id, r.person_id FROM attendance.attendance_records r
    JOIN attendance.attendance_sessions s ON s.id = r.session_id
), absence_counts AS (
  SELECT s.group_id, r.person_id, count(*)::integer AS used_absences
  FROM attendance.attendance_records r JOIN attendance.attendance_sessions s ON s.id = r.session_id
  WHERE s.status = 'closed' AND s.starts_at <= clock_timestamp() AND r.status = 'absent'
  GROUP BY s.group_id, r.person_id
)
SELECT sg.person_id, g.id AS group_id, g.code AS group_code, g.course_code, g.term_ends_on,
  g.allowed_absences, coalesce(a.used_absences, 0) AS used_absences,
  greatest(g.allowed_absences - coalesce(a.used_absences, 0), 0) AS remaining_absences
FROM student_groups sg JOIN attendance.groups g ON g.id = sg.group_id
LEFT JOIN absence_counts a ON a.group_id = sg.group_id AND a.person_id = sg.person_id;
