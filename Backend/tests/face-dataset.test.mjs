import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {importFaceDataset} from '../scripts/import-face-dataset.mjs';

function fixture() {
  const bytes=Buffer.concat([Buffer.from('P5\n92 112\n255\n'),Buffer.alloc(92*112,32)]);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  return {name:'ORL-AT&T',sourceUrl:'https://github.com/LeoYaman/presence-attendance/blob/main/att_faces.zip',
    archiveSha256:'a'.repeat(64),attribution:'Olivetti Research Laboratory',readme:'Original source README.\n',
    subjects:Array.from({length:40},(_,i)=>({key:'s'+(i+1),images:Array.from({length:10},(_,j)=>({
      key:(j+1)+'.pgm',path:'s'+(i+1)+'/'+(j+1)+'.pgm',width:92,height:112,mimeType:'image/x-portable-graymap',sha256,data:bytes.toString('base64')
    }))}))};
}

async function database() {
  const engine=new PGlite();
  for(const name of ['001_initial_schema.sql','006_face_datasets.sql']) await engine.exec(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  return engine;
}

test('ORL reference archive imports all original bytes and reimports without duplication',async()=>{
  const db=await database();
  try {
    const manifest=fixture();
    const first=await importFaceDataset(db,manifest);
    assert.equal(first.subjects,40);assert.equal(first.images,400);
    assert.equal(first.subjectsInserted,40);assert.equal(first.imagesInserted,400);
    const second=await importFaceDataset(db,manifest);
    assert.equal(second.datasetId,first.datasetId);assert.equal(second.subjectsInserted,0);assert.equal(second.imagesInserted,0);
    const row=(await db.query(`SELECT d.test_only,d.source_url,d.archive_sha256,d.source_readme,i.original_path,encode(i.image_bytes,'base64') AS data
      FROM attendance.face_datasets d JOIN attendance.face_dataset_subjects s ON s.dataset_id=d.id JOIN attendance.face_dataset_images i ON i.subject_id=s.id
      WHERE s.subject_key='s1' AND i.image_key='1.pgm'`)).rows[0];
    assert.equal(row.test_only,true);assert.equal(row.source_url,manifest.sourceUrl);assert.equal(row.archive_sha256,manifest.archiveSha256);
    assert.equal(row.source_readme,manifest.readme);assert.equal(row.original_path,'s1/1.pgm');
    assert.deepEqual(Buffer.from(row.data,'base64'),Buffer.from(manifest.subjects[0].images[0].data,'base64'));
    for(const table of ['people','face_enrollments','attendance_records']) assert.equal((await db.query('SELECT count(*)::integer AS count FROM attendance.'+table)).rows[0].count,0);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM attendance.face_dataset_images')).rows[0].count,400);
  } finally {await db.close();}
});

test('malformed manifest rejects before writes and SQL failures roll back every row',async()=>{
  const db=await database();
  try {
    const corrupt=fixture();corrupt.subjects[39].images[9].sha256='0'.repeat(64);
    await assert.rejects(importFaceDataset(db,corrupt),/bytes do not match SHA-256/);
    const invalid=fixture();invalid.subjects[0].images[0].path='s2/1.pgm';
    await assert.rejects(importFaceDataset(db,invalid),/original path/);
    const invalidPgm=fixture();const image=invalidPgm.subjects[0].images[0];
    const bytes=Buffer.from(image.data,'base64');bytes[0]=0;image.data=bytes.toString('base64');image.sha256=createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(importFaceDataset(db,invalidPgm),/binary PGM/);
    await db.exec(`CREATE FUNCTION attendance.fail_test_image() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.original_path='s40/10.pgm' THEN RAISE EXCEPTION 'test import interruption'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_test_image BEFORE INSERT ON attendance.face_dataset_images FOR EACH ROW EXECUTE FUNCTION attendance.fail_test_image();`);
    await assert.rejects(importFaceDataset(db,fixture()),/test import interruption/);
    for(const table of ['face_datasets','face_dataset_subjects','face_dataset_images']) assert.equal((await db.query('SELECT count(*)::integer AS count FROM attendance.'+table)).rows[0].count,0);
  } finally {await db.close();}
});

test('reimport rejects archive mismatch and detects changed stored bytes despite unchanged SHA',async()=>{
  const db=await database();
  try {
    const manifest=fixture();await importFaceDataset(db,manifest);
    const different={...manifest,archiveSha256:'b'.repeat(64)};
    await assert.rejects(importFaceDataset(db,different),/provenance differs/);
    assert.equal((await db.query('SELECT archive_sha256 FROM attendance.face_datasets')).rows[0].archive_sha256,manifest.archiveSha256);
    await db.query(`UPDATE attendance.face_dataset_images SET image_bytes=set_byte(image_bytes,100,33) WHERE original_path='s1/1.pgm'`);
    await assert.rejects(importFaceDataset(db,manifest),/Stored face dataset image differs: s1\/1.pgm/);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM attendance.face_dataset_images')).rows[0].count,400);
  } finally {await db.close();}
});

test('dataset subjects have no person links and migrations grant no runtime dataset access',async()=>{
  const db=await database();
  try {
    const foreignTables=(await db.query(`SELECT ccu.table_name FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
      WHERE tc.table_schema='attendance' AND tc.table_name LIKE 'face_dataset%' AND tc.constraint_type='FOREIGN KEY'`)).rows.map(row=>row.table_name).sort();
    assert.deepEqual(foreignTables,['face_dataset_subjects','face_datasets']);
    const sql=await readFile(new URL('../db/migrations/006_face_datasets.sql',import.meta.url),'utf8');
    assert.doesNotMatch(sql,/\bGRANT\b/i);
    await assert.rejects(db.query(`INSERT INTO attendance.face_datasets(name,source_url,archive_sha256,attribution,source_readme,test_only)
      VALUES('other','https://example.org',$1,'source','readme',false)`,['a'.repeat(64)]),/check constraint/);
  } finally {await db.close();}
});
