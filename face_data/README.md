# Webcam face detection and team recognition

Windows prototype tested with Python 3.14. Camera images and attendance are not
recorded. The shared demo includes reference photos and students.json. Python environments and downloaded models are excluded from Git.

## Setup

Run from the project root in PowerShell:

~~~powershell
python -m venv face_data/.venv
./face_data/.venv/Scripts/python.exe -m pip install -r face_data/requirements.txt
~~~

## Recognition

The four teammates are already configured in the included students.json. To add another consenting person, put their reference photo in face_data/people_faces/.
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

## Dashboard integration

`recognition_worker.py` reuses this detector and adds OpenCV LBPH face comparison.
It receives browser JPEG frames from the authenticated Node API; it does not open
a second webcam. See the root README's **Frontend camera matching** section for
setup and registration. Use 64-bit Python; set `FACE_PYTHON` if the interpreter is
not `face_data/.venv`. Registration is temporary and requires five face samples.
Matches are suggestions confirmed by a teacher before attendance is saved.
The standalone `webcam_faces.py` also supports the YuNet/SFace recognition mode documented above; it does not save attendance.

## ORL dataset import

`export_dataset.py` validates the bundled `att_faces.zip` using only the standard
library and emits original PGM bytes in a manifest without extracting files.
The Node importer stores the 40 anonymous subjects and 400 images in separate
`attendance.face_dataset_*` test tables. See the root README for the offline
import command. These archive subjects are not enrolled students, and importing
the archive does not add them to live camera matching.
