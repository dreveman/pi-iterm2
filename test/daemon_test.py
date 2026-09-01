#!/usr/bin/env python3
"""Platform-local tests for the companion daemon's report and IPC helpers."""

import asyncio
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
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

shell_spec = importlib.util.spec_from_file_location(
    "pi_iterm2_tab_color", Path(__file__).parents[1] / "shell" / "tab_color.py"
)
shell_color = importlib.util.module_from_spec(shell_spec)
shell_spec.loader.exec_module(shell_color)


class FakeSession:
    session_id = "GUID"

    async def async_get_variable(self, name):
        return {
            "hostname": "host",
            "user.pi_cwd": "/cwd",
            "user.pi_session": "pi-id",
            "user.pi_status": "idle",
            "user.pi_host_color": "#010203",
        }[name]


class HostileSession:
    """Session variables carrying escape sequences. Any process that can write to a
    terminal can set these with OSC 1337;SetUserVar, so they are attacker-controlled."""

    session_id = "EVIL"

    async def async_get_variable(self, name):
        return {
            "hostname": "host\x1b]0;pwned\x07",
            "user.pi_cwd": "/cwd\x1b[2J\x1b[H",
            "user.pi_session": "id\x1b]52;c;cHduZWQ=\x07",
            "user.pi_status": "idle\r\nfake prompt $ ",
            "user.pi_host_color": "#010203",
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
            assert "hostname:   \x1b[38;2;1;2;3mhost\x1b[39m" in response["output"]
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
            # Hostile session variables must not reach the report, which is written
            # straight to a terminal.
            hostile = await daemon.read_session_vars(HostileSession())
            assert hostile["hostname"] == "host]0;pwned"
            assert hostile["cwd"] == "/cwd[2J[H"
            assert hostile["pi_session"] == "id]52;c;cHduZWQ="
            assert hostile["pi_status"] == "idlefake prompt $ "
            for value in hostile.values():
                assert "\x1b" not in value and "\x07" not in value

            report = daemon.format_session_report("EVIL", hostile, None)
            assert "\x1b]" not in report
            summary = daemon.format_session_line("EVIL", hostile)
            assert "\x1b]" not in summary
        finally:
            server.close()
            await server.wait_closed()
            lock.close()


assert daemon.resolve_session_id("w0t0p0:GUID") == "GUID"
assert daemon.resolve_session_id("GUID") == "GUID"
assert daemon.resolve_session_id(None) is None
assert daemon.colored_hostname("host", "#010203") == "\x1b[38;2;1;2;3mhost\x1b[39m"
assert daemon.colored_hostname("host", "invalid") == "host"

# Control bytes are stripped and the length is capped; unset stays unset.
assert daemon.sanitize_text("a\x1b[2Jb\x00c\x7f") == "a[2Jbc"
assert daemon.sanitize_text("a\r\nb") == "ab"
assert daemon.sanitize_text("plain/path") == "plain/path"
assert daemon.sanitize_text(None) is None
assert daemon.sanitize_text("") == ""
assert len(daemon.sanitize_text("x" * 1000)) == daemon.MAX_FIELD_LENGTH
assert daemon.sanitize_text("x" * 10, limit=4) == "xxxx"

# A record written by an older build, or edited by hand, is replayed straight into a
# terminal, so it has to be cleaned on the way out as well as on the way in.
poisoned = daemon.build_reminder_line(
    {
        "hostname": "host\x1b]0;pwned\x07",
        "cwd": "/cwd\x1b[2J",
        "piSessionId": "id\x1b]52;c;cHduZWQ=\x07",
        "status": "idle\r\n$ ",
        "hostColor": "#010203",
        "updatedAt": time.time(),
    }
)
# The only escapes left are the ones this line builds itself: dim, the host color, and
# the trailing CRLFs.
assert "\x1b]" not in poisoned
assert "\x1b[2J" not in poisoned
assert poisoned.count("\r\n") == 2
assert "pwned" in poisoned  # the text survives; only the control bytes are removed

# An empty field after sanitizing still reads as unknown rather than blank.
assert "was ? (?)" in daemon.build_reminder_line(
    {"piSessionId": "\x1b", "status": "\x00", "cwd": "/c", "updatedAt": time.time()}
)
# Golden vector for JS Math.round compatibility (Python round would make green 76).
assert shell_color.hsl_to_rgb(30, 45, 30) == (111, 77, 42)
reminder = daemon.build_reminder_line(
    {
        "hostname": "host",
        "hostColor": "#010203",
        "cwd": "/cwd",
        "piSessionId": "pi-id",
        "status": "idle",
        "updatedAt": daemon.time.time(),
    }
)
assert "\x1b[22;38;2;1;2;3mhost\x1b[2;39m /cwd" in reminder
asyncio.run(run_async_tests())

with tempfile.TemporaryDirectory(prefix="pi-iterm2-shell-test-") as home:
    environment = os.environ.copy()
    environment["HOME"] = home
    shell_check = subprocess.check_output(
        [
            sys.executable,
            str(Path(__file__).parents[1] / "shell" / "tab_color.py"),
            "--check",
        ],
        env=environment,
        text=True,
    )
    assert re.search(r"host:\s+\x1b\[38;2;\d+;\d+;\d+m.+\x1b\[39m", shell_check)

print("ok - daemon and shell checks color hostnames and strip control bytes")
