import { loadEnvFile } from 'node:process';
import { createPool } from '../src/database.mjs';
import { createApp } from '../src/server.mjs';
import { createDemoAlerts } from '../src/demo-alerts.mjs';
import { createSubjectRegistryClient } from '../src/subject-registry-client.mjs';
try { loadEnvFile(new URL('../.env',import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let pool, demoAlerts;
try {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('Production requires HTTPS PUBLIC_ORIGIN');
  const registryUrl=process.env.SUBJECT_REGISTRY_URL,registryKey=process.env.SUBJECT_REGISTRY_READ_KEY;
  if(production&&(!registryUrl||!registryKey))throw new Error('Production requires subject registry configuration');
  const subjectRegistry=registryUrl||registryKey?createSubjectRegistryClient({url:registryUrl,readKey:registryKey}):undefined;
  pool = createPool(process.env.DATABASE_URL);
  if (process.env.ALLOW_FICTIONAL_ALERT_DEMO === 'true') {
    demoAlerts=createDemoAlerts({pool});
    await demoAlerts.start();
  }
  const server = createApp({pool,publicOrigin:process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`,
    secureCookies:production || process.env.COOKIE_SECURE === 'true',syntheticCamera:process.env.ALLOW_SYNTHETIC_CAMERA === 'true',demoAlerts,subjectRegistry});
  server.on('close',()=>demoAlerts?.stop());
  server.listen(port,process.env.HOST ?? '127.0.0.1',() => console.log(`Presence listening on port ${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(async () => { await pool.end(); process.exit(0); }));
} catch {
  demoAlerts?.stop();
  console.error('Startup failed. Check DATABASE_URL, PORT, PUBLIC_ORIGIN and SUBJECT_REGISTRY_URL/SUBJECT_REGISTRY_READ_KEY; production requires HTTPS and registry configuration.');
  await pool?.end(); process.exitCode=1;
}
