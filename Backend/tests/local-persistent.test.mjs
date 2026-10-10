import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalDatabase} from '../scripts/local-demo.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {transaction} from '../src/database.mjs';
test('local data survives restart and concurrent transactions stay isolated',async()=>{
  const path=await mkdtemp(join(tmpdir(),'presence-local-')); let local;
  try{
    local=await openLocalDatabase(path);
    await transaction(local.pool,db=>seedDemo(db,'Local-test-password-2026'));
    const dump=local.engine.dumpDataDir.bind(local.engine);
    let snapshots=0;
    local.engine.dumpDataDir=async(...args)=>{snapshots++;return dump(...args);};
    await transaction(local.pool,async db=>{
      assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance.people')).rows[0].n,8);
    },{readOnly:true});
    assert.equal(snapshots,0,'face roster reads must not export the entire database');
    await assert.rejects(transaction(local.pool,db=>db.query("UPDATE attendance.people SET full_name='Forbidden'"),{readOnly:true}),/read.only/i);
    assert.equal(snapshots,0);
    await transaction(local.pool,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query('SELECT count(*) FROM attendance.attendance_records');
    });
    assert.equal(snapshots,0,'dashboard reads must not export the entire database');
    await Promise.all([
      assert.rejects(transaction(local.pool,async db=>{await db.query("UPDATE attendance.people SET full_name='Rolled back'"); throw new Error('rollback');}),/rollback/),
      transaction(local.pool,async db=>assert.equal((await db.query("SELECT count(*)::int AS n FROM attendance.people WHERE full_name='Rolled back'")).rows[0].n,0))
    ]);
    const events=(await local.pool.query('SELECT count(*)::int AS n FROM attendance.attendance_events')).rows[0].n;
    await local.pool.end(); local=null; local=await openLocalDatabase(path);
    assert.equal((await local.pool.query('SELECT count(*)::int AS n FROM attendance.people')).rows[0].n,8);
    await transaction(local.pool,db=>seedDemo(db,'Other-local-password-2026'));
    assert.equal((await local.pool.query('SELECT count(*)::int AS n FROM attendance.attendance_events')).rows[0].n,events);
    assert.equal((await local.pool.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='timescaledb'")).rows[0].n,0);
  }finally{await local?.pool.end();await rm(path,{recursive:true,force:true});}
});
