from pathlib import Path
import cv2
root = Path(__file__).resolve().parents[1]
(root / '.tmp').mkdir(exist_ok=True)
image = cv2.imread(str(root / 'face_data/people_faces/WIN_20261010_00_52_47_Pro.jpg'))
if image is None:
    raise RuntimeError('Olivia reference unavailable')
height, width = image.shape[:2]
scale = min(640 / width, 480 / height)
scaled = cv2.resize(image, (round(width * scale), round(height * scale)))
canvas = cv2.copyMakeBorder(scaled, (480-scaled.shape[0])//2, (480-scaled.shape[0]+1)//2,
                           (640-scaled.shape[1])//2, (640-scaled.shape[1]+1)//2,
                           cv2.BORDER_CONSTANT, value=(32,32,32))
yuv = cv2.cvtColor(canvas, cv2.COLOR_BGR2YUV_I420)
with (root / '.tmp/olivia-controlled.y4m').open('wb') as out:
    out.write(b'YUV4MPEG2 W640 H480 F5:1 Ip A1:1 C420jpeg\n')
    for _ in range(100):
        out.write(b'FRAME\n')
        out.write(yuv.tobytes())
print('Controlled Olivia camera fixture created')
