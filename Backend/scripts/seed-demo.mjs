import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { createPool,transaction } from '../src/database.mjs';
import { hashPassword } from '../src/auth.mjs';
import { verifySchema } from './migrations.mjs';
const scopedId = n => `d3102026-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const demo = { groupId:scopedId(1),teacherId:scopedId(2),adminId:scopedId(3),
  teacherEmail:'teacher@presence-demo.test',adminEmail:'admin@presence-demo.test',studentEmail:'student1@presence-demo.test' };

export async function seedDemo(db,password,{ now = new Date() } = {}) {
  const hash = await hashPassword(password);
  const group = (await db.query('SELECT code,name FROM attendance.groups WHERE id=$1',[demo.groupId])).rows[0];
  if (group && (group.code!=='PRESENCE-DEMO-SYNTHETIC' || !group.name.startsWith('[SYNTHETIC DEMO]'))) throw new Error('Synthetic ID scope is already occupied');
  for (const [userId,email] of [[demo.teacherId,demo.teacherEmail],[demo.adminId,demo.adminEmail],...Array.from({length:8},(_,i)=>[scopedId(200+i),`student${i+1}@presence-demo.test`])]) {
    const user=(await db.query('SELECT email,role,person_id FROM attendance.users WHERE id=$1',[userId])).rows[0];
    const expectedRole=userId===demo.teacherId?'teacher':userId===demo.adminId?'admin':'student';
    const expectedPerson=expectedRole==='student'?scopedId(100+Number(userId.slice(-12))-200):null;
    if (user && (user.email!==email || user.role!==expectedRole || user.person_id!==expectedPerson)) throw new Error('Synthetic user ID scope is already occupied');
  }
  await db.query(`INSERT INTO attendance.users(id,email,password_hash,role) VALUES($1,$2,$3,'teacher'),($4,$5,$3,'admin') ON CONFLICT(id) DO NOTHING`,
    [demo.teacherId,demo.teacherEmail,hash,demo.adminId,demo.adminEmail]);
  await db.query(`INSERT INTO attendance.groups(id,code,name,course_code,term_name,term_starts_on,term_ends_on,time_zone)
    VALUES($1,'PRESENCE-DEMO-SYNTHETIC','[SYNTHETIC DEMO] Attendance Lab','DEMO101','Synthetic demonstration',
    $2::date-90,$2::date+90,'America/New_York') ON CONFLICT(id) DO NOTHING`,[demo.groupId,now]);
  await db.query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[demo.groupId,demo.teacherId]);
  for (let i=0;i<8;i++) {
    const personId=scopedId(100+i); const userId=scopedId(200+i); const personCode=`PRESENCE-DEMO-${i+1}`;
    const person=(await db.query('SELECT person_code FROM attendance.people WHERE id=$1',[personId])).rows[0];
    if (person && person.person_code!==personCode) throw new Error('Synthetic person ID scope is already occupied');
    const membership=(await db.query('SELECT group_id,person_id FROM attendance.group_memberships WHERE id=$1',[scopedId(300+i)])).rows[0];
    if (membership && (membership.group_id!==demo.groupId || membership.person_id!==personId)) throw new Error('Synthetic membership ID scope is already occupied');
    const enrollment=(await db.query('SELECT person_id,provider FROM attendance.face_enrollments WHERE id=$1',[scopedId(400+i)])).rows[0];
    if (enrollment && (enrollment.person_id!==personId || enrollment.provider!=='presence-synthetic-demo')) throw new Error('Synthetic enrollment ID scope is already occupied');
    await db.query('INSERT INTO attendance.people(id,person_code,full_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[personId,personCode,`Demo Student ${i+1}`]);
    await db.query(`INSERT INTO attendance.users(id,email,password_hash,role,person_id) VALUES($1,$2,$3,'student',$4) ON CONFLICT(id) DO NOTHING`,[userId,`student${i+1}@presence-demo.test`,hash,personId]);
    await db.query(`INSERT INTO attendance.group_memberships(id,group_id,person_id,joined_at) VALUES($1,$2,$3,$4::timestamptz-interval '90 days') ON CONFLICT(id) DO NOTHING`,[scopedId(300+i),demo.groupId,personId,now]);
    await db.query(`INSERT INTO attendance.face_enrollments(id,person_id,provider,template_ref,status,consent_recorded_at,created_by)
      VALUES($1,$2,'presence-synthetic-demo',$3,'active',$4,$5) ON CONFLICT(id) DO NOTHING`,[scopedId(400+i),personId,`synthetic-demo-${i+1}`,now,demo.adminId]);
  }
  // Historical synthetic data is explicitly fabricated. No real biometric
  // enrollment or consent is implied; the provider never stores images.
  for (let day=6;day>=1;day--) {
    const sid=scopedId(500+day); const starts=new Date(now.getTime()-day*86400000); const ends=new Date(starts.getTime()+3600000);
    const existing=(await db.query('SELECT group_id FROM attendance.attendance_sessions WHERE id=$1',[sid])).rows[0];
    if (existing && existing.group_id!==demo.groupId) throw new Error('Synthetic session ID scope is already occupied');
    const created=await db.query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,status,opened_at,closed_at,created_by)
      VALUES($1,$2,$3,$4,'closed',$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id`,[sid,demo.groupId,starts,ends,demo.teacherId]);
    if (!created.rows.length) continue;
    for (let i=0;i<8;i++) {
      const status=(i+day)%7===0?'absent':(i+day)%5===0?'late':'present';
      const checked=status==='absent'?null:new Date(starts.getTime()+(status==='late'?15:2)*60000);
      const record=(await db.query(`INSERT INTO attendance.attendance_records(session_id,person_id,status,checked_in_at,method,recorded_by)
        VALUES($1,$2,$3,$4,'manual',$5) RETURNING *`,[sid,scopedId(100+i),status,checked,demo.teacherId])).rows[0];
      await db.query(`INSERT INTO attendance.audit_logs(actor_user_id,entity_type,entity_id,action,after_value,reason)
        VALUES($1,'attendance_record',$2,'synthetic_demo_seed',$3,'Fabricated demo history; no real student data')`,[demo.adminId,record.id,JSON.stringify(record)]);
    }
  }
  const existing=(await db.query('SELECT group_id FROM attendance.attendance_sessions WHERE id=$1',[scopedId(500)])).rows[0];
  if (existing && existing.group_id!==demo.groupId) throw new Error('Synthetic session ID scope is already occupied');
  await db.query(`INSERT INTO attendance.attendance_sessions(id,group_id,starts_at,ends_at,created_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[scopedId(500),demo.groupId,now,new Date(now.getTime()+3600000),demo.teacherId]);
  return {groupCode:'PRESENCE-DEMO-SYNTHETIC',teacherEmail:demo.teacherEmail,studentEmail:demo.studentEmail,adminEmail:demo.adminEmail};
}
async function main() {
  try { loadEnvFile(new URL('../.env',import.meta.url)); } catch(error) { if(error.code!=='ENOENT') throw error; }
  if (!process.argv.includes('--synthetic') || process.env.ALLOW_SYNTHETIC_SEED!=='true') {
    console.error('Synthetic seed requires --synthetic and ALLOW_SYNTHETIC_SEED=true. Nothing was written.'); process.exitCode=1; return;
  }
  let pool;
  try {
    if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD is required');
    pool=createPool(process.env.DATABASE_URL);
    await verifySchema(pool);
    const result=await transaction(pool,db=>seedDemo(db,process.env.DEMO_PASSWORD));
    console.log('Synthetic demo added without deleting records. Existing demo account passwords were preserved.'); console.log(JSON.stringify(result));
  } catch { console.error('Synthetic seed failed. Check opt-in flags, DEMO_PASSWORD (12–256 characters), migrations, and unused demo ID scope.'); process.exitCode=1; }
  finally { await pool?.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
