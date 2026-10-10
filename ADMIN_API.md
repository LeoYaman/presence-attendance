# Admin API

All `/api/admin/*` routes require an authenticated **admin**. POST additionally requires the existing exact Origin and X-CSRF-Token. JSON errors use `{error:{code,message}}`. No hard deletion: records and membership history are preserved. Field names are snake_case unless specified below.

These APIs remain available independently of the interface. The current use-case design does not include the former admin pages or an admin sign-in button.

GET lists support `q` (name/code/email search), `active=all|true|false`, `limit` (1–200, default 100), `offset` (default 0). Responses include `total,limit,offset`.

- GET `/api/admin/students` → `{students:[{id,person_code,full_name,is_active,email,user_id,membership_count}],total,limit,offset}`; optional `group_id`.
- POST `/api/admin/students` creates with `{person_code,full_name,email?,password?,is_active?}`. Email and password must both be supplied for an optional student login; passwords 12–256 characters. → `{student}`.
- GET `/api/admin/students/:id` → `{student,memberships,history,summary}`. Memberships include group code/name and historical joined_at/left_at; attendance history remains available for inactive students.
- POST `/api/admin/students/:id` updates `{person_code?,full_name?,is_active?,email?,password?}` → `{student}`; is_active=false deactivates (no history removal).
- POST `/api/admin/students/:id/memberships` with `{group_id,action:"join"|"leave"}` → `{membership}`. Leave ends the current membership; join adds a new period. Never alters a prior session roster.
- GET `/api/admin/staff` → `{staff:[{id,email,role,is_active,full_name,group_count}],total,limit,offset}`; optional `role=admin|teacher`.
- POST `/api/admin/staff` with `{email,password,role:"admin"|"teacher",full_name?}` → `{staff}`.
- POST `/api/admin/staff/:id` with `{email?,password?,role?,is_active?,full_name?}` → `{staff}`. Deactivation/demotion of the last active admin returns 409; sessions revoked on account/role/password changes. Password hashes never returned or audited.
- GET `/api/admin/courses` → `{courses:[group fields plus student_count,staff_count],total,limit,offset}`.
- POST `/api/admin/courses` with `{code,name,course_code,term_name,term_starts_on,term_ends_on,time_zone?,allowed_absences?,is_active?}` → `{course}`.
- GET `/api/admin/courses/:id` → `{course,students,staff,sessions}`.
- POST `/api/admin/courses/:id` updates the same optional fields → `{course}`.
- POST `/api/admin/courses/:id/staff` with `{user_id,action:"assign"|"remove"}` → `{staff}` (current assigned users).
- GET `/api/admin/sessions` → `{sessions:[session fields plus group_code,group_name,present,late,absent,pending,total],total,limit,offset}`. Filters `group_id,status=planned|open|closed|cancelled,from=YYYY-MM-DD,to=YYYY-MM-DD,q`.
- GET `/api/admin/sessions/:id` → `{session,records}`; records include id,person_id,person_code,full_name,status,checked_in_at,method,confidence.
- GET `/api/admin/attendance` → `{records:[record fields plus person_code,full_name,group_code,group_name,starts_at,ends_at,opened_at,closed_at,session_status],total,limit,offset}`; filters `group_id,person_id,session_id,status=pending|present|late|absent,from,to,q`.
- POST `/api/admin/attendance/:id/correction` with `{status:"present"|"late"|"absent",reason,checkedInAt?}` → `{record}`. Nonempty reason required; present/late require ISO timestamp inside original session attendance window; absent requires no time. Atomic audit/event writes.
- GET `/api/admin/dashboard` → `{counts:{students,staff,teachers,admins,courses,open_sessions,closed_sessions,today_open_sessions,today_closed_sessions},attendance:{present,late,absent,pending,total,attendance_rate},near_limit:[summary fields plus full_name,person_code,group_name],recent_audit:[audit rows],daily:[{day,present,late,absent,total}],courses:[{id,code,name,present,late,absent,total,attendance_rate}]}`. Rate counts present+late over closed past session records; null when no data.
- GET `/api/admin/audit` → `{logs:[audit fields plus actor_email],total,limit,offset}`; filters `entity_type,actor_user_id,action,from,to,q`.
- GET `/api/admin/settings` → `{settings:{id,recording_retention_days,recording_max_mb,recording_storage_max_mb,storage_mode,default_allowed_absences,default_late_after_minutes,default_time_zone,updated_at},storage:{mode:"local",configurable:false,used_bytes,recording_count,limit_bytes}}`.
- POST `/api/admin/settings` with any of `{recording_retention_days:1..90,recording_max_mb:1..1024,recording_storage_max_mb:1..1048576,default_allowed_absences:0..100,default_late_after_minutes:0..180,default_time_zone}` → `{settings,storage}`. Storage mode is fixed to the configured local filesystem; cloud provisioning is unavailable. Changes audited; storage limit is enforced across all recording files, including upload/finalization workspace, and does not delete files when reduced. Dashboard also returns storage usage/limit. Today session counts use each course time zone. Recording retention/per-recording policy applies to newly created recordings only. Existing recordings keep their original expiry/limit.
- GET `/api/admin/export?type=students|staff|courses|attendance|audit` downloads CSV matching the corresponding GET filters, capped at 10,000 rows; exceeding cap returns 409. Formula-leading cells escaped. No password/token export.

Create/update successes use 200. Validation 400, unauthorized 401/403, missing row 404, state conflict/duplicate 409, unavailable backend 503. Existing teacher/student routes keep their original query behavior and access checks.
