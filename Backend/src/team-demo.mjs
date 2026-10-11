import {randomUUID} from 'node:crypto';
import {teamReferences} from '../scripts/import-team-references.mjs';
export function createTeamDemo({pool,faceWorker,fail,fields,enabled}) {
 const guests=new Map();
 return async function({user,body,action='detect'}) {
  if(!enabled)fail(404,'not_found','Team camera is available only in local demo mode');
  if(!['teacher','admin'].includes(user.role))fail(403,'staff_required','Staff access required');
  await pool.query('SELECT attendance.require_group_manager($1,$2)',[user.id,teamReferences.groupId]);
  const now=Date.now();
  for(const [id,guest] of guests)if(guest.expiresAt<=now){await faceWorker.request({action:'demo_delete',groupId:guest.owner,personId:id});guests.delete(id);}
  const own=()=>Array.from(guests.values()).filter(guest=>guest.owner===user.id);
  if(action==='list')return {participants:own().map(({id,name,expiresAt})=>({id,name,expiresAt}))};
  if(action==='add'){
   fields(body,['image','name','consent'],['image','name','consent']);
   if(body.consent!==true)fail(400,'consent_required','Participant consent is required');
   if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>60)fail(400,'invalid_name','Enter a display name of 1-60 characters');
   if(typeof body.image!=='string'||body.image.length>350000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))fail(400,'invalid_image','A camera image is required');
   if(own().length>=5||guests.size>=64)fail(409,'guest_limit','Temporary participant limit reached');
   const id='guest_'+randomUUID();await faceWorker.request({action:'demo_enroll',groupId:user.id,personId:id,image:body.image});
   const guest={id,name:body.name.trim(),owner:user.id,expiresAt:now+3600000};guests.set(id,guest);
   return {participant:{id,name:guest.name,expiresAt:guest.expiresAt}};
  }
  if(action==='delete'){
   fields(body,['id'],['id']);const guest=guests.get(body.id);
   if(!guest||guest.owner!==user.id)fail(404,'not_found','Temporary participant not found');
   await faceWorker.request({action:'demo_delete',groupId:user.id,personId:guest.id});guests.delete(guest.id);return {deleted:true};
  }
  fields(body,['image','consent','activeReferences'],['image','consent']);
  if(body.consent!==true)fail(400,'consent_required','All participants must consent to the team demo');
  const keys=teamReferences.members.map(member=>member.key);
  if(body.activeReferences!==undefined && (!Array.isArray(body.activeReferences)||body.activeReferences.length>4||new Set(body.activeReferences).size!==body.activeReferences.length||body.activeReferences.some(key=>!keys.includes(key))))fail(400,'invalid_demo','Choose only known team references, without duplicates');
  if(typeof body.image!=='string'||body.image.length>350000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))fail(400,'invalid_image','A camera image is required');
  await pool.query('SELECT attendance.require_group_manager($1,$2)',[user.id,teamReferences.groupId]);
  const mappings=(await pool.query(`SELECT r.reference_key,r.person_id,p.full_name FROM attendance.team_face_references r JOIN attendance.people p ON p.id=r.person_id WHERE r.group_id=$1 AND r.reference_key=ANY($2::text[]) AND r.is_active AND p.is_active`,[teamReferences.groupId,keys])).rows;
  if(mappings.length!==4)fail(409,'team_not_ready','Import the four team references before using this camera; see Backend/README.md');
  const active=mappings.filter(r=>(body.activeReferences??keys).includes(r.reference_key));
  const temporary=own();
  const result=await faceWorker.request({action:'detect',groupId:teamReferences.groupId,allowedIds:active.map(r=>r.person_id).concat(temporary.map(g=>g.id)),demoScope:user.id,referenceMappings:active.map(r=>({referenceKey:r.reference_key,personId:r.person_id})),image:body.image});
  return {faces:result.matches.map(match=>{
   const person=active.find(r=>r.person_id===match.studentId && r.reference_key===match.referenceKey) || temporary.find(g=>g.id===match.studentId && g.id===match.referenceKey);
   return {box:match.box,name:person?.full_name||person?.name||'Unknown',similarity:person&&Number.isFinite(match.similarity)?match.similarity:null};
  })};
 };
}
