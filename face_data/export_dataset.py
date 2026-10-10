#!/usr/bin/env python3
"""Export the bundled ORL face archive as a JSON manifest without extracting it.

Image bytes are passed through unchanged. This module deliberately uses only the
Python standard library and does not perform biometric processing.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import BinaryIO


SOURCE_URL = "https://github.com/LeoYaman/presence-attendance/blob/main/att_faces.zip"
DATASET_NAME = "ORL-AT&T"
ATTRIBUTION = "Olivetti Research Laboratory"
MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
MAX_EXPANDED_BYTES = 50 * 1024 * 1024
MAX_IMAGE_BYTES = 100_000
EXPECTED_WIDTH = 92
EXPECTED_HEIGHT = 112
EXPECTED_MAXVAL = 255


class ExportError(Exception):
    """Input archive is not a valid copy of the expected ORL dataset."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_limited(stream: BinaryIO, limit: int) -> bytes:
    chunks: list[bytes] = []
    remaining = limit + 1
    while remaining:
        chunk = stream.read(min(64 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    result = b"".join(chunks)
    if len(result) > limit:
        raise ExportError(f"entry exceeds permitted size ({limit} bytes)")
    return result


def _pgm_token(data: bytes, pos: int) -> tuple[bytes, int]:
    length = len(data)
    while pos < length:
        if data[pos] in b" \t\r\n\v\f":
            pos += 1
        elif data[pos] == ord("#"):
            newline = data.find(b"\n", pos + 1)
            if newline < 0:
                raise ExportError("unterminated comment in PGM header")
            pos = newline + 1
        else:
            break
    start = pos
    while pos < length and data[pos] not in b" \t\r\n\v\f#":
        pos += 1
    if pos == start:
        raise ExportError("incomplete PGM header")
    return data[start:pos], pos


def validate_pgm(data: bytes, name: str = "image") -> None:
    """Check a binary PGM header and exact 92x112, 8-bit raster length."""
    if len(data) > MAX_IMAGE_BYTES:
        raise ExportError(f"{name}: image exceeds {MAX_IMAGE_BYTES} bytes")
    try:
        magic, pos = _pgm_token(data, 0)
        width, pos = _pgm_token(data, pos)
        height, pos = _pgm_token(data, pos)
        maxval, pos = _pgm_token(data, pos)
    except ExportError as exc:
        raise ExportError(f"{name}: {exc}") from exc
    if magic != b"P5":
        raise ExportError(f"{name}: expected binary P5 PGM")
    try:
        dimensions = int(width), int(height), int(maxval)
    except ValueError as exc:
        raise ExportError(f"{name}: non-numeric PGM dimensions or maxval") from exc
    if dimensions != (EXPECTED_WIDTH, EXPECTED_HEIGHT, EXPECTED_MAXVAL):
        raise ExportError(f"{name}: expected 92x112 PGM with maxval 255")
    if pos >= len(data) or data[pos] not in b" \t\r\n\v\f":
        raise ExportError(f"{name}: missing whitespace after PGM maxval")
    # The delimiter after maxval is part of the header. Treat CRLF as one newline,
    # but do not skip arbitrary whitespace because raster bytes may be whitespace.
    if data[pos:pos + 2] == b"\r\n":
        pos += 2
    else:
        pos += 1
    expected = EXPECTED_WIDTH * EXPECTED_HEIGHT
    if len(data) - pos != expected:
        raise ExportError(f"{name}: expected exactly {expected} raster bytes")


def _entry_is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = info.external_attr >> 16
    return (mode & 0o170000) == 0o120000


def _expected_image_path(name: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"s([1-9]|[1-3][0-9]|40)/([1-9]|10)\.pgm", name)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def export_dataset(archive_path: str | Path) -> dict:
    path = Path(archive_path)
    try:
        archive_bytes = path.stat().st_size
    except OSError as exc:
        raise ExportError(f"cannot read archive {path}: {exc}") from exc
    if archive_bytes > MAX_ARCHIVE_BYTES:
        raise ExportError(f"archive exceeds {MAX_ARCHIVE_BYTES} bytes")
    try:
        archive_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        zf = zipfile.ZipFile(path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise ExportError(f"invalid ZIP archive: {exc}") from exc

    with zf:
        infos = zf.infolist()
        seen: set[str] = set()
        canonical: dict[str, zipfile.ZipInfo] = {}
        directories: set[str] = set()
        for info in infos:
            raw_name = info.filename
            if not raw_name or raw_name.startswith(("/", "\\")) or "\\" in raw_name:
                raise ExportError(f"unsafe archive path: {raw_name!r}")
            parts = raw_name.split("/")
            is_dir = info.is_dir()
            logical_parts = parts[:-1] if is_dir and parts[-1] == "" else parts
            if (not logical_parts or any(p in ("", ".", "..") for p in logical_parts)
                    or ":" in logical_parts[0]):
                raise ExportError(f"unsafe archive path: {raw_name!r}")
            normalized = "/".join(logical_parts)
            if normalized in seen:
                raise ExportError(f"duplicate or colliding ZIP entry: {normalized}")
            seen.add(normalized)
            if _entry_is_symlink(info):
                raise ExportError(f"symlink entries are not allowed: {raw_name}")
            if is_dir:
                if not re.fullmatch(r"s(?:[1-9]|[1-3][0-9]|40)", normalized):
                    raise ExportError(f"unexpected directory: {raw_name}")
                directories.add(normalized)
                continue
            if normalized == "README":
                canonical[normalized] = info
                continue
            image_key = _expected_image_path(normalized)
            if image_key is None:
                raise ExportError(f"unexpected file in archive: {raw_name}")
            if info.file_size > MAX_IMAGE_BYTES:
                raise ExportError(f"{raw_name}: image exceeds {MAX_IMAGE_BYTES} bytes")
            canonical[normalized] = info

        expected_names = {"README"}
        expected_names.update(f"s{s}/{i}.pgm" for s in range(1, 41) for i in range(1, 11))
        if set(canonical) != expected_names:
            missing = sorted(expected_names - set(canonical))
            raise ExportError(f"archive is missing expected entries: {', '.join(missing[:5])}")
        expected_directories = {f"s{i}" for i in range(1, 41)}
        if directories != expected_directories or len(infos) != 441:
            raise ExportError(f"expected 441 ZIP entries, found {len(infos)}")
        expanded = sum(info.file_size for info in canonical.values())
        if expanded > MAX_EXPANDED_BYTES:
            raise ExportError(f"expanded data exceeds {MAX_EXPANDED_BYTES} bytes")
        try:
            readme_bytes = _read_limited(zf.open(canonical["README"]), 1_000_000)
            readme = readme_bytes.decode("utf-8-sig")
        except (UnicodeDecodeError, zipfile.BadZipFile, RuntimeError, OSError) as exc:
            raise ExportError(f"cannot read archive README: {exc}") from exc

        subjects = []
        for subject_id in range(1, 41):
            images = []
            for image_id in range(1, 11):
                image_path = f"s{subject_id}/{image_id}.pgm"
                info = canonical[image_path]
                try:
                    data = _read_limited(zf.open(info), MAX_IMAGE_BYTES)
                except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
                    raise ExportError(f"cannot read {image_path}: {exc}") from exc
                if len(data) != info.file_size:
                    raise ExportError(f"{image_path}: ZIP size does not match content")
                validate_pgm(data, image_path)
                images.append({
                    "key": f"{image_id}.pgm",
                    "path": image_path,
                    "sha256": _sha256(data),
                    "width": EXPECTED_WIDTH,
                    "height": EXPECTED_HEIGHT,
                    "mimeType": "image/x-portable-graymap",
                    "data": base64.b64encode(data).decode("ascii"),
                })
            subjects.append({"key": f"s{subject_id}", "images": images})

    return {
        "name": DATASET_NAME,
        "sourceUrl": SOURCE_URL,
        "archiveSha256": archive_sha256,
        "attribution": ATTRIBUTION,
        "readme": readme,
        "subjects": subjects,
    }


def default_archive_path() -> Path:
    return Path(__file__).resolve().parent.parent / "att_faces.zip"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", nargs="?", type=Path, default=default_archive_path())
    args = parser.parse_args(argv)
    try:
        manifest = export_dataset(args.archive)
        json.dump(manifest, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except ExportError as exc:
        print(f"export_dataset: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
