import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localDatabase} from './local-fixture.mjs';
import {createApp} from '../src/server.mjs';
import {createRecordingStore} from '../src/recording-store.mjs';
import {hashPassword} from '../src/auth.mjs';

const origin='http://127.0.0.1:39113',secret='Admin-test-secret-2026';
const ids={admin:randomUUID(),teacher:randomUUID()};
let fixture,server,admin,teacher,student,course,session,record,root,store;
async function call(path,{actor=admin,body,headers={},raw=false}={}){
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrfToken}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:raw?await response.text():await response.json(),cookie:response.headers.get('set-cookie'),type:response.headers.get('content-type')};
}
async function login(email){const result=await call('/api/login',{actor:null,body:{email,password:secret}});assert.equal(result.status,200);return {cookie:result.cookie.split(';')[0],csrfToken:result.body.csrfToken};}
before(async()=>{
  fixture=await localDatabase();const hash=await hashPassword(secret);
  await fixture.pool.query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'admin@admin.test',$3,'admin'),($2,'teacher@admin.test',$3,'teacher')",[ids.admin,ids.teacher,hash]);
  root=await mkdtemp(join(tmpdir(),'presence-admin-'));store=createRecordingStore({root});
  server=createApp({pool:fixture.pool,publicOrigin:origin,recordingStore:store,faceWorker:{close(){}}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(39113,'127.0.0.1',resolve);});
  admin=await login('admin@admin.test');teacher=await login('teacher@admin.test');
},{timeout:30000});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await fixture?.engine.close();if(root)await rm(root,{recursive:true,force:true});});

test('admin routes preserve authentication, Origin, CSRF and strict query/identity boundaries',async()=>{
  assert.equal((await call('/api/admin/students',{actor:null})).status,401);
  assert.equal((await call('/api/admin/students',{actor:teacher})).status,403);
  assert.equal((await call('/api/admin/students',{body:{person_code:'X',full_name:'X'},headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await call('/api/admin/students',{body:{person_code:'X',full_name:'X'},headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await call('/api/admin/students',{body:{person_code:'X',full_name:'X',actor_user_id:ids.teacher}})).status,400);
  assert.equal((await call('/api/admin/students?wrong=1')).status,400);
  assert.equal((await call('/api/admin/students?limit=201')).status,400);
  assert.equal((await call('/api/admin/students?q=x&q=y')).status,400);
  assert.equal((await call('/api/groups?q=x')).status,400);
});
test('student login creation, duplicate conflicts, updates and inactive account state are atomic',async()=>{
  const result=await call('/api/admin/students',{body:{person_code:'ADM-STU',full_name:'=Student formula',email:'student@admin.test',password:secret}});assert.equal(result.status,200);student=result.body.student;
  assert.equal((await call('/api/admin/students',{body:{person_code:'ADM-STU',full_name:'Duplicate'}})).status,409);
  const countBefore=(await fixture.pool.query('SELECT count(*)::int AS n FROM attendance.people')).rows[0].n;
  assert.equal((await call('/api/admin/students',{body:{person_code:'ROLLBACK',full_name:'Rollback',email:'student@admin.test',password:secret}})).status,409);
  assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM attendance.people')).rows[0].n,countBefore);
  const filtered=await call('/api/admin/students?q=ADM-STU&active=true&limit=1');assert.equal(filtered.body.total,1);assert.equal(filtered.body.students[0].id,student.id);
  const account=await login('student@admin.test');assert.equal((await call(`/api/admin/students/${student.id}`,{body:{is_active:false}})).status,200);
  assert.equal((await call('/api/me',{actor:account})).status,401);
  assert.equal((await fixture.pool.query('SELECT is_active FROM attendance.users WHERE person_id=$1',[student.id])).rows[0].is_active,false);
  assert.equal((await call(`/api/admin/students/${student.id}`,{body:{is_active:true}})).status,200);
  assert.equal((await login('student@admin.test')).csrfToken.length,64);
  assert.equal((await call('/api/admin/students?active=false')).body.total,0);
});
test('persisted defaults apply to courses and sessions; membership periods and assignments preserve history',async()=>{
  const saved=await call('/api/admin/settings',{body:{default_allowed_absences:3,default_late_after_minutes:22,default_time_zone:'America/New_York',recording_retention_days:14,recording_max_mb:4,recording_storage_max_mb:12}});assert.equal(saved.status,200);
  assert.equal(saved.body.storage.limit_bytes,12*1048576);
  const result=await call('/api/admin/courses',{body:{code:'ADM-COURSE',name:'Admin Course',course_code:'ADM',term_name:'Test',term_starts_on:'2020-01-01',term_ends_on:'2030-01-01'}});assert.equal(result.status,200);course=result.body.course;assert.equal(course.allowed_absences,3);assert.equal(course.time_zone,'America/New_York');
  assert.equal((await call(`/api/admin/students/${student.id}/memberships`,{body:{group_id:course.id,action:'join'}})).status,200);
  assert.equal((await call(`/api/admin/students/${student.id}/memberships`,{body:{group_id:course.id,action:'join'}})).status,409);
  assert.equal((await call(`/api/admin/courses/${course.id}/staff`,{body:{user_id:ids.teacher,action:'assign'}})).body.staff.length,1);
  const planned=await call(`/api/groups/${course.id}/sessions`,{body:{startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()}});assert.equal(planned.status,200);session=planned.body.session;assert.equal(session.late_after_minutes,22);
  assert.equal((await call(`/api/sessions/${session.id}/open`,{body:{}})).status,200);
  assert.equal((await call(`/api/admin/students/${student.id}/memberships`,{body:{group_id:course.id,action:'leave'}})).status,200);
  const detail=await call(`/api/admin/students/${student.id}`);assert.ok(detail.body.memberships[0].left_at);assert.equal(detail.body.history.length,1);
  assert.equal((await call('/api/admin/students?group_id='+course.id)).body.total,0);
  assert.equal((await call(`/api/admin/courses/${course.id}/staff`,{body:{user_id:ids.teacher,action:'remove'}})).body.staff.length,0);
  assert.equal((await call(`/api/groups/${course.id}/roster`,{actor:teacher})).status,403);
});
test('attendance correction validates window and reason and writes immutable audit/event rows',async()=>{
  assert.equal((await call(`/api/sessions/${session.id}/close`,{body:{}})).status,200);
  const detail=await call(`/api/admin/sessions/${session.id}`);assert.equal(detail.body.records.length,1);record=detail.body.records[0];assert.equal(record.status,'absent');
  assert.equal((await call(`/api/admin/attendance/${record.id}/correction`,{body:{status:'present',reason:' ',checkedInAt:session.opened_at}})).status,400);
  assert.equal((await call(`/api/admin/attendance/${record.id}/correction`,{body:{status:'present',reason:'Outside window',checkedInAt:'2020-01-01T00:00:00Z'}})).status,409);
  const at=new Date(detail.body.session.opened_at).toISOString();
  const corrected=await call(`/api/admin/attendance/${record.id}/correction`,{body:{status:'present',reason:'Verified attendance',checkedInAt:at}});assert.equal(corrected.status,200);assert.equal(corrected.body.record.status,'present');
  assert.equal((await call('/api/admin/attendance?group_id='+course.id+'&person_id='+student.id+'&status=present')).body.total,1);
  const audits=await call('/api/admin/audit?action=attendance_corrected');assert.equal(audits.body.logs[0].reason,'Verified attendance');assert.equal(audits.body.logs[0].before_value.status,'absent');
  const events=(await fixture.pool.query('SELECT count(*)::int AS n FROM attendance.attendance_events WHERE record_id=$1',[record.id])).rows[0].n;assert.ok(events>=3);
  await assert.rejects(fixture.pool.query('DELETE FROM attendance.audit_logs'),/append-only/);
  assert.equal((await call(`/api/admin/students/${student.id}`,{body:{is_active:false}})).status,200);
  assert.equal((await call(`/api/admin/students/${student.id}`)).body.history.length,1);
});
test('dashboard computes real closed-past rates, course totals, storage and timezone-aware today counts',async()=>{
  const dashboard=await call('/api/admin/dashboard');assert.equal(dashboard.status,200);assert.equal(dashboard.body.attendance.total,1);assert.equal(dashboard.body.attendance.attendance_rate,100);
  assert.equal(dashboard.body.counts.closed_sessions,1);assert.equal(dashboard.body.courses[0].total,1);assert.equal(dashboard.body.storage.limit_bytes,12*1048576);assert.equal(typeof dashboard.body.counts.today_closed_sessions,'number');
  assert.equal((await call('/api/admin/sessions?group_id='+course.id+'&status=closed')).body.sessions[0].present,1);
  const empty=await call('/api/admin/sessions?from=2030-01-01&to=2030-01-02');assert.equal(empty.body.total,0);
});
test('staff role/activation edits protect last admin and revoke existing sessions without leaking passwords',async()=>{
  const last=await call(`/api/admin/staff/${ids.admin}`,{body:{role:'teacher'}});assert.equal(last.status,409);assert.equal(last.body.error.code,'last_admin');
  const created=await call('/api/admin/staff',{body:{email:'second@admin.test',password:secret,role:'admin',full_name:'Second Admin'}});assert.equal(created.status,200);assert.equal(created.body.staff.password_hash,undefined);
  const second=created.body.staff;
  assert.equal((await call('/api/admin/students')).body.students.some(row=>row.id===second.person_id),false);
  assert.equal((await call(`/api/admin/staff/${second.id}`,{body:{full_name:'Renamed Admin'}})).status,200);
  const audit=(await call('/api/admin/audit?action=staff_updated')).body.logs[0];assert.equal(audit.before_value.full_name,'Second Admin');assert.equal(audit.after_value.full_name,'Renamed Admin');
  const secondActor=await login('second@admin.test');assert.equal((await call(`/api/admin/staff/${second.id}`,{body:{role:'teacher'}})).status,200);
  assert.equal((await call('/api/me',{actor:secondActor})).status,401);
  assert.equal((await call(`/api/admin/staff/${second.id}`,{body:{is_active:false}})).status,200);
  assert.equal((await call('/api/admin/staff?active=false&role=teacher')).body.total,1);
  assert.equal(JSON.stringify((await call('/api/admin/audit')).body).includes('password_hash'),false);
  await assert.rejects(fixture.pool.query("UPDATE attendance.users SET is_active=false WHERE id=$1",[ids.admin]),/last active administrator/);
});
test('CSV uses real filtered rows and neutralizes spreadsheet formulas without exposing credentials',async()=>{
  const csv=await call('/api/admin/export?type=students&q=ADM-STU',{raw:true});assert.equal(csv.status,200);assert.match(csv.type,/text\/csv/);assert.match(csv.body,/'=Student formula/);assert.doesNotMatch(csv.body,/password_hash|csrf_token/);
  const staffCsv=await call('/api/admin/export?type=staff',{raw:true});assert.equal(staffCsv.status,200);assert.doesNotMatch(staffCsv.body,/password_hash|scrypt/);
  assert.equal((await call('/api/admin/export?type=invalid')).status,400);
});
test('settings control new recording retention and limits; existing manifests keep original policy',async()=>{
  const created=await call(`/api/groups/${course.id}/recordings`,{body:{mimeType:'video/webm',startedAt:new Date().toISOString()}});assert.equal(created.status,200);
  const video=created.body.recording;assert.equal(Math.round((Date.parse(video.expiresAt)-Date.now())/86400000),14);
  const manifest=JSON.parse(await readFile(join(root,video.id,'manifest.json'),'utf8'));assert.equal(manifest.maxBytes,4*1048576);
  await call('/api/admin/settings',{body:{recording_retention_days:1,recording_max_mb:1,recording_storage_max_mb:1}});
  const next=await call(`/api/groups/${course.id}/recordings`,{body:{mimeType:'video/webm',startedAt:new Date().toISOString()}});assert.equal(next.status,200);
  await assert.rejects(store.putChunk(next.body.recording.id,0,Buffer.alloc(1048576)),/storage limit/);
  assert.equal((await store.get(video.id)).expiresAt,video.expiresAt);
  assert.equal((await call('/api/admin/settings',{body:{storage_mode:'cloud'}})).status,400);
  const before=await call('/api/admin/settings');assert.equal((await call('/api/admin/settings',{body:{default_time_zone:'Unknown/Zone'}})).status,400);
  assert.equal((await call('/api/admin/settings')).body.settings.default_time_zone,before.body.settings.default_time_zone);
});
test('additive migration can rerun without losing settings or historical data',async()=>{
  const settingsBefore=(await call('/api/admin/settings')).body.settings;
  await fixture.pool.query(await readFile(new URL('../db/migrations/009_admin_management.sql',import.meta.url),'utf8'));
  assert.equal((await call('/api/admin/settings')).body.settings.recording_retention_days,settingsBefore.recording_retention_days);
  assert.equal((await call(`/api/admin/students/${student.id}`)).body.history.length,1);
});
