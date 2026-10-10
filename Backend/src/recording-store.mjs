import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, lstat, open, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

export const RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RECORDING_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
// Upload queues may drain after capture stops. This does not extend video time.
export const RECORDING_UPLOAD_GRACE_MS = 15 * 60 * 1000;
export const RECORDING_INACTIVITY_MS = 15 * 60 * 1000;
export const RECORDING_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const RECORDING_MAX_CHUNKS = 1450;
export const RECORDING_MAX_BYTES = 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function uuid(value, field = 'Recording ID') {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure(400, 'INVALID_RECORDING_ID', `${field} must be a UUID.`);
  return value.toLowerCase();
}
function timestamp(value, fallback) {
  const result = value == null ? fallback : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw failure(400, 'INVALID_RECORDING_TIME', 'Recording time must be a valid timestamp.');
  return result;
}
function mime(value) {
  if (typeof value !== 'string' || !/^video\/(webm|mp4)(?:;\s*codecs=[\w.," -]+)?$/i.test(value)) {
    throw failure(400, 'INVALID_RECORDING_MIME', 'Recording format must be video/webm or video/mp4.');
  }
  return value.toLowerCase();
}
function extension(recording) { return recording.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'; }
function publicMetadata(recording) {
  const { id, groupId, ownerId, mimeType, startedAt, status, expiresAt, chunkCount, endedAt, bytes, seekable, processingError, lastUploadedAt, recovered, interrupted, recoveredAt } = recording;
  return { id, groupId, ownerId, mimeType, startedAt, status, expiresAt, chunkCount, bytes, lastUploadedAt,
    ...(endedAt ? { endedAt } : {}), ...(status === 'finished' ? { seekable } : {}), ...(processingError ? { processingError } : {}),
    ...(interrupted ? { interrupted: true } : {}), ...(recovered ? { recovered: true, recoveredAt } : {}) };
}

async function remuxVideo(binary, input, output, format) {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-threads', '1'];
  if (format === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', format, output);
  await new Promise((accept, reject) => {
    const process = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    // FFmpeg runs outside the recognition event loop and does no re-encoding.
    process.stderr.on('data', () => {});
    const timeout = setTimeout(() => {
      process.kill();
      reject(failure(503, 'RECORDING_PROCESSING_TIMEOUT', 'Recording processing timed out. Please retry.'));
    }, 120_000);
    timeout.unref();
    process.once('error', () => { clearTimeout(timeout); reject(failure(503, 'RECORDING_PROCESSOR_UNAVAILABLE', 'Video processor is unavailable. Please retry later.')); });
    process.once('exit', code => { clearTimeout(timeout); code === 0 ? accept() : reject(failure(422, 'RECORDING_PROCESSING_FAILED', 'Video container could not be finalized. Please retry.')); });
  });
}

/** Files live outside SQL; chunk and manifest commits survive process restarts.
 * Own this root from one server process. Per-recording operations are serialized.
 * MediaRecorder chunks must belong to the same continuous recorder instance.
 */
export function createRecordingStore({ root = process.env.RECORDINGS_DIR || join(backendRoot, '.recordings'), now = () => Date.now(), ffmpegPath = process.env.FFMPEG_PATH } = {}) {
  const directory = resolve(root);
  const locks = new Map();
  let initialized;
  let processor;
  async function findProcessor() {
    if (processor) return processor;
    if (ffmpegPath) return processor = ffmpegPath;
    const portable = join(backendRoot, '.tools', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try { await access(portable); processor = portable; } catch { processor = 'ffmpeg'; }
    return processor;
  }
  const initialize = () => initialized ||= (async () => {
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure(500, 'UNSAFE_RECORDING_ROOT', 'Recording storage root must be a real directory.');
  })();
  const pathFor = id => join(directory, uuid(id));
  async function safeDirectory(id) {
    await initialize();
    const path = pathFor(id);
    let info;
    try { info = await lstat(path); } catch (error) {
      if (error.code === 'ENOENT') throw failure(404, 'RECORDING_NOT_FOUND', 'Recording was not found.');
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure(404, 'RECORDING_NOT_FOUND', 'Recording was not found.');
    return path;
  }
  function serialized(id, operation) {
    id = uuid(id);
    const previous = locks.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    locks.set(id, pending);
    pending.finally(() => { if (locks.get(id) === pending) locks.delete(id); }).catch(() => {});
    return pending;
  }
  async function load(id, { allowExpired = false } = {}) {
    id = uuid(id);
    const path = await safeDirectory(id);
    const manifest = join(path, 'manifest.json');
    let recording;
    try {
      const info = await lstat(manifest);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error('Unsafe manifest');
      recording = JSON.parse(await readFile(manifest, 'utf8'));
      // Older version-one manifests did not record upload activity.
      recording.lastUploadedAt ??= recording.chunkCount ? new Date(recording.createdAt).toISOString() : null;
      if (recording.version !== 1 || recording.id !== id || uuid(recording.groupId) !== recording.groupId || uuid(recording.ownerId) !== recording.ownerId ||
        mime(recording.mimeType) !== recording.mimeType || !['recording', 'processing_failed', 'finished'].includes(recording.status) ||
        !Number.isFinite(recording.createdAt) || !Number.isSafeInteger(recording.retentionMs ?? RECORDING_RETENTION_MS) || (recording.retentionMs ?? RECORDING_RETENTION_MS)<86400000 || (recording.retentionMs ?? RECORDING_RETENTION_MS)>90*86400000 || Date.parse(recording.expiresAt) !== recording.createdAt + (recording.retentionMs ?? RECORDING_RETENTION_MS) ||
        !Array.isArray(recording.chunks) || recording.chunks.length !== recording.chunkCount || recording.chunkCount > RECORDING_MAX_CHUNKS ||
        !Number.isFinite(Date.parse(recording.startedAt)) || !Number.isSafeInteger(recording.maxBytes ?? RECORDING_MAX_BYTES) || (recording.maxBytes ?? RECORDING_MAX_BYTES)<1048576 || (recording.maxBytes ?? RECORDING_MAX_BYTES)>RECORDING_MAX_BYTES || !Number.isSafeInteger(recording.bytes) || recording.bytes < 0 || recording.bytes > (recording.maxBytes ?? RECORDING_MAX_BYTES) ||
        (recording.chunkCount > 0 && !Number.isFinite(Date.parse(recording.lastUploadedAt))) ||
        (recording.status === 'finished' && (recording.seekable !== true || !Number.isSafeInteger(recording.mediaBytes) || recording.mediaBytes < 1)) ||
        recording.chunks.some(chunk => !Number.isSafeInteger(chunk.size) || chunk.size < 1 || chunk.size > RECORDING_MAX_CHUNK_BYTES || !/^[a-f0-9]{64}$/.test(chunk.hash)) ||
        recording.chunks.reduce((sum, chunk) => sum + chunk.size, 0) !== recording.bytes) throw Error('Invalid manifest');
    } catch (error) {
      if (error.code === 'ENOENT') throw failure(404, 'RECORDING_NOT_FOUND', 'Recording was not found.');
      throw failure(500, 'INVALID_RECORDING_MANIFEST', 'Recording metadata could not be read.');
    }
    if (!allowExpired && now() >= Date.parse(recording.expiresAt)) throw failure(404, 'RECORDING_EXPIRED', 'Recording has expired.');
    return { recording, path };
  }
  async function atomicFile(destination, data) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
  const save = (path, recording) => atomicFile(join(path, 'manifest.json'), JSON.stringify(recording));
  const chunkPath = (path, sequence) => join(path, `chunk-${String(sequence).padStart(6, '0')}.bin`);
  async function safeFile(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw failure(500, 'UNSAFE_RECORDING_FILE', 'Recording data is unavailable.');
    return info;
  }
  let storageTail=Promise.resolve();
  let currentStorageLimit=10240*1048576;
  function storageWrite(operation){const pending=storageTail.catch(()=>{}).then(operation);storageTail=pending;return pending;}
  async function usage(){
    await initialize();let usedBytes=0,recordings=0;
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(!UUID.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())continue;
      const path=await safeDirectory(entry.name);recordings++;
      for(const name of await readdir(path)){const info=await lstat(join(path,name));if(info.isFile()&&!info.isSymbolicLink())usedBytes+=info.size;}
    }
    return {mode:'local',used_bytes:usedBytes,recording_count:recordings,limit_bytes:currentStorageLimit};
  }
  const store = {
    setStorageLimit(bytes){if(!Number.isSafeInteger(bytes)||bytes<1048576||bytes>1048576*1048576)throw failure(400,'INVALID_STORAGE_LIMIT','Storage limit must be 1 MiB to 1 TiB.');currentStorageLimit=bytes;},
    usage,
    create({ groupId, ownerId, mimeType, startedAt, retentionDays=7,maxMb=1024 } = {}) {return storageWrite(async()=>{
      await initialize();
      if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>90||!Number.isInteger(maxMb)||maxMb<1||maxMb>1024)throw failure(400,'INVALID_RECORDING_POLICY','Invalid recording policy.');
      if((await usage()).used_bytes+65536>currentStorageLimit)throw failure(413,'RECORDING_STORAGE_LIMIT','Recording storage limit has been reached.');
      const createdAt = now();
      const starts = timestamp(startedAt, createdAt);
      if (starts > createdAt + 60_000 || starts < createdAt - RECORDING_MAX_DURATION_MS) throw failure(400, 'INVALID_RECORDING_TIME', 'Recording start must be within the last two hours.');
      const recording = { version: 1, id: randomUUID(), groupId: uuid(groupId, 'Group ID'), ownerId: uuid(ownerId, 'Owner ID'),
        mimeType: mime(mimeType), startedAt: new Date(starts).toISOString(), status: 'recording', createdAt,
        retentionMs:retentionDays*86400000,maxBytes:maxMb*1048576,
        expiresAt: new Date(createdAt + retentionDays*86400000).toISOString(), chunkCount: 0, bytes: 0, chunks: [], lastUploadedAt: null };
      const path = pathFor(recording.id);
      await mkdir(path);
      try { await save(path, recording); } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
      return publicMetadata(recording);
    });},
    async get(id) { return publicMetadata((await load(id)).recording); },
    async list(groupId) {
      groupId = uuid(groupId, 'Group ID');
      await initialize();
      const result = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          const { recording } = await load(entry.name);
          if (recording.groupId === groupId) result.push(publicMetadata(recording));
        } catch (error) { if (![404].includes(error.status)) throw error; }
      }
      return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
    putChunk(id, sequence, data) {
      // Copy immediately so caller changes cannot corrupt a queued upload.
      if (!Buffer.isBuffer(data) || data.length === 0 || data.length > RECORDING_MAX_CHUNK_BYTES) return Promise.reject(failure(413, 'INVALID_RECORDING_CHUNK', 'Recording chunks must contain 1 byte to 8 MiB.'));
      if (!Number.isSafeInteger(sequence) || sequence < 0) return Promise.reject(failure(400, 'INVALID_CHUNK_SEQUENCE', 'Chunk sequence must be a nonnegative integer.'));
      const bytes = Buffer.from(data);
      return storageWrite(()=>serialized(id, async () => {
        const { recording, path } = await load(id);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (sequence < recording.chunkCount) {
          const existing = recording.chunks[sequence];
          if (existing.hash !== hash || existing.size !== bytes.length) throw failure(409, 'CHUNK_CONFLICT', 'This chunk sequence already contains different data.');
          return publicMetadata(recording);
        }
        if (recording.status !== 'recording') throw failure(409, 'RECORDING_FINISHED', 'Recording is already finished.');
        if (sequence !== recording.chunkCount) throw failure(409, 'CHUNK_OUT_OF_ORDER', `Expected chunk sequence ${recording.chunkCount}.`);
        if (now() - recording.createdAt > RECORDING_MAX_DURATION_MS + RECORDING_UPLOAD_GRACE_MS || sequence >= RECORDING_MAX_CHUNKS || recording.bytes + bytes.length > (recording.maxBytes ?? RECORDING_MAX_BYTES)) throw failure(413, 'RECORDING_LIMIT', 'Recording exceeds its upload deadline or storage limit.');
        if((await usage()).used_bytes+bytes.length+65536>currentStorageLimit)throw failure(413,'RECORDING_STORAGE_LIMIT','Recording storage limit has been reached.');
        const destination = chunkPath(path, sequence);
        // An uncommitted orphan after a crash can be overwritten safely: the
        // manifest is the commit boundary, and prior committed chunks stay intact.
        try { await safeFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await atomicFile(destination, bytes);
        const updated = { ...recording, chunks: [...recording.chunks, { hash, size: bytes.length }], chunkCount: sequence + 1, bytes: recording.bytes + bytes.length, lastUploadedAt: new Date(now()).toISOString() };
        await save(path, updated);
        return publicMetadata(updated);
      }));
    },
    finish(id, { endedAt } = {}) { return finalize(id, { endedAt }); },
    async media(id) {
      const { recording, path } = await load(id);
      if (recording.status !== 'finished') throw failure(409, 'RECORDING_NOT_FINISHED', 'Recording is still uploading.');
      const mediaPath = join(path, `recording.${extension(recording)}`);
      const info = await safeFile(mediaPath);
      if (info.size !== recording.mediaBytes) throw failure(500, 'RECORDING_MEDIA_DAMAGED', 'Recording data is incomplete.');
      return { path: mediaPath, size: info.size, mimeType: recording.mimeType, seekable: true };
    },
    async cleanup() {
      await initialize();
      let removed = 0, recovered = 0, recoveryFailed = 0;
      const stale = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        await serialized(entry.name, async () => {
          try {
            const { recording, path } = await load(entry.name, { allowExpired: true });
            if (now() >= Date.parse(recording.expiresAt)) {
              await safeDirectory(entry.name);
              await rm(path, { recursive: true, force: true });
              removed++;
            } else if (isStale(recording)) {
              stale.push({ id: recording.id, lastUploadedAt: recording.lastUploadedAt });
            }
          } catch (error) { if (error.status !== 404 && error.code !== 'INVALID_RECORDING_MANIFEST') throw error; }
        });
      }
      // The scan locks have been released. Finalize reacquires each lock and
      // checks activity again, avoiding deadlocks and races with resumed uploads.
      for (const candidate of stale) {
        try {
          if ((await finalize(candidate.id, { recovery: candidate }))?.recovered) recovered++;
        } catch { recoveryFailed++; }
      }
      return { removed, recovered, recoveryFailed };
    },
    async close() { await Promise.allSettled([...locks.values()]); },
  };
  function isStale(recording) {
    return recording.status !== 'finished' && recording.chunkCount > 0 &&
      now() - Date.parse(recording.lastUploadedAt) >= RECORDING_INACTIVITY_MS &&
      (!recording.lastRecoveryAttemptAt || now() - recording.lastRecoveryAttemptAt >= RECORDING_INACTIVITY_MS);
  }
  function finalize(id, { endedAt, recovery } = {}) {
      return storageWrite(()=>serialized(id, async () => {
        const { recording, path } = await load(id);
        if (recording.status === 'finished') return recovery ? null : publicMetadata(recording);
        if (recovery && (recording.lastUploadedAt !== recovery.lastUploadedAt || !isStale(recording))) return null;
        const starts = Date.parse(recording.startedAt);
        const fallback = recording.endedAt ? Date.parse(recording.endedAt) : recovery ? Math.max(starts, Math.min(Date.parse(recording.lastUploadedAt), starts + RECORDING_MAX_DURATION_MS)) : now();
        const ends = timestamp(endedAt, fallback);
        if (ends < starts || ends > starts + RECORDING_MAX_DURATION_MS || ends > now() + 60_000) throw failure(400, 'INVALID_RECORDING_TIME', 'Recording end must follow its start and stay within two hours.');
        if (recording.chunkCount === 0) throw failure(409, 'RECORDING_EMPTY', 'Recording has no video chunks.');
        // Reserve workspace for concatenation and remux before starting either write.
        if((await usage()).used_bytes+2*recording.bytes+65536>currentStorageLimit)throw failure(413,'RECORDING_STORAGE_LIMIT','Free recording storage before finalizing this video.');
        const prepared = { ...recording, endedAt: new Date(ends).toISOString(),
          ...(recovery ? { interrupted: true, lastRecoveryAttemptAt: now() } : {}) };
        // Keep captured end time if the process crashes or processing must retry.
        await save(path, prepared);
        const destination = join(path, `recording.${extension(recording)}`);
        const sourcePath = join(path, `source.${extension(recording)}`);
        const temporary = `${sourcePath}.${randomUUID()}.tmp`;
        const processed = `${destination}.${randomUUID()}.tmp`;
        async function* orderedChunks() {
          for (let sequence = 0; sequence < recording.chunkCount; sequence++) {
            const source = chunkPath(path, sequence);
            const info = await safeFile(source);
            if (info.size !== recording.chunks[sequence].size) throw failure(500, 'RECORDING_CHUNK_DAMAGED', 'A recording chunk is incomplete.');
            const hash = createHash('sha256');
            for await (const data of createReadStream(source)) { hash.update(data); yield data; }
            if (hash.digest('hex') !== recording.chunks[sequence].hash) throw failure(500, 'RECORDING_CHUNK_DAMAGED', 'A recording chunk is damaged.');
          }
        }
        try {
          await pipeline(Readable.from(orderedChunks()), createWriteStream(temporary, { flags: 'wx' }));
          const handle = await open(temporary, 'r+');
          try { await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, sourcePath);
          try {
            await remuxVideo(await findProcessor(), sourcePath, processed, extension(recording));
          } catch (error) {
            await save(path, { ...prepared, status: 'processing_failed', processingError: error.message });
            throw error;
          }
          const mediaBytes = (await safeFile(processed)).size;
          await rename(processed, destination);
          const finished = { ...prepared, status: 'finished', seekable: true, mediaBytes,
            ...(prepared.interrupted ? { recovered: true, recoveredAt: new Date(now()).toISOString() } : {}) };
          delete finished.processingError;
          await save(path, finished);
          // Once manifest commit succeeds the final file is authoritative.
          await Promise.all(recording.chunks.map((_, sequence) => rm(chunkPath(path, sequence), { force: true }).catch(() => {})));
          await rm(sourcePath, { force: true }).catch(() => {});
          return publicMetadata(finished);
        } finally { await Promise.all([rm(temporary, { force: true }), rm(processed, { force: true })]); }
      }));
  }
  return store;
}
