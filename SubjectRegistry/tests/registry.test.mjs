import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openRegistryDatabase,transaction} from '../src/database.mjs';
import {createRegistryServer} from '../src/server.mjs';
import {createSubjectsApi,provisionSubjectKey,provisionReaderKey,revokeSubjectKey,setSubjectSourceActive,seedOlivia,digest} from '../src/subjects.mjs';
import {loadLocalConfiguration,registryConfiguration} from '../src/config.mjs';
const jpeg=await readFile(new URL('../../face_data/people_faces/WIN_20261010_00_51_21_Pro.jpg',import.meta.url));
const image=jpeg.toString('base64');
const worker={async request(request){if(request.action==='validate-reference')return {valid:true};return {registeredReferences:request.subjectReferences.length,matches:request.allowedIds.map(subjectId=>({subjectId,identityMatched:true,box:{x:0.1,y:0.1,width:0.2,height:0.2},similarity:0.9}))};}};

test('persistent physical registry: HTTP privileges, source isolation, deletion and immutable snapshots',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'registry-persistent-'));let local,server;
 try{
  local=await openRegistryDatabase(dir);const pool=local.pool;
  await assert.rejects(openRegistryDatabase(dir),/already open/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name='attendance'")).rows[0].n,0);
  const config=await loadLocalConfiguration(pool,join(dir,'service-config.json'));
  assert.deepEqual(await loadLocalConfiguration(pool,join(dir,'service-config.json')),config);
  const other=await provisionSubjectKey(pool,{name:'other',apps:['subject-finder']});
  const scopedReader=await provisionReaderKey(pool,{apps:['subject-finder']});
  server=createRegistryServer({pool,faceWorker:worker});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  async function call(key,path,method='GET',body){const response=await fetch(origin+path,{method,headers:{'x-api-key':key,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
  assert.equal((await call(config.writeKey,'/api/subjects?app=subject-finder')).status,401);
  assert.equal((await call(config.readerKey,'/api/subjects/external/forbidden','PUT',{name:'Forbidden'})).status,401);
  assert.equal((await call(scopedReader.key,'/api/subjects?app=attendance')).status,403);
  assert.equal((await call(other.key,'/api/subjects/external/escape','PUT',{name:'Escape',apps:['attendance']})).status,403);
  const id=randomUUID();await seedOlivia(pool,{faceWorker:worker,image,subjectId:id,writeKey:config.writeKey});
  assert.equal((await call(config.readerKey,'/api/subjects?app=subject-finder')).body.subjects[0].id,id);
  assert.equal((await call(config.readerKey,'/api/subjects/detect','POST',{app:'subject-finder',image})).body.matches[0].message,'Got you, Olivia');
  const before=(await pool.query('SELECT count(*)::int AS n FROM registry.subjects')).rows[0].n;
  assert.equal((await call(config.writeKey,'/api/subjects/external/broken','PUT',{name:'Broken',image:Buffer.from('not a jpeg').toString('base64')})).status,400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM registry.subjects')).rows[0].n,before);
  assert.equal((await call(other.key,'/api/subjects/external/team_olivia','DELETE')).status,404);
  const removed=await call(config.writeKey,'/api/subjects/external/team_olivia','DELETE');assert.equal(removed.status,200);assert.equal(removed.body.deleted,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM registry.subjects')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM registry.face_references')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM registry.app_access')).rows[0].n,0);
  assert.equal((await pool.query("SELECT snapshot->>'name' AS name FROM registry.audit WHERE action='delete'")).rows[0].name,'Olivia');
  await assert.rejects(pool.query("DELETE FROM registry.audit WHERE action='delete'"),/append.only/);
  await new Promise(resolve=>server.close(resolve));server=null;await pool.end();local=null;
  local=await openRegistryDatabase(dir);assert.equal((await local.pool.query("SELECT count(*)::int AS n FROM registry.audit WHERE action='delete'")).rows[0].n,1);
  assert.deepEqual(await loadLocalConfiguration(local.pool,join(dir,'service-config.json')),config);
  assert.equal((await local.pool.query('SELECT count(*)::int AS n FROM registry.subjects')).rows[0].n,0);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await local?.pool.end();await rm(dir,{recursive:true,force:true});}
});

test('catalog change rejects stale matches; validation races recheck scoped and revoked writer keys',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'registry-races-'));let local;
 try{
  local=await openRegistryDatabase(dir);const {pool}=local;
  const writer=await provisionSubjectKey(pool,{name:'race',apps:['subject-finder','attendance']});const reader=await provisionReaderKey(pool);
  const api=createSubjectsApi({pool,faceWorker:worker});await api.external({key:writer.key,method:'PUT',externalId:'identity',body:{name:'Known',apps:['subject-finder'],image}});
  let started,finish;const entered=new Promise(r=>started=r),wait=new Promise(r=>finish=r);
  const delayed=createSubjectsApi({pool,faceWorker:{async request(request){started();await wait;return worker.request(request);}}});
  const detection=delayed.detect({key:reader.key,body:{app:'subject-finder',image}});await entered;
  const version=(await api.list({key:reader.key,app:'subject-finder'})).version;
  await provisionSubjectKey(pool,{name:'race',apps:['attendance']});finish();
  const result=await detection;assert.ok(result.version>version);assert.equal(result.matches[0].identityMatched,false);assert.equal(result.matches[0].subjectId,null);
  await provisionSubjectKey(pool,{name:'race',apps:['subject-finder','attendance']});
  let validated,continueUpload;const validationEntered=new Promise(r=>validated=r),validationWait=new Promise(r=>continueUpload=r);
  const validationApi=createSubjectsApi({pool,faceWorker:{async request(request){validated();await validationWait;return worker.request(request);}}});
  const write=validationApi.external({key:writer.key,method:'PUT',externalId:'denied',body:{name:'Denied',apps:['attendance'],image}});await validationEntered;
  await provisionSubjectKey(pool,{name:'race',apps:['subject-finder']});continueUpload();await assert.rejects(write,e=>e.code==='app_scope_denied');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM registry.subjects WHERE external_id='denied'")).rows[0].n,0);
  let validating,complete;const revocationEntered=new Promise(r=>validating=r),revocationWait=new Promise(r=>complete=r);
  const revocationApi=createSubjectsApi({pool,faceWorker:{async request(request){validating();await revocationWait;return worker.request(request);}}});
  const revokedWrite=revocationApi.external({key:writer.key,method:'PUT',externalId:'revoked',body:{name:'Revoked',image}});await revocationEntered;
  await revokeSubjectKey(pool,writer.key);complete();await assert.rejects(revokedWrite,e=>e.code==='invalid_api_key');
  const pinned=createSubjectsApi({pool,faceWorker:worker,readerKeyHash:digest(reader.key)});
  await revokeSubjectKey(pool,reader.key);await assert.rejects(api.list({key:reader.key,app:'subject-finder'}),e=>e.code==='invalid_api_key');
  await assert.rejects(pinned.list({key:reader.key,app:'subject-finder'}),e=>e.code==='invalid_api_key');
 }finally{await local?.pool.end();await rm(dir,{recursive:true,force:true});}
});

test('global capacity rollback, transaction serialization and revoked source reactivation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'registry-capacity-'));let local;
 try{
  local=await openRegistryDatabase(dir);const {pool}=local;
  const writer=await provisionSubjectKey(pool,{name:'capacity',apps:['subject-finder']});const reader=await provisionReaderKey(pool);const api=createSubjectsApi({pool,faceWorker:worker});
  const created=await api.external({key:writer.key,method:'PUT',externalId:'fixture',body:{name:'Capacity fixture',apps:['subject-finder']}});
  // Test-only gallery fixture reaches the worker contract's count boundary in one transaction.
  await transaction(pool,db=>db.query("INSERT INTO registry.face_references(subject_id,image_sha256,image_bytes) SELECT $1,lpad(to_hex(n),64,'0'),$2 FROM generate_series(1,100) n",[created.subject.id,jpeg]));
  const prior=(await api.list({key:reader.key,app:'subject-finder'})).version;
  await assert.rejects(api.external({key:writer.key,method:'POST',references:true,externalId:'fixture',body:{image}}),e=>e.code==='reference_capacity');
  assert.equal((await api.list({key:reader.key,app:'subject-finder'})).version,prior);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM registry.face_references')).rows[0].n,100);
  await setSubjectSourceActive(pool,writer.sourceId,false);
  const other=await provisionSubjectKey(pool,{name:'other-capacity',apps:['subject-finder']});
  await api.external({key:other.key,method:'PUT',externalId:'other',body:{name:'Other',apps:['subject-finder'],image}});
  await assert.rejects(setSubjectSourceActive(pool,writer.sourceId,true),e=>e.code==='reference_capacity');
  assert.equal((await pool.query('SELECT is_active FROM registry.sources WHERE id=$1',[writer.sourceId])).rows[0].is_active,false);
  await Promise.all([
   assert.rejects(transaction(pool,async db=>{await db.query("UPDATE registry.subjects SET name='Rolled back'");throw new Error('rollback');}),/rollback/),
   transaction(pool,async db=>assert.equal((await db.query("SELECT count(*)::int AS n FROM registry.subjects WHERE name='Rolled back'")).rows[0].n,0),{readOnly:true})
  ]);
  // Independently reach the byte boundary with only 99 test references.
  await transaction(pool,async db=>{
   await db.query('DELETE FROM registry.face_references');
   const otherId=(await db.query("SELECT id FROM registry.subjects WHERE external_id='other'")).rows[0].id;
   await db.query("INSERT INTO registry.face_references(subject_id,image_sha256,image_bytes) SELECT $1,lpad(to_hex(n),64,'0'),$2 FROM generate_series(1,99) n",[otherId,Buffer.alloc(121200)]);
  });
  assert.ok(jpeg.length>1200);
  await assert.rejects(api.external({key:other.key,method:'POST',references:true,externalId:'other',body:{image}}),e=>e.code==='reference_capacity');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM registry.face_references')).rows[0].n,99);
 }finally{await local?.pool.end();await rm(dir,{recursive:true,force:true});}
});
test('public HTTPS requirement and independent production configuration',()=>{
 assert.throws(()=>registryConfiguration({NODE_ENV:'production',SUBJECT_REGISTRY_PUBLIC_ORIGIN:'http://example.com'}),/HTTPS/);
 assert.throws(()=>registryConfiguration({SUBJECT_REGISTRY_PUBLIC_ORIGIN:'http://example.com'}),/HTTPS/);
 assert.equal(registryConfiguration({NODE_ENV:'production',SUBJECT_REGISTRY_PUBLIC_ORIGIN:'https://registry.example.com'}).publicOrigin,'https://registry.example.com');
});
