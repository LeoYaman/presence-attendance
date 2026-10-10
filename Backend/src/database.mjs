import pg from 'pg';

export function databaseConfig(dsn) {
  if (!dsn) throw new Error('DATABASE_URL is required');
  let url;
  try { url = new URL(dsn); } catch { throw new Error('Invalid PostgreSQL connection URI'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL URI');
  // URL ssl options can replace pg's ssl object, including verification settings.
  for (const key of ['sslmode','ssl','sslcert','sslkey','sslrootcert','uselibpqcompat']) url.searchParams.delete(key);
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true }, max: 10,
    connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000, query_timeout: 15000,
    application_name: 'presence-api' };
}
export function createPool(dsn) {
  const pool = new pg.Pool(databaseConfig(dsn));
  pool.on('error', () => console.error('Database pool connection error'));
  return pool;
}
export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
