import {transaction} from './database.mjs';

export const passengerGroupId='f3102026-0000-4000-8000-000000000001';
const roster=[
  {id:'f3102026-0000-4000-8000-000000000101',name:'Leo',referenceKey:'team_leo'},
  {id:'f3102026-0000-4000-8000-000000000102',name:'Rebbeca',referenceKey:'team_rebbeca'},
  {id:'f3102026-0000-4000-8000-000000000103',name:'Olivia',referenceKey:'team_olivia'}
];

// Identity suggestions for this explicitly enrolled passenger roster only.
// Camera frames are transient; this API never writes attendance or alert data.
export function createPassengerApi({pool,faceWorker,fail,fields}) {
  return async ({method,path,user,body})=>{
    if(!['teacher','admin'].includes(user.role))fail(403,'forbidden','Passenger recognition requires a teacher or administrator');
    if(!((path==='/api/passengers'&&method==='GET')||(path==='/api/passengers/detect'&&method==='POST')))
      fail(405,'method_not_allowed','Method not allowed');
    if(method==='POST'){
      fields(body,['image'],['image']);
      if(typeof body.image!=='string'||body.image.length>350000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))
        fail(400,'invalid_image','A base64 JPEG camera frame is required');
      const jpeg=Buffer.from(body.image,'base64');
      if(jpeg.length<3||jpeg[0]!==255||jpeg[1]!==216||jpeg[2]!==255)
        fail(400,'invalid_image','A base64 JPEG camera frame is required');
    }
    const rows=await transaction(pool,async db=>{
      await db.query('SELECT attendance.require_group_manager($1,$2)',[user.id,passengerGroupId]);
      return (await db.query(`SELECT d.person_id,d.name,d.reference_key FROM demo.passengers d
        JOIN attendance.people p ON p.id=d.person_id
        JOIN attendance.team_face_references r ON r.reference_key=d.reference_key AND r.person_id=d.person_id
        JOIN attendance.groups g ON g.id=r.group_id
        WHERE d.is_active AND p.is_active AND r.is_active AND g.is_active AND r.group_id=$1
          AND d.person_id=ANY($2::uuid[]) ORDER BY d.name`,[passengerGroupId,roster.map(person=>person.id)])).rows;
    },{readOnly:true});
    // Enforce exact key/name/id bindings even if a database row was changed.
    const passengers=roster.filter(person=>rows.some(row=>row.person_id===person.id&&row.reference_key===person.referenceKey&&row.name===person.name));
    if(method==='GET')return {groupId:passengerGroupId,passengers:passengers.map(({id,name})=>({id,name,role:'passenger'}))};
    if(!passengers.length)fail(503,'passenger_references_unavailable','Saved passenger references are unavailable');
    let result;
    try{
      result=await faceWorker.request({action:'detect',groupId:passengerGroupId,image:body.image,
        allowedIds:passengers.map(person=>person.id),referenceMappings:passengers.map(person=>({referenceKey:person.referenceKey,personId:person.id}))});
    }catch(error){fail(error.status||503,error.code||'face_service_unavailable',error.message||'Face service unavailable');}
    if(!Array.isArray(result?.matches)||!Number.isInteger(result.registeredReferences)||result.registeredReferences!==passengers.length)
      fail(503,'face_service_unavailable','Saved passenger recognition is unavailable');
    return {registeredReferences:result.registeredReferences,matches:result.matches.map(match=>{
      const person=match.identityMatched===true?passengers.find(person=>person.id===match.studentId&&person.referenceKey===match.referenceKey):null;
      const box=match.box;
      const validBox=box&&['x','y','width','height'].every(key=>typeof box[key]==='number'&&Number.isFinite(box[key])&&box[key]>=0&&box[key]<=1);
      return {passengerId:person?.id??null,name:person?.name??null,role:'passenger',
        similarity:typeof match.similarity==='number'&&Number.isFinite(match.similarity)?match.similarity:null,
        box:validBox?{x:box.x,y:box.y,width:box.width,height:box.height}:null,identityMatched:Boolean(person)};
    })};
  };
}
