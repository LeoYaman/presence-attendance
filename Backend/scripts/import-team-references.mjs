import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';

const run=promisify(execFile);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const scopedId=n=>`f3102026-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const teamReferences=Object.freeze({
  groupId:scopedId(1),groupCode:'PRESENCE-TEAM-REFERENCES',teacherId:'d3102026-0000-4000-8000-000000000002',
  members:Object.freeze([
    ['team_anthony','Anthony','WIN_20261010_00_51_21_Pro.jpg'],
    ['team_leo','Leo','WIN_20261010_00_51_36_Pro.jpg'],
    ['team_rebbeca','Rebbeca','WIN_20261010_00_52_21_Pro.jpg'],
    ['team_olivia','Olivia','WIN_20261010_00_52_47_Pro.jpg']
  ].map(([key,name,photo],i)=>Object.freeze({key,name,sourcePath:'face_data/people_faces/'+photo,
    personId:scopedId(100+i),personCode:'PRESENCE-TEAM-'+name.toUpperCase(),membershipId:scopedId(300+i)})))
});

function validateManifest(manifest) {
  if(!manifest||!/^[0-9a-f]{40}$/.test(manifest.sourceCommit??'')||!Array.isArray(manifest.references)||manifest.references.length!==4)
    throw new Error('Invalid team references: expected four photographs and a full source commit');
  return teamReferences.members.map(member=>{
    const matching=manifest.references.filter(row=>row?.key===member.key);
    const row=matching[0];
    if(matching.length!==1||row.name!==member.name||row.sourcePath!==member.sourcePath)
      throw new Error('Invalid team references: confirmed name/photo mapping differs: '+member.key);
    if(!Buffer.isBuffer(row.bytes)||row.bytes.length<100||row.bytes.length>4194304||
      row.bytes[0]!==255||row.bytes[1]!==216||row.bytes[2]!==255||row.bytes.at(-2)!==255||row.bytes.at(-1)!==217)
      throw new Error('Invalid team references: original JPEG bytes required: '+member.key);
    if(row.sha256!==digest(row.bytes)) throw new Error('Invalid team references: SHA-256 differs: '+member.key);
    return {...member,sha256:row.sha256,hex:row.bytes.toString('hex')};
  });
}

export async function loadTeamReferenceManifest(root=fileURLToPath(new URL('../../',import.meta.url))) {
  const git=async args=>(await run('git',args,{cwd:root,encoding:'buffer',maxBuffer:8*1024*1024})).stdout;
  const sourceCommit=(await git(['rev-parse','origin/main^{commit}'])).toString('utf8').trim();
  if(!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Invalid team references: origin/main commit missing');
  const students=JSON.parse((await git(['show',sourceCommit+':face_data/students.json'])).toString('utf8')).students;
  if(!Array.isArray(students)||students.filter(row=>row?.kind==='team').length!==4)
    throw new Error('Invalid team references: expected four team entries in source students.json');
  const references=[];
  for(const member of teamReferences.members) {
    const matches=students.filter(row=>row?.id===member.key);
    const entry=matches[0];
    if(matches.length!==1||entry.kind!=='team'||entry.name!==member.name||'face_data/'+entry.photo!==member.sourcePath)
      throw new Error('Invalid team references: source students.json mapping differs: '+member.key);
    const bytes=await git(['show',sourceCommit+':'+member.sourcePath]);
    references.push({key:member.key,name:member.name,sourcePath:member.sourcePath,bytes,sha256:digest(bytes)});
  }
  const manifest={sourceCommit,references};
  validateManifest(manifest);
  return manifest;
}

export async function importTeamReferences(db,manifest) {
  const references=validateManifest(manifest);
  const client=typeof db.connect==='function'?await db.connect():db;
  const mismatch=label=>{throw new Error('Existing team reference '+label+' differs; nothing was overwritten');};
  let begun=false,peopleInserted=0,referencesInserted=0,membershipsInserted=0;
  try {
    await client.query('BEGIN');begun=true;
    const teacher=(await client.query('SELECT role,is_active FROM attendance.users WHERE id=$1',[teamReferences.teacherId])).rows[0];
    if(teacher?.role!=='teacher'||teacher.is_active!==true) throw new Error('Team references require the existing active local demo teacher');
    const groupRows=(await client.query('SELECT *,term_starts_on::text AS starts,term_ends_on::text AS ends FROM attendance.groups WHERE id=$1 OR code=$2 FOR UPDATE',[teamReferences.groupId,teamReferences.groupCode])).rows;
    if(groupRows.length>1) mismatch('group scope');
    const group=groupRows[0];
    if(group&&(group.id!==teamReferences.groupId||group.code!==teamReferences.groupCode||group.name!=='Team reference photographs'||
      group.course_code!=='TEAM-REF'||group.term_name!=='Team reference demonstration'||group.starts!=='2026-01-01'||group.ends!=='2027-12-31'||
      group.time_zone!=='America/New_York'||group.allowed_absences!==10||group.is_active!==true)) mismatch('group');
    await client.query(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on,time_zone)
      VALUES($1,$2,'Team reference photographs','TEAM-REF','Team reference demonstration','2026-01-01','2027-12-31','America/New_York')
      ON CONFLICT(id) DO NOTHING`,[teamReferences.groupId,teamReferences.groupCode]);
    const staff=(await client.query('SELECT user_id FROM attendance.group_staff WHERE group_id=$1',[teamReferences.groupId])).rows;
    if(staff.some(row=>row.user_id!==teamReferences.teacherId)) mismatch('group staff');
    await client.query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[teamReferences.groupId,teamReferences.teacherId]);
    for(const reference of references) {
      const people=(await client.query('SELECT id,person_code,full_name,is_active FROM attendance.people WHERE id=$1 OR person_code=$2 FOR UPDATE',[reference.personId,reference.personCode])).rows;
      if(people.length>1||people.some(row=>row.id!==reference.personId||row.person_code!==reference.personCode||row.full_name!==reference.name||row.is_active!==true)) mismatch('person '+reference.key);
      const added=await client.query('INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id',[reference.personId,reference.personCode,reference.name]);
      peopleInserted+=added.rows.length;
      const memberships=(await client.query(`SELECT id,group_id,person_id,joined_at=TIMESTAMPTZ '2026-01-01 00:00:00+00' AS expected_start,left_at
        FROM attendance.group_memberships WHERE id=$1 OR (group_id=$2 AND person_id=$3) FOR UPDATE`,[reference.membershipId,teamReferences.groupId,reference.personId])).rows;
      if(memberships.length>1||memberships.some(row=>row.id!==reference.membershipId||row.group_id!==teamReferences.groupId||row.person_id!==reference.personId||!row.expected_start||row.left_at!==null)) mismatch('membership '+reference.key);
      const membership=await client.query(`INSERT INTO attendance.group_memberships(id,group_id,person_id,joined_at)
        VALUES($1,$2,$3,'2026-01-01 00:00:00+00') ON CONFLICT(id) DO NOTHING RETURNING id`,[reference.membershipId,teamReferences.groupId,reference.personId]);
      membershipsInserted+=membership.rows.length;
      const stored=(await client.query(`SELECT *,encode(image_bytes,'hex') AS hex FROM attendance.team_face_references
        WHERE reference_key=$1 OR person_id=$2 OR source_path=$3 FOR UPDATE`,[reference.key,reference.personId,reference.sourcePath])).rows;
      if(stored.length>1||stored.some(row=>row.reference_key!==reference.key||row.group_id!==teamReferences.groupId||row.person_id!==reference.personId||
        row.source_path!==reference.sourcePath||row.source_commit!==manifest.sourceCommit||row.image_sha256!==reference.sha256||row.hex!==reference.hex||row.is_active!==true)) mismatch('photograph '+reference.key);
      const imported=await client.query(`INSERT INTO attendance.team_face_references(reference_key,group_id,person_id,source_path,source_commit,image_sha256,image_bytes)
        VALUES($1,$2,$3,$4,$5,$6,decode($7,'hex')) ON CONFLICT(reference_key) DO NOTHING RETURNING reference_key`,
        [reference.key,teamReferences.groupId,reference.personId,reference.sourcePath,manifest.sourceCommit,reference.sha256,reference.hex]);
      referencesInserted+=imported.rows.length;
    }
    const roster=(await client.query('SELECT id FROM attendance.group_memberships WHERE group_id=$1',[teamReferences.groupId])).rows;
    if(roster.length!==4||roster.some(row=>!references.some(reference=>reference.membershipId===row.id))) mismatch('group roster');
    await client.query('COMMIT');begun=false;
    return {groupId:teamReferences.groupId,groupCode:teamReferences.groupCode,sourceCommit:manifest.sourceCommit,
      people:4,references:4,peopleInserted,membershipsInserted,referencesInserted};
  } catch(error) {
    if(begun) await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {if(client!==db) client.release();}
}

async function listening(host,port) {
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host,port});
    socket.setTimeout(1000);
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',error=>{
      socket.destroy();
      if(error.code==='ECONNREFUSED') resolve(false);
      else reject(new Error('Unable to verify the local server is offline: '+error.code));
    });
    socket.once('timeout',()=>{socket.destroy();resolve(true);});
  });
}

// Windows sandboxed child sockets can fail to observe a host listener. Check the
// operating system's TCP inventory as well before opening the shared snapshot.
async function verifyWindowsPorts(ports) {
  if(process.platform!=='win32') return;
  let stdout;
  try {({stdout}=await run('netstat.exe',['-ano','-p','tcp'],{encoding:'utf8',maxBuffer:1024*1024}));}
  catch {throw new Error('Unable to verify the local server is offline using netstat');}
  for(const line of stdout.split(/\r?\n/)) {
    const fields=line.trim().split(/\s+/);
    if(fields[0]!=='TCP') continue;
    const port=Number(fields[1]?.match(/:(\d+)$/)?.[1]);
    if(ports.has(port)) throw new Error('Stop the local server before importing (port '+port+' has a TCP endpoint)');
  }
}

export async function assertLocalDemoOffline({port=Number(process.env.LOCAL_DEMO_PORT??3000),probe=listening,windowsPorts=verifyWindowsPorts}={}) {
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid LOCAL_DEMO_PORT');
  const ports=new Set([3000,port]);
  await windowsPorts(ports);
  for(const checkedPort of ports) for(const host of ['127.0.0.1','::1'])
    if(await probe(host,checkedPort)) throw new Error('Stop the local server before importing (port '+checkedPort+' is listening)');
}

async function main() {
  const args=process.argv.slice(2);
  if(args.length!==2||!args.includes('--local')||!args.includes('--offline-confirmed'))
    throw new Error('Usage: node scripts/import-team-references.mjs --local --offline-confirmed (stop the local server first)');
  if(process.env.NODE_ENV==='production') throw new Error('Local team reference import is forbidden in production');
  await assertLocalDemoOffline();
  const manifest=await loadTeamReferenceManifest();
  const {openLocalDatabase}=await import('./local-demo.mjs');
  const {pool}=await openLocalDatabase(fileURLToPath(new URL('../.local-db/pgdata/',import.meta.url)));
  try {console.log(JSON.stringify(await importTeamReferences(pool,manifest),null,2));}
  finally {await pool.end();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{
  console.error('Team reference import failed:',error.message);process.exitCode=1;
});
