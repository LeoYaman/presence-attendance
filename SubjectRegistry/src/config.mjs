import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {digest,provisionSubjectKey,provisionReaderKey,subjectApps} from './subjects.mjs';
export async function loadLocalConfiguration(pool,path) {
 let config;
 try{config=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(config){
  if(!/^registry_read_[a-f0-9]{64}$/.test(config.readerKey??'')||!/^registry_write_[a-f0-9]{64}$/.test(config.writeKey??''))throw new Error('Invalid private registry configuration');
  const rows=(await pool.query("SELECT privilege,source_id FROM registry.api_keys WHERE key_hash=ANY($1::text[]) AND is_active AND (expires_at IS NULL OR expires_at>now())",[[digest(config.readerKey),digest(config.writeKey)]])).rows;
  if(rows.length!==2||!rows.some(r=>r.privilege==='read')||!rows.some(r=>r.privilege==='write'&&r.source_id===config.sourceId))throw new Error('Private registry configuration keys are expired or revoked; explicitly reprovision');
  return config;
 }
 const writer=await provisionSubjectKey(pool,{name:'local-import',apps:subjectApps}),reader=await provisionReaderKey(pool);
 config={sourceId:writer.sourceId,readerKey:reader.key,writeKey:writer.key};await mkdir(dirname(path),{recursive:true});
 await writeFile(path+'.tmp',JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(path+'.tmp',path);return config;
}
export function registryConfiguration(env=process.env) {
 const port=Number(env.SUBJECT_REGISTRY_PORT??3002);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid registry port');
 const publicOrigin=env.SUBJECT_REGISTRY_PUBLIC_ORIGIN??`http://127.0.0.1:${port}`;let url;
 try{url=new URL(publicOrigin);}catch{throw new Error('Invalid registry public origin');}
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['https:','http:'].includes(url.protocol))throw new Error('Registry public origin must be a root HTTP(S) origin');
 if((env.NODE_ENV==='production'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))&&url.protocol!=='https:')throw new Error('Published registry requires HTTPS');
 return {port,publicOrigin:url.origin};
}
