import {createHmac,randomBytes} from 'node:crypto';
export function createAttendanceExport({pool,fail,uuid}){
 const key=process.env.ATTENDANCE_ANALYTICS_KEY||randomBytes(32).toString('hex');
 return async({user,url,res})=>{
  if(!['teacher','admin'].includes(user.role))fail(403,'staff_required','Staff access required');
  if([...url.searchParams.keys()].some(key=>key!=='groupId')||url.searchParams.getAll('groupId').length!==1)fail(400,'invalid_query','Choose exactly one class');
  const id=uuid(url.searchParams.get('groupId'));
  await pool.query('SELECT attendance.require_group_manager($1,$2)',[user.id,id]);
  // to_jsonb supports deployments with a record provenance column and the
  // unchanged bundled schema. Explicit row flags take priority over group labels.
  const rows=(await pool.query(`SELECT g.code AS class_code,s.id AS session_id,r.person_id,s.starts_at,r.checked_in_at,r.status,
    CASE WHEN to_jsonb(r)->>'synthetic' IN ('true','false') THEN (to_jsonb(r)->>'synthetic')::boolean
      ELSE (g.code='PRESENCE-DEMO-SYNTHETIC' AND g.name LIKE '[SYNTHETIC DEMO]%')
        OR g.term_name IN ('Synthetic demonstration','Fictional local demonstration')
        OR EXISTS(SELECT 1 FROM attendance.audit_logs a WHERE a.entity_type='attendance_record'
          AND a.entity_id=r.id AND a.action='synthetic_demo_seed') END AS synthetic
    FROM attendance.attendance_records r JOIN attendance.attendance_sessions s ON s.id=r.session_id
    JOIN attendance.groups g ON g.id=s.group_id
    WHERE g.id=$1 AND s.status='closed' AND s.starts_at<=now() AND r.status IN ('present','late','absent')
    ORDER BY s.starts_at,r.person_id LIMIT 10001`,[id])).rows;
  if(rows.length>10000)fail(409,'export_too_large','Export limited to 10,000 finalized records');
  const cell=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
  const csv='class_code,session_id,student_key,starts_at,checked_in_at,status,synthetic\r\n'+rows.map(row=>[row.class_code,row.session_id,createHmac('sha256',key).update(String(row.person_id)).digest('hex'),new Date(row.starts_at).toISOString(),row.checked_in_at?new Date(row.checked_in_at).toISOString():'',row.status,row.synthetic===true?'true':'false'].map(cell).join(',')).join('\r\n');
  res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="presence-attendance.csv"','Cache-Control':'no-store'});res.end(csv);
 };
}
