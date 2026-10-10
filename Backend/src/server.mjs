import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, opaqueToken, tokenDigest, sessionCookie, readSessionCookie } from './auth.mjs';
import { transaction } from './database.mjs';
import { syntheticRecognition } from './camera.mjs';
import { createFaceWorker } from './face-worker.mjs';
import { createRecordingStore } from './recording-store.mjs';
import { createAdminApi } from './admin.mjs';
import { createPassengerApi } from './passengers.mjs';
import demoCatalog from '../../assets/demo-catalog.json' with { type: 'json' };

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status,code,message); };
const uuid = value => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '')) fail(400,'invalid_id','A valid UUID is required'); return value; };
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    fail(400,'invalid_time','Use an ISO timestamp with a time zone');
  return new Date(value).toISOString();
};
function fields(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !(k in body)))
    fail(400,'invalid_body','Request fields are missing or unsupported');
}
async function readBody(req, limit = 8192) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) fail(415,'json_required','Content-Type must be application/json');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) fail(413,'body_too_large','Request body is too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { fail(400,'invalid_json','Request body must be valid JSON'); }
}
const userView = row => ({ id:row.id,email:row.email,role:row.role,person_id:row.person_id,full_name:row.full_name });
const sessionQuery = 'SELECT * FROM attendance.attendance_sessions WHERE id=$1';
const rosterQuery = `SELECT r.person_id,p.person_code,p.full_name,r.id AS record_id,r.status,r.checked_in_at,r.method,r.confidence,
  CASE r.method WHEN 'manual' THEN 'teacher' WHEN 'face' THEN 'camera' ELSE r.method END AS source
  FROM attendance.attendance_records r JOIN attendance.people p ON p.id=r.person_id WHERE r.session_id=$1 ORDER BY p.full_name`;
export const arrivalsQuery = `WITH latest AS (
  SELECT DISTINCT ON (record_id) * FROM attendance.attendance_events WHERE session_id=$1 ORDER BY record_id,event_time DESC,event_id DESC
) SELECT time_bucket(interval '5 minutes',checked_in_at) AS bucket,count(*)::int AS count FROM latest
WHERE status IN ('present','late') GROUP BY bucket ORDER BY bucket`;
export const dailyQuery = `WITH latest AS (
  SELECT DISTINCT ON (record_id) * FROM attendance.attendance_events WHERE group_id=$1 ORDER BY record_id,event_time DESC,event_id DESC
) SELECT time_bucket(interval '1 day',s.starts_at,g.time_zone) AS bucket,
  count(*) FILTER(WHERE e.status='present')::int AS present,count(*) FILTER(WHERE e.status='late')::int AS late,
  count(*) FILTER(WHERE e.status='absent')::int AS absent,count(*) FILTER(WHERE e.status='pending')::int AS pending,count(*)::int AS total
FROM latest e JOIN attendance.attendance_sessions s ON s.id=e.session_id JOIN attendance.groups g ON g.id=s.group_id
WHERE s.status='closed' AND s.starts_at<=now()
  AND s.starts_at >= $2::timestamptz - interval '30 days' AND s.starts_at < $2::timestamptz + interval '1 day'
GROUP BY bucket ORDER BY bucket`;

export function createApp({ pool, publicOrigin = 'http://localhost:3000', secureCookies = false,
  syntheticCamera = false, demoAlerts = null, frontendRoot = new URL('../../',import.meta.url), recognitionAdapter = syntheticRecognition, faceWorker = createFaceWorker(), recordingStore = createRecordingStore() } = {}) {
  if (!pool) throw new Error('A database pool is required');
  const origin = new URL(publicOrigin).origin;
  if (secureCookies && !origin.startsWith('https://')) throw new Error('Secure cookies require an HTTPS PUBLIC_ORIGIN');
  const attempts = new Map();
  const dummyHashPromise = hashPassword(opaqueToken());
  const adminApi = createAdminApi({pool,fail,uuid,timestamp,fields,recordingStore});
  const passengerApi = createPassengerApi({pool,faceWorker,fail,fields});
  const staticFiles = new Map([['/', ['index.html','text/html; charset=utf-8']], ['/index.html',['index.html','text/html; charset=utf-8']],
    ['/app.js',['app.js','text/javascript; charset=utf-8']], ['/camera-client.js',['camera-client.js','text/javascript; charset=utf-8']], ['/recording-client.js',['recording-client.js','text/javascript; charset=utf-8']], ['/styles.css',['styles.css','text/css; charset=utf-8']]]);
  // Publish only the UI files; credentials, datasets and backend source stay private.
  const uiFiles = {
    'text/html; charset=utf-8': ['criminal-detection.html','criminal-test.html','parent-child.html','login.html','student.html',
      'Frontend/Studentpage/index.html','Frontend/Teacherpage/index.html','teacherPortal/index.html'],
    'text/css; charset=utf-8': ['usecase-workspace.css','neutral-theme.css','login.css','student.css','Frontend/Studentpage/styles.css','Frontend/Teacherpage/styles.css','teacherPortal/styles.css'],
    'text/javascript; charset=utf-8': ['criminal-data.js','usecase-workspace.js','passenger-camera.js','login.js','student.js','customize.js','Frontend/Studentpage/student.js','Frontend/Studentpage/customize.js','teacherPortal/app.js'],
    'image/png': ['ucf-logo.png','ucf-header-logo.png','fullsail-logo.png','fullsail-logo-white.png','fullsail-header-light.png','fullsail-header-dark.png',
      'assets/ucf-logo.png','assets/fullsail-logo.png','assets/fullsail-logo-white.png']
  };
  for (const [type,names] of Object.entries(uiFiles)) for (const name of names) staticFiles.set('/'+name,[name,type]);
  for (const [name,type] of [['demo-alerts.html','text/html'],['demo-alerts.js','text/javascript'],['demo-alerts.css','text/css']]) staticFiles.set('/'+name,[name,type+'; charset=utf-8']);
  // Only publish the named fictional portraits, never arbitrary dataset paths.
  for (const student of demoCatalog.students) {
    if (!/^assets\/student-photos\/STU-\d{4}-[a-z]+(?:-[a-z]+)*\.png$/.test(student.photo)) throw new Error('Invalid demo portrait path');
    staticFiles.set('/'+student.photo,[student.photo,'image/png']);
  }
  for (const [name,type] of [
    ['assets/student-photos/preview.png','image/png'],
    ['assets/student-photos/mapping.json','application/json; charset=utf-8'],
    ['assets/student-photos/mapping.csv','text/csv; charset=utf-8']
  ]) staticFiles.set('/'+name,[name,type]);
  for (const name of ['ucf-logo.png','fullsail-logo.png','fullsail-logo-white.png'])
    staticFiles.set('/teacherPortal/assets/'+name,['assets/'+name,'image/png']);
  async function authenticate(req) {
    const token = readSessionCookie(req.headers.cookie);
    if (!token) fail(401,'authentication_required','Please sign in');
    const { rows } = await pool.query(`SELECT u.id,u.email,u.role,u.person_id,p.full_name,a.csrf_token
      FROM attendance.auth_sessions a JOIN attendance.users u ON u.id=a.user_id
      LEFT JOIN attendance.people p ON p.id=u.person_id
      WHERE a.token_hash=$1 AND a.expires_at>now() AND u.is_active AND (u.person_id IS NULL OR p.is_active)`, [tokenDigest(token)]);
    if (!rows[0]) fail(401,'authentication_required','Please sign in');
    return rows[0];
  }
  async function managedSession(db, sessionId, actor, lock = false) {
    const result = (await db.query(sessionQuery + (lock ? ' FOR UPDATE' : ''),[sessionId])).rows[0];
    if (!result) fail(404,'not_found','Session not found');
    await db.query('SELECT attendance.require_group_manager($1,$2)',[actor.id,result.group_id]);
    return result;
  }
  async function studentProfile(personId, actor, preview = false) {
    return transaction(pool, async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const groups = (await db.query(`SELECT g.* FROM attendance.groups g WHERE
        (EXISTS(SELECT 1 FROM attendance.group_memberships m WHERE m.group_id=g.id AND m.person_id=$1)
          OR EXISTS(SELECT 1 FROM attendance.student_history h WHERE h.group_id=g.id AND h.person_id=$1))
        AND ($2::boolean=false OR $3='admin' OR EXISTS(SELECT 1 FROM attendance.group_staff gs WHERE gs.group_id=g.id AND gs.user_id=$4))
        ORDER BY g.name`,[personId,preview,actor.role,actor.id])).rows;
      if (preview && !groups.length) fail(403,'forbidden','No managed course for this student');
      const profile = (await db.query(`SELECT p.id,p.person_code,p.full_name,
        coalesce(u.email_notifications,false) AS notify_absence FROM attendance.people p
        LEFT JOIN attendance.users u ON u.person_id=p.id AND u.role='student' WHERE p.id=$1 AND p.is_active`,[personId])).rows[0];
      if (!profile) fail(404,'not_found','Student not found');
      const groupIds=groups.map(g=>g.id);
      return {profile,groups,
        history:(await db.query('SELECT * FROM attendance.student_history WHERE person_id=$1 AND group_id=ANY($2::uuid[]) ORDER BY starts_at DESC',[personId,groupIds])).rows,
        summary:(await db.query('SELECT * FROM attendance.student_absence_summary WHERE person_id=$1 AND group_id=ANY($2::uuid[]) ORDER BY group_code',[personId,groupIds])).rows};
    });
  }
  async function route(req,res) {
    const url = new URL(req.url,origin); const path = url.pathname; const method = req.method;
    if (!path.startsWith('/api/')) {
      if (['GET','HEAD'].includes(method) && ['/teacherPortal/index.html','/Frontend/Teacherpage/index.html'].includes(path)) {
        res.writeHead(303,{'Location':'/index.html','Cache-Control':'no-cache'}); res.end(); return;
      }
      if (!['GET','HEAD'].includes(method) || !staticFiles.has(path)) fail(404,'not_found','Page not found');
      const [name,type] = staticFiles.get(path);
      const bytes = await readFile(new URL(name,frontendRoot));
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'}); res.end(method === 'HEAD' ? undefined : bytes); return;
    }
    if (url.search && !path.startsWith('/api/admin/')) fail(400,'unsupported_query','Query parameters are unsupported');
    const recordingChunkRoute=path.match(/^\/api\/recordings\/([^/]+)\/chunks\/(\d+)$/);
    if (!['GET','POST'].includes(method) && !(method==='PUT'&&recordingChunkRoute)) fail(405,'method_not_allowed','Method not allowed');
    if (['POST','PUT'].includes(method) && req.headers.origin !== origin) fail(403,'invalid_origin','Request must come from this application');
    const body = method === 'POST' ? await readBody(req, (path==='/api/passengers/detect'||/^\/api\/groups\/[^/]+\/faces\/(detect|enroll)$/.test(path)) ? 400000 : 8192) : null;
    if (path === '/api/login' && method === 'POST') {
      fields(body,['email','password'],['email','password']);
      if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
          typeof body.password !== 'string' || !body.password.length || body.password.length > 256) fail(400,'invalid_credentials','Email and password are required');
      const now = Date.now(); const address = req.socket.remoteAddress;
      for (const [key,value] of attempts) if (value.reset < now) attempts.delete(key);
      if (!attempts.has(address) && attempts.size >= 10000) fail(429,'rate_limited','Please try again later');
      const attempt = attempts.get(address) ?? { count:0, reset:now + 15*60*1000 }; attempts.set(address,attempt);
      if (++attempt.count > 15) fail(429,'rate_limited','Too many sign-in attempts; try again later');
      const user = (await pool.query(`SELECT u.*,p.full_name,p.is_active AS person_active FROM attendance.users u
        LEFT JOIN attendance.people p ON p.id=u.person_id WHERE lower(btrim(u.email))=lower($1)`,[body.email.trim()])).rows[0];
      const valid = await verifyPassword(body.password,user?.password_hash ?? await dummyHashPromise);
      if (!valid || !user?.is_active || (user.person_id && !user.person_active)) fail(401,'invalid_credentials','Email or password is incorrect');
      const token = opaqueToken(); const csrfToken = opaqueToken(); const expiry = new Date(now + 8*60*60*1000);
      await transaction(pool,async db => {
        const old = readSessionCookie(req.headers.cookie);
        if (old) await db.query('DELETE FROM attendance.auth_sessions WHERE token_hash=$1',[tokenDigest(old)]);
        await db.query('DELETE FROM attendance.auth_sessions WHERE expires_at<=now()');
        await db.query('INSERT INTO attendance.auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)',[tokenDigest(token),user.id,csrfToken,expiry]);
      });
      res.setHeader('Set-Cookie',sessionCookie(token,secureCookies,expiry));
      return {user:userView(user),csrfToken,capabilities:{syntheticCamera}};
    }
    const user = await authenticate(req);
    if (['POST','PUT'].includes(method)) {
      const supplied = req.headers['x-csrf-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(user.csrf_token)))
        fail(403,'invalid_csrf','Refresh the page and try again');
    }
    if (path === '/api/me' && method === 'GET') return {user:userView(user),csrfToken:user.csrf_token,capabilities:{syntheticCamera}};
    if (path === '/api/passengers' || path === '/api/passengers/detect') return passengerApi({method,path,user,body});
    if (path === '/api/demo-alerts' || path === '/api/demo-alerts/simulate') {
      if (!['teacher','admin'].includes(user.role)) fail(403,'forbidden','This simulation requires a teacher or administrator');
      if (!demoAlerts) fail(503,'demo_disabled','The fictional alert demo is not enabled');
      if (path === '/api/demo-alerts' && method === 'GET') return {synthetic:true,records:await demoAlerts.list(),sync:demoAlerts.getStatus?.()};
      if (path === '/api/demo-alerts/simulate' && method === 'POST') {
        fields(body,['id'],['id']);
        if (typeof body.id !== 'string' || !/^demo-[a-z0-9-]{1,64}$/.test(body.id)) fail(400,'invalid_demo_id','Choose a fictional demo scenario');
        const result = await demoAlerts.simulate(body.id);
        if (!result) fail(404,'not_found','This fictional scenario is no longer active');
        return result;
      }
      fail(405,'method_not_allowed','Method not allowed');
    }
    if (path.startsWith('/api/admin/')) return adminApi({req,res,url,user,body});
    const recordingGroupRoute=path.match(/^\/api\/groups\/([^/]+)\/recordings$/);
    const recordingRoute=path.match(/^\/api\/recordings\/([^/]+)\/(finish|video)$/);
    if(recordingGroupRoute||recordingChunkRoute||recordingRoute){
      const storeCall=async operation=>{
        try{return await operation();}catch(error){
          if(Number.isInteger(error.status))throw new HttpError(error.status,error.code||'recording_error',error.message);
          throw error;
        }
      };
      const authorizeGroup=groupId=>transaction(pool,db=>db.query('SELECT attendance.require_group_manager($1,$2)',[user.id,groupId]),{readOnly:true});
      if(recordingGroupRoute){
        const groupId=uuid(recordingGroupRoute[1]); await authorizeGroup(groupId);
        if(method==='GET')return {recordings:await storeCall(()=>recordingStore.list(groupId))};
        if(method==='POST'){
          fields(body,['mimeType','startedAt'],['mimeType','startedAt']);
          const policy=(await pool.query('SELECT * FROM attendance.admin_settings WHERE singleton=true')).rows[0];
          recordingStore.setStorageLimit?.(policy.recording_storage_max_mb*1048576);
          return {recording:await storeCall(()=>recordingStore.create({groupId,ownerId:user.id,mimeType:body.mimeType,startedAt:timestamp(body.startedAt),retentionDays:policy.recording_retention_days,maxMb:policy.recording_max_mb}))};
        }
        fail(405,'method_not_allowed','Method not allowed');
      }
      const id=uuid((recordingChunkRoute||recordingRoute)[1]);
      if(method==='POST'||method==='PUT'){
        const policy=(await pool.query('SELECT recording_storage_max_mb FROM attendance.admin_settings WHERE singleton=true')).rows[0];
        recordingStore.setStorageLimit?.(policy.recording_storage_max_mb*1048576);
      }
      const recording=await storeCall(()=>recordingStore.get(id));
      await authorizeGroup(recording.groupId);
      if(recordingChunkRoute&&method==='PUT'){
        if(recording.ownerId!==user.id)fail(403,'forbidden','Only the recording owner can upload video');
        if((req.headers['content-type']||'').split(';')[0]!==recording.mimeType.split(';')[0])fail(415,'invalid_recording_type','Video content type must match the recording');
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>8*1024*1024)fail(413,'recording_chunk_too_large','Video chunk exceeds 8 MiB');chunks.push(chunk);}
        return {recording:await storeCall(()=>recordingStore.putChunk(id,Number(recordingChunkRoute[2]),Buffer.concat(chunks)))};
      }
      if(recordingRoute?.[2]==='finish'&&method==='POST'){
        if(recording.ownerId!==user.id)fail(403,'forbidden','Only the recording owner can finish video');
        fields(body,['endedAt'],['endedAt']);
        return {recording:await storeCall(()=>recordingStore.finish(id,{endedAt:timestamp(body.endedAt)}))};
      }
      if(recordingRoute?.[2]==='video'&&method==='GET'){
        const media=await storeCall(()=>recordingStore.media(id));
        let start=0,end=media.size-1,status=200;
        if(req.headers.range){
          const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if(!match||(!match[1]&&!match[2])){res.setHeader('Content-Range',`bytes */${media.size}`);fail(416,'invalid_range','Invalid video byte range');}
          if(!match[1])start=Math.max(0,media.size-Number(match[2]));
          else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start> end||start>=media.size){res.setHeader('Content-Range',`bytes */${media.size}`);fail(416,'invalid_range','Invalid video byte range');}
          status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${media.size}`);
        }
        res.writeHead(status,{'Content-Type':media.mimeType,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, no-store'});
        await pipeline(createReadStream(media.path,{start,end}),res);return;
      }
      fail(405,'method_not_allowed','Method not allowed');
    }
    const portraitRoute=path.match(/^\/api\/team-portraits\/(team_anthony|team_leo|team_rebbeca|team_olivia)$/);
    if (portraitRoute && method === 'GET') {
      const bytes=await transaction(pool,async db=>{
        const reference=(await db.query(`SELECT r.group_id,r.image_bytes FROM attendance.team_face_references r
          JOIN attendance.people p ON p.id=r.person_id JOIN attendance.groups g ON g.id=r.group_id
          WHERE r.reference_key=$1 AND r.is_active AND p.is_active AND g.is_active`,[portraitRoute[1]])).rows[0];
        if(!reference) fail(404,'not_found','Team portrait not found');
        await db.query('SELECT attendance.require_group_manager($1,$2)',[user.id,reference.group_id]);
        return Buffer.from(reference.image_bytes);
      },{readOnly:true});
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'}); res.end(bytes); return;
    }
    if (path === '/api/student-profile' && method === 'GET') {
      if(user.role!=='student'||!user.person_id) fail(403,'forbidden','Student access required');
      return studentProfile(user.person_id,user);
    }
    if (path === '/api/preferences' && method === 'POST') {
      if(user.role!=='student'||!user.person_id) fail(403,'forbidden','Student access required');
      fields(body,['notify_absence'],['notify_absence']);
      if(typeof body.notify_absence!=='boolean') fail(400,'invalid_body','Notification preference must be boolean');
      await pool.query('UPDATE attendance.users SET email_notifications=$1 WHERE id=$2',[body.notify_absence,user.id]);
      return {notify_absence:body.notify_absence};
    }
    if (path === '/api/student-preview' && method === 'GET') {
      if(!['teacher','admin'].includes(user.role)) fail(403,'forbidden','Teacher access required');
      const students=(await pool.query(`SELECT DISTINCT p.id,p.person_code,p.full_name FROM attendance.people p
        JOIN (SELECT person_id,group_id FROM attendance.group_memberships UNION SELECT person_id,group_id FROM attendance.student_history) membership ON membership.person_id=p.id
        WHERE p.is_active AND ($1='admin' OR EXISTS(SELECT 1 FROM attendance.group_staff gs WHERE gs.group_id=membership.group_id AND gs.user_id=$2))
        ORDER BY p.full_name`,[user.role,user.id])).rows;
      return {students};
    }
    const previewRoute=path.match(/^\/api\/student-preview\/([^/]+)$/);
    if(previewRoute && method==='GET') {
      if(!['teacher','admin'].includes(user.role)) fail(403,'forbidden','Teacher access required');
      return studentProfile(uuid(previewRoute[1]),user,true);
    }
    if (path === '/api/logout' && method === 'POST') {
      fields(body,[]); await pool.query('DELETE FROM attendance.auth_sessions WHERE token_hash=$1',[tokenDigest(readSessionCookie(req.headers.cookie))]);
      res.setHeader('Set-Cookie',sessionCookie('',secureCookies,null)); return {ok:true};
    }
    if (path === '/api/groups' && method === 'GET') {
      const { rows } = await pool.query(`SELECT g.* FROM attendance.groups g WHERE
        $1='admin' OR ($1='teacher' AND EXISTS(SELECT 1 FROM attendance.group_staff gs WHERE gs.group_id=g.id AND gs.user_id=$2))
        OR ($1='student' AND (EXISTS(SELECT 1 FROM attendance.group_memberships m WHERE m.group_id=g.id AND m.person_id=$3)
          OR EXISTS(SELECT 1 FROM attendance.attendance_records r JOIN attendance.attendance_sessions s ON s.id=r.session_id WHERE s.group_id=g.id AND r.person_id=$3)))
        ORDER BY g.name`,[user.role,user.id,user.person_id]); return {groups:rows};
    }
    if (path === '/api/history' && method === 'GET') {
      if (user.role !== 'student' || !user.person_id) fail(403,'forbidden','Student access required');
      return transaction(pool, async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return {history:(await db.query('SELECT * FROM attendance.student_history WHERE person_id=$1 ORDER BY starts_at DESC',[user.person_id])).rows,
          summary:(await db.query('SELECT * FROM attendance.student_absence_summary WHERE person_id=$1 ORDER BY group_code',[user.person_id])).rows};
      });
    }
    const firstCheckIn = path.match(/^\/api\/groups\/([^/]+)\/checkins$/);
    if (firstCheckIn && method === 'POST') {
      const groupId=uuid(firstCheckIn[1]);
      fields(body,['personId'],['personId']); const personId=uuid(body.personId);
      return transaction(pool,async db=>{
        await db.query('SELECT attendance.require_group_manager($1,$2)',[user.id,groupId]);
        const group=(await db.query('SELECT * FROM attendance.groups WHERE id=$1 FOR UPDATE',[groupId])).rows[0];
        if(!group.is_active)fail(409,'inactive_group','Group is inactive');
        // The group lock makes concurrent first faces and retries share a
        // session; preparation and attendance have one durable commit.
        let session=(await db.query(`SELECT * FROM attendance.attendance_sessions WHERE group_id=$1
          AND status='open' AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp()
          ORDER BY starts_at DESC LIMIT 1`,[groupId])).rows[0];
        if(!session){
          session=(await db.query(`WITH new_window AS (SELECT clock_timestamp() AS starts_at)
            INSERT INTO attendance.attendance_sessions(group_id,starts_at,ends_at,late_after_minutes,created_by)
            SELECT $1,starts_at,starts_at+interval '1 hour',(SELECT default_late_after_minutes FROM attendance.admin_settings WHERE singleton=true),$2 FROM new_window RETURNING *`,[groupId,user.id])).rows[0];
          await db.query('SELECT attendance.open_session($1,$2)',[session.id,user.id]);
        }
        const record=(await db.query('SELECT * FROM attendance.record_check_in($1,$2,$3)',[session.id,personId,user.id])).rows[0];
        return {session:(await db.query(sessionQuery,[session.id])).rows[0],record,
          roster:(await db.query(rosterQuery,[session.id])).rows};
      });
    }
    const faceRoute = path.match(/^\/api\/groups\/([^/]+)\/faces\/(detect|enroll|clear)$/);
    if (faceRoute && method === 'POST') {
      const groupId = uuid(faceRoute[1]), action = faceRoute[2];
      fields(body, action === 'enroll' ? ['image','personId'] : action === 'detect' ? ['image'] : [], action === 'enroll' ? ['image','personId'] : action === 'detect' ? ['image'] : []);
      if (action !== 'clear' && (typeof body.image !== 'string' || body.image.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))) fail(400,'invalid_image','A base64 JPEG camera frame is required');
      if (action === 'enroll') uuid(body.personId);
      const {allowedIds, referenceMappings} = await transaction(pool, async db => {
        await db.query('SELECT attendance.require_group_manager($1,$2)',[user.id,groupId]);
        const allowedIds = (await db.query(`SELECT p.id FROM attendance.group_memberships m JOIN attendance.people p ON p.id=m.person_id
          WHERE m.group_id=$1 AND m.joined_at<=now() AND (m.left_at IS NULL OR m.left_at>now()) AND p.is_active`,[groupId])).rows.map(row => row.id);
        // A person can attend several courses; reuse their saved reference only
        // when this manager is also authorized for its source group.
        const references = action === 'detect' ? (await db.query(`SELECT r.reference_key,r.person_id
          FROM attendance.team_face_references r JOIN attendance.groups g ON g.id=r.group_id
          WHERE r.is_active AND g.is_active AND r.person_id=ANY($1::uuid[])
            AND ($2='admin' OR EXISTS(SELECT 1 FROM attendance.group_staff gs WHERE gs.group_id=r.group_id AND gs.user_id=$3))
          ORDER BY r.reference_key`,[allowedIds,user.role,user.id])).rows : [];
        return {allowedIds, referenceMappings:references.filter(row => allowedIds.includes(row.person_id)).map(row => ({referenceKey:row.reference_key,personId:row.person_id}))};
      }, {readOnly:true});
      if (action === 'enroll' && !allowedIds.includes(body.personId)) fail(403,'not_in_roster','Choose an active student from this course roster');
      try { return await faceWorker.request({ action, groupId, allowedIds, referenceMappings, ...body }); }
      catch (error) { throw new HttpError(error.status || 503, error.code || 'face_service_unavailable', error.message || 'Face service unavailable'); }
    }
    let match = path.match(/^\/api\/groups\/([^/]+)\/(roster|sessions)$/);
    if (match) {
      const groupId = uuid(match[1]); const action = match[2];
      return transaction(pool,async db => {
        await db.query('SELECT attendance.require_group_manager($1,$2)',[user.id,groupId]);
        if (!(await db.query('SELECT id FROM attendance.groups WHERE id=$1',[groupId])).rows.length) fail(404,'not_found','Group not found');
        if (action === 'roster' && method === 'GET') return {roster:(await db.query(`SELECT p.id AS person_id,p.person_code,p.full_name FROM attendance.group_memberships m
          JOIN attendance.people p ON p.id=m.person_id WHERE m.group_id=$1 AND m.joined_at<=now() AND (m.left_at IS NULL OR m.left_at>now()) AND p.is_active ORDER BY p.full_name`,[groupId])).rows};
        if (action === 'sessions' && method === 'GET') return {sessions:(await db.query('SELECT * FROM attendance.attendance_sessions WHERE group_id=$1 ORDER BY starts_at DESC LIMIT 100',[groupId])).rows};
        if (action === 'sessions' && method === 'POST') {
          fields(body,['startsAt','endsAt','lateAfterMinutes'],['startsAt','endsAt']);
          const starts = timestamp(body.startsAt); const ends = timestamp(body.endsAt); const late = body.lateAfterMinutes ?? (await db.query('SELECT default_late_after_minutes FROM attendance.admin_settings WHERE singleton=true')).rows[0].default_late_after_minutes;
          if (ends <= starts || !Number.isInteger(late) || late < 0 || late > 1440) fail(400,'invalid_session','End must follow start and late threshold must be 0–1440 minutes');
          const group = (await db.query('SELECT * FROM attendance.groups WHERE id=$1 FOR UPDATE',[groupId])).rows[0];
          if (!group.is_active) fail(409,'inactive_group','Group is inactive');
          const session = (await db.query(`INSERT INTO attendance.attendance_sessions(group_id,starts_at,ends_at,late_after_minutes,created_by)
            VALUES($1,$2,$3,$4,$5) RETURNING *`,[groupId,starts,ends,late,user.id])).rows[0]; return {session};
        }
        fail(405,'method_not_allowed','Method not allowed');
      });
    }
    match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(open|close|approve-next|checkins|dashboard))?$/);
    if (match) {
      const sessionId = uuid(match[1]); const action = match[2];
      return transaction(pool,async db => {
        if (method === 'GET') await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const session = await managedSession(db,sessionId,user,method === 'POST' && action === 'approve-next');
        if (method === 'GET' && (!action || action === 'dashboard')) {
          const roster = (await db.query(rosterQuery,[sessionId])).rows;
          if (!action) return {session,roster};
          const distribution = {pending:0,present:0,late:0,absent:0,total:roster.length};
          for (const row of roster) distribution[row.status]++;
          return {session,roster,distribution,arrivals:(await db.query(arrivalsQuery,[sessionId])).rows,
            daily:(await db.query(dailyQuery,[session.group_id,session.starts_at])).rows};
        }
        if (method === 'POST' && action === 'approve-next') {
          fields(body,[]);
          const isFuture = (await db.query('SELECT $1::timestamptz > clock_timestamp() AS future',[session.starts_at])).rows[0].future;
          if (isFuture) fail(409,'future_session','A future session cannot be approved before its scheduled start');
          if (!['open','closed'].includes(session.status)) fail(409,'workflow_conflict','Only open or closed sessions can be approved');
          // The predecessor lock covers finalization and creation, so concurrent
          // approvals return one successor even after the first request commits.
          await db.query('SELECT attendance.close_session($1,$2)',[sessionId,user.id]);
          const approvedSession = (await db.query(sessionQuery,[sessionId])).rows[0];
          let next = (await db.query('SELECT * FROM attendance.attendance_sessions WHERE previous_session_id=$1',[sessionId])).rows[0];
          if (!next) {
            next = (await db.query(`WITH next_window AS (SELECT clock_timestamp() AS starts_at)
              INSERT INTO attendance.attendance_sessions(group_id,starts_at,ends_at,late_after_minutes,created_by,previous_session_id)
              SELECT $1,starts_at,starts_at + interval '1 hour',$2,$3,$4 FROM next_window RETURNING *`,
              [session.group_id,session.late_after_minutes,user.id,sessionId])).rows[0];
            await db.query('SELECT attendance.open_session($1,$2)',[next.id,user.id]);
            next = (await db.query(sessionQuery,[next.id])).rows[0];
          }
          return {approvedSession,approvedRoster:(await db.query(rosterQuery,[sessionId])).rows,
            session:next,roster:(await db.query(rosterQuery,[next.id])).rows};
        }
        if (method === 'POST' && ['open','close'].includes(action)) {
          fields(body,[]);
          const isFuture = (await db.query('SELECT $1::timestamptz > clock_timestamp() AS future',[session.starts_at])).rows[0].future;
          if (isFuture) fail(409,'future_session','A future session cannot be opened or finalized before its scheduled start');
          const routine = action === 'open' ? 'open_session' : 'close_session';
          const n = (await db.query(`SELECT attendance.${routine}($1,$2) AS n`,[sessionId,user.id])).rows[0].n;
          return {session:(await db.query(sessionQuery,[sessionId])).rows[0],[action === 'open' ? 'participants' : 'absentCount']:n};
        }
        if (method === 'POST' && action === 'checkins') {
          fields(body,['personId','source','confidence'],['personId','source']); const personId = uuid(body.personId);
          if (!['teacher','camera'].includes(body.source)) fail(400,'invalid_source','Source must be teacher or camera');
          if (body.confidence !== undefined && (typeof body.confidence !== 'number' || body.confidence < 0 || body.confidence > 1)) fail(400,'invalid_confidence','Confidence must be between zero and one');
          let result;
          if (body.source === 'camera') {
            const trusted = await recognitionAdapter(db,{groupId:session.group_id,sessionId,personId,request:req},syntheticCamera);
            if (!trusted || (trusted.synthetic && !syntheticCamera)) fail(501,'camera_unavailable','Real camera recognition is not configured. Synthetic mode is limited to the labeled demo group.');
            uuid(trusted.personId); uuid(trusted.enrollmentId);
            if (typeof trusted.confidence !== 'number' || !Number.isFinite(trusted.confidence) || trusted.confidence < 0 || trusted.confidence > 1)
              fail(503,'recognition_invalid','Recognition adapter returned an invalid result');
            result = await db.query(`SELECT * FROM attendance.record_check_in($1,$2,$3,'face',$4,$5)`,[sessionId,trusted.personId,user.id,trusted.confidence,trusted.enrollmentId]);
          } else {
            if (body.confidence !== undefined) fail(400,'invalid_confidence','Teacher check-in cannot contain recognition confidence');
            result = await db.query('SELECT * FROM attendance.record_check_in($1,$2,$3)',[sessionId,personId,user.id]);
          }
          return {record:result.rows[0],synthetic:body.source === 'camera' && syntheticCamera && recognitionAdapter === syntheticRecognition};
        }
        fail(405,'method_not_allowed','Method not allowed');
      });
    }
    match = path.match(/^\/api\/records\/([^/]+)\/correction$/);
    if (match && method === 'POST') {
      const recordId = uuid(match[1]); fields(body,['status','reason','checkedInAt'],['status','reason']);
      if (!['present','late','absent'].includes(body.status) || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000)
        fail(400,'invalid_correction','Provide an attendance status and a reason of 1–1000 characters');
      const checked = body.checkedInAt == null ? null : timestamp(body.checkedInAt);
      if ((body.status === 'absent' && checked) || (body.status !== 'absent' && !checked)) fail(400,'invalid_correction','Present or late requires a time; absent requires no time');
      return {record:(await pool.query('SELECT * FROM attendance.correct_attendance($1,$2,$3,$4,$5)',[recordId,user.id,body.status,body.reason.trim(),checked])).rows[0]};
    }
    fail(404,'not_found','Endpoint not found');
  }
  const server = createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const result = await route(req,res);
      if (!res.writableEnded) { res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(result)); }
    } catch (error) {
      if(res.headersSent){res.destroy();return;}
      let status = error.status; let code = error.code; let message = error.message;
      if (!(error instanceof HttpError)) {
        if (error.code === '42501') { status=403; code='forbidden'; message='You are not authorized for this group'; }
        else if (error.code === 'P0001') { status=409; code='workflow_conflict'; message='Attendance operation conflicts with the session state or attendance window'; }
        else if (['23503','23505','23514','22007','22008'].includes(error.code)) { status=400; code='invalid_data'; message='The data violates an attendance constraint'; }
        else { status=503; code='service_unavailable'; message='Attendance service is unavailable. Check backend configuration and migrations.'; console.error(`Request failed (${error.code ?? 'internal'})`); }
      }
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify({error:{code,message}}));
    }
  });
  let recordingCleanup;
  const cleanRecordings=async()=>{
    try{
      const policy=(await pool.query('SELECT recording_storage_max_mb FROM attendance.admin_settings WHERE singleton=true')).rows[0];
      recordingStore.setStorageLimit?.(policy.recording_storage_max_mb*1048576);
      await recordingStore.cleanup();
    }catch{console.error('Recording retention cleanup failed; it will retry.');}
  };
  server.on('listening', () => {
    faceWorker.start?.(); cleanRecordings();
    recordingCleanup=setInterval(cleanRecordings,5*60*1000);recordingCleanup.unref();
  });
  server.on('close', () => {clearInterval(recordingCleanup);faceWorker.close();});
  return server;
}
