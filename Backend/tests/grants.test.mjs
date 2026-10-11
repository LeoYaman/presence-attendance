import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {localDatabase} from './local-fixture.mjs';
test('runtime grant template supports admin management while preserving attendance/audit history and face boundaries',async () => {
  const fixture=await localDatabase(); const q=fixture.db.query;
  try {
    await q('CREATE ROLE presence_runtime');
    await q(await readFile(new URL('../db/runtime_grants.sql',import.meta.url),'utf8'));
    const legacyTables=(await q(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='attendance' AND table_name LIKE 'subject%'`)).rows;
    assert.deepEqual(legacyTables,[]);
    const teacher=randomUUID(),person=randomUUID(),group=randomUUID(),session=randomUUID(),face=randomUUID();
    await q("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'grants@example.test','NONLOGIN','teacher')",[teacher]);
    await q("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'GRANT-P','Grant Test')",[person]);
    await q(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on) VALUES($1,'GRANT-G','Grant Group','GRANT','Test',current_date-1,current_date+1)`,[group]);
    await q('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2)',[group,teacher]);
    await q('INSERT INTO attendance.group_memberships(group_id,person_id) VALUES($1,$2)',[group,person]);
    await q(`INSERT INTO attendance.face_enrollments(id,person_id,provider,template_ref,status,consent_recorded_at,created_by)
      VALUES($1,$2,'test','grant-ref','active',now(),$3)`,[face,person,teacher]);
    await q('SET ROLE presence_runtime');
    await q('BEGIN');
    await q('SELECT id FROM attendance.groups WHERE id=$1 FOR UPDATE',[group]);
    await q(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by) VALUES($1,$2,now()-interval '1 minute',now()+interval '1 hour',$3)`,[session,group,teacher]);
    await q('SELECT attendance.open_session($1,$2)',[session,teacher]);
    await q("SELECT * FROM attendance.record_check_in($1,$2,$3,'face',0.99,$4)",[session,person,teacher,face]);
    await q('SELECT attendance.close_session($1,$2)',[session,teacher]);
    await q('COMMIT');
    await q('UPDATE attendance.users SET email_notifications=true WHERE id=$1',[teacher]);
    await q("UPDATE attendance.users SET role='admin' WHERE id=$1",[teacher]);
    await q("UPDATE attendance.groups SET name='Changed' WHERE id=$1",[group]);
    await q('SELECT * FROM attendance.admin_settings');
    await q('SELECT * FROM attendance.audit_logs');
    assert.deepEqual((await q('SELECT * FROM demo.passengers')).rows,[]);
    await assert.rejects(q("INSERT INTO demo.passengers(person_id,name,reference_key) VALUES(gen_random_uuid(),'Test','team_leo')"),/permission denied/);
    await assert.rejects(q("UPDATE attendance.face_enrollments SET status='failed' WHERE id=$1",[face]),/permission denied/);
    await assert.rejects(q('DELETE FROM attendance.attendance_records WHERE session_id=$1',[session]),/permission denied/);
    await assert.rejects(q('DELETE FROM attendance.audit_logs'),/permission denied/);
    await assert.rejects(q('DELETE FROM attendance.people WHERE id=$1',[person]),/permission denied/);
  } finally {await q('RESET ROLE');await fixture.engine.close();}
});
