# Webcam face detection and team recognition

Windows prototype tested with Python 3.14. Camera images and attendance are not
recorded. Photos and students.json stay local and are excluded from Git.

## Setup

Run from the project root in PowerShell:

~~~powershell
python -m venv face_data/.venv
./face_data/.venv/Scripts/python.exe -m pip install -r face_data/requirements.txt
~~~

## Recognition

Put one consenting teammate's reference photo per person in face_data/people_faces/.
JPG, PNG and PGM are supported. Create face_data/students.json like this:

~~~json
{
  "students": [
    {
      "id": "team01",
      "name": "Example Name",
      "photo": "people_faces/example.jpg",
      "kind": "team"
    }
  ]
}
~~~

Paths are relative to students.json. IDs must be unique. Each reference must have
exactly one detectable face. Team members are enrolled by default; --include-samples
also includes sample entries.

~~~powershell
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py --download-recognition-models
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py --check-enrollment
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py --recognize
~~~

Recognition uses OpenCV YuNet to detect and align faces, then SFace to compare
embeddings. MediaPipe is used only in the original detection mode below.
Green labels indicate candidate identity matches; orange labels show Unknown.
Similarity scores are not probabilities. Defaults require cosine similarity of
at least 0.45 and a gap of 0.06 above the next-best person. These are initial
prototype settings; validate with new live frames and an unenrolled person.
Use --threshold and --margin to adjust after testing. Enrollment self-checks
only validate loading and distinguishability of references, not live accuracy.
No attendance decisions are made. Review errors before adding attendance.

## MediaPipe detection preview

~~~powershell
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py --download-model
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py
~~~

Press Q or Esc to quit. Try --camera 1 for another camera. Close other camera
apps and enable desktop camera access in Windows Settings if opening fails.
Downloads need internet; subsequent processing is local.

Optional photo preview:

~~~powershell
./face_data/.venv/Scripts/python.exe face_data/view_face.py "C:/path/to/photo.jpg"
~~~

References:
- https://docs.opencv.org/4.x/d0/dd4/tutorial_dnn_face.html
- https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface
- https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector/python
