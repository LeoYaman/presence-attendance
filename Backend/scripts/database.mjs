import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { applyMigrations, verifySchema } from './migrations.mjs';

try { loadEnvFile(new URL('../.env', import.meta.url)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const command = process.argv[2];
if (!['check', 'migrate', 'verify'].includes(command)) {
  console.error('Usage: node scripts/database.mjs check|migrate|verify');
  process.exit(1);
}
const dsn = process.env.DATABASE_URL;
if (!dsn) {
  console.error('Set DATABASE_URL in Backend/.env using your Tiger Data service connection URI.');
  process.exit(1);
}

let client;
try {
  const url = new URL(dsn);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL URI');
  // pg URL SSL options can override its ssl object. Remove them, then enforce TLS verification.
  for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
  client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000, query_timeout: 60000, application_name: 'presence-database-setup' });
  await client.connect();
  await client.query("SET timezone = 'UTC'");
  if (command === 'migrate') {
    const applied = await applyMigrations(client);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database migrations are already up to date.');
    console.log(JSON.stringify(await verifySchema(client), null, 2));
  } else if (command === 'verify') {
    console.log(JSON.stringify(await verifySchema(client), null, 2));
  } else {
    const { rows } = await client.query('SELECT current_database() AS database, current_user AS db_user, version() AS version');
    console.log(JSON.stringify(rows[0], null, 2));
    console.log('Connected with TLS certificate verification enabled.');
  }
} catch (error) {
  // Never print a connection URI, password, or raw connection error.
  if (error.code === '0A000' && error.message?.startsWith('TimescaleDB is required')) {
    console.error('TimescaleDB is required for migration 003. Configure a Timescale-enabled PostgreSQL service. No migrations were committed.');
  } else if (error.message?.startsWith('Applied migration') || error.message?.startsWith('Missing ')) {
    console.error(error.message);
  } else {
    console.error(`Database ${command} failed (${error.code ?? 'configuration/error'}). Check service readiness, connection settings, and migration compatibility.`);
  }
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
