import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {openRegistryDatabase,openProductionRegistryDatabase} from '../src/database.mjs';
import {loadLocalConfiguration,registryConfiguration} from '../src/config.mjs';
import {seedOlivia} from '../src/subjects.mjs';
import {createRegistryServer} from '../src/server.mjs';
import {createFaceWorker} from '../../Backend/src/face-worker.mjs';

export async function startRegistry({env=process.env,args=process.argv.slice(2),dataDir=fileURLToPath(new URL('../.local-db/pgdata/',import.meta.url)),configurationPath=fileURLToPath(new URL('../.local-db/service-config.json',import.meta.url))}={}) {
 const configuration=registryConfiguration(env),production=env.NODE_ENV==='production';
 const local=production?await openProductionRegistryDatabase(env.SUBJECT_REGISTRY_DATABASE_URL):await openRegistryDatabase(dataDir);
 const {pool}=local,faceWorker=createFaceWorker();let server;
 try{
  const config=production?null:await loadLocalConfiguration(pool,configurationPath);
  if(args.length){
   if(production||![2,4].includes(args.length)||args[0]!=='--olivia-photo'||(args.length===4&&args[2]!=='--subject-id'))throw new Error('Use --olivia-photo <JPEG path> [--subject-id <UUID>] in local mode');
   await seedOlivia(pool,{faceWorker,image:(await readFile(args[1])).toString('base64'),subjectId:args[3],writeKey:config.writeKey});
  }
  server=createRegistryServer({pool,faceWorker});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(configuration.port,'127.0.0.1',resolve);});
  const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));faceWorker.close();await pool.end();};
  return {...local,server,close,configuration,privateConfiguration:config,faceWorker};
 }catch(error){faceWorker.close();await pool.end();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 startRegistry().then(runtime=>{console.log(`Subject registry listening on ${runtime.configuration.publicOrigin}`);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>runtime.close().then(()=>process.exit(0)));}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
