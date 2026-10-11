import {readFile} from 'node:fs/promises';
import {request as registryRequest} from 'node:http';
import {createSubjectRegistryClient} from '../src/subject-registry-client.mjs';
import {openLocalDatabase} from './local-demo.mjs';
import {createApp} from '../src/server.mjs';
import {pickupConfiguration} from '../src/pickup-demo.mjs';
import {createFaceWorker} from '../src/face-worker.mjs';
import {createDemoAlerts} from '../src/demo-alerts.mjs';
const {pool}=await openLocalDatabase(new URL('../.runpod/pgdata/',import.meta.url).pathname);
const publicOrigin='https://lls3utct362n0w-8888.proxy.runpod.net';
const credentials=JSON.parse(await readFile(new URL('../.runpod/presentation-login.json',import.meta.url),'utf8'));
const faceWorker=createFaceWorker({python:'/opt/presence-venv/bin/python'});
const demoAlerts=createDemoAlerts({pool});
await demoAlerts.start();
const pickupSettings=pickupConfiguration({...process.env,
 PICKUP_DEMO_ENABLED:process.env.PICKUP_DEMO_ENABLED??'true',
 PICKUP_LEO_ID:'f3102026-0000-4000-8000-000000000101',
 PICKUP_REBECA_ID:'f3102026-0000-4000-8000-000000000102',
 PICKUP_ANTHONY_ID:'f3102026-0000-4000-8000-000000000100'});
const registryConfig=JSON.parse(await readFile(new URL('../../SubjectRegistry/.local-db/service-config.json',import.meta.url),'utf8'));
const subjectRegistry=createSubjectRegistryClient({url:'http://127.0.0.1:3002',readKey:registryConfig.readerKey});
const server=createApp({subjectRegistry,pool,publicOrigin,secureCookies:true,syntheticCamera:false,faceWorker,demoAlerts,pickupSettings});
server.on('close',()=>demoAlerts.stop());
const appHandler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',async(req,res)=>{
 const requestUrl=new URL(req.url,publicOrigin),path=requestUrl.pathname;
 if(path.startsWith('/api/subject-registry/')){
  const upstreamPath='/api/'+path.slice('/api/subject-registry/'.length);
  if(!/^\/api\/subjects(?:\/detect|\/external\/[A-Za-z0-9._-]{1,128}(?:\/references)?)?$/.test(upstreamPath)){res.writeHead(404);res.end();return;}
  const upstream=registryRequest({hostname:'127.0.0.1',port:3002,path:upstreamPath+requestUrl.search,method:req.method,headers:{'X-API-Key':req.headers['x-api-key']??'','Content-Type':req.headers['content-type']??'application/json'}},reply=>{
   res.writeHead(reply.statusCode,{'Content-Type':'application/json','Cache-Control':'no-store'});reply.pipe(res);
  });
  upstream.setTimeout(60000,()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'registry_unavailable',message:'Subject registry unavailable'}}));});
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream);return;
 }
 if(path==='/api/presentation-login'){
  const reject=(status,message)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:{message}}));};
  if(req.method!=='POST')return reject(405,'Method not allowed');
  if(req.headers.origin!==publicOrigin)return reject(403,'Request must come from this application');
  if(!(req.headers['content-type']||'').startsWith('application/json'))return reject(415,'JSON required');
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>64)return reject(413,'Request too large');}
   const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return reject(400,'Unsupported fields');
   const response=await fetch('http://127.0.0.1:8888/api/login',{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
   const result=await response.json();
   if(response.ok&&result.user?.role!=='teacher')return reject(403,'Professor workspace unavailable');
   const headers={'Content-Type':'application/json','Cache-Control':'no-store'};
   const cookie=response.headers.get('set-cookie');if(cookie&&response.ok)headers['Set-Cookie']=cookie;
   res.writeHead(response.status,headers);res.end(JSON.stringify(result));
  }catch{return reject(503,'Professor workspace unavailable');}
  return;
 }
 if(['GET','HEAD'].includes(req.method)&&path==='/'){res.writeHead(303,{Location:'/login.html','Cache-Control':'no-store'});res.end();return;}
 appHandler(req,res);
});
server.listen(8888,'0.0.0.0',()=>console.log('Presence presentation ready on port 8888'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{demoAlerts.stop();server.close(async()=>{await pool.end();process.exit(0);});});
