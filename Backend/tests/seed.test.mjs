import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase} from './local-fixture.mjs';
import {seedDemo,demo} from '../scripts/seed-demo.mjs';
import {verifyPassword} from '../src/auth.mjs';
import {applyMigrations} from '../scripts/migrations.mjs';
import {transaction} from '../src/database.mjs';

test('production migration fails clearly and atomically without Timescale; local shim is separate',async () => {
  const engine=new PGlite(); const db={query:async(sql,params)=>params?engine.query(sql,params):(await engine.exec(sql)).at(-1)};
  try {
    await assert.rejects(applyMigrations(db),/TimescaleDB is required/);
    assert.equal((await db.query("SELECT to_regnamespace('attendance') AS schema")).rows[0].schema,null);
    assert.equal((await db.query("SELECT to_regclass('public.presence_schema_migrations') AS tracking")).rows[0].tracking,null);
  } finally {await engine.close();}
});
test('synthetic seed is additive, idempotent, hashes credentials, preserves passwords and produces event-backed history',async () => {
  const fixture=await localDatabase();
  try {
    const result=await transaction(fixture.pool,db=>seedDemo(db,'Synthetic-test-password-2026'));
    assert.equal(result.teacherEmail,demo.teacherEmail);
    const count=async table=>(await fixture.db.query(`SELECT count(*)::int AS n FROM attendance.${table}`)).rows[0].n;
    assert.equal(await count('people'),8); assert.equal(await count('users'),10); assert.equal(await count('attendance_sessions'),7);
    assert.equal(await count('attendance_records'),48); assert.equal(await count('attendance_events'),48);
    const user=(await fixture.db.query('SELECT * FROM attendance.users WHERE id=$1',[demo.teacherId])).rows[0];
    assert.equal(await verifyPassword('Synthetic-test-password-2026',user.password_hash),true);
    await transaction(fixture.pool,db=>seedDemo(db,'Different-test-password-2026'));
    assert.equal(await count('attendance_records'),48); assert.equal(await count('attendance_events'),48);
    const again=(await fixture.db.query('SELECT * FROM attendance.users WHERE id=$1',[demo.teacherId])).rows[0]; assert.equal(again.password_hash,user.password_hash);
  } finally {await fixture.engine.close();}
});
test('seed refuses a colliding real identity before any demo data commits',async () => {
  const fixture=await localDatabase();
  try {
    await fixture.db.query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'real@example.test','existing','teacher')",[demo.teacherId]);
    await assert.rejects(transaction(fixture.pool,db=>seedDemo(db,'Synthetic-test-password-2026')),/scope is already occupied/);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.groups')).rows[0].n,0);
    assert.equal((await fixture.db.query('SELECT email FROM attendance.users WHERE id=$1',[demo.teacherId])).rows[0].email,'real@example.test');
  } finally {await fixture.engine.close();}
});
