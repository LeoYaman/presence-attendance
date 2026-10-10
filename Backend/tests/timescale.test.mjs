import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPool} from '../src/database.mjs';
import {applyMigrations,verifySchema} from '../scripts/migrations.mjs';
import {arrivalsQuery,dailyQuery} from '../src/server.mjs';
// Never fall back to DATABASE_URL. This test migrates ONLY an explicitly opted-in
// empty disposable database; synthetic fixtures run in a rollback transaction.
const dsn=process.env.TIMESCALE_TEST_DATABASE_URL;
test('native Timescale hypertable, timezone buckets and transactional event semantics',{
  skip:!dsn || process.env.TIMESCALE_TEST_ALLOW_EMPTY_DATABASE!=='true',timeout:60000
},async () => {
  const pool=createPool(dsn); const client=await pool.connect(); let fixtureStarted=false;
  try {
    const dbName=(await client.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(dbName,/(?:^presence_test|_test$)/,'Use a dedicated database named presence_test... or ..._test');
    const exists=await client.query("SELECT to_regnamespace('attendance') AS schema,to_regclass('public.presence_schema_migrations') AS tracking");
    assert.equal(exists.rows[0].schema,null,'Refusing to write into an existing attendance schema');
    assert.equal(exists.rows[0].tracking,null,'Refusing to reuse migration tracking');
    const tables=await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
    assert.equal(tables.rows[0].n,0,'A completely empty disposable database is required');
    await applyMigrations(client); await verifySchema(client);
    assert.deepEqual(await applyMigrations(client),[]);
    await client.query('BEGIN'); fixtureStarted=true;
    const teacher=randomUUID(),person=randomUUID(),group=randomUUID(),session=randomUUID();
    await client.query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'synthetic@native-test.invalid','NONLOGIN-TEST','teacher')",[teacher]);
    await client.query("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'NATIVE-SYNTHETIC','Synthetic Native Test')",[person]);
    await client.query(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on,time_zone)
      VALUES($1,'NATIVE-SYNTHETIC','[SYNTHETIC TEST] Native','TEST','TEST',current_date-1,current_date+1,'America/New_York')`,[group]);
    await client.query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2)',[group,teacher]);
    await client.query('INSERT INTO attendance.group_memberships(group_id,person_id) VALUES($1,$2)',[group,person]);
    await client.query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by)
      VALUES($1,$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',$3)`,[session,group,teacher]);
    await client.query('SELECT attendance.open_session($1,$2)',[session,teacher]);
    const first=(await client.query('SELECT * FROM attendance.record_check_in($1,$2,$3)',[session,person,teacher])).rows[0];
    await client.query('SELECT * FROM attendance.record_check_in($1,$2,$3)',[session,person,teacher]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[session])).rows[0].n,2);
    await client.query('SELECT attendance.close_session($1,$2)',[session,teacher]);
    assert.equal((await client.query(arrivalsQuery,[session])).rows.reduce((n,r)=>n+r.count,0),1);
    const starts=(await client.query('SELECT starts_at FROM attendance.attendance_sessions WHERE id=$1',[session])).rows[0].starts_at;
    const daily=(await client.query(dailyQuery,[group,starts])).rows; assert.equal(daily[0].present,1);
    const localHour=(await client.query("SELECT extract(hour FROM $1::timestamptz AT TIME ZONE 'America/New_York')::int AS hour",[daily[0].bucket])).rows[0].hour; assert.equal(localHour,0);
    await client.query("SELECT * FROM attendance.correct_attendance($1,$2,'absent','Synthetic native test',NULL)",[first.id,teacher]);
    assert.equal((await client.query(arrivalsQuery,[session])).rows.length,0);
    assert.equal((await client.query(dailyQuery,[group,starts])).rows[0].absent,1);
    await client.query('SAVEPOINT rollback_event');
    const opened=(await client.query('SELECT opened_at FROM attendance.attendance_sessions WHERE id=$1',[session])).rows[0].opened_at;
    await client.query("SELECT * FROM attendance.correct_attendance($1,$2,'present','Rollback verification',$3)",[first.id,teacher,opened]);
    await client.query('ROLLBACK TO SAVEPOINT rollback_event');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[session])).rows[0].n,3);
  } finally {
    if (fixtureStarted) await client.query('ROLLBACK');
    client.release(); await pool.end();
  }
});
