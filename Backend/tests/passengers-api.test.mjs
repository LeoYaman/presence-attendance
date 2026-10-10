import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/server.mjs';
import {passengerGroupId} from '../src/passengers.mjs';
import {importTeamReferences,teamReferences} from '../scripts/import-team-references.mjs';

const passengers=[
  {person_id:'f3102026-0000-4000-8000-000000000101',name:'Leo',reference_key:'team_leo'},
  {person_id:'f3102026-0000-4000-8000-000000000102',name:'Rebbeca',reference_key:'team_rebbeca'},
  {person_id:'f3102026-0000-4000-8000-000000000103',name:'Olivia',reference_key:'team_olivia'}
];
test('passenger API protects scoped identity matching and never writes attendance or alerts',async()=>{
  const csrf='a'.repeat(64), image=Buffer.from([255,216,255,0,255,217]).toString('base64');
  let role='teacher', manager=true, rows=passengers, failure=null, requests=[];
  const queries=[];
  const query=async(sql,params)=>{
    queries.push(sql);
    if(sql.includes('attendance.auth_sessions'))return {rows:[{id:'actor',role,csrf_token:csrf}]};
    if(sql.includes('require_group_manager')){
      assert.deepEqual(params,['actor',passengerGroupId]);
      if(!manager)throw Object.assign(new Error('forbidden'),{code:'42501'});
    }
    if(sql.includes('FROM demo.passengers'))return {rows};
    return {rows:[]};
  };
  const box={x:0.1,y:0.2,width:0.2,height:0.3};
  const faceWorker={close(){},async request(payload){
    requests.push(payload); if(failure)throw failure;
    return {registeredReferences:3,matches:[
      {studentId:passengers[0].person_id,referenceKey:'team_leo',identityMatched:true,similarity:0.9,box,criminalStatus:'unsafe'},
      {studentId:passengers[1].person_id,referenceKey:'team_rebbeca',identityMatched:true,similarity:0.85,box},
      {studentId:passengers[2].person_id,referenceKey:'team_olivia',identityMatched:true,similarity:0.7,box,bookingStatus:'unsafe'},
      {studentId:'f3102026-0000-4000-8000-000000000100',referenceKey:'team_anthony',identityMatched:true,similarity:0.7,box},
      {studentId:passengers[0].person_id,referenceKey:'team_anthony',identityMatched:true,box}
    ]};
  }};
  const server=createApp({pool:{query,connect:async()=>({query,release(){}})},publicOrigin:'http://localhost',faceWorker,recordingStore:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers={Cookie:'presence_session='+'b'.repeat(64),'X-CSRF-Token':csrf,Origin:'http://localhost','Content-Type':'application/json'};
  const call=(path,body,extra={})=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    assert.equal((await call('/api/passengers',undefined,{Cookie:''})).status,401);
    role='student';assert.equal((await call('/api/passengers')).status,403);role='teacher';
    manager=false;assert.equal((await call('/api/passengers')).status,403);manager=true;
    const roster=await (await call('/api/passengers')).json();
    assert.deepEqual(roster,{groupId:passengerGroupId,passengers:passengers.map(p=>({id:p.person_id,name:p.name,role:'passenger'}))});
    assert.equal((await call('/api/passengers/detect',{image},{Origin:'https://bad.test'})).status,403);
    assert.equal((await call('/api/passengers/detect',{image},{'X-CSRF-Token':''})).status,403);
    assert.equal((await call('/api/passengers/detect',{image,groupId:passengerGroupId})).status,400);
    assert.equal((await call('/api/passengers/detect',{image:'a'.repeat(350001)})).status,400);
    assert.equal((await call('/api/passengers/detect',{image:'a'.repeat(400001)})).status,413);
    assert.equal((await call('/api/passengers/detect',{image:'data:image/jpeg;base64,'+image})).status,400);
    assert.equal((await call('/api/passengers/detect',{image:'YWJj'})).status,400);
    manager=false;assert.equal((await call('/api/passengers/detect',{image})).status,403);manager=true;
    assert.equal(requests.length,0);
    const result=await (await call('/api/passengers/detect',{image})).json();
    assert.equal(result.registeredReferences,3);
    assert.deepEqual(result.matches.slice(0,3).map(p=>[p.name,p.role,p.identityMatched]),[['Leo','passenger',true],['Rebbeca','passenger',true],['Olivia','passenger',true]]);
    for(const match of result.matches.slice(3)){assert.equal(match.passengerId,null);assert.equal(match.name,null);assert.equal(match.identityMatched,false);}
    assert.equal(JSON.stringify(result).includes('criminal'),false);
    assert.equal(JSON.stringify(result).includes('booking'),false);
    assert.deepEqual(requests[0],{action:'detect',groupId:passengerGroupId,image,allowedIds:passengers.map(p=>p.person_id),referenceMappings:passengers.map(p=>({referenceKey:p.reference_key,personId:p.person_id}))});
    failure=Object.assign(new Error('Worker unavailable'),{status:503,code:'face_service_unavailable'});
    assert.equal((await call('/api/passengers/detect',{image})).status,503);
    failure=null;rows=[];
    assert.equal((await call('/api/passengers/detect',{image})).status,503);
    assert.equal(requests.length,2);
    assert.equal(queries.some(sql=>/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)),false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('passenger migrations seed only existing active canonical references',async()=>{
  const db=new PGlite();
  try{
    for(const name of ['001_initial_schema.sql','007_team_face_references.sql'])
      await db.exec(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    const migration=await readFile(new URL('../db/migrations/011_demo_passengers.sql',import.meta.url),'utf8');
    await db.exec(migration);
    assert.deepEqual((await db.query('SELECT * FROM demo.passengers')).rows,[]);
    await db.query(`INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'teacher@presence-demo.test','test teacher','teacher')`,[teamReferences.teacherId]);
    const {createHash}=await import('node:crypto');
    await importTeamReferences(db,{sourceCommit:'a'.repeat(40),references:teamReferences.members.map((member,i)=>{
      const bytes=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(100,i),Buffer.from([255,217])]);
      return {key:member.key,name:member.name,sourcePath:member.sourcePath,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
    })});
    const seed=migration.slice(migration.indexOf('INSERT INTO demo.passengers'));
    await db.query("UPDATE attendance.team_face_references SET is_active=false WHERE reference_key='team_rebbeca'");
    await db.exec(seed);
    assert.deepEqual((await db.query('SELECT person_id,name,reference_key FROM demo.passengers ORDER BY name')).rows,[passengers[0]]);
    await db.query("UPDATE attendance.team_face_references SET is_active=true WHERE reference_key='team_rebbeca'");
    await db.exec(seed);
    assert.deepEqual((await db.query('SELECT person_id,name,reference_key FROM demo.passengers ORDER BY name')).rows,passengers.slice(0,2));
    await assert.rejects(db.query(`INSERT INTO demo.passengers(person_id,name,reference_key) VALUES($1,'Olivia','team_olivia')`,[teamReferences.members.find(p=>p.key==='team_olivia').personId]),error=>error.code==='23514');
    const oliviaMigration=await readFile(new URL('../db/migrations/012_demo_olivia_passenger.sql',import.meta.url),'utf8');
    await db.query("UPDATE attendance.team_face_references SET is_active=false WHERE reference_key='team_olivia'");
    await db.exec(oliviaMigration);
    assert.deepEqual((await db.query('SELECT person_id,name,reference_key FROM demo.passengers ORDER BY name')).rows,passengers.slice(0,2));
    await db.query("UPDATE attendance.team_face_references SET is_active=true WHERE reference_key='team_olivia'");
    await db.exec(oliviaMigration.slice(oliviaMigration.indexOf('INSERT INTO demo.passengers')));
    assert.deepEqual((await db.query('SELECT person_id,name,reference_key FROM demo.passengers ORDER BY name')).rows,[passengers[0],passengers[2],passengers[1]]);
    await assert.rejects(db.query(`INSERT INTO demo.passengers(person_id,name,reference_key) VALUES($1,'Anthony','team_anthony')`,[teamReferences.members.find(p=>p.key==='team_anthony').personId]),error=>error.code==='23514');
  }finally{await db.close();}
});
