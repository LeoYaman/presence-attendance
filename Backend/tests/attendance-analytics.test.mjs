import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDatabase} from './local-fixture.mjs';
import {createAttendanceExport,createAttendanceReports} from '../src/attendance-analytics.mjs';
import {createApp} from '../src/server.mjs';
import {opaqueToken,tokenDigest} from '../src/auth.mjs';

const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
const uuid=value=>{if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value??''))fail(400,'invalid_uuid');return value;};
const actor={id:randomUUID(),role:'teacher'};
const groupId=randomUUID();
const url=query=>new URL('http://localhost/?'+query);
function response(){return {headers:null,output:null,writeHead(status,headers){this.status=status;this.headers=headers;},end(output){this.output=output;}};}

test('export rejects roles and malformed queries before reading records',async()=>{
  const handler=createAttendanceExport({pool:{query(){assert.fail('Database must not be queried');}},fail,uuid});
  await assert.rejects(handler({user:{role:'student'},url:url('groupId='+groupId)}),{status:403,code:'staff_required'});
  for(const query of ['',`groupId=${groupId}&groupId=${groupId}`,`groupId=${groupId}&unexpected=1`])
    await assert.rejects(handler({user:actor,url:url(query)}),{status:400,code:'invalid_query'});
  await assert.rejects(handler({user:actor,url:url('groupId=bad')}),{status:400,code:'invalid_uuid'});
});

const reportsUrl=path=>new URL('http://localhost/api/attendance-insights/reports'+path);
test('reports reject nonstaff, query spoofing, invalid identifiers, and nonexact paths before database access',async()=>{
  const handler=createAttendanceReports({pool:{query(){assert.fail('Database must not be queried');}},fail,uuid});
  await assert.rejects(handler({user:{role:'student'},url:reportsUrl('')}),{status:403,code:'staff_required'});
  for(const path of ['?synthetic=true','?groupId='+groupId,'/'+groupId+'?synthetic=false'])
    await assert.rejects(handler({user:actor,url:reportsUrl(path)}),{status:400,code:'invalid_query'});
  await assert.rejects(handler({user:actor,url:reportsUrl('/bad')}),{status:400,code:'invalid_uuid'});
  for(const path of ['/','/'+groupId+'/extra','-spoof'])
    await assert.rejects(handler({user:actor,url:reportsUrl(path)}),{status:404,code:'not_found'});
});

async function reportFixture(){
  const fixture=await localDatabase(),q=(sql,params)=>fixture.pool.query(sql,params);
  const admin={id:randomUUID(),role:'admin'},other={id:randomUUID(),role:'teacher'},inactive={id:randomUUID(),role:'teacher'};
  for(const user of [actor,admin,other,inactive])await q('INSERT INTO attendance.users(id,email,password_hash,role,is_active) VALUES($1,$2,\'NONLOGIN\',$3,$4)',[user.id,user.id+'@reports.invalid',user.role,user!==inactive]);
  async function group(code='REPORT-'+randomUUID(),term='Real term',owner=actor){
    const id=randomUUID();
    await q("INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on) VALUES($1,$2,$3,'REPORT',$4,current_date-30,current_date+30)",[id,code,code==='PRESENCE-DEMO-SYNTHETIC'?'[SYNTHETIC DEMO] Lesson':'Private class title',term]);
    await q('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2)',[id,owner.id]);return id;
  }
  async function session(gid,{status='closed',future=false}={}){
    const id=randomUUID(),start=future?'2 days':'-2 days',end=future?'3 days':'-1 day';
    await q(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,status,opened_at,closed_at,created_by)
      VALUES($1,$2,now()+$3::interval,now()+$4::interval,$5,CASE WHEN $5 IN ('open','closed') THEN now()+$3::interval END,
        CASE WHEN $5='closed' THEN now()+$4::interval END,$6)`,[id,gid,start,end,status,actor.id]);return id;
  }
  async function record(sid,status='present'){
    const person=randomUUID();await q("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,$2,'Private Student Name')",[person,'PRIVATE-'+person]);
    const row=(await q(`INSERT INTO attendance.attendance_records(session_id,person_id,status,checked_in_at,method,recorded_by)
      VALUES($1,$2,$3,CASE WHEN $3 IN ('present','late') THEN now()-interval '2 days' END,
        CASE WHEN $3 IN ('present','late') THEN 'manual' WHEN $3='absent' THEN 'system' END,
        CASE WHEN $3<>'pending' THEN $4::uuid END) RETURNING id`,[sid,person,status,actor.id])).rows[0];return {id:row.id,person};
  }
  return {...fixture,q,admin,other,inactive,group,session,record};
}

test('SQL reports include each closed past lesson, empty rosters, finalized counts and staff ownership without people data',async()=>{
  const f=await reportFixture();
  try{
    const gid=await f.group(),sid=await f.session(gid),empty=await f.session(gid);
    const privateGroup=await f.group('PRIVATE-OTHER','Real term',f.other),privateSession=await f.session(privateGroup);
    for(const status of ['present','late','absent','pending'])await f.record(sid,status);
    for(const status of ['planned','open','cancelled'])await f.session(gid,{status});
    const future=await f.session(gid,{future:true});
    const handler=createAttendanceReports({pool:f.pool,fail,uuid});
    const list=await handler({user:actor,url:reportsUrl('')});
    assert.deepEqual(new Set(list.reports.map(row=>row.id)),new Set([sid,empty]));
    assert.equal(list.reports.find(row=>row.id===empty).total,0);
    assert.equal(list.reports.find(row=>row.id===sid).total,3);
    for(const row of list.reports){assert.equal(row.group_id,gid);assert.equal(row.synthetic,false);assert.ok(Number.isFinite(Date.parse(row.starts_at)));assert.ok(Number.isFinite(Date.parse(row.ends_at)));assert.ok(Number.isFinite(Date.parse(row.closed_at)));}
    const report=await handler({user:actor,url:reportsUrl('/'+sid)});
    assert.equal(report.version,1);assert.equal(report.engine,'Presence Attendance');assert.equal(report.synthetic,false);
    assert.equal(report.session.id,sid);assert.ok(Number.isFinite(Date.parse(report.generated_at)));
    assert.deepEqual(report.classes[0],{class_code:report.session.class_code,total:3,attended:2,late:1,absent:1,attendance_rate:66.7,late_rate:33.3,suggestion:'Follow up on absences and help students attend the next lesson.'});
    const emptyReport=await handler({user:actor,url:reportsUrl('/'+empty)});
    assert.equal(emptyReport.classes[0].attendance_rate,0);assert.equal(emptyReport.classes[0].late_rate,0);assert.equal(emptyReport.classes[0].total,0);
    for(const id of [future,privateSession,randomUUID()])await assert.rejects(handler({user:actor,url:reportsUrl('/'+id)}),{status:404,code:'not_found'});
    assert.equal((await handler({user:f.admin,url:reportsUrl('')})).reports.length,3);
    assert.equal((await handler({user:f.admin,url:reportsUrl('/'+privateSession)})).session.id,privateSession);
    assert.equal((await handler({user:f.inactive,url:reportsUrl('')})).reports.length,0);
    assert.equal((await handler({user:{id:f.other.id,role:'admin'},url:reportsUrl('')})).reports.length,1,'A caller role flag cannot override durable group ownership');
    const serialized=JSON.stringify({list,report,emptyReport});assert.ok(!serialized.includes('Private Student Name'));assert.ok(!serialized.includes('person_id'));assert.ok(!serialized.includes('person_code'));assert.ok(!serialized.includes('checked_in_at'));
  }finally{await f.engine.close();}
});

test('report provenance follows row flags and audit markers and survives empty synthetic lessons',async()=>{
  const f=await reportFixture();
  try{
    const real=await f.session(await f.group()),synthetic=await f.session(await f.group('PRESENCE-DEMO-SYNTHETIC')),
      fictionalEmpty=await f.session(await f.group('FICTIONAL','Fictional local demonstration')),
      audited=await f.session(await f.group());
    await f.record(real);await f.record(synthetic);const marker=await f.record(audited);
    await f.q("INSERT INTO attendance.audit_logs(actor_user_id,entity_type,entity_id,action) VALUES($1,'attendance_record',$2,'synthetic_demo_seed')",[actor.id,marker.id]);
    const handler=createAttendanceReports({pool:f.pool,fail,uuid,syntheticCamera:true});
    const get=id=>handler({user:actor,url:reportsUrl('/'+id)});
    assert.equal((await get(real)).synthetic,false,'Camera configuration does not label real records synthetic');
    for(const id of [synthetic,fictionalEmpty,audited])assert.equal((await get(id)).synthetic,true);
    await f.q('ALTER TABLE attendance.attendance_records ADD COLUMN synthetic boolean');
    await f.q('UPDATE attendance.attendance_records SET synthetic=false WHERE session_id IN ($1,$2)',[synthetic,audited]);
    await f.q('UPDATE attendance.attendance_records SET synthetic=true WHERE session_id=$1',[real]);
    assert.equal((await get(real)).synthetic,true);
    assert.equal((await get(synthetic)).synthetic,false,'Explicit real flags override synthetic group labels');
    assert.equal((await get(audited)).synthetic,false,'Explicit real flags override seed audit markers');
    assert.equal((await get(fictionalEmpty)).synthetic,true);
    const list=await handler({user:actor,url:reportsUrl('')});
    for(const row of list.reports)assert.equal(row.synthetic,(await get(row.id)).synthetic);
  }finally{await f.engine.close();}
});

test('HTTP reports appear after approve-next and close, persist across app recreation, and reflect corrections once',async()=>{
  const f=await reportFixture();let server;
  try{
    const gid=await f.group(),sid=randomUUID();
    const people=[randomUUID(),randomUUID()];
    for(const person of people){
      await f.q("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,$2,'Private HTTP Student')",[person,'HTTP-'+person]);
      await f.q("INSERT INTO attendance.group_memberships(group_id,person_id,joined_at) VALUES($1,$2,now()-interval '5 minutes')",[gid,person]);
    }
    await f.q("INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by) VALUES($1,$2,now()-interval '1 minute',now()+interval '1 hour',$3)",[sid,gid,actor.id]);
    const credentials=new Map();
    for(const user of [actor,f.admin,f.other]){
      const token=opaqueToken(),csrf=opaqueToken();credentials.set(user.id,{Cookie:'presence_session='+token,'X-CSRF-Token':csrf});
      await f.q("INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenDigest(token),user.id,csrf]);
    }
    let origin;
    const start=async()=>{
      server=createApp({pool:f.pool,publicOrigin:'http://localhost',faceWorker:{close(){}},recordingStore:{cleanup:async()=>{},setStorageLimit(){}}});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
    };
    await start();
    const request=async(path,{user=actor,body}={})=>{
      const res=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...credentials.get(user?.id),...(body===undefined?{}:{Origin:'http://localhost','Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:res.status,headers:res.headers,body:await res.json()};
    };
    const list=()=>request('/api/attendance-insights/reports');
    assert.equal((await request('/api/attendance-insights/reports',{user:null})).status,401);
    assert.equal((await list()).body.reports.length,0);
    assert.equal((await request(`/api/sessions/${sid}/open`,{body:{}})).status,200);
    const checked=await request(`/api/sessions/${sid}/checkins`,{body:{personId:people[0],source:'teacher'}});assert.equal(checked.status,200);
    assert.equal((await list()).body.reports.length,0,'An open lesson has no completed report');
    const approved=await request(`/api/sessions/${sid}/approve-next`,{body:{}});assert.equal(approved.status,200);
    const next=approved.body.session.id;
    const firstList=await list();assert.equal(firstList.status,200);assert.equal(firstList.headers.get('Cache-Control'),'no-store');assert.deepEqual(firstList.body.reports.map(row=>row.id),[sid]);
    const detail=()=>request('/api/attendance-insights/reports/'+sid);
    const firstReport=(await detail()).body;assert.equal(firstReport.classes[0].total,2);assert.equal(firstReport.classes[0].attended,1);assert.equal(firstReport.classes[0].absent,1);
    assert.equal((await request('/api/attendance-insights/reports/'+sid,{user:f.other})).status,404);
    assert.equal((await request('/api/attendance-insights/reports/'+sid+'?synthetic=true')).status,400);
    const absent=approved.body.approvedRoster.find(row=>row.person_id===people[1]);
    const correction={status:'present',reason:'Verified class attendance',checkedInAt:approved.body.approvedSession.opened_at};
    for(let i=0;i<2;i++)assert.equal((await request(`/api/records/${absent.record_id}/correction`,{body:correction})).status,200);
    const corrected=(await detail()).body;assert.equal(corrected.classes[0].total,2);assert.equal(corrected.classes[0].attended,2);assert.equal(corrected.classes[0].attendance_rate,100);assert.equal((await list()).body.reports.length,1);
    assert.equal((await request(`/api/sessions/${next}/close`,{body:{}})).status,200);
    assert.equal((await request(`/api/sessions/${next}/close`,{body:{}})).status,200);
    const closedList=(await list()).body.reports;assert.deepEqual(new Set(closedList.map(row=>row.id)),new Set([sid,next]));
    const nextReport=(await request('/api/attendance-insights/reports/'+next)).body;assert.equal(nextReport.classes[0].absent,2);assert.equal(nextReport.classes[0].total,2);
    await new Promise(resolve=>server.close(resolve));server=null;await start();
    assert.deepEqual((await list()).body.reports,closedList,'Reports survive app recreation and derive from durable sessions');
    assert.deepEqual((await detail()).body.classes,corrected.classes);
    assert.ok(!JSON.stringify({closedList,corrected}).includes('Private HTTP Student'));
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await f.engine.close();}
});

test('export propagates group authorization denial without querying records',async()=>{
  let calls=0;
  const handler=createAttendanceExport({fail,uuid,pool:{query:async()=>{calls++;throw Object.assign(new Error('denied'),{code:'42501'});}}});
  await assert.rejects(handler({user:actor,url:url('groupId='+groupId)}),{code:'42501'});
  assert.equal(calls,1);
});

test('export enforces the row cap before sending CSV',async()=>{
  const handler=createAttendanceExport({fail,uuid,pool:{query:async sql=>({rows:sql.includes('AS class_code')?Array(10001).fill({}):[]})}});
  const res=response();
  await assert.rejects(handler({user:actor,url:url('groupId='+groupId),res}),{status:409,code:'export_too_large'});
  assert.equal(res.output,null);
});

test('SQL export preserves row provenance, excludes unfinished sessions, and pseudonymizes identities',async()=>{
  const fixture=await localDatabase();
  let server;
  try{
    const query=(sql,params)=>fixture.pool.query(sql,params);
    await query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'analytics@test.invalid','NONLOGIN','teacher')",[actor.id]);
    await query("INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'ANALYTICS-PRIVATE','Private Name')",[actor.id]);
    const sessionIds=[];
    for(const [code,name,term] of [['REAL','Real class','Term'],['PRESENCE-DEMO-SYNTHETIC','[SYNTHETIC DEMO] Test','Term'],['CLS-1','Catalog class','Fictional local demonstration'],['AUDITED','Renamed class','Term']]){
      const gid=randomUUID(),sid=randomUUID();sessionIds.push({gid,sid,code});
      await query("INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on) VALUES($1,$2,$3,'COURSE',$4,current_date-30,current_date+30)",[gid,code,name,term]);
      await query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2)',[gid,actor.id]);
      await query("INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,status,opened_at,closed_at,created_by) VALUES($1,$2,now()-interval '2 days',now()-interval '1 day','closed',now()-interval '2 days',now()-interval '1 day',$3)",[sid,gid,actor.id]);
      const record=(await query("INSERT INTO attendance.attendance_records(session_id,person_id,status,checked_in_at,method,recorded_by) VALUES($1,$2,'present',now()-interval '2 days','manual',$2) RETURNING id",[sid,actor.id])).rows[0];
      if(code==='AUDITED')await query("INSERT INTO attendance.audit_logs(actor_user_id,entity_type,entity_id,action) VALUES($1,'attendance_record',$2,'synthetic_demo_seed')",[actor.id,record.id]);
    }
    const handler=createAttendanceExport({pool:fixture.pool,fail,uuid,syntheticCamera:true});
    const exportGroup=async gid=>{const res=response();await handler({user:actor,url:url('groupId='+gid),res});return res;};
    for(const entry of sessionIds){const res=await exportGroup(entry.gid);assert.equal(res.status,200);assert.equal(res.headers['Cache-Control'],'no-store');assert.equal(res.output.split('\r\n').length,2);assert.ok(res.output.endsWith(entry.code==='REAL'?'"false"':'"true"'));assert.ok(!res.output.includes(actor.id));assert.ok(!res.output.includes('Private Name'));}
    const real=sessionIds[0],first=await exportGroup(real.gid),second=await exportGroup(real.gid);
    assert.equal(first.output,second.output,'Pseudonyms remain stable within this handler');
    for(const [status,future] of [['open',false],['closed',true]]){
      const sid=randomUUID();
      await query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,status,opened_at,closed_at,created_by) VALUES($1,$2,now()+$3::interval,now()+$4::interval,$5,now()+$3::interval,CASE WHEN $5='closed' THEN now()+$4::interval END,$6)`,[sid,real.gid,future?'2 days':'-2 days',future?'3 days':'-1 day',status,actor.id]);
      await query("INSERT INTO attendance.attendance_records(session_id,person_id,status,checked_in_at,method,recorded_by) VALUES($1,$2,'present',now(),'manual',$2)",[sid,actor.id]);
    }
    assert.equal((await exportGroup(real.gid)).output.split('\r\n').length,2);
    await assert.rejects(handler({user:{id:randomUUID(),role:'teacher'},url:url('groupId='+real.gid),res:response()}),{code:'42501'});
    // Exercise custom deployed schemas without requiring a migration in stock installs.
    await query('ALTER TABLE attendance.attendance_records ADD COLUMN synthetic boolean');
    await query('UPDATE attendance.attendance_records SET synthetic=true WHERE session_id=$1',[real.sid]);
    await query('UPDATE attendance.attendance_records SET synthetic=false WHERE session_id=$1',[sessionIds[1].sid]);
    assert.ok((await exportGroup(real.gid)).output.endsWith('"true"'));
    assert.ok((await exportGroup(sessionIds[1].gid)).output.endsWith('"false"'));
    server=createApp({pool:fixture.pool,syntheticCamera:false,faceWorker:{close(){}},recordingStore:{cleanup:async()=>{},setStorageLimit(){}}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    const cookies={};
    for(const role of ['teacher','student','otherTeacher']){
      const uid=role==='teacher'?actor.id:randomUUID(),token=opaqueToken();
      if(role!=='teacher')await query('INSERT INTO attendance.users(id,email,password_hash,role,person_id) VALUES($1,$2,\'NONLOGIN\',$3,$4)',[uid,role+'@analytics.invalid',role==='student'?'student':'teacher',role==='student'?actor.id:null]);
      await query("INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenDigest(token),uid,opaqueToken()]);
      cookies[role]='presence_session='+token;
    }
    const request=(query,role)=>fetch(origin+'/api/attendance-insights/export?'+query,{headers:role?{Cookie:cookies[role]}:{}});
    assert.equal((await request('groupId='+real.gid)).status,401);
    assert.equal((await request('groupId='+real.gid,'student')).status,403);
    assert.equal((await request('groupId='+real.gid,'otherTeacher')).status,403);
    assert.equal((await request('groupId='+real.gid+'&extra=1','teacher')).status,400);
    const exported=await request('groupId='+real.gid,'teacher');
    assert.equal(exported.status,200);assert.match(exported.headers.get('Content-Type'),/^text\/csv/);
    assert.ok((await exported.text()).endsWith('"true"'),'HTTP export respects row provenance even with syntheticCamera false');
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await fixture.engine.close();}
});
