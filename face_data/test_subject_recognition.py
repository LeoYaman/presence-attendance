"""Persistent subject isolation and real local SFace reference regression checks."""
import base64
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from face_data.recognition_worker import RecognitionWorker, RequestError, STUDENTS_PATH


class SubjectRecognitionTests(unittest.TestCase):
    def setUp(self):
        self.frame = SimpleNamespace(shape=(480, 640, 3))
        self.face = [10, 20, 100, 120] + [0] * 10 + [0.95]
        self.engine = SimpleNamespace(detect=Mock(return_value=[self.face]),
                                      feature=Mock(return_value='feature'), threshold=0.45, margin=0.06,
                                      model=SimpleNamespace(match=Mock(return_value=0.9)))
        self.worker = RecognitionWorker(None, SimpleNamespace(FaceRecognizerSF_FR_COSINE=7), None)
        self.worker.subject_engine = self.engine
        self.request = {'action': 'detect', 'groupId': 'subjects:finder', 'allowedIds': ['arbitrary-subject'],
                        'subjectsVersion': 1, 'image': 'jpeg',
                        'subjectReferences': [{'subjectId': 'arbitrary-subject', 'referenceId': 'r1', 'image': 'jpeg'}]}

    def detect(self, request=None):
        with patch('face_data.recognition_worker._decode_image', return_value=(self.frame, b'jpeg')):
            return self.worker.process(request or self.request)

    def test_arbitrary_subject_matches_and_cache_rebuilds_on_version_or_content_change(self):
        self.assertEqual(self.detect()['matches'][0]['subjectId'], 'arbitrary-subject')
        self.detect()
        self.assertEqual(self.engine.feature.call_count, 3)  # one enrollment + two frames
        self.request['subjectsVersion'] = 2
        self.detect()
        self.assertEqual(self.engine.feature.call_count, 5)
        self.request['subjectReferences'][0]['image'] = 'changed'
        self.detect()
        self.assertEqual(self.engine.feature.call_count, 7)

    def test_empty_list_removes_cached_identity_without_legacy_fallback(self):
        self.detect()
        self.request['subjectReferences'] = []
        self.request['allowedIds'] = []
        result = self.detect()
        self.assertIsNone(result['matches'][0]['subjectId'])
        self.assertEqual(result['registeredReferences'], 0)

    def test_unauthorized_subject_is_rejected(self):
        self.request['allowedIds'] = []
        with self.assertRaisesRegex(RequestError, 'allowedIds'):
            self.detect()

    def test_reference_validation_rejects_multiple_faces(self):
        self.engine.detect.return_value = [self.face, self.face]
        with patch('face_data.recognition_worker._decode_image', return_value=(self.frame, b'jpeg')):
            with self.assertRaisesRegex(RequestError, 'exactly one'):
                self.worker.process({'action': 'validate-reference', 'image': 'jpeg'})

    def test_ambiguous_distinct_subjects_stay_unknown_but_multiple_refs_of_same_subject_do_not_compete(self):
        self.request['subjectReferences'].append({'subjectId': 'arbitrary-subject', 'referenceId': 'r2', 'image': 'jpeg'})
        self.assertTrue(self.detect()['matches'][0]['identityMatched'])
        self.request['allowedIds'].append('other-subject')
        self.request['subjectReferences'].append({'subjectId': 'other-subject', 'referenceId': 'r3', 'image': 'jpeg'})
        self.assertFalse(self.detect()['matches'][0]['identityMatched'])


class RealSubjectPhotoTests(unittest.TestCase):
    def test_olivia_dynamic_upload_and_removal(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('OpenCV runtime unavailable')
        if not (STUDENTS_PATH.parent / 'models' / 'face_recognition_sface_2021dec.onnx').is_file():
            self.skipTest('SFace model unavailable')
        students = json.loads(STUDENTS_PATH.read_text(encoding='utf-8-sig'))['students']
        references = []
        photo = None
        for student in students:
            if student.get('kind') != 'team':
                continue
            path = STUDENTS_PATH.parent / student['photo']
            if not path.is_file():
                self.skipTest('Local team reference photos unavailable')
            image = cv2.imread(str(path))
            scale = min(1, 960 / max(image.shape[:2]))
            image = cv2.resize(image, (round(image.shape[1] * scale), round(image.shape[0] * scale)))
            encoded = base64.b64encode(cv2.imencode('.jpg', image)[1].tobytes()).decode()
            references.append({'subjectId': 'db-' + student['id'], 'referenceId': student['id'], 'image': encoded})
            if student['id'] == 'team_olivia':
                photo = encoded
        worker = RecognitionWorker(None, cv2, np)
        self.assertTrue(worker.process({'action': 'validate-reference', 'image': photo})['valid'])
        with self.assertRaises(RequestError):
            worker.process({'action': 'validate-reference', 'image': base64.b64encode(b'not a jpeg').decode()})
        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        blank_encoded = base64.b64encode(cv2.imencode('.jpg', blank)[1].tobytes()).decode()
        with self.assertRaisesRegex(RequestError, 'exactly one'):
            worker.process({'action': 'validate-reference', 'image': blank_encoded})
        olivia_image = cv2.imdecode(np.frombuffer(base64.b64decode(photo), dtype=np.uint8), cv2.IMREAD_COLOR)
        two_people = np.concatenate([olivia_image, olivia_image], axis=1)
        multiple = base64.b64encode(cv2.imencode('.jpg', two_people)[1].tobytes()).decode()
        with self.assertRaisesRegex(RequestError, 'exactly one'):
            worker.process({'action': 'validate-reference', 'image': multiple})
        request = {'action': 'detect', 'groupId': 'subjects:finder', 'subjectsVersion': 1,
                   'allowedIds': [r['subjectId'] for r in references], 'subjectReferences': references, 'image': photo}
        result = worker.process(request)
        self.assertEqual(result['matches'][0]['subjectId'], 'db-team_olivia')
        request['image'] = blank_encoded
        self.assertEqual(worker.process(request)['matches'], [])
        request['image'] = photo
        # The same photo becomes unknown immediately after persistent removal.
        request.update(subjectReferences=[], allowedIds=[], subjectsVersion=2)
        self.assertIsNone(worker.process(request)['matches'][0]['subjectId'])


if __name__ == '__main__':
    unittest.main()
