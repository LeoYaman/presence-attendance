-- Passenger identity roster. No criminal status or links to fictional alerts.
CREATE SCHEMA IF NOT EXISTS demo;
CREATE TABLE demo.passengers (
  person_id uuid PRIMARY KEY REFERENCES attendance.people(id) ON DELETE RESTRICT,
  name text NOT NULL,
  reference_key text NOT NULL UNIQUE REFERENCES attendance.team_face_references(reference_key) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  CHECK ((person_id='f3102026-0000-4000-8000-000000000101' AND name='Leo' AND reference_key='team_leo')
      OR (person_id='f3102026-0000-4000-8000-000000000102' AND name='Rebbeca' AND reference_key='team_rebbeca'))
);
COMMENT ON TABLE demo.passengers IS 'Consented passenger identity suggestions only; no criminal or watchlist classification.';
REVOKE ALL ON demo.passengers FROM PUBLIC;
INSERT INTO demo.passengers(person_id,name,reference_key)
SELECT r.person_id,p.full_name,r.reference_key
FROM attendance.team_face_references r JOIN attendance.people p ON p.id=r.person_id
WHERE r.is_active AND p.is_active AND r.group_id='f3102026-0000-4000-8000-000000000001'
  AND ((r.person_id='f3102026-0000-4000-8000-000000000101' AND r.reference_key='team_leo' AND p.full_name='Leo')
    OR (r.person_id='f3102026-0000-4000-8000-000000000102' AND r.reference_key='team_rebbeca' AND p.full_name='Rebbeca'))
ON CONFLICT DO NOTHING;
