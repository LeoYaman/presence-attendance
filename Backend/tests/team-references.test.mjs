import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {importTeamReferences,loadTeamReferenceManifest,teamReferences,assertLocalDemoOffline} from '../scripts/import-team-references.mjs';

const forbidden=['users','face_enrollments','attendance_sessions','attendance_records','audit_logs'];
function fixture() {
  return {sourceCommit:'a'.repeat(40),references:teamReferences.members.map((member,i)=>{
    const bytes=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(100,i),Buffer.from([255,217])]);
    return {key:member.key,name:member.name,sourcePath:member.sourcePath,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  })};
}
async function database() {
  const db=new PGlite();
  for(const name of ['001_initial_schema.sql','007_team_face_references.sql'])
    await db.exec(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  await db.query(`INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'teacher@presence-demo.test','test teacher','teacher')`,[teamReferences.teacherId]);
  return db;
}
async function state(db) {
  const result={};
  for(const table of ['groups','people','group_staff','group_memberships','team_face_references',...forbidden])
    result[table]=(await db.query('SELECT row_to_json(t) AS row FROM attendance.'+table+' t ORDER BY row_to_json(t)::text')).rows;
  return result;
}

test('team import preserves exact bytes, names and provenance; repeat changes no rows',async()=>{
  const db=await database();
  try {
    const before=await state(db),manifest=fixture();
    const first=await importTeamReferences(db,manifest);
    assert.equal(first.peopleInserted,4);assert.equal(first.membershipsInserted,4);assert.equal(first.referencesInserted,4);
    const after=await state(db);
    const second=await importTeamReferences(db,manifest);
    assert.equal(second.peopleInserted,0);assert.equal(second.membershipsInserted,0);assert.equal(second.referencesInserted,0);
    assert.deepEqual(await state(db),after);
    for(const table of forbidden) assert.deepEqual(after[table],before[table]);
    const rows=(await db.query(`SELECT r.*,p.full_name,p.person_code,encode(r.image_bytes,'hex') AS hex
      FROM attendance.team_face_references r JOIN attendance.people p ON p.id=r.person_id ORDER BY r.reference_key`)).rows;
    assert.equal(rows.length,4);
    for(const row of rows) {
      const reference=manifest.references.find(reference=>reference.key===row.reference_key);
      assert.equal(row.full_name,reference.name);assert.equal(row.source_commit,manifest.sourceCommit);
      assert.equal(row.source_path,reference.sourcePath);assert.equal(row.image_sha256,reference.sha256);
      assert.equal(row.group_id,teamReferences.groupId);assert.equal(row.is_active,true);
      assert.deepEqual(Buffer.from(row.hex,'hex'),reference.bytes);
    }
    assert.equal((await db.query('SELECT code FROM attendance.groups')).rows[0].code,teamReferences.groupCode);
    assert.deepEqual((await db.query('SELECT user_id FROM attendance.group_staff')).rows,[{user_id:teamReferences.teacherId}]);
  } finally {await db.close();}
});

test('invalid mapping and hashes reject before writes; late SQL failure rolls back import',async()=>{
  const db=await database();
  try {
    const before=await state(db);
    const badName=fixture();badName.references[2].name='Rebecca';
    await assert.rejects(importTeamReferences(db,badName),/confirmed name\/photo mapping differs/);
    const badHash=fixture();badHash.references[3].sha256='b'.repeat(64);
    await assert.rejects(importTeamReferences(db,badHash),/SHA-256 differs/);
    const badJpeg=fixture();badJpeg.references[0].bytes[0]=0;
    await assert.rejects(importTeamReferences(db,badJpeg),/original JPEG bytes required/);
    assert.deepEqual(await state(db),before);
    await db.exec(`CREATE FUNCTION attendance.fail_team_import() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.reference_key='team_olivia' THEN RAISE EXCEPTION 'test interruption'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_team_import BEFORE INSERT ON attendance.team_face_references FOR EACH ROW EXECUTE FUNCTION attendance.fail_team_import();`);
    await assert.rejects(importTeamReferences(db,fixture()),/test interruption/);
    assert.deepEqual(await state(db),before);
  } finally {await db.close();}
});

test('person collision, changed provenance and stored byte corruption refuse overwrite atomically',async()=>{
  const db=await database();
  try {
    const member=teamReferences.members[3];
    await db.query('INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,$2,$3)',[member.personId,member.personCode,'Someone else']);
    const collision=await state(db);
    await assert.rejects(importTeamReferences(db,fixture()),/person team_olivia differs/);
    assert.deepEqual(await state(db),collision);
    await db.query('DELETE FROM attendance.people WHERE id=$1',[member.personId]);
    const manifest=fixture();await importTeamReferences(db,manifest);
    const first=await state(db);
    await assert.rejects(importTeamReferences(db,{...manifest,sourceCommit:'b'.repeat(40)}),/photograph team_anthony differs/);
    assert.deepEqual(await state(db),first);
    await db.query(`UPDATE attendance.team_face_references SET image_bytes=set_byte(image_bytes,10,42) WHERE reference_key='team_leo'`);
    const corrupt=await state(db);
    await assert.rejects(importTeamReferences(db,manifest),/photograph team_leo differs/);
    assert.deepEqual(await state(db),corrupt);
  } finally {await db.close();}
});

test('missing active teacher rejects without creating users or any import rows',async()=>{
  const db=await database();
  try {
    await db.query('DELETE FROM attendance.users');
    const before=await state(db);
    await assert.rejects(importTeamReferences(db,fixture()),/existing active local demo teacher/);
    assert.deepEqual(await state(db),before);
  } finally {await db.close();}
});

test('repository manifest captures the pinned origin/main JPEG blobs and confirmed names',async()=>{
  const manifest=await loadTeamReferenceManifest();
  assert.match(manifest.sourceCommit,/^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.references.map(row=>row.name),['Anthony','Leo','Rebbeca','Olivia']);
  const root=fileURLToPath(new URL('../../',import.meta.url));
  for(const reference of manifest.references) {
    const {stdout}=await promisify(execFile)('git',['show',manifest.sourceCommit+':'+reference.sourcePath],{cwd:root,encoding:'buffer',maxBuffer:8*1024*1024});
    assert.deepEqual(reference.bytes,stdout);
    assert.equal(reference.sha256,createHash('sha256').update(stdout).digest('hex'));
  }
});

test('CLI requires explicit offline local flags before opening a database',async()=>{
  const script=fileURLToPath(new URL('../scripts/import-team-references.mjs',import.meta.url));
  for(const args of [[],['--local'],['--database','--offline-confirmed']])
    await assert.rejects(promisify(execFile)(process.execPath,[script,...args]),error=>error.code===1&&/Usage:/.test(error.stderr));
});

test('offline guard checks port3000 and a configured port, rejects listeners and fails closed on probe errors',async()=>{
  const calls=[];
  await assertLocalDemoOffline({port:4321,windowsPorts:async ports=>assert.deepEqual([...ports],[3000,4321]),
    probe:async(host,port)=>{calls.push([host,port]);return false;}});
  assert.deepEqual(calls,[['127.0.0.1',3000],['::1',3000],['127.0.0.1',4321],['::1',4321]]);
  await assert.rejects(assertLocalDemoOffline({port:4321,windowsPorts:async()=>{},probe:async(host,port)=>port===3000}),/port 3000 is listening/);
  await assert.rejects(assertLocalDemoOffline({windowsPorts:async()=>{},probe:async()=>{throw new Error('EPERM');}}),/EPERM/);
  await assert.rejects(assertLocalDemoOffline({windowsPorts:async()=>{throw new Error('inventory unavailable');},probe:async()=>false}),/inventory unavailable/);
});

