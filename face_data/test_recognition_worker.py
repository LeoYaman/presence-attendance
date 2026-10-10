"""Dependency-light tests for the worker's identity acceptance boundary."""
import unittest
from unittest.mock import patch

from face_data.recognition_worker import (
    Enrollment,
    MAX_TOTAL_SAMPLES,
    RecognitionWorker,
    accepted_lbph_match,
)


class MatchAcceptanceTests(unittest.TestCase):
    def test_accepts_clear_best_identity_below_distance_limit(self):
        self.assertEqual(
            accepted_lbph_match([("person-a", 31.0), ("person-b", 45.0)]),
            ("person-a", 31.0),
        )

    def test_rejects_distance_above_conservative_limit(self):
        self.assertEqual(accepted_lbph_match([("person-a", 50.01)]), (None, 50.01))

    def test_rejects_ambiguous_runner_up(self):
        self.assertEqual(
            accepted_lbph_match([("person-a", 32.0), ("person-b", 41.9)]),
            (None, 32.0),
        )

    def test_accepts_exact_minimum_margin(self):
        self.assertEqual(
            accepted_lbph_match([("person-a", 32.0), ("person-b", 42.0)]),
            ("person-a", 32.0),
        )

    def test_ignores_invalid_distances_and_returns_unknown_when_none_remain(self):
        self.assertEqual(accepted_lbph_match([("nan", float("nan")), ("inf", float("inf"))]), (None, None))

    def test_orders_by_distance_instead_of_person_id(self):
        self.assertEqual(
            accepted_lbph_match([("z-person", 20.0), ("a-person", 44.0)]),
            ("z-person", 20.0),
        )


class ClearScopeTests(unittest.TestCase):
    def test_person_clear_does_not_remove_other_people_or_groups(self):
        worker = RecognitionWorker(None, None, None)
        worker.enrollments = {
            "group-a": {"person-a": Enrollment([object(), object()]),
                        "person-b": Enrollment([object()])},
            "group-b": {"person-a": Enrollment([object()])},
        }
        result = worker.process({"action": "clear", "groupId": "group-a", "personId": "person-a",
                                 "allowedIds": ["person-b"]})
        self.assertEqual(result["samplesRemoved"], 2)
        self.assertEqual(result["sampleCounts"], {"person-b": 1})
        self.assertEqual(len(worker.enrollments["group-b"]["person-a"].samples), 1)

    def test_group_clear_removes_only_that_scope(self):
        worker = RecognitionWorker(None, None, None)
        worker.enrollments = {
            "group-a": {"person-a": Enrollment([object(), object()])},
            "group-b": {"person-b": Enrollment([object()])},
        }
        result = worker.process({"action": "clear", "groupId": "group-a", "allowedIds": []})
        self.assertEqual(result["samplesRemoved"], 2)
        self.assertNotIn("group-a", worker.enrollments)
        self.assertIn("group-b", worker.enrollments)

    def test_roster_change_prunes_stale_identity_and_invalidates_cached_models(self):
        worker = RecognitionWorker(None, None, None)
        worker.enrollments = {"group-a": {"stale": Enrollment([object()]), "active": Enrollment([object()])}}
        worker.models = {"group-a": (("active", "stale"), {})}
        worker._prune_to_allowed("group-a", {"active"})
        self.assertEqual(set(worker.enrollments["group-a"]), {"active"})
        self.assertNotIn("group-a", worker.models)


class EnrollmentSafetyTests(unittest.TestCase):
    class Crop:
        def __init__(self, height, width):
            self.shape = (height, width, 3)

    def make_worker(self, faces, enrollment=None):
        worker = RecognitionWorker(None, None, None)
        worker._faces = lambda _frame: faces
        if enrollment is not None:
            worker.enrollments = {"group": {"person": enrollment}}
        return worker

    def test_enrollment_rejects_a_small_second_face_even_if_only_one_is_eligible(self):
        faces = [((0, 0, 100, 100), 0.9, self.Crop(100, 100)),
                 ((120, 0, 160, 40), 0.8, self.Crop(40, 40))]
        worker = self.make_worker(faces)
        with patch("face_data.recognition_worker._decode_image", return_value=(object(), b"jpeg")):
            with self.assertRaisesRegex(ValueError, "exactly one detected face"):
                worker.process({"action": "enroll", "groupId": "group", "personId": "person",
                                "allowedIds": ["person"], "image": "eA=="})

    def test_enrollment_stops_at_per_person_sample_cap(self):
        faces = [((0, 0, 100, 100), 0.9, self.Crop(100, 100))]
        enrollment = Enrollment([object()] * 30, set())
        worker = self.make_worker(faces, enrollment)
        with patch("face_data.recognition_worker._decode_image", return_value=(object(), b"new jpeg")):
            with self.assertRaisesRegex(ValueError, "sample limit reached"):
                worker.process({"action": "enroll", "groupId": "group", "personId": "person",
                                "allowedIds": ["person"], "image": "eA=="})

    def test_enrollment_stops_at_aggregate_sample_cap_without_allocating_face_arrays(self):
        faces = [((0, 0, 100, 100), 0.9, self.Crop(100, 100))]
        group = {f"person-{index}": Enrollment([None] * (30 if index < 66 else 20))
                 for index in range(67)}
        worker = self.make_worker(faces)
        worker.enrollments = {"group": group}
        self.assertEqual(sum(len(item.samples) for item in group.values()), MAX_TOTAL_SAMPLES)
        allowed = list(group) + ["new-person"]
        with patch("face_data.recognition_worker._decode_image", return_value=(object(), b"new jpeg")):
            with self.assertRaisesRegex(ValueError, "worker sample limit reached"):
                worker.process({"action": "enroll", "groupId": "group", "personId": "new-person",
                                "allowedIds": allowed, "image": "eA=="})
        self.assertNotIn("new-person", worker.enrollments["group"])


if __name__ == "__main__":
    unittest.main()
