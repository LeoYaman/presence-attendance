import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {localDatabase} from './local-fixture.mjs';

test('014 removes legacy subject tables and preserves attendance data',async()=>{
  const fixture=await localDatabase({applyExternalSubjectRegistry:false});
  const q=fixture.db.query;
  try {
    const user=randomUUID(),person=randomUUID(),group=randomUUID(),session=randomUUID();
    await q("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'migration@example.test','NONLOGIN','teacher')",[user]);
    await q("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'MIGRATION-P','Migration Person')",[person]);
    await q(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on)
      VALUES($1,'MIGRATION-G','Migration Group','MIG','Test',current_date-1,current_date+1)`,[group]);
    await q(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by)
      VALUES($1,$2,now()-interval '1 minute',now()+interval '1 hour',$3)`,[session,group,user]);
    await q('INSERT INTO attendance.attendance_records(session_id,person_id) VALUES($1,$2)',[session,person]);

    await q(await readFile(new URL('../db/migrations/014_external_subject_registry.sql',import.meta.url),'utf8'));
    const remaining=(await q(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='attendance' AND table_type='BASE TABLE'`)).rows.map(row=>row.table_name);
    for(const name of ['subject_sync_sources','subject_api_keys','subjects','subject_app_access','subject_person_links',
      'subject_face_references','subject_catalog_version','subject_sync_audit']) assert.ok(!remaining.includes(name),name+' remains');
    assert.equal((await q('SELECT count(*)::int AS count FROM attendance.people WHERE id=$1',[person])).rows[0].count,1);
    assert.equal((await q('SELECT count(*)::int AS count FROM attendance.attendance_records WHERE session_id=$1',[session])).rows[0].count,1);
  } finally {await fixture.engine.close();}
});
