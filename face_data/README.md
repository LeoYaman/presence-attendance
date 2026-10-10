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

Only face detection is implemented so far; there is no student identity matching
or attendance logging yet. Reference photos, student records, and local Python
and model files are excluded from Git. Keep consenting teammates' photos locally
in face_data/students/ with one folder per person.

Optional dataset preview:

~~~powershell
./face_data/.venv/Scripts/python.exe face_data/view_face.py "C:/path/to/photo.jpg"
~~~
