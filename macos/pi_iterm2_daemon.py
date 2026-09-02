#!/usr/bin/env python3
"""
pi-iterm2 companion daemon.

Install by saving this file as:
  ~/Library/Application Support/iTerm2/Scripts/AutoLaunch/pi_iterm2_daemon.py

Requires, once: iTerm2 Settings -> General -> Magic -> Enable Python API, and
Scripts -> Install Python Runtime (Check for Updated Runtime once already
installed) -- that second step is what actually provisions the bundled
Python environment this runs under (with the `iterm2` module included);
enabling the API alone does not. iTerm2 runs AutoLaunch scripts
automatically on startup once both are done.

Records, per tab: iTerm2's built-in `hostname`, `username`, and `path` plus
the `user.pi_cwd` / `user.pi_session` / `user.pi_session_id` /
`user.pi_instance` / `user.pi_status` / `user.pi_host_color` variables the
pi-iterm2 Pi extension publishes, into ~/.pi-iterm2/state.json, keyed by the
iTerm2 session id
(Session.session_id, the Python API's `guid`). iTerm2 reapplies a session's
original guid when restoring a saved window arrangement at startup, so a tab
keeps the same session id across an iTerm2 restart; keying on it also means
two tabs open in the same directory at once can never collide, since each
tab's id is unique regardless of what directory it's in.

On each new iTerm2 application launch, the daemon merges completed state into
~/.pi-iterm2/state.previous.json and starts a fresh state.json. An
application-scoped run marker prevents duplicate rotation within one launch.

A synchronous shell pre-prompt hook invokes this script's hidden
--emit-pending mode, selects the newest record matching ITERM_SESSION_ID, and
prints it before the shell renders its prompt.

Usage:
  pi_iterm2_daemon.py              Run as the long-lived daemon (AutoLaunch).
  pi_iterm2_daemon.py --check      One-shot: print what is currently recorded
                                    for a session and a reminder preview,
                                    without delivering anything. Targets the
                                    session this is run
                                    from (via the ITERM_SESSION_ID environment
                                    variable iTerm2 sets), or pass
                                    --session <id> to check a specific one.
  pi_iterm2_daemon.py --check-all  Preview every stored tab record. Needs no
                                    ITERM_SESSION_ID.

The installed shell hook uses the hidden --emit-pending mode to print one
matching reminder synchronously before the first prompt.
"""

import argparse
import asyncio
import fcntl
import json
import math
import os
import re
import shlex
import socket
import subprocess
import sys
import termios
import time
import tty
import unicodedata
import uuid
from pathlib import Path
from typing import Optional

iterm2 = None


def require_iterm2():
    """Load the heavy iTerm2 SDK only in long-lived daemon mode."""
    global iterm2
    if iterm2 is None:
        import importlib

        iterm2 = importlib.import_module("iterm2")
    return iterm2


STATE_PATH = Path.home() / ".pi-iterm2" / "state.json"
PREVIOUS_STATE_PATH = STATE_PATH.parent / "state.previous.json"
LOCK_PATH = STATE_PATH.parent / "daemon.lock"
RECORD_INDEX_PATH = STATE_PATH.parent / "record-ids"
APP_RUN_MARKER = "user.pi_iterm2_app_run"
HOST_COLOR_PATTERN = re.compile(r"#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})")
ITERM_SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
REMOTE_IDENTITY_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")
PI_SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")
CONFIG_PATH = Path.home() / ".pi" / "agent" / "pi-iterm2.json"
VSCODE_SETTINGS_PATHS = [
    Path.home() / ".vscode-remote" / "data" / "Machine" / "settings.json",
    Path.home() / ".vscode-server" / "data" / "Machine" / "settings.json",
]
VSCODE_COLOR_KEYS = [
    "titleBar.activeBackground",
    "titleBar.inactiveBackground",
    "activityBar.background",
]
IDLE_SATURATION = 45
IDLE_LIGHTNESS = 30
# Everything this daemon reports comes from iTerm2 session variables, and any process that
# can write to a terminal can set those with OSC 1337;SetUserVar -- the payload is base64,
# so arbitrary bytes, ESC included, survive into the variable intact. Those values get
# persisted and later replayed into a tab as terminal output, so a hostile cwd or session
# name would otherwise be executed as escape sequences in a tab it was never typed in.
# Strip control bytes at the boundary, the same way the extension's sanitizeOscText() does
# before emitting a raw OSC payload.
CONTROL_BYTES_PATTERN = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# Also bound the length, so one very long value can't push the rest of a report off screen.
MAX_FIELD_LENGTH = 256


def sanitize_text(value: Optional[str], limit: int = MAX_FIELD_LENGTH) -> Optional[str]:
    """Strip controls and cap strings; reject every other value type."""
    if not isinstance(value, str):
        return None
    if not value:
        return value
    value = CONTROL_BYTES_PATTERN.sub("", value)
    return "".join(
        character
        for character in value
        if unicodedata.category(character) not in {"Cf", "Cs", "Zl", "Zp"}
    )[:limit]


# Keep the most recently updated records only, so a long-lived install does not
# accumulate one entry per tab ever opened.
MAX_RECORDS = 200


def record_timestamp(record: dict) -> float:
    value = record.get("updatedAt")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        return float(value) if math.isfinite(value) else 0
    except OverflowError:
        return 0


def load_state(path: Optional[Path] = None, strict: bool = False) -> dict:
    target = path or STATE_PATH
    try:
        state = json.loads(target.read_text())
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        if strict:
            raise
        return {}
    if not isinstance(state, dict) or any(
        not isinstance(key, str) or not isinstance(record, dict)
        for key, record in state.items()
    ):
        if strict:
            raise ValueError(f"Invalid state structure in {target}.")
        return (
            {
                key: record
                for key, record in state.items()
                if isinstance(key, str) and isinstance(record, dict)
            }
            if isinstance(state, dict)
            else {}
        )
    return state


def load_report_state() -> dict:
    """Return records from both launches, preferring the current launch."""
    state = load_state(PREVIOUS_STATE_PATH)
    state.update(load_state())
    return state


def sync_record_index() -> None:
    """Publish record IDs for the shell hook's zero-process fast path."""
    STATE_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE_PATH.parent, 0o700)
    session_ids = sorted(
        session_id
        for session_id in load_state(PREVIOUS_STATE_PATH)
        if isinstance(session_id, str)
        and ITERM_SESSION_ID_PATTERN.fullmatch(session_id)
    )
    contents = "".join(f"{session_id}\n" for session_id in session_ids)
    try:
        if RECORD_INDEX_PATH.read_text() == contents:
            return
    except (OSError, UnicodeDecodeError):
        pass
    tmp = RECORD_INDEX_PATH.with_name(
        f"{RECORD_INDEX_PATH.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        tmp.write_text(contents)
        os.chmod(tmp, 0o600)
        os.replace(tmp, RECORD_INDEX_PATH)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def limit_state(state: dict) -> dict:
    if len(state) <= MAX_RECORDS:
        return state
    newest = sorted(
        state.items(), key=lambda item: record_timestamp(item[1]), reverse=True
    )
    return dict(newest[:MAX_RECORDS])


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(limit_state(state), indent=2, sort_keys=True))
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def rotate_state_for_new_app_run() -> None:
    """Merge completed state into the durable recovery snapshot."""
    prepare_state_directory()
    if not STATE_PATH.exists():
        return
    current = load_state(STATE_PATH, strict=True)
    merged = load_state(PREVIOUS_STATE_PATH, strict=True)
    for session_id, record in current.items():
        previous = merged.get(session_id)
        if previous is None or record_timestamp(record) >= record_timestamp(previous):
            merged[session_id] = record
    write_state(PREVIOUS_STATE_PATH, merged)
    STATE_PATH.unlink()


async def prepare_recovery_state(app) -> dict:
    """Rotate state once per iTerm2 application launch and return its snapshot.

    Session-scoped user variables survive window restoration, so they cannot tell
    a restored, dead Pi from a live one. The application-scoped run id does not
    survive an iTerm2 restart but does survive a daemon restart within the same app.
    """
    app_run_id = await app.async_get_variable(APP_RUN_MARKER)
    if not isinstance(app_run_id, str) or not app_run_id:
        rotate_state_for_new_app_run()
        app_run_id = uuid.uuid4().hex
        await app.async_set_variable(APP_RUN_MARKER, app_run_id)
    sync_record_index()
    return load_state(PREVIOUS_STATE_PATH)


def save_state(state: dict) -> None:
    """Atomically persist the current app run."""
    write_state(STATE_PATH, state)


def record_session(session_id: str, values: dict) -> None:
    """Read-modify-write in one synchronous step. Keeping this free of `await` is what
    stops two tabs' tasks from interleaving between the load and the save and dropping
    one another's records."""
    state = load_state(strict=True)
    state[session_id] = {
        "hostname": values["hostname"],
        "username": values["username"],
        "cwd": values["cwd"],
        "piSessionId": values["pi_session_id"],
        "piSessionIdExact": True,
        "piSessionName": values["pi_session"],
        "piInstance": values["pi_instance"],
        "status": values["pi_status"],
        "hostColor": values["host_color"],
        "updatedAt": time.time(),
    }
    save_state(state)


def format_ago(seconds: float) -> str:
    if not isinstance(seconds, (int, float)) or not math.isfinite(seconds):
        seconds = 0
    seconds = max(0, seconds)
    if seconds < 60:
        return f"{int(seconds)}s"
    if seconds < 3600:
        return f"{int(seconds / 60)}m"
    if seconds < 86400:
        return f"{int(seconds / 3600)}h"
    return f"{int(seconds / 86400)}d"


def colored_hostname(host, color, dim_context=False) -> str:
    """Color only the hostname, restoring the surrounding foreground and intensity."""
    if not isinstance(host, str) or not isinstance(color, str):
        return str(host)
    match = HOST_COLOR_PATTERN.fullmatch(color)
    if match is None:
        return host
    red, green, blue = (int(channel, 16) for channel in match.groups())
    if dim_context:
        return f"\x1b[22;38;2;{red};{green};{blue}m{host}\x1b[2;39m"
    return f"\x1b[38;2;{red};{green};{blue}m{host}\x1b[39m"


def is_pi_session_id(value: Optional[str], exact: bool = False) -> bool:
    """Validate an exact Pi ID, or conservatively accept only a UUID."""
    if not value:
        return False
    if exact:
        return PI_SESSION_ID_PATTERN.fullmatch(value) is not None
    try:
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def is_local_hostname(
    host: Optional[str], local_hostname: Optional[str] = None
) -> bool:
    """Match exact local hostname aliases plus the standard loopback hostnames."""
    if not host:
        return False
    normalized = host.rstrip(".").lower()
    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True
    if local_hostname is not None:
        aliases = {local_hostname}
    else:
        aliases = {socket.gethostname(), socket.getfqdn()}
    return normalized in {alias.rstrip(".").lower() for alias in aliases if alias}


def fnv1a(text: str) -> int:
    hashed = 0x811C9DC5
    for character in text:
        hashed = ((hashed ^ ord(character)) * 0x01000193) & 0xFFFFFFFF
    return hashed


def rgb_to_hue(red: int, green: int, blue: int) -> float:
    red, green, blue = red / 255, green / 255, blue / 255
    largest = max(red, green, blue)
    delta = largest - min(red, green, blue)
    if delta == 0:
        return 0
    if largest == red:
        sextant = ((green - blue) / delta) % 6
    elif largest == green:
        sextant = (blue - red) / delta + 2
    else:
        sextant = (red - green) / delta + 4
    return (sextant * 60) % 360


def hue_from_css_hex(value: str) -> Optional[float]:
    match = re.fullmatch(r"#([0-9a-fA-F]{3,8})", value.strip())
    if match is None:
        return None
    digits = match.group(1)
    if len(digits) in (3, 4):
        digits = "".join(digit * 2 for digit in digits[:3])
    elif len(digits) in (6, 8):
        digits = digits[:6]
    else:
        return None
    return rgb_to_hue(int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16))


def parse_color_spec(value) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value % 360
    if not isinstance(value, str):
        return None
    text = value.strip()
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", text)
    if match is not None:
        digits = match.group(1)
        return rgb_to_hue(
            int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16)
        )
    if re.fullmatch(r"[+-]?\d+(\.\d+)?", text):
        return float(text) % 360
    return None


def hsl_to_rgb(hue: float, saturation: float, lightness: float) -> tuple[int, int, int]:
    saturation, lightness = saturation / 100, lightness / 100
    chroma = (1 - abs(2 * lightness - 1)) * saturation
    sextant = (hue % 360) / 60
    second = chroma * (1 - abs((sextant % 2) - 1))
    base = lightness - chroma / 2
    order = [
        (chroma, second, 0),
        (second, chroma, 0),
        (0, chroma, second),
        (0, second, chroma),
        (second, 0, chroma),
        (chroma, 0, second),
    ]
    return tuple(
        math.floor((channel + base) * 255 + 0.5)
        for channel in order[min(int(sextant), 5)]
    )


def read_json(path: Path):
    try:
        value = json.loads(path.read_text())
        return value
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def vscode_hue() -> Optional[tuple[float, str]]:
    for path in VSCODE_SETTINGS_PATHS:
        settings = read_json(path)
        if not isinstance(settings, dict):
            continue
        colors = settings.get("workbench.colorCustomizations")
        if not isinstance(colors, dict):
            continue
        for key in VSCODE_COLOR_KEYS:
            value = colors.get(key)
            if isinstance(value, str):
                hue = hue_from_css_hex(value)
                if hue is not None:
                    return hue, f"{key} in {path}"
    return None


def resolve_shell_hue(host: str, config: dict) -> tuple[float, str]:
    host_colors = config.get("hostColors")
    pinned = (
        parse_color_spec(host_colors.get(host))
        if isinstance(host_colors, dict)
        else None
    )
    if pinned is not None:
        return pinned, "hostColors pin"
    if config.get("vscodeColor", True):
        found = vscode_hue()
        if found is not None:
            return found[0], f"VS Code window color ({found[1]})"
    palette_value = config.get("palette")
    palette = [
        hue
        for hue in (
            parse_color_spec(entry)
            for entry in (palette_value if isinstance(palette_value, list) else [])
        )
        if hue is not None
    ]
    if palette:
        return palette[fnv1a(f"host:{host}") % len(palette)], "palette"
    return float(fnv1a(f"host:{host}") % 360), "hostname hash"


def shell_identity_output(check: bool = False) -> int:
    host = os.uname().nodename
    config_value = read_json(CONFIG_PATH)
    config = config_value if isinstance(config_value, dict) else {}
    disabled = None
    if config.get("enabled") is False:
        disabled = f"enabled is false in {CONFIG_PATH}"
    elif config.get("tabColor") is False:
        disabled = f"tabColor is false in {CONFIG_PATH}"
    if disabled:
        if check:
            print(f"host:     {host}")
            print(f"disabled: {disabled}")
        return 0

    hue, source = resolve_shell_hue(host, config)
    rgb = hsl_to_rgb(hue, IDLE_SATURATION, IDLE_LIGHTNESS)
    sequence = "".join(
        f"\x1b]6;1;bg;{name};brightness;{value}\x07"
        for name, value in (("red", rgb[0]), ("green", rgb[1]), ("blue", rgb[2]))
    )
    if os.environ.get("TMUX"):
        sequence = "\x1bPtmux;" + sequence.replace("\x1b", "\x1b\x1b") + "\x1b\\"
    if check:
        colored_host = f"\x1b[38;2;{rgb[0]};{rgb[1]};{rgb[2]}m{host}\x1b[39m"
        print(f"host:   {colored_host}")
        print(f"hue:    {hue:.1f} deg")
        print(f"source: {source}")
        print(
            f"color:  rgb({rgb[0]},{rgb[1]},{rgb[2]})  "
            f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"
        )
        return 0
    sys.stdout.write(sequence)
    sys.stdout.flush()
    return 0


def build_remote_launch_argv(
    host: str, user: Optional[str], remote_command: str
) -> list[str]:
    """Argv that runs remote_command on a remote host, for the resume command.

    Override this when a deployment reaches hosts with something other than plain
    SSH. The replacement owns the whole argv, so it also fits launchers that take
    the remote command through a flag, that put the host last, or that address
    hosts by name without a username.
    """
    target = f"{user}@{host}" if user else host
    return ["ssh", "-t", "--", target, remote_command]


def build_resume_command(
    prior: Optional[dict], local_hostname: Optional[str] = None
) -> Optional[str]:
    """Build a shell-safe, copyable local or SSH command for resuming Pi."""
    if not isinstance(prior, dict) or not prior:
        return None
    host = sanitize_text(prior.get("hostname"))
    user = sanitize_text(prior.get("username"))
    cwd = sanitize_text(prior.get("cwd"))
    pi_session_id = sanitize_text(prior.get("piSessionId"))
    if not host or not cwd:
        return None
    if not REMOTE_IDENTITY_PATTERN.fullmatch(host):
        return None
    if user and not REMOTE_IDENTITY_PATTERN.fullmatch(user):
        return None
    resume_command = f"cd -- {shlex.quote(cwd)}"
    has_pi_session = is_pi_session_id(
        pi_session_id, exact=prior.get("piSessionIdExact") is True
    )
    local = is_local_hostname(host, local_hostname)
    if local and not has_pi_session:
        return None  # iTerm2 restores a local shell's directory itself.
    if has_pi_session:
        resume_command += f" && exec pi --session {shlex.quote(pi_session_id)}"
    if local:
        return resume_command
    if not has_pi_session:
        resume_command += ' && exec "${SHELL:-/bin/sh}" -l'
    return shlex.join(build_remote_launch_argv(host, user or None, resume_command))


def build_reminder_line(
    prior: Optional[dict], local_hostname: Optional[str] = None
) -> Optional[str]:
    """The single source of truth for shell-hook output and check previews."""
    if not isinstance(prior, dict) or not prior:
        return None
    updated_at = record_timestamp(prior)
    age = time.time() - updated_at if updated_at else 0
    ago = format_ago(age)
    # Treat persisted state as untrusted because it is rendered directly in a terminal.
    host = sanitize_text(prior.get("hostname"))
    cwd = sanitize_text(prior.get("cwd")) or "?"
    pi_session_id = sanitize_text(prior.get("piSessionId"))
    pi_session_name = sanitize_text(prior.get("piSessionName"))
    has_pi_session = is_pi_session_id(
        pi_session_id, exact=prior.get("piSessionIdExact") is True
    )
    session_label = pi_session_name or pi_session_id or "?"
    status = sanitize_text(prior.get("status")) or "?"
    # hostname is only populated when the extension's `currentDir` option is on, so the
    # location half of the line degrades to just the cwd rather than printing "?".
    display_host = colored_hostname(host, prior.get("hostColor"), dim_context=True)
    where = f"{display_host} {cwd}" if host else cwd
    if has_pi_session:
        reminder = (
            f"\x1b[2mLast Pi session in this tab was "
            f"{session_label} ({status}) "
            f"on {where}, {ago} ago.\x1b[0m\n"
        )
        restore_target = "session"
    else:
        reminder = (
            f"\x1b[2mLast shell location in this tab was {where}, {ago} ago.\x1b[0m\n"
        )
        restore_target = "shell"
    command = build_resume_command(prior, local_hostname)
    if not command:
        return reminder + "\n"
    # Bold the command instead of printing literal Markdown backticks. Terminal copy
    # omits the styling escapes, leaving the command itself safe to paste.
    return (
        reminder + f"Run \x1b[1m{command}\x1b[22m to restore this {restore_target}.\n\n"
    )


async def read_session_vars(session) -> dict:
    """Sanitized at this boundary, so state, reports, and hook output stay safe."""
    pi_cwd = sanitize_text(await session.async_get_variable("user.pi_cwd"))
    shell_cwd = sanitize_text(await session.async_get_variable("path"))
    return {
        "hostname": sanitize_text(await session.async_get_variable("hostname")),
        "username": sanitize_text(await session.async_get_variable("username")),
        "cwd": pi_cwd or shell_cwd,
        "pi_session": sanitize_text(
            await session.async_get_variable("user.pi_session")
        ),
        "pi_session_id": sanitize_text(
            await session.async_get_variable("user.pi_session_id")
        ),
        "pi_instance": sanitize_text(
            await session.async_get_variable("user.pi_instance")
        ),
        "pi_status": sanitize_text(await session.async_get_variable("user.pi_status")),
        # Validated by HOST_COLOR_PATTERN before use, but sanitizing is free and keeps the
        # rule "everything read from a session variable is cleaned here" without exception.
        "host_color": sanitize_text(
            await session.async_get_variable("user.pi_host_color")
        ),
    }


def latest_record_for_session(session_id: Optional[str]) -> Optional[dict]:
    """Return the newest record for a tab, before or after startup rotation."""
    resolved_id = resolve_session_id(session_id)
    if not resolved_id:
        return None
    records = [
        state[resolved_id]
        for state in (load_state(), load_state(PREVIOUS_STATE_PATH))
        if isinstance(state, dict) and isinstance(state.get(resolved_id), dict)
    ]
    if not records:
        return None
    return max(records, key=record_timestamp)


def read_single_key(prompt: str) -> str:
    """Read one unechoed key from the terminal without waiting for Enter."""
    descriptor = sys.stdin.fileno()
    previous = termios.tcgetattr(descriptor)
    sys.stdout.write(prompt)
    sys.stdout.flush()
    try:
        tty.setcbreak(descriptor)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)
        sys.stdout.write("\n")
        sys.stdout.flush()


def stdio_is_tty() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def maybe_run_restore(
    prior: Optional[dict], input_fn=None, run_fn=subprocess.run, tty_check=None
) -> bool:
    """Optionally run the displayed command after an explicit default-no prompt."""
    if tty_check is None:
        tty_check = stdio_is_tty
    if not tty_check():
        return False
    config = read_json(CONFIG_PATH)
    if not isinstance(config, dict) or config.get("promptRestore") is not True:
        return False
    command = build_resume_command(prior)
    if not command:
        return False
    try:
        answer = (
            input_fn("Run it now? [y/N] ")
            if input_fn is not None
            else read_single_key("Run it now? [y/N] ")
        )
    except (EOFError, KeyboardInterrupt, OSError, termios.error):
        return False
    if answer.lower() != "y":
        return False
    shell = os.environ.get("SHELL") or "/bin/sh"
    environment = os.environ.copy()
    if os.environ.get("ITERM_SESSION_ID"):
        environment["PI_ITERM2_RESTORE_SESSION_ID"] = os.environ["ITERM_SESSION_ID"]
    run_fn([shell, "-lic", command], check=False, env=environment)
    return True


def emit_pending_replay() -> int:
    """Print one reminder synchronously from a shell pre-prompt hook."""
    try:
        prior = latest_record_for_session(os.environ.get("ITERM_SESSION_ID"))
        output = build_reminder_line(prior)
        if not output:
            return 3
        try:
            sys.stdout.write(output)
        except UnicodeEncodeError:
            sys.stdout.buffer.write(output.encode("utf-8", errors="replace"))
        sys.stdout.flush()
        maybe_run_restore(prior)
        return 0
    except (OSError, TypeError, ValueError):
        return 1


async def track_session(connection, session_id, recovery_state: dict):
    """Record Pi identity changes; shell hooks handle all reminder output."""
    app = await iterm2.async_get_app(connection)
    session = app.get_session_by_id(session_id)
    if session is None:
        return

    async with (
        iterm2.VariableMonitor(
            connection, iterm2.VariableScopes.SESSION, "user.pi_cwd", session_id
        ) as cwd_monitor,
        iterm2.VariableMonitor(
            connection, iterm2.VariableScopes.SESSION, "path", session_id
        ) as path_monitor,
        iterm2.VariableMonitor(
            connection, iterm2.VariableScopes.SESSION, "user.pi_instance", session_id
        ) as instance_monitor,
        iterm2.VariableMonitor(
            connection, iterm2.VariableScopes.SESSION, "user.pi_status", session_id
        ) as status_monitor,
    ):
        values = await read_session_vars(session)
        prior = recovery_state.get(session_id)
        if values["cwd"] and (
            not prior
            or (
                values["pi_instance"]
                and values["pi_instance"] != prior.get("piInstance")
            )
        ):
            record_session(session_id, values)

        async def record_on_change(monitor):
            while True:
                await monitor.async_get()
                current_session = app.get_session_by_id(session_id)
                if current_session is None:
                    return
                current_values = await read_session_vars(current_session)
                if current_values["cwd"]:
                    record_session(session_id, current_values)

        tasks = [
            asyncio.create_task(record_on_change(cwd_monitor)),
            asyncio.create_task(record_on_change(path_monitor)),
            asyncio.create_task(record_on_change(instance_monitor)),
            asyncio.create_task(record_on_change(status_monitor)),
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


def resolve_session_id(value: Optional[str]) -> Optional[str]:
    # iTerm2 sets this in every session's shell environment as "w0t0p0:<guid>".
    return value.rsplit(":", 1)[-1] if value else None


def format_record_report(
    session_id: str, record: Optional[dict], current: bool = False
) -> str:
    marker = (
        "  <- this tab"
        if session_id == resolve_session_id(os.environ.get("ITERM_SESSION_ID"))
        else ""
    )
    lines = [
        f"session id: {session_id}{marker}",
        f"stored record{' (current)' if current else ''}: "
        + (json.dumps(record, indent=2) if record else "(none)"),
        "",
    ]
    reminder = build_reminder_line(record)
    lines.extend(
        [
            "Reminder preview:",
            reminder.strip("\n") if reminder else "nothing stored for this tab",
        ]
    )
    return "\n".join(lines)


def build_check_report(session_id: Optional[str]) -> str:
    resolved_id = resolve_session_id(session_id)
    if not resolved_id:
        raise ValueError(
            "No session id given and ITERM_SESSION_ID is not set. Use --session <id>."
        )
    current = load_state()
    previous = load_state(PREVIOUS_STATE_PATH)
    record = current.get(resolved_id) or previous.get(resolved_id)
    return format_record_report(resolved_id, record, current=resolved_id in current)


def build_check_all_report() -> str:
    current = load_state()
    state = load_state(PREVIOUS_STATE_PATH)
    state.update(current)
    if not state:
        return "No stored iTerm2 session records."
    reports = [f"Stored records ({len(state)}):"]
    for session_id in sorted(state):
        reports.extend(
            [
                "",
                "-" * 72,
                format_record_report(
                    session_id, state[session_id], current=session_id in current
                ),
            ]
        )
    return "\n".join(reports)


def prepare_state_directory() -> None:
    STATE_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE_PATH.parent, 0o700)


def acquire_daemon_lock(timeout: float = 5):
    """Hold an advisory lock, allowing an old daemon time to exit on app restart."""
    prepare_state_directory()
    lock_file = open(LOCK_PATH, "a+")
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock_file
        except BlockingIOError:
            if time.monotonic() >= deadline:
                lock_file.close()
                return None
            time.sleep(0.1)


async def daemon_main(connection):
    app = await iterm2.async_get_app(connection)
    recovery_state = await prepare_recovery_state(app)

    async def on_session(session_id):
        try:
            await track_session(connection, session_id, recovery_state)
        except Exception as error:
            detail = sanitize_text(str(error)) or type(error).__name__
            print(
                f"Stopped tracking iTerm2 session {session_id}: {detail}",
                file=sys.stderr,
            )

    # Covers every session that exists now, plus every one created later. The framework
    # cancels each task when its session terminates.
    await iterm2.EachSessionOnceMonitor.async_foreach_session_create_task(
        app, on_session
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="Preview one session instead of running the daemon.",
    )
    mode.add_argument(
        "--check-all",
        action="store_true",
        help="Preview every live session instead of running the daemon.",
    )
    parser.add_argument(
        "--session", help="Session id for --check (defaults to the current session)."
    )
    mode.add_argument(
        "--emit-pending",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    mode.add_argument(
        "--refresh-record-index",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    mode.add_argument("--shell-identity", action="store_true", help=argparse.SUPPRESS)
    mode.add_argument(
        "--shell-identity-check", action="store_true", help=argparse.SUPPRESS
    )
    args = parser.parse_args()
    if args.session and not args.check:
        parser.error("--session requires --check")

    if args.emit_pending:
        raise SystemExit(emit_pending_replay())
    if args.refresh_record_index:
        sync_record_index()
        return
    if args.shell_identity or args.shell_identity_check:
        raise SystemExit(shell_identity_output(check=args.shell_identity_check))
    if args.check_all:
        print(build_check_all_report())
        return
    if args.check:
        try:
            print(
                build_check_report(args.session or os.environ.get("ITERM_SESSION_ID"))
            )
        except ValueError as error:
            print(f"Check failed: {sanitize_text(str(error))}", file=sys.stderr)
            raise SystemExit(1) from error
        return

    require_iterm2()
    daemon_lock = acquire_daemon_lock()
    if daemon_lock is None:
        print("Another pi-iterm2 daemon is already running.", file=sys.stderr)
        return
    iterm2.run_forever(daemon_main)


if __name__ == "__main__":
    main()
