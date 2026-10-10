import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { hashPassword } from './auth.mjs';

// This module receives only the authenticated identity established by server.mjs.
export function createAdminApi({pool,fail,uuid,timestamp,fields,recordingStore}) {
  // node-postgres represents DATE as a local-midnight Date; preserve its calendar day.
  const normalizeDates=value=>{
    if(Array.isArray(value))return value.map(normalizeDates);
    if(value&&typeof value==='object'&&!(value instanceof Date))return Object.fromEntries(Object.entries(value).map(([key,item])=>
      [key,['term_starts_on','term_ends_on','day'].includes(key)&&item instanceof Date
        ?`${item.getFullYear()}-${String(item.getMonth()+1).padStart(2,'0')}-${String(item.getDate()).padStart(2,'0')}`:normalizeDates(item)]));
    return value;
  };
  const cleanUser = ({password_hash, ...row}) => row;
  const text = (value,name,max=200) => {
    if(typeof value!=='string'||!value.trim()||value.trim().length>max) fail(400,'invalid_body',`${name} must contain 1–${max} characters`);
    return value.trim();
  };
  const bool = value => {if(typeof value!=='boolean')fail(400,'invalid_body','Active state must be boolean');return value;};
  const integer = (value,min,max,name) => {if(!Number.isInteger(value)||value<min||value>max)fail(400,'invalid_body',`${name} must be an integer from ${min} to ${max}`);return value;};
  const email = value => {const result=text(value,'Email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))fail(400,'invalid_body','A valid email is required');return result;};
  const password = async value => {if(typeof value!=='string'||value.length<12||value.length>256)fail(400,'invalid_body','Password must contain 12–256 characters');return hashPassword(value);};
  const day = (value,name) => {if(!/^\d{4}-\d{2}-\d{2}$/.test(value??'')||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(400,'invalid_date',`${name} must be YYYY-MM-DD`);return value;};
  const one = async (db,sql,params,message='Record not found') => {const row=(await db.query(sql,params)).rows[0];if(!row)fail(404,'not_found',message);return row;};
  const studentSql=`SELECT p.*,u.id AS user_id,u.email FROM attendance.people p LEFT JOIN attendance.users u ON u.person_id=p.id
    WHERE p.id=$1 AND NOT EXISTS(SELECT 1 FROM attendance.users st WHERE st.person_id=p.id AND st.role<>'student')`;
  const settings = async (db,lock=false) => one(db,'SELECT * FROM attendance.admin_settings WHERE singleton=true'+(lock?' FOR UPDATE':''),[],'Admin settings are not initialized');
  const audit = (db,actor,type,id,action,before,after,reason=null) => db.query(`INSERT INTO attendance.audit_logs
    (actor_user_id,entity_type,entity_id,action,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [actor.id,type,id,action,before?JSON.stringify(before):null,after?JSON.stringify(after):null,reason]);
  const page = (url,exporting=false) => {
    const limit=exporting?10001:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100;
    const offset=exporting?0:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0;
    integer(limit,1,exporting?10001:200,'Limit');integer(offset,0,1000000,'Offset');
    return {limit,offset};
  };
  function queryFilters(url,kind) {
    const specific={students:['group_id'],staff:['role'],courses:[],sessions:['group_id','status','from','to'],attendance:['group_id','person_id','session_id','status','from','to'],audit:['entity_type','actor_user_id','action','from','to']}[kind];
    const allowed=['q','active','limit','offset',...(specific??[]),'type'];
    for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length>1)fail(400,'invalid_query','Unsupported or duplicate query field');
    const parts=[],params=[];
    const add=(sql,value)=>{params.push(value);parts.push(sql.replaceAll('?',`$${params.length}`));};
    const q=url.searchParams.get('q');
    if(q!==null){if(q.length>200)fail(400,'invalid_query','Search is too long'); const cols={students:['p.full_name','p.person_code','u.email'],staff:['p.full_name','u.email'],courses:['g.name','g.code','g.course_code'],sessions:['g.name','g.code'],attendance:['p.full_name','p.person_code','g.name','g.code'],audit:['a.action','a.reason','u.email']}[kind];add(`(${cols.map(c=>`coalesce(${c},'') ILIKE ?`).join(' OR ')})`,'%'+q+'%');}
    const active=url.searchParams.get('active');
    if(active!==null){if(!['all','true','false'].includes(active))fail(400,'invalid_query','Active filter must be all, true or false');if(active!=='all'&&['students','staff','courses'].includes(kind))add(`${kind==='students'?'p':kind==='staff'?'u':'g'}.is_active=?`,active==='true');}
    for(const key of ['group_id','person_id','session_id','actor_user_id'])if(url.searchParams.has(key))add(`${key==='actor_user_id'?'a':key==='person_id'||key==='session_id'?'r':kind==='students'?'m':'s'}.${key}=?`,uuid(url.searchParams.get(key)));
    if(url.searchParams.has('role')){const role=url.searchParams.get('role');if(!['admin','teacher'].includes(role))fail(400,'invalid_query','Unknown staff role');add('u.role=?',role);}
    if(url.searchParams.has('status')){const status=url.searchParams.get('status');if(!(kind==='sessions'?['planned','open','closed','cancelled']:['pending','present','late','absent']).includes(status))fail(400,'invalid_query','Unknown status');add(`${kind==='sessions'?'s':'r'}.status=?`,status);}
    const time=kind==='audit'?'a.created_at':'s.starts_at';
    if(url.searchParams.has('from'))add(`${time}>=?::date`,day(url.searchParams.get('from'),'From'));
    if(url.searchParams.has('to'))add(`${time}<?::date+interval '1 day'`,day(url.searchParams.get('to'),'To'));
    if(url.searchParams.has('from')&&url.searchParams.has('to')&&url.searchParams.get('from')>url.searchParams.get('to'))fail(400,'invalid_query','From must not follow To');
    for(const key of ['entity_type','action'])if(url.searchParams.has(key))add(`a.${key}=?`,text(url.searchParams.get(key),key));
    return {parts,params};
  }
  async function list(db,url,kind,exporting=false) {
    const {parts,params}=queryFilters(url,kind);const {limit,offset}=page(url,exporting);
    let source,columns,order;
    if(kind==='students') {
      source='attendance.people p LEFT JOIN attendance.users u ON u.person_id=p.id';
      columns=`p.*,u.email,u.id AS user_id,(SELECT count(*)::int FROM attendance.group_memberships m WHERE m.person_id=p.id AND m.joined_at<=now() AND (m.left_at IS NULL OR m.left_at>now())) AS membership_count`;
      parts.push("NOT EXISTS(SELECT 1 FROM attendance.users staff WHERE staff.person_id=p.id AND staff.role<>'student')");
      if(url.searchParams.has('group_id')){source+=' JOIN attendance.group_memberships m ON m.person_id=p.id';parts.push('m.joined_at<=now() AND (m.left_at IS NULL OR m.left_at>now())');}
      order='p.full_name,p.id';
    } else if(kind==='staff') {
      source='attendance.users u LEFT JOIN attendance.people p ON p.id=u.person_id';
      columns=`u.id,u.email,u.role,u.is_active,u.person_id,u.created_at,u.updated_at,p.full_name,(SELECT count(*)::int FROM attendance.group_staff gs WHERE gs.user_id=u.id) AS group_count`;
      parts.push("u.role IN ('admin','teacher')");order='u.email,u.id';
    } else if(kind==='courses') {
      source='attendance.groups g';columns=`g.*,(SELECT count(*)::int FROM attendance.group_memberships m JOIN attendance.people p ON p.id=m.person_id AND p.is_active WHERE m.group_id=g.id AND m.joined_at<=now() AND (m.left_at IS NULL OR m.left_at>now())) AS student_count,(SELECT count(*)::int FROM attendance.group_staff gs JOIN attendance.users u ON u.id=gs.user_id AND u.is_active WHERE gs.group_id=g.id AND u.role IN ('teacher','admin')) AS staff_count`;order='g.code,g.id';
    } else if(kind==='sessions') {
      source='attendance.attendance_sessions s JOIN attendance.groups g ON g.id=s.group_id';
      columns=`s.*,g.code AS group_code,g.name AS group_name,${['present','late','absent','pending'].map(status=>`(SELECT count(*)::int FROM attendance.attendance_records r WHERE r.session_id=s.id AND r.status='${status}') AS ${status}`).join(',')},(SELECT count(*)::int FROM attendance.attendance_records r WHERE r.session_id=s.id) AS total`;order='s.starts_at DESC,s.id';
    } else if(kind==='attendance') {
      source='attendance.attendance_records r JOIN attendance.people p ON p.id=r.person_id JOIN attendance.attendance_sessions s ON s.id=r.session_id JOIN attendance.groups g ON g.id=s.group_id';
      columns='r.*,p.person_code,p.full_name,g.code AS group_code,g.name AS group_name,s.group_id,s.starts_at,s.ends_at,s.opened_at,s.closed_at,s.status AS session_status';order='s.starts_at DESC,p.full_name,r.id';
    } else {
      source='attendance.audit_logs a JOIN attendance.users u ON u.id=a.actor_user_id';columns='a.*,u.email AS actor_email';order='a.created_at DESC,a.id';
    }
    const where=parts.length?' WHERE '+parts.join(' AND '):'';
    const total=(await db.query(`SELECT count(*)::int AS total FROM ${source}${where}`,params)).rows[0].total;
    const rows=(await db.query(`SELECT ${columns} FROM ${source}${where} ORDER BY ${order} LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset])).rows;
    return {[{students:'students',staff:'staff',courses:'courses',sessions:'sessions',attendance:'records',audit:'logs'}[kind]]:rows,total,limit,offset};
  }
  async function validateCourse(db,body,creating=false) {
    const allowed=['code','name','course_code','term_name','term_starts_on','term_ends_on','time_zone','allowed_absences','is_active'];fields(body,allowed,creating?allowed.slice(0,6):[]);
    const result={};
    for(const key of allowed.slice(0,4))if(key in body)result[key]=text(body[key],key);
    for(const key of ['term_starts_on','term_ends_on'])if(key in body)result[key]=day(body[key],key);
    if('is_active' in body)result.is_active=bool(body.is_active);
    if('allowed_absences' in body)result.allowed_absences=integer(body.allowed_absences,0,100,'Allowed absences');
    if('time_zone' in body){result.time_zone=text(body.time_zone,'Time zone',100);if(!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[result.time_zone])).rows.length)fail(400,'invalid_body','Unknown time zone');}
    return result;
  }
  async function update(db,table,id,values) {
    if(!Object.keys(values).length)fail(400,'invalid_body','At least one changed field is required');
    // Table and column names only come from the fixed allowlists in this module.
    const entries=Object.entries(values);
    return one(db,`UPDATE attendance.${table} SET ${entries.map(([key],i)=>`${key}=$${i+2}`).join(',')} WHERE id=$1 RETURNING *`,[id,...entries.map(([,value])=>value)]);
  }
  async function create(db,table,values) {
    const entries=Object.entries(values);
    return one(db,`INSERT INTO attendance.${table}(${entries.map(([key])=>key).join(',')}) VALUES(${entries.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,entries.map(([,value])=>value));
  }
  return async function handle({req,res,url,user,body}) {
    if(user.role!=='admin')fail(403,'forbidden','Administrator access required');
    const path=url.pathname.replace('/api/admin/','');const method=req.method;
    if(method==='POST'&&url.search)fail(400,'invalid_query','Mutation query parameters are unsupported');
    try {
      const response=await transaction(pool,async db=>{
        if(method==='GET')await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        if(['students','staff','courses','sessions','attendance','audit'].includes(path)&&method==='GET')return list(db,url,path);
        if(path==='export'&&method==='GET') {
          const kind=url.searchParams.get('type');if(!['students','staff','courses','attendance','audit'].includes(kind))fail(400,'invalid_query','Choose an export type');
          const result=await list(db,url,kind,true);if(result.total>10000)fail(409,'export_too_large','Narrow your filters to export at most 10,000 rows');
          const rows=normalizeDates(result[{attendance:'records',audit:'logs'}[kind]??kind]);
          const columns=rows.length?Object.keys(rows[0]):({students:['id','person_code','full_name','is_active','email'],staff:['id','email','role','is_active'],courses:['id','code','name'],attendance:['id','person_code','full_name','status'],audit:['id','created_at','actor_email','action']}[kind]);
          const cell=value=>{let valueText=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);if(/^[\s]*[=+\-@]/.test(valueText)||/^[\t\r\n]/.test(valueText))valueText="'"+valueText;return '"'+valueText.replaceAll('"','""')+'"';};
          const csv='\uFEFF'+[columns.map(cell).join(','),...rows.map(row=>columns.map(key=>cell(row[key])).join(','))].join('\r\n')+'\r\n';
          res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${kind}.csv"`,'Cache-Control':'no-store'});res.end(csv);return;
        }
        if(path==='settings') {
          if(url.search)fail(400,'invalid_query','Settings query fields are unsupported');
          let result=await settings(db,method==='POST');
          if(method==='POST'){
            fields(body,['recording_retention_days','recording_max_mb','recording_storage_max_mb','default_allowed_absences','default_late_after_minutes','default_time_zone']);
            const values={};for(const [key,min,max] of [['recording_retention_days',1,90],['recording_max_mb',1,1024],['recording_storage_max_mb',1,1048576],['default_allowed_absences',0,100],['default_late_after_minutes',0,180]])if(key in body)values[key]=integer(body[key],min,max,key);
            if('default_time_zone' in body){values.default_time_zone=text(body.default_time_zone,'Time zone',100);if(!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[values.default_time_zone])).rows.length)fail(400,'invalid_body','Unknown time zone');}
            const previous=result;result=await update(db,'admin_settings',result.id,values);await audit(db,user,'settings',result.id,'settings_updated',previous,result);
          }
          return {settings:result,storage:{...(await recordingStore.usage?.()??{}),limit_bytes:result.recording_storage_max_mb*1048576,mode:'local',configurable:false}};
        }
        if(path==='dashboard'&&method==='GET') {
          if(url.search)fail(400,'invalid_query','Dashboard query fields are unsupported');
          const defaults=await settings(db);
          const counts=(await db.query(`SELECT
            (SELECT count(*)::int FROM attendance.people p WHERE p.is_active AND NOT EXISTS(SELECT 1 FROM attendance.users u WHERE u.person_id=p.id AND u.role<>'student')) AS students,
            (SELECT count(*)::int FROM attendance.users WHERE is_active AND role IN ('admin','teacher')) AS staff,
            (SELECT count(*)::int FROM attendance.users WHERE is_active AND role='teacher') AS teachers,
            (SELECT count(*)::int FROM attendance.users WHERE is_active AND role='admin') AS admins,
            (SELECT count(*)::int FROM attendance.groups WHERE is_active) AS courses,
            (SELECT count(*)::int FROM attendance.attendance_sessions WHERE status='open') AS open_sessions,
            (SELECT count(*)::int FROM attendance.attendance_sessions WHERE status='closed' AND starts_at<=now()) AS closed_sessions,
            (SELECT count(*)::int FROM attendance.attendance_sessions s JOIN attendance.groups g ON g.id=s.group_id WHERE s.status='open' AND (s.starts_at AT TIME ZONE g.time_zone)::date=(now() AT TIME ZONE g.time_zone)::date) AS today_open_sessions,
            (SELECT count(*)::int FROM attendance.attendance_sessions s JOIN attendance.groups g ON g.id=s.group_id WHERE s.status='closed' AND s.starts_at<=now() AND (s.starts_at AT TIME ZONE g.time_zone)::date=(now() AT TIME ZONE g.time_zone)::date) AS today_closed_sessions`)).rows[0];
          const totals=`count(*) FILTER(WHERE r.status='present')::int AS present,count(*) FILTER(WHERE r.status='late')::int AS late,count(*) FILTER(WHERE r.status='absent')::int AS absent,count(*)::int AS total`;
          const attendance=(await db.query(`SELECT ${totals},count(*) FILTER(WHERE r.status='pending')::int AS pending,round(100.0*count(*) FILTER(WHERE r.status IN ('present','late'))/nullif(count(*),0),1)::float AS attendance_rate
            FROM attendance.attendance_records r JOIN attendance.attendance_sessions s ON s.id=r.session_id WHERE s.status='closed' AND s.starts_at<=now()`)).rows[0];
          const near_limit=(await db.query(`SELECT a.*,p.person_code,p.full_name,g.name AS group_name FROM attendance.student_absence_summary a JOIN attendance.people p ON p.id=a.person_id JOIN attendance.groups g ON g.id=a.group_id
            WHERE p.is_active AND g.is_active AND g.term_ends_on>=current_date AND a.used_absences>0 AND a.remaining_absences<=2 ORDER BY a.remaining_absences,a.used_absences DESC LIMIT 100`)).rows;
          const recent_audit=(await db.query('SELECT a.*,u.email AS actor_email FROM attendance.audit_logs a JOIN attendance.users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC,a.id LIMIT 10')).rows;
          const daily=(await db.query(`SELECT (s.starts_at AT TIME ZONE g.time_zone)::date AS day,${totals} FROM attendance.attendance_records r JOIN attendance.attendance_sessions s ON s.id=r.session_id JOIN attendance.groups g ON g.id=s.group_id WHERE s.status='closed' AND s.starts_at<=now() AND s.starts_at>=now()-interval '30 days' GROUP BY day ORDER BY day`)).rows;
          const courses=(await db.query(`SELECT g.id,g.code,g.name,${totals.replace('count(*)::int AS total','count(r.id)::int AS total')},round(100.0*count(*) FILTER(WHERE r.status IN ('present','late'))/nullif(count(r.id),0),1)::float AS attendance_rate
            FROM attendance.groups g LEFT JOIN attendance.attendance_sessions s ON s.group_id=g.id AND s.status='closed' AND s.starts_at<=now() LEFT JOIN attendance.attendance_records r ON r.session_id=s.id WHERE g.is_active GROUP BY g.id ORDER BY g.code`)).rows;
          return {counts,attendance,near_limit,recent_audit,daily,courses,storage:{...(await recordingStore.usage?.()??{mode:'local',used_bytes:null}),limit_bytes:defaults.recording_storage_max_mb*1048576}};
        }
        if(path==='students'&&method==='POST') {
          fields(body,['person_code','full_name','is_active','email','password'],['person_code','full_name']);
          if(('email' in body)!==('password' in body))fail(400,'invalid_body','Email and password must both be provided');
          const person=await create(db,'people',{person_code:text(body.person_code,'Student code',100),full_name:text(body.full_name,'Full name'),is_active:'is_active' in body?bool(body.is_active):true});
          if('email' in body)await create(db,'users',{person_id:person.id,email:email(body.email),password_hash:await password(body.password),role:'student',is_active:person.is_active});
          const student=await one(db,studentSql,[person.id]);await audit(db,user,'student',person.id,'student_created',null,student);return {student};
        }
        let match=path.match(/^students\/([^/]+)(?:\/(memberships))?$/);
        if(match){
          const id=uuid(match[1]);let before=await one(db,studentSql+(method==='POST'&&!match[2]?' FOR UPDATE OF p':''),[id],'Student not found');
          if(match[2]==='memberships'&&method==='POST') {
            fields(body,['group_id','action'],['group_id','action']);const groupId=uuid(body.group_id);
            await one(db,'SELECT * FROM attendance.groups WHERE id=$1 FOR UPDATE',[groupId],'Course not found');
            before=await one(db,studentSql+' FOR UPDATE OF p',[id],'Student not found');
            let previous=null,membership;
            if(body.action==='join'){
              if(!before.is_active)fail(409,'inactive_student','Activate the student before enrollment');
              const group=await one(db,'SELECT is_active FROM attendance.groups WHERE id=$1',[groupId]);if(!group.is_active)fail(409,'inactive_course','Activate the course before enrollment');
              if((await db.query('SELECT id FROM attendance.group_memberships WHERE group_id=$1 AND person_id=$2 AND left_at IS NULL',[groupId,id])).rows.length)fail(409,'already_enrolled','Student already has an active membership');
              membership=await create(db,'group_memberships',{group_id:groupId,person_id:id});
            }else if(body.action==='leave'){
              previous=await one(db,'SELECT * FROM attendance.group_memberships WHERE group_id=$1 AND person_id=$2 AND left_at IS NULL FOR UPDATE',[groupId,id],'Active membership not found');
              membership=await one(db,"UPDATE attendance.group_memberships SET left_at=greatest(clock_timestamp(),joined_at+interval '1 microsecond') WHERE id=$1 RETURNING *",[previous.id]);
            }else fail(400,'invalid_body','Membership action must be join or leave');
            await audit(db,user,'membership',membership.id,body.action==='join'?'membership_joined':'membership_ended',previous,membership);return {membership};
          }
          if(match[2])fail(405,'method_not_allowed','Method not allowed');
          if(method==='GET'){
            if(url.search)fail(400,'invalid_query','Detail query fields are unsupported');
            return {student:before,memberships:(await db.query('SELECT m.*,g.code AS group_code,g.name AS group_name FROM attendance.group_memberships m JOIN attendance.groups g ON g.id=m.group_id WHERE m.person_id=$1 ORDER BY m.joined_at DESC',[id])).rows,
              history:(await db.query('SELECT * FROM attendance.student_history WHERE person_id=$1 ORDER BY starts_at DESC',[id])).rows,summary:(await db.query('SELECT * FROM attendance.student_absence_summary WHERE person_id=$1 ORDER BY group_code',[id])).rows};
          }
          fields(body,['person_code','full_name','is_active','email','password']);if(!Object.keys(body).length)fail(400,'invalid_body','At least one changed field is required');
          const values={};for(const key of ['person_code','full_name'])if(key in body)values[key]=text(body[key],key,key==='person_code'?100:200);if('is_active' in body)values.is_active=bool(body.is_active);
          if(Object.keys(values).length)await update(db,'people',id,values);
          if('is_active' in values)await db.query("UPDATE attendance.users SET is_active=$1 WHERE person_id=$2 AND role='student'",[values.is_active,id]);
          if('email' in body||'password' in body){
            const account=(await db.query("SELECT * FROM attendance.users WHERE person_id=$1 AND role='student' FOR UPDATE",[id])).rows[0];
            const userValues={};if('email' in body)userValues.email=email(body.email);if('password' in body)userValues.password_hash=await password(body.password);
            if(account){await update(db,'users',account.id,userValues);await db.query('DELETE FROM attendance.auth_sessions WHERE user_id=$1',[account.id]);}
            else {if(!('email' in body&&'password' in body))fail(400,'invalid_body','New login requires email and password');await create(db,'users',{...userValues,person_id:id,role:'student',is_active:values.is_active??before.is_active});}
          }
          if(values.is_active===false&&before.user_id)await db.query('DELETE FROM attendance.auth_sessions WHERE user_id=$1',[before.user_id]);
          const student=await one(db,studentSql,[id]);await audit(db,user,'student',id,'student_updated',before,student,'password' in body?'Login password changed':null);return {student};
        }
        if(path==='staff'&&method==='POST') {
          fields(body,['email','password','role','full_name'],['email','password','role']);if(!['teacher','admin'].includes(body.role))fail(400,'invalid_body','Staff role must be teacher or admin');
          let person=null;if('full_name' in body)person=await create(db,'people',{person_code:'STAFF-'+randomUUID(),full_name:text(body.full_name,'Full name')});
          const staff=cleanUser(await create(db,'users',{email:email(body.email),password_hash:await password(body.password),role:body.role,person_id:person?.id??null}));staff.full_name=person?.full_name??null;
          await audit(db,user,'user',staff.id,'staff_created',null,staff);return {staff};
        }
        match=path.match(/^staff\/([^/]+)$/);
        if(match&&method==='POST'){
          fields(body,['email','password','role','is_active','full_name']);if(!Object.keys(body).length)fail(400,'invalid_body','At least one changed field is required');
          // Lock before the row lookup to serialize concurrent privilege changes.
          await db.query('SELECT pg_advisory_xact_lock(710202611)');const id=uuid(match[1]);const before=cleanUser(await one(db,"SELECT u.*,p.full_name FROM attendance.users u LEFT JOIN attendance.people p ON p.id=u.person_id WHERE u.id=$1 AND u.role IN ('teacher','admin') FOR UPDATE OF u",[id],'Staff member not found'));
          const values={};if('role' in body){if(!['teacher','admin'].includes(body.role))fail(400,'invalid_body','Staff role must be teacher or admin');values.role=body.role;}
          if('is_active' in body)values.is_active=bool(body.is_active);if('email' in body)values.email=email(body.email);if('password' in body)values.password_hash=await password(body.password);
          if(before.role==='admin'&&before.is_active&&(values.role==='teacher'||values.is_active===false)){
            if(!(await db.query("SELECT id FROM attendance.users WHERE role='admin' AND is_active AND id<>$1",[id])).rows.length)fail(409,'last_admin','The last active administrator cannot be deactivated or demoted');
          }
          let person;if('full_name' in body){const full_name=text(body.full_name,'Full name');if(before.person_id)person=await update(db,'people',before.person_id,{full_name});else{person=await create(db,'people',{person_code:'STAFF-'+randomUUID(),full_name});values.person_id=person.id;}}
          const staff=cleanUser(Object.keys(values).length?await update(db,'users',id,values):before);staff.full_name=person?.full_name??before.full_name;
          if('is_active' in values&&before.person_id)await db.query('UPDATE attendance.people SET is_active=$1 WHERE id=$2',[values.is_active,before.person_id]);
          if(['email','password','role','is_active'].some(key=>key in body))await db.query('DELETE FROM attendance.auth_sessions WHERE user_id=$1',[id]);
          await audit(db,user,'user',id,'staff_updated',before,staff,'password' in body?'Login password changed':null);return {staff};
        }
        if(path==='courses'&&method==='POST'){
          const values=await validateCourse(db,body,true);const defaults=await settings(db);values.allowed_absences??=defaults.default_allowed_absences;values.time_zone??=defaults.default_time_zone;
          const course=await create(db,'groups',values);await audit(db,user,'course',course.id,'course_created',null,course);return {course};
        }
        match=path.match(/^courses\/([^/]+)(?:\/(staff))?$/);
        if(match){
          const id=uuid(match[1]);const before=await one(db,'SELECT * FROM attendance.groups WHERE id=$1'+(method==='POST'?' FOR UPDATE':''),[id],'Course not found');
          const assigned=async()=>(await db.query("SELECT u.id,u.email,u.role,u.is_active,p.full_name FROM attendance.group_staff gs JOIN attendance.users u ON u.id=gs.user_id LEFT JOIN attendance.people p ON p.id=u.person_id WHERE gs.group_id=$1 ORDER BY u.email",[id])).rows;
          if(match[2]==='staff'&&method==='POST'){
            fields(body,['user_id','action'],['user_id','action']);const userId=uuid(body.user_id);const account=cleanUser(await one(db,"SELECT * FROM attendance.users WHERE id=$1 AND role IN ('teacher','admin')",[userId],'Staff member not found'));
            const previous=(await db.query('SELECT * FROM attendance.group_staff WHERE group_id=$1 AND user_id=$2',[id,userId])).rows[0]??null;
            if(body.action==='assign'){if(!account.is_active)fail(409,'inactive_staff','Activate this staff member before assignment');await db.query('INSERT INTO attendance.group_staff(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,userId]);}
            else if(body.action==='remove'){await db.query('DELETE FROM attendance.group_staff WHERE group_id=$1 AND user_id=$2',[id,userId]);}
            else fail(400,'invalid_body','Staff action must be assign or remove');
            await audit(db,user,'staff_assignment',id,'staff_'+body.action,previous,body.action==='assign'?{group_id:id,user_id:userId}:null);return {staff:await assigned()};
          }
          if(match[2])fail(405,'method_not_allowed','Method not allowed');
          if(method==='GET'){
            if(url.search)fail(400,'invalid_query','Detail query fields are unsupported');
            return {course:before,staff:await assigned(),students:(await db.query('SELECT p.*,m.id AS membership_id,m.joined_at,m.left_at FROM attendance.group_memberships m JOIN attendance.people p ON p.id=m.person_id WHERE m.group_id=$1 ORDER BY p.full_name,m.joined_at DESC',[id])).rows,
              sessions:(await db.query('SELECT * FROM attendance.attendance_sessions WHERE group_id=$1 ORDER BY starts_at DESC',[id])).rows};
          }
          const values=await validateCourse(db,body);const course=await update(db,'groups',id,values);await audit(db,user,'course',id,'course_updated',before,course);return {course};
        }
        match=path.match(/^sessions\/([^/]+)$/);
        if(match&&method==='GET'){
          if(url.search)fail(400,'invalid_query','Detail query fields are unsupported');const id=uuid(match[1]);
          return {session:await one(db,'SELECT s.*,g.code AS group_code,g.name AS group_name FROM attendance.attendance_sessions s JOIN attendance.groups g ON g.id=s.group_id WHERE s.id=$1',[id],'Session not found'),records:(await db.query('SELECT r.*,p.person_code,p.full_name FROM attendance.attendance_records r JOIN attendance.people p ON p.id=r.person_id WHERE r.session_id=$1 ORDER BY p.full_name',[id])).rows};
        }
        match=path.match(/^attendance\/([^/]+)\/correction$/);
        if(match&&method==='POST'){
          const id=uuid(match[1]);await one(db,'SELECT id FROM attendance.attendance_records WHERE id=$1',[id],'Attendance record not found');fields(body,['status','reason','checkedInAt'],['status','reason']);
          if(!['present','late','absent'].includes(body.status))fail(400,'invalid_correction','Choose present, late or absent');const reason=text(body.reason,'Correction reason',1000);const checked=body.checkedInAt==null?null:timestamp(body.checkedInAt);
          if((body.status==='absent'&&checked)||(body.status!=='absent'&&!checked))fail(400,'invalid_correction','Present or late requires a time; absent requires no time');
          return {record:await one(db,'SELECT * FROM attendance.correct_attendance($1,$2,$3,$4,$5)',[id,user.id,body.status,reason,checked])};
        }
        fail(404,'not_found','Admin endpoint not found');
      });
      return normalizeDates(response);
    }catch(error){
      if(error.code==='23505')fail(409,'duplicate','A record with this code, email or membership already exists');
      throw error;
    }
  };
}
