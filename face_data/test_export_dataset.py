import hashlib
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

try:
    from .export_dataset import ExportError, export_dataset, validate_pgm
except ImportError:  # Direct execution from the face_data directory.
    from export_dataset import ExportError, export_dataset, validate_pgm


REPO = Path(__file__).resolve().parent.parent
ARCHIVE = REPO / "att_faces.zip"
RASTER = b"\x00" * (92 * 112)
PGM = b"P5\n92 112\n255\n" + RASTER
README = b"ORL face archive test README\n"


def make_archive(path: Path, *, duplicate: bool = False, bad_pgm: bool = False,
                 extra_file: str | None = None) -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("README", README)
            for subject in range(1, 41):
                zf.writestr(f"s{subject}/", b"")
                for image in range(1, 11):
                    name = f"s{subject}/{image}.pgm"
                    content = b"P5\n92 112\n255\nshort" if bad_pgm and subject == 1 and image == 1 else PGM
                    zf.writestr(name, content)
            if extra_file:
                zf.writestr(extra_file, b"unexpected")
            if duplicate:
                zf.writestr("README", README)


class ExportDatasetTests(unittest.TestCase):
    def test_bundled_archive_exports_expected_shape_and_hashes(self):
        manifest = export_dataset(ARCHIVE)
        self.assertEqual(manifest["name"], "ORL-AT&T")
        self.assertEqual(manifest["archiveSha256"], hashlib.sha256(ARCHIVE.read_bytes()).hexdigest())
        self.assertEqual(len(manifest["subjects"]), 40)
        self.assertEqual([s["key"] for s in manifest["subjects"]], [f"s{i}" for i in range(1, 41)])
        first = manifest["subjects"][0]["images"][0]
        self.assertEqual(first["path"], "s1/1.pgm")
        self.assertEqual((first["width"], first["height"]), (92, 112))
        self.assertEqual(first["mimeType"], "image/x-portable-graymap")
        self.assertEqual(len(manifest["subjects"][0]["images"]), 10)
        self.assertEqual(len(manifest["subjects"][-1]["images"]), 10)
        decoded = __import__("base64").b64decode(first["data"])
        self.assertEqual(first["sha256"], hashlib.sha256(decoded).hexdigest())
        self.assertIn("Olivetti Research Laboratory", manifest["readme"])

    def test_pgm_header_comments_are_supported(self):
        validate_pgm(b"P5 # magic\n92 # width\n112\n255\r\n" + RASTER)

    def test_rejects_duplicate_zip_entry(self):
        with tempfile.TemporaryDirectory(dir=REPO) as tmp:
            path = Path(tmp) / "duplicate.zip"
            make_archive(path, duplicate=True)
            with self.assertRaisesRegex(ExportError, "duplicate or colliding"):
                export_dataset(path)

    def test_rejects_unsafe_paths_and_unexpected_files(self):
        with tempfile.TemporaryDirectory(dir=REPO) as tmp:
            path = Path(tmp) / "unsafe.zip"
            make_archive(path, extra_file="../escape.txt")
            with self.assertRaisesRegex(ExportError, "unsafe archive path"):
                export_dataset(path)

    def test_rejects_corrupt_pgm_content(self):
        with tempfile.TemporaryDirectory(dir=REPO) as tmp:
            path = Path(tmp) / "corrupt.zip"
            make_archive(path, bad_pgm=True)
            with self.assertRaisesRegex(ExportError, "raster bytes"):
                export_dataset(path)


if __name__ == "__main__":
    unittest.main()
