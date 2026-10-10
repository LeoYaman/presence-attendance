"""Export visually selected ORL demo portraits with explicit fictional roster mapping.

Run from the repository root with face_data/.venv/Scripts/python.exe.
Original archive and recognition reference files are preserved.
"""
from pathlib import Path
from io import BytesIO
import csv
import hashlib
import json
import re
import zipfile
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
# Manually reviewed all ten frames per subject: frontal, open eyes, little tilt.
SELECTED_FRAMES = (1, 2, 9, 4, 2, 5, 8, 2, 2, 10, 1, 1, 5, 1, 2, 2, 2, 7, 4, 8,
                   3, 9, 1, 1, 3, 1, 3, 3, 4, 7)


def main():
    html = (ROOT / 'students.html').read_text(encoding='utf-8')
    roster = re.findall(r'<tr><td>([^<]+)</td><td><span class="mono">(STU-\d{4})</span>', html)
    if len(roster) != len(SELECTED_FRAMES) or len({sid for _, sid in roster}) != len(SELECTED_FRAMES):
        raise ValueError(f'Expected exactly {len(SELECTED_FRAMES)} distinct fictional roster entries')
    output = ROOT / 'assets' / 'student-photos'
    output.mkdir(parents=True, exist_ok=True)
    mappings = []
    preview = Image.new('RGB', (1050, ((len(roster) + 4) // 5) * 285), '#f2f2f2')
    draw = ImageDraw.Draw(preview)
    with zipfile.ZipFile(ROOT / 'att_faces.zip') as archive:
        for index, ((name, student_id), frame) in enumerate(zip(roster, SELECTED_FRAMES)):
            subject = f's{index + 1}'
            matches = [p for p in archive.namelist() if p.endswith(f'{subject}/{frame}.pgm')]
            if len(matches) != 1:
                raise ValueError(f'Expected one archive source for {subject}/{frame}')
            source_path = matches[0]
            source_bytes = archive.read(source_path)
            slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
            filename = f'{student_id}-{slug}.png'
            with Image.open(BytesIO(source_bytes)) as source:
                portrait = source.convert('L')
                if portrait.size != (92, 112):
                    raise ValueError('Unexpected source dimensions')
                portrait.save(output / filename)
                x, y = (index % 5) * 210 + 13, (index // 5) * 285 + 10
                preview.paste(portrait.resize((184, 224), Image.Resampling.NEAREST).convert('RGB'), (x, y))
                draw.text((x, y + 229), f'{student_id}  {name}', fill='black')
                draw.text((x, y + 247), f'ORL {subject}/{frame}.pgm', fill='black')
            mappings.append({
                'student_id': student_id, 'student_name': name,
                'photo_file': f'assets/student-photos/{filename}',
                'source_subject': subject, 'source_image': frame,
                'source_archive': 'att_faces.zip', 'source_path': source_path,
                'source_sha256': hashlib.sha256(source_bytes).hexdigest(),
                'photo_sha256': hashlib.sha256((output / filename).read_bytes()).hexdigest(),
                'selection': 'Visually reviewed: frontal face, open eyes, minimal head tilt',
            })
    manifest = {'dataset': 'ORL-AT&T', 'attribution': 'Olivetti Research Laboratory',
                'test_only': True,
                'note': 'Anonymous sample portraits assigned to fictional roster names; these are not real identities or live biometric enrollments.',
                'students': mappings}
    (output / 'mapping.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    with (output / 'mapping.csv').open('w', newline='', encoding='utf-8-sig') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(mappings[0]))
        writer.writeheader()
        writer.writerows(mappings)
    preview.save(output / 'preview.png')
    (output / 'README.md').write_text(
        '# Student sample portraits\n\n'
        f'{len(mappings)} visually selected frontal ORL portraits are assigned to the fictional admin roster. '
        'Each filename contains the student ID and roster name.\n\n'
        '- `mapping.csv`: readable student-to-source mapping.\n'
        '- `mapping.json`: source paths and SHA-256 hashes.\n'
        '- `preview.png`: labeled overview of all assignments.\n\n'
        'Images retain all original 92 x 112 grayscale pixels, converted losslessly from PGM to browser-compatible PNG. '
        'The original `att_faces.zip` and recognition references are preserved. '
        'These assignments are display-only test data; names do not identify the anonymous ORL subjects. '
        'No live biometric enrollment is created. Attribution: Olivetti Research Laboratory.\n\n'
        'Regenerate from the repository root: '
        '`./face_data/.venv/Scripts/python.exe face_data/assign_roster_photos.py`.\n', encoding='utf-8')
    print(f'Exported {len(mappings)} student portraits and mapping files')


if __name__ == '__main__':
    main()
