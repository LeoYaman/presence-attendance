// Fictional roster fixtures for the offline PGlite demo only. Portrait assets
// remain display references; this seed never creates biometric enrollments.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {demo} from './seed-demo.mjs';
import {teamReferences} from './import-team-references.mjs';

const namespace='presence-local-fictional-catalog-2026-v1';
export function localCatalogId(kind,key) {
  const bytes=createHash('sha1').update(`${namespace}:${kind}:${key}`).digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x50; bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function loadLocalCatalog() {
  return JSON.parse(await readFile(new URL('../../assets/demo-catalog.json',import.meta.url),'utf8'));
}

function validateCatalog(catalog) {
  if (catalog?.test_only!==true || !Array.isArray(catalog.courses) || catalog.courses.length!==10 ||
      !Array.isArray(catalog.students) || catalog.students.length!==30)
    throw new Error('Local fictional catalog must contain ten courses and thirty students');
  for (const [rows,idPattern] of [[catalog.courses,/^CLS-\d+$/],[catalog.students,/^STU-10(?:0[1-9]|[12]\d|30)$/]]) {
    if (new Set(rows.map(row=>row.id)).size!==rows.length || rows.some(row=>!idPattern.test(row.id)||typeof row.name!=='string'||!row.name.trim()))
      throw new Error('Local fictional catalog identities are invalid');
  }
  if (new Set(catalog.courses.map(row=>row.code)).size!==10 || catalog.courses.some(row=>typeof row.code!=='string'||!row.code.trim()))
    throw new Error('Local fictional catalog course codes are invalid');
}

// Call inside the same transaction as seedDemo. Dedicated IDs and conflict
// checks prevent an accidental merge with existing people or course sections.
export async function seedLocalCatalog(db,{localOnly=false,catalog,now=new Date()}={}) {
  if (!localOnly || process.env.NODE_ENV==='production') throw new Error('Fictional catalog seed is restricted to the local demo');
  catalog??=await loadLocalCatalog(); validateCatalog(catalog);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid local catalog seed time');
  const teacher=(await db.query('SELECT email,role,person_id,is_active FROM attendance.users WHERE id=$1',[demo.teacherId])).rows[0];
  if (!teacher || teacher.email!==demo.teacherEmail || teacher.role!=='teacher' || teacher.person_id!==null || !teacher.is_active)
    throw new Error('Local catalog requires the existing synthetic demo teacher');
  const hour=now.toISOString().slice(0,13);
  // Reuse only the already imported, confirmed team identities. Their photos
  // and source group remain owned by the original import.
  const imported=(await db.query(`SELECT r.reference_key,r.person_id,r.source_path,p.person_code,p.full_name
    FROM attendance.team_face_references r JOIN attendance.people p ON p.id=r.person_id
    JOIN attendance.groups g ON g.id=r.group_id
    WHERE r.group_id=$1 AND r.is_active AND p.is_active AND g.is_active
      AND EXISTS(SELECT 1 FROM attendance.group_staff s WHERE s.group_id=r.group_id AND s.user_id=$2)`,
    [teamReferences.groupId,demo.teacherId])).rows;
  const team=teamReferences.members.filter(member=>imported.some(row=>row.reference_key===member.key&&
    row.person_id===member.personId&&row.source_path===member.sourcePath&&
    row.person_code===member.personCode&&row.full_name===member.name));
  const roster=[...catalog.students.map(student=>({key:student.id,personId:localCatalogId('person',student.id)})),
    ...team.map(member=>({key:member.key,personId:member.personId}))];
  const rosterVersion=team.length?`:team-v1:${team.map(member=>member.key).join(',')}`:'';
  const sessions=[];
  for (const student of catalog.students) {
    const id=localCatalogId('person',student.id);
    const existing=(await db.query('SELECT id,person_code,full_name,is_active FROM attendance.people WHERE id=$1 OR person_code=$2',[id,student.id])).rows;
    if (existing.some(row=>row.id!==id||row.person_code!==student.id||row.full_name!==student.name||!row.is_active))
      throw new Error('Local catalog person scope is already occupied: '+student.id);
    await db.query('INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[id,student.id,student.name]);
  }
  for (const course of catalog.courses) {
    const groupId=localCatalogId('group',course.id);
    const existing=(await db.query('SELECT id,code,name,course_code,is_active FROM attendance.groups WHERE id=$1 OR code=$2',[groupId,course.id])).rows;
    if (existing.some(row=>row.id!==groupId||row.code!==course.id||row.name!==course.name||row.course_code!==course.code||!row.is_active))
      throw new Error('Local catalog group scope is already occupied: '+course.id);
    await db.query(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on,time_zone)
      VALUES($1,$2,$3,$4,'Fictional local demonstration',$5::date-90,$5::date+90,'America/New_York') ON CONFLICT(id) DO NOTHING`,
      [groupId,course.id,course.name,course.code,now]);
    await db.query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[groupId,demo.teacherId]);
    for (const student of roster) {
      const membershipId=localCatalogId('membership',`${course.id}:${student.key}`),personId=student.personId;
      const membership=(await db.query('SELECT id,group_id,person_id,left_at FROM attendance.group_memberships WHERE id=$1 OR (group_id=$2 AND person_id=$3 AND left_at IS NULL)',[membershipId,groupId,personId])).rows;
      if (membership.some(row=>row.id!==membershipId||row.group_id!==groupId||row.person_id!==personId||row.left_at!==null))
        throw new Error('Local catalog membership scope is already occupied');
      await db.query(`INSERT INTO attendance.group_memberships(id,group_id,person_id,joined_at)
        VALUES($1,$2,$3,$4::timestamptz-interval '90 days') ON CONFLICT(id) DO NOTHING`,[membershipId,groupId,personId,now]);
    }
    // A restart in a later hour adds a usable window without changing existing
    // attendance. Repeated starts within this hour preserve approved sessions.
    // A changed roster gets a new snapshot, leaving old attendance untouched.
    const sessionId=localCatalogId('session',`${course.id}:${hour}${rosterVersion}`);
    const session=(await db.query('SELECT group_id,created_by,status FROM attendance.attendance_sessions WHERE id=$1',[sessionId])).rows[0];
    if (session && (session.group_id!==groupId||session.created_by!==demo.teacherId)) throw new Error('Local catalog session scope is already occupied');
    const created=await db.query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by)
      VALUES($1,$2,$3::timestamptz-interval '1 minute',$3::timestamptz+interval '1 hour',$4) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [sessionId,groupId,now,demo.teacherId]);
    if (created.rows.length) await db.query('SELECT attendance.open_session($1,$2)',[sessionId,demo.teacherId]);
    sessions.push({courseId:course.id,groupId,sessionId});
  }
  return {courses:catalog.courses.length,students:roster.length,sampleStudents:catalog.students.length,
    teamStudents:team.length,memberships:catalog.courses.length*roster.length,sessions};
}
