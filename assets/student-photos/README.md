# Student sample portraits

30 visually selected frontal ORL portraits are assigned to the fictional admin roster. Each filename contains the student ID and roster name.

- `mapping.csv`: readable student-to-source mapping.
- `mapping.json`: source paths and SHA-256 hashes.
- `preview.png`: labeled overview of all assignments.

Images retain all original 92 x 112 grayscale pixels, converted losslessly from PGM to browser-compatible PNG. The original `att_faces.zip` and recognition references are preserved. These assignments are display-only test data; names do not identify the anonymous ORL subjects. No live biometric enrollment is created. Attribution: Olivetti Research Laboratory.

Regenerate from the repository root: `./face_data/.venv/Scripts/python.exe face_data/assign_roster_photos.py`.
