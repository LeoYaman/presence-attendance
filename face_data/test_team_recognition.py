"""Dependency-light tests for saved-reference scope and SFace output boundaries."""
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from face_data.recognition_worker import (
    MAX_REFERENCE_MAPPINGS,
    STUDENTS_PATH,
    RecognitionWorker,
    RequestError,
    _create_reference_recognizer,
)


LEO_ID = "79f2110b-8a36-47c3-aacd-ef533038fb5d"
OLIVIA_ID = "e8e12d16-8edb-48cd-81d2-dc2b005023a4"
ANTHONY_ID = "c20d0ff4-6d96-409f-9baf-51d8bdcf4113"


def face(x=10, y=20, width=100, height=120, score=0.95):
    return [x, y, width, height] + [0] * 10 + [score]


class TeamRecognitionTests(unittest.TestCase):
    def make_worker(self, scores=None, faces=None):
        scores = scores or {"team_leo": 0.8, "team_olivia": 0.5,
                            "team_anthony": 0.99, "team_rebbeca": 0.98}
        recognizer = SimpleNamespace(
            gallery=[({"id": key, "kind": "team", "name": "Local reference name"}, key)
                     for key in scores],
            threshold=0.45,
            margin=0.06,
            detect=Mock(return_value=[face()] if faces is None else faces),
            feature=Mock(return_value="live-feature"),
            model=SimpleNamespace(match=Mock(side_effect=lambda _live, saved, _metric: scores[saved])),
        )
        worker = RecognitionWorker(None, SimpleNamespace(FaceRecognizerSF_FR_COSINE=7), None)
        worker._faces = Mock(side_effect=AssertionError("SFace must not use MediaPipe faces"))
        return worker, recognizer

    def request(self, mappings=None, allowed=None):
        return {"action": "detect", "groupId": "group-a", "image": "mock-jpeg",
                "allowedIds": [LEO_ID, OLIVIA_ID] if allowed is None else allowed,
                "referenceMappings": [{"referenceKey": "team_leo", "personId": LEO_ID},
                                      {"referenceKey": "team_olivia", "personId": OLIVIA_ID}]
                if mappings is None else mappings}

    def detect(self, worker, recognizer, request=None):
        with patch("face_data.recognition_worker._decode_image",
                   return_value=(SimpleNamespace(shape=(480, 640, 3)), b"jpeg")), \
                patch("face_data.recognition_worker._create_reference_recognizer",
                      return_value=recognizer) as factory:
            result = worker.process(self.request() if request is None else request)
        return result, factory

    def test_only_mapped_references_compete_and_match_roster_id_without_samples(self):
        worker, recognizer = self.make_worker()
        result, factory = self.detect(worker, recognizer)
        self.assertEqual(result["registeredReferences"], 2)
        self.assertEqual(result["sampleCounts"], {})
        match = result["matches"][0]
        self.assertEqual(match["studentId"], LEO_ID)
        self.assertEqual(match["referenceKey"], "team_leo")
        self.assertTrue(match["identityMatched"])
        self.assertEqual(match["recognitionMethod"], "sface")
        self.assertEqual(match["similarity"], 0.8)
        self.assertEqual(match["confidence"], 0.95)
        self.assertEqual([call.args[1] for call in recognizer.model.match.call_args_list],
                         ["team_leo", "team_olivia"])
        factory.assert_called_once_with()

    def test_threshold_and_runner_up_margin(self):
        for best, second, expected in [(0.449, 0.2, False), (0.45, 0.3, True),
                                       (0.60, 0.541, False), (0.60, 0.54, True)]:
            with self.subTest(best=best, second=second):
                worker, recognizer = self.make_worker({"team_leo": best, "team_olivia": second})
                result, _ = self.detect(worker, recognizer)
                match = result["matches"][0]
                self.assertEqual(match["identityMatched"], expected)
                self.assertEqual(match["studentId"], LEO_ID if expected else None)
                self.assertEqual(match["referenceKey"], "team_leo" if expected else None)
                self.assertEqual(match["similarity"], best)

    def test_single_mapped_reference_needs_threshold_but_no_runner_up(self):
        worker, recognizer = self.make_worker({"team_leo": 0.45, "team_olivia": 0.99})
        request = self.request(mappings=[{"referenceKey": "team_leo", "personId": LEO_ID}])
        result, _ = self.detect(worker, recognizer, request)
        self.assertEqual(result["matches"][0]["studentId"], LEO_ID)
        self.assertEqual(result["registeredReferences"], 1)

    def test_gallery_is_cached_but_current_roster_mappings_control_every_match(self):
        worker, recognizer = self.make_worker()
        self.detect(worker, recognizer)
        recognizer.model.match.reset_mock()
        request = self.request(mappings=[{"referenceKey": "team_anthony", "personId": ANTHONY_ID}],
                               allowed=[ANTHONY_ID])
        result, factory = self.detect(worker, recognizer, request)
        factory.assert_not_called()
        self.assertEqual(result["matches"][0]["studentId"], ANTHONY_ID)
        self.assertEqual([call.args[1] for call in recognizer.model.match.call_args_list], ["team_anthony"])

    def test_empty_mappings_leave_existing_pipeline_and_do_not_load_references(self):
        worker, recognizer = self.make_worker()
        worker._faces = Mock(return_value=[])
        request = self.request(mappings=[])
        result, factory = self.detect(worker, recognizer, request)
        factory.assert_not_called()
        worker._faces.assert_called_once()
        self.assertEqual(result["registeredReferences"], 0)
        self.assertEqual(result["matches"], [])

    def test_mapping_validation_rejects_unscoped_paths_unknown_keys_and_duplicates(self):
        invalid = [
            [{"referenceKey": "team_leo", "personId": "outside-roster"}],
            [{"referenceKey": "s1", "personId": LEO_ID}],
            [{"referenceKey": "../students.json", "personId": LEO_ID}],
            [{"referenceKey": "team_leo", "personId": LEO_ID, "photo": "other.jpg"}],
            [{"referenceKey": "team_leo", "personId": LEO_ID},
             {"referenceKey": "team_leo", "personId": OLIVIA_ID}],
            [{"referenceKey": "team_leo", "personId": LEO_ID},
             {"referenceKey": "team_olivia", "personId": LEO_ID}],
            [{"referenceKey": "team_leo", "personId": []}],
            [{}], None, {}, [None],
            [{"referenceKey": "team_leo", "personId": LEO_ID}] * (MAX_REFERENCE_MAPPINGS + 1),
        ]
        for mappings in invalid:
            with self.subTest(mappings=mappings):
                worker, recognizer = self.make_worker()
                request = self.request()
                request["referenceMappings"] = mappings
                with patch("face_data.recognition_worker._create_reference_recognizer") as factory:
                    with self.assertRaises(RequestError):
                        worker.process(request)
                    factory.assert_not_called()

    def test_known_key_must_also_be_available_in_loaded_gallery(self):
        worker, recognizer = self.make_worker({"team_leo": 0.9})
        with self.assertRaisesRegex(RequestError, "unavailable team reference"):
            self.detect(worker, recognizer)

    def test_confidence_and_boxes_are_clamped_and_similarity_is_not_probability(self):
        worker, recognizer = self.make_worker({"team_leo": 1.2, "team_olivia": -0.5},
                                            [face(-10, -20, 800, 600, 1.5)])
        result, _ = self.detect(worker, recognizer)
        match = result["matches"][0]
        self.assertEqual(match["confidence"], 1.0)
        self.assertEqual(match["box"], {"x": 0, "y": 0, "width": 1, "height": 1})
        self.assertEqual(match["similarity"], 1.2)
        json.dumps(result, allow_nan=False)

    def test_nonfinite_similarity_stays_unknown_and_json_serializable(self):
        worker, recognizer = self.make_worker({"team_leo": float("nan"), "team_olivia": float("inf")})
        result, _ = self.detect(worker, recognizer)
        self.assertFalse(result["matches"][0]["identityMatched"])
        self.assertIsNone(result["matches"][0]["similarity"])
        json.dumps(result, allow_nan=False)

    def test_nonfinite_confidence_stays_unknown_and_bad_boxes_are_skipped(self):
        worker, recognizer = self.make_worker(faces=[face(score=float("nan")),
                                                   face(x=float("inf")), face(width=-1),
                                                   face(x=700), face(score=-3)])
        result, _ = self.detect(worker, recognizer)
        self.assertEqual(len(result["matches"]), 2)
        self.assertTrue(all(match["studentId"] is None for match in result["matches"]))
        self.assertTrue(all(match["confidence"] == 0 for match in result["matches"]))
        recognizer.feature.assert_not_called()
        json.dumps(result, allow_nan=False)

    def test_model_failures_are_request_errors(self):
        worker, recognizer = self.make_worker()
        recognizer.detect.side_effect = RuntimeError("missing model")
        with self.assertRaisesRegex(RequestError, "Saved team recognition failed: missing model"):
            self.detect(worker, recognizer)


class LazyRecognizerTests(unittest.TestCase):
    def test_repository_path_is_fixed_and_initialization_stdout_goes_to_stderr(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        expected = object()

        def constructor(path):
            self.assertEqual(path, STUDENTS_PATH)
            self.assertEqual(path.name, "students.json")
            print("Enrolled Leo")
            return expected

        with patch("face_data.recognition.Recognizer", side_effect=constructor), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertIs(_create_reference_recognizer(), expected)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("Enrolled Leo", stderr.getvalue())

    def test_absent_models_are_clear_request_errors(self):
        with patch("face_data.recognition.Recognizer", side_effect=RuntimeError("Download recognition models first")):
            with self.assertRaisesRegex(RequestError, "Saved team recognition is unavailable: Download"):
                _create_reference_recognizer()


if __name__ == "__main__":
    unittest.main()
