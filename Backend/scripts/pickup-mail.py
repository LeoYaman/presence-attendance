"""Local SMTP adapter. Reads private request data from stdin, never logs it."""
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage

def main():
    data = json.load(sys.stdin)
    message = EmailMessage()
    message['Subject'] = 'Presence demo: exit approval requested'
    message['From'] = os.environ['PICKUP_SMTP_FROM']
    message['To'] = data['recipient']
    message.set_content('Adult participant demo.\n' + data['reason'] + '\n\n'
                        'Open the link, sign in as the requesting operator, and approve explicitly:\n'
                        + data['url'] + '\n\nLink expires in 10 minutes; participants must remain visible.')
    if data.get('image') and data.get('box'):
        import base64
        import cv2
        import numpy as np
        frame = cv2.imdecode(np.frombuffer(base64.b64decode(data['image']), dtype=np.uint8), cv2.IMREAD_COLOR)
        height, width = frame.shape[:2]
        box = data['box']
        x, y = max(0, int(box['x']*width)), max(0, int(box['y']*height))
        x2, y2 = min(width, int((box['x']+box['width'])*width)), min(height, int((box['y']+box['height'])*height))
        crop = frame[y:y2, x:x2]
        if crop.size == 0:
            raise ValueError('Invalid face crop')
        ok, encoded = cv2.imencode('.jpg', crop)
        if not ok:
            raise ValueError('Could not encode face crop')
        message.add_attachment(encoded.tobytes(), maintype='image', subtype='jpeg', filename='anthony-demo-face.jpg')
    host = os.environ['PICKUP_SMTP_HOST']
    mode = os.environ.get('PICKUP_SMTP_MODE', 'starttls')
    if mode not in ('starttls', 'ssl'):
        raise ValueError('SMTP requires TLS')
    port = int(os.environ.get('PICKUP_SMTP_PORT', '465' if mode == 'ssl' else '587'))
    client = smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context()) if mode == 'ssl' else smtplib.SMTP(host, port, timeout=15)
    with client:
        if mode == 'starttls':
            client.ehlo()
            client.starttls(context=ssl.create_default_context())
            client.ehlo()
        if os.environ.get('PICKUP_SMTP_USER'):
            client.login(os.environ['PICKUP_SMTP_USER'], os.environ['PICKUP_SMTP_PASSWORD'])
        client.send_message(message)

if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
