import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDatabase} from './local-fixture.mjs';
import {createAttendanceExport} from '../src/attendance-analytics.mjs';
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
