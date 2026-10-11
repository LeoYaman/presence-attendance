import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {lockLocalDatabase} from '../scripts/local-database-lock.mjs';

const moduleUrl=new URL('../scripts/local-database-lock.mjs',import.meta.url).href;
const absent=path=>assert.rejects(readFile(path),error=>error.code==='ENOENT');
async function deadPid(){
  const child=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});
  const pid=child.pid;await once(child,'exit');return pid;
}
async function directory(){return mkdtemp(join(tmpdir(),'presence-lock-'));}

test('active owner rejects duplicates without changing its lease; release is idempotent',async()=>{
  const path=await directory();let release;
  try{
    release=await lockLocalDatabase(path);
    await assert.rejects(lockLocalDatabase(path,{label:'Subject registry'}),/Subject registry database is already open/);
    assert.equal(await readFile(join(path,'database.lock'),'utf8'),String(process.pid));
    await absent(join(path,'database.lock.recovery'));
    const first=release();assert.equal(release(),first);await first;
    await absent(join(path,'database.lock'));
    const next=await lockLocalDatabase(path);await next();
  }finally{await release?.();await rm(path,{recursive:true,force:true});}
});

test('dead PID lease is recovered and recovery claim is removed',async()=>{
  const path=await directory();let release;
  try{
    await writeFile(join(path,'database.lock'),String(await deadPid()));
    release=await lockLocalDatabase(path);
    assert.equal(await readFile(join(path,'database.lock'),'utf8'),String(process.pid));
    await absent(join(path,'database.lock.recovery'));
  }finally{await release?.();await rm(path,{recursive:true,force:true});}
});

test('orphaned recovery claim conservatively blocks acquisition and remains untouched',async()=>{
  for(const primaryExists of [false,true]){
    const path=await directory();
    try{
      if(primaryExists)await writeFile(join(path,'database.lock'),String(await deadPid()));
      await writeFile(join(path,'database.lock.recovery'),'interrupted recovery');
      const original=primaryExists?await readFile(join(path,'database.lock'),'utf8'):null;
      await assert.rejects(lockLocalDatabase(path),/recovery is already in progress.*explicitly removing/);
      assert.equal(await readFile(join(path,'database.lock.recovery'),'utf8'),'interrupted recovery');
      if(primaryExists)assert.equal(await readFile(join(path,'database.lock'),'utf8'),original);
      else await absent(join(path,'database.lock'));
    }finally{await rm(path,{recursive:true,force:true});}
  }
});

test('invalid PID lease fails conservatively while its temporary recovery claim is cleaned',async()=>{
  const path=await directory();
  try{
    await writeFile(join(path,'database.lock'),'');
    await assert.rejects(lockLocalDatabase(path),/already open/);
    assert.equal(await readFile(join(path,'database.lock'),'utf8'),'');
    await absent(join(path,'database.lock.recovery'));
  }finally{await rm(path,{recursive:true,force:true});}
});

test('failed PID write releases only the newly acquired lease and its recovery claim',async()=>{
  const path=await directory(),probe=await open(join(path,'probe'),'wx');
  const prototype=Object.getPrototypeOf(probe),write=prototype.writeFile;await probe.close();
  try{
    prototype.writeFile=async function(){throw new Error('Intentional PID write failure');};
    await assert.rejects(lockLocalDatabase(path),/Intentional PID write failure/);
    await absent(join(path,'database.lock'));await absent(join(path,'database.lock.recovery'));
    prototype.writeFile=write;
    const release=await lockLocalDatabase(path);await release();
  }finally{prototype.writeFile=write;await rm(path,{recursive:true,force:true});}
});

function message(child){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Lock contender did not respond')),10000);
    function finish(error,value){clearTimeout(timer);child.off('message',received);child.off('error',failed);child.off('exit',exited);error?reject(error):resolve(value);}
    const received=value=>finish(null,value),failed=error=>finish(error),exited=code=>finish(new Error(`Lock contender exited with ${code}`));
    child.once('message',received);child.once('error',failed);child.once('exit',exited);
  });
}
function contender(path){
  const source=`
    const {lockLocalDatabase}=await import(process.argv[2]);
    let release;
    process.on('message',async command=>{
      if(command==='acquire'){
        try{release=await lockLocalDatabase(process.argv[1]);process.send({status:'acquired',pid:process.pid});}
        catch(error){process.send({status:'rejected',message:error.message});}
      }else if(command==='release'){
        await release?.();process.send({status:'released'});process.disconnect();
      }
    });
    process.send({status:'ready'});
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source,path,moduleUrl],{windowsHide:true,stdio:['ignore','ignore','inherit','ipc']});
  return {child,ready:message(child)};
}

test('simultaneous child-process stale recovery leaves exactly one owner while it holds the lease',async()=>{
  const path=await directory(),children=[];
  try{
    await writeFile(join(path,'database.lock'),String(await deadPid()));
    const contenders=[contender(path),contender(path)];children.push(...contenders.map(item=>item.child));
    await Promise.all(contenders.map(item=>item.ready));
    const results=children.map(child=>message(child));
    children.forEach(child=>child.send('acquire'));
    const attempts=await Promise.all(results);
    assert.equal(attempts.filter(result=>result.status==='acquired').length,1);
    assert.equal(attempts.filter(result=>result.status==='rejected').length,1);
    const winner=attempts.findIndex(result=>result.status==='acquired'),loser=1-winner;
    assert.match(attempts[loser].message,/already open|recovery is already in progress/);
    assert.equal(await readFile(join(path,'database.lock'),'utf8'),String(attempts[winner].pid));
    // The winner stays alive and owns its lease while the loser retries.
    const retry=message(children[loser]);children[loser].send('acquire');
    assert.equal((await retry).status,'rejected');
    assert.equal(await readFile(join(path,'database.lock'),'utf8'),String(attempts[winner].pid));
    await absent(join(path,'database.lock.recovery'));
    const released=children.map(child=>message(child));children.forEach(child=>child.send('release'));
    await Promise.all(released);
    await absent(join(path,'database.lock'));await absent(join(path,'database.lock.recovery'));
  }finally{
    await Promise.all(children.map(async child=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}));
    await rm(path,{recursive:true,force:true});
  }
});
