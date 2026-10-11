// Raw keys are written only to a caller-chosen private file, never printed.
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openRegistryDatabase,openProductionRegistryDatabase} from '../src/database.mjs';
import {provisionSubjectKey,provisionReaderKey} from '../src/subjects.mjs';
export async function provisionKeyFile(args=process.argv.slice(2),env=process.env) {
 const options={};for(let i=0;i<args.length;i++){
  const arg=args[i];if(arg==='--read'||arg==='--local'){options[arg.slice(2)]=true;continue;}
  const match=arg.match(/^--(name|apps|output|expires-at)(?:=(.*))?$/);if(!match)throw new Error('Unknown provisioning option');
  const value=match[2]??args[++i];if(!value||value.startsWith('--'))throw new Error('Provisioning option requires a value');options[match[1]]=value;
 }
 if(!options.output||(!options.read&&!options.name))throw new Error('Use --name NAME --output PRIVATEPATH, or --read --output PRIVATEPATH');
 const output=resolve(options.output),localMode=options.local||env.NODE_ENV!=='production';
 const {pool}=localMode?await openRegistryDatabase(fileURLToPath(new URL('../.local-db/pgdata/',import.meta.url))):await openProductionRegistryDatabase(env.SUBJECT_REGISTRY_DATABASE_URL);
 try{
  const configuration={...(options.apps?{apps:options.apps.split(',')}:{}) ,expiresAt:options['expires-at']??null};
  const result=options.read?await provisionReaderKey(pool,configuration):await provisionSubjectKey(pool,{...configuration,name:options.name});
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return {output,sourceId:result.sourceId??null,privilege:options.read?'read':'write'};
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){provisionKeyFile().then(result=>console.log(`Saved private ${result.privilege} key file`)).catch(error=>{console.error(error.message);process.exitCode=1;});}
