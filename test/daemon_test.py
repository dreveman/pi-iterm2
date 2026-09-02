#!/usr/bin/env python3
"""Platform-local tests for the companion daemon's report and IPC helpers."""

import asyncio
import contextlib
import importlib.util
import io
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


class FakeSession:
    session_id = "GUID"

    def __init__(self):
        self.variables = {
            "hostname": "host",
            "username": "alice",
            "path": "/shell-cwd",
            "user.pi_cwd": "/cwd",
            # Deliberately nonempty: iTerm2 restores this stale value after a force quit.
            "user.pi_session": "friendly-name",
            "user.pi_session_id": "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
            "user.pi_instance": "instance-old",
            "user.pi_status": "idle",
            "user.pi_host_color": "#010203",
        }

    async def async_get_variable(self, name):
        return self.variables.get(name, "")


class HostileSession:
    """Session variables carrying escape sequences. Any process that can write to a
    terminal can set these with OSC 1337;SetUserVar, so they are attacker-controlled."""

    session_id = "EVIL"

    async def async_get_variable(self, name):
        return {
            "hostname": "host\x1b]0;pwned\x07",
            "username": "user\x1b]0;pwned\x07",
            "path": "/shell\x1b[2J",
            "user.pi_cwd": "/cwd\x1b[2J\x1b[H",
            "user.pi_session": "name\x1b]52;c;cHduZWQ=\x07",
            "user.pi_session_id": "01a05d77-6025-7a5f-9fa2-7f313c3c8992\x1b",
            "user.pi_instance": "instance\x1b]0;pwned\x07",
            "user.pi_status": "idle\r\nfake prompt $ ",
            "user.pi_host_color": "#010203",
        }[name]


class FakeApp:
    windows = []
    buried_sessions = []

    def __init__(self):
        self.variables = {}

    def get_session_by_id(self, session_id):
        return FakeSession() if session_id == "GUID" else None

    async def async_get_variable(self, name):
        return self.variables.get(name, "")

    async def async_set_variable(self, name, value):
        self.variables[name] = value


async def fake_get_app(_connection):
    return FakeApp()


async def run_async_tests():
    daemon.iterm2 = sys.modules["iterm2"]
    daemon.iterm2.async_get_app = fake_get_app

    shell_session = FakeSession()
    shell_session.variables["user.pi_cwd"] = ""
    assert (await daemon.read_session_vars(shell_session))["cwd"] == "/shell-cwd"

    with tempfile.TemporaryDirectory(prefix="pi-iterm2-test-") as directory:
        root = Path(directory) / "state"
        daemon.STATE_PATH = root / "state.json"
        daemon.PREVIOUS_STATE_PATH = root / "state.previous.json"
        daemon.LOCK_PATH = root / "daemon.lock"
        daemon.RECORD_INDEX_PATH = root / "record-ids"

        lock = daemon.acquire_daemon_lock()
        assert lock is not None
        assert daemon.acquire_daemon_lock(timeout=0) is None
        assert (root.stat().st_mode & 0o777) == 0o700

        # The first daemon in an iTerm2 app launch rotates the completed state. A daemon
        # restart in that same app must neither rotate again nor lose the recovery copy.
        prior = {
            "hostname": "remote.example.com",
            "username": "alice",
            "cwd": "/old-cwd",
            "piSessionId": "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
            "piSessionIdExact": True,
            "piSessionName": "friendly-name",
            "piInstance": "instance-old",
            "status": "idle",
            "hostColor": "#010203",
            "updatedAt": time.time(),
        }
        daemon.STATE_PATH.write_text(json.dumps({"GUID": prior}))
        app = FakeApp()
        recovery = await daemon.prepare_recovery_state(app)
        assert recovery == {"GUID": prior}
        assert not daemon.STATE_PATH.exists()
        assert daemon.load_state(daemon.PREVIOUS_STATE_PATH) == recovery
        assert daemon.RECORD_INDEX_PATH.read_text() == "GUID\n"

        daemon.STATE_PATH.write_text(json.dumps({"CURRENT": {"cwd": "/new"}}))
        repeated_recovery = await daemon.prepare_recovery_state(app)
        assert repeated_recovery == recovery
        assert daemon.load_state() == {"CURRENT": {"cwd": "/new"}}
        assert daemon.load_report_state() == {
            "GUID": prior,
            "CURRENT": {"cwd": "/new"},
        }

        # A later app launch merges partial current state into the recovery snapshot,
        # retaining tabs that were not resumed during the intervening launch.
        old_x = {**prior, "cwd": "/old-x", "updatedAt": 1}
        old_y = {**prior, "cwd": "/old-y", "updatedAt": 2}
        new_x = {**prior, "cwd": "/new-x", "updatedAt": 3}
        daemon.write_state(daemon.PREVIOUS_STATE_PATH, {"X": old_x, "Y": old_y})
        daemon.write_state(daemon.STATE_PATH, {"X": new_x})
        daemon.rotate_state_for_new_app_run()
        assert daemon.load_state(daemon.PREVIOUS_STATE_PATH) == {
            "X": new_x,
            "Y": old_y,
        }
        assert not daemon.STATE_PATH.exists()

        daemon.write_state(daemon.PREVIOUS_STATE_PATH, recovery)
        daemon.write_state(daemon.STATE_PATH, {"CURRENT": {"cwd": "/new"}})
        daemon.sync_record_index()

        # A restored stale user.pi_session must not suppress the recovery reminder.
        # The shell helper reads state directly before or after startup rotation.
        assert daemon.latest_record_for_session("w0t0p0:GUID") == prior
        previous_session_id = os.environ.get("ITERM_SESSION_ID")
        os.environ["ITERM_SESSION_ID"] = "w0t0p0:GUID"
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                assert daemon.emit_pending_replay() == 0
        finally:
            if previous_session_id is None:
                os.environ.pop("ITERM_SESSION_ID", None)
            else:
                os.environ["ITERM_SESSION_ID"] = previous_session_id
        rendered = output.getvalue()
        assert "Last Pi session in this tab was friendly-name" in rendered
        expected_remote = daemon.build_resume_command(prior)
        assert expected_remote is not None and expected_remote in rendered
        assert rendered.endswith("\n\n")
        assert "pi-iterm2:" not in rendered

        # If startup rotation has not happened yet, state.json still holds the newest
        # record; after rotation the same lookup falls back to state.previous.json.
        current_state = daemon.load_state()
        newer = {**prior, "cwd": "/newer-cwd", "updatedAt": time.time() + 1}
        daemon.STATE_PATH.write_text(json.dumps({"GUID": newer}))
        assert daemon.latest_record_for_session("GUID") == newer
        daemon.STATE_PATH.write_text(json.dumps(current_state))

        report = daemon.build_check_report("w0t0p0:GUID")
        assert "session id: GUID" in report
        assert "friendly-name" in report
        assert "Reminder preview:" in report
        assert "stored record (current):" in daemon.format_record_report(
            "GUID", prior, current=True
        )
        try:
            daemon.build_check_report(None)
            assert False, "missing session id must fail"
        except ValueError:
            pass
        assert "Stored records" in daemon.build_check_all_report()

        hostile = await daemon.read_session_vars(HostileSession())
        assert hostile["hostname"] == "host]0;pwned"
        assert hostile["username"] == "user]0;pwned"
        assert hostile["cwd"] == "/cwd[2J[H"
        assert hostile["pi_session"] == "name]52;c;cHduZWQ="
        assert hostile["pi_session_id"] == "01a05d77-6025-7a5f-9fa2-7f313c3c8992"
        assert hostile["pi_instance"] == "instance]0;pwned"
        assert hostile["pi_status"] == "idlefake prompt $ "
        for value in hostile.values():
            assert "\x1b" not in value and "\x07" not in value

        lock.close()


assert daemon.resolve_session_id("w0t0p0:GUID") == "GUID"
assert daemon.resolve_session_id("GUID") == "GUID"
assert daemon.resolve_session_id(None) is None
assert daemon.colored_hostname("host", "#010203") == "\x1b[38;2;1;2;3mhost\x1b[39m"
assert daemon.colored_hostname("host", "invalid") == "host"
assert daemon.is_local_hostname("workstation.local", "workstation.local")
assert daemon.is_local_hostname("WORKSTATION.LOCAL.", "workstation.local")
assert daemon.is_local_hostname("localhost", "workstation.local")
assert not daemon.is_local_hostname("workstation", "workstation.local")
assert not daemon.is_local_hostname("workstation.example.com", "workstation.local")

resume_command = daemon.build_resume_command(
    {
        "hostname": "example.com",
        "username": "alice",
        "cwd": "/work/it's here",
        "piSessionId": "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
    },
    local_hostname="workstation.local",
)
assert resume_command is not None
outer_command = daemon.shlex.split(resume_command)
inner_command = "cd -- '/work/it'\"'\"'s here' && exec pi --session 01a05d77-6025-7a5f-9fa2-7f313c3c8992"
assert outer_command == daemon.build_remote_launch_argv(
    "example.com", "alice", inner_command
)
remote_index = outer_command.index(inner_command)
assert daemon.shlex.split(outer_command[remote_index]) == [
    "cd",
    "--",
    "/work/it's here",
    "&&",
    "exec",
    "pi",
    "--session",
    "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
]
# The launcher hook owns the whole argv, so a flag-style launcher that addresses
# hosts without a username works without touching build_resume_command.
original_launch_argv = daemon.build_remote_launch_argv
try:
    daemon.build_remote_launch_argv = lambda host, user, remote_command: [
        "remote-launcher",
        "--host",
        host,
        "--command",
        remote_command,
    ]
    overridden = daemon.build_resume_command(
        {
            "hostname": "example.com",
            "username": "alice",
            "cwd": "/work",
            "piSessionId": "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
        },
        local_hostname="workstation.local",
    )
    assert overridden is not None
    assert daemon.shlex.split(overridden) == [
        "remote-launcher",
        "--host",
        "example.com",
        "--command",
        "cd -- /work && exec pi --session 01a05d77-6025-7a5f-9fa2-7f313c3c8992",
    ]
finally:
    daemon.build_remote_launch_argv = original_launch_argv

local_command = daemon.build_resume_command(
    {
        "hostname": "workstation.local",
        "username": "alice",
        "cwd": "/work/it's here",
        "piSessionId": "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
    },
    local_hostname="workstation.local",
)
assert local_command is not None
assert daemon.shlex.split(local_command) == [
    "cd",
    "--",
    "/work/it's here",
    "&&",
    "exec",
    "pi",
    "--session",
    "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
]

assert daemon.build_resume_command({"hostname": "host"}) is None
shell_command = daemon.build_resume_command(
    {"hostname": "host", "cwd": "/cwd", "piSessionId": "friendly-name"},
    local_hostname="workstation.local",
)
assert shell_command is not None
assert (
    daemon.shlex.split(shell_command)[-1] == 'cd -- /cwd && exec "${SHELL:-/bin/sh}" -l'
)
with tempfile.TemporaryDirectory(prefix="pi-iterm2-prompt-test-") as config_home:
    original_config_path = daemon.CONFIG_PATH
    daemon.CONFIG_PATH = Path(config_home) / "pi-iterm2.json"
    daemon.CONFIG_PATH.write_text('{"promptRestore": true}')
    prompts = []
    commands = []
    try:
        assert daemon.maybe_run_restore(
            {
                "hostname": "host",
                "cwd": "/cwd",
                "piSessionId": "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
            },
            input_fn=lambda prompt: prompts.append(prompt) or "y",
            run_fn=lambda command, **options: commands.append((command, options)),
            tty_check=lambda: True,
        )
        assert not daemon.maybe_run_restore(
            {
                "hostname": "host",
                "cwd": "/cwd",
                "piSessionId": "01a05d77-6025-7a5f-9fa2-7f313c3c8992",
            },
            input_fn=lambda _prompt: "yes",
            run_fn=lambda command, **options: commands.append((command, options)),
            tty_check=lambda: False,
        )
    finally:
        daemon.CONFIG_PATH = original_config_path
    assert prompts == ["Run it now? [y/N] "]
    assert commands
    assert commands[0][0][1] == "-lic"
    assert "pi --session 01a05d77-6025-7a5f-9fa2-7f313c3c8992" in commands[0][0][2]
    assert commands[0][1]["check"] is False
    assert "env" in commands[0][1]

shell_reminder = daemon.build_reminder_line(
    {"hostname": "host", "cwd": "/cwd", "updatedAt": time.time()}
)
assert "Last shell location in this tab" in shell_reminder
assert "cd -- /cwd" in shell_reminder
assert "pi --session" not in shell_reminder
local_shell_record = {
    "hostname": "workstation.local",
    "cwd": "/already-restored",
    "updatedAt": time.time(),
}
assert (
    daemon.build_resume_command(local_shell_record, local_hostname="workstation.local")
    is None
)
assert "Run " not in daemon.build_reminder_line(
    local_shell_record, local_hostname="workstation.local"
)
custom_id_command = daemon.build_resume_command(
    {
        "hostname": "host",
        "cwd": "/cwd",
        "piSessionId": "release-branch",
        "piSessionIdExact": True,
    },
    local_hostname="workstation.local",
)
assert custom_id_command is not None
assert (
    daemon.shlex.split(daemon.shlex.split(custom_id_command)[4])[-1] == "release-branch"
)

# Control bytes are stripped and the length is capped; unset stays unset.
assert daemon.sanitize_text("a\x1b[2Jb\x00c\x7f") == "a[2Jbc"
assert daemon.sanitize_text("a\r\nb") == "ab"
assert (
    daemon.sanitize_text("a\x85b\u061cc\u200ed\u200fe\u202ef\u2066g\ud800h")
    == "abcdefgh"
)
assert daemon.sanitize_text("plain/path") == "plain/path"
assert daemon.sanitize_text(None) is None
assert daemon.sanitize_text(123) is None
assert daemon.sanitize_text("") == ""
assert len(daemon.sanitize_text("x" * 1000)) == daemon.MAX_FIELD_LENGTH
assert daemon.sanitize_text("x" * 10, limit=4) == "xxxx"

# Persisted state is untrusted and must be cleaned again before terminal output.
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
# The only escapes left are the fixed styling sequences built by the renderer.
assert "\x1b]" not in poisoned
assert "\x1b[2J" not in poisoned
assert poisoned.count("\n") == 3
assert "pwned" in poisoned  # the text survives; only the control bytes are removed

# Missing Pi fields fall back to shell-location recovery.
assert "Last shell location" in daemon.build_reminder_line(
    {"piSessionId": "\x1b", "status": "\x00", "cwd": "/c", "updatedAt": time.time()}
)
assert "0s ago" in daemon.build_reminder_line(
    {"piSessionId": "id", "cwd": "/c", "updatedAt": float("nan")}
)
assert daemon.build_reminder_line(["not", "a", "record"]) is None
# Golden vector for JS Math.round compatibility (Python round would make green 76).
assert daemon.hsl_to_rgb(30, 45, 30) == (111, 77, 42)
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
            str(Path(__file__).parents[1] / "macos" / "pi_iterm2_daemon.py"),
            "--shell-identity-check",
        ],
        env=environment,
        text=True,
    )
    assert re.search(r"host:\s+\x1b\[38;2;\d+;\d+;\d+m.+\x1b\[39m", shell_check)

restore_hook = Path(__file__).parents[1] / "shell" / "pi_iterm2_restore.sh"
subprocess.check_call(["bash", "-n", str(restore_hook)])
subprocess.check_call(["zsh", "-n", str(restore_hook)])
subprocess.check_call(
    [
        "bash",
        "-c",
        'unset TERM_PROGRAM ITERM_SESSION_ID; source "$1"; false; '
        "_pi_iterm2_restore_once; [[ $? == 1 ]]; "
        "PI_ITERM2_SHELL_IDENTITY=x; false; pi_iterm2_shell_identity >/dev/null; [[ $? == 1 ]]",
        "bash",
        str(restore_hook),
    ]
)
with tempfile.TemporaryDirectory(prefix="pi-iterm2-hook-test-") as home:
    state_dir = Path(home) / ".pi-iterm2"
    state_dir.mkdir()
    (state_dir / "record-ids").write_text("GUID\n")
    hook_environment = os.environ.copy()
    hook_environment.update(
        {"HOME": home, "TERM_PROGRAM": "iTerm.app", "ITERM_SESSION_ID": "w0t0p0:GUID"}
    )
    hook_environment.pop("TMUX", None)
    subprocess.check_call(
        [
            "bash",
            "-c",
            'PROMPT_COMMAND=(one two); source "$1"; source "$1"; '
            "declare -F pi-iterm2-check >/dev/null; "
            "declare -F pi-iterm2-check-all >/dev/null; "
            "[[ ${#PROMPT_COMMAND[@]} == 2 && ${PROMPT_COMMAND[0]} == one && "
            "${PROMPT_COMMAND[1]} == two ]]",
            "bash",
            str(restore_hook),
        ],
        env=hook_environment,
        stderr=subprocess.DEVNULL,
    )

    # A tab without a record gets the shell commands but no PROMPT_COMMAND hook.
    hook_environment["ITERM_SESSION_ID"] = "w0t0p0:OTHER"
    subprocess.check_call(
        [
            "bash",
            "-c",
            'PROMPT_COMMAND=(_pi_iterm2_restore_once one two); source "$1"; '
            "declare -F pi-iterm2-check >/dev/null; "
            "[[ ${#PROMPT_COMMAND[@]} == 2 && ${PROMPT_COMMAND[0]} == one ]]",
            "bash",
            str(restore_hook),
        ],
        env=hook_environment,
    )

    # Non-iTerm shells neither register color hooks nor retain an old documented prefix.
    hook_environment["TERM_PROGRAM"] = "Apple_Terminal"
    subprocess.check_call(
        [
            "bash",
            "-c",
            'PROMPT_COMMAND="pi_iterm2_tab_color; existing"; source "$1"; '
            "[[ $PROMPT_COMMAND == existing ]]",
            "bash",
            str(restore_hook),
        ],
        env=hook_environment,
    )

with tempfile.TemporaryDirectory(prefix="pi-iterm2-remote-hook-test-") as home:
    state_dir = Path(home) / ".pi-iterm2"
    state_dir.mkdir()
    (state_dir / "remote-location-enabled").write_text("enabled\n")
    remote_environment = os.environ.copy()
    remote_environment.update(
        {"HOME": home, "USER": "alice", "HOSTNAME": "remote-host"}
    )
    remote_environment.pop("TERM_PROGRAM", None)
    remote_environment.pop("ITERM_SESSION_ID", None)
    remote_environment.pop("TMUX", None)
    location_output = subprocess.check_output(
        [
            "bash",
            "-c",
            'source "$1"; _pi_iterm2_publish_location',
            "bash",
            str(restore_hook),
        ],
        env=remote_environment,
    )
    assert b"]1337;RemoteHost=alice@remote-host" in location_output
    assert b"]1337;CurrentDir=" in location_output

print("ok - daemon and shell checks color hostnames and strip control bytes")
