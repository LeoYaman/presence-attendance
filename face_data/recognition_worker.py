"""Local JSON-lines face detector with saved SFace and in-memory LBPH matching.

Identity matches are local suggestions. The worker emits no attendance writes,
and an identity match must not be treated as server-authenticated evidence.
"""
from __future__ import annotations

import base64
import hashlib
import json
import sys
from contextlib import redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from .webcam_faces import MODEL, URL  # Package import used by tests and integrations.
except ImportError:
    from webcam_faces import MODEL, URL  # Script execution from face_data/.

MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_FRAME_PIXELS = 1920 * 1080
MIN_FACE_EDGE = 80
MIN_DETECTION_SCORE = 0.70
LBPH_MAX_DISTANCE = 50.0
LBPH_MIN_MARGIN = 10.0
FACE_SIZE = (150, 150)
MAX_SAMPLES_PER_PERSON = 30
MAX_IDENTITIES_PER_GROUP = 200
MAX_GROUPS = 50
MAX_TOTAL_SAMPLES = 2000
MAX_REFERENCE_MAPPINGS = 100
TEAM_REFERENCE_KEYS = frozenset({"team_anthony", "team_leo", "team_rebbeca", "team_olivia"})
STUDENTS_PATH = Path(__file__).resolve().parent / "students.json"


class RequestError(ValueError):
    """A request cannot be processed safely."""


@dataclass
class Enrollment:
    samples: list[Any] = field(default_factory=list)
    hashes: set[str] = field(default_factory=set)


def accepted_lbph_match(distances: list[tuple[str, float]],
                        max_distance: float = LBPH_MAX_DISTANCE,
                        min_margin: float = LBPH_MIN_MARGIN) -> tuple[str | None, float | None]:
    """Return the unique best identity only when distance and runner-up margin pass."""
    finite = sorted(((person_id, float(distance)) for person_id, distance in distances
                     if _finite_number(distance) and float(distance) >= 0),
                    key=lambda item: item[1])
    if not finite:
        return None, None
    best_id, best_distance = finite[0]
    if best_distance > max_distance:
        return None, best_distance
    if len(finite) > 1 and finite[1][1] - best_distance < min_margin:
        return None, best_distance
    return best_id, best_distance


def _finite_number(value: Any) -> bool:
    try:
        return float(value) == float(value) and abs(float(value)) != float("inf")
    except (TypeError, ValueError):
        return False


def _decode_image(value: Any, cv2: Any) -> tuple[Any, bytes]:
    if not isinstance(value, str) or not value or len(value) > (MAX_IMAGE_BYTES * 4 // 3 + 16):
        raise RequestError("image must be a base64 JPEG within the size limit")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise RequestError("image is not valid base64") from error
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise RequestError("image exceeds the size limit")
    if not raw.startswith(b"\xff\xd8"):
        raise RequestError("image must be JPEG encoded")
    import numpy as np
    frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None or len(frame.shape) != 3:
        raise RequestError("image must decode as a color JPEG")
    height, width = frame.shape[:2]
    if width < 1 or height < 1 or width > 1920 or height > 1080 or width * height > MAX_FRAME_PIXELS:
        raise RequestError("image dimensions exceed the frame limit")
    return frame, raw


def _request_scope(request: dict[str, Any]) -> str:
    group_id = request.get("groupId")
    if not isinstance(group_id, str) or not group_id or len(group_id) > 200:
        raise RequestError("groupId must be a non-empty string")
    return group_id


def _allowed_ids(request: dict[str, Any]) -> set[str]:
    values = request.get("allowedIds", [])
    if not isinstance(values, list) or len(values) > 10000:
        raise RequestError("allowedIds must be a list")
    if any(not isinstance(value, str) or not value or len(value) > 200 for value in values):
        raise RequestError("allowedIds contains an invalid identifier")
    return set(values)


def _reference_mappings(request: dict[str, Any], allowed: set[str]) -> dict[str, str]:
    """Accept server-provided roster mappings, never paths or arbitrary gallery entries."""
    values = request.get("referenceMappings", [])
    if not isinstance(values, list) or len(values) > MAX_REFERENCE_MAPPINGS:
        raise RequestError(f"referenceMappings must be a list of at most {MAX_REFERENCE_MAPPINGS} mappings")
    mappings: dict[str, str] = {}
    mapped_people: set[str] = set()
    for value in values:
        if not isinstance(value, dict) or set(value) != {"referenceKey", "personId"}:
            raise RequestError("referenceMappings entries must contain only referenceKey and personId")
        reference_key, person_id = value["referenceKey"], value["personId"]
        if not isinstance(reference_key, str) or reference_key not in TEAM_REFERENCE_KEYS:
            raise RequestError("referenceKey must identify a known team reference")
        if not isinstance(person_id, str) or person_id not in allowed:
            raise RequestError("reference mapping personId must be in allowedIds")
        if reference_key in mappings or person_id in mapped_people:
            raise RequestError("referenceMappings contains duplicate referenceKey or personId")
        mappings[reference_key] = person_id
        mapped_people.add(person_id)
    return mappings


def _create_reference_recognizer() -> Any:
    # The repository recognizer prints enrollment progress. Keep the protocol's
    # stdout exclusively JSON lines, including during module import/initialization.
    try:
        with redirect_stdout(sys.stderr):
            if __package__:
                from .recognition import Recognizer
            else:
                from recognition import Recognizer
            return Recognizer(STUDENTS_PATH)
    except Exception as error:
        raise RequestError(f"Saved team recognition is unavailable: {error}") from error


class RecognitionWorker:
    def __init__(self, detector: Any, cv2: Any, np: Any):
        self.detector = detector
        self.cv2 = cv2
        self.np = np
        self.enrollments: dict[str, dict[str, Enrollment]] = {}
        self.models: dict[str, tuple[tuple[str, ...], dict[str, Any]]] = {}
        self.reference_recognizer: Any = None

    def _detect_references(self, frame: Any, mappings: dict[str, str]) -> dict[str, Any]:
        if self.reference_recognizer is None:
            self.reference_recognizer = _create_reference_recognizer()
        recognizer = self.reference_recognizer
        gallery = {student["id"]: saved for student, saved in recognizer.gallery
                   if student.get("kind") == "team" and student.get("id") in TEAM_REFERENCE_KEYS}
        if not set(mappings).issubset(gallery):
            raise RequestError("referenceMappings includes an unavailable team reference")
        height, width = frame.shape[:2]
        matches = []
        try:
            for face in recognizer.detect(frame):
                # YuNet returns x, y, width, height, landmarks, and detection score.
                if len(face) < 15 or not all(_finite_number(value) for value in face[:4]):
                    continue
                x, y, face_width, face_height = map(float, face[:4])
                if face_width <= 0 or face_height <= 0:
                    continue
                x0, y0 = max(0.0, min(float(width), x)), max(0.0, min(float(height), y))
                x1 = max(0.0, min(float(width), x + face_width))
                y1 = max(0.0, min(float(height), y + face_height))
                if x1 <= x0 or y1 <= y0:
                    continue
                raw_score = face[-1]
                score = max(0.0, min(1.0, float(raw_score))) if _finite_number(raw_score) else 0.0
                reference_key = None
                similarity = None
                if score >= MIN_DETECTION_SCORE:
                    feature = recognizer.feature(frame, face)
                    scores = []
                    for key in mappings:
                        value = recognizer.model.match(feature, gallery[key],
                                                       self.cv2.FaceRecognizerSF_FR_COSINE)
                        if _finite_number(value):
                            scores.append((key, float(value)))
                    scores.sort(key=lambda item: item[1], reverse=True)
                    if scores:
                        best_key, similarity = scores[0]
                        runner_up = scores[1][1] if len(scores) > 1 else -1.0
                        if (similarity >= recognizer.threshold and
                                similarity - runner_up + 1e-12 >= recognizer.margin):
                            reference_key = best_key
                matches.append({"studentId": mappings[reference_key] if reference_key else None,
                                "referenceKey": reference_key, "identityMatched": reference_key is not None,
                                "similarity": similarity, "recognitionMethod": "sface",
                                "confidence": score,
                                "box": {"x": x0 / width, "y": y0 / height,
                                        "width": (x1 - x0) / width, "height": (y1 - y0) / height}})
        except RequestError:
            raise
        except Exception as error:
            raise RequestError(f"Saved team recognition failed: {error}") from error
        return {"matches": matches, "registeredReferences": len(mappings)}

    def _faces(self, frame: Any) -> list[tuple[tuple[int, int, int, int], float, Any]]:
        rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        mp = self._mp
        result = self.detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        height, width = frame.shape[:2]
        faces = []
        for detection in result.detections or []:
            box = detection.bounding_box
            x0, y0 = max(0, box.origin_x), max(0, box.origin_y)
            x1 = min(width, box.origin_x + box.width)
            y1 = min(height, box.origin_y + box.height)
            categories = detection.categories or []
            score = float(categories[0].score) if categories else 0.0
            if x1 <= x0 or y1 <= y0 or not _finite_number(score):
                continue
            faces.append(((x0, y0, x1, y1), score, frame[y0:y1, x0:x1]))
        return faces

    def _normalize(self, crop: Any) -> Any:
        gray = self.cv2.cvtColor(crop, self.cv2.COLOR_BGR2GRAY)
        gray = self.cv2.equalizeHist(gray)
        return self.cv2.resize(gray, FACE_SIZE, interpolation=self.cv2.INTER_AREA)

    def _prune_to_allowed(self, group_id: str, allowed: set[str]) -> None:
        group = self.enrollments.get(group_id)
        if group is None:
            return
        stale = set(group) - allowed
        for person_id in stale:
            del group[person_id]
        if stale:
            self.models.pop(group_id, None)
        if not group:
            self.enrollments.pop(group_id, None)

    def _sample_counts(self, group_id: str, allowed: set[str]) -> dict[str, int]:
        return {person_id: len(enrollment.samples)
                for person_id, enrollment in self.enrollments.get(group_id, {}).items()
                if person_id in allowed}

    def _models_for(self, group_id: str, allowed: set[str]) -> dict[str, Any]:
        key = tuple(sorted(allowed))
        group = self.enrollments.get(group_id)
        if not group:
            self.models.pop(group_id, None)
            return {}
        cached = self.models.get(group_id)
        if cached and cached[0] == key:
            return cached[1]
        trained: dict[str, Any] = {}
        for person_id in key:
            enrollment = group.get(person_id)
            if not enrollment or len(enrollment.samples) < 5:
                continue
            recognizer = self.cv2.face.LBPHFaceRecognizer_create()
            labels = self.np.zeros((len(enrollment.samples),), dtype=self.np.int32)
            recognizer.train(enrollment.samples, labels)
            trained[person_id] = recognizer
        self.models[group_id] = (key, trained)
        return trained

    def process(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request.get("action")
        if action not in {"detect", "enroll", "clear"}:
            raise RequestError("action must be detect, enroll, or clear")
        group_id = _request_scope(request)
        allowed = _allowed_ids(request)
        if action == "clear":
            person_id = request.get("personId")
            if person_id is None:
                removed = sum(len(item.samples) for item in self.enrollments.pop(group_id, {}).values())
                self.models.pop(group_id, None)
                return {"cleared": "group", "samplesRemoved": removed, "sampleCounts": {}}
            if not isinstance(person_id, str) or not person_id:
                raise RequestError("personId must be a non-empty string")
            enrollment = self.enrollments.get(group_id, {}).pop(person_id, None)
            self.models.pop(group_id, None)
            self._prune_to_allowed(group_id, allowed)
            return {"cleared": "person", "personId": person_id,
                    "samplesRemoved": len(enrollment.samples) if enrollment else 0,
                    "sampleCounts": self._sample_counts(group_id, allowed)}

        self._prune_to_allowed(group_id, allowed)
        mappings = _reference_mappings(request, allowed) if action == "detect" else {}
        frame, raw = _decode_image(request.get("image"), self.cv2)
        if mappings:
            return {**self._detect_references(frame, mappings),
                    "sampleCounts": self._sample_counts(group_id, allowed)}
        faces = self._faces(frame)
        if action == "enroll":
            person_id = request.get("personId")
            if not isinstance(person_id, str) or not person_id:
                raise RequestError("personId must be a non-empty string")
            if person_id not in allowed:
                raise RequestError("personId must be in allowedIds")
            if len(faces) != 1:
                raise RequestError("enrollment requires exactly one detected face in the image")
            _, score, crop = faces[0]
            if score < MIN_DETECTION_SCORE or min(crop.shape[:2]) < MIN_FACE_EDGE:
                raise RequestError("enrollment face must be at least 80px wide and high with score >= 0.7")
            group = self.enrollments.get(group_id)
            if group is None and len(self.enrollments) >= MAX_GROUPS:
                raise RequestError(f"worker memory limit reached ({MAX_GROUPS} groups); clear an unused group")
            if group is not None and person_id not in group and len(group) >= MAX_IDENTITIES_PER_GROUP:
                raise RequestError(f"group identity limit reached ({MAX_IDENTITIES_PER_GROUP}); clear an unused identity")
            enrollment = group.get(person_id) if group is not None else None
            digest = hashlib.sha256(raw).hexdigest()
            added = enrollment is None or digest not in enrollment.hashes
            if added:
                if enrollment and len(enrollment.samples) >= MAX_SAMPLES_PER_PERSON:
                    raise RequestError(f"sample limit reached ({MAX_SAMPLES_PER_PERSON}); clear this identity before enrolling again")
                total_samples = sum(len(item.samples) for scoped in self.enrollments.values()
                                    for item in scoped.values())
                if total_samples >= MAX_TOTAL_SAMPLES:
                    raise RequestError(f"worker sample limit reached ({MAX_TOTAL_SAMPLES}); clear an unused group or identity")
                if group is None:
                    group = {}
                    self.enrollments[group_id] = group
                if enrollment is None:
                    enrollment = Enrollment()
                    group[person_id] = enrollment
                enrollment.hashes.add(digest)
                enrollment.samples.append(self._normalize(crop))
                self.models.pop(group_id, None)
            return {"enrolled": added, "personId": person_id,
                    "sampleCount": len(enrollment.samples), "ready": len(enrollment.samples) >= 5,
                    "sampleCounts": self._sample_counts(group_id, allowed)}

        models = self._models_for(group_id, allowed)
        height, width = frame.shape[:2]
        matches = []
        for box, score, crop in faces:
            identity = None
            distance = None
            if score >= MIN_DETECTION_SCORE and min(crop.shape[:2]) >= MIN_FACE_EDGE and models:
                normalized = self._normalize(crop)
                distances = []
                for person_id, recognizer in models.items():
                    _, raw_distance = recognizer.predict(normalized)
                    distances.append((person_id, float(raw_distance)))
                identity, distance = accepted_lbph_match(distances)
            x0, y0, x1, y1 = box
            matches.append({"studentId": identity, "distance": distance,
                            "box": {"x": x0 / width, "y": y0 / height,
                                    "width": (x1 - x0) / width, "height": (y1 - y0) / height},
                            "confidence": score, "identityMatched": identity is not None})
        return {"matches": matches, "sampleCounts": self._sample_counts(group_id, allowed),
                "registeredReferences": 0}


def _create_worker() -> RecognitionWorker:
    try:
        import cv2
        import mediapipe as mp
        import numpy as np
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError as error:
        raise RuntimeError("Install face_data/requirements.txt to run recognition_worker.py") from error
    if not hasattr(cv2, "face") or not hasattr(cv2.face, "LBPHFaceRecognizer_create"):
        raise RuntimeError("opencv-contrib-python with the face module is required")
    if not Path(MODEL).is_file():
        raise RuntimeError(f"Detector model is missing; download {URL} to {MODEL}")
    options = vision.FaceDetectorOptions(
        base_options=python.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.IMAGE,
        min_detection_confidence=MIN_DETECTION_SCORE,
    )
    worker = RecognitionWorker(vision.FaceDetector.create_from_options(options), cv2, np)
    worker._mp = mp
    return worker


def main() -> int:
    try:
        worker = _create_worker()
    except Exception as error:
        print(f"recognition worker startup failed: {error}", file=sys.stderr, flush=True)
        return 1
    try:
        for line in sys.stdin:
            request_id = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise RequestError("request must be a JSON object")
                request_id = request.get("id")
                response = {"id": request_id, "ok": True, **worker.process(request)}
            except Exception as error:
                response = {"id": request_id, "ok": False, "error": str(error) or error.__class__.__name__}
                print(f"request failed: {error}", file=sys.stderr, flush=True)
            print(json.dumps(response, separators=(",", ":"), allow_nan=False), flush=True)
    finally:
        worker.detector.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
