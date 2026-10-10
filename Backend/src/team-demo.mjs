import {teamReferences} from '../scripts/import-team-references.mjs';
export function createTeamDemo({pool,faceWorker,fail,fields,enabled}) {
 return async function({user,body}) {
  if(!enabled)fail(404,'not_found','Team camera is available only in local demo mode');
  if(!['teacher','admin'].includes(user.role))fail(403,'staff_required','Staff access required');
  fields(body,['image','consent','activeReferences'],['image','consent']);
  if(body.consent!==true)fail(400,'consent_required','All participants must consent to the team demo');
  const keys=teamReferences.members.map(member=>member.key);
  if(body.activeReferences!==undefined && (!Array.isArray(body.activeReferences)||body.activeReferences.length>4||new Set(body.activeReferences).size!==body.activeReferences.length||body.activeReferences.some(key=>!keys.includes(key))))fail(400,'invalid_demo','Choose only known team references, without duplicates');
  if(typeof body.image!=='string'||body.image.length>350000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))fail(400,'invalid_image','A camera image is required');
  await pool.query('SELECT attendance.require_group_manager($1,$2)',[user.id,teamReferences.groupId]);
  const mappings=(await pool.query(`SELECT r.reference_key,r.person_id,p.full_name FROM attendance.team_face_references r JOIN attendance.people p ON p.id=r.person_id WHERE r.group_id=$1 AND r.reference_key=ANY($2::text[]) AND r.is_active AND p.is_active`,[teamReferences.groupId,keys])).rows;
  if(mappings.length!==4)fail(409,'team_not_ready','Import the four team references before using this camera; see Backend/README.md');
  const active=mappings.filter(r=>(body.activeReferences??keys).includes(r.reference_key));
  const result=await faceWorker.request({action:'detect',groupId:teamReferences.groupId,allowedIds:active.map(r=>r.person_id),referenceMappings:active.map(r=>({referenceKey:r.reference_key,personId:r.person_id})),image:body.image});
  return {faces:result.matches.map(match=>{
   const person=active.find(r=>r.person_id===match.studentId && r.reference_key===match.referenceKey);
   return {box:match.box,name:person?.full_name||'Unknown',similarity:person&&Number.isFinite(match.similarity)?match.similarity:null};
  })};
 };
}
