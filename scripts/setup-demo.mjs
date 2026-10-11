import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdir,copyFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),exec=promisify(execFile);
const check='import sys,struct; assert sys.version_info >= (3,12) and struct.calcsize("P")==8, "64-bit Python 3.12+ required"';
async function run(command,args) {
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited with ${code}`)));
  });
}
export async function setupDemo({env=process.env}={}) {
  if(env.NODE_ENV==='production')throw new Error('Local demo setup is forbidden in production');
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Install Node.js 22 or newer');
  const python=join(root,'face_data','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  try{await access(python);}catch{
    const candidates=env.SETUP_PYTHON?[[env.SETUP_PYTHON,[]]]:process.platform==='win32'?[['py',['-3.12']],['py',['-3']],['python',[]]]:[['python3',[]],['python',[]]];
    let selected;
    for(const [command,args]of candidates){try{await exec(command,[...args,'-c',check],{windowsHide:true});selected=[command,args];break;}catch{}}
    if(!selected)throw new Error('Install 64-bit Python 3.12+ or set SETUP_PYTHON to its executable');
    await run(selected[0],[...selected[1],'-m','venv',join(root,'face_data','.venv')]);
  }
  await exec(python,['-c',check],{windowsHide:true});
  console.log('Installing the camera and video runtime...');
  await run(python,['-m','pip','install','-r',join(root,'face_data','requirements.txt'),'imageio-ffmpeg==0.6.0']);
  const webcam=join(root,'face_data','webcam_faces.py');
  try{await access(join(root,'face_data','models','blaze_face_short_range.tflite'));}catch{await run(python,[webcam,'--download-model']);}
  await run(python,[webcam,'--download-recognition-models']);
  await run(python,[webcam,'--check-enrollment']);
  const {stdout}=await exec(python,['-c','import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],{windowsHide:true});
  const target=join(root,'Backend','.tools','ffmpeg',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
  await mkdir(join(root,'Backend','.tools','ffmpeg'),{recursive:true});await copyFile(stdout.trim(),target);if(process.platform!=='win32')await chmod(target,0o755);
  await exec(target,['-version'],{windowsHide:true});
  console.log('Setup complete. Run npm start and open http://localhost:3000.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)setupDemo().catch(error=>{console.error(`Setup failed: ${error.message}`);process.exitCode=1;});
