"""
LLM Auto-Confirm v1.1

Automatically clicks confirmation/approval buttons for LLM coding assistants
(Claude, Copilot, Cursor, etc.) in any IDE or application.
Uses OpenCV template matching to locate buttons on screen and clicks them.

Usage:
    1. Capture a button template:  python auto_confirm.py --capture
    2. Start auto-clicking:        python auto_confirm.py
    3. Stop monitoring:            Ctrl+C

    Options:
        --capture [NAME]   Capture a button template (default name: confirm)
        --confidence 0.85  Match confidence threshold
        --interval 0.5     Detection interval (seconds)
        --cooldown 2.0     Cooldown after each click (seconds)
        --list             List saved templates
"""

import argparse
import atexit
import os
import platform
import signal
import sys
import time
from datetime import datetime

# -- Dependency check and auto-install ------------------------------------

REQUIRED_PACKAGES = {
    "pyautogui": "pyautogui",
    "cv2": "opencv-python",
    "PIL": "Pillow",
    "numpy": "numpy",
}


def ensure_dependencies():
    missing = []
    for module, package in REQUIRED_PACKAGES.items():
        try:
            __import__(module)
        except ImportError:
            missing.append(package)
    if missing:
        print(f"[*] Installing dependencies: {', '.join(missing)}")
        os.system(f'"{sys.executable}" -m pip install {" ".join(missing)} -q')
        print("[+] Installation complete. Please re-run the script.")
        sys.exit(0)


ensure_dependencies()

import pyautogui
import cv2
import numpy as np
from PIL import Image, ImageGrab

# -- DPI awareness (Windows / macOS) --------------------------------------

if sys.platform == "win32":
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

# On macOS, Pillow's ImageGrab.grab() returns Retina-resolution images
# automatically, so no extra DPI setup is needed.

# -- Global configuration -------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(SCRIPT_DIR, "templates")

# Ensure the templates directory exists
os.makedirs(TEMPLATES_DIR, exist_ok=True)

# PyAutoGUI failsafe: move mouse to top-left corner to emergency-stop
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05

PID_FILE = os.path.join(SCRIPT_DIR, ".auto_confirm.pid")


# -- Instance detection ----------------------------------------------------


def _is_process_alive(pid):
    """Check if a process with the given PID is still running."""
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        SYNCHRONIZE = 0x00100000
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if handle:
            kernel32.CloseHandle(handle)
            return True
        return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def check_already_running():
    """Check if another instance is already running via PID file.
    Returns the existing PID if running, None otherwise."""
    if not os.path.exists(PID_FILE):
        return None
    try:
        with open(PID_FILE, "r") as f:
            old_pid = int(f.read().strip())
    except (ValueError, OSError):
        return None

    if old_pid == os.getpid():
        return None

    if _is_process_alive(old_pid):
        return old_pid

    # Stale PID file, clean up
    _remove_pid_file()
    return None


def _write_pid_file():
    """Write current PID to the lock file."""
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))


def _remove_pid_file():
    """Remove the PID file if it belongs to us."""
    try:
        if os.path.exists(PID_FILE):
            with open(PID_FILE, "r") as f:
                pid = int(f.read().strip())
            if pid == os.getpid():
                os.remove(PID_FILE)
    except (ValueError, OSError):
        pass


def _notify(title, message):
    """Show a desktop notification (best-effort, no error if unsupported)."""
    try:
        system = platform.system()
        if system == "Windows":
            # Use PowerShell toast notification
            ps_cmd = (
                f'[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, '
                f'ContentType = WindowsRuntime] > $null; '
                f'$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); '
                f'$text = $xml.GetElementsByTagName("text"); '
                f'$text[0].AppendChild($xml.CreateTextNode("{title} - {message}")) > $null; '
                f'$toast = [Windows.UI.Notifications.ToastNotification]::new($xml); '
                f'[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("LLM Auto-Confirm").Show($toast)'
            )
            os.system(f'powershell -Command "{ps_cmd}"')
        elif system == "Darwin":
            os.system(f'osascript -e \'display notification "{message}" with title "{title}"\'')
        else:
            os.system(f'notify-send "{title}" "{message}" 2>/dev/null')
    except Exception:
        pass


def _default_font():
    """Return a platform-appropriate font family for the tkinter UI."""
    system = platform.system()
    if system == "Darwin":
        return "Helvetica"
    elif system == "Windows":
        return "Segoe UI"
    else:
        return "Sans"


# -- Template capture mode -------------------------------------------------


def capture_template(name="confirm"):
    """Open a tkinter GUI for the user to select a button region and save it as a template image."""
    import tkinter as tk
    from PIL import ImageTk

    print("[*] Capturing screen...")
    time.sleep(0.5)
    screenshot = ImageGrab.grab()
    screen_w, screen_h = screenshot.size

    # Scale down to fit in a display window
    max_w, max_h = 1400, 850
    scale = min(1.0, max_w / screen_w, max_h / screen_h)
    display_w = int(screen_w * scale)
    display_h = int(screen_h * scale)
    display_img = screenshot.resize((display_w, display_h), Image.LANCZOS)

    state = {"start": None, "end": None, "rect": None, "saved": False}

    font_family = _default_font()

    root = tk.Tk()
    root.title(f"LLM Auto-Confirm - Select button region [{name}]")
    root.resizable(False, False)

    # Instructions
    tk.Label(
        root,
        text='Draw a rectangle around the button you want to auto-click, then press "Save Template"',
        font=(font_family, 11),
        pady=8,
    ).pack()

    # Canvas
    canvas = tk.Canvas(root, width=display_w, height=display_h, cursor="crosshair")
    canvas.pack()
    tk_img = ImageTk.PhotoImage(display_img)
    canvas.create_image(0, 0, anchor=tk.NW, image=tk_img)

    def on_press(e):
        state["start"] = (e.x, e.y)
        if state["rect"]:
            canvas.delete(state["rect"])

    def on_drag(e):
        if state["rect"]:
            canvas.delete(state["rect"])
        if state["start"]:
            state["rect"] = canvas.create_rectangle(
                state["start"][0],
                state["start"][1],
                e.x,
                e.y,
                outline="#ff3333",
                width=2,
                dash=(4, 2),
            )

    def on_release(e):
        state["end"] = (e.x, e.y)

    def clear_selection(e=None):
        """Clear the current selection rectangle."""
        if state["rect"]:
            canvas.delete(state["rect"])
        state["start"] = None
        state["end"] = None
        state["rect"] = None

    def save():
        if not state["start"] or not state["end"]:
            return

        # Map display coordinates back to actual screen coordinates
        x1 = int(min(state["start"][0], state["end"][0]) / scale)
        y1 = int(min(state["start"][1], state["end"][1]) / scale)
        x2 = int(max(state["start"][0], state["end"][0]) / scale)
        y2 = int(max(state["start"][1], state["end"][1]) / scale)

        if x2 - x1 < 5 or y2 - y1 < 5:
            print("[!] Selection too small, please try again.")
            return

        cropped = screenshot.crop((x1, y1, x2, y2))
        path = os.path.join(TEMPLATES_DIR, f"{name}.png")
        cropped.save(path)
        state["saved"] = True

        print(f"[+] Template saved: {path}")
        print(f"    Region: ({x1},{y1}) -> ({x2},{y2})")
        print(f"    Size:   {x2 - x1} x {y2 - y1} px")
        root.destroy()

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    canvas.bind("<ButtonRelease-1>", on_release)
    canvas.bind("<ButtonPress-3>", clear_selection)  # Right-click to clear

    # On macOS, right-click may be <ButtonPress-2> depending on config
    if sys.platform == "darwin":
        canvas.bind("<ButtonPress-2>", clear_selection)

    btn_frame = tk.Frame(root, pady=8)
    btn_frame.pack()
    tk.Button(
        btn_frame,
        text="Save Template",
        command=save,
        font=(font_family, 10),
        padx=15,
        pady=3,
    ).pack(side=tk.LEFT, padx=8)
    tk.Button(
        btn_frame,
        text="Clear",
        command=clear_selection,
        font=(font_family, 10),
        padx=15,
        pady=3,
    ).pack(side=tk.LEFT, padx=8)
    tk.Button(
        btn_frame,
        text="Cancel",
        command=root.destroy,
        font=(font_family, 10),
        padx=15,
        pady=3,
    ).pack(side=tk.LEFT, padx=8)

    root.mainloop()
    return state["saved"]


# -- Template loading and matching -----------------------------------------


def load_templates():
    """Load all .png templates from the templates/ directory."""
    if not os.path.isdir(TEMPLATES_DIR):
        return []

    templates = []
    for fname in sorted(os.listdir(TEMPLATES_DIR)):
        if fname.lower().endswith(".png"):
            path = os.path.join(TEMPLATES_DIR, fname)
            img = cv2.imread(path)
            if img is not None:
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                templates.append((fname, gray))
    return templates


def find_button(screenshot_gray, templates, confidence):
    """Find the best matching button location in a screenshot.

    Returns: (center_x, center_y, template_name, confidence) or None
    """
    best = None

    for name, tmpl in templates:
        th, tw = tmpl.shape

        # Skip if template is larger than the screenshot
        if th > screenshot_gray.shape[0] or tw > screenshot_gray.shape[1]:
            continue

        result = cv2.matchTemplate(screenshot_gray, tmpl, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)

        if max_val >= confidence and (best is None or max_val > best[3]):
            cx = max_loc[0] + tw // 2
            cy = max_loc[1] + th // 2
            best = (cx, cy, name, max_val)

    return best


# -- Monitor loop ----------------------------------------------------------


def monitor(confidence, interval, cooldown):
    """Continuously monitor the screen and auto-click when a matching button is found."""
    existing_pid = check_already_running()
    if existing_pid:
        print(f"[!] Another instance is already running (PID: {existing_pid}).")
        print(f"    To stop it: kill the process or press Ctrl+C in its terminal.")
        sys.exit(1)

    _write_pid_file()
    atexit.register(_remove_pid_file)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    templates = load_templates()

    if not templates:
        print("[!] No button templates found. You need to capture one first.")
        print("[*] A window will open for you to select the button region.")
        print()
        success = capture_template("confirm")
        if not success:
            print("[!] No template saved. Exiting.")
            sys.exit(1)
        templates = load_templates()
        if not templates:
            print("[!] Failed to load templates. Exiting.")
            sys.exit(1)
        print()

    names = ", ".join(n for n, _ in templates)
    print(f"[+] Loaded {len(templates)} template(s): {names}")
    print(f"    Confidence threshold: {confidence}")
    print(f"    Check interval:       {interval}s")
    print(f"    Click cooldown:       {cooldown}s")
    print(f"    Emergency stop:       Move mouse to top-left corner")
    print()
    print("[*] Monitoring... (Ctrl+C to stop)")
    print()

    click_count = 0
    last_click_time = 0.0

    try:
        while True:
            now = time.time()

            # Skip during cooldown period
            if now - last_click_time < cooldown:
                time.sleep(interval)
                continue

            # Capture screen and search for matches
            try:
                screenshot = np.array(ImageGrab.grab())
                screenshot_gray = cv2.cvtColor(screenshot, cv2.COLOR_RGB2GRAY)
                match = find_button(screenshot_gray, templates, confidence)
            except Exception as e:
                print(f"[!] Screenshot error: {e}")
                time.sleep(interval)
                continue

            if match:
                cx, cy, tname, conf = match

                # On macOS Retina displays, screen coordinates are half the pixel coordinates
                if sys.platform == "darwin":
                    cx, cy = cx // 2, cy // 2

                # Save mouse position, click, then restore
                orig_x, orig_y = pyautogui.position()
                pyautogui.click(cx, cy)
                pyautogui.moveTo(orig_x, orig_y)
                click_count += 1
                last_click_time = time.time()
                ts = datetime.now().strftime("%H:%M:%S")
                print(
                    f"    [{ts}] Clicked {tname} "
                    f"(confidence: {conf:.3f}, pos: {cx},{cy}) "
                    f"| total: {click_count}"
                )

            time.sleep(interval)

    except KeyboardInterrupt:
        print(f"\n[+] Stopped. Total clicks: {click_count}")
        _notify("LLM Auto-Confirm", f"Stopped. Total clicks: {click_count}")
    except pyautogui.FailSafeException:
        print(f"\n[!] Failsafe triggered (mouse at top-left corner). Total clicks: {click_count}")
        _notify("LLM Auto-Confirm", f"Failsafe triggered! Total clicks: {click_count}")


# -- CLI entry point -------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="LLM Auto-Confirm - Auto-click confirmation buttons for LLM coding assistants",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python auto_confirm.py --capture            Capture the default template
  python auto_confirm.py --capture allow      Capture a template named "allow"
  python auto_confirm.py                      Start monitoring with defaults
  python auto_confirm.py --confidence 0.8     Lower threshold (easier to match)
  python auto_confirm.py --interval 0.3       Check more frequently
  python auto_confirm.py --list               List saved templates
        """,
    )
    parser.add_argument(
        "--capture",
        "-c",
        nargs="?",
        const="confirm",
        default=None,
        metavar="NAME",
        help="Capture a button template (default name: confirm)",
    )
    parser.add_argument(
        "--confidence",
        type=float,
        default=0.85,
        help="Match confidence threshold (default: 0.85)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.5,
        help="Detection interval in seconds (default: 0.5)",
    )
    parser.add_argument(
        "--cooldown",
        type=float,
        default=2.0,
        help="Cooldown after each click in seconds (default: 2.0)",
    )
    parser.add_argument(
        "--list", "-l", action="store_true", help="List saved templates"
    )

    args = parser.parse_args()

    print("=" * 50)
    print("  LLM Auto-Confirm v1.1")
    print("=" * 50)
    print()

    if args.list:
        templates = load_templates()
        if templates:
            print(f"[*] Saved templates ({TEMPLATES_DIR}):")
            for name, tmpl in templates:
                print(f"    - {name} ({tmpl.shape[1]}x{tmpl.shape[0]} px)")
        else:
            print("[*] No templates found. Run --capture to create one.")
        return

    if args.capture is not None:
        success = capture_template(args.capture)
        if success:
            print()
            print("[*] Template captured! You can now start monitoring:")
            print(f"    python {os.path.basename(__file__)}")
    else:
        monitor(args.confidence, args.interval, args.cooldown)


if __name__ == "__main__":
    main()
