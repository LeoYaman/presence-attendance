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

// Keep report provenance consistent with CSV exports, including installations
// that add an explicit record flag without changing the bundled schema.
const groupSynthetic=`(g.code='PRESENCE-DEMO-SYNTHETIC' AND g.name LIKE '[SYNTHETIC DEMO]%')
  OR g.term_name IN ('Synthetic demonstration','Fictional local demonstration')`;
const recordSynthetic=`CASE WHEN to_jsonb(r)->>'synthetic' IN ('true','false')
  THEN (to_jsonb(r)->>'synthetic')::boolean ELSE (${groupSynthetic})
    OR EXISTS(SELECT 1 FROM attendance.audit_logs a WHERE a.entity_type='attendance_record'
      AND a.entity_id=r.id AND a.action='synthetic_demo_seed') END`;
const reportQuery=`SELECT s.id,s.group_id,g.code AS class_code,g.name AS class_name,
  s.starts_at,s.ends_at,s.closed_at,count(r.id)::int AS total,
  count(r.id) FILTER(WHERE r.status IN ('present','late'))::int AS attended,
  count(r.id) FILTER(WHERE r.status='late')::int AS late,
  count(r.id) FILTER(WHERE r.status='absent')::int AS absent,
  coalesce(bool_or(${recordSynthetic}) FILTER(WHERE r.id IS NOT NULL),(${groupSynthetic})) AS synthetic
  FROM attendance.attendance_sessions s JOIN attendance.groups g ON g.id=s.group_id
  JOIN attendance.users u ON u.id=$1 AND u.is_active AND
    (u.role='admin' OR (u.role='teacher' AND EXISTS(
      SELECT 1 FROM attendance.group_staff gs WHERE gs.group_id=g.id AND gs.user_id=u.id)))
  LEFT JOIN attendance.attendance_records r ON r.session_id=s.id AND r.status IN ('present','late','absent')
  WHERE s.status='closed' AND s.starts_at<=now() AND s.closed_at<=now()`;
const reportGroupBy=' GROUP BY s.id,g.id';
const iso=value=>new Date(value).toISOString();
const reportView=row=>({id:row.id,group_id:row.group_id,class_code:row.class_code,class_name:row.class_name,
  starts_at:iso(row.starts_at),ends_at:iso(row.ends_at),closed_at:iso(row.closed_at),total:row.total,synthetic:row.synthetic===true});
const percentage=(count,total)=>total?Math.round(count/total*1000)/10:0;

export function createAttendanceReports({pool,fail,uuid}){
  return async({user,url})=>{
    if(!['teacher','admin'].includes(user.role))fail(403,'staff_required','Staff access required');
    const match=url.pathname.match(/^\/api\/attendance-insights\/reports(?:\/([^/]+))?$/);
    if(!match)fail(404,'not_found','Report route not found');
    if(url.search)fail(400,'invalid_query','Report queries are unsupported');
    if(!match[1]){
      const rows=(await pool.query(reportQuery+reportGroupBy+' ORDER BY s.starts_at DESC,s.closed_at DESC,s.id',[user.id])).rows;
      return {reports:rows.map(reportView)};
    }
    const id=uuid(match[1]);
    const row=(await pool.query(reportQuery+' AND s.id=$2'+reportGroupBy,[user.id,id])).rows[0];
    if(!row)fail(404,'not_found','Finalized attendance report not found');
    const attendanceRate=percentage(row.attended,row.total),lateRate=percentage(row.late,row.total);
    const suggestion=!row.total?'No finalized attendance records are available for this lesson.':
      attendanceRate<75?'Follow up on absences and help students attend the next lesson.':
      lateRate>=20?'Encourage students to arrive before the lesson starts.':'Attendance is on track. Keep supporting consistent attendance.';
    const {group_id,total,synthetic,...session}=reportView(row);
    return {version:1,engine:'Presence Attendance',generated_at:new Date().toISOString(),synthetic,session,
      classes:[{class_code:row.class_code,total,attended:row.attended,late:row.late,absent:row.absent,
        attendance_rate:attendanceRate,late_rate:lateRate,suggestion}]};
  };
}
