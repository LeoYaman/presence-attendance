import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {transaction} from './database.mjs';
export const subjectApps=['subject-finder','attendance','parent-child'];
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const appsValid=apps=>Array.isArray(apps)&&apps.length>0&&new Set(apps).size===apps.length&&apps.every(a=>subjectApps.includes(a));
const lock=db=>db.query('SELECT version FROM registry.catalog_version WHERE singleton FOR UPDATE');
const increment=async db=>Number((await db.query('UPDATE registry.catalog_version SET version=version+1 WHERE singleton RETURNING version')).rows[0].version);
async function enforceCapacity(db){
 const capacity=(await db.query('SELECT count(*)::int AS n,coalesce(sum(octet_length(r.image_bytes)),0)::bigint AS bytes FROM registry.face_references r JOIN registry.subjects s ON s.id=r.subject_id JOIN registry.sources src ON src.id=s.source_id WHERE r.is_active AND s.is_active AND src.is_active')).rows[0];
 if(capacity.n>100||Number(capacity.bytes)>12000000)fail(409,'reference_capacity','Recognition supports up to 100 active references and 12 MB');
}
async function audit(db,{sourceId=null,subjectId=null,action,version,snapshot}){await db.query('INSERT INTO registry.audit(source_id,subject_id,action,version,snapshot) VALUES($1,$2,$3,$4,$5)',[sourceId,subjectId,action,version,JSON.stringify(snapshot)]);}
function expiry(value){if(value!==null&&(!Number.isFinite(Date.parse(value))||Date.parse(value)<=Date.now()))throw new Error('Key expiry must be in the future');}
export async function provisionSubjectKey(pool,{name,apps,expiresAt=null}) {
 if(typeof name!=='string'||!name.trim()||name.length>120||(apps!==undefined&&!appsValid(apps)))throw new Error('Invalid source configuration');expiry(expiresAt);
 const key='registry_write_'+randomBytes(32).toString('hex');
 const source=await transaction(pool,async db=>{
  await lock(db);const existing=(await db.query('SELECT * FROM registry.sources WHERE name=$1 FOR UPDATE',[name.trim()])).rows[0];
  const allowed=apps??existing?.allowed_apps??subjectApps;
  const changed=existing&&JSON.stringify([...existing.allowed_apps].sort())!==JSON.stringify([...allowed].sort());
  const row=(await db.query('INSERT INTO registry.sources(name,allowed_apps) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET allowed_apps=excluded.allowed_apps RETURNING *',[name.trim(),allowed])).rows[0];
  await db.query("INSERT INTO registry.api_keys(source_id,key_hash,privilege,expires_at) VALUES($1,$2,'write',$3)",[row.id,digest(key),expiresAt]);
  const version=changed?await increment(db):Number((await db.query('SELECT version FROM registry.catalog_version WHERE singleton')).rows[0].version);
  await audit(db,{sourceId:row.id,action:changed?'source_scope':'provision_write_key',version,snapshot:{name:row.name,apps:allowed}});
  return row;
 });return {sourceId:source.id,key};
}
export async function provisionReaderKey(pool,{apps=subjectApps,expiresAt=null}={}) {
 if(!appsValid(apps))throw new Error('Invalid reader scope');expiry(expiresAt);const key='registry_read_'+randomBytes(32).toString('hex');
 await transaction(pool,async db=>{await lock(db);await db.query("INSERT INTO registry.api_keys(key_hash,privilege,allowed_apps,expires_at) VALUES($1,'read',$2,$3)",[digest(key),apps,expiresAt]);});return {key};
}
export async function revokeSubjectKey(pool,key) {
 return transaction(pool,async db=>{await lock(db);const keyRow=(await db.query('UPDATE registry.api_keys SET is_active=false WHERE key_hash=$1 AND is_active RETURNING source_id',[digest(key)])).rows[0];if(!keyRow)return false;const version=await increment(db);await audit(db,{sourceId:keyRow.source_id,action:'revoke_key',version,snapshot:{revoked:true}});return true;});
}
export async function setSubjectSourceActive(pool,sourceId,active) {
 if(typeof active!=='boolean')throw new Error('Active must be boolean');
 return transaction(pool,async db=>{await lock(db);const row=(await db.query('UPDATE registry.sources SET is_active=$1 WHERE id=$2 AND is_active<>$1 RETURNING id,name',[active,sourceId])).rows[0];if(!row)return false;await enforceCapacity(db);const version=await increment(db);await audit(db,{sourceId,action:active?'source_activate':'source_revoke',version,snapshot:{name:row.name,active}});return true;});
}
function jpeg(image) {
 if(typeof image!=='string'||image.length>350000||!/^[A-Za-z0-9+/]+={0,2}$/.test(image))fail(400,'invalid_image','A base64 JPEG is required');
 const bytes=Buffer.from(image,'base64');if(bytes.length<100||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217||bytes.toString('base64')!==image)fail(400,'invalid_image','A complete base64 JPEG is required');return bytes;
}
function fields(body,allowed,required=[]) {if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k))||required.some(k=>body[k]===undefined))fail(400,'invalid_body','Unexpected or missing fields');}
export function createSubjectsApi({pool,faceWorker,readerKeyHash=null}) {
 async function worker(request){try{return await faceWorker.request(request);}catch(e){fail(e.status||503,e.code||'face_service_unavailable',e.message||'Face service unavailable');}}
 async function readKey(db,key,app){
  if(typeof key!=='string'||!/^registry_read_[a-f0-9]{64}$/.test(key))fail(401,'invalid_api_key','A read API key is required');
  const hash=digest(key);
  // Optional pin narrows the database-backed reader credential; it cannot bypass revocation or scope.
  if(readerKeyHash&&(!/^[a-f0-9]{64}$/.test(readerKeyHash)||!timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(readerKeyHash,'hex'))))fail(401,'invalid_api_key','A valid read API key is required');
  const row=(await db.query("SELECT allowed_apps FROM registry.api_keys WHERE key_hash=$1 AND privilege='read' AND is_active AND (expires_at IS NULL OR expires_at>now())",[hash])).rows[0];
  if(!row)fail(401,'invalid_api_key','A valid read API key is required');if(!row.allowed_apps.includes(app))fail(403,'app_scope_denied','Reader does not have application access');
 }
 async function writeKey(db,key){
  if(typeof key!=='string'||!/^registry_write_[a-f0-9]{64}$/.test(key))fail(401,'invalid_api_key','A write API key is required');
  const row=(await db.query("SELECT src.* FROM registry.api_keys k JOIN registry.sources src ON src.id=k.source_id WHERE k.key_hash=$1 AND k.privilege='write' AND k.is_active AND src.is_active AND (k.expires_at IS NULL OR k.expires_at>now())",[digest(key)])).rows[0];
  if(!row)fail(401,'invalid_api_key','A valid write API key is required');return row;
 }
 async function catalog(db,app){
  const version=Number((await db.query('SELECT version FROM registry.catalog_version WHERE singleton')).rows[0].version);
  const subjects=(await db.query(`SELECT s.id,s.name,s.external_id,(SELECT count(*)::int FROM registry.face_references r WHERE r.subject_id=s.id AND r.is_active) AS reference_count
   FROM registry.subjects s JOIN registry.sources src ON src.id=s.source_id JOIN registry.app_access a ON a.subject_id=s.id
   WHERE s.is_active AND src.is_active AND a.app=$1 AND $1=ANY(src.allowed_apps) ORDER BY s.name,s.id`,[app])).rows.map(r=>({id:r.id,name:r.name,externalId:r.external_id,referenceCount:r.reference_count}));return {version,subjects};
 }
 async function external({key,method,externalId,references=false,body={},subjectId}) {
  if(!/^[A-Za-z0-9._-]{1,128}$/.test(externalId))fail(400,'invalid_external_id','Invalid external identity');
  if(references?method!=='POST':!['PUT','PATCH','DELETE'].includes(method))fail(405,'method_not_allowed','Method not allowed');
  if(subjectId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId))fail(400,'invalid_subject_id','Invalid subject identity');
  const source=await writeKey(pool,key);
  fields(body,references?['image']:method==='DELETE'?[]:['name','active','apps','image'],references?['image']:method==='PUT'?['name']:[]);
  if(body.name!==undefined&&(typeof body.name!=='string'||!body.name.trim()||body.name.length>120))fail(400,'invalid_name','Name must contain 1 to 120 characters');
  if(body.active!==undefined&&typeof body.active!=='boolean')fail(400,'invalid_body','Active must be boolean');
  if(body.apps!==undefined&&(!Array.isArray(body.apps)||new Set(body.apps).size!==body.apps.length||body.apps.some(a=>!source.allowed_apps.includes(a))))fail(403,'app_scope_denied','Application access exceeds source scope');
  const bytes=body.image!==undefined?jpeg(body.image):null;if(bytes){const result=await worker({action:'validate-reference',image:body.image});if(result?.valid!==true)fail(422,'invalid_face_frame','Reference validation failed');}
  return transaction(pool,async db=>{
   await lock(db);const freshSource=await writeKey(db,key);await db.query('SELECT id FROM registry.sources WHERE id=$1 FOR UPDATE',[freshSource.id]);
   if(body.apps?.some(app=>!freshSource.allowed_apps.includes(app)))fail(403,'app_scope_denied','Application access exceeds source scope');
   let subject=(await db.query('SELECT * FROM registry.subjects WHERE source_id=$1 AND external_id=$2 FOR UPDATE',[freshSource.id,externalId])).rows[0];
   if(method==='DELETE'){
    if(!subject)fail(404,'not_found','Subject does not exist');const snapshot={externalId:subject.external_id,name:subject.name,active:subject.is_active};
    await db.query('DELETE FROM registry.subjects WHERE id=$1',[subject.id]);const version=await increment(db);await audit(db,{sourceId:freshSource.id,subjectId:subject.id,action:'delete',version,snapshot});return {version,deleted:true,subject:{id:subject.id,externalId}};
   }
   if(!subject){if(references||method==='PATCH')fail(404,'not_found','Subject does not exist');subject=(await db.query('INSERT INTO registry.subjects(id,source_id,external_id,name,is_active) VALUES(coalesce($1::uuid,gen_random_uuid()),$2,$3,$4,$5) RETURNING *',[subjectId??null,freshSource.id,externalId,body.name.trim(),body.active??true])).rows[0];}
   else {if(subjectId&&subjectId!==subject.id)fail(409,'subject_identity_conflict','Existing subject identity differs');subject=(await db.query('UPDATE registry.subjects SET name=$1,is_active=$2,updated_at=now() WHERE id=$3 RETURNING *',[body.name?.trim()??subject.name,body.active??subject.is_active,subject.id])).rows[0];}
   if(!references&&(body.apps!==undefined||method==='PUT')){await db.query('DELETE FROM registry.app_access WHERE subject_id=$1',[subject.id]);for(const app of body.apps??freshSource.allowed_apps)await db.query('INSERT INTO registry.app_access VALUES($1,$2)',[subject.id,app]);}
   if(bytes)await db.query('INSERT INTO registry.face_references(subject_id,image_sha256,image_bytes) VALUES($1,$2,$3) ON CONFLICT(subject_id,image_sha256) DO UPDATE SET is_active=true',[subject.id,digest(bytes),bytes]);
   await enforceCapacity(db);
   const version=await increment(db);await db.query('UPDATE registry.sources SET last_success_at=now() WHERE id=$1',[freshSource.id]);
   await audit(db,{sourceId:freshSource.id,subjectId:subject.id,action:references?'reference':subject.is_active?'upsert':'deactivate',version,snapshot:{externalId:subject.external_id,name:subject.name,active:subject.is_active,apps:body.apps??null,imageSha256:bytes?digest(bytes):null}});
   return {version,subject:{id:subject.id,name:subject.name,active:subject.is_active,externalId:subject.external_id}};
  });
 }
 function appCheck(app){if(!subjectApps.includes(app))fail(400,'invalid_app','Choose a supported application');return app;}
 async function list({key,app}){appCheck(app);return transaction(pool,async db=>{await readKey(db,key,app);return catalog(db,app);},{readOnly:true});}
 async function detect({key,body}) {
  fields(body,['app','image'],['app','image']);const app=appCheck(body.app);jpeg(body.image);
  const loaded=await transaction(pool,async db=>{await readKey(db,key,app);const c=await catalog(db,app);const refs=(await db.query('SELECT id,subject_id,image_bytes FROM registry.face_references WHERE is_active AND subject_id=ANY($1::uuid[])',[c.subjects.map(s=>s.id)])).rows;return {...c,refs};},{readOnly:true});
  const result=await worker({action:'detect',groupId:'registry:'+app,image:body.image,allowedIds:loaded.subjects.map(s=>s.id),subjectsVersion:loaded.version,subjectReferences:loaded.refs.map(r=>({subjectId:r.subject_id,referenceId:r.id,image:Buffer.from(r.image_bytes).toString('base64')}))});
  if(!Array.isArray(result?.matches))fail(503,'face_service_unavailable','Recognition returned an invalid response');
  const current=await list({key,app});const fresh=current.version===loaded.version;
  return {version:current.version,registeredReferences:result.registeredReferences,matches:result.matches.map(m=>{
   const s=fresh&&m.identityMatched===true?loaded.subjects.find(s=>s.id===(m.subjectId??m.studentId)&&current.subjects.some(now=>now.id===s.id)):null;
   const b=m.box,box=b&&['x','y','width','height'].every(k=>Number.isFinite(b[k])&&b[k]>=0&&b[k]<=1)&&b.x+b.width<=1&&b.y+b.height<=1?{x:b.x,y:b.y,width:b.width,height:b.height}:null;
   return {subjectId:s?.id??null,name:s?.name??null,identityMatched:Boolean(s),box,similarity:Number.isFinite(m.similarity)?m.similarity:null,message:s?'Got you, '+s.name:null};
  })};
 }
 return {external,list,detect};
}
export async function seedOlivia(pool,{faceWorker,image,subjectId,writeKey}) {
 return createSubjectsApi({pool,faceWorker}).external({key:writeKey,method:'PUT',externalId:'team_olivia',subjectId,body:{name:'Olivia',apps:subjectApps,image}});
}
