import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {loadBundledTeamReferenceManifest,ensureDemoTeamReferences,seedPresentationSubjects} from '../scripts/demo-fixtures.mjs';
import {importTeamReferences,teamReferences} from '../scripts/import-team-references.mjs';
import {openRegistryDatabase} from '../../SubjectRegistry/src/database.mjs';
import {loadLocalConfiguration} from '../../SubjectRegistry/src/config.mjs';
import {createSubjectsApi,subjectApps} from '../../SubjectRegistry/src/subjects.mjs';

const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
function rootUrl(root,...parts){return join(root,...parts);}
async function makeWorkspaceTemp(prefix) {
  const base=join(repoRoot,'.tmp');await mkdir(base,{recursive:true});
  return mkdtemp(join(base,prefix));
}

async function attendanceDatabase() {
  const db=new PGlite();
  for(const name of ['001_initial_schema.sql','007_team_face_references.sql'])
    await db.exec(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  await db.query("INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,'teacher@presence-demo.test','test teacher','teacher')",[teamReferences.teacherId]);
  return db;
}

test('bundled team manifest loads from a gitless ZIP tree and rejects changed photo bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'presence-zip-fixtures-'));
  try {
    await mkdir(rootUrl(root,'assets'),{recursive:true});
    await mkdir(rootUrl(root,'face_data','people_faces'),{recursive:true});
    await copyFile(rootUrl(repoRoot,'assets','team-reference-manifest.json'),rootUrl(root,'assets','team-reference-manifest.json'));
    await copyFile(rootUrl(repoRoot,'face_data','students.json'),rootUrl(root,'face_data','students.json'));
    for(const member of teamReferences.members) await copyFile(rootUrl(repoRoot,...member.sourcePath.split('/')),rootUrl(root,...member.sourcePath.split('/')));
    const loaded=await loadBundledTeamReferenceManifest(root);
    assert.equal(loaded.sourceCommit,'4e6bf7eab4a4b07fb835d4ca7d9048fecaef3045');
    assert.deepEqual(loaded.references.map(row=>row.key),teamReferences.members.map(row=>row.key));
    assert.ok(loaded.references.every(row=>Buffer.isBuffer(row.bytes)));
    const photo=rootUrl(root,...teamReferences.members[0].sourcePath.split('/'));
    const bytes=await readFile(photo);bytes[100]^=1;await writeFile(photo,bytes);
    await assert.rejects(loadBundledTeamReferenceManifest(root),/SHA-256 differs/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('attendance fixture import is additive and retains one existing source commit',async()=>{
  const db=await attendanceDatabase();
  try {
    const bundled=await loadBundledTeamReferenceManifest();
    const previousCommit='a'.repeat(40);
    await importTeamReferences(db,{...bundled,sourceCommit:previousCommit});
    const first=await ensureDemoTeamReferences(db);
    assert.equal(first.sourceCommit,previousCommit);
    assert.equal(first.peopleInserted,0);assert.equal(first.membershipsInserted,0);assert.equal(first.referencesInserted,0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM attendance.team_face_references')).rows[0].count,4);
    assert.equal((await db.query('SELECT count(DISTINCT source_commit)::int AS count FROM attendance.team_face_references')).rows[0].count,1);
    await db.query("UPDATE attendance.team_face_references SET source_commit=$1 WHERE reference_key=$2",['b'.repeat(40),teamReferences.members[0].key]);
    await assert.rejects(ensureDemoTeamReferences(db),/conflicting source provenance/);
  } finally {await db.close();}
});

test('presentation subject seeding creates four references once and preserves later deletions',async()=>{
  const directory=await makeWorkspaceTemp('presence-registry-fixtures-');
  let local;
  try {
    local=await openRegistryDatabase(directory);
    const {pool}=local,configuration=await loadLocalConfiguration(pool,join(directory,'service-config.json'));
    const markerPath=join(directory,'presentation-subjects.json');
    const faceWorker={async request(){return {valid:true};}};
    const result=await seedPresentationSubjects({pool,faceWorker,configuration,markerPath});
    assert.equal(result.status,'seeded');
    const api=createSubjectsApi({pool,faceWorker});
    const catalog=await api.list({key:configuration.readerKey,app:'subject-finder'});
    assert.deepEqual(catalog.subjects.map(row=>[row.externalId,row.name,row.id,row.referenceCount]),
      [...teamReferences.members].sort((a,b)=>a.name.localeCompare(b.name)).map(row=>[row.key,row.name,row.personId,1]));
    assert.deepEqual((await api.list({key:configuration.readerKey,app:'attendance'})).subjects,catalog.subjects);
    assert.equal((await seedPresentationSubjects({pool,faceWorker,configuration,markerPath})).status,'already-initialized');
    await api.external({key:configuration.writeKey,method:'PATCH',externalId:teamReferences.members[1].key,body:{name:'Renamed by operator',active:false}});
    assert.equal((await seedPresentationSubjects({pool,faceWorker,configuration,markerPath})).status,'already-initialized');
    const changed=(await pool.query('SELECT name,is_active FROM registry.subjects WHERE external_id=$1',[teamReferences.members[1].key])).rows[0];
    assert.deepEqual(changed,{name:'Renamed by operator',is_active:false});
    await api.external({key:configuration.writeKey,method:'DELETE',externalId:teamReferences.members[0].key});
    assert.equal((await seedPresentationSubjects({pool,faceWorker,configuration,markerPath})).status,'already-initialized');
    assert.equal((await api.list({key:configuration.readerKey,app:'subject-finder'})).subjects.length,2);
    assert.equal(JSON.parse(await readFile(markerPath,'utf8')).subjects.length,4);
    const legacy=JSON.parse(await readFile(markerPath,'utf8'));delete legacy.status;
    await writeFile(markerPath,JSON.stringify(legacy));
    await api.external({key:configuration.writeKey,method:'DELETE',externalId:teamReferences.members[2].key});
    assert.equal((await seedPresentationSubjects({pool,faceWorker,configuration,markerPath})).status,'already-initialized');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM registry.subjects')).rows[0].count,2);
  } finally {await local?.pool.end();await rm(directory,{recursive:true,force:true});}
});

test('a failed second presentation subject write resumes only verified missing rows',async()=>{
  const directory=await makeWorkspaceTemp('presence-registry-resume-');
  let local;
  try {
    local=await openRegistryDatabase(directory);
    const {pool}=local,configuration=await loadLocalConfiguration(pool,join(directory,'service-config.json'));
    const markerPath=join(directory,'presentation-subjects.json');
    let validations=0;
    const failingWorker={async request(){if(++validations===2)throw new Error('intentional second reference failure');return {valid:true};}};
    await assert.rejects(seedPresentationSubjects({pool,faceWorker:failingWorker,configuration,markerPath}),/intentional second reference failure/);
    const partial=JSON.parse(await readFile(markerPath,'utf8'));
    assert.equal(partial.status,'seeding');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM registry.subjects')).rows[0].count,1);

    const first=teamReferences.members[0],expected=(await loadBundledTeamReferenceManifest()).references[0];
    await pool.query('UPDATE registry.subjects SET name=$1 WHERE external_id=$2',['Changed during bootstrap',first.key]);
    await assert.rejects(seedPresentationSubjects({pool,faceWorker:{async request(){return {valid:true};}},configuration,markerPath}),/changed or unexpected registry identity/);
    await pool.query('UPDATE registry.subjects SET name=$1 WHERE external_id=$2',[first.name,first.key]);
    await pool.query('UPDATE registry.face_references SET image_sha256=$1 WHERE subject_id=$2',['0'.repeat(64),first.personId]);
    await assert.rejects(seedPresentationSubjects({pool,faceWorker:{async request(){return {valid:true};}},configuration,markerPath}),/reference changed/);
    await pool.query('UPDATE registry.face_references SET image_sha256=$1 WHERE subject_id=$2',[expected.sha256,first.personId]);

    const faceWorker={async request(){return {valid:true};}};
    const resumed=await seedPresentationSubjects({pool,faceWorker,configuration,markerPath});
    assert.equal(resumed.status,'seeded');assert.equal(resumed.marker.status,'ready');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM registry.subjects')).rows[0].count,4);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM registry.face_references')).rows[0].count,4);
    const api=createSubjectsApi({pool,faceWorker});
    await api.external({key:configuration.writeKey,method:'DELETE',externalId:teamReferences.members[0].key});
    assert.equal((await seedPresentationSubjects({pool,faceWorker,configuration,markerPath})).status,'already-initialized');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM registry.subjects')).rows[0].count,3);
  } finally {await local?.pool.end();await rm(directory,{recursive:true,force:true});}
});

test('an existing registry catalog is marked initialized without adding or replacing subjects',async()=>{
  const directory=await makeWorkspaceTemp('presence-registry-existing-');
  let local;
  try {
    local=await openRegistryDatabase(directory);
    const {pool}=local,configuration=await loadLocalConfiguration(pool,join(directory,'service-config.json'));
    const faceWorker={async request(){return {valid:true};}};
    const api=createSubjectsApi({pool,faceWorker});
    await api.external({key:configuration.writeKey,method:'PUT',externalId:'operator-added',subjectId:'f3102026-0000-4000-8000-000000000900',
      body:{name:'Operator Added',apps:subjectApps}});
    const markerPath=join(directory,'presentation-subjects.json');
    const seeded=await seedPresentationSubjects({pool,faceWorker,configuration,markerPath});
    assert.equal(seeded.status,'already-initialized');
    const rows=(await api.list({key:configuration.readerKey,app:'subject-finder'})).subjects;
    assert.deepEqual(rows.map(row=>[row.externalId,row.name]),[['operator-added','Operator Added']]);
    assert.deepEqual(JSON.parse(await readFile(markerPath,'utf8')).reason,'registry-already-contained-subjects');
  } finally {await local?.pool.end();await rm(directory,{recursive:true,force:true});}
});
