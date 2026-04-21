#!/usr/bin/env python3
"""MJPEG HTTP preview server for 3D scanner camera client.

Serves a multipart/x-mixed-replace MJPEG stream on http://<pi>:8888/ that
can be embedded directly in a browser <img> tag. Replaces the broken raw-TCP
version that wrote frames to stdout instead of the client socket.
"""
import argparse
import io
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder
from picamera2.outputs import FileOutput


def parse_args():
    p = argparse.ArgumentParser(description='MJPEG preview server')
    p.add_argument('--width', type=int, default=1280)
    p.add_argument('--height', type=int, default=720)
    p.add_argument('--quality', type=int, default=85,
                   help='MJPEG quality 1-100 (higher = better but larger)')
    p.add_argument('--port', type=int, default=8888)
    return p.parse_args()


def _handle_sigterm(signum, frame):
    # Raise SystemExit so the 'finally' block gets to call stop_recording()
    # and release the camera for the next preview session.
    sys.stderr.write('[preview] SIGTERM received, shutting down\n')
    raise SystemExit(0)


signal.signal(signal.SIGTERM, _handle_sigterm)


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
        # Strip query string so cache-busters like "?t=1234" still match
        path = self.path.split('?', 1)[0]
        if path not in ('/', '/stream', '/stream.mjpg'):
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
    cli = parse_args()
    output = StreamingOutput()
    picam2 = Picamera2()
    picam2.configure(picam2.create_video_configuration(main={"size": (cli.width, cli.height)}))

    encoder = MJPEGEncoder()
    try:
        encoder.q = int(cli.quality)   # some picamera2 versions support this attr
    except Exception:
        pass

    picam2.start_recording(encoder, FileOutput(output))

    # Announce readiness so the Node client can forward the URL to the browser.
    # The Node side greps for this line on stdout.
    print('MJPEG preview server listening on 0.0.0.0:%d (%dx%d q=%d)' % (cli.port, cli.width, cli.height, cli.quality), flush=True)

    try:
        server = StreamingServer(('0.0.0.0', cli.port), StreamingHandler)
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        try:
            picam2.stop_recording()
        except Exception as e:
            sys.stderr.write('[preview] stop_recording error: %s\n' % e)
        try:
            picam2.close()
        except Exception:
            pass
        sys.stderr.write('[preview] shutdown complete\n')
