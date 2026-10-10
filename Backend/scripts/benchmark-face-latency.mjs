// Isolated local benchmark: reference JPEG -> real worker -> acknowledged,
// persistent attendance write. Does not use or modify the live database.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openLocalDatabase} from './local-demo.mjs';
import {seedDemo,demo} from './seed-demo.mjs';
import {importTeamReferences,loadTeamReferenceManifest,teamReferences} from './import-team-references.mjs';
import {transaction} from '../src/database.mjs';
import {createApp} from '../src/server.mjs';

const directory=await mkdtemp(join(tmpdir(),'presence-latency-'));
let local,server;
try {
  local=await openLocalDatabase(directory);
  const password='Benchmark-only-password-2026';
  await transaction(local.pool,db=>seedDemo(db,password));
  await importTeamReferences(local.pool,await loadTeamReferenceManifest());
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const python=process.env.FACE_PYTHON||join(root,'face_data','.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
  const {stdout}=await promisify(execFile)(python,['-c',"import cv2,base64,sys; f=cv2.imread(sys.argv[1]); h,w=f.shape[:2]; s=min(1,640/w,480/h); f=cv2.resize(f,(round(w*s),round(h*s))); print(base64.b64encode(cv2.imencode('.jpg',f,[cv2.IMWRITE_JPEG_QUALITY,80])[1]).decode())",join(root,teamReferences.members[0].sourcePath)]);
  const image=stdout.trim();
  // Reserve a loopback port, then configure the exact origin used by CSRF.
  server=createApp({pool:local.pool,secureCookies:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  server=createApp({pool:local.pool,publicOrigin:origin,secureCookies:false});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  let cookie,csrf;
  async function post(path,body) {
    const response=await fetch(origin+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},body:JSON.stringify(body)});
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    if(path==='/login'){cookie=response.headers.get('set-cookie').split(';')[0];csrf=result.csrfToken;}
    return result;
  }
  await post('/login',{email:demo.teacherEmail,password});
  const group=teamReferences.groupId;
  const measurements=[];
  for(let i=0;i<5;i++) {
    const start=performance.now();
    const result=await post(`/groups/${group}/faces/detect`,{image});
    const detected=performance.now();
    const match=result.matches.find(m=>m.identityMatched&&m.similarity>0.55);
    assert.ok(match,'reference must qualify at the unchanged automatic threshold');
    const {session,record}=await post(`/groups/${group}/checkins`,{personId:match.studentId});
    assert.ok(['present','late'].includes(record.status));
    const saved=performance.now();
    measurements.push({sample:i+1,recognitionMs:Math.round(detected-start),recognitionAndNewSessionSaveMs:Math.round(saved-start),withPollingBudgetMs:Math.round(saved-start+100)});
    await post(`/sessions/${session.id}/close`,{});
  }
  console.log(JSON.stringify({fixture:'reference JPEG, real Python worker, isolated persistent PGlite; includes new session creation/open and write acknowledgement',measurements},null,2));
} finally {
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  await local?.pool.end();
  await rm(directory,{recursive:true,force:true});
}
