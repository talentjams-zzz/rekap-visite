"""Shared test infrastructure for the Rekap Visite Playwright tests.

Every test file is a top-level script (no test functions) that drives the app
through a real browser, and its code runs at module IMPORT time (during pytest
collection). So the app server must already be up before the first test module
is imported. conftest.py is imported by pytest before any test module in this
directory, so we start `server.js` here at import time on port 8765, with an
isolated DATA_FILE so the tests never touch the real master_data.json.

Usage in a test file:
    from conftest import BASE, DATA   # BASE = http://localhost:8765

Run:  python3 -m pytest test_*.py -v
"""
import atexit
import os
import socket
import subprocess
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8765
BASE = f"http://localhost:{PORT}"
DATA = os.path.join(HERE, "data")


def _port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _start_server():
    """Start server.js on :8765 with a throwaway data file. Returns the Popen or None."""
    if _port_open(PORT):
        # Something is already serving the app on the test port — use it as-is.
        return None

    data_file = os.path.join(tempfile.mkdtemp(prefix="rekap-test-"), "master_data.json")
    env = dict(os.environ, DATA_FILE=data_file)
    proc = subprocess.Popen(
        ["node", "server.js", str(PORT)],
        cwd=HERE,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        if _port_open(PORT):
            return proc
        if proc.poll() is not None:
            raise RuntimeError("server.js exited early during test setup")
        time.sleep(0.1)
    raise RuntimeError(f"server.js did not open port {PORT} in time")


def _stop_server(proc):
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


# Start the server now (at conftest import time) and stop it when the process exits.
_server_proc = _start_server()
atexit.register(_stop_server, _server_proc)
