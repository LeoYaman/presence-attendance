-- Subject data now lives in the independently operated SubjectRegistry service.
-- Drop only the obsolete attendance-owned tables, in foreign-key dependency order.
DROP TABLE attendance.subject_sync_audit;
DROP TABLE attendance.subject_face_references;
DROP TABLE attendance.subject_app_access;
DROP TABLE attendance.subject_person_links;
DROP TABLE attendance.subjects;
DROP TABLE attendance.subject_api_keys;
DROP TABLE attendance.subject_sync_sources;
DROP TABLE attendance.subject_catalog_version;
