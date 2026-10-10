import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createConnection} from 'node:net';
import {loadEnvFile} from 'node:process';

const sourceUrl='https://github.com/LeoYaman/presence-attendance/blob/main/att_faces.zip';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new Error('Invalid face dataset: '+message);};

function pgmDimensions(bytes) {
  // P5 headers may contain comments. Do not skip whitespace in the raster itself.
  let offset=0;
  const space=byte=>[9,10,11,12,13,32].includes(byte);
  function token() {
    for (;;) {
      while(space(bytes[offset])) offset++;
      if(bytes[offset]!==35) break;
      while(offset<bytes.length&&bytes[offset]!==10&&bytes[offset]!==13) offset++;
    }
    const start=offset;
    while(offset<bytes.length&&!space(bytes[offset])&&bytes[offset]!==35) offset++;
    return bytes.subarray(start,offset).toString('latin1');
  }
  const magic=token(),width=token(),height=token(),maxval=token();
  if(magic!=='P5'||width!=='92'||height!=='112'||maxval!=='255'||!space(bytes[offset])) fail('expected 92x112 8-bit binary PGM');
  if(bytes[offset]===13&&bytes[offset+1]===10) offset+=2; else offset++;
  if(offset>1024||bytes.length-offset!==92*112) fail('PGM raster length does not match its header');
}

function validateManifest(manifest) {
  if(!manifest||manifest.name!=='ORL-AT&T'||manifest.sourceUrl!==sourceUrl||manifest.attribution!=='Olivetti Research Laboratory') fail('unexpected archive identity or provenance');
  if(!/^[0-9a-f]{64}$/.test(manifest.archiveSha256??'')) fail('archive SHA-256 is required');
  if(typeof manifest.readme!=='string'||!manifest.readme.trim()||manifest.readme.length>65536) fail('source README is required');
  if(!Array.isArray(manifest.subjects)||manifest.subjects.length!==40) fail('expected 40 subjects');
  const subjects=new Map();
  for(const subject of manifest.subjects) {
    if(!subject||!/^s([1-9]|[1-3][0-9]|40)$/.test(subject.key)||subjects.has(subject.key)) fail('invalid or duplicate subject key');
    if(!Array.isArray(subject.images)||subject.images.length!==10) fail('expected 10 images per subject');
    const images=new Map();
    for(const image of subject.images) {
      if(!image||!/^([1-9]|10)\.pgm$/.test(image.key)||images.has(image.key)||image.path!==subject.key+'/'+image.key) fail('invalid image key or original path');
      if(image.width!==92||image.height!==112||image.mimeType!=='image/x-portable-graymap') fail('invalid image dimensions or MIME type');
      if(!/^[0-9a-f]{64}$/.test(image.sha256??'')) fail('invalid image SHA-256');
      if(typeof image.data!=='string'||image.data.length>15104||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) fail('invalid image base64');
      const bytes=Buffer.from(image.data,'base64');
      if(bytes.toString('base64')!==image.data||digest(bytes)!==image.sha256) fail('image bytes do not match SHA-256');
      pgmDimensions(bytes);
      images.set(image.key,{...image,hex:bytes.toString('hex')});
    }
    subjects.set(subject.key,{key:subject.key,images});
  }
  return subjects;
}

export async function importFaceDataset(db,manifest) {
  const subjects=validateManifest(manifest);
  const client=typeof db.connect==='function'?await db.connect():db;
  let begun=false;
  try {
    await client.query('BEGIN'); begun=true;
    const inserted=await client.query(`INSERT INTO attendance.face_datasets(name,source_url,archive_sha256,attribution,source_readme)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(name) DO NOTHING RETURNING id`,
      [manifest.name,manifest.sourceUrl,manifest.archiveSha256,manifest.attribution,manifest.readme]);
    const dataset=(await client.query('SELECT * FROM attendance.face_datasets WHERE name=$1 FOR UPDATE',[manifest.name])).rows[0];
    if(dataset.test_only!==true||dataset.archive_sha256!==manifest.archiveSha256||dataset.source_url!==manifest.sourceUrl||dataset.attribution!==manifest.attribution||dataset.source_readme!==manifest.readme)
      throw new Error('Existing face dataset provenance differs; archive was not overwritten');
    let subjectsInserted=0,imagesInserted=0;
    if(inserted.rows.length) {
      for(const subject of subjects.values()) {
        const row=(await client.query('INSERT INTO attendance.face_dataset_subjects(dataset_id,subject_key) VALUES($1,$2) RETURNING id',[dataset.id,subject.key])).rows[0];
        subjectsInserted++;
        for(const image of subject.images.values()) {
          await client.query(`INSERT INTO attendance.face_dataset_images(subject_id,image_key,original_path,sha256,width,height,mime_type,image_bytes)
            VALUES($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'))`,[row.id,image.key,image.path,image.sha256,image.width,image.height,image.mimeType,image.hex]);
          imagesInserted++;
        }
      }
    }
    const storedSubjects=(await client.query('SELECT subject_key FROM attendance.face_dataset_subjects WHERE dataset_id=$1',[dataset.id])).rows;
    const storedImages=(await client.query(`SELECT s.subject_key,i.image_key,i.original_path,i.sha256,i.width,i.height,i.mime_type,encode(i.image_bytes,'hex') AS hex
      FROM attendance.face_dataset_subjects s JOIN attendance.face_dataset_images i ON i.subject_id=s.id WHERE s.dataset_id=$1`,[dataset.id])).rows;
    if(storedSubjects.length!==40||storedSubjects.some(row=>!subjects.has(row.subject_key))||storedImages.length!==400) throw new Error('Stored face dataset is incomplete or has unexpected rows');
    for(const row of storedImages) {
      const expected=subjects.get(row.subject_key)?.images.get(row.image_key);
      if(!expected||row.original_path!==expected.path||row.sha256!==expected.sha256||row.width!==expected.width||row.height!==expected.height||row.mime_type!==expected.mimeType||row.hex!==expected.hex||digest(Buffer.from(row.hex,'hex'))!==row.sha256)
        throw new Error('Stored face dataset image differs: '+row.subject_key+'/'+row.image_key);
    }
    await client.query('COMMIT'); begun=false;
    return {datasetId:dataset.id,subjects:40,images:400,subjectsInserted,imagesInserted};
  } catch(error) {
    if(begun) await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {if(client!==db) client.release();}
}

async function localServerIsListening(port) {
  return new Promise(resolveCheck=>{
    const socket=createConnection({host:'127.0.0.1',port});
    socket.setTimeout(1000);
    socket.once('connect',()=>{socket.destroy();resolveCheck(true);});
    socket.once('error',()=>{socket.destroy();resolveCheck(false);});
    socket.once('timeout',()=>{socket.destroy();resolveCheck(true);});
  });
}

async function main() {
  const args=process.argv.slice(2),mode=args.shift();
  const offlineConfirmed=args.includes('--offline-confirmed');
  if(offlineConfirmed) args.splice(args.indexOf('--offline-confirmed'),1);
  if(!['--local','--database'].includes(mode)||args.length>1||args.some(arg=>arg.startsWith('--'))||(mode==='--database'&&offlineConfirmed)) throw new Error('Usage: node scripts/import-face-dataset.mjs --local --offline-confirmed [archive.zip] | --database [archive.zip]');
  if(mode==='--local'&&!offlineConfirmed) throw new Error('Stop the local server and pass --offline-confirmed before importing its database snapshot');
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const archive=resolve(args[0]??resolve(root,'att_faces.zip'));
  const python=process.env.FACE_PYTHON??resolve(root,'face_data','.venv','Scripts','python.exe');
  const {stdout}=await promisify(execFile)(python,[resolve(root,'face_data','export_dataset.py'),archive],{maxBuffer:16*1024*1024});
  const manifest=JSON.parse(stdout);
  validateManifest(manifest);
  let pool;
  try {
    if(mode==='--local') {
      if(process.env.NODE_ENV==='production') throw new Error('Local dataset import is forbidden in production');
      const port=Number(process.env.LOCAL_DEMO_PORT??3000);
      if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid LOCAL_DEMO_PORT');
      console.error('Offline local import: stop the local server before opening its database snapshot.');
      if(await localServerIsListening(port)) throw new Error('Stop the local server before importing (LOCAL_DEMO_PORT is listening)');
      const {openLocalDatabase}=await import('./local-demo.mjs');
      ({pool}=await openLocalDatabase(fileURLToPath(new URL('../.local-db/pgdata/',import.meta.url))));
    } else {
      try{loadEnvFile(new URL('../.env',import.meta.url));}catch(error){if(error.code!=='ENOENT') throw error;}
      const {createPool}=await import('../src/database.mjs');
      pool=createPool(process.env.DATABASE_URL);
    }
    console.log(JSON.stringify(await importFaceDataset(pool,manifest),null,2));
  } finally {if(pool) await pool.end();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{
  console.error('Face dataset import failed:',error.message?.startsWith('Invalid face dataset:')||/^(Usage:|Stop the local server|Invalid LOCAL_DEMO_PORT|Local dataset import|Existing face dataset|Stored face dataset)/.test(error.message??'')?error.message:'Check archive, Python environment, database migrations, and connection configuration.');
  process.exitCode=1;
});
