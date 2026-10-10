"""YuNet face alignment and SFace identity matching for a local team demo."""
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent
MODELS = {
    "face_detection_yunet_2023mar.onnx": "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}

def download_models():
    directory = ROOT / "models"
    directory.mkdir(exist_ok=True)
    for filename, url in MODELS.items():
        target = directory / filename
        if target.is_file():
            print(f"Already downloaded: {filename}", flush=True)
            continue
        temporary = target.with_suffix(".download")
        print(f"Downloading {filename}...", flush=True)
        try:
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)

class Recognizer:
    def __init__(self, students_path, include_samples=False, threshold=0.45, margin=0.06):
        import cv2
        self.cv2 = cv2
        self.threshold = threshold
        self.margin = margin
        paths = [ROOT / "models" / name for name in MODELS]
        if not all(path.is_file() for path in paths):
            raise RuntimeError("Download recognition models first: python face_data/webcam_faces.py --download-recognition-models")
        self.detector = cv2.FaceDetectorYN.create(str(paths[0]), "", (320, 320), 0.85, 0.3, 5000)
        self.model = cv2.FaceRecognizerSF.create(str(paths[1]), "")
        self.gallery = []
        students_path = Path(students_path)
        data = json.loads(students_path.read_text(encoding="utf-8-sig"))
        students = data["students"]
        seen = set()
        for student in students:
            if student.get("kind") != "team" and not include_samples:
                continue
            student_id = student["id"]
            if student_id in seen:
                raise RuntimeError(f"Duplicate student ID: {student_id}")
            seen.add(student_id)
            photo = students_path.parent / student["photo"]
            image = cv2.imread(str(photo))
            if image is None:
                raise RuntimeError(f"Cannot read reference photo: {photo}")
            image = self.resize(image)
            faces = self.detect(image)
            if len(faces) != 1:
                raise RuntimeError(f"{student['name']}: expected exactly one face in {photo.name}, found {len(faces)}. Use a clear single-person photo.")
            self.gallery.append((student, self.feature(image, faces[0])))
            print(f"Enrolled {student['name']}", flush=True)
        if not self.gallery:
            raise RuntimeError("No enrolled team members found in students.json.")

    def resize(self, image):
        height, width = image.shape[:2]
        scale = min(1.0, 960 / max(height, width))
        if scale < 1:
            return self.cv2.resize(image, (round(width * scale), round(height * scale)))
        return image

    def detect(self, image):
        self.detector.setInputSize((image.shape[1], image.shape[0]))
        _, faces = self.detector.detect(image)
        return [] if faces is None else faces

    def feature(self, image, face):
        return self.model.feature(self.model.alignCrop(image, face)).copy()

    def match(self, feature):
        scores = sorted(
            ((float(self.model.match(feature, saved, self.cv2.FaceRecognizerSF_FR_COSINE)), student)
             for student, saved in self.gallery),
            key=lambda item: item[0], reverse=True,
        )
        score, student = scores[0]
        runner_up = scores[1][0] if len(scores) > 1 else -1.0
        if score < self.threshold or score - runner_up < self.margin:
            return None, score
        return student, score

def run(args):
    import cv2
    recognizer = Recognizer(args.students, args.include_samples, args.threshold, args.margin)
    print(f"Loaded {len(recognizer.gallery)} identities. Similarity scores are not probabilities.", flush=True)
    if args.check_enrollment:
        for student, feature in recognizer.gallery:
            matched, score = recognizer.match(feature)
            if matched is None or matched["id"] != student["id"]:
                raise RuntimeError(f"Ambiguous enrollment: {student['name']}. Use a better reference photo.")
            print(f"Reference self-check: {student['name']} ({score:.3f})", flush=True)
        print("Enrollment check passed. This does not measure live webcam accuracy.", flush=True)
        return
    print(f"Opening camera {args.camera}...", flush=True)
    camera = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(args.camera)
    window = "Team recognition - Q or Esc to quit"
    try:
        if not camera.isOpened():
            raise RuntimeError("Cannot open webcam. Close other camera apps or try --camera 1.")
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        print("Camera opened. Press Q or Esc to quit.", flush=True)
        while True:
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError("Cannot read webcam frame.")
            faces = recognizer.detect(frame)
            labels = []
            # Match unmodified pixels before drawing any overlays.
            for face in faces:
                student, score = recognizer.match(recognizer.feature(frame, face))
                labels.append((face, student, score))
            for face, student, score in labels:
                x, y, width, height = [int(value) for value in face[:4]]
                color = (0, 255, 0) if student else (0, 165, 255)
                name = student["name"] if student else "Unknown"
                cv2.rectangle(frame, (max(0, x), max(0, y)),
                              (min(frame.shape[1]-1, x+width), min(frame.shape[0]-1, y+height)), color, 2)
                cv2.putText(frame, f"{name} | similarity {score:.2f}", (max(0, x), max(25, y-8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            cv2.putText(frame, f"Faces: {len(faces)} | Q/Esc: quit", (10, frame.shape[0]-15),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.imshow(window, frame)
            if (cv2.waitKey(1) & 0xFF) in (ord("q"), ord("Q"), 27):
                break
            if cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
                break
    finally:
        camera.release()
        cv2.destroyAllWindows()
