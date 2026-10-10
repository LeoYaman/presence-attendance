# Webcam face detection
Draws boxes around faces. Confidence measures face detection, not identity.
No camera images are saved. Enrollment and attendance are later steps.

Run from the project root in PowerShell:

~~~powershell
python -m venv face_data/.venv
./face_data/.venv/Scripts/python.exe -m pip install -r face_data/requirements.txt
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py --download-model
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py
~~~

Press Q or Esc to stop. Try --camera 1 for another camera.
Close other camera apps and enable desktop camera access in Windows Settings.
The model download needs internet; detection then runs locally.
Google's short-range BlazeFace model is intended for nearby faces.

Documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector/python


## Team setup

Clone this GitHub repository and open a terminal in its root, then run the four
PowerShell commands above. Tested on Windows with Python 3.14. Each teammate
creates their own virtual environment and downloads the detection model.
The first model download and package installation need internet.

The standalone webcam script performs detection only. The dashboard worker now adds temporary identity matching and teacher-confirmed attendance (see below). Reference photos, student records, and local Python
and model files are excluded from Git. Keep consenting teammates' photos locally
in face_data/students/ with one folder per person.

Optional dataset preview:

~~~powershell
./face_data/.venv/Scripts/python.exe face_data/view_face.py "C:/path/to/photo.jpg"
~~~

## Dashboard integration

`recognition_worker.py` reuses this detector and adds OpenCV LBPH face comparison.
It receives browser JPEG frames from the authenticated Node API; it does not open
a second webcam. See the root README's **Frontend camera matching** section for
setup and registration. Use 64-bit Python; set `FACE_PYTHON` if the interpreter is
not `face_data/.venv`. Registration is temporary and requires five face samples.
Matches are suggestions confirmed by a teacher before attendance is saved.
The original standalone `webcam_faces.py` remains a detector only.

## ORL dataset import

`export_dataset.py` validates the bundled `att_faces.zip` using only the standard
library and emits original PGM bytes in a manifest without extracting files.
The Node importer stores the 40 anonymous subjects and 400 images in separate
`attendance.face_dataset_*` test tables. See the root README for the offline
import command. These archive subjects are not enrolled students, and importing
the archive does not add them to live camera matching.
