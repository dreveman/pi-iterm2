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

While running, serves the Pi extension's read-only check commands over a
user-only Unix socket at ~/.pi-iterm2/daemon.sock. This reuses the daemon's
already-authenticated iTerm2 connection instead of opening another connection
from a captured child process, where iTerm2's one-time authentication can fail.

Records, per tab: the `user.pi_cwd` / `user.pi_session` / `user.pi_status` /
`user.pi_host_color` variables the pi-iterm2 pi extension publishes (plus
`hostname` when it is available), into ~/.pi-iterm2/state.json, keyed by the iTerm2 session id
(Session.session_id, the Python API's `guid`). iTerm2 reapplies a session's
original guid when restoring a saved window arrangement at startup, so a tab
keeps the same session id across an iTerm2 restart; keying on it also means
two tabs open in the same directory at once can never collide, since each
tab's id is unique regardless of what directory it's in.

Replays, per tab: when a tab appears with a record from a previous run and no
pi session currently live in it -- which is exactly the restored-after-a-crash
case -- one dim line is injected saying what was last running there and how
long ago, with the hostname shown in its recorded host color. It is injected
at tab appearance, while the tab is still showing a
plain shell prompt, and deliberately NOT when pi later starts: `async_inject`
delivers data as though it were program output, so injecting into a running
pi TUI would land in a screen pi is actively repainting and be overwritten or
corrupt it. A tab that already has a live pi session is skipped for the same
reason.

Session-id persistence across a restart has not been verified against a live
iTerm2 instance; confirm it holds before relying on this.

Usage:
  pi_iterm2_daemon.py              Run as the long-lived daemon (AutoLaunch).
  pi_iterm2_daemon.py --check      One-shot: print what is currently recorded
                                    for a session and the exact line that would
                                    be injected on restore, without injecting
                                    anything. Targets the session this is run
                                    from (via the ITERM_SESSION_ID environment
                                    variable iTerm2 sets), or pass
                                    --session <id> to check a specific one.
  pi_iterm2_daemon.py --check-all  The same report for every live session --
                                    all panes of all tabs of all windows, plus
                                    buried sessions -- marking the tab it was
                                    run from, and summarizing how many stored
                                    records belong to tabs that no longer
                                    exist. Needs no ITERM_SESSION_ID.
"""

import argparse
import asyncio
import fcntl
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

import iterm2

STATE_PATH = Path.home() / ".pi-iterm2" / "state.json"
SOCKET_PATH = STATE_PATH.parent / "daemon.sock"
LOCK_PATH = STATE_PATH.parent / "daemon.lock"
PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 16 * 1024
HOST_COLOR_PATTERN = re.compile(r"#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})")

# Everything this daemon reports comes from iTerm2 session variables, and any process that
# can write to a terminal can set those with OSC 1337;SetUserVar -- the payload is base64,
# so arbitrary bytes, ESC included, survive into the variable intact. Those values get
# persisted and later replayed into a tab as terminal output, so a hostile cwd or session
# name would otherwise be executed as escape sequences in a tab it was never typed in.
# Strip control bytes at the boundary, the same way the extension's sanitizeOscText() does
# before emitting a raw OSC payload.
CONTROL_BYTES_PATTERN = re.compile(r"[\x00-\x1f\x7f]")

# Also bound the length, so one very long value can't push the rest of a report off screen.
MAX_FIELD_LENGTH = 256


def sanitize_text(value: Optional[str], limit: int = MAX_FIELD_LENGTH) -> Optional[str]:
    """Strip control bytes and cap the length. None and "" pass through unchanged, since
    callers distinguish "unset" from "set to something"."""
    if not value:
        return value
    return CONTROL_BYTES_PATTERN.sub("", value)[:limit]


# Keep the most recently updated records only, so a long-lived install does not
# accumulate one entry per tab ever opened.
MAX_RECORDS = 200


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    """Write via a temp file and atomic replace. A plain truncate-and-write would leave
    invalid JSON behind if iTerm2 quit mid-write -- the very event this feature exists to
    survive -- and load_state() treats invalid JSON as empty, silently losing everything.
    """
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if len(state) > MAX_RECORDS:
        newest = sorted(
            state.items(), key=lambda kv: kv[1].get("updatedAt", 0), reverse=True
        )
        state = dict(newest[:MAX_RECORDS])
    tmp = STATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
    os.replace(tmp, STATE_PATH)


def record_session(session_id: str, values: dict) -> None:
    """Read-modify-write in one synchronous step. Keeping this free of `await` is what
    stops two tabs' tasks from interleaving between the load and the save and dropping
    one another's records."""
    state = load_state()
    state[session_id] = {
        "hostname": values["hostname"],
        "cwd": values["cwd"],
        "piSessionId": values["pi_session"],
        "status": values["pi_status"],
        "hostColor": values["host_color"],
        "updatedAt": time.time(),
    }
    save_state(state)


def format_ago(seconds: float) -> str:
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


def build_reminder_line(prior: Optional[dict]) -> Optional[str]:
    """The single source of truth for what gets replayed into a restored tab. Returns None
    when there is no record to report. Used both to inject the real reminder and, in
    --check mode, to preview it without injecting anything."""
    if not prior:
        return None
    ago = format_ago(time.time() - prior.get("updatedAt", time.time()))
    # Sanitized again on the way out, not just on the way in: a state file written by an
    # older build, or edited by hand, is replayed straight into a terminal from here.
    host = sanitize_text(prior.get("hostname"))
    cwd = sanitize_text(prior.get("cwd")) or "?"
    pi_session_id = sanitize_text(prior.get("piSessionId")) or "?"
    status = sanitize_text(prior.get("status")) or "?"
    # hostname is only populated when the extension's `currentDir` option is on, so the
    # location half of the line degrades to just the cwd rather than printing "?".
    display_host = colored_hostname(host, prior.get("hostColor"), dim_context=True)
    where = f"{display_host} {cwd}" if host else cwd
    return (
        f"\r\n\x1b[2mpi-iterm2: last session in this tab was "
        f"{pi_session_id} ({status}) "
        f"on {where}, {ago} ago\x1b[0m\r\n"
    )


async def read_session_vars(session) -> dict:
    """Sanitized at this boundary, so nothing downstream -- the state file, the reports, the
    injected reminder -- ever handles a value with control bytes in it."""
    return {
        "hostname": sanitize_text(await session.async_get_variable("hostname")),
        "cwd": sanitize_text(await session.async_get_variable("user.pi_cwd")),
        "pi_session": sanitize_text(
            await session.async_get_variable("user.pi_session")
        ),
        "pi_status": sanitize_text(await session.async_get_variable("user.pi_status")),
        # Validated by HOST_COLOR_PATTERN before use, but sanitizing is free and keeps the
        # rule "everything read from a session variable is cleaned here" without exception.
        "host_color": sanitize_text(
            await session.async_get_variable("user.pi_host_color")
        ),
    }


async def replay_into_tab(session, session_id: str) -> None:
    """Inject the reminder for a tab that just appeared, if it has a prior record and no
    pi session live in it right now."""
    prior = load_state().get(session_id)
    line = build_reminder_line(prior)
    if not line:
        return
    if await session.async_get_variable("user.pi_session"):
        return  # pi is already running here; injecting would land in its TUI
    await session.async_inject(line.encode("utf-8"))


async def track_session(connection, session_id):
    app = await iterm2.async_get_app(connection)

    session = app.get_session_by_id(session_id)
    if session is None:
        return
    await replay_into_tab(session, session_id)

    # pi_cwd is set at session start (and on rename), so this fires exactly when there is
    # something new worth recording -- no polling. Note the recording side only needs
    # pi_cwd/pi_session, which the extension's `userVars` option controls; `hostname`
    # comes from its separate `currentDir` option and is treated as optional so turning
    # that off does not silently stop the daemon recording anything.
    async with iterm2.VariableMonitor(
        connection, iterm2.VariableScopes.SESSION, "user.pi_cwd", session_id
    ) as mon:
        while True:
            await mon.async_get()

            session = app.get_session_by_id(session_id)
            if session is None:
                return  # session ended

            values = await read_session_vars(session)
            if not values["cwd"]:
                continue
            record_session(session_id, values)


def resolve_session_id(value: Optional[str]) -> Optional[str]:
    # iTerm2 sets this in every session's shell environment as "w0t0p0:<guid>".
    return value.rsplit(":", 1)[-1] if value else None


def format_session_report(
    session_id: str, values: dict, prior: Optional[dict], marker: str = ""
) -> str:
    """One session's live variables, stored record, and what would be injected. Shared by
    --check, --check-all, and local IPC so the three can never drift apart."""
    lines = [
        f"session id: {session_id}{marker}",
        "hostname:   "
        + (
            colored_hostname(values["hostname"], values.get("host_color"))
            if values["hostname"]
            else "(unset)"
        ),
        f"cwd:        {values['cwd'] or '(unset)'}",
        f"pi_session: {values['pi_session'] or '(unset)'}",
        f"pi_status:  {values['pi_status'] or '(unset)'}",
        "",
        "stored record: " + (json.dumps(prior, indent=2) if prior else "(none)"),
        "",
    ]

    line = build_reminder_line(prior)
    if not line:
        lines.append(
            "Would inject on restore: nothing (no record stored for this tab yet)"
        )
        return "\n".join(lines)
    lines.extend(["Would inject on restore:", line.strip("\r\n")])
    if values["pi_session"]:
        lines.extend(
            [
                "",
                "Note: suppressed while pi is live in this tab. The reminder is injected only",
                "when a tab appears with no pi session running, so it cannot land in pi's TUI.",
            ]
        )
    return "\n".join(lines)


def format_session_line(
    session_id: str, values: dict, marker: str = "", width: int = 0
) -> str:
    """A tab with no stored record has nothing to preview, so --check-all summarizes it in
    one line -- still showing whether pi is live in it -- rather than repeating a full
    empty report per tab."""
    bits = []
    if values["hostname"]:
        bits.append(
            "host=" + colored_hostname(values["hostname"], values.get("host_color"))
        )
    bits.extend(
        f"{key}={values[key]}"
        for key in ("cwd", "pi_session", "pi_status")
        if values[key]
    )
    label = f"{session_id}{marker}".ljust(width)
    return f"  {label}  {'  '.join(bits) if bits else '(no pi variables set)'}"


def all_sessions(app) -> list:
    """Every live session: all panes of all tabs of all windows, including panes minimized
    behind a maximized one, plus buried sessions (which live outside the window tree).
    """
    sessions = []
    for window in app.windows:
        for tab in window.tabs:
            sessions.extend(tab.all_sessions)
    sessions.extend(app.buried_sessions)
    return sessions


async def build_check_report(connection, session_id: Optional[str]) -> str:
    app = await iterm2.async_get_app(connection)
    resolved_id = resolve_session_id(session_id)
    if not resolved_id:
        raise ValueError(
            "No session id given and ITERM_SESSION_ID is not set. Run this from inside "
            "an iTerm2 tab, or pass --session <id>, or use --check-all."
        )

    session = app.get_session_by_id(resolved_id)
    if session is None:
        raise ValueError(f"No live session with id {resolved_id}.")

    values = await read_session_vars(session)
    return format_session_report(resolved_id, values, load_state().get(resolved_id))


async def check_main(connection, session_id: Optional[str]):
    try:
        print(
            await build_check_report(
                connection, session_id or os.environ.get("ITERM_SESSION_ID")
            )
        )
    except ValueError as error:
        print(error, file=sys.stderr)


async def build_check_all_report(
    connection, current_session_id: Optional[str] = None
) -> str:
    app = await iterm2.async_get_app(connection)
    sessions = all_sessions(app)
    if not sessions:
        return "No live iTerm2 sessions."

    current_id = resolve_session_id(current_session_id)
    state = load_state()

    recorded, unrecorded = [], []
    for session in sessions:
        session_id = session.session_id
        entry = (
            session_id,
            await read_session_vars(session),
            "  <- this tab" if session_id == current_id else "",
        )
        (recorded if state.get(session_id) else unrecorded).append(entry)

    lines = []
    if recorded:
        lines.append(f"Tabs with a stored record ({len(recorded)}):\n")
        for index, (session_id, values, marker) in enumerate(recorded):
            if index:
                lines.append("\n" + "-" * 72 + "\n")
            lines.append(
                format_session_report(session_id, values, state.get(session_id), marker)
            )
        lines.append("")

    if unrecorded:
        lines.append(f"Tabs with no stored record ({len(unrecorded)}):")
        width = max(
            len(f"{session_id}{marker}") for session_id, _, marker in unrecorded
        )
        for session_id, values, marker in unrecorded:
            lines.append(format_session_line(session_id, values, marker, width))
        lines.append("")

    orphans = [key for key in state if key not in {s.session_id for s in sessions}]
    lines.extend(
        [
            "=" * 72,
            f"{len(sessions)} live session(s); {len(state)} stored record(s), {len(orphans)} for tabs that no longer exist.",
        ]
    )
    return "\n".join(lines)


async def check_all_main(connection):
    print(await build_check_all_report(connection, os.environ.get("ITERM_SESSION_ID")))


def parse_control_request(line: bytes) -> tuple[Optional[str], Optional[str]]:
    """Validate one request line and return its (command, session id). Raises ValueError
    with a client-facing message for anything malformed; nothing here trusts the caller,
    since any process running as this user can reach the socket."""
    if not line or len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
        raise ValueError("Invalid or oversized daemon request.")
    request = json.loads(line)
    if not isinstance(request, dict):
        raise ValueError("Daemon request must be a JSON object.")
    # An exact type check, not isinstance: bool subclasses int, so True would otherwise
    # read as version 1.
    version = request.get("version")
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise ValueError("Incompatible daemon protocol version.")
    session_id = request.get("sessionId")
    if session_id is not None and not isinstance(session_id, str):
        raise ValueError("sessionId must be a string.")
    return request.get("command"), session_id


async def run_control_command(connection, command, session_id: Optional[str]) -> str:
    """The whole command surface: two read-only reports, and nothing else."""
    if command == "check":
        return await build_check_report(connection, session_id)
    if command == "check-all":
        return await build_check_all_report(connection, session_id)
    raise ValueError("Unknown daemon command.")


async def write_control_response(writer, response: dict) -> None:
    """Best effort by design: a client that hung up mid-report is ordinary, and there is
    nowhere useful to report a failure to reply to it."""
    try:
        writer.write((json.dumps(response) + "\n").encode("utf-8"))
        await writer.drain()
    # BrokenPipeError is a ConnectionError.
    except ConnectionError:
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionError:
            pass


async def handle_control_request(reader, writer, connection, report_lock) -> None:
    """Serve one bounded, read-only request over the user-owned local socket. Reads,
    dispatches, and always answers: every failure below becomes an error field in the
    response rather than a dropped connection."""
    response = {"version": PROTOCOL_VERSION, "ok": False}
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=5)
        command, session_id = parse_control_request(line)

        async def run_report():
            async with report_lock:
                return await run_control_command(connection, command, session_id)

        # Include time waiting behind another report in the deadline, and leave a
        # margin before the extension client's 15-second timeout.
        output = await asyncio.wait_for(run_report(), timeout=14)
        response = {"version": PROTOCOL_VERSION, "ok": True, "output": output}
    except asyncio.TimeoutError:
        response["error"] = "Timed out while handling daemon request."
    # json.JSONDecodeError is a ValueError, so this covers a malformed request body as
    # well as the explicit raises in parse_control_request.
    except ValueError as error:
        response["error"] = str(error) or "Invalid daemon request."
    except Exception as error:
        response["error"] = f"Could not query iTerm2: {error}"

    await write_control_response(writer, response)


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


async def start_control_server(connection, report_lock):
    """Create the IPC socket. The caller must already hold the daemon lock."""
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass

    async def on_client(reader, writer):
        await handle_control_request(reader, writer, connection, report_lock)

    server = await asyncio.start_unix_server(
        on_client,
        path=SOCKET_PATH,
        limit=MAX_REQUEST_BYTES + 1,
    )
    os.chmod(SOCKET_PATH, 0o600)
    stat = SOCKET_PATH.stat()
    return server, (stat.st_dev, stat.st_ino)


async def daemon_main(connection):
    app = await iterm2.async_get_app(connection)
    report_lock = asyncio.Lock()
    try:
        control = await start_control_server(connection, report_lock)
    except Exception as error:
        # Reporting is optional. A filesystem/socket problem must not disable the
        # daemon's primary record-and-replay behavior.
        print(f"Could not start pi-iterm2 check socket: {error}", file=sys.stderr)
        control = None

    async def on_session(session_id):
        try:
            await track_session(connection, session_id)
        except Exception:
            pass  # RPC failed for this session; stop watching it

    try:
        # Covers every session that exists now, plus every one created later. The
        # framework cancels each task when its session terminates.
        await iterm2.EachSessionOnceMonitor.async_foreach_session_create_task(
            app, on_session
        )
    finally:
        if control:
            server, socket_identity = control
            server.close()
            await server.wait_closed()
            try:
                stat = SOCKET_PATH.stat()
                if (stat.st_dev, stat.st_ino) == socket_identity:
                    SOCKET_PATH.unlink()
            except FileNotFoundError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Preview one session instead of running the daemon.",
    )
    parser.add_argument(
        "--check-all",
        action="store_true",
        help="Preview every live session instead of running the daemon.",
    )
    parser.add_argument(
        "--session", help="Session id for --check (defaults to the current session)."
    )
    args = parser.parse_args()

    if args.check_all:
        iterm2.run_until_complete(check_all_main)
    elif args.check:
        iterm2.run_until_complete(
            lambda connection: check_main(connection, args.session)
        )
    else:
        daemon_lock = acquire_daemon_lock()
        if daemon_lock is None:
            print("Another pi-iterm2 daemon is already running.", file=sys.stderr)
            return
        iterm2.run_forever(daemon_main)


if __name__ == "__main__":
    main()
