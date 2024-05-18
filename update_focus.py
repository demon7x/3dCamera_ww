import sys
from picamera2 import Picamera2

def update_focus(focus_value):
    picam2 = Picamera2()
    picam2.start()
    controls = {"AfMode": 1, "AfTrigger": 0, "LensPosition": float(focus_value)}  # Assuming manual focus control is supported
    picam2.set_controls(controls)
    picam2.stop()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 update_focus.py <focus_value>")
        sys.exit(1)
    
    focus_value = sys.argv[1]
    update_focus(focus_value)
