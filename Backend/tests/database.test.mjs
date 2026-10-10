import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, verifySchema } from '../scripts/migrations.mjs';

let engine;
let db;
const id = Object.fromEntries(['admin', 'teacher', 'otherTeacher', 'student', 'alice', 'bob', 'outsider', 'group', 'session', 'face'].map(k => [k, randomUUID()]));
const query = (sql, params) => db.query(sql, params);
const one = async (sql, params) => (await query(sql, params)).rows[0];

before(async () => {
  engine = new PGlite();
  db = { query: async (sql, params) => params ? engine.query(sql, params) : (await engine.exec(sql)).at(-1) };
  await applyMigrations(db, { baseOnly: true });
  await query(`INSERT INTO attendance.people (id, person_code, full_name) VALUES
    ($1, 'S001', 'Alice Example'), ($2, 'S002', 'Bob Example'), ($3, 'S003', 'Outside Example')`, [id.alice, id.bob, id.outsider]);
  for (const [key, email, role, person] of [
    ['admin', 'admin@example.test', 'admin', null], ['teacher', 'teacher@example.test', 'teacher', null],
    ['otherTeacher', 'other@example.test', 'teacher', null], ['student', 'alice@example.test', 'student', id.alice],
  ]) {
    await query('INSERT INTO attendance.users (id, email, role, person_id, password_hash) VALUES ($1,$2,$3,$4,$5)',
      [id[key], email, role, person, 'TEST-ONLY-NON-LOGIN-HASH']);
  }
  await query(`INSERT INTO attendance.groups (id, code, name, course_code, term_name, term_starts_on, term_ends_on, time_zone)
    VALUES ($1,'CS101-A-FALL26','Computer Science','CS101','Fall 2026','2026-09-01','2026-12-15','America/New_York')`, [id.group]);
  await query('INSERT INTO attendance.group_staff (group_id,user_id) VALUES ($1,$2)', [id.group, id.teacher]);
  await query(`INSERT INTO attendance.group_memberships (group_id,person_id,joined_at)
    VALUES ($1,$2,now() - interval '1 day'),($1,$3,now() - interval '1 day')`, [id.group, id.alice, id.bob]);
  await query(`INSERT INTO attendance.attendance_sessions (id,group_id,starts_at,ends_at,created_by)
    VALUES ($1,$2,now() - interval '1 minute',now() + interval '1 hour',$3)`, [id.session, id.group, id.teacher]);
});
after(async () => { if (engine) await engine.close(); });

test('migrations create all nine tables and are safe to rerun', async () => {
  const schema = await verifySchema(db, { baseOnly: true });
  assert.equal(schema.tables.length, 9);
  assert.equal(schema.migrations.length, 2);
  assert.deepEqual(await applyMigrations(db, { baseOnly: true }), []);
});

test('emails are unique regardless of case; student accounts need a person', async () => {
  await assert.rejects(query(`INSERT INTO attendance.users (email,password_hash,role) VALUES ('ADMIN@EXAMPLE.TEST','test','admin')`), /duplicate key/);
  await assert.rejects(query(`INSERT INTO attendance.users (email,password_hash,role) VALUES ('unlinked@example.test','test','student')`), /check constraint/);
  await assert.rejects(query(`INSERT INTO attendance.users (email,password_hash,role) VALUES ('second@example.test','test','student')`), /check constraint/);
});

test('membership history cannot contain overlapping closed intervals', async () => {
  await assert.rejects(query(`INSERT INTO attendance.group_memberships (group_id,person_id,joined_at,left_at)
    VALUES ($1,$2,now() - interval '2 days',now() - interval '12 hours')`, [id.group, id.alice]), /cannot overlap/);
  await assert.rejects(query(`INSERT INTO attendance.groups (code,name,course_code,term_name,term_starts_on,term_ends_on,time_zone)
    VALUES ('bad','Bad','BAD','Fall','2026-09-01','2026-12-01','Imaginary/Zone')`), /Unknown group time zone/);
});

test('students and unassigned teachers cannot open sessions', async () => {
  await assert.rejects(query('SELECT attendance.open_session($1,$2)', [id.session, id.student]), /Not authorized/);
  await assert.rejects(query('SELECT attendance.open_session($1,$2)', [id.session, id.otherTeacher]), /Not authorized/);
  assert.equal((await one('SELECT status FROM attendance.attendance_sessions WHERE id=$1', [id.session])).status, 'planned');
});

test('opening snapshots the roster once and creates pending results', async () => {
  assert.equal((await one('SELECT attendance.open_session($1,$2) AS count', [id.session, id.teacher])).count, 2);
  await query('UPDATE attendance.group_memberships SET left_at=clock_timestamp() WHERE group_id=$1 AND person_id=$2', [id.group, id.bob]);
  await query('INSERT INTO attendance.group_memberships (group_id,person_id) VALUES ($1,$2)', [id.group, id.outsider]);
  assert.equal((await one('SELECT attendance.open_session($1,$2) AS count', [id.session, id.teacher])).count, 2);
  const rows = (await query('SELECT person_id,status FROM attendance.attendance_records WHERE session_id=$1', [id.session])).rows;
  assert.deepEqual(new Set(rows.map(r => r.person_id)), new Set([id.alice,id.bob]));
  assert.ok(rows.every(r => r.status === 'pending'));
});

test('database rejects duplicate attendance rows and missing check-in method', async () => {
  await assert.rejects(query('INSERT INTO attendance.attendance_records (session_id,person_id) VALUES ($1,$2)', [id.session,id.alice]), /duplicate key/);
  await assert.rejects(query(`UPDATE attendance.attendance_records SET status='present',checked_in_at=now(),recorded_by=$1 WHERE session_id=$2 AND person_id=$3`,
    [id.teacher,id.session,id.alice]), /check constraint/);
});

test('manual check-in preserves first timestamp and refuses non-roster students', async () => {
  await assert.rejects(query('SELECT * FROM attendance.record_check_in($1,$2,$3)', [id.session,id.outsider,id.teacher]), /not on the session roster/);
  const first = await one('SELECT * FROM attendance.record_check_in($1,$2,$3)', [id.session,id.alice,id.teacher]);
  const repeated = await one('SELECT * FROM attendance.record_check_in($1,$2,$3)', [id.session,id.alice,id.teacher]);
  assert.equal(first.status, 'present');
  assert.equal(first.method, 'manual');
  assert.equal(first.id, repeated.id);
  assert.equal(String(first.checked_in_at), String(repeated.checked_in_at));
  assert.equal((await one(`SELECT count(*)::int AS n FROM attendance.audit_logs WHERE entity_id=$1 AND action='checked_in'`, [first.id])).n, 1);
});

test('closing finalizes pending roster members despite later membership changes', async () => {
  assert.equal((await one('SELECT attendance.close_session($1,$2) AS n', [id.session,id.teacher])).n, 1);
  const bob = await one('SELECT * FROM attendance.attendance_records WHERE session_id=$1 AND person_id=$2', [id.session,id.bob]);
  assert.equal(bob.status, 'absent');
  assert.equal(bob.method, 'system');
  assert.equal(bob.checked_in_at, null);
  const finalized = await one(`SELECT * FROM attendance.audit_logs WHERE entity_id=$1 AND action='absence_finalized'`, [bob.id]);
  assert.equal(finalized.before_value.status, 'pending');
  assert.equal(finalized.after_value.status, 'absent');
  assert.equal((await one('SELECT attendance.close_session($1,$2) AS n', [id.session,id.teacher])).n, 1);
  await assert.rejects(query('SELECT * FROM attendance.record_check_in($1,$2,$3)', [id.session,id.bob,id.teacher]), /not open/);
  await assert.rejects(query('SELECT attendance.open_session($1,$2)', [id.session,id.teacher]), /Only planned/);
});

test('student reports count finalized absences and preserve former memberships', async () => {
  const summary = await one('SELECT * FROM attendance.student_absence_summary WHERE person_id=$1 AND group_id=$2', [id.bob,id.group]);
  assert.equal(summary.used_absences, 1);
  assert.equal(summary.remaining_absences, 9);
  const newcomer = await one('SELECT * FROM attendance.student_absence_summary WHERE person_id=$1 AND group_id=$2', [id.outsider,id.group]);
  assert.equal(newcomer.used_absences, 0);
  const history = (await query('SELECT * FROM attendance.student_history WHERE person_id=$1', [id.bob])).rows;
  assert.equal(history.length, 1);
});

test('corrections require permissions, reason, valid time, and create immutable audit history', async () => {
  const bob = await one('SELECT * FROM attendance.attendance_records WHERE session_id=$1 AND person_id=$2', [id.session,id.bob]);
  const session = await one('SELECT * FROM attendance.attendance_sessions WHERE id=$1', [id.session]);
  await assert.rejects(query(`SELECT * FROM attendance.correct_attendance($1,$2,'present','', $3)`, [bob.id,id.teacher,session.opened_at]), /reason required/);
  await assert.rejects(query(`SELECT * FROM attendance.correct_attendance($1,$2,'present','Verified', $3)`, [bob.id,id.student,session.opened_at]), /Not authorized/);
  await assert.rejects(query(`SELECT * FROM attendance.correct_attendance($1,$2,'present','Verified', now() + interval '1 day')`, [bob.id,id.teacher]), /valid check-in time/);
  const corrected = await one(`SELECT * FROM attendance.correct_attendance($1,$2,'present','Teacher verified arrival',$3)`, [bob.id,id.teacher,session.opened_at]);
  assert.equal(corrected.status, 'present');
  const audit = await one(`SELECT * FROM attendance.audit_logs WHERE entity_id=$1 AND action='attendance_corrected'`, [bob.id]);
  assert.equal(audit.before_value.status, 'absent');
  assert.equal(audit.after_value.status, 'present');
  assert.equal(audit.reason, 'Teacher verified arrival');
  await assert.rejects(query('UPDATE attendance.audit_logs SET reason=$1 WHERE id=$2', ['changed',audit.id]), /append-only/);
  await assert.rejects(query('DELETE FROM attendance.audit_logs WHERE id=$1', [audit.id]), /append-only/);
  assert.equal((await one('SELECT used_absences FROM attendance.student_absence_summary WHERE person_id=$1 AND group_id=$2', [id.bob,id.group])).used_absences, 0);
});

test('face check-in requires an active enrollment, valid confidence and marks late correctly', async () => {
  const lateSession = randomUUID();
  await query(`INSERT INTO attendance.attendance_sessions (id,group_id,starts_at,ends_at,created_by)
    VALUES ($1,$2,now()-interval '20 minutes',now()+interval '1 hour',$3)`, [lateSession,id.group,id.teacher]);
  await query('SELECT attendance.open_session($1,$2)', [lateSession,id.teacher]);
  await assert.rejects(query(`SELECT * FROM attendance.record_check_in($1,$2,$3,'face',0.9,$4)`, [lateSession,id.alice,id.teacher,id.face]), /Active face enrollment/);
  await query(`INSERT INTO attendance.face_enrollments (id,person_id,provider,template_ref,status,consent_recorded_at,created_by)
    VALUES ($1,$2,'test-provider','test-template','active',now(),$3)`, [id.face,id.alice,id.admin]);
  await assert.rejects(query(`SELECT * FROM attendance.record_check_in($1,$2,$3,'face',1.5,$4)`, [lateSession,id.alice,id.teacher,id.face]), /between 0 and 1/);
  const result = await one(`SELECT * FROM attendance.record_check_in($1,$2,$3,'face',0.9,$4)`, [lateSession,id.alice,id.teacher,id.face]);
  assert.equal(result.status,'late');
  assert.equal(result.method,'face');
  assert.equal(Number(result.confidence),0.9);
  await query('SELECT attendance.close_session($1,$2)', [lateSession,id.teacher]);
  assert.equal((await one('SELECT used_absences FROM attendance.student_absence_summary WHERE person_id=$1 AND group_id=$2', [id.alice,id.group])).used_absences, 0);
});

test('deletion pending stops enrollment use and deleted metadata clears the template reference', async () => {
  await query(`UPDATE attendance.face_enrollments SET status='deletion_pending',deletion_requested_at=clock_timestamp() WHERE id=$1`, [id.face]);
  const session = randomUUID();
  await query(`INSERT INTO attendance.attendance_sessions (id,group_id,starts_at,ends_at,created_by)
    VALUES ($1,$2,now(),now()+interval '1 hour',$3)`, [session,id.group,id.teacher]);
  await query('SELECT attendance.open_session($1,$2)', [session,id.teacher]);
  await assert.rejects(query(`SELECT * FROM attendance.record_check_in($1,$2,$3,'face',0.9,$4)`, [session,id.alice,id.teacher,id.face]), /Active face enrollment/);
  await assert.rejects(query(`UPDATE attendance.face_enrollments SET status='deleted',deleted_at=clock_timestamp() WHERE id=$1`, [id.face]), /check constraint/);
  await query(`UPDATE attendance.face_enrollments SET status='deleted',deleted_at=clock_timestamp(),template_ref=NULL WHERE id=$1`, [id.face]);
  assert.equal((await one('SELECT template_ref FROM attendance.face_enrollments WHERE id=$1', [id.face])).template_ref,null);
  const summary = await one('SELECT used_absences FROM attendance.student_absence_summary WHERE person_id=$1 AND group_id=$2', [id.outsider,id.group]);
  assert.equal(summary.used_absences,1); // only the previous closed session; this pending session is excluded
});

test('history is protected from person deletion and notification preference can be saved', async () => {
  await assert.rejects(query('DELETE FROM attendance.people WHERE id=$1', [id.alice]), /foreign key constraint/);
  await query('UPDATE attendance.users SET email_notifications=true WHERE id=$1', [id.student]);
  assert.equal((await one('SELECT email_notifications FROM attendance.users WHERE id=$1', [id.student])).email_notifications,true);
});

test('an already-open session cannot be cancelled', async () => {
  const session = await one("SELECT id FROM attendance.attendance_sessions WHERE status='open' LIMIT 1");
  await assert.rejects(query("UPDATE attendance.attendance_sessions SET status='cancelled' WHERE id=$1", [session.id]), /check constraint/);
});

test('schema verification detects missing required views', async () => {
  await query('BEGIN');
  try {
    await query('DROP VIEW attendance.student_history');
    await assert.rejects(verifySchema(db, { baseOnly: true }), /Missing views: student_history/);
  } finally {
    await query('ROLLBACK');
  }
  assert.equal((await verifySchema(db, { baseOnly: true })).tables.length, 9);
});
