import {open,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';

async function closeAndRemove(handle,path) {
  try{await handle.close();}finally{await unlink(path);}
}

// Serialize acquisition and stale recovery before loading any snapshot. An
// interrupted recovery claim requires explicit cleanup rather than takeover.
export async function lockLocalDatabase(directory,{label='Attendance'}={}) {
  const path=join(directory,'database.lock'),recoveryPath=path+'.recovery';
  let recovery;
  try{recovery=await open(recoveryPath,'wx',0o600);}catch(error){
    if(error.code!=='EEXIST')throw error;
    throw new Error(`${label} database lock recovery is already in progress. If recovery was interrupted, stop all database processes before explicitly removing database.lock.recovery.`);
  }
  let lock;
  try{
    try{
      try{lock=await open(path,'wx',0o600);}catch(error){
        if(error.code!=='EEXIST')throw error;
        // Read the current lease only after obtaining exclusive recovery rights.
        const pid=Number(await readFile(path,'utf8'));let running=true;
        if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')running=false;}}
        if(running)throw new Error(`${label} database is already open. Stop the other local demo before starting another.`);
        await unlink(path);lock=await open(path,'wx',0o600);
      }
      await lock.writeFile(String(process.pid));
    }finally{await closeAndRemove(recovery,recoveryPath);}
  }catch(error){
    // Only a primary lease acquired under our recovery claim may be removed.
    if(lock)await closeAndRemove(lock,path);
    throw error;
  }
  let releasing;
  return ()=>releasing??=closeAndRemove(lock,path);
}
