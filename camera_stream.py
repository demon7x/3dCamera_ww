#!/usr/bin/env python3
"""MJPEG HTTP preview server for 3D scanner camera client.

Serves a multipart/x-mixed-replace MJPEG stream on http://<pi>:8888/ that
can be embedded directly in a browser <img> tag. Replaces the broken raw-TCP
version that wrote frames to stdout instead of the client socket.
"""
import io
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder
from picamera2.outputs import FileOutput


class StreamingOutput(io.BufferedIOBase):
    """File-like sink for the MJPEG encoder. picamera2's FileOutput
    validates ``isinstance(file, io.BufferedIOBase)`` so the subclass is
    mandatory — a plain class with .write() is rejected."""

    def __init__(self):
        super().__init__()
        self.frame = None
        self.condition = threading.Condition()

    def writable(self):
        return True

    def write(self, buf):
        with self.condition:
            self.frame = bytes(buf)
            self.condition.notify_all()
        return len(buf)


class StreamingHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[preview http] %s\n" % (fmt % args))

    def do_GET(self):
        if self.path not in ('/', '/stream', '/stream.mjpg'):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Age', '0')
        self.send_header('Cache-Control', 'no-cache, private')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=FRAME')
        self.end_headers()
        try:
            while True:
                with output.condition:
                    output.condition.wait(timeout=2)
                    frame = output.frame
                if not frame:
                    continue
                self.wfile.write(b'--FRAME\r\n')
                self.wfile.write(b'Content-Type: image/jpeg\r\n')
                self.wfile.write(('Content-Length: %d\r\n\r\n' % len(frame)).encode())
                self.wfile.write(frame)
                self.wfile.write(b'\r\n')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            sys.stderr.write("[preview http] client loop error: %s\n" % e)


class StreamingServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    output = StreamingOutput()
    picam2 = Picamera2()
    picam2.configure(picam2.create_video_configuration(main={"size": (640, 480)}))
    picam2.start_recording(MJPEGEncoder(), FileOutput(output))

    # Announce readiness so the Node client can forward the URL to the browser.
    # The Node side greps for this line on stdout.
    print('MJPEG preview server listening on 0.0.0.0:8888', flush=True)

    try:
        server = StreamingServer(('0.0.0.0', 8888), StreamingHandler)
        server.serve_forever()
    finally:
        picam2.stop_recording()
