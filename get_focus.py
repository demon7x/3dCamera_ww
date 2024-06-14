from picamera2 import Picamera2

def get_current_focus():
    picam2 = Picamera2()
    controls = picam2.camera_controls
    #focus_value = controls["LensPosition"]
    focus_value = controls
    return focus_value

if __name__ == "__main__":
    focus_value = get_current_focus()
    print(focus_value)

