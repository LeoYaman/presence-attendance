import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { localDatabase } from './local-fixture.mjs';
import { createApp } from '../src/server.mjs';
import { hashPassword,verifyPassword,tokenDigest } from '../src/auth.mjs';
import { databaseConfig } from '../src/database.mjs';
const password = 'A-test-only-secret-2026';
const id = Object.fromEntries(['teacher','otherTeacher','student','alice','bob','inactive','notRoster','group','session'].map(k => [k,randomUUID()]));
let fixture,server,origin,teacher,student,otherTeacher,aliceRecord,bobRecord,session,faceCalls=[],faceFailure=null,faceWorkerClosed=false;
const faceWorker = {
  async request(request) {
    faceCalls.push(request);
    if (faceFailure) throw faceFailure;
    return {matches:[],sampleCounts:{}};
  },
  close() { faceWorkerClosed=true; },
};
const query = (sql,params) => fixture.db.query(sql,params);
const one = async (sql,params) => (await query(sql,params)).rows[0];
async function request(path,{actor,body,method=body===undefined?'GET':'POST',headers={}}={}) {
  const response = await fetch(`${origin}${path}`,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),
    ...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrfToken}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
}
async function login(email) {
  const result = await request('/api/login',{body:{email,password}});
  assert.equal(result.status,200); return {cookie:result.cookie.split(';')[0],csrfToken:result.body.csrfToken,user:result.body.user};
}
before(async () => {
  fixture = await localDatabase();
  await query(`INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,'API-A','Alice Test'),($2,'API-B','Bob Test'),($3,'API-X','Inactive Test')`,[id.alice,id.bob,id.inactive]);
  await query('UPDATE attendance.people SET is_active=false WHERE id=$1',[id.inactive]);
  const hash = await hashPassword(password);
  for (const [key,email,role,person] of [['teacher','teacher@api.test','teacher',null],['otherTeacher','other@api.test','teacher',null],['student','alice@api.test','student',id.alice]])
    await query('INSERT INTO attendance.users(id,email,password_hash,role,person_id) VALUES($1,$2,$3,$4,$5)',[id[key],email,hash,role,person]);
  await query(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on,time_zone)
    VALUES($1,'API-G','API Class','API','Test',current_date-30,current_date+30,'America/New_York')`,[id.group]);
  await query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2)',[id.group,id.teacher]);
  await query('INSERT INTO attendance.group_memberships(group_id,person_id,joined_at) VALUES($1,$2,now()-interval \'1 day\'),($1,$3,now()-interval \'1 day\'),($1,$4,now()-interval \'1 day\')',[id.group,id.alice,id.bob,id.inactive]);
  await query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by) VALUES($1,$2,now()-interval '1 minute',now()+interval '1 hour',$3)`,[id.session,id.group,id.teacher]);
  server = createApp({pool:fixture.pool,publicOrigin:'http://127.0.0.1:39107',faceWorker});
  await new Promise(resolve => server.listen(39107,'127.0.0.1',resolve)); origin='http://127.0.0.1:39107';
  teacher = await login('teacher@api.test'); student = await login('alice@api.test'); otherTeacher=await login('other@api.test');
}, {timeout:30000});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); assert.equal(faceWorkerClosed,true); await fixture?.engine.close(); });

test('scrypt rejects wrong passwords and malformed hashes; pool always verifies TLS',async () => {
  const hash=await hashPassword(password); assert.equal(await verifyPassword(password,hash),true);
  assert.equal(await verifyPassword('wrong',hash),false); assert.equal(await verifyPassword(password,'TEST-NONLOGIN'),false);
  await assert.rejects(hashPassword('short'),/12 to 256/);
  const config=databaseConfig('postgresql://fixture:secret@example.test/db?sslmode=disable&sslrootcert=bad&uselibpqcompat=true');
  assert.equal(config.ssl.rejectUnauthorized,true); assert.equal(new URL(config.connectionString).search,'');
});
test('authentication returns trusted role, HttpOnly opaque token and only stores token digest',async () => {
  assert.equal(teacher.user.role,'teacher'); assert.equal(teacher.user.person_id,null); assert.match(teacher.cookie,/presence_session=[a-f0-9]{64}/);
  const loginResponse=await request('/api/login',{body:{email:'TEACHER@API.TEST',password}});
  assert.match(loginResponse.cookie,/HttpOnly/); assert.match(loginResponse.cookie,/SameSite=Strict/);
  assert.equal(loginResponse.body.user.password_hash,undefined);
  const token=teacher.cookie.split('=')[1]; assert.ok(await one('SELECT token_hash FROM attendance.auth_sessions WHERE token_hash=$1',[tokenDigest(token)]));
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.auth_sessions WHERE token_hash=$1',[token])).n,0);
  assert.equal((await request('/api/me',{actor:student})).body.user.person_id,id.alice);
  assert.equal((await request('/api/me')).status,401);
  assert.equal((await request('/api/login',{body:{email:'teacher@api.test',password:'wrong'}})).status,401);
  assert.equal((await request('/api/login',{body:{email:'missing@api.test',password}})).body.error.message,'Email or password is incorrect');
});
test('CSRF, origin, identity injection and group authorization are enforced',async () => {
  assert.equal((await request(`/api/sessions/${id.session}/open`,{actor:teacher,body:{},headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await request(`/api/sessions/${id.session}/open`,{actor:teacher,body:{},headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await request(`/api/sessions/${id.session}/open`,{actor:teacher,body:{},headers:{'X-CSRF-Token':'é'.repeat(64)}})).status,403);
  assert.equal((await request(`/api/sessions/${id.session}/open`,{actor:teacher,body:{actor:id.student}})).status,400);
  assert.equal((await request(`/api/sessions/${id.session}/open`,{actor:student,body:{}})).status,403);
  assert.equal((await request(`/api/groups/${id.group}/roster`,{actor:otherTeacher})).status,403);
  assert.equal((await request('/api/groups',{actor:otherTeacher})).body.groups.length,0);
  assert.equal((await request('/api/groups',{actor:student})).body.groups.length,1);
  assert.equal((await request('/api/history',{actor:teacher})).status,403);
  assert.equal((await request(`/api/sessions/not-a-uuid/open`,{actor:teacher,body:{}})).status,400);
});
test('face routes require authentication, CSRF, teacher role and group management permission',async () => {
  faceCalls=[];
  const path=`/api/groups/${id.group}/faces/detect`, body={image:'eA=='};
  assert.equal((await request(path,{body})).status,401);
  assert.equal((await request(path,{actor:teacher,body,headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await request(path,{actor:student,body})).status,403);
  assert.equal((await request(path,{actor:otherTeacher,body})).status,403);
  assert.equal(faceCalls.length,0);
});
test('face enrollment accepts only active current-roster people',async () => {
  faceCalls=[];
  const path=`/api/groups/${id.group}/faces/enroll`, bodyFor=personId=>({image:'eA==',personId});
  assert.equal((await request(path,{actor:teacher,body:bodyFor(id.inactive)})).status,403);
  assert.equal((await request(path,{actor:teacher,body:bodyFor(id.notRoster)})).status,403);
  assert.equal(faceCalls.length,0);
  const result=await request(path,{actor:teacher,body:bodyFor(id.alice)});
  assert.equal(result.status,200);
  assert.deepEqual(new Set(faceCalls[0].allowedIds),new Set([id.alice,id.bob]));
  assert.equal(faceCalls[0].personId,id.alice);
});
test('face image validation rejects malformed input while allowing camera bodies over 8192 bytes',async () => {
  faceCalls=[];
  const path=`/api/groups/${id.group}/faces/detect`;
  assert.equal((await request(path,{actor:teacher,body:{image:'***'}})).status,400);
  const large=await request(path,{actor:teacher,body:{image:'A'.repeat(12000)}});
  assert.equal(large.status,200);
  assert.equal(faceCalls.length,1);
  assert.equal(faceCalls[0].image.length,12000);
  assert.equal((await request(path,{actor:teacher,body:{image:'A'.repeat(401000)}})).status,413);
  assert.equal(faceCalls.length,1);
});
test('face clear is scoped to the authorized group and worker errors map to API status',async () => {
  faceCalls=[];
  const path=`/api/groups/${id.group}/faces/clear`;
  assert.equal((await request(path,{actor:teacher,body:{}})).status,200);
  assert.equal(faceCalls.length,1);
  assert.equal(faceCalls[0].action,'clear');
  assert.equal(faceCalls[0].groupId,id.group);
  assert.deepEqual(new Set(faceCalls[0].allowedIds),new Set([id.alice,id.bob]));
  faceFailure=Object.assign(new Error('worker busy'),{status:429,code:'face_busy'});
  try {
    const failed=await request(`/api/groups/${id.group}/faces/detect`,{actor:teacher,body:{image:'eA=='}});
    assert.equal(failed.status,429);
    assert.deepEqual(failed.body.error,{code:'face_busy',message:'worker busy'});
  } finally { faceFailure=null; }
});

test('saved reference mappings are server-owned and restricted to active roster people',async () => {
  const path=`/api/groups/${id.group}/faces/detect`;
  for(const [key,person] of [['team_leo',id.alice],['team_anthony',id.inactive],['team_olivia',id.bob]]) {
    await query(`INSERT INTO attendance.team_face_references(reference_key,group_id,person_id,source_path,source_commit,image_sha256,image_bytes,is_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[key,id.group,person,`face_data/people_faces/WIN_${key==='team_leo'?'1':key==='team_anthony'?'2':'3'}_Pro.jpg`,'a'.repeat(40),'b'.repeat(64),Buffer.alloc(100),key!=='team_olivia']);
  }
  try {
    faceCalls=[];
    assert.equal((await request(path,{actor:teacher,body:{image:'eA==',referenceMappings:[]}})).status,400);
    assert.equal((await request(path,{actor:otherTeacher,body:{image:'eA=='}})).status,403);
    assert.equal(faceCalls.length,0);
    assert.equal((await request(path,{actor:teacher,body:{image:'eA=='}})).status,200);
    assert.deepEqual(faceCalls[0].referenceMappings,[{referenceKey:'team_leo',personId:id.alice}]);
  } finally {await query('DELETE FROM attendance.team_face_references WHERE group_id=$1',[id.group]);}
});
test('opening roster, teacher check-in and retry deduplicate raw event history',async () => {
  const result=await request(`/api/sessions/${id.session}/open`,{actor:teacher,body:{}}); assert.equal(result.status,200); assert.equal(result.body.participants,2); session=result.body.session;
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[id.session])).n,2);
  assert.equal((await request(`/api/sessions/${id.session}/open`,{actor:teacher,body:{}})).body.participants,2);
  const initial=await request(`/api/sessions/${id.session}/dashboard`,{actor:teacher});
  assert.equal(initial.body.roster.length,2); assert.equal(initial.body.distribution.pending,2); assert.equal(initial.body.daily.length,0);
  bobRecord=initial.body.roster.find(r=>r.person_id===id.bob).record_id;
  const first=await request(`/api/sessions/${id.session}/checkins`,{actor:teacher,body:{personId:id.alice,source:'teacher'}}); assert.equal(first.status,200); aliceRecord=first.body.record;
  const again=await request(`/api/sessions/${id.session}/checkins`,{actor:teacher,body:{personId:id.alice,source:'teacher'}});
  assert.equal(again.body.record.checked_in_at,aliceRecord.checked_in_at); assert.equal(again.body.record.status,'present');
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[id.session])).n,3);
  const dashboard=await request(`/api/sessions/${id.session}/dashboard`,{actor:teacher});
  assert.deepEqual(dashboard.body.distribution,{pending:1,present:1,late:0,absent:0,total:2}); assert.equal(dashboard.body.arrivals.reduce((n,r)=>n+r.count,0),1);
  assert.equal(dashboard.body.roster.find(r=>r.person_id===id.alice).source,'teacher');
  assert.equal((await request(`/api/sessions/${id.session}/checkins`,{actor:teacher,body:{personId:id.bob,source:'camera',confidence:0.999}})).status,501);
  assert.equal((await request(`/api/sessions/${id.session}/checkins`,{actor:teacher,body:{personId:id.bob,source:'teacher',confidence:0.999}})).status,400);
});
test('closing finalizes, corrections immediately update raw analytics without double counting',async () => {
  const result=await request(`/api/sessions/${id.session}/close`,{actor:teacher,body:{}}); assert.equal(result.status,200); assert.equal(result.body.absentCount,1);
  assert.equal((await request(`/api/sessions/${id.session}/close`,{actor:teacher,body:{}})).body.absentCount,1);
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[id.session])).n,4);
  let dashboard=(await request(`/api/sessions/${id.session}/dashboard`,{actor:teacher})).body; assert.equal(dashboard.daily[0].absent,1);
  assert.equal((await request(`/api/records/${bobRecord}/correction`,{actor:teacher,body:{status:'present',reason:'',checkedInAt:session.opened_at}})).status,400);
  assert.equal((await request(`/api/records/${bobRecord}/correction`,{actor:student,body:{status:'present',reason:'Verified',checkedInAt:session.opened_at}})).status,403);
  const body={status:'present',reason:'Teacher verified arrival',checkedInAt:session.opened_at};
  assert.equal((await request(`/api/records/${bobRecord}/correction`,{actor:teacher,body})).status,200);
  assert.equal((await request(`/api/records/${bobRecord}/correction`,{actor:teacher,body})).status,200);
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[id.session])).n,5);
  dashboard=(await request(`/api/sessions/${id.session}/dashboard`,{actor:teacher})).body; assert.equal(dashboard.daily[0].absent,0); assert.equal(dashboard.daily[0].present,2);
  assert.equal(dashboard.arrivals.reduce((n,r)=>n+r.count,0),2);
  const history=(await request('/api/history',{actor:student})).body; assert.equal(history.history.length,1); assert.equal(history.history[0].person_id,id.alice); assert.equal(history.summary[0].used_absences,0);
  assert.equal((await request(`/api/history?personId=${id.bob}`,{actor:student})).status,400);
  await assert.rejects(query('UPDATE attendance.attendance_events SET status=\'absent\' WHERE record_id=$1',[aliceRecord.id]),/append-only/);
});
test('audit failure rolls back relational result AND trigger event in same HTTP transaction',async () => {
  const made=await request(`/api/groups/${id.group}/sessions`,{actor:teacher,body:{startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),lateAfterMinutes:10}});
  assert.equal(made.status,200); const sid=made.body.session.id;
  await request(`/api/sessions/${sid}/open`,{actor:teacher,body:{}});
  await query(`CREATE FUNCTION attendance.test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='checked_in' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER test_audit_failure BEFORE INSERT ON attendance.audit_logs FOR EACH ROW EXECUTE FUNCTION attendance.test_reject_audit();`);
  assert.equal((await request(`/api/sessions/${sid}/checkins`,{actor:teacher,body:{personId:id.bob,source:'teacher'}})).status,409);
  await query('DROP TRIGGER test_audit_failure ON attendance.audit_logs; DROP FUNCTION attendance.test_reject_audit();');
  assert.equal((await one('SELECT status FROM attendance.attendance_records WHERE session_id=$1 AND person_id=$2',[sid,id.bob])).status,'pending');
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[sid])).n,2);
});
test('future sessions cannot open or close and legacy future absence does not consume allowance',async () => {
  const future=new Date(Date.now()+86400000).toISOString();
  const made=await request(`/api/groups/${id.group}/sessions`,{actor:teacher,body:{startsAt:future,endsAt:new Date(Date.now()+90000000).toISOString()}});
  assert.equal(made.status,200); const sid=made.body.session.id;
  for (const action of ['open','close']) assert.equal((await request(`/api/sessions/${sid}/${action}`,{actor:teacher,body:{}})).status,409);
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_records WHERE session_id=$1',[sid])).n,0);
  await query("UPDATE attendance.attendance_sessions SET status='closed',opened_at=now(),closed_at=now() WHERE id=$1",[sid]);
  await query("INSERT INTO attendance.attendance_records(session_id,person_id,status,method,recorded_by) VALUES($1,$2,'absent','system',$3)",[sid,id.alice,id.teacher]);
  const history=(await request('/api/history',{actor:student})).body;
  assert.equal(history.summary.find(r=>r.group_id===id.group).used_absences,0);
  assert.equal((await request(`/api/sessions/${id.session}/dashboard`,{actor:teacher})).body.daily.reduce((n,r)=>n+r.absent,0),0);
});
test('synthetic recognition requires explicit flag AND labeled demo group and ignores client confidence',async () => {
  const sid=randomUUID(); const gid=randomUUID();
  await query(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on)
    VALUES($1,'PRESENCE-DEMO-SYNTHETIC','[SYNTHETIC DEMO] Class','DEMO','Synthetic',current_date-30,current_date+30)`,[gid]);
  await query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2)',[gid,id.teacher]);
  await query('INSERT INTO attendance.group_memberships(group_id,person_id) VALUES($1,$2)',[gid,id.alice]);
  await query(`INSERT INTO attendance.face_enrollments(person_id,provider,template_ref,status,consent_recorded_at,created_by)
    VALUES($1,'presence-synthetic-demo','synthetic-test-only','active',now(),$2)`,[id.alice,id.teacher]);
  await query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by) VALUES($1,$2,now(),now()+interval '1 hour',$3)`,[sid,gid,id.teacher]);
  await query('SELECT attendance.open_session($1,$2)',[sid,id.teacher]);
  const demoServer=createApp({pool:fixture.pool,publicOrigin:'http://127.0.0.1:39108',syntheticCamera:true});
  await new Promise(resolve=>demoServer.listen(39108,'127.0.0.1',resolve)); const oldOrigin=origin; origin='http://127.0.0.1:39108';
  try {
    const nonDemoSession=(await one("SELECT id FROM attendance.attendance_sessions WHERE group_id=$1 AND status='open'",[id.group])).id;
    assert.equal((await request(`/api/sessions/${nonDemoSession}/checkins`,{actor:teacher,body:{personId:id.alice,source:'camera'}})).status,501);
    const result=await request(`/api/sessions/${sid}/checkins`,{actor:teacher,body:{personId:id.alice,source:'camera',confidence:0.12}});
    assert.equal(result.status,200); assert.equal(Number(result.body.record.confidence),0.99); assert.equal(result.body.synthetic,true);
  } finally { origin=oldOrigin; await new Promise(resolve=>demoServer.close(resolve)); }
});
test('approve-next finalizes history once and concurrent requests share one fresh open roster',async () => {
  const made=await request(`/api/groups/${id.group}/sessions`,{actor:teacher,body:{
    startsAt:new Date(Date.now()-20*60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),lateAfterMinutes:7}});
  assert.equal(made.status,200); const sid=made.body.session.id;
  assert.equal((await request(`/api/sessions/${sid}/open`,{actor:teacher,body:{}})).status,200);
  const arrival=await request(`/api/sessions/${sid}/checkins`,{actor:teacher,body:{personId:id.alice,source:'teacher'}});
  assert.equal(arrival.body.record.status,'late');
  const beforeApproval=Date.now();
  const approvals=await Promise.all([1,2].map(()=>request(`/api/sessions/${sid}/approve-next`,{actor:teacher,body:{}})));
  for(const approval of approvals) assert.equal(approval.status,200);
  const result=approvals[0].body, next=result.session;
  assert.equal(approvals[1].body.session.id,next.id);
  assert.equal(result.approvedSession.id,sid); assert.equal(result.approvedSession.status,'closed');
  assert.equal(next.status,'open'); assert.notEqual(next.id,sid); assert.equal(next.group_id,id.group);
  assert.equal(next.previous_session_id,sid); assert.equal(next.late_after_minutes,7);
  assert.ok(Date.parse(next.starts_at)>=beforeApproval); assert.ok(Date.parse(next.opened_at)>=Date.parse(next.starts_at));
  assert.equal(Date.parse(next.ends_at)-Date.parse(next.starts_at),3600000);
  assert.deepEqual(result.roster.map(row=>row.status),['pending','pending']);
  assert.ok(result.roster.every(row=>row.checked_in_at===null && row.method===null));
  assert.equal(result.approvedRoster.find(row=>row.person_id===id.alice).status,'late');
  assert.equal(result.approvedRoster.find(row=>row.person_id===id.alice).checked_in_at,arrival.body.record.checked_in_at);
  assert.equal(result.approvedRoster.find(row=>row.person_id===id.bob).status,'absent');
  assert.ok(result.roster.every(row=>!result.approvedRoster.some(old=>old.record_id===row.record_id)));
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_sessions WHERE previous_session_id=$1',[sid])).n,1);
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[sid])).n,4);
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[next.id])).n,2);
  const freshArrival=await request(`/api/sessions/${next.id}/checkins`,{actor:teacher,body:{personId:id.alice,source:'teacher'}});
  assert.equal(freshArrival.status,200); assert.equal(freshArrival.body.record.status,'present');
  const retry=await request(`/api/sessions/${sid}/approve-next`,{actor:teacher,body:{}});
  assert.equal(retry.body.session.id,next.id);
  assert.equal(retry.body.roster.find(row=>row.person_id===id.alice).checked_in_at,freshArrival.body.record.checked_in_at);
  assert.deepEqual(retry.body.approvedRoster,result.approvedRoster);
  assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE session_id=$1',[next.id])).n,3);
  await assert.rejects(query(`INSERT INTO attendance.attendance_sessions(group_id,starts_at,ends_at,created_by,previous_session_id)
    VALUES($1,now(),now()+interval '1 hour',$2,$3)`,[id.group,id.teacher,sid]),/unique constraint/);
});

test('approve-next recovers an already closed session and rejects unauthorized or invalid states',async () => {
  const recovered=await request(`/api/sessions/${id.session}/approve-next`,{actor:teacher,body:{}});
  assert.equal(recovered.status,200); assert.equal(recovered.body.approvedSession.status,'closed');
  assert.equal(recovered.body.session.previous_session_id,id.session); assert.equal(recovered.body.session.status,'open');
  const path=`/api/sessions/${recovered.body.session.id}/approve-next`;
  assert.equal((await request(path,{body:{}})).status,401);
  for(const actor of [student,otherTeacher]) assert.equal((await request(path,{actor,body:{}})).status,403);
  assert.equal((await request(path,{actor:teacher,body:{},headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await request(path,{actor:teacher,body:{},headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await request(path,{actor:teacher,body:{previousSessionId:id.session}})).status,400);
  assert.equal((await request(path,{actor:teacher})).status,405);
  assert.equal((await request(`/api/sessions/${randomUUID()}/approve-next`,{actor:teacher,body:{}})).status,404);
  for(const state of ['planned','cancelled','future']) {
    const sid=randomUUID();
    await query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by,status)
      VALUES($1,$2,now()+$4::interval,now()+interval '2 days',$3,$5)`,
      [sid,id.group,id.teacher,state==='future'?'1 day':'-1 minute',state==='cancelled'?'cancelled':'planned']);
    const rejected=await request(`/api/sessions/${sid}/approve-next`,{actor:teacher,body:{}});
    assert.equal(rejected.status,409);
    assert.equal(rejected.body.error.code,state==='future'?'future_session':'workflow_conflict');
    assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_sessions WHERE previous_session_id=$1',[sid])).n,0);
  }
});

test('approve-next succeeds with the existing restricted runtime role grants',async () => {
  const made=await request(`/api/groups/${id.group}/sessions`,{actor:teacher,body:{
    startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()}});
  assert.equal(made.status,200); const sid=made.body.session.id;
  assert.equal((await request(`/api/sessions/${sid}/open`,{actor:teacher,body:{}})).status,200);
  await query('CREATE ROLE presence_runtime');
  await query(await readFile(new URL('../db/runtime_grants.sql',import.meta.url),'utf8'));
  await query('SET ROLE presence_runtime');
  try {
    const result=await request(`/api/sessions/${sid}/approve-next`,{actor:teacher,body:{}});
    assert.equal(result.status,200); assert.equal(result.body.approvedSession.status,'closed');
    assert.equal(result.body.session.previous_session_id,sid); assert.equal(result.body.session.status,'open');
    assert.deepEqual(result.body.roster.map(row=>row.status),['pending','pending']);
  } finally { await query('RESET ROLE'); }
});

test('approve-next rolls back old finalization, new roster and events if successor opening fails',async () => {
  const made=await request(`/api/groups/${id.group}/sessions`,{actor:teacher,body:{
    startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()}});
  assert.equal(made.status,200); const sid=made.body.session.id;
  assert.equal((await request(`/api/sessions/${sid}/open`,{actor:teacher,body:{}})).status,200);
  const beforeSessions=(await one('SELECT count(*)::int AS n FROM attendance.attendance_sessions')).n;
  const beforeEvents=(await one('SELECT count(*)::int AS n FROM attendance.attendance_events')).n;
  const beforeAudits=(await one('SELECT count(*)::int AS n FROM attendance.audit_logs')).n;
  await query(`CREATE FUNCTION attendance.test_reject_successor_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='session_opened' THEN RAISE EXCEPTION 'test successor audit failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER test_successor_audit_failure BEFORE INSERT ON attendance.audit_logs
      FOR EACH ROW EXECUTE FUNCTION attendance.test_reject_successor_audit();`);
  try {
    assert.equal((await request(`/api/sessions/${sid}/approve-next`,{actor:teacher,body:{}})).status,409);
    assert.equal((await one('SELECT status FROM attendance.attendance_sessions WHERE id=$1',[sid])).status,'open');
    assert.deepEqual((await query('SELECT status FROM attendance.attendance_records WHERE session_id=$1',[sid])).rows.map(row=>row.status),['pending','pending']);
    assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_sessions')).n,beforeSessions);
    assert.equal((await one('SELECT count(*)::int AS n FROM attendance.attendance_events')).n,beforeEvents);
    assert.equal((await one('SELECT count(*)::int AS n FROM attendance.audit_logs')).n,beforeAudits);
  } finally {
    await query('DROP TRIGGER test_successor_audit_failure ON attendance.audit_logs; DROP FUNCTION attendance.test_reject_successor_audit();');
  }
  assert.equal((await request(`/api/sessions/${sid}/approve-next`,{actor:teacher,body:{}})).status,200);
});

test('static allowlist blocks credentials/datasets; logout, inactive accounts and expiry revoke access',async () => {
  for (const path of ['/Backend/.env','/face_data/README.txt','/.git/config']) assert.equal((await fetch(`${origin}${path}`)).status,404);
  await query('UPDATE attendance.users SET is_active=false WHERE id=$1',[id.otherTeacher]); assert.equal((await request('/api/me',{actor:otherTeacher})).status,401);
  await query("UPDATE attendance.auth_sessions SET expires_at=now()-interval '59 minutes',created_at=now()-interval '1 hour' WHERE user_id=$1",[id.student]);
  assert.equal((await request('/api/me',{actor:student})).status,401);
  assert.equal((await request('/api/logout',{actor:teacher,body:{}})).status,200); assert.equal((await request('/api/me',{actor:teacher})).status,401);
});
