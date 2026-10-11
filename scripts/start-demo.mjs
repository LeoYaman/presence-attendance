import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startRegistry} from '../SubjectRegistry/scripts/start.mjs';
import {startLocalDemo} from '../Backend/scripts/local-demo.mjs';
import {createSubjectRegistryClient} from '../Backend/src/subject-registry-client.mjs';
import {seedPresentationSubjects} from '../Backend/scripts/demo-fixtures.mjs';
import {teamReferences} from '../Backend/scripts/import-team-references.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const run=promisify(execFile);
export async function startDemo({env=process.env,checkRuntime=true}={}) {
  if(env.NODE_ENV==='production')throw new Error('Use npm run start:production for production; password-free demo is local only.');
  const python=env.FACE_PYTHON||join(root,'face_data','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  let ffmpeg=env.FFMPEG_PATH;
  if(checkRuntime){
    try {
      const {stdout}=await run(python,['-c','import cv2, mediapipe, imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],{windowsHide:true});
      ffmpeg??=stdout.trim();
      await run(ffmpeg,['-version'],{windowsHide:true});
      const {access}=await import('node:fs/promises');
      for(const name of ['blaze_face_short_range.tflite','face_detection_yunet_2023mar.onnx','face_recognition_sface_2021dec.onnx'])await access(join(root,'face_data','models',name));
    }catch{throw new Error('Camera/video runtime is missing. Run npm run setup first (64-bit Python 3.12+ and internet required).');}
  }
  const configured={...env,FACE_PYTHON:python,...(ffmpeg?{FFMPEG_PATH:ffmpeg}:{}),
    PICKUP_DEMO_ENABLED:'true',PICKUP_LEO_ID:teamReferences.members[1].personId,
    PICKUP_REBECA_ID:teamReferences.members[2].personId,PICKUP_ANTHONY_ID:teamReferences.members[0].personId};
  // Existing adapters read only these runtime paths; cloud .env is never loaded.
  process.env.FACE_PYTHON=configured.FACE_PYTHON;
  if(configured.FFMPEG_PATH)process.env.FFMPEG_PATH=configured.FFMPEG_PATH;
  const data=env.PRESENCE_DEMO_DATA_DIR?resolve(root,env.PRESENCE_DEMO_DATA_DIR):undefined;
  const registryDirectory=data?join(data,'registry'):join(root,'SubjectRegistry','.local-db');
  let registry,attendance;
  try{
    registry=await startRegistry({env:configured,args:[],dataDir:join(registryDirectory,'pgdata'),configurationPath:join(registryDirectory,'service-config.json')});
    await seedPresentationSubjects({pool:registry.pool,faceWorker:registry.faceWorker,configuration:registry.privateConfiguration,markerPath:join(registryDirectory,'presentation-fixtures.json')});
    const subjectRegistry=createSubjectRegistryClient({url:`http://127.0.0.1:${registry.configuration.port}`,readKey:registry.privateConfiguration.readerKey});
    attendance=await startLocalDemo({env:configured,subjectRegistry,prepareTeam:true,...(data?{dataDir:join(data,'attendance')}:{})});
    let closing;const close=()=>closing??=(async()=>{try{await attendance.close();}finally{await registry.close();}})();
    return {attendance,registry,close};
  }catch(error){await Promise.allSettled([attendance?.close(),registry?.close()]);throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  startDemo().then(runtime=>{
    console.log(`Presence demo ready: ${runtime.attendance.configuration.publicOrigin}/login.html`);
    console.log('All four workspaces use a local demo operator session. Data stays on this computer; PGlite is not TimescaleDB.');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>runtime.close().then(()=>process.exit(0)));
  }).catch(error=>{console.error(`Demo startup failed: ${error.message}`);process.exitCode=1;});
}
