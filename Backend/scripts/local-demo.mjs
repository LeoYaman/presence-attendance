// Offline development only: persistent PostgreSQL-compatible PGlite, NOT TimescaleDB.
import {PGlite} from '@electric-sql/pglite';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {applyMigrations,verifySchema} from './migrations.mjs';
import {seedDemo,demo} from './seed-demo.mjs';
import {seedLocalCatalog} from './seed-local-catalog.mjs';
import {createApp} from '../src/server.mjs';
import {createSubjectRegistryClient} from '../src/subject-registry-client.mjs';
import {createDemoAlerts} from '../src/demo-alerts.mjs';
import {opaqueToken,tokenDigest,sessionCookie} from '../src/auth.mjs';

export function localDemoConfiguration(env=process.env) {
  const port=Number(env.LOCAL_DEMO_PORT??3000);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid local port');
  let publicOrigin=`http://localhost:${port}`;
  let tailscaleLogin=null;
  if(env.LOCAL_DEMO_PUBLIC_ORIGIN!==undefined) {
    const supplied=env.LOCAL_DEMO_PUBLIC_ORIGIN;
    let url;
    try{url=new URL(supplied);}catch{throw new Error('LOCAL_DEMO_PUBLIC_ORIGIN must be an HTTPS ts.net root origin');}
    if(typeof supplied!=='string'||url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(url.hostname)||
      (supplied!==url.origin&&supplied!==url.origin+'/'))
      throw new Error('LOCAL_DEMO_PUBLIC_ORIGIN must be an HTTPS ts.net root origin');
    tailscaleLogin=env.LOCAL_DEMO_TAILSCALE_LOGIN;
    if(typeof tailscaleLogin!=='string'||tailscaleLogin.length===0||tailscaleLogin.length>254||/\s|[\x00-\x1f\x7f]/.test(tailscaleLogin))
      throw new Error('LOCAL_DEMO_TAILSCALE_LOGIN must be a nonempty login of at most 254 characters');
    publicOrigin=url.origin;
  }
  return Object.freeze({port,publicOrigin,host:new URL(publicOrigin).host,secureCookies:tailscaleLogin!==null,tailscaleLogin});
}

export function authorizeLocalDemoRequest(req,configuration) {
  if(typeof req.headers.host!=='string'||req.headers.host!==configuration.host) return false;
  if(!configuration.secureCookies) return true;
  // Only the loopback Tailscale Serve proxy may supply the authenticated identity.
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  const login=req.headers['tailscale-user-login'];
  return typeof login==='string'&&login===configuration.tailscaleLogin;
}

export async function openLocalDatabase(dataDir) {
  await mkdir(dataDir,{recursive:true});
  const snapshot=join(dataDir,'database.tar');
  let saved;
  try{saved=new Blob([await readFile(snapshot)]);}catch(error){if(error.code!=='ENOENT')throw error;}
  // Memory runtime with atomic PostgreSQL data-directory snapshots avoids Windows FS reopen issues.
  const engine=new PGlite(saved?{loadDataDir:saved}:{});
  async function persist(){const blob=await engine.dumpDataDir(); await writeFile(snapshot+'.tmp',Buffer.from(await blob.arrayBuffer()));await rename(snapshot+'.tmp',snapshot);}
  const raw={query:async(sql,params)=>params ? engine.query(sql,params) : (await engine.exec(sql)).at(-1)};
  try {
    await applyMigrations(raw,{baseOnly:true});
    await raw.query('BEGIN');
    await raw.query('CREATE TABLE IF NOT EXISTS public.presence_local_migrations(name text PRIMARY KEY,checksum text NOT NULL)');
    for (const name of ['003_attendance_events.sql','004_auth_sessions.sql','005_future_absence_reporting.sql','006_face_datasets.sql','007_team_face_references.sql','008_session_successors.sql','009_admin_management.sql','010_demo_alerts.sql','011_demo_passengers.sql','012_demo_olivia_passenger.sql','013_shared_subjects.sql','014_external_subject_registry.sql']) {
      const source=await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8');
      const checksum=createHash('sha256').update(source).digest('hex');
      const prior=(await raw.query('SELECT checksum FROM public.presence_local_migrations WHERE name=$1',[name])).rows[0];
      if (prior) {if(prior.checksum!==checksum) throw new Error('Local migration changed: '+name); continue;}
      const sql=name.startsWith('003') ? source.replace(/DO \$\$[\s\S]*?\$\$;/,'').replace('CREATE EXTENSION IF NOT EXISTS timescaledb;','').replace(/^SELECT create_hypertable[^\n]+$/m,'') : source;
      await raw.query(sql);
      await raw.query('INSERT INTO public.presence_local_migrations VALUES($1,$2)',[name,checksum]);
    }
    await raw.query(`CREATE OR REPLACE FUNCTION public.time_bucket(width interval,stamp timestamptz) RETURNS timestamptz
      LANGUAGE SQL IMMUTABLE AS $$ SELECT date_bin(width,stamp,'2000-01-01'::timestamptz) $$;
      CREATE OR REPLACE FUNCTION public.time_bucket(width interval,stamp timestamptz,zone text) RETURNS timestamptz
      LANGUAGE SQL STABLE AS $$ SELECT date_bin(width,stamp AT TIME ZONE zone,'2000-01-01'::timestamp) AT TIME ZONE zone $$;`);
    await raw.query('COMMIT');
    await verifySchema(raw,{baseOnly:true});
    await persist();
  } catch(error) {await raw.query('ROLLBACK').catch(()=>{}); await engine.close(); throw error;}
  // Serialize all transactions and stand-alone queries on the embedded connection.
  let tail=Promise.resolve();
  async function acquire(){let release; const next=new Promise(resolve=>{release=resolve;}); const previous=tail; tail=next; await previous; return release;}
  const pool={
    async query(sql,params){const release=await acquire(); try{const result=await raw.query(sql,params);if(!/^\s*(SELECT|WITH|SHOW)\b/i.test(sql))await persist();return result;}finally{release();}},
    async connect(){
      const release=await acquire(); let readOnly=false;
      return {query:async(sql,params)=>{
        const result=await raw.query(sql,params);
        if(/^\s*BEGIN\b/i.test(sql))readOnly=/\bREAD\s+ONLY\b/i.test(sql);
        if(/^\s*SET\s+TRANSACTION\b/i.test(sql)&&/\bREAD\s+(ONLY|WRITE)\b/i.test(sql))readOnly=/\bREAD\s+ONLY\b/i.test(sql);
        if(/^\s*COMMIT\b/i.test(sql)&&!readOnly)await persist();
        return result;
      },release};
    },
    async end(){await tail; if(!engine.closed) await engine.close();}
  };
  return {pool,engine};
}

async function main(){
  if(process.env.NODE_ENV==='production') throw new Error('Local demo is forbidden in production');
  const configuration=localDemoConfiguration();
  const {port,publicOrigin,secureCookies}=configuration;
  const {pool}=await openLocalDatabase(fileURLToPath(new URL('../.local-db/pgdata/',import.meta.url)));
  let subjectRegistry;
  try {
    const registryConfig=JSON.parse(await readFile(new URL('../../SubjectRegistry/.local-db/service-config.json',import.meta.url),'utf8'));
    const readKey=process.env.SUBJECT_REGISTRY_READ_KEY??registryConfig.readerKey;
    if(typeof readKey==='string'&&readKey.length) subjectRegistry=createSubjectRegistryClient({
      url:process.env.SUBJECT_REGISTRY_URL??'http://127.0.0.1:3002',readKey,
    });
  } catch(error) { if(error.code!=='ENOENT') throw error; }
  const client=await pool.connect();
  try{await client.query('BEGIN'); await seedDemo(client,opaqueToken()); await seedLocalCatalog(client,{localOnly:true}); await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK'); throw error;}finally{client.release();}
  const demoAlerts=createDemoAlerts({pool});
  await demoAlerts.start();
  const server=createApp({pool,publicOrigin,secureCookies,syntheticCamera:true,demoAlerts,subjectRegistry});
  server.on('close',()=>demoAlerts.stop());
  const handle=server.listeners('request')[0]; server.removeAllListeners('request');
  server.on('request',async(req,res)=>{
    // Fixed synthetic teacher session, gated before any route or cookie is issued.
    // Remote mode intentionally disables the localhost fallback.
    if(!authorizeLocalDemoRequest(req,configuration)){res.writeHead(403);res.end('Demo access denied');return;}
    if(req.method==='GET' && (req.url==='/'||req.url==='/index.html'||req.url==='/team-demo.html'||req.url==='/parent-child.html'||req.url==='/demo-alerts.html'||req.url==='/criminal-detection.html'||req.url==='/criminal-test.html'||req.url==='/student.html?demo=1')){
      try{
        const token=opaqueToken(); const expiry=new Date(Date.now()+8*3600000);
        await pool.query('INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)',[tokenDigest(token),demo.teacherId,opaqueToken(),expiry]);
        res.setHeader('Set-Cookie',sessionCookie(token,secureCookies,expiry));
      }catch{res.writeHead(503);res.end('Local database unavailable');return;}
    }
    handle(req,res);
  });
  server.listen(port,'127.0.0.1',()=>console.log(`LOCAL SYNTHETIC DEMO (PGlite, no TimescaleDB): ${publicOrigin}`));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(async()=>{await pool.end();process.exit(0);}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error('Local demo failed:',error.message);process.exitCode=1;});
