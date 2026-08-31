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

Records, per tab: the `user.pi_cwd` / `user.pi_session` / `user.pi_status`
variables the pi-iterm2 pi extension publishes (plus `hostname` when it is
available), into ~/.pi-iterm2/state.json, keyed by the iTerm2 session id
(Session.session_id, the Python API's `guid`). iTerm2 reapplies a session's
original guid when restoring a saved window arrangement at startup, so a tab
keeps the same session id across an iTerm2 restart; keying on it also means
two tabs open in the same directory at once can never collide, since each
tab's id is unique regardless of what directory it's in.

Replays, per tab: when a tab appears with a record from a previous run and no
pi session currently live in it -- which is exactly the restored-after-a-crash
case -- one dim line is injected saying what was last running there and how
long ago. It is injected at tab appearance, while the tab is still showing a
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
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import iterm2

STATE_PATH = Path.home() / ".pi-iterm2" / "state.json"

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


def build_reminder_line(prior: Optional[dict]) -> Optional[str]:
    """The single source of truth for what gets replayed into a restored tab. Returns None
    when there is no record to report. Used both to inject the real reminder and, in
    --check mode, to preview it without injecting anything."""
    if not prior:
        return None
    ago = format_ago(time.time() - prior.get("updatedAt", time.time()))
    # hostname is only populated when the extension's `currentDir` option is on, so the
    # location half of the line degrades to just the cwd rather than printing "?".
    host = prior.get("hostname")
    cwd = prior.get("cwd", "?")
    where = f"{host} {cwd}" if host else cwd
    return (
        f"\r\n\x1b[2mpi-iterm2: last session in this tab was "
        f"{prior.get('piSessionId', '?')} ({prior.get('status', '?')}) "
        f"on {where}, {ago} ago\x1b[0m\r\n"
    )


async def read_session_vars(session) -> dict:
    return {
        "hostname": await session.async_get_variable("hostname"),
        "cwd": await session.async_get_variable("user.pi_cwd"),
        "pi_session": await session.async_get_variable("user.pi_session"),
        "pi_status": await session.async_get_variable("user.pi_status"),
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


async def daemon_main(connection):
    app = await iterm2.async_get_app(connection)

    async def on_session(session_id):
        try:
            await track_session(connection, session_id)
        except Exception:
            pass  # RPC failed for this session; stop watching it

    # Covers every session that exists now, plus every one created later. The framework
    # cancels each task when its session terminates.
    await iterm2.EachSessionOnceMonitor.async_foreach_session_create_task(
        app, on_session
    )


def resolve_session_id(explicit: Optional[str]) -> Optional[str]:
    if explicit:
        return explicit
    # iTerm2 sets this in every session's shell environment, as "w0t0p0:<guid>".
    env_value = os.environ.get("ITERM_SESSION_ID", "")
    return env_value.rsplit(":", 1)[-1] if env_value else None


def print_session_report(
    session_id: str, values: dict, prior: Optional[dict], marker: str = ""
) -> None:
    """One session's live variables, stored record, and what would be injected. Shared by
    --check and --check-all so the two can never drift apart."""
    print(f"session id: {session_id}{marker}")
    print(f"hostname:   {values['hostname'] or '(unset)'}")
    print(f"cwd:        {values['cwd'] or '(unset)'}")
    print(f"pi_session: {values['pi_session'] or '(unset)'}")
    print(f"pi_status:  {values['pi_status'] or '(unset)'}")
    print()
    print("stored record:", json.dumps(prior, indent=2) if prior else "(none)")
    print()

    line = build_reminder_line(prior)
    if not line:
        print("Would inject on restore: nothing (no record stored for this tab yet)")
        return
    print("Would inject on restore:")
    print(line.strip("\r\n"))
    if values["pi_session"]:
        print()
        print(
            "Note: suppressed while pi is live in this tab. The reminder is injected only"
        )
        print(
            "when a tab appears with no pi session running, so it cannot land in pi's TUI."
        )


def format_session_line(
    session_id: str, values: dict, marker: str = "", width: int = 0
) -> str:
    """A tab with no stored record has nothing to preview, so --check-all summarizes it in
    one line -- still showing whether pi is live in it -- rather than repeating a full
    empty report per tab."""
    bits = [
        f"{key}={values[key]}"
        for key in ("cwd", "pi_session", "pi_status")
        if values[key]
    ]
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


async def check_main(connection, session_id: Optional[str]):
    app = await iterm2.async_get_app(connection)
    resolved_id = resolve_session_id(session_id)
    if not resolved_id:
        print(
            "No session id given and ITERM_SESSION_ID is not set. Run this from inside",
            file=sys.stderr,
        )
        print(
            "an iTerm2 tab, or pass --session <id>, or use --check-all.",
            file=sys.stderr,
        )
        return

    session = app.get_session_by_id(resolved_id)
    if session is None:
        print(f"No live session with id {resolved_id}.", file=sys.stderr)
        return

    values = await read_session_vars(session)
    print_session_report(resolved_id, values, load_state().get(resolved_id))


async def check_all_main(connection):
    app = await iterm2.async_get_app(connection)
    sessions = all_sessions(app)
    if not sessions:
        print("No live iTerm2 sessions.")
        return

    current_id = resolve_session_id(None)
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

    if recorded:
        print(f"Tabs with a stored record ({len(recorded)}):\n")
        for index, (session_id, values, marker) in enumerate(recorded):
            if index:
                print("\n" + "-" * 72 + "\n")
            print_session_report(session_id, values, state.get(session_id), marker)
        print()

    if unrecorded:
        print(f"Tabs with no stored record ({len(unrecorded)}):")
        width = max(
            len(f"{session_id}{marker}") for session_id, _, marker in unrecorded
        )
        for session_id, values, marker in unrecorded:
            print(format_session_line(session_id, values, marker, width))
        print()

    orphans = [key for key in state if key not in {s.session_id for s in sessions}]
    print("=" * 72)
    print(
        f"{len(sessions)} live session(s); {len(state)} stored record(s), {len(orphans)} for tabs that no longer exist."
    )


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
        iterm2.run_forever(daemon_main)


if __name__ == "__main__":
    main()
