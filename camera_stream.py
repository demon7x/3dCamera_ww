#!/usr/bin/env python3
"""MJPEG HTTP preview server for 3D scanner camera client.

Serves a multipart/x-mixed-replace MJPEG stream on http://<pi>:8888/ that
can be embedded directly in a browser <img> tag. Replaces the broken raw-TCP
version that wrote frames to stdout instead of the client socket.
"""
import argparse
import io
import json
import signal
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder
from picamera2.outputs import FileOutput


picam2 = None   # module-level so HTTP handlers can call set_controls on it


def apply_controls(payload):
    """Translate a flat dict of sensible keys into picamera2 Controls and apply.

    Returns the dict of controls actually applied.
    """
    if picam2 is None:
        return {}
    controls = {}

    def to_float(v):
        try: return float(v)
        except Exception: return None
    def to_int(v):
        try: return int(float(v))
        except Exception: return None

    # Auto-exposure toggle ('auto' | 'manual' | true/false)
    if 'ae' in payload:
        v = str(payload['ae']).lower()
        controls['AeEnable'] = v in ('1', 'true', 'on', 'auto', 'yes')
    if 'exposure' in payload:
        n = to_int(payload['exposure'])
        if n is not None: controls['ExposureTime'] = n
    if 'gain' in payload:
        v = to_float(payload['gain'])
        if v is not None: controls['AnalogueGain'] = v
    if 'awb' in payload:
        # 0 auto / 1 tungsten / 2 fluorescent / 3 indoor / 4 daylight / 5 cloudy
        n = to_int(payload['awb'])
        if n is not None:
            controls['AwbEnable'] = True
            controls['AwbMode'] = n
    if 'brightness' in payload:
        v = to_float(payload['brightness'])
        if v is not None: controls['Brightness'] = v
    if 'contrast' in payload:
        v = to_float(payload['contrast'])
        if v is not None: controls['Contrast'] = v
    if 'saturation' in payload:
        v = to_float(payload['saturation'])
        if v is not None: controls['Saturation'] = v
    if 'sharpness' in payload:
        v = to_float(payload['sharpness'])
        if v is not None: controls['Sharpness'] = v
    if 'focus' in payload:
        v = to_float(payload['focus'])
        if v is not None:
            controls['AfMode'] = 0          # manual
            controls['LensPosition'] = v

    if controls:
        try:
            picam2.set_controls(controls)
        except Exception as e:
            sys.stderr.write('[controls] set_controls error: %s (controls=%s)\n' % (e, controls))
    return controls


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

    def _send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path != '/controls':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
            raw = self.rfile.read(length).decode('utf-8') if length else ''
            if raw.lstrip().startswith('{'):
                payload = json.loads(raw)
            else:
                payload = dict(urllib.parse.parse_qsl(raw))
            applied = apply_controls(payload)
            body = json.dumps({'ok': True, 'applied': applied}).encode()
            self.send_response(200)
            self._send_cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            sys.stderr.write('[controls] POST error: %s\n' % e)
            self.send_error(500, str(e))

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
    picam2 = Picamera2()  # module-level, shared with apply_controls()
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
