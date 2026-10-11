import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDatabase} from './local-fixture.mjs';
import {createApp} from '../src/server.mjs';
import {opaqueToken,tokenDigest} from '../src/auth.mjs';
import {teamReferences} from '../scripts/import-team-references.mjs';

let fixture,server,actor,student,registryCalls=[],faceCalls=[],matchedParticipants=['leo','anthony'];
const origin='http://127.0.0.1:39137';
const ids=Object.fromEntries(teamReferences.members.map(person=>[person.key,person.personId]));
const configuration={leoId:ids.team_leo,rebecaId:ids.team_rebbeca,anthonyId:ids.team_anthony};
async function call(path,{method='GET',body,headers={}}={}) {
  const response=await fetch(origin+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
}
before(async()=>{
  fixture=await localDatabase();
  async function session(role){
    const id=randomUUID(),token=opaqueToken(),csrf=opaqueToken();
    const personId=role==='student'?randomUUID():null;
    if(personId)await fixture.db.query("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'pickup-student','Pickup Student')",[personId]);
    await fixture.db.query('INSERT INTO attendance.users(id,email,password_hash,role,person_id) VALUES($1,$2,$3,$4,$5)',[id,role+'@pickup.test','no-login',role,personId]);
    await fixture.db.query("INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenDigest(token),id,csrf]);
    return {Cookie:'presence_session='+token,'X-CSRF-Token':csrf};
  }
  actor=await session('teacher');student=await session('student');
  await fixture.db.query(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on)
    VALUES($1,'PICKUP-REFS','Pickup references','PICKUP','Demo','2026-01-01','2027-12-31')`,[teamReferences.groupId]);
  for(const person of teamReferences.members){
    await fixture.db.query('INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,$2,$3)',[person.personId,person.personCode,person.name]);
    await fixture.db.query(`INSERT INTO attendance.team_face_references(reference_key,group_id,person_id,source_path,source_commit,image_sha256,image_bytes)
      VALUES($1,$2,$3,$4,$5,$6,decode($7,'hex'))`,[person.key,teamReferences.groupId,person.personId,person.sourcePath,
      'a'.repeat(40),'b'.repeat(64),'ab'.repeat(120)]);
  }
  const subjectRegistry={async detect(request){registryCalls.push(request);throw new Error('Pickup must not use the external catalog');}};
  const faceWorker={close(){},async request(request){
    faceCalls.push(request);
    return {registeredReferences:request.referenceMappings.length,matches:matchedParticipants.map(name=>{
      const referenceKey='team_'+name,personId=request.referenceMappings.find(item=>item.referenceKey===referenceKey)?.personId;
      return {studentId:personId,referenceKey,identityMatched:Boolean(personId),box:{x:.1,y:.1,width:.2,height:.2},similarity:.9};
    })};
  }};
  server=createApp({pool:fixture.pool,publicOrigin:origin,subjectRegistry,pickupSettings:{enabled:true,configuration,mailConfigured:false,recipient:''},pickupMailer:async()=>{throw new Error('Email must not run');},faceWorker});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(39137,'127.0.0.1',resolve);});
});
after(async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve));if(fixture)await fixture.engine.close();});

test('pickup routes require a session and an operator role',async()=>{
  assert.equal((await call('/api/pickup-demo')).status,401);
  assert.equal((await call('/api/pickup-demo',{headers:student})).status,403);
  assert.equal((await call('/api/pickup-demo',{headers:actor})).body.enabled,true);
});

test('pickup POST enforces same Origin and CSRF before recognition',async()=>{
  assert.equal((await call('/api/pickup-demo/decide',{method:'POST',headers:actor,body:{image:'frame'}})).status,403);
  assert.equal((await call('/api/pickup-demo/decide',{method:'POST',headers:{Cookie:actor.Cookie,Origin:origin},body:{image:'frame'}})).status,403);
  assert.equal((await call('/api/pickup-demo/decide',{method:'POST',headers:{...actor,Origin:'https://different.test'},body:{image:'frame'}})).status,403);
  assert.equal(registryCalls.length,0);
});

test('pickup uses configured local references independently of the registry catalog',async()=>{
  const image=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(12000)]).toString('base64');
  const result=await call('/api/pickup-demo/decide',{method:'POST',headers:{...actor,Origin:origin},body:{image}});
  assert.equal(result.status,200);assert.equal(result.body.state,'approved');
  assert.deepEqual(result.body.recognition.matches.map(m=>m.name),['Leo','Anthony']);
  assert.ok(result.body.recognition.matches.every(m=>m.identityMatched && m.box));
  assert.equal(registryCalls.length,0);assert.equal(faceCalls.length,1);
  assert.equal(faceCalls[0].action,'detect');assert.equal(faceCalls[0].groupId,'pickup-demo');assert.equal(faceCalls[0].image,image);
  assert.deepEqual(faceCalls[0].allowedIds,[configuration.leoId,configuration.rebecaId,configuration.anthonyId]);
  assert.deepEqual(faceCalls[0].referenceMappings,[{referenceKey:'team_leo',personId:configuration.leoId},
    {referenceKey:'team_rebbeca',personId:configuration.rebecaId},{referenceKey:'team_anthony',personId:configuration.anthonyId}]);
  assert.deepEqual(result.body.recognition.matches.map(m=>m.subjectId),[configuration.leoId,configuration.anthonyId]);
  assert.ok(result.body.recognition.matches.every(m=>m.personId===m.subjectId));
});

test('camera POST rejects bodies above 400KB and client-supplied matches',async()=>{
  const oversized=await call('/api/pickup-demo/decide',{method:'POST',headers:{...actor,Origin:origin},body:{image:'A'.repeat(400001)}});
  assert.equal(oversized.status,413);assert.equal(oversized.body.error.code,'body_too_large');
  const forged=await call('/api/pickup-demo/decide',{method:'POST',headers:{...actor,Origin:origin},body:{image:'frame',matches:[{subjectId:configuration.leoId}]}});
  assert.equal(forged.status,400);assert.equal(faceCalls.length,1);
});

test('reset also requires CSRF and clears the latest decision',async()=>{
  assert.equal((await call('/api/pickup-demo/reset',{method:'POST',headers:{Cookie:actor.Cookie,Origin:origin},body:{}})).status,403);
  assert.equal((await call('/api/pickup-demo/reset',{method:'POST',headers:{...actor,Origin:origin},body:{}})).status,200);
  assert.equal((await call('/api/pickup-demo',{headers:actor})).body.latest,null);
});


test('manual pickup approval requires session, role, Origin and CSRF and rejects replay',async()=>{
  assert.equal((await call('/api/pickup-demo/reset',{method:'POST',headers:{...actor,Origin:origin},body:{}})).status,200);
  matchedParticipants=['rebbeca','anthony'];
  const image=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(12000)]).toString('base64');
  const pending=await call('/api/pickup-demo/decide',{method:'POST',headers:{...actor,Origin:origin},body:{image}});
  assert.equal(pending.status,200);assert.equal(pending.body.request.canApprove,true);
  const path=`/api/pickup-demo/requests/${pending.body.request.id}/approve`;
  assert.equal((await call(path,{method:'POST',headers:{Origin:origin},body:{}})).status,401);
  assert.equal((await call(path,{method:'POST',headers:{...student,Origin:origin},body:{}})).status,403);
  assert.equal((await call(path,{method:'POST',headers:{Cookie:actor.Cookie,Origin:origin},body:{}})).status,403);
  assert.equal((await call(path,{method:'POST',headers:actor,body:{}})).status,403);
  assert.equal((await call(path,{method:'POST',headers:{...actor,Origin:'https://different.test'},body:{}})).status,403);
  const approved=await call(path,{method:'POST',headers:{...actor,Origin:origin},body:{}});
  assert.equal(approved.status,200);assert.equal(approved.body.state,'approved');
  assert.equal((await call(path,{method:'POST',headers:{...actor,Origin:origin},body:{}})).status,409);
  const state=(await call('/api/pickup-demo',{headers:actor})).body;
  assert.equal(state.approvalMode,'manual');assert.equal(state.mailConfigured,false);assert.equal(state.requests[0].canApprove,false);
});
