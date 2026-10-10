import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { transaction } from './database.mjs';

const MAX_BYTES = 256 * 1024;
const MAX_RECORDS = 100;
const ID = /^demo-[a-z0-9][a-z0-9-]{0,62}$/;
const TITLE = 'DEMO — Faculty security is getting informed';
const EXPLANATION = 'This is a fictional simulation. No real call or notification is being made.';
const DEFAULT_FEED = new URL('../../assets/demo-alert-feed.json', import.meta.url);

function validateFeed(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(k => k !== 'records') || !Array.isArray(source.records))
    throw new Error('Invalid demo alert feed: expected only a records array');
  if (source.records.length > MAX_RECORDS) throw new Error(`Invalid demo alert feed: maximum ${MAX_RECORDS} records`);
  const seen = new Set();
  return source.records.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(k => !['id','name','scenario','synthetic','fictional'].includes(k)))
      throw new Error('Invalid demo alert record schema');
    if (record.synthetic !== true || record.fictional !== true) throw new Error('Every demo alert record must be synthetic and fictional');
    if (typeof record.id !== 'string' || !ID.test(record.id) || seen.has(record.id)) throw new Error('Invalid or duplicate demo-prefixed alert id');
    if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 80) throw new Error('Invalid fictional demo alert name');
    if (typeof record.scenario !== 'string' || !record.scenario.trim() || record.scenario.length > 240) throw new Error('Invalid fictional demo alert scenario');
    seen.add(record.id);
    return { id: record.id, name: record.name.trim(), scenario: record.scenario.trim() };
  });
}

export function createDemoAlerts({ pool, feedPath = DEFAULT_FEED, intervalMs = 5000 }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool with connect() is required');
  if (!(typeof feedPath === 'string' && feedPath) && !(feedPath instanceof URL)) throw new TypeError('feedPath must be a path or file URL');
  if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new RangeError('intervalMs must be at least 100');
  let timer;
  let inFlight;
  let started = false;
  let lastSyncedAt = null;
  let lastError = null;
  let lastChecksum = null;

  async function load() {
    const bytes = await readFile(feedPath);
    if (bytes.byteLength > MAX_BYTES) throw new Error(`Demo alert feed exceeds ${MAX_BYTES} bytes`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('Malformed demo alert feed JSON'); }
    return { records: validateFeed(parsed), checksum: createHash('sha256').update(bytes).digest('hex') };
  }
  function sync() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const { records, checksum } = await load(); // Validate fully before opening a write transaction.
      if (checksum === lastChecksum) {
        lastSyncedAt = new Date().toISOString();
        lastError = null;
        return records.length;
      }
      const count = await transaction(pool, async db => {
        for (const record of records) await db.query(`INSERT INTO demo.alerts AS current_alert(id,name,scenario,synthetic,fictional,active)
          VALUES($1,$2,$3,true,true,true) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,scenario=EXCLUDED.scenario,
          synthetic=true,fictional=true,active=true,updated_at=now()
          WHERE current_alert.name IS DISTINCT FROM EXCLUDED.name OR current_alert.scenario IS DISTINCT FROM EXCLUDED.scenario OR NOT current_alert.active`, [record.id, record.name, record.scenario]);
        await db.query('UPDATE demo.alerts SET active=false,updated_at=now() WHERE active=true AND NOT (id = ANY($1::text[]))', [records.map(r => r.id)]);
        return records.length;
      });
      lastSyncedAt = new Date().toISOString();
      lastError = null;
      lastChecksum = checksum;
      return count;
    })().catch(error => {
      lastError = error.message || 'Demo alert feed sync failed';
      throw error;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  async function list() {
    const result = await pool.query('SELECT id,name,scenario,synthetic,fictional FROM demo.alerts WHERE active=true ORDER BY id');
    return result.rows;
  }
  async function simulate(id) {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    const result = await pool.query('SELECT id,name,scenario FROM demo.alerts WHERE id=$1 AND active=true', [id]);
    if (!result.rows.length) return null;
    const alert = result.rows[0];
    const booking = id === 'demo-flight-booking';
    return { ...alert, synthetic: true, fictional: true, notificationSent: false,
      title: booking ? 'Demo — Not allowed on this flight' : TITLE,
      explanation: booking ? 'Fictional reservation DEMO-FLIGHT-001 only. Manually selected test status; no face match or real boarding decision is used.' : EXPLANATION };
  }
  async function start() {
    if (started) return;
    await sync();
    timer = setInterval(() => { void sync().catch(() => {}); }, intervalMs);
    timer.unref?.();
    started = true;
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    started = false;
  }
  function getStatus() { return { lastSyncedAt, lastError }; }
  return { start, stop, sync, list, simulate, getStatus };
}
