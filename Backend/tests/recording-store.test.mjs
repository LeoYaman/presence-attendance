import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRecordingStore, RECORDING_RETENTION_MS, RECORDING_MAX_DURATION_MS, RECORDING_UPLOAD_GRACE_MS, RECORDING_INACTIVITY_MS, RECORDING_MAX_CHUNK_BYTES } from '../src/recording-store.mjs';

const groupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherGroup = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const initialTime = Date.parse('2026-10-10T14:00:00.000Z');
const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const portable = join(backendRoot, '.tools', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffmpeg = process.env.FFMPEG_PATH || portable;
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(backendRoot, '.recording-test-'));
  let time = initialTime;
  const store = createRecordingStore({ root, now: () => time, ...options });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, advance(milliseconds) { time += milliseconds; }, now: () => time };
}
const create = store => store.create({ groupId, ownerId, mimeType: 'video/webm;codecs=vp8' });
const rejectsCode = (promise, status, code) => assert.rejects(promise, error => error.status === status && error.code === code);
async function run(args) {
  return new Promise((accept, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept(stdout) : reject(new Error(stderr)));
  });
}

test('persists manifests and scopes lists to the requested group', async t => {
  const { root, store, now } = await fixture(t);
  const recording = await create(store);
  assert.equal(recording.startedAt, new Date(initialTime).toISOString());
  assert.equal(recording.expiresAt, new Date(initialTime + RECORDING_RETENTION_MS).toISOString());
  assert.equal(recording.status, 'recording');
  await store.putChunk(recording.id, 0, Buffer.from('first'));
  await store.create({ groupId: otherGroup, ownerId, mimeType: 'video/mp4' });
  const restarted = createRecordingStore({ root, now });
  assert.equal((await restarted.get(recording.id)).chunkCount, 1);
  assert.deepEqual((await restarted.list(groupId)).map(item => item.id), [recording.id]);
  await rejectsCode(restarted.get('../outside'), 400, 'INVALID_RECORDING_ID');
  await rejectsCode(store.create({ groupId, ownerId: '../outside', mimeType: 'video/webm' }), 400, 'INVALID_RECORDING_ID');
  await rejectsCode(store.create({ groupId, ownerId, mimeType: 'image/png' }), 400, 'INVALID_RECORDING_MIME');
});

test('serializes concurrent uploads and makes identical retries idempotent', async t => {
  const { root, store } = await fixture(t);
  const recording = await create(store);
  const original = Buffer.from('first');
  const first = store.putChunk(recording.id, 0, original);
  original.fill(0);
  const second = store.putChunk(recording.id, 1, Buffer.from('second'));
  await Promise.all([first, second]);
  assert.equal((await store.putChunk(recording.id, 0, Buffer.from('first'))).chunkCount, 2);
  assert.equal((await store.get(recording.id)).bytes, 11);
  assert.equal((await readFile(join(root, recording.id, 'chunk-000000.bin'))).toString(), 'first');
  await rejectsCode(store.putChunk(recording.id, 0, Buffer.from('different')), 409, 'CHUNK_CONFLICT');
  await rejectsCode(store.putChunk(recording.id, 3, Buffer.from('gap')), 409, 'CHUNK_OUT_OF_ORDER');
  assert.equal((await store.get(recording.id)).chunkCount, 2);
});

test('replaces uncommitted orphan chunks while keeping committed uploads', async t => {
  const { root, store, now } = await fixture(t);
  const recording = await create(store);
  await store.putChunk(recording.id, 0, Buffer.from('committed'));
  await writeFile(join(root, recording.id, 'chunk-000001.bin'), 'orphan before manifest commit');
  const restarted = createRecordingStore({ root, now });
  await restarted.putChunk(recording.id, 1, Buffer.from('retry'));
  assert.equal((await readFile(join(root, recording.id, 'chunk-000000.bin'))).toString(), 'committed');
  assert.equal((await readFile(join(root, recording.id, 'chunk-000001.bin'))).toString(), 'retry');
  assert.equal((await restarted.get(recording.id)).chunkCount, 2);
});

test('bounds chunk size, recording duration and final timestamps', async t => {
  const { store, advance } = await fixture(t);
  const recording = await create(store);
  await rejectsCode(store.putChunk(recording.id, 0, Buffer.alloc(0)), 413, 'INVALID_RECORDING_CHUNK');
  await rejectsCode(store.putChunk(recording.id, 0, Buffer.alloc(RECORDING_MAX_CHUNK_BYTES + 1)), 413, 'INVALID_RECORDING_CHUNK');
  await rejectsCode(store.putChunk(recording.id, -1, Buffer.from('data')), 400, 'INVALID_CHUNK_SEQUENCE');
  await rejectsCode(store.finish(recording.id), 409, 'RECORDING_EMPTY');
  await store.putChunk(recording.id, 0, Buffer.from('data'));
  await rejectsCode(store.finish(recording.id, { endedAt: initialTime - 1 }), 400, 'INVALID_RECORDING_TIME');
  advance(RECORDING_MAX_DURATION_MS + RECORDING_UPLOAD_GRACE_MS + 1);
  await rejectsCode(store.putChunk(recording.id, 1, Buffer.from('late')), 413, 'RECORDING_LIMIT');
  await rejectsCode(store.finish(recording.id), 400, 'INVALID_RECORDING_TIME');
});

test('accepts delayed final chunks during upload grace without extending captured duration', async t => {
  const { store, advance } = await fixture(t);
  const recording = await create(store);
  await store.putChunk(recording.id, 0, Buffer.from('initial'));
  advance(RECORDING_MAX_DURATION_MS + 1);
  assert.equal((await store.putChunk(recording.id, 1, Buffer.from('delayed-final'))).chunkCount, 2);
  // The upload deadline includes 15 minutes to drain queued chunks.
  advance(RECORDING_UPLOAD_GRACE_MS - 1);
  assert.equal((await store.putChunk(recording.id, 2, Buffer.from('deadline-final'))).chunkCount, 3);
  advance(1);
  await rejectsCode(store.putChunk(recording.id, 3, Buffer.from('too-late')), 413, 'RECORDING_LIMIT');
  // Explicit captured end time remains bounded to two hours.
  await rejectsCode(store.finish(recording.id, { endedAt: initialTime + RECORDING_MAX_DURATION_MS + 1 }), 400, 'INVALID_RECORDING_TIME');
});

test('retention uses server creation time and deletes only owned safe directories', async t => {
  const { root, store, advance } = await fixture(t);
  const recording = await store.create({ groupId, ownerId, mimeType: 'video/webm', startedAt: initialTime - 30_000 });
  await mkdir(join(root, 'keep-other-files'));
  await writeFile(join(root, 'keep-other-files', 'sentinel.txt'), 'keep');
  advance(RECORDING_RETENTION_MS - 1);
  assert.deepEqual(await store.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 0 });
  assert.equal((await store.get(recording.id)).id, recording.id);
  advance(1);
  await rejectsCode(store.get(recording.id), 404, 'RECORDING_EXPIRED');
  assert.deepEqual(await store.list(groupId), []);
  assert.deepEqual(await store.cleanup(), { removed: 1, recovered: 0, recoveryFailed: 0 });
  await access(join(root, 'keep-other-files', 'sentinel.txt'));
  assert.deepEqual(await store.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 0 });
});

test('ignores UUID symlinks during listing and expiration cleanup', async t => {
  const { root, store, advance } = await fixture(t);
  const external = await mkdtemp(join(backendRoot, '.recording-external-test-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'sentinel.txt'), 'keep');
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  try { await symlink(external, join(root, id), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink creation unavailable'); return; }
    throw error;
  }
  advance(RECORDING_RETENTION_MS);
  assert.deepEqual(await store.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 0 });
  assert.deepEqual(await store.list(groupId), []);
  await rejectsCode(store.get(id), 404, 'RECORDING_NOT_FOUND');
  assert.equal(await readFile(join(external, 'sentinel.txt'), 'utf8'), 'keep');
});

test('rejects corrupt manifests and never uses metadata as deletion paths', async t => {
  const { root, store, advance } = await fixture(t);
  const recording = await create(store);
  const manifest = join(root, recording.id, 'manifest.json');
  const corrupted = JSON.parse(await readFile(manifest, 'utf8'));
  corrupted.id = '../keep';
  await writeFile(manifest, JSON.stringify(corrupted));
  await mkdir(join(root, 'keep'));
  await writeFile(join(root, 'keep', 'sentinel.txt'), 'keep');
  advance(RECORDING_RETENTION_MS);
  await rejectsCode(store.get(recording.id), 500, 'INVALID_RECORDING_MANIFEST');
  assert.deepEqual(await store.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 0 });
  assert.equal(await readFile(join(root, 'keep', 'sentinel.txt'), 'utf8'), 'keep');
  await access(manifest);
});

test('processing failure preserves source and committed chunks for restart and retry', async t => {
  const { root, store, now, advance } = await fixture(t, { ffmpegPath: join(tmpdir(), 'missing-recording-processor.exe') });
  const recording = await create(store);
  await store.putChunk(recording.id, 0, Buffer.from('first'));
  await store.putChunk(recording.id, 1, Buffer.from('second'));
  await rejectsCode(store.finish(recording.id), 503, 'RECORDING_PROCESSOR_UNAVAILABLE');
  assert.equal((await store.get(recording.id)).status, 'processing_failed');
  assert.equal((await store.get(recording.id)).endedAt, new Date(initialTime).toISOString());
  assert.equal(await readFile(join(root, recording.id, 'source.webm'), 'utf8'), 'firstsecond');
  assert.equal(await readFile(join(root, recording.id, 'chunk-000000.bin'), 'utf8'), 'first');
  const restarted = createRecordingStore({ root, now, ffmpegPath: join(tmpdir(), 'missing-recording-processor.exe') });
  advance(RECORDING_MAX_DURATION_MS + 1);
  await rejectsCode(restarted.finish(recording.id), 503, 'RECORDING_PROCESSOR_UNAVAILABLE');
  await rejectsCode(restarted.media(recording.id), 409, 'RECORDING_NOT_FINISHED');
});

test('throttles unsuccessful recovery attempts and retains the conservative captured end', async t => {
  const { store, advance } = await fixture(t, { ffmpegPath: join(tmpdir(), 'missing-recording-processor.exe') });
  const recording = await create(store);
  advance(5000);
  await store.putChunk(recording.id, 0, Buffer.from('partial-camera-video'));
  assert.equal((await store.get(recording.id)).lastUploadedAt, new Date(initialTime + 5000).toISOString());
  advance(RECORDING_INACTIVITY_MS);
  assert.deepEqual(await store.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 1 });
  const failed = await store.get(recording.id);
  assert.equal(failed.status, 'processing_failed');
  assert.equal(failed.interrupted, true);
  assert.equal(failed.endedAt, new Date(initialTime + 5000).toISOString());
  assert.deepEqual(await store.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 0 });
  advance(RECORDING_INACTIVITY_MS);
  assert.deepEqual(await store.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 1 });
  assert.equal((await store.get(recording.id)).endedAt, failed.endedAt);
});

test('detects altered committed chunks before merging and keeps them for recovery', async t => {
  const { root, store } = await fixture(t);
  const recording = await create(store);
  await store.putChunk(recording.id, 0, Buffer.from('first'));
  await writeFile(join(root, recording.id, 'chunk-000000.bin'), 'other');
  await rejectsCode(store.finish(recording.id), 500, 'RECORDING_CHUNK_DAMAGED');
  assert.equal((await store.get(recording.id)).status, 'recording');
  assert.equal((await readdir(join(root, recording.id))).filter(name => name.endsWith('.tmp')).length, 0);
});

test('merges ordered streaming WebM chunks and remuxes seekable video without changing frames', async t => {
  try { await access(ffmpeg); } catch { t.skip('Set FFMPEG_PATH or provision Backend/.tools/ffmpeg for the real remux test'); return; }
  const { root, store, now } = await fixture(t, { ffmpegPath: ffmpeg });
  const input = join(root, 'camera.webm');
  await run(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '4', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-g', '10', '-live', '1', '-f', 'webm', input]);
  const bytes = await readFile(input);
  const recording = await create(store);
  const part = Math.ceil(bytes.length / 3);
  for (let sequence = 0; sequence < 3; sequence++) await store.putChunk(recording.id, sequence, bytes.subarray(sequence * part, Math.min(bytes.length, (sequence + 1) * part)));
  const finished = await store.finish(recording.id, { endedAt: initialTime + 4000 });
  assert.equal(finished.status, 'finished');
  assert.equal(finished.seekable, true);
  const restarted = createRecordingStore({ root, now, ffmpegPath: ffmpeg });
  const media = await restarted.media(recording.id);
  assert.equal(media.seekable, true);
  const indexed = await readFile(media.path);
  assert.equal(media.size, indexed.length);
  assert.ok(indexed.includes(Buffer.from('1c53bb6b', 'hex')), 'WebM has Cues for seeking');
  assert.ok(indexed.includes(Buffer.from('4489', 'hex')), 'WebM has duration metadata');
  const frames = text => text.split('\n').filter(line => /^0,/.test(line));
  assert.deepEqual(frames(await run(['-i', input, '-f', 'framemd5', '-'])), frames(await run(['-i', media.path, '-f', 'framemd5', '-'])));
  assert.equal(frames(await run(['-ss', '2', '-i', media.path, '-frames:v', '1', '-f', 'framemd5', '-'])).length, 1);
  assert.equal((await restarted.finish(recording.id)).status, 'finished');
  await restarted.putChunk(recording.id, 0, bytes.subarray(0, part));
  await rejectsCode(restarted.putChunk(recording.id, 3, Buffer.from('extra')), 409, 'RECORDING_FINISHED');
  assert.deepEqual((await readdir(join(root, recording.id))).sort(), ['manifest.json', 'recording.webm']);
});

test('restart maintenance recovers inactive uploaded video after the browser closes', async t => {
  try { await access(ffmpeg); } catch { t.skip('Set FFMPEG_PATH or provision Backend/.tools/ffmpeg for the real remux test'); return; }
  const { root, store, now, advance } = await fixture(t, { ffmpegPath: ffmpeg });
  const input = join(root, 'interrupted.webm');
  await run(['-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=10', '-t', '4', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-g', '10', '-live', '1', '-f', 'webm', input]);
  const recording = await create(store);
  advance(4000);
  await store.putChunk(recording.id, 0, await readFile(input));
  const restarted = createRecordingStore({ root, now, ffmpegPath: ffmpeg });
  advance(RECORDING_INACTIVITY_MS - 1);
  assert.deepEqual(await restarted.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 0 });
  advance(1);
  assert.deepEqual(await restarted.cleanup(), { removed: 0, recovered: 1, recoveryFailed: 0 });
  const recovered = await restarted.get(recording.id);
  assert.equal(recovered.status, 'finished');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.interrupted, true);
  assert.equal(recovered.endedAt, new Date(initialTime + 4000).toISOString());
  assert.equal(recovered.recoveredAt, new Date(now()).toISOString());
  const media = await restarted.media(recording.id);
  assert.equal(media.seekable, true);
  assert.equal((await run(['-ss', '2', '-i', media.path, '-frames:v', '1', '-f', 'framemd5', '-'])).split('\n').filter(line => /^0,/.test(line)).length, 1);
  assert.deepEqual(await restarted.cleanup(), { removed: 0, recovered: 0, recoveryFailed: 0 });
});
