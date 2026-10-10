"""Local webcam face detection and optional team recognition; no image recording."""
import argparse
from pathlib import Path
import sys
import time
import urllib.request

MODEL = Path(__file__).resolve().parent / "models" / "blaze_face_short_range.tflite"
URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--confidence", type=float, default=0.6)
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--recognize", action="store_true", help="Match enrolled team members")
    parser.add_argument("--download-recognition-models", action="store_true")
    parser.add_argument("--check-enrollment", action="store_true", help="Validate references without opening webcam")
    parser.add_argument("--students", type=Path, default=Path(__file__).resolve().parent / "students.json")
    parser.add_argument("--include-samples", action="store_true", help="Also enroll AT&T sample subjects")
    parser.add_argument("--threshold", type=float, default=0.45, help="Minimum cosine similarity, not a probability")
    parser.add_argument("--margin", type=float, default=0.06, help="Minimum gap between best and second match")
    args = parser.parse_args()
    if not 0 <= args.threshold <= 1 or not 0 <= args.margin <= 2:
        parser.error("Invalid recognition threshold or margin")
    if args.download_recognition_models:
        from recognition import download_models
        download_models()
        return
    if args.recognize or args.check_enrollment:
        from recognition import run
        run(args)
        return
    if not 0 <= args.confidence <= 1:
        parser.error("--confidence must be between 0 and 1")
    if args.download_model:
        MODEL.parent.mkdir(parents=True, exist_ok=True)
        temporary = MODEL.with_suffix(".download")
        try:
            urllib.request.urlretrieve(URL, temporary)
            temporary.replace(MODEL)
        finally:
            temporary.unlink(missing_ok=True)
        print(f"Model saved to {MODEL}")
        return
    print(f"Python: {sys.executable}", flush=True)
    print("Loading face detection libraries...", flush=True)
    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError as error:
        raise RuntimeError("Install dependencies: python -m pip install -r face_data/requirements.txt") from error
    if not MODEL.is_file():
        raise RuntimeError("Run this script with --download-model first.")
    options = vision.FaceDetectorOptions(
        base_options=python.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.VIDEO,
        min_detection_confidence=args.confidence,
    )
    print(f"Opening camera {args.camera}...", flush=True)
    camera = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(args.camera)
    window = "Webcam faces - Q or Esc to quit"
    try:
        if not camera.isOpened():
            raise RuntimeError("Cannot open webcam. Close other camera apps or try --camera 1.")
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        last_timestamp = -1
        with vision.FaceDetector.create_from_options(options) as detector:
            print("Camera opened. Reading frames; press Q or Esc to quit.", flush=True)
            while True:
                ok, frame = camera.read()
                if not ok:
                    raise RuntimeError("Cannot read webcam. Check connection and Windows camera permissions.")
                frame = cv2.flip(frame, 1)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                timestamp = max(last_timestamp + 1, time.monotonic_ns() // 1_000_000)
                last_timestamp = timestamp
                result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp)
                height, width = frame.shape[:2]
                for detection in result.detections:
                    box = detection.bounding_box
                    x, y = max(0, box.origin_x), max(0, box.origin_y)
                    right = min(width - 1, box.origin_x + box.width)
                    bottom = min(height - 1, box.origin_y + box.height)
                    cv2.rectangle(frame, (x, y), (right, bottom), (0, 255, 0), 2)
                    cv2.putText(frame, f"Face {detection.categories[0].score:.0%}",
                                (x, max(20, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                cv2.putText(frame, f"Faces: {len(result.detections)} | Q/Esc: quit",
                            (10, height - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                cv2.imshow(window, frame)
                if (cv2.waitKey(1) & 0xFF) in (ord("q"), ord("Q"), 27):
                    break
                if cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
                    break
    finally:
        camera.release()
        cv2.destroyAllWindows()

if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, ImportError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
