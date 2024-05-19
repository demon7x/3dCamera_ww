from picamera2 import Picamera2, MjpegEncoder
from picamera2.outputs import FileOutput
import socket
import threading

def start_camera_stream():
    picam2 = Picamera2()
    video_config = picam2.create_video_configuration(main={"size": (640, 480)})
    picam2.configure(video_config)
    output = FileOutput(output_file="/dev/stdout", format="mjpeg")
    encoder = MjpegEncoder(picam2, output=output)
    picam2.start_encoder(encoder)
    picam2.start()
    return picam2

def handle_client_connection(client_socket):
    picam2 = start_camera_stream()
    try:
        while True:
            data = client_socket.recv(1024)
            if not data:
                break
    finally:
        picam2.stop()
        client_socket.close()

def start_server():
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.bind(('0.0.0.0', 8888))
    server_socket.listen(1)
    print('Server started on port 8888')

    while True:
        client_socket, addr = server_socket.accept()
        print(f'Accepted connection from {addr}')
        client_handler = threading.Thread(target=handle_client_connection, args=(client_socket,))
        client_handler.start()

if __name__ == "__main__":
    start_server()
