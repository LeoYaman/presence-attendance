import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { applyMigrations } from '../scripts/migrations.mjs';

export async function localDatabase() {
  const engine = new PGlite();
  const db = { query:async (sql,params) => params ? engine.query(sql,params) : (await engine.exec(sql)).at(-1), release() {} };
  // PGlite has one connection. Model pool ownership so concurrent HTTP requests
  // cannot interleave BEGIN/COMMIT on that connection.
  let tail = Promise.resolve();
  async function acquire() {
    let release; const next = new Promise(resolve => { release=resolve; });
    const previous=tail; tail=next; await previous; return release;
  }
  const pool = {
    async query(sql,params) { const release=await acquire(); try { return await db.query(sql,params); } finally { release(); } },
    async connect() { const release=await acquire(); return {query:db.query,release}; },
  };
  await applyMigrations(db,{baseOnly:true});
  // EXPLICIT TEST-ONLY SHIM: PGlite cannot load TimescaleDB. Keep the actual
  // event table and trigger SQL, replacing only extension/hypertable setup.
  const migration = await readFile(new URL('../db/migrations/003_attendance_events.sql',import.meta.url),'utf8');
  const shim = migration.replace(/DO \$\$[\s\S]*?\$\$;/,'').replace('CREATE EXTENSION IF NOT EXISTS timescaledb;','')
    .replace(/^SELECT create_hypertable[^\n]+$/m,'');
  await db.query(shim);
  await db.query(await readFile(new URL('../db/migrations/004_auth_sessions.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../db/migrations/005_future_absence_reporting.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../db/migrations/007_team_face_references.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../db/migrations/008_session_successors.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../db/migrations/009_admin_management.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../db/migrations/010_demo_alerts.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../db/migrations/011_demo_passengers.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../db/migrations/012_demo_olivia_passenger.sql',import.meta.url),'utf8'));
  // SQL implementation used solely to exercise HTTP query shape locally. The
  // opt-in integration suite verifies native Timescale timezone bucket behavior.
  await db.query(`CREATE FUNCTION public.time_bucket(width interval,stamp timestamptz) RETURNS timestamptz
    LANGUAGE SQL IMMUTABLE AS $$ SELECT date_bin(width,stamp,'2000-01-01'::timestamptz) $$;
    CREATE FUNCTION public.time_bucket(width interval,stamp timestamptz,zone text) RETURNS timestamptz
    LANGUAGE SQL STABLE AS $$ SELECT date_bin(width,stamp AT TIME ZONE zone,'2000-01-01'::timestamp) AT TIME ZONE zone $$;`);
  return {engine,db,pool};
}
