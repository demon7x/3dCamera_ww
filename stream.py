import socketio
import time
import base64
import cv2
from picamera2 import Picamera2
import socket
import fcntl
import struct

# 서버 주소 (app.js와 동일하게 설정)
socketServer = 'http://192.168.0.16:8080'
sio = socketio.Client()

camera = Picamera2()
camera.configure(camera.create_video_configuration(main={"size": (640, 480)}))
camera.start()

def get_ip_address(ifname):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    return socket.inet_ntoa(fcntl.ioctl(
        s.fileno(),
        0x8915,  # SIOCGIFADDR
        struct.pack('256s', ifname[:15].encode('utf-8'))
    )[20:24])

ip_address = get_ip_address('wlan0')  # 'wlan0'은 무선 네트워크 인터페이스 이름입니다. 필요에 따라 'eth0' 등으로 변경하세요.

@sio.event
def connect():
    print('Connected to server')
    sio.emit('camera-online', {'name': 'Camera1', 'ipAddress': ip_address})

@sio.event
def disconnect():
    print('Disconnected from server')

@sio.event
def preview(data):
    print('Starting preview...')
    client_socket_id = data['clientSocketId']
    while True:
        frame = camera.capture_array()
        _, buffer = cv2.imencode('.jpg', frame)
        jpg_as_text = base64.b64encode(buffer).decode('utf-8')
        sio.emit('camera-stream', {'clientSocketId': client_socket_id, 'stream': jpg_as_text})
        time.sleep(0.1)  # 10 fps

if __name__ == '__main__':
    sio.connect(socketServer)
    sio.wait()
