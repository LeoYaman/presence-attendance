import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createDemoAlerts} from '../src/demo-alerts.mjs';

async function fixture() {
  const engine = new PGlite();
  await engine.exec(await readFile(new URL('../db/migrations/010_demo_alerts.sql', import.meta.url), 'utf8'));
  let tail = Promise.resolve();
  const pool = {
    async query(sql, params) { let release; const next = new Promise(r => {release=r;}); const prev=tail; tail=next; await prev; try {return await engine.query(sql,params);} finally {release();} },
    async connect() { let release; const next = new Promise(r => {release=r;}); const prev=tail; tail=next; await prev; return {query:(sql,params)=>engine.query(sql,params),release}; }
  };
  const dir=await mkdtemp(join(tmpdir(),'demo-alerts-'));
  const feedPath=join(dir,'feed.json');
  return {engine,pool,dir,feedPath,close:async()=>{await engine.close();await rm(dir,{recursive:true,force:true});}};
}
const record=(id,name='Mira Vale')=>({id,name,scenario:'Fictional practice scenario.',synthetic:true,fictional:true});

test('sync upserts fictional rows, deactivates removals, and simulation never sends notifications',async()=>{
  const f=await fixture();
  try {
    await writeFile(f.feedPath,JSON.stringify({records:[record('demo-orion-01')]}));
    const alerts=createDemoAlerts({pool:f.pool,feedPath:f.feedPath,intervalMs:60000});
    assert.equal(await alerts.start(),undefined);
    assert.deepEqual(await alerts.list(),[{id:'demo-orion-01',name:'Mira Vale',scenario:'Fictional practice scenario.',synthetic:true,fictional:true}]);
    assert.deepEqual(await alerts.simulate('demo-orion-01'),{
      id:'demo-orion-01',name:'Mira Vale',scenario:'Fictional practice scenario.',synthetic:true,fictional:true,
      notificationSent:false,title:'DEMO — Faculty security is getting informed',explanation:'This is a fictional simulation. No real call or notification is being made.'
    });
    await writeFile(f.feedPath,JSON.stringify({records:[record('demo-orion-01','Updated Mira'),record('demo-new-02','Juniper Reed')]}));
    await Promise.all([alerts.sync(),alerts.sync()]);
    assert.equal((await alerts.list()).length,2);
    await writeFile(f.feedPath,JSON.stringify({records:[record('demo-new-02','Juniper Reed')]}));
    await alerts.sync();
    assert.deepEqual((await alerts.list()).map(x=>x.id),['demo-new-02']);
    assert.equal(await alerts.simulate('demo-orion-01'),null);
    alerts.stop();
  } finally {await f.close();}
});

test('malformed or unsafe feed preserves prior snapshot and rejects non-fictional fields',async()=>{
  const f=await fixture();
  try {
    await writeFile(f.feedPath,JSON.stringify({records:[record('demo-stable-01')]}));
    const alerts=createDemoAlerts({pool:f.pool,feedPath:f.feedPath});
    await alerts.sync();
    const before=await alerts.list();
    for (const content of [
      '{bad json',
      JSON.stringify({records:[{...record('demo-real-01'),synthetic:false}]}),
      JSON.stringify({records:[{...record('demo-real-01'),personId:'abc'}]}),
      JSON.stringify({records:[record('attendance-1')]})
    ]) {
      await writeFile(f.feedPath,content);
      await assert.rejects(alerts.sync());
      assert.deepEqual(await alerts.list(),before);
      assert.match(alerts.getStatus().lastError,/Malformed|fictional|schema|id/i);
    }
  } finally {await f.close();}
});

test('start performs initial sync and periodic polling reloads a changed feed',async()=>{
  const f=await fixture();
  const alerts=createDemoAlerts({pool:f.pool,feedPath:f.feedPath,intervalMs:100});
  try {
    await writeFile(f.feedPath,JSON.stringify({records:[record('demo-first-01')]}));
    await alerts.start();
    assert.ok(alerts.getStatus().lastSyncedAt);
    assert.deepEqual((await alerts.list()).map(row=>row.id),['demo-first-01']);
    await writeFile(f.feedPath,JSON.stringify({records:[record('demo-second-02')]}));
    const deadline=Date.now()+2000;
    while(Date.now()<deadline && (await alerts.list()).some(row=>row.id!=='demo-second-02'))
      await new Promise(resolve=>setTimeout(resolve,25));
    assert.deepEqual((await alerts.list()).map(row=>row.id),['demo-second-02']);
    assert.equal(alerts.getStatus().lastError,null);
  } finally {alerts.stop();await f.close();}
});

test('oversized feed is rejected while existing database state remains available',async()=>{
  const f=await fixture();
  try {
    await writeFile(f.feedPath,JSON.stringify({records:[record('demo-stable-01')]}));
    const alerts=createDemoAlerts({pool:f.pool,feedPath:f.feedPath});
    await alerts.sync();
    await writeFile(f.feedPath,' '.repeat(256*1024+1));
    await assert.rejects(alerts.sync(),/exceeds/);
    assert.equal((await alerts.list()).length,1);
  } finally {await f.close();}
});
