import {transaction} from './database.mjs';

export const subjectApps=['subject-finder','attendance','parent-child'];

// Only attendance authorization belongs here. The registry owns subjects and
// biometrics, and this adapter accesses them exclusively through HTTP.
export function createSubjectsApi({pool,fail,fields,uuid,subjectRegistry}) {
 const appCheck=app=>{if(!subjectApps.includes(app))fail(400,'invalid_app','Choose a supported application');return app;};
 const jpeg=image=>{
  if(typeof image!=='string'||image.length>350000||!/^[A-Za-z0-9+/]+={0,2}$/.test(image))fail(400,'invalid_image','A base64 JPEG is required');
  const bytes=Buffer.from(image,'base64');
  if(bytes.length<100||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail(400,'invalid_image','A base64 JPEG is required');
 };
 async function remote(operation) {
  if(!subjectRegistry)fail(503,'subject_registry_unavailable','Subject registry is unavailable');
  try{return await operation();}
  catch(error){fail(error.status||503,error.code||'subject_registry_unavailable',error.message||'Subject registry is unavailable');}
 }
 async function ui({method,path,user,body,url}) {
  if(!['teacher','admin'].includes(user.role))fail(403,'forbidden','Subjects require a teacher or administrator');
  if(path==='/api/subjects'&&method==='GET') {
   if([...url.searchParams.keys()].some(k=>k!=='app')||url.searchParams.getAll('app').length!==1)fail(400,'invalid_app','Specify one application');
   const app=appCheck(url.searchParams.get('app'));
   return remote(()=>subjectRegistry.catalog(app));
  }
  if(path!=='/api/subjects/detect'||method!=='POST')fail(405,'method_not_allowed','Method not allowed');
  fields(body,['app','image','groupId'],['app','image']);
  const app=appCheck(body.app);jpeg(body.image);
  if(body.groupId!==undefined) {
   uuid(body.groupId);
   await transaction(pool,db=>db.query('SELECT attendance.require_group_manager($1,$2)',[user.id,body.groupId]),{readOnly:true});
  }
  const result=await remote(()=>subjectRegistry.detect({app,image:body.image}));
  const ids=[...new Set(result.matches.filter(m=>m.identityMatched).map(m=>m.subjectId))];
  // UUID equality is a stable identity binding. Names and source external IDs
  // never select an attendance person. A roster only limits optional mapping.
  const people=ids.length?(await pool.query(`SELECT p.id FROM attendance.people p WHERE p.is_active AND p.id=ANY($1::uuid[])
   AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM attendance.group_memberships m WHERE m.person_id=p.id AND m.group_id=$2 AND m.left_at IS NULL))`,[ids,body.groupId??null])).rows:[];
  const mapped=new Set(people.map(p=>p.id));
  return {...result,matches:result.matches.map(match=>({...match,personId:match.identityMatched&&mapped.has(match.subjectId)?match.subjectId:null,
   message:match.identityMatched?'Got you, '+match.name:null}))};
 }
 return {ui};
}
