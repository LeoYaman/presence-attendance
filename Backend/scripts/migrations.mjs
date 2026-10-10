import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const migrationsDirectory = new URL('../db/migrations/', import.meta.url);

export async function applyMigrations(db, { baseOnly = false } = {}) {
  const names = (await readdir(migrationsDirectory)).filter(n => /^\d+_[a-z_]+\.sql$/.test(n) && (!baseOnly || n < '003')).sort();
  // One transaction makes both migrations and their tracking records atomic.
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(710202610)');
    await db.query(`CREATE TABLE IF NOT EXISTS public.presence_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map((await db.query('SELECT name, checksum FROM public.presence_schema_migrations')).rows.map(r => [r.name, r.checksum]));
    for (const name of applied.keys()) {
      if (!names.includes(name)) throw new Error(`Applied migration is missing locally: ${name}`);
    }
    const newlyApplied = [];
    for (const name of names) {
      const sql = await readFile(new URL(name, migrationsDirectory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO public.presence_schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      newlyApplied.push(name);
    }
    await db.query('COMMIT');
    return newlyApplied;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export const expectedTables = [
  'people', 'users', 'groups', 'group_memberships', 'group_staff',
  'attendance_sessions', 'attendance_records', 'face_enrollments', 'audit_logs',
];

export async function verifySchema(db, { baseOnly = false } = {}) {
  const { rows } = await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'attendance' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const existing = new Set(rows.map(r => r.table_name));
  const missing = [...expectedTables, ...(!baseOnly ? ['attendance_events','auth_sessions','face_datasets','face_dataset_subjects','face_dataset_images','team_face_references'] : [])].filter(t => !existing.has(t));
  if (missing.length) throw new Error(`Missing tables: ${missing.join(', ')}`);
  const tracking = await db.query("SELECT to_regclass('public.presence_schema_migrations') AS tracking");
  if (!tracking.rows[0].tracking) throw new Error('Missing migration tracking table');
  const migrationRows = (await db.query('SELECT name, checksum FROM public.presence_schema_migrations ORDER BY name')).rows;
  const names = (await readdir(migrationsDirectory)).filter(n => /^\d+_[a-z_]+\.sql$/.test(n) && (!baseOnly || n < '003')).sort();
  if (JSON.stringify(names) !== JSON.stringify(migrationRows.map(r => r.name))) throw new Error('Missing or unexpected migration records');
  for (const row of migrationRows) {
    const sql = await readFile(new URL(row.name, migrationsDirectory), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== row.checksum) throw new Error(`Applied migration was modified: ${row.name}`);
  }
  const requiredObjects = {
    views: ['student_history', 'student_absence_summary'],
    functions: ['require_group_manager', 'open_session', 'record_check_in', 'close_session', 'correct_attendance',
      'touch_updated_at', 'validate_group_timezone', 'validate_membership', 'reject_audit_edit'],
    triggers: ['groups_timezone', 'membership_periods', 'audit_append_only', 'people_updated', 'users_updated',
      'groups_updated', 'sessions_updated', 'records_updated', 'enrollments_updated'],
    indexes: ['attendance_records_session_id_person_id_key', 'users_email_unique', 'memberships_one_active',
      'face_one_active_per_person', 'face_template_unique'],
  };
  const objectQueries = {
    views: "SELECT table_name AS name FROM information_schema.views WHERE table_schema='attendance'",
    functions: "SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='attendance'",
    triggers: "SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema='attendance'",
    indexes: "SELECT indexname AS name FROM pg_indexes WHERE schemaname='attendance'",
  };
  for (const [kind, required] of Object.entries(requiredObjects)) {
    const found = new Set((await db.query(objectQueries[kind])).rows.map(r => r.name));
    const missingObjects = required.filter(name => !found.has(name));
    if (missingObjects.length) throw new Error(`Missing ${kind}: ${missingObjects.join(', ')}`);
  }
  if (!baseOnly) {
    const successorColumn = await db.query(`SELECT data_type FROM information_schema.columns
      WHERE table_schema='attendance' AND table_name='attendance_sessions' AND column_name='previous_session_id'`);
    if (successorColumn.rows[0]?.data_type !== 'uuid') throw new Error('Missing session successor column');
    const successorConstraints = new Set((await db.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='attendance.attendance_sessions'::regclass`)).rows.map(row => row.conname));
    for (const name of ['attendance_sessions_previous_session_id_key','attendance_sessions_previous_session_id_fkey','attendance_sessions_previous_session_distinct'])
      if (!successorConstraints.has(name)) throw new Error('Missing session successor constraint: ' + name);
    const eventTriggers = new Set((await db.query(objectQueries.triggers)).rows.map(r => r.name));
    if (!eventTriggers.has('records_event') || !eventTriggers.has('events_append_only')) throw new Error('Missing attendance event triggers');
    const hypertable = await db.query("SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema='attendance' AND hypertable_name='attendance_events'");
    if (!hypertable.rows.length) throw new Error('Missing attendance_events Timescale hypertable');
  }
  return { tables: [...existing], migrations: migrationRows.map(r => r.name) };
}
