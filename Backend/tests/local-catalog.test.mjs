import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {localDatabase} from './local-fixture.mjs';
import {seedDemo,demo} from '../scripts/seed-demo.mjs';
import {seedLocalCatalog,loadLocalCatalog,localCatalogId} from '../scripts/seed-local-catalog.mjs';
import {transaction} from '../src/database.mjs';
import {createApp} from '../src/server.mjs';
import {opaqueToken,tokenDigest} from '../src/auth.mjs';
import {importTeamReferences,teamReferences} from '../scripts/import-team-references.mjs';

function teamManifest() {
  return {sourceCommit:'a'.repeat(40),references:teamReferences.members.map((member,i)=>{
    const bytes=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(100,i),Buffer.from([255,217])]);
    return {key:member.key,name:member.name,sourcePath:member.sourcePath,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  })};
}

test('existing team joins all ten courses with reusable references and fresh snapshots while preserving history',async()=>{
  const fixture=await localDatabase();let server;
  try {
    await transaction(fixture.pool,db=>seedDemo(db,'Catalog-test-password-2026'));
    const catalog=await loadLocalCatalog(),now=new Date();
    const old=await transaction(fixture.pool,db=>seedLocalCatalog(db,{localOnly:true,catalog,now}));
    await fixture.db.query('SELECT attendance.record_check_in($1,$2,$3)',[old.sessions[0].sessionId,localCatalogId('person',catalog.students[0].id),demo.teacherId]);
    await fixture.db.query('SELECT attendance.close_session($1,$2)',[old.sessions[0].sessionId,demo.teacherId]);
    const oldRecords=(await fixture.db.query('SELECT * FROM attendance.attendance_records ORDER BY id')).rows;
    const oldEvents=(await fixture.db.query('SELECT * FROM attendance.attendance_events ORDER BY event_id')).rows;
    await importTeamReferences(fixture.pool,teamManifest());
    const source=(await fixture.db.query(`SELECT row_to_json(r) AS row FROM attendance.team_face_references r ORDER BY reference_key`)).rows;
    const sourceMemberships=(await fixture.db.query('SELECT * FROM attendance.group_memberships WHERE group_id=$1 ORDER BY id',[teamReferences.groupId])).rows;
    const result=await transaction(fixture.pool,db=>seedLocalCatalog(db,{localOnly:true,catalog,now}));
    assert.equal(result.students,34);assert.equal(result.sampleStudents,30);assert.equal(result.teamStudents,4);assert.equal(result.memberships,340);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.people WHERE person_code LIKE $1',['PRESENCE-TEAM-%'])).rows[0].n,4);
    assert.equal((await fixture.db.query(`SELECT count(*)::int AS n FROM attendance.face_enrollments f JOIN attendance.people p ON p.id=f.person_id
      WHERE p.person_code LIKE 'STU-%' OR p.person_code LIKE 'PRESENCE-TEAM-%'`)).rows[0].n,0);
    const calls=[],token=opaqueToken(),csrf=opaqueToken();
    await fixture.db.query("INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tokenDigest(token),demo.teacherId,csrf]);
    server=createApp({pool:fixture.pool,publicOrigin:'http://127.0.0.1',faceWorker:{async request(call){calls.push(call);return {matches:[]};},close(){}}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    for(const course of result.sessions) {
      assert.notEqual(course.sessionId,old.sessions.find(row=>row.courseId===course.courseId).sessionId);
      const roster=(await fixture.db.query(`SELECT p.id,p.person_code,p.full_name FROM attendance.group_memberships m JOIN attendance.people p ON p.id=m.person_id WHERE m.group_id=$1 AND m.left_at IS NULL`,[course.groupId])).rows;
      assert.equal(roster.length,34);
      for(const member of teamReferences.members) assert.equal(roster.find(row=>row.id===member.personId).full_name,member.name);
      assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.attendance_records WHERE session_id=$1',[course.sessionId])).rows[0].n,34);
      const response=await fetch(origin+`/api/groups/${course.groupId}/faces/detect`,{method:'POST',headers:{Cookie:`presence_session=${token}`,Origin:'http://127.0.0.1','Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({image:'eA=='})});
      assert.equal(response.status,200);
      assert.equal(calls.at(-1).allowedIds.length,34);
      assert.deepEqual(calls.at(-1).referenceMappings,[...teamReferences.members].sort((a,b)=>a.key.localeCompare(b.key)).map(member=>({referenceKey:member.key,personId:member.personId})));
    }
    for(const record of oldRecords) assert.deepEqual((await fixture.db.query('SELECT * FROM attendance.attendance_records WHERE id=$1',[record.id])).rows[0],record);
    for(const event of oldEvents) assert.deepEqual((await fixture.db.query('SELECT * FROM attendance.attendance_events WHERE event_id=$1',[event.event_id])).rows[0],event);
    assert.deepEqual((await fixture.db.query(`SELECT row_to_json(r) AS row FROM attendance.team_face_references r ORDER BY reference_key`)).rows,source);
    assert.deepEqual((await fixture.db.query('SELECT * FROM attendance.group_memberships WHERE group_id=$1 ORDER BY id',[teamReferences.groupId])).rows,sourceMemberships);
    const allRecords=(await fixture.db.query('SELECT * FROM attendance.attendance_records ORDER BY id')).rows;
    await transaction(fixture.pool,db=>seedLocalCatalog(db,{localOnly:true,catalog,now}));
    assert.deepEqual((await fixture.db.query('SELECT * FROM attendance.attendance_records ORDER BY id')).rows,allRecords);
  } finally {if(server) await new Promise(resolve=>server.close(resolve));await fixture.engine.close();}
});

test('all fictional courses have thirty selectable students; startup preserves unrelated data and attendance',async()=>{
  const fixture=await localDatabase(); let server;
  try {
    await transaction(fixture.pool,db=>seedDemo(db,'Catalog-test-password-2026'));
    const catalog=await loadLocalCatalog(),now=new Date();
    const previous=(await fixture.db.query('SELECT id,password_hash FROM attendance.users ORDER BY id')).rows;
    const otherTeacher=randomUUID();
    await fixture.db.query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'unassigned@catalog.test','existing','teacher')",[otherTeacher]);
    const result=await transaction(fixture.pool,db=>seedLocalCatalog(db,{localOnly:true,catalog,now}));
    assert.equal(result.memberships,300);
    assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM attendance.group_memberships m JOIN attendance.groups g ON g.id=m.group_id WHERE g.code LIKE 'CLS-%' AND m.left_at IS NULL")).rows[0].n,300);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.face_enrollments f JOIN attendance.people p ON p.id=f.person_id WHERE p.person_code LIKE \'STU-%\'')).rows[0].n,0);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.people')).rows[0].n,38);
    for (const user of previous) assert.deepEqual((await fixture.db.query('SELECT id,password_hash FROM attendance.users WHERE id=$1',[user.id])).rows[0],user);
    const token=opaqueToken(),csrf=opaqueToken(),otherToken=opaqueToken();
    await fixture.db.query("INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$3,now()+interval '1 hour')",[tokenDigest(token),demo.teacherId,csrf,tokenDigest(otherToken),otherTeacher]);
    server=createApp({pool:fixture.pool,publicOrigin:'http://127.0.0.1',faceWorker:{close(){}}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    async function request(path,{body,actor=token}={}) {
      const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Cookie:`presence_session=${actor}`,...(body===undefined?{}:{Origin:'http://127.0.0.1','Content-Type':'application/json','X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,body:await response.json()};
    }
    const groups=await request('/api/groups'); assert.equal(groups.status,200);
    const assigned=groups.body.groups.filter(group=>catalog.courses.some(course=>course.id===group.code));
    assert.equal(assigned.length,10); assert.ok(groups.body.groups.some(group=>group.id===demo.groupId));
    assert.deepEqual((await request('/api/groups',{actor:otherToken})).body.groups,[]);
    for (const course of catalog.courses) {
      const group=assigned.find(row=>row.code===course.id);
      assert.equal(group.name,course.name); assert.equal(group.course_code,course.code);
      const roster=await request(`/api/groups/${group.id}/roster`); assert.equal(roster.status,200);
      assert.deepEqual(roster.body.roster.map(row=>row.person_code).sort(),catalog.students.map(row=>row.id).sort());
      for (const student of catalog.students) assert.equal(roster.body.roster.find(row=>row.person_code===student.id).full_name,student.name);
      const sessions=await request(`/api/groups/${group.id}/sessions`); assert.equal(sessions.status,200);
      assert.equal(sessions.body.sessions.length,1); assert.equal(sessions.body.sessions[0].status,'open');
      const dashboard=await request(`/api/sessions/${sessions.body.sessions[0].id}/dashboard`);
      assert.equal(dashboard.status,200); assert.equal(dashboard.body.distribution.total,30); assert.equal(dashboard.body.distribution.pending,30);
      assert.equal((await request(`/api/groups/${group.id}/roster`,{actor:otherToken})).status,403);
    }
    const first=result.sessions[0],studentId=localCatalogId('person',catalog.students[0].id);
    const checkin=await request(`/api/sessions/${first.sessionId}/checkins`,{body:{personId:studentId,source:'teacher'}});
    assert.equal(checkin.status,200);
    assert.equal((await request(`/api/sessions/${first.sessionId}/close`,{body:{}})).status,200);
    const before=(await fixture.db.query('SELECT * FROM attendance.attendance_records ORDER BY id')).rows;
    const events=(await fixture.db.query('SELECT count(*)::int AS n FROM attendance.attendance_events')).rows[0].n;
    await transaction(fixture.pool,db=>seedLocalCatalog(db,{localOnly:true,catalog,now}));
    assert.deepEqual((await fixture.db.query('SELECT * FROM attendance.attendance_records ORDER BY id')).rows,before);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.attendance_events')).rows[0].n,events);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.attendance_sessions')).rows[0].n,17);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.group_memberships')).rows[0].n,308);
    assert.equal((await fixture.db.query('SELECT status FROM attendance.attendance_sessions WHERE id=$1',[first.sessionId])).rows[0].status,'closed');
  } finally {if(server) await new Promise(resolve=>server.close(resolve));await fixture.engine.close();}
});

test('local catalog collision rolls back the entire additive seed',async()=>{
  const fixture=await localDatabase();
  try {
    await transaction(fixture.pool,db=>seedDemo(db,'Catalog-test-password-2026'));
    const catalog=await loadLocalCatalog(),collision=randomUUID();
    await fixture.db.query("INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on) VALUES($1,$2,'Existing real course','REAL','Existing term',current_date-1,current_date+1)",[collision,catalog.courses.at(-1).id]);
    await assert.rejects(transaction(fixture.pool,db=>seedLocalCatalog(db,{localOnly:true,catalog})),/group scope is already occupied/);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.people')).rows[0].n,8);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.group_memberships')).rows[0].n,8);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attendance.attendance_sessions')).rows[0].n,7);
    assert.equal((await fixture.db.query('SELECT name FROM attendance.groups WHERE id=$1',[collision])).rows[0].name,'Existing real course');
  } finally {await fixture.engine.close();}
});

test('catalog seed requires explicit local opt-in and validated fixture identities',async()=>{
  const db={query(){throw new Error('Unexpected database write');}};
  await assert.rejects(seedLocalCatalog(db),/restricted to the local demo/);
  const catalog=await loadLocalCatalog();
  await assert.rejects(seedLocalCatalog(db,{localOnly:true,catalog:{...catalog,test_only:false}}),/ten courses and thirty students/);
  await assert.rejects(seedLocalCatalog(db,{localOnly:true,catalog:{...catalog,students:catalog.students.map((row,index)=>index===1?catalog.students[0]:row)}}),/identities are invalid/);
});
