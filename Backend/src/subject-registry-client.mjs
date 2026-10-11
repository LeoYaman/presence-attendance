import {subjectApps} from './subjects.mjs';

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validName=value=>typeof value==='string'&&value.trim().length>0&&value.length<=120;
const validVersion=value=>Number.isSafeInteger(value)&&value>=0;
function unavailable(code='subject_registry_unavailable',message='Subject registry is unavailable') {
 const error=new Error(message);error.status=503;error.code=code;return error;
}
function invalidResponse(){throw unavailable('subject_registry_invalid_response','Subject registry returned an invalid response');}
function catalogView(body) {
 if(!body||!validVersion(body.version)||!Array.isArray(body.subjects)||body.subjects.length>10000)invalidResponse();
 const seen=new Set();
 const subjects=body.subjects.map(s=>{
  if(!s||!idPattern.test(s.id??'')||!validName(s.name)||!Number.isSafeInteger(s.referenceCount)||s.referenceCount<0||seen.has(s.id))invalidResponse();
  seen.add(s.id);return {id:s.id,name:s.name,referenceCount:s.referenceCount};
 });
 return {version:body.version,subjects};
}
function detectionView(body) {
 if(!body||!validVersion(body.version)||!Number.isSafeInteger(body.registeredReferences)||body.registeredReferences<0||!Array.isArray(body.matches)||body.matches.length>100)invalidResponse();
 const matches=body.matches.map(m=>{
  if(!m||typeof m.identityMatched!=='boolean'||(m.identityMatched&&(!idPattern.test(m.subjectId??'')||!validName(m.name))))invalidResponse();
  const box=m.box;
  if(box!==null&&box!==undefined&&(!box||!['x','y','width','height'].every(k=>Number.isFinite(box[k])&&box[k]>=0&&box[k]<=1)))invalidResponse();
  if(m.similarity!==null&&m.similarity!==undefined&&!Number.isFinite(m.similarity))invalidResponse();
  return {subjectId:m.identityMatched?m.subjectId:null,name:m.identityMatched?m.name:null,identityMatched:m.identityMatched,
   box:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null,similarity:m.similarity??null,message:m.identityMatched?'Got you, '+m.name:null};
 });
 return {version:body.version,registeredReferences:body.registeredReferences,matches};
}

export function createSubjectRegistryClient({url,readKey,timeoutMs=15000,maxResponseBytes=1000000}={}) {
 let base;
 try{base=new URL(url);}catch{throw new Error('A valid SUBJECT_REGISTRY_URL is required');}
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/'||
   (base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw new Error('Subject registry requires HTTPS or loopback HTTP');
 if(typeof readKey!=='string'||!/^registry_read_[a-f0-9]{64}$/.test(readKey))throw new Error('A valid SUBJECT_REGISTRY_READ_KEY is required');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1)throw new Error('Invalid subject registry client limits');
 async function request(path,body) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
  try {
   const response=await fetch(new URL(path,base),{method:body?'POST':'GET',redirect:'error',signal:controller.signal,
    headers:{'X-API-Key':readKey,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
   if(Number(response.headers.get('content-length'))>maxResponseBytes){controller.abort();throw unavailable('subject_registry_response_too_large','Subject registry response is too large');}
   const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.length;if(size>maxResponseBytes){controller.abort();throw unavailable('subject_registry_response_too_large','Subject registry response is too large');}chunks.push(chunk);}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{invalidResponse();}
   if(!response.ok) {
    // Credentials and internal registry diagnostics stay on the server.
    if([400,413,422,429].includes(response.status)&&typeof data?.error?.code==='string'&&typeof data?.error?.message==='string') {
     const error=new Error(data.error.message);error.status=response.status;error.code=data.error.code;throw error;
    }
    throw unavailable();
   }
   return data;
  }catch(error){
   if(error.status)throw error;
   if(controller.signal.aborted)throw unavailable('subject_registry_timeout','Subject registry request timed out');
   throw unavailable();
  }finally{clearTimeout(timer);}
 }
 return {
  async catalog(app){if(!subjectApps.includes(app))throw new Error('Invalid registry application');return catalogView(await request('/api/subjects?app='+encodeURIComponent(app)));},
  async detect({app,image}){if(!subjectApps.includes(app))throw new Error('Invalid registry application');return detectionView(await request('/api/subjects/detect',{app,image}));}
 };
}
