import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {request as httpRequest} from 'node:http';
import {localDatabase} from './local-fixture.mjs';
import {seedDemo,demo} from '../scripts/seed-demo.mjs';
import {opaqueToken,tokenDigest} from '../src/auth.mjs';
import {createApp} from '../src/server.mjs';
import {createRecordingStore,RECORDING_RETENTION_MS} from '../src/recording-store.mjs';

test('recording HTTP API enforces access, streams ranges and keeps slow uploads out of recognition',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'presence-recording-api-'));
  const fixture=await localDatabase();let server,slow;
  let clock=Date.now();
  const store=createRecordingStore({root:directory,now:()=>clock});
  try{
    await seedDemo(fixture.db,'Recording-test-password-2026');
    const other=randomUUID();
    await fixture.db.query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'other@recording.test','test-only','teacher')",[other]);
    async function actor(id){const token=opaqueToken(),csrf=opaqueToken();await fixture.db.query('INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')',[tokenDigest(token),id,csrf]);return {cookie:`presence_session=${token}`,csrf};}
    // Cookie name comes from the production helper, never from a test-only bypass.
    const {sessionCookie}=await import('../src/auth.mjs');
    const teacher=await actor(demo.teacherId),admin=await actor(demo.adminId),unassigned=await actor(other);
    for(const user of [teacher,admin,unassigned])user.cookie=sessionCookie(user.cookie.split('=')[1],false,new Date(Date.now()+3600000)).split(';')[0];
    server=createApp({pool:fixture.pool,publicOrigin:'http://localhost',recordingStore:store,faceWorker:{request:async()=>({matches:[],sampleCounts:{}}),close(){}}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    async function request(path,{actor=teacher,method='GET',body,raw,headers={}}={}){
      return fetch(origin+'/api'+path,{method,headers:{...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}:{}),...(method==='GET'?{}:{Origin:'http://localhost','Content-Type':raw===undefined?'application/json':'video/webm'}),...headers},...(method==='GET'?{}:{body:raw??JSON.stringify(body??{})})});
    }
    const groupPath=`/groups/${demo.groupId}/recordings`;
    assert.equal((await request(groupPath,{actor:null})).status,401);
    assert.equal((await request(groupPath,{actor:unassigned})).status,403);
    assert.equal((await request(groupPath,{method:'POST',body:{mimeType:'video/webm',startedAt:new Date(clock).toISOString()},headers:{'X-CSRF-Token':''}})).status,403);
    const created=await request(groupPath,{method:'POST',body:{mimeType:'video/webm',startedAt:new Date(clock).toISOString()}});
    assert.equal(created.status,200);const {recording}=await created.json();
    const path=`/recordings/${recording.id}`;
    assert.equal((await request(path+'/chunks/0',{actor:unassigned,method:'PUT',raw:Buffer.from('x')})).status,403);
    assert.equal((await request(path+'/chunks/0',{actor:admin,method:'PUT',raw:Buffer.from('x')})).status,403);
    assert.equal((await request(path+'/chunks/0',{method:'PUT',raw:Buffer.from('x'),headers:{Origin:'http://elsewhere.test'}})).status,403);
    assert.equal((await request(path+'/chunks/0',{method:'PUT',raw:Buffer.from('x'),headers:{'Content-Type':'application/octet-stream'}})).status,415);
    // A half-sent upload must never hold the SQL connection or face worker.
    slow=httpRequest(origin+'/api'+path+'/chunks/0',{method:'PUT',headers:{Cookie:teacher.cookie,'X-CSRF-Token':teacher.csrf,Origin:'http://localhost','Content-Type':'video/webm','Content-Length':'1024'}});
    slow.on('error',()=>{});slow.write(Buffer.from('partial'));
    const detection=await request(`/groups/${demo.groupId}/faces/detect`,{method:'POST',body:{image:'eA=='}});
    assert.equal(detection.status,200);slow.destroy();slow=null;
    const binary=fileURLToPath(new URL('../.tools/ffmpeg/ffmpeg.exe',import.meta.url));
    const {stdout:clip}=await promisify(execFile)(process.env.FFMPEG_PATH||binary,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x120:r=15','-t','1','-an','-c:v','libvpx','-f','webm','pipe:1'],{encoding:'buffer',maxBuffer:1024*1024,windowsHide:true});
    assert.equal((await request(path+'/chunks/0',{method:'PUT',raw:clip})).status,200);
    assert.equal((await request(path+'/chunks/0',{method:'PUT',raw:clip})).status,200);
    assert.equal((await request(path+'/chunks/0',{method:'PUT',raw:Buffer.from('different')})).status,409);
    const finished=await request(path+'/finish',{method:'POST',body:{endedAt:new Date(clock+1000).toISOString()}});
    assert.equal(finished.status,200);assert.equal((await finished.json()).recording.seekable,true);
    const full=await request(path+'/video');assert.equal(full.status,200);const bytes=Buffer.from(await full.arrayBuffer());
    const ranged=await request(path+'/video',{headers:{Range:'bytes=10-29'}});assert.equal(ranged.status,206);assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),bytes.subarray(10,30));
    assert.equal((await request(path+'/video',{headers:{Range:'bytes=999999999-'}})).status,416);
    assert.equal((await request(path+'/video',{actor:unassigned})).status,403);
    assert.equal((await request(path+'/video',{actor:admin})).status,200);
    assert.equal((await (await request(groupPath)).json()).recordings.length,1);
    clock+=RECORDING_RETENTION_MS;
    assert.notEqual((await request(path+'/video')).status,200);
    assert.equal((await (await request(groupPath)).json()).recordings.length,0);
    await store.cleanup();
  }finally{
    slow?.destroy();if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await store.close();await fixture.engine.close();await rm(directory,{recursive:true,force:true});
  }
});
