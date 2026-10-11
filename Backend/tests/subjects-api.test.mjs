import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase} from './local-fixture.mjs';
import {createApp} from '../src/server.mjs';
import {createSubjectRegistryClient} from '../src/subject-registry-client.mjs';
import {opaqueToken,tokenDigest} from '../src/auth.mjs';
import {initializeRegistry} from '../../SubjectRegistry/src/database.mjs';
import {createRegistryServer} from '../../SubjectRegistry/src/server.mjs';
import {provisionSubjectKey,provisionReaderKey} from '../../SubjectRegistry/src/subjects.mjs';

let attendance,registryEngine,registryPool,registryServer,server,origin,registryOrigin,readerKey,writeKey,actor,subjectId,teacherId,groupId,onDetect;
const workerRequests=[];
// API-boundary fixture only: the image worker is replaced, never the registry
// HTTP API or either DB. These tests do not measure biometric accuracy.
const jpeg=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(200),Buffer.from([255,217])]).toString('base64');
const close=server=>new Promise(resolve=>server?.listening?server.close(resolve):resolve());
async function listen(server,port=0){await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;}
async function call(path,{method='GET',body,headers={},base=origin}={}) {
 const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
 return {status:response.status,body:await response.json()};
}
const external=(method,body)=>call('/api/subjects/external/olivia',{base:registryOrigin,method,body,headers:{'X-API-Key':writeKey}});
const detect=(body={})=>call('/api/subjects/detect',{method:'POST',headers:{...actor,Origin:origin},body:{app:'attendance',image:jpeg,...body}});
function startRegistry() {
 registryServer=createRegistryServer({pool:registryPool,faceWorker:{close(){},async request(request){
  workerRequests.push(request);
  if(request.action==='validate-reference')return {valid:true};
  await onDetect?.();
  return {registeredReferences:request.subjectReferences.length,matches:request.allowedIds.map(subjectId=>({subjectId,identityMatched:true,box:{x:0,y:0,width:0.2,height:0.3},similarity:0.9}))};
 }}});
 return registryServer;
}
before(async()=>{
 attendance=await localDatabase();
 registryEngine=new PGlite();
 const db={query:async(sql,params)=>params?registryEngine.query(sql,params):(await registryEngine.exec(sql)).at(-1)};
 let tail=Promise.resolve();
 async function acquire(){let release;const next=new Promise(resolve=>release=resolve),previous=tail;tail=next;await previous;return release;}
 registryPool={async query(sql,params){const release=await acquire();try{return await db.query(sql,params);}finally{release();}},async connect(){const release=await acquire();return {query:db.query,release};}};
 await initializeRegistry(db);
 readerKey=(await provisionReaderKey(registryPool)).key;
 writeKey=(await provisionSubjectKey(registryPool,{name:'external-system'})).key;
 registryOrigin=await listen(startRegistry());
 const created=await external('PUT',{name:'Olivia',image:jpeg});assert.equal(created.status,200);subjectId=created.body.subject.id;
 teacherId=randomUUID();groupId=randomUUID();const token=opaqueToken(),csrfToken=opaqueToken();
 await attendance.db.query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'subjects@test.invalid','no-login','teacher')",[teacherId]);
 await attendance.db.query("INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenDigest(token),teacherId,csrfToken]);
 await attendance.db.query("INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on) VALUES($1,'TEST','Test','TEST','test','2026-01-01','2026-12-31')",[groupId]);
 await attendance.db.query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2)',[groupId,teacherId]);
 // A same-name attendance person deliberately has a different stable identity.
 await attendance.db.query("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'SAME-NAME','Olivia')",[randomUUID()]);
 actor={Cookie:'presence_session='+token,'X-CSRF-Token':csrfToken};
 const reservation=createServer();origin=await listen(reservation);const port=reservation.address().port;await close(reservation);
 server=createApp({pool:attendance.pool,publicOrigin:origin,subjectRegistry:createSubjectRegistryClient({url:registryOrigin,readKey:readerKey}),faceWorker:{close(){},request(){throw new Error('Attendance worker must not perform registry detection');}}});
 await listen(server,port);
});
after(async()=>{await close(server);await close(registryServer);await attendance?.engine.close();await registryEngine?.close();});

test('every app reads independent registry and forwards recognition over HTTP with no local subjects',async()=>{
 assert.equal((await attendance.db.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='attendance' AND table_name LIKE 'subject%' ")).rows[0].n,0);
 for(const app of ['subject-finder','attendance','parent-child']) {
  const list=await call('/api/subjects?app='+app,{headers:actor});assert.equal(list.status,200);assert.deepEqual(list.body.subjects,[{id:subjectId,name:'Olivia',referenceCount:1}]);
  const result=await detect({app});assert.equal(result.status,200);assert.equal(result.body.matches[0].subjectId,subjectId);assert.equal(result.body.matches[0].message,'Got you, Olivia');assert.equal(result.body.matches[0].personId,null);
 }
 assert.ok(workerRequests.some(r=>r.groupId==='registry:attendance'));
 assert.equal((await attendance.db.query('SELECT count(*)::int n FROM attendance.attendance_records')).rows[0].n,0);
 assert.equal((await call('/SubjectRegistry/.local-db/service-config.json')).status,404);
});

test('cookie authentication, Origin, CSRF and strict payload checks remain in attendance',async()=>{
 assert.equal((await call('/api/subjects?app=attendance')).status,401);
 assert.equal((await call('/api/subjects?app=attendance&app=subject-finder',{headers:actor})).status,400);
 assert.equal((await call('/api/subjects?app=unknown',{headers:actor})).status,400);
 assert.equal((await call('/api/subjects/detect',{method:'POST',headers:actor,body:{app:'attendance',image:jpeg}})).status,403);
 assert.equal((await call('/api/subjects/detect',{method:'POST',headers:{Cookie:actor.Cookie,Origin:origin},body:{app:'attendance',image:jpeg}})).status,403);
 assert.equal((await detect({userId:randomUUID()})).status,400);
 assert.equal((await detect({image:'YWJj'})).status,400);
 assert.equal((await detect({image:'A'.repeat(400001)})).status,413);
 assert.equal((await call('/api/subjects/external/olivia',{method:'PUT',headers:{'X-API-Key':writeKey},body:{name:'Override'}})).status,404);
 // The adapter's read key cannot become an external write credential.
 assert.equal((await call('/api/subjects/external/other',{base:registryOrigin,method:'PUT',headers:{'X-API-Key':readerKey},body:{name:'Other'}})).status,401);
});

test('group authorization precedes remote detection and never narrows target recognition',async()=>{
 const before=workerRequests.length;
 assert.equal((await detect({groupId:randomUUID()})).status,403);assert.equal(workerRequests.length,before);
 const withoutLink=await detect({groupId});assert.equal(withoutLink.status,200);assert.equal(withoutLink.body.matches[0].subjectId,subjectId);assert.equal(withoutLink.body.matches[0].personId,null);
 await attendance.db.query("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'STABLE-ID','Different display name')",[subjectId]);
 assert.equal((await detect({groupId})).body.matches[0].personId,null);
 await attendance.db.query('INSERT INTO attendance.group_memberships(group_id,person_id) VALUES($1,$2)',[groupId,subjectId]);
 assert.equal((await detect({groupId})).body.matches[0].personId,subjectId);
 assert.equal(workerRequests.at(-1).groupId,'registry:attendance');
});

test('external update, deactivation, in-flight invalidation and deletion are immediately visible',async()=>{
 const initial=(await call('/api/subjects?app=attendance',{headers:actor})).body.version;
 assert.equal((await external('PATCH',{name:'Olivia Updated'})).status,200);
 assert.equal((await detect()).body.matches[0].name,'Olivia Updated');
 onDetect=()=>external('PATCH',{active:false});
 try {
  const stale=await detect();assert.equal(stale.status,200);assert.ok(stale.body.version>initial);assert.ok(stale.body.matches.every(m=>m.identityMatched===false&&m.message===null));
 }finally{onDetect=undefined;}
 assert.deepEqual((await call('/api/subjects?app=attendance',{headers:actor})).body.subjects,[]);
 assert.deepEqual((await detect()).body.matches,[]);
 assert.equal((await external('PATCH',{active:true,name:'Olivia'})).status,200);
 assert.equal((await external('DELETE')).status,200);
 assert.deepEqual((await call('/api/subjects?app=attendance',{headers:actor})).body.subjects,[]);
 assert.equal((await external('PUT',{name:'Olivia',image:jpeg})).status,200);
});

test('registry restart retains source of truth and stop returns unavailable without cached identity',async()=>{
 assert.equal((await detect()).body.matches[0].message,'Got you, Olivia');
 const port=registryServer.address().port;await close(registryServer);
 assert.equal((await call('/api/subjects?app=attendance',{headers:actor})).status,503);
 const unavailable=await detect();assert.equal(unavailable.status,503);assert.equal(unavailable.body.matches,undefined);
 registryOrigin=await listen(startRegistry(),port);
 assert.equal((await detect()).body.matches[0].message,'Got you, Olivia');
});

test('HTTP client fails closed on timeout, oversized, redirect, and malformed registry output',async()=>{
 const badServer=createServer((req,res)=>{
  if(req.url.includes('detect')) {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({version:1,registeredReferences:1,matches:[{identityMatched:true,subjectId:'invalid',name:'Olivia'}]}));return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end('A'.repeat(200));
 });
 const url=await listen(badServer);
 try {
  const client=createSubjectRegistryClient({url,readKey:readerKey,maxResponseBytes:100});
  await assert.rejects(client.catalog('attendance'),{status:503,code:'subject_registry_response_too_large'});
  await assert.rejects(createSubjectRegistryClient({url,readKey:readerKey}).detect({app:'attendance',image:jpeg}),{status:503,code:'subject_registry_invalid_response'});
 }finally{await close(badServer);}
 const hanging=createServer(()=>{});const hangingUrl=await listen(hanging);
 try{await assert.rejects(createSubjectRegistryClient({url:hangingUrl,readKey:readerKey,timeoutMs:30}).catalog('attendance'),{status:503,code:'subject_registry_timeout'});}
 finally{hanging.closeAllConnections();await close(hanging);}
 const redirect=createServer((req,res)=>{res.writeHead(302,{Location:registryOrigin+'/api/subjects?app=attendance'});res.end();});
 try{await assert.rejects(createSubjectRegistryClient({url:await listen(redirect),readKey:readerKey}).catalog('attendance'),{status:503,code:'subject_registry_unavailable'});}
 finally{await close(redirect);}
});
