import test from 'node:test';
import assert from 'node:assert/strict';
import {createPickupDemo, evaluatePickup, pickupConfiguration} from '../src/pickup-demo.mjs';

const configuration = {
  leoId:'11111111-1111-4111-8111-111111111111',
  rebecaId:'22222222-2222-4222-8222-222222222222',
  anthonyId:'33333333-3333-4333-8333-333333333333'
};
const face = name => ({subjectId:configuration[name+'Id'], name, identityMatched:true, box:{x:.1,y:.1,width:.2,height:.2}});
const pair = () => [face('leo'),face('anthony')];
class HttpError extends Error {
  constructor(status,code,message) { super(message); this.status=status; this.code=code; }
}
const fail = (status,code,message) => {throw new HttpError(status,code,message);};
function fields(body,allowed,required=[]) {
  if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!allowed.includes(key)) || required.some(key=>!(key in body))) fail(400,'invalid_body','Invalid fields');
}
const flush = async () => {for(let i=0;i<8;i++) await Promise.resolve();};
function fixture({enabled=true,mailConfigured=true,mailFails=false,recognizeOverride}={}) {
  let time=100000, matches=[face('rebeca'),face('anthony')], recognitionError=null;
  const emails=[], recognition=[];
  const user={id:'owner',role:'teacher'};
  const route=createPickupDemo({settings:{enabled,configuration,mailConfigured,recipient:'owner@example.test'}, origin:'https://demo.example.test',fail,fields,now:()=>time,
    recognize:async(actor,image)=>{recognition.push({actor,image});if(recognitionError) throw recognitionError;if(recognizeOverride)return recognizeOverride(actor,image);return {matches};},
    sendMail:async message=>{emails.push(message);if(mailFails) throw new Error('Transport failed');}
  });
  const call=(path='/api/pickup-demo',body,actor=user)=>route({method:body===undefined?'GET':'POST',path,user:actor,body});
  return {call,user,emails,recognition,setMatches:value=>{matches=value;},advance:ms=>{time+=ms;},setError:value=>{recognitionError=value;},
    decide:()=>call('/api/pickup-demo/decide',{image:'server-image'}),
    approval:async()=>({id:(await call()).requests[0].id})
  };
}
const rejectsCode=(promise,code,status)=>assert.rejects(promise,error=>error instanceof HttpError && error.code===code && error.status===status);

test('only Leo and Anthony auto approve; every solo configured identity is blocked',()=>{
  assert.equal(evaluatePickup(pair(),configuration).state,'approved');
  for(const name of ['leo','rebeca','anthony']) {
    assert.deepEqual(evaluatePickup([face(name)],configuration),{state:'blocked',reason:'Cannot exit alone.'});
  }
  assert.equal(evaluatePickup([face('rebeca'),face('anthony')],configuration).state,'pending');
  assert.equal(evaluatePickup([face('leo'),face('rebeca')],configuration).state,'pending');
  assert.equal(evaluatePickup([face('leo'),face('rebeca'),face('anthony')],configuration).state,'blocked');
  assert.equal(evaluatePickup([...pair(),{identityMatched:false,subjectId:null}],configuration).state,'blocked');
  assert.equal(evaluatePickup([...pair(),{identityMatched:true,subjectId:'other'}],configuration).state,'blocked');
  assert.equal(evaluatePickup([...pair(),{identityMatched:true,subjectId:null}],configuration).state,'blocked');
  assert.equal(evaluatePickup([face('rebeca'),face('rebeca')],configuration).state,'blocked');
  assert.equal(evaluatePickup([],configuration).state,'waiting');
});

test('configuration requires explicit enabled flag and three distinct valid IDs',()=>{
  const env={PICKUP_DEMO_ENABLED:'true',PICKUP_LEO_ID:configuration.leoId,PICKUP_REBECA_ID:configuration.rebecaId,PICKUP_ANTHONY_ID:configuration.anthonyId};
  assert.equal(pickupConfiguration(env).enabled,true);
  assert.equal(pickupConfiguration({...env,PICKUP_DEMO_ENABLED:'false'}).enabled,false);
  assert.equal(pickupConfiguration({...env,PICKUP_ANTHONY_ID:configuration.leoId}).enabled,false);
  assert.equal(pickupConfiguration({...env,PICKUP_LEO_ID:'Leo'}).enabled,false);
});

test('operator role required and disabled demo exposes no configuration or decision',async()=>{
  const f=fixture({enabled:false});
  await rejectsCode(f.call(undefined,undefined,{id:'student',role:'student'}),'forbidden',403);
  assert.deepEqual(await f.call(),{enabled:false,configuration:null,manualApproval:true,approvalMode:'manual',mailConfigured:false,requests:[],approvals:[],latest:null});
  await rejectsCode(f.decide(),'pickup_disabled',503);
  assert.equal(f.recognition.length,0);
});

test('client identity assertions are rejected; recognition receives only actor and image',async()=>{
  const f=fixture();
  await rejectsCode(f.call('/api/pickup-demo/decide',{image:'frame',matches:pair()}),'invalid_body',400);
  await f.decide();
  assert.deepEqual(f.recognition,[{actor:f.user,image:'server-image'}]);
});

test('approved decision returns its single verified recognition and accepts the next frame immediately',async()=>{
  const f=fixture();f.setMatches(pair());
  const first=await f.decide();
  assert.equal(first.state,'approved');assert.deepEqual(first.recognition.matches,pair());
  assert.equal(f.recognition.length,1);
  f.setMatches([face('rebeca'),face('anthony')]);
  const next=await f.decide();assert.equal(next.state,'pending');assert.equal(f.recognition.length,2);
  assert.equal((await f.call()).latest.recognition,undefined);
});

test('concurrent frames are rejected while server recognition is in flight',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});
  const f=fixture({recognizeOverride:()=>pending});
  const first=f.decide();await flush();
  await rejectsCode(f.decide(),'pickup_busy',429);
  resolve({matches:pair()});assert.equal((await first).state,'approved');
  assert.equal(f.recognition.length,1);
});

test('a recent manual request stays approvable during recognition and approval returns retryable busy',async()=>{
  let resolve, count=0;
  const pending=new Promise(done=>{resolve=done;});
  const matches=[face('rebeca'),face('anthony')];
  const f=fixture({recognizeOverride:()=>++count===1?{matches}:pending});
  const first=await f.decide();
  const id=first.request.id;
  const deciding=f.decide();await flush();
  const during=await f.call();
  assert.equal(during.requests[0].id,id);
  assert.equal(during.requests[0].canApprove,true,'ongoing inference must not hide the pending approval action');
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'pickup_busy',429);
  assert.equal((await f.call()).requests[0].status,'pending','a busy approval does not consume the request');
  resolve({matches});
  assert.equal((await deciding).request.id,id);
  assert.equal((await f.call(`/api/pickup-demo/requests/${id}/approve`,{})).state,'approved');
});

test('a changed pair completing in-flight recognition removes the old approval action',async()=>{
  let resolve, count=0;
  const pending=new Promise(done=>{resolve=done;});
  const f=fixture({recognizeOverride:()=>++count===1?{matches:[face('rebeca'),face('anthony')]}:pending});
  const first=await f.decide();
  const deciding=f.decide();await flush();
  resolve({matches:[face('leo'),face('rebeca')]});
  const changed=await deciding;
  assert.notEqual(changed.request.id,first.request.id);
  assert.deepEqual(changed.request.matchedNames,['leo','rebeca']);
  assert.equal(changed.request.canApprove,true);
  const old=(await f.call()).requests.find(request=>request.id===first.request.id);
  assert.equal(old.status,'superseded');
  assert.equal(old.canApprove,false);
  await rejectsCode(f.call(`/api/pickup-demo/requests/${first.request.id}/approve`,{}),'stale_approval',409);
});

test('manual requests deduplicate without email or tokens and reject approval replay',async()=>{
  const f=fixture();const first=await f.decide();await flush();
  const {id}=await f.approval();assert.equal(first.state,'pending');assert.equal(first.request.canApprove,true);
  f.advance(1000);assert.equal((await f.decide()).request.id,id);assert.equal(f.emails.length,0);
  const serialized=JSON.stringify(await f.call());assert.ok(!serialized.includes('token'));assert.ok(!serialized.includes('recipient'));
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{token:'a'.repeat(64)}),'invalid_body',400);
  assert.equal((await f.call(`/api/pickup-demo/requests/${id}/approve`,{})).state,'approved');
  assert.equal((await f.call()).requests[0].canApprove,false);
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
});

test('a changed valid pair supersedes a prior manual request and approval link',async()=>{
  const f=fixture();f.setMatches([face('leo'),face('rebeca')]);await f.decide();await flush();const {id}=await f.approval();
  f.advance(1000);f.setMatches([face('rebeca'),face('anthony')]);
  const changed=await f.decide();assert.equal(changed.state,'pending');assert.deepEqual(changed.request.matchedNames,['rebeca','anthony']);await flush();
  const state=await f.call();
  assert.equal(state.latest.state,'pending');
  assert.equal(state.requests.length,2);
  assert.equal(state.requests.find(request=>request.id===id).status,'superseded');
  assert.equal(state.requests.find(request=>request.id!==id).status,'pending');
  assert.equal(f.emails.length,0);
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
});

test('valid non-auto-approved pairs create a named manual request and deduplicate',async()=>{
  const f=fixture();f.setMatches([face('rebeca'),face('anthony')]);
  const first=await f.decide();assert.equal(first.state,'pending');
  assert.deepEqual(first.request.matchedNames,['rebeca','anthony']);await flush();
  const id=first.request.id;
  f.advance(1000);assert.equal((await f.decide()).request.id,id);
  const state=await f.call();
  assert.equal(state.requests.length,1);
  assert.deepEqual(state.requests[0].matchedNames,['rebeca','anthony']);
  assert.equal(f.emails.length,0);
});

test('unknown, invalid, duplicate, and over two identities never create requests',async()=>{
  for (const matches of [
    [face('leo'),{identityMatched:false,subjectId:null}],
    [face('rebeca'),face('rebeca')],
    [face('leo'),face('rebeca'),face('anthony')]
  ]) {
    const f=fixture();f.setMatches(matches);
    assert.equal((await f.decide()).state,'blocked',JSON.stringify(matches));
    await flush();assert.equal((await f.call()).requests.length,0);
  }
  const unregistered=fixture();unregistered.setMatches([{identityMatched:true,subjectId:'unknown-id',name:'Unknown'}]);
  assert.equal((await unregistered.decide()).state,'blocked');
  assert.equal((await unregistered.call()).latest.reason,'Cannot exit alone.');
  assert.equal((await unregistered.call()).requests.length,0);
});

test('SMTP configuration never enables or sends mail in manual demo mode',async()=>{
  const f=fixture({mailConfigured:true});await f.decide();await flush();
  const state=await f.call();assert.equal(state.mailConfigured,false);assert.equal(state.approvalMode,'manual');assert.equal(f.emails.length,0);
  assert.equal(pickupConfiguration({PICKUP_APPROVAL_EMAIL:'owner@example.test',PICKUP_SMTP_HOST:'smtp.example.test',PICKUP_SMTP_FROM:'demo@example.test'}).mailConfigured,false);
});

test('approval belongs to initiating operator and requires a recent visible frame',async()=>{
  const f=fixture();await f.decide();await flush();const {id}=await f.approval();
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{},{id:'different',role:'admin'}),'invalid_approval',403);
  f.advance(5001);
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
  const renewed=await f.decide();
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
  assert.equal((await f.call(`/api/pickup-demo/requests/${renewed.request.id}/approve`,{})).state,'approved');
});

test('expired request cannot approve and a later pending frame creates a new request',async()=>{
  const f=fixture();await f.decide();await flush();const {id}=await f.approval();
  f.advance(10*60000);
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
  assert.equal((await f.call()).requests[0].status,'expired');
  const renewed=await f.decide();assert.notEqual(renewed.request.id,id);await flush();assert.equal(f.emails.length,0);
});

test('changed participants supersede pending requests and prior approval links',async()=>{
  const f=fixture();await f.decide();await flush();const {id}=await f.approval();
  f.advance(1000);f.setMatches([face('leo'),face('rebeca')]);const changed=await f.decide();assert.equal(changed.state,'pending');await flush();
  const state=await f.call();assert.equal(state.requests.find(r=>r.id===id).status,'superseded');
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
  f.advance(60000);f.setMatches([face('rebeca'),face('anthony')]);assert.equal((await f.decide()).state,'pending');await flush();assert.equal(f.emails.length,0);
  f.advance(1000);f.setMatches(pair());assert.equal((await f.decide()).state,'approved');
  assert.ok((await f.call()).requests.every(r=>r.status==='superseded'));
});

test('reset supersedes pending requests and their manual approval links',async()=>{
  const f=fixture();await f.decide();await flush();const {id}=await f.approval();
  assert.equal((await f.call('/api/pickup-demo/reset',{})).state,'waiting');
  const state=await f.call();assert.equal(state.latest,null);assert.equal(state.requests[0].status,'superseded');
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
});

test('reset invalidates a recognition response that is still in flight',async()=>{
  let resolve;const recognition=new Promise(r=>{resolve=r;});
  const f=fixture({recognizeOverride:()=>recognition});
  const deciding=f.decide();await flush();
  await f.call('/api/pickup-demo/reset',{});resolve({matches:pair()});
  await rejectsCode(deciding,'stale_observation',409);
  const state=await f.call();assert.notEqual(state.latest?.state,'approved');assert.equal(state.requests.length,0);assert.equal(f.emails.length,0);
});

test('GET removes latest approval after five seconds without a fresh frame',async()=>{
  const f=fixture();f.setMatches(pair());assert.equal((await f.decide()).state,'approved');
  f.advance(5001);assert.equal((await f.call()).latest,null);
});

test('pair approval history survives solo, blocked frames and camera reset without approving them',async()=>{
  const f=fixture();f.setMatches(pair());const approved=await f.decide();
  assert.equal(approved.approvals.length,1);
  const event=approved.approvals[0];
  assert.match(event.id,/^[a-f0-9-]{36}$/);assert.equal(event.createdAt,new Date(100000).toISOString());
  assert.deepEqual(event.matchedNames,['leo','anthony']);assert.equal(event.state,'approved');assert.equal(event.reason,approved.reason);
  f.setMatches([face('leo')]);const solo=await f.decide();assert.equal(solo.state,'blocked');assert.equal(solo.reason,'Cannot exit alone.');assert.deepEqual(solo.approvals,[event]);
  f.setMatches([face('rebeca'),face('anthony')]);const manual=await f.decide();assert.equal(manual.state,'pending');assert.deepEqual(manual.approvals,[event]);
  await f.call('/api/pickup-demo/reset',{});const reset=await f.call();assert.equal(reset.latest,null);assert.deepEqual(reset.approvals,[event]);
  assert.deepEqual((await f.call(undefined,undefined,{id:'other',role:'teacher'})).approvals,[]);
});

test('continuous pair frames deduplicate history and a new pair transition records a new event',async()=>{
  const f=fixture();f.setMatches(pair());const first=await f.decide();
  f.advance(1000);f.setMatches(pair().reverse());const repeated=await f.decide();assert.deepEqual(repeated.approvals,first.approvals);
  f.setMatches([face('leo')]);await f.decide();f.advance(1000);f.setMatches(pair());
  const next=await f.decide();assert.equal(next.approvals.length,2);assert.notEqual(next.approvals[0].id,first.approvals[0].id);
  assert.ok(next.approvals[0].createdAt>next.approvals[1].createdAt);
  for(let i=0;i<21;i++){f.setMatches([]);await f.decide();f.advance(1000);f.setMatches(pair());await f.decide();}
  assert.equal((await f.call()).approvals.length,20);
});

test('a manually approved pair after an observation gap needs fresh manual approval',async()=>{
  const f=fixture();f.setMatches([face('rebeca'),face('anthony')]);
  const approved=await f.decide();assert.equal(approved.state,'pending');
  const previousId=approved.request.id;
  await f.call(`/api/pickup-demo/requests/${previousId}/approve`,{});
  f.advance(5001);
  const afterGap=await f.decide();
  assert.equal(afterGap.state,'pending');
  assert.equal(afterGap.request.canApprove,true);
  assert.notEqual(afterGap.request.id,previousId);
  assert.deepEqual(afterGap.request.matchedNames,['rebeca','anthony']);
});

test('solo and manual approval never create automatic pair history',async()=>{
  const f=fixture();f.setMatches([face('rebeca'),face('anthony')]);
  const pending=await f.decide();assert.equal(pending.state,'pending');
  await f.call(`/api/pickup-demo/requests/${pending.request.id}/approve`,{});
  assert.deepEqual((await f.call()).approvals,[]);
  for(const name of ['leo','rebeca','anthony']) {
    f.setMatches([face(name)]);
    const solo=await f.decide();
    assert.equal(solo.state,'blocked');assert.equal(solo.reason,'Cannot exit alone.');
    assert.equal(solo.request,undefined);
    assert.equal((await f.call()).requests.every(request=>request.status!=='pending'&&request.status!=='approved'),true);
  }
  assert.deepEqual((await f.call()).approvals,[]);
});

test('solo frames cannot create or approve requests and invalidate a prior pair approval',async()=>{
  const f=fixture();
  const pairRequest=await f.decide();assert.equal(pairRequest.state,'pending');
  const id=pairRequest.request.id;
  assert.equal((await f.call(`/api/pickup-demo/requests/${id}/approve`,{})).state,'approved');
  for(const name of ['leo','rebeca','anthony']) {
    f.advance(1000);f.setMatches([face(name)]);
    const solo=await f.decide();
    assert.equal(solo.state,'blocked');assert.equal(solo.reason,'Cannot exit alone.');
    assert.equal(solo.request,undefined);
    assert.equal((await f.call()).requests.some(request=>request.status==='pending'),false);
    await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
  }
});

test('recognition errors invalidate an approved request and never retain an exit approval',async()=>{
  const f=fixture();await f.decide();await flush();const {id}=await f.approval();
  await f.call(`/api/pickup-demo/requests/${id}/approve`,{});
  f.advance(1000);f.setError(new Error('Face service unavailable'));
  await assert.rejects(f.decide(),/Face service unavailable/);
  const state=await f.call();assert.equal(state.latest.state,'blocked');assert.equal(state.requests[0].status,'superseded');
  await rejectsCode(f.call(`/api/pickup-demo/requests/${id}/approve`,{}),'stale_approval',409);
});


test('manual requests renew immediately after reset without a mail cooldown',async()=>{
  const f=fixture();const first=await f.decide();
  await f.call('/api/pickup-demo/reset',{});
  const next=await f.decide();assert.equal(next.state,'pending');assert.equal(next.request.canApprove,true);assert.notEqual(next.request.id,first.request.id);assert.equal(f.emails.length,0);
});
