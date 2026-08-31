#!/usr/bin/env python3
"""Platform-local tests for the companion daemon's report and IPC helpers."""

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

# The helper tests do not need a real iTerm2 installation. Supply the module before
# loading the daemon, then replace async_get_app with a fake below.
sys.modules.setdefault("iterm2", types.ModuleType("iterm2"))
spec = importlib.util.spec_from_file_location(
    "pi_iterm2_daemon", Path(__file__).parents[1] / "macos" / "pi_iterm2_daemon.py"
)
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)


class FakeSession:
    session_id = "GUID"

    async def async_get_variable(self, name):
        return {
            "hostname": "host",
            "user.pi_cwd": "/cwd",
            "user.pi_session": "pi-id",
            "user.pi_status": "idle",
        }[name]


class FakeApp:
    windows = []
    buried_sessions = []

    def get_session_by_id(self, session_id):
        return FakeSession() if session_id == "GUID" else None


async def fake_get_app(_connection):
    return FakeApp()


async def request(socket_path, value):
    reader, writer = await asyncio.open_unix_connection(socket_path)
    writer.write((json.dumps(value) + "\n").encode("utf-8"))
    await writer.drain()
    response = json.loads(await reader.readline())
    writer.close()
    await writer.wait_closed()
    return response


async def run_async_tests():
    daemon.iterm2.async_get_app = fake_get_app
    with tempfile.TemporaryDirectory(prefix="pi-iterm2-test-") as directory:
        root = Path(directory) / "state"
        daemon.STATE_PATH = root / "state.json"
        daemon.SOCKET_PATH = root / "daemon.sock"
        daemon.LOCK_PATH = root / "daemon.lock"

        lock = daemon.acquire_daemon_lock()
        assert lock is not None
        assert daemon.acquire_daemon_lock(timeout=0) is None
        assert (root.stat().st_mode & 0o777) == 0o700

        control = await daemon.start_control_server(object(), asyncio.Lock())
        assert control is not None
        server, _identity = control
        try:
            assert (daemon.SOCKET_PATH.stat().st_mode & 0o777) == 0o600
            response = await request(
                daemon.SOCKET_PATH,
                {"version": 1, "command": "check", "sessionId": "w0t0p0:GUID"},
            )
            assert response["ok"] is True
            assert "session id: GUID" in response["output"]
            assert "cwd:        /cwd" in response["output"]

            response = await request(
                daemon.SOCKET_PATH,
                {"version": True, "command": "check", "sessionId": "GUID"},
            )
            assert response["ok"] is False
            assert "protocol" in response["error"].lower()

            response = await request(
                daemon.SOCKET_PATH,
                {"version": 1, "command": "check", "sessionId": None},
            )
            assert response["ok"] is False
            assert "No session id" in response["error"]
        finally:
            server.close()
            await server.wait_closed()
            lock.close()


assert daemon.resolve_session_id("w0t0p0:GUID") == "GUID"
assert daemon.resolve_session_id("GUID") == "GUID"
assert daemon.resolve_session_id(None) is None
asyncio.run(run_async_tests())
print("ok - daemon report IPC, permissions, validation, and singleton lock")
