-- Extend identity suggestions only. Booking simulations remain independent.
ALTER TABLE demo.passengers DROP CONSTRAINT passengers_check;
ALTER TABLE demo.passengers ADD CONSTRAINT passengers_check CHECK (
  (person_id='f3102026-0000-4000-8000-000000000101' AND name='Leo' AND reference_key='team_leo')
  OR (person_id='f3102026-0000-4000-8000-000000000102' AND name='Rebbeca' AND reference_key='team_rebbeca')
  OR (person_id='f3102026-0000-4000-8000-000000000103' AND name='Olivia' AND reference_key='team_olivia')
);
INSERT INTO demo.passengers(person_id,name,reference_key)
SELECT r.person_id,p.full_name,r.reference_key
FROM attendance.team_face_references r JOIN attendance.people p ON p.id=r.person_id
WHERE r.is_active AND p.is_active AND r.group_id='f3102026-0000-4000-8000-000000000001'
  AND r.person_id='f3102026-0000-4000-8000-000000000103'
  AND r.reference_key='team_olivia' AND p.full_name='Olivia'
ON CONFLICT DO NOTHING;
