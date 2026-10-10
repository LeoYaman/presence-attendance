"""Copy one reference per AT&T subject into a flat local photo folder."""
import argparse
import json
from pathlib import Path
import shutil

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path.home() / "Downloads" / "att_faces")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    destination = root / "people_faces"
    records_path = root / "students.json"
    subjects = sorted(
        (p for p in args.source.iterdir() if p.is_dir() and p.name.startswith("s") and p.name[1:].isdigit()),
        key=lambda p: int(p.name[1:]),
    )
    if not subjects:
        parser.error(f"No subject folders found in {args.source}")
    sources = [folder / "1.pgm" for folder in subjects]
    for source in sources:
        if not source.is_file():
            parser.error(f"Missing reference photo: {source}")
    if records_path.exists() and records_path.read_text(encoding="utf-8-sig").strip():
        parser.error("students.json already contains data; refusing to overwrite it.")
    if destination.exists() and any(destination.iterdir()):
        parser.error("people_faces already contains files; refusing to overwrite them.")
    destination.mkdir(parents=True, exist_ok=True)
    records = []
    for folder, source in zip(subjects, sources):
        target = destination / f"{folder.name}.pgm"
        shutil.copy2(source, target)
        records.append({
            "id": folder.name,
            "name": f"AT&T sample {folder.name}",
            "photo": f"people_faces/{target.name}",
            "kind": "sample",
        })
    records_path.write_text(json.dumps({"students": records}, indent=2) + "\n", encoding="utf-8")
    print(f"Copied {len(records)} reference photos to {destination}")
    print(f"Saved photo mappings to {records_path}")
    print("Original dataset unchanged. Add team JPG/PNG photos here separately.")

if __name__ == "__main__":
    main()
