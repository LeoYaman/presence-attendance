import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {importTeamReferences,teamReferences} from './import-team-references.mjs';
import {createSubjectsApi,digest as keyDigest,subjectApps} from '../../SubjectRegistry/src/subjects.mjs';

const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const commitPattern=/^[0-9a-f]{40}$/;
const registryMarker=join(fileURLToPath(new URL('../../SubjectRegistry/',import.meta.url)),'.local-db','presentation-subjects.json');

function checkTeamRows(rows,label) {
  if(!Array.isArray(rows)||rows.length!==teamReferences.members.length)
    throw new Error(`Invalid bundled team references: expected four ${label}`);
  return teamReferences.members.map(member=>{
    const matches=rows.filter(row=>row?.key===member.key);
    const row=matches[0];
    if(matches.length!==1||row.name!==member.name||row.sourcePath!==member.sourcePath)
      throw new Error(`Invalid bundled team references: ${label} mapping differs for ${member.key}`);
    return member;
  });
}

export async function loadBundledTeamReferenceManifest(root=repositoryRoot) {
  const manifest=JSON.parse(await readFile(join(root,'assets','team-reference-manifest.json'),'utf8'));
  if(!commitPattern.test(manifest?.sourceCommit??''))
    throw new Error('Invalid bundled team references: expected a full source commit');
  checkTeamRows(manifest.references,'manifest');
  const students=JSON.parse(await readFile(join(root,'face_data','students.json'),'utf8')).students;
  if(!Array.isArray(students)||students.filter(row=>row?.kind==='team').length!==teamReferences.members.length)
    throw new Error('Invalid bundled team references: expected four team entries in students.json');
  for(const member of teamReferences.members) {
    const entries=students.filter(row=>row?.id===member.key);
    const entry=entries[0];
    if(entries.length!==1||entry.kind!=='team'||entry.name!==member.name||`face_data/${entry.photo}`!==member.sourcePath)
      throw new Error(`Invalid bundled team references: students.json mapping differs for ${member.key}`);
  }
  const references=[];
  for(const member of teamReferences.members) {
    const row=manifest.references.find(candidate=>candidate.key===member.key);
    const bytes=await readFile(join(root,...member.sourcePath.split('/')));
    if(!/^[0-9a-f]{64}$/.test(row.sha256??'')||digest(bytes)!==row.sha256)
      throw new Error(`Invalid bundled team references: SHA-256 differs for ${member.key}`);
    references.push({...member,bytes,sha256:row.sha256});
  }
  return {sourceCommit:manifest.sourceCommit,references};
}

export async function ensureDemoTeamReferences(pool) {
  const manifest=await loadBundledTeamReferenceManifest();
  const keys=teamReferences.members.map(member=>member.key);
  const stored=(await pool.query('SELECT DISTINCT source_commit FROM attendance.team_face_references WHERE reference_key=ANY($1::text[])',[keys])).rows;
  if(stored.length>1) throw new Error('Existing team references have conflicting source provenance');
  if(stored.length===1) {
    if(!commitPattern.test(stored[0].source_commit??'')) throw new Error('Existing team references have invalid source provenance');
    manifest.sourceCommit=stored[0].source_commit;
  }
  return importTeamReferences(pool,manifest);
}

export async function seedPresentationSubjects({pool,faceWorker,configuration,markerPath=registryMarker}) {
  let marker;
  try {
    marker=JSON.parse(await readFile(markerPath,'utf8'));
  } catch(error) { if(error.code!=='ENOENT') throw error; }

  // Ready and pre-status markers represent a completed initialization. Their
  // catalog may have been intentionally edited or deleted since then.
  if(marker&&marker.status!=='seeding') return {status:'already-initialized',marker};

  const manifest=await loadBundledTeamReferenceManifest();
  if(marker?.status==='seeding') assertSeedingMarker(marker,manifest,configuration);

  const currentCount=Number((await pool.query('SELECT count(*)::int AS count FROM registry.subjects')).rows[0]?.count??0);
  if(!marker&&currentCount>0) {
    const completed={status:'ready',sourceCommit:manifest.sourceCommit,reason:'registry-already-contained-subjects'};
    await writeMarker(markerPath,completed);
    return {status:'already-initialized',marker:completed};
  }

  const planned=plannedSubjects(manifest);
  const missing=await verifySeedingState(pool,{manifest,configuration,planned});
  if(!marker) {
    marker={status:'seeding',sourceCommit:manifest.sourceCommit,sourceId:configuration.sourceId,subjects:planned};
    await writeMarker(markerPath,marker);
  }
  const api=createSubjectsApi({pool,faceWorker});
  for(const reference of manifest.references.filter(row=>missing.has(row.key))) {
    await api.external({key:configuration.writeKey,method:'PUT',externalId:reference.key,subjectId:reference.personId,
      body:{name:reference.name,apps:subjectApps,image:reference.bytes.toString('base64')}});
  }
  const remaining=await verifySeedingState(pool,{manifest,configuration,planned});
  if(remaining.size) throw new Error('Presentation subject bootstrap did not create every expected identity');
  const ready={...marker,status:'ready'};
  await writeMarker(markerPath,ready);
  return {status:'seeded',marker:ready};
}

function plannedSubjects(manifest) {
  return manifest.references.map(({key,name,personId,sha256})=>({key,name,personId,sha256,apps:[...subjectApps].sort()}));
}

function assertSeedingMarker(marker,manifest,configuration) {
  const expected=plannedSubjects(manifest);
  if(marker.sourceCommit!==manifest.sourceCommit||marker.sourceId!==configuration?.sourceId||
    JSON.stringify(marker.subjects)!==JSON.stringify(expected))
    throw new Error('Presentation subject bootstrap marker differs from the expected private registry configuration');
}

async function verifySeedingState(pool,{manifest,configuration,planned}) {
  if(typeof configuration?.sourceId!=='string'||typeof configuration?.writeKey!=='string'||
    !/^registry_write_[a-f0-9]{64}$/.test(configuration.writeKey))
    throw new Error('Presentation subject seed requires its original private registry write key');

  const source=(await pool.query('SELECT id,name,allowed_apps,is_active FROM registry.sources WHERE id=$1',[configuration.sourceId])).rows[0];
  if(!source||source.name!=='local-import'||source.is_active!==true||
    JSON.stringify([...source.allowed_apps].sort())!==JSON.stringify([...subjectApps].sort()))
    throw new Error('Presentation subject bootstrap source differs from its private configuration');
  const key=(await pool.query("SELECT source_id FROM registry.api_keys WHERE key_hash=$1 AND privilege='write' AND is_active AND (expires_at IS NULL OR expires_at>now())",[keyDigest(configuration.writeKey)])).rows[0];
  if(!key||key.source_id!==configuration.sourceId)
    throw new Error('Presentation subject bootstrap write key no longer owns its configured source');

  const subjects=(await pool.query('SELECT id,source_id,external_id,name,is_active FROM registry.subjects ORDER BY external_id')).rows;
  const expectedByKey=new Map(manifest.references.map(reference=>[reference.key,reference]));
  const subjectByKey=new Map();
  for(const subject of subjects) {
    const expected=expectedByKey.get(subject.external_id);
    if(!expected||subject.id!==expected.personId||subject.source_id!==configuration.sourceId||
      subject.name!==expected.name||subject.is_active!==true)
      throw new Error('Presentation subject bootstrap found a changed or unexpected registry identity');
    subjectByKey.set(subject.external_id,subject);
  }

  const subjectIds=subjects.map(subject=>subject.id);
  const refs=subjectIds.length?(await pool.query(`SELECT s.external_id,r.image_sha256,r.image_bytes,r.is_active
    FROM registry.face_references r JOIN registry.subjects s ON s.id=r.subject_id
    WHERE s.id=ANY($1::uuid[]) ORDER BY s.external_id,r.image_sha256`,[subjectIds])).rows:[];
  const apps=subjectIds.length?(await pool.query(`SELECT s.external_id,a.app FROM registry.app_access a
    JOIN registry.subjects s ON s.id=a.subject_id WHERE s.id=ANY($1::uuid[]) ORDER BY s.external_id,a.app`,[subjectIds])).rows:[];
  const missing=new Set();
  for(const plannedSubject of planned) {
    const subject=subjectByKey.get(plannedSubject.key);
    if(!subject) {missing.add(plannedSubject.key);continue;}
    const reference=manifest.references.find(row=>row.key===plannedSubject.key);
    const storedRefs=refs.filter(row=>row.external_id===plannedSubject.key);
    if(storedRefs.length!==1||storedRefs[0].is_active!==true||storedRefs[0].image_sha256!==reference.sha256||
      digest(Buffer.from(storedRefs[0].image_bytes))!==reference.sha256)
      throw new Error(`Presentation subject bootstrap reference changed for ${plannedSubject.key}`);
    const storedApps=apps.filter(row=>row.external_id===plannedSubject.key).map(row=>row.app).sort();
    if(JSON.stringify(storedApps)!==JSON.stringify(plannedSubject.apps))
      throw new Error(`Presentation subject bootstrap application access changed for ${plannedSubject.key}`);
  }
  if(subjectByKey.size!==subjects.length) throw new Error('Presentation subject bootstrap contains an unexpected registry identity');
  return missing;
}

async function writeMarker(path,marker) {
  await mkdir(dirname(path),{recursive:true});
  const temporary=`${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(marker,null,2)+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,path);
}
