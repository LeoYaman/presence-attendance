// A real recognition adapter must verify a device/provider server-side. No client
// person ID or confidence can ever constitute a trusted real recognition result.
export async function syntheticRecognition(db, { groupId, personId }, enabled) {
  if (!enabled) return null;
  const { rows } = await db.query(`SELECT f.id AS enrollment_id FROM attendance.face_enrollments f
    JOIN attendance.groups g ON g.id=$1
    JOIN attendance.group_memberships m ON m.person_id=f.person_id AND m.group_id=g.id
    WHERE g.code='PRESENCE-DEMO-SYNTHETIC' AND g.name LIKE '[SYNTHETIC DEMO]%'
      AND f.person_id=$2 AND f.status='active' AND f.provider='presence-synthetic-demo'
      AND m.joined_at<=now() AND (m.left_at IS NULL OR m.left_at>now())`, [groupId,personId]);
  return rows[0] ? { personId, enrollmentId: rows[0].enrollment_id, confidence: 0.99, synthetic: true } : null;
}
