import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const ownRequire=createRequire(import.meta.url),backendRequire=createRequire(new URL('../../Backend/package.json',import.meta.url));
const require=name=>{try{return ownRequire(name);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;return backendRequire(name);}};
const {PGlite}=require('@electric-sql/pglite');

export async function transaction(pool,work,{readOnly=false}={}) {
 const db=await pool.connect();
 try {await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
 catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
export async function initializeRegistry(db) {
 const sql=await readFile(new URL('../db/001_registry.sql',import.meta.url),'utf8');
 const checksum=createHash('sha256').update(sql).digest('hex');
 await db.query('BEGIN');
 try {
  await db.query('CREATE TABLE IF NOT EXISTS public.registry_migrations(name text PRIMARY KEY,checksum text NOT NULL)');
  const previous=(await db.query("SELECT checksum FROM public.registry_migrations WHERE name='001_registry.sql'")).rows[0];
  if(previous&&previous.checksum!==checksum)throw new Error('Registry migration checksum changed');
  if(!previous){await db.query(sql);await db.query('INSERT INTO public.registry_migrations VALUES($1,$2)',['001_registry.sql',checksum]);}
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}
}
export async function openRegistryDatabase(dataDir) {
 dataDir=resolve(dataDir);await mkdir(dataDir,{recursive:true});
 const lockPath=join(dataDir,'database.lock');let lock;
 try{lock=await open(lockPath,'wx',0o600);}catch(error){
  if(error.code!=='EEXIST')throw error;
  const pid=Number(await readFile(lockPath,'utf8'));let running=true;
  if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')running=false;}}
  if(running)throw new Error('Subject registry database is already open');
  await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
 }
 await lock.writeFile(String(process.pid));
 const snapshot=join(dataDir,'database.tar');let saved,engine;
 const unlock=async()=>{await lock.close();await unlink(lockPath);};
 try{
  try{saved=new Blob([await readFile(snapshot)]);}catch(error){if(error.code!=='ENOENT')throw error;}
  engine=new PGlite(saved?{loadDataDir:saved}:{});
  const raw={query:async(sql,params)=>params?engine.query(sql,params):(await engine.exec(sql)).at(-1)};
  const persist=async()=>{const blob=await engine.dumpDataDir();await writeFile(snapshot+'.tmp',Buffer.from(await blob.arrayBuffer()),{mode:0o600});await rename(snapshot+'.tmp',snapshot);};
  await initializeRegistry(raw);await persist();
  let tail=Promise.resolve(),fault=null,closing=false;
  async function acquire(){let release;const next=new Promise(r=>release=r),prior=tail;tail=next;await prior;if(fault||closing){release();throw fault??new Error('Registry database closed');}return release;}
  async function durable(){try{await persist();}catch(e){fault=new Error('Registry persistence failed; restart required',{cause:e});throw fault;}}
  const pool={
   async query(sql,params){const release=await acquire();try{const result=await raw.query(sql,params);if(!/^\s*(SELECT|SHOW)\b/i.test(sql))await durable();return result;}finally{release();}},
   async connect(){const release=await acquire();let readOnly=false;return {query:async(sql,params)=>{const result=await raw.query(sql,params);if(/^\s*BEGIN\b/i.test(sql))readOnly=/\bREAD\s+ONLY\b/i.test(sql);if(/^\s*COMMIT\b/i.test(sql)&&!readOnly)await durable();return result;},release};},
   async end(){closing=true;await tail;await engine.close();await unlock();}
  };
  return {pool,engine};
 }catch(error){await engine?.close().catch(()=>{});await unlock();throw error;}
}
export async function openProductionRegistryDatabase(dsn) {
 if(!dsn)throw new Error('SUBJECT_REGISTRY_DATABASE_URL is required for the independent registry');
 const url=new URL(dsn);if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Registry needs a PostgreSQL URI');
 for(const key of ['sslmode','ssl','sslcert','sslkey','sslrootcert','uselibpqcompat'])url.searchParams.delete(key);
 const {Pool}=require('pg');const pool=new Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},application_name:'subject-registry',max:10,connectionTimeoutMillis:15000,query_timeout:15000});
 const db=await pool.connect();let failure;try{
  const attendance=(await db.query("SELECT 1 FROM pg_namespace WHERE nspname='attendance'")).rows.length;
  if(attendance)throw new Error('Registry requires a separate PostgreSQL database; attendance schema detected');
  await initializeRegistry(db);
 }catch(error){failure=error;}finally{db.release();}
 if(failure){await pool.end();throw failure;}
 return {pool};
}
