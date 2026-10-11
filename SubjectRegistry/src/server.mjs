import {createServer} from 'node:http';
import {createSubjectsApi,fail} from './subjects.mjs';

export function createRegistryServer({pool,faceWorker,readerKeyHash=null}) {
 const api=createSubjectsApi({pool,faceWorker,readerKeyHash}),attempts=new Map();
 async function body(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))fail(415,'unsupported_media_type','Use application/json');
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>360000)fail(413,'body_too_large','Request exceeds upload limit');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'invalid_json','A JSON object is required');}
 }
 return createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try {
   const url=new URL(req.url,'http://registry.invalid'),path=url.pathname,key=req.headers['x-api-key'];let result;
   if(!['/api/subjects','/api/subjects/detect'].includes(path)&&!path.startsWith('/api/subjects/external/'))fail(404,'not_found','Route not found');
   const address=req.socket.remoteAddress??'unknown',now=Date.now();for(const [id,value] of attempts)if(value.reset<=now)attempts.delete(id);
   if(!attempts.has(address)&&attempts.size>=10000)fail(429,'rate_limited','Try later');
   const limits=attempts.get(address)??{count:0,reset:now+60000};attempts.set(address,limits);if(++limits.count>300)fail(429,'rate_limited','Too many registry requests');
   if(path==='/api/subjects'){
    if(req.method!=='GET')fail(405,'method_not_allowed','Method not allowed');
    if([...url.searchParams.keys()].some(k=>k!=='app')||url.searchParams.getAll('app').length!==1)fail(400,'invalid_app','Specify one application');
    result=await api.list({key,app:url.searchParams.get('app')});
   }else if(path==='/api/subjects/detect'){
    if(req.method!=='POST')fail(405,'method_not_allowed','Method not allowed');if(url.search)fail(400,'invalid_body','Unexpected query parameters');result=await api.detect({key,body:await body(req)});
   }else{
    const match=path.match(/^\/api\/subjects\/external\/([A-Za-z0-9._-]{1,128})(\/references)?$/);if(!match)fail(404,'not_found','Route not found');
    if(url.search)fail(400,'invalid_body','Unexpected query parameters');
    const payload=req.method==='DELETE'?{}:await body(req);
    if(req.method==='DELETE'&&(Number(req.headers['content-length'])>0||req.headers['transfer-encoding']))fail(400,'invalid_body','Deletion accepts no body');
    result=await api.external({key,method:req.method,externalId:match[1],references:Boolean(match[2]),body:payload});
   }
   res.writeHead(200);res.end(JSON.stringify(result));
  }catch(error){res.writeHead(error.status||500);res.end(JSON.stringify({error:{code:error.code??'registry_failure',message:error.status?error.message:'Subject registry request failed'}}));}
 });
}
