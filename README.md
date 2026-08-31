# pi-iterm2

**Never lose a Pi session after an iTerm2 or system restart.** The macOS companion daemon remembers the remote host, working directory, and Pi session ID for every tab. When iTerm2 restores a tab, it prints exactly what was running there:

```text
pi-iterm2: last session in this tab was 01abc... (idle) on devvm123 /home/me/project, 2m ago
```

The hostname is printed in that host's tab color, so it remains recognizable at a glance. The message tells you which host to reconnect to, which working directory to enter, and which exact Pi session to resume. Recovery is independent of SSH, mosh, devserver tooling, or any other connection method because pi-iterm2 records the session identity in the tab itself rather than managing the connection.

The extension also ties iTerm2 tabs to the live Pi sessions running in them:

- **Tab color** is derived from hostname (primary), session id (secondary nudge), and live agent status (idle/working/waiting/error) — so tabs on different machines are visually distinct, sessions on the same machine stay in the same color family, and a glance at the tab tells you whether that session needs attention.
- **Tab title** gets a status icon prefixed while there's something to flag (working/waiting/error), on top of pi's own default title.
- **cwd, session name, status, and resolved host color are published as iTerm2 user-defined variables** (`\(user.pi_cwd)`, `\(user.pi_session)`, `\(user.pi_status)`, `\(user.pi_host_color)`), so the companion daemon and custom iTerm2 badges or titles can use them.
- **Native cwd tracking** (`CurrentDir`/`RemoteHost`) is also enabled, so iTerm2's own directory-inheriting new-tab/split behavior and semantic history work for the session's project directory.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/dreveman/pi-iterm2
```

To try a local checkout without installing it:

```bash
pi --no-extensions -e /path/to/pi-iterm2
```

After installing or changing configuration in a running Pi session, run `/reload` or restart Pi.

## Requirements

iTerm2 only. The extension auto-detects iTerm2 via `TERM_PROGRAM=iTerm.app` and does nothing on other terminals. It also does nothing outside interactive TUI mode (RPC, print, and JSON modes have no terminal to address) and outside a real TTY.

## Configuration

Defaults apply with no configuration file. Override in:

```text
~/.pi/agent/pi-iterm2.json
```

```json
{
  "enabled": "auto",
  "tabColor": true,
  "tabTitle": true,
  "currentDir": true,
  "userVars": true,
  "vscodeColor": true
}
```

- `enabled` — `"auto"` (default) detects iTerm2 via `TERM_PROGRAM`; `true`/`false` force it on or off (`true` is useful for terminals that also implement these sequences, and required on hosts reached over plain SSH — see below).
- `tabColor` — color-code the tab background by host/session/status.
- `tabTitle` — prefix a status icon on the tab title (see [How the tab title is chosen](#how-the-tab-title-is-chosen)).
- `currentDir` — emit iTerm2's native `CurrentDir`/`RemoteHost` sequences.
- `userVars` — publish `pi_cwd`, `pi_session`, `pi_status`, and `pi_host_color` as iTerm2 user-defined variables.
- `vscodeColor` — take the host's hue from the VS Code window color when one is set for this machine (see [Matching the VS Code window color](#matching-the-vs-code-window-color)). Set it to `false` to ignore that and use the palette or hash instead.
- `palette`, `hostColors`, `sessionHueSpread` — shape or override the automatic colors (see [Choosing your own colors](#choosing-your-own-colors)).

### SSH and `enabled: "auto"`

`TERM_PROGRAM` is a local environment variable your shell doesn't forward over SSH, so `"auto"` never activates the extension on a remote host — even though your client is genuinely iTerm2. Set `"enabled": true` in that host's `~/.pi/agent/pi-iterm2.json` to force it on there.

Missing configuration uses the defaults. Invalid JSON, unknown fields, and invalid option types produce a warning (shown once at session start) and fall back to the defaults.

## How tab color is chosen

Color is HSL, composed from three factors in priority order:

1. **Host** sets the hue. In order: a `hostColors` pin for this machine, else the [VS Code window color](#matching-the-vs-code-window-color) if one is set for it, else a `palette` entry, else `os.hostname()` hashed over the full wheel — the dominant, most visible difference between tabs on different machines.
2. **Session id** nudges that hue by up to ±20° — sessions on the same host land in the same color family but stay distinguishable.
3. **Status** sets saturation/lightness only, never hue: dim while idle, brighter while the agent is working, brightest when a dialog needs your input, and desaturated-but-marked when the most recently completed turn ended in a tool error (cleared as soon as a later turn succeeds, so a self-corrected run ends up looking normal, not stuck red).

### Choosing your own colors

By default every hue is hashed, so you get whatever the wheel gives you. Three options change that, from loosest to tightest:

```json
{
  "palette": ["#4a7ba7", "#a74a5c", "#4aa76b", 45],
  "hostColors": { "devbox": "#7a4aa7", "laptop": 200 },
  "sessionHueSpread": 0
}
```

- **`palette`** — hosts are assigned from these colors instead of the full 0–360° wheel, so everything stays in a set you picked while still being automatic for new machines.
- **`hostColors`** — pins named hosts explicitly. Wins over `palette`, and any host not listed still falls back to `palette`, then to the hash.
- **`sessionHueSpread`** — degrees of per-session nudge around the host hue (default `40`, i.e. ±20°). Set it to `0` to pin every session on a host to exactly that hue — worth doing if you pin colors and want precisely the color you named.

Colors are accepted either as `"#rrggbb"` or as a bare hue number (`0`–`359`). **Only the hue is used** from a hex color: saturation and lightness stay reserved for conveying status, so a pinned host still visibly brightens while the agent works. If you want the exact literal color instead, that trade-off isn't available — status signalling is the reason the tab is colored at all.

Rather than editing JSON and reloading to see the result, two commands change the live tab immediately and save the result to the same config file:

```
/iterm2-color                          show this host's current color and where it came from
/iterm2-color #4a7ba7                  pin this host (also accepts a bare hue, e.g. 208)
/iterm2-color clear                    unpin it

/iterm2-palette                        show the current palette
/iterm2-palette #4a7ba7 #a74a5c 45     set it
/iterm2-palette clear                  back to the full hue wheel
```

Each reported color is preceded by a swatch of the actual tab color it produces, so you can see the result inline — which matters most for `/iterm2-palette`, where a whole palette can be previewed at once even though a tab can only show one color at a time:

```
Palette set: ██ 0°  ██ 120°  ██ 240°
```

They rewrite `~/.pi/agent/pi-iterm2.json` in place, preserving any other settings in it, and store what you typed (`#4a7ba7` stays `#4a7ba7`) rather than the derived hue. `sessionHueSpread` has no command — it's a set-once preference, so edit the file for that.

Settings are per host: the file lives in the home directory of whichever machine pi runs on, and applies to every session there. Entries are keyed by hostname inside it, so one synced dotfile can carry a color per machine. Pi re-reads the file when a session is replaced, so `/new`, `/resume`, and `/fork` pick up hand-edits without restarting pi.

The tab color and user variables reset on session shutdown.

## How the tab title is chosen

The title follows pi's own default format exactly: `π - session - cwd` once the session has been given a name with `/name`, or just `π - cwd` until then — pi has no auto-generated session title, so an unnamed session's raw id isn't shown as one. Either way, a status icon is prefixed when there's something to flag:

| Status | Icon |
|---|---|
| idle | (none) |
| working | ◐ ◓ ◑ ◒ (spins through all four, once a second) |
| waiting (needs your input) | ◆ |
| error (most recent turn failed) | ✖ |

It's set at the same status-change points as the tab color (`agent_start`, `agent_settled`, `ui_prompt_start`/`ui_prompt_end`, plus `/name`), not at session start — pi's own default title at that point is already identical to what this would produce for an idle session, so there's nothing to add there. Pi manages the tab title itself only at session start, rename, and shutdown, and never during a turn, so this never fights with pi's own title updates.

The spin is a plain `setInterval` started at `agent_start` and stopped the moment status stops being "working" (settled, a dialog opens, session ends) — it never keeps ticking once idle.

## Matching the VS Code window color

If you color VS Code windows per machine — with [Peacock](https://marketplace.visualstudio.com/items?itemName=johnpapa.vscode-peacock), your platform's own tooling, or by hand — the tab picks up the same hue, so the terminal tab and the editor window agree without configuring anything twice.

The color is read from VS Code's **machine-scope** settings, whichever of these exists:

```text
~/.vscode-remote/data/Machine/settings.json
~/.vscode-server/data/Machine/settings.json
```

from `workbench.colorCustomizations`, taking the first of `titleBar.activeBackground`, `titleBar.inactiveBackground`, `activityBar.background` that holds a hex color. Machine scope is the one that describes the host: unlike user or workspace settings it doesn't follow you between machines, which is what makes it a sensible source for a per-host hue. Every hex form VS Code accepts works (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`); alpha is ignored, as are comments and trailing commas in the file.

As everywhere else, **only the hue is taken** — saturation and lightness stay reserved for agent status, so a machine matched to its editor still brightens while working. A `hostColors` pin outranks this, and anything unusable (no file, no color set, an empty `workbench.colorCustomizations`, an unparseable file) falls back to the palette and then the hash, silently.

The file is only ever read, never written, and only once per session — it describes the machine, so it effectively never changes mid-session. If you do change it while a session is open, `/iterm2-color refresh` re-reads it and recolors the tab.

To ignore VS Code entirely, set `"vscodeColor": false` in `~/.pi/agent/pi-iterm2.json`.

Note that a fully grey window color (some "black"/"charcoal" presets) has no hue at all and resolves to 0°, i.e. red. Pin the host with `/iterm2-color` if you'd rather have something else.

## Coloring tabs that aren't running pi

The tab color is three ordinary escape sequences, so a plain shell prompt can set the same color pi would — useful when you keep shells open on several machines and only some of them are running pi. `shell/tab_color.py` prints the escape for the current host and nothing else:

```bash
python3 shell/tab_color.py            # print the escape sequence
python3 shell/tab_color.py --check    # print what it resolved, and why
```

It reads the same `~/.pi/agent/pi-iterm2.json`, follows the same precedence (`hostColors` → VS Code window color → `palette` → hostname hash), uses the same hash and the same color math, and honors `enabled: false`, `tabColor: false` and `vscodeColor: false` — so one configuration covers both, and a shell tab and a pi tab on the same host are the exact same color. It only ever reads; it has no dependencies beyond the standard library, so it also works copied to a host on its own.

### bash

In `~/.bashrc`:

```bash
if [[ $- == *i* ]]; then
  PI_ITERM2_TAB_COLOR=$(python3 ~/path/to/pi-iterm2/shell/tab_color.py 2>/dev/null)
  pi_iterm2_tab_color() { printf %s "$PI_ITERM2_TAB_COLOR"; }
  [[ $PROMPT_COMMAND == *pi_iterm2_tab_color* ]] || PROMPT_COMMAND="pi_iterm2_tab_color${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
```

### zsh

Same idea in `~/.zshrc`, but zsh has no `PROMPT_COMMAND` — use a `precmd` hook:

```zsh
if [[ -o interactive ]]; then
  PI_ITERM2_TAB_COLOR=$(python3 ~/path/to/pi-iterm2/shell/tab_color.py 2>/dev/null)
  pi_iterm2_tab_color() { printf %s "$PI_ITERM2_TAB_COLOR" }
  (( ${precmd_functions[(Ie)pi_iterm2_tab_color]} )) || precmd_functions+=(pi_iterm2_tab_color)
fi
```

Both run the script **once per shell** and replay the captured escape from a prompt hook, so the per-prompt cost is a shell builtin rather than a Python start-up. Both are also safe to re-source: the guard keeps the hook from being registered twice.

The prompt hook matters for more than the first prompt: pi resets the tab color to the profile default when a session ends, so re-emitting on each prompt is what restores the host color after you exit pi.

Two limits worth knowing. A shell has no agent status, so this always emits the resting (idle) shade — the working/waiting/error brightness only happens while pi is running. And since `TERM_PROGRAM` isn't forwarded over SSH, the script can't detect iTerm2 and simply emits unconditionally; other terminals ignore these sequences, but if you also connect from a terminal where that isn't true, guard the snippet with a check of your own.

## tmux

Sequences are wrapped in tmux's DCS passthrough envelope (`ESC Ptmux; ... ESC \`) whenever `$TMUX` is set, so tab color and user vars work inside a tmux session running in iTerm2. This does not require `allow-passthrough` to be configured in tmux.

## Displaying host, cwd, and session id

`pi_cwd`, `pi_session`, `pi_status`, and `pi_host_color` are ordinary iTerm2 user-defined variables, referenceable as `\(user.pi_cwd)` etc. `pi_cwd`, `pi_session`, and `pi_host_color` are set at session start and when their values change; `pi_status` tracks the live agent status (`idle`/`working`/`waiting`/`error`), updating at the same moments as the tab color. `pi_host_color` is the resolved resting host color as `#rrggbb`, before the per-session nudge and live-status brightness. All four are cleared on session shutdown.

For **cwd and host specifically, prefer iTerm2's built-in variables instead**: `\(session.path)` and `\(session.hostname)` are auto-populated from the same `CurrentDir`/`RemoteHost` sequences this extension already sends, so `pi_cwd` is redundant with `session.path`. (`session.hostname`/`session.username` normally require iTerm2's own shell-integration script to be installed on the remote host — this extension's `RemoteHost` sequence populates them without that.) `pi_session` (the session id) has no iTerm2 built-in equivalent, since iTerm2 has no concept of it.

Put whichever combination you want in **Settings → Profiles → General → Badge**, a tab title format, or a status bar "Interpolated String" component, e.g.:
```
\(session.hostname) — \(user.pi_session)
```

`pi_cwd`/`session.path` reflect the session's project root (`ctx.cwd`), not a live shell `$PWD`: Pi's bash tool always runs from that same fixed directory, so there is no in-session directory to track — a `cd` inside a bash command only affects that one subprocess. The project root only changes when the session itself changes (`/new`, `/resume`, `/fork`), which is when it's refreshed.

Note that none of badge/title/status-bar text is mouse-selectable (it's UI chrome, not real terminal content).

## macOS companion daemon

`macos/pi_iterm2_daemon.py` is a standalone script that runs on the Mac, separately from the pi extension — it is not required for the tab color/user var/`CurrentDir` features above, which work without it. It records each tab's host, host color, `pi_cwd`, `pi_session`, and `pi_status` into `~/.pi-iterm2/state.json` (keyed by iTerm2 session id, capped at the 200 most recent), so that a tab restored after iTerm2, the local system, or the remote host restarts can say exactly where and how to resume its previous Pi session. The restored reminder and the `--check`/`--check-all` reports render each hostname in its recorded host color.

The reminder is injected **when the tab appears and no pi session is live in it** — i.e. while it's still showing a plain shell prompt — and deliberately not when pi later starts. `async_inject` delivers data as though it were program output, so injecting into a running pi TUI would land in a screen pi is actively repainting and be overwritten or corrupt it; a tab that already has a live pi session is skipped for the same reason.

### Prerequisites (once, on the Mac)

1. **Settings → General → Magic → Enable Python API**.
2. **Scripts → Install Python Runtime** (renamed to **Check for Updated Runtime** once this has been done before). This is what actually provisions iTerm2's bundled Python interpreter under `~/Library/Application Support/iTerm2/iterm2env/versions/`; it's a separate step from enabling the API and from installing the daemon file itself, and nothing here runs without it.

### If pi-iterm2 is installed locally on the Mac

Three commands, only registered when pi is running on macOS:

- `/iterm2-daemon-install` — copies the bundled daemon to `~/Library/Application Support/iTerm2/Scripts/AutoLaunch/pi_iterm2_daemon.py`. Safe to run again to pick up an update; it just overwrites.
- `/iterm2-daemon-check` — asks the running daemon for a report about the tab you're in: current live variables, what's stored, and exactly what would be printed if this tab were restored right now. Read-only.
- `/iterm2-daemon-check-all` — asks for the same report for every live session, plus a count of stored records whose tabs no longer exist.

The check commands use the running AutoLaunch daemon's already-authenticated iTerm2 connection through a user-only local socket at `~/.pi-iterm2/daemon.sock`. They do not start a second Python API client, because iTerm2's one-time authentication can reject programs launched as captured child processes (including Pi extension commands) even when the same command works in an ordinary shell.

After `/iterm2-daemon-install` (and the prerequisites above), restart iTerm2 for it to start running. Reinstall and restart after upgrading from a daemon version that does not yet provide the local check socket.

### Otherwise

None of this requires the pi extension — the daemon is a plain, standalone file. Download it straight from GitHub, from the Mac's own terminal:
```bash
mkdir -p ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch

curl -fsSL https://raw.githubusercontent.com/dreveman/pi-iterm2/main/macos/pi_iterm2_daemon.py \
  -o ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/pi_iterm2_daemon.py
```
`mkdir -p` first because that folder doesn't exist until iTerm2's Scripts/Python API has been used at least once. After the prerequisites above, restart iTerm2 — AutoLaunch scripts aren't hot-reloaded, so re-run the `curl` and restart iTerm2 again any time the daemon is updated. See the file's own header comment for how it works.

To check it manually, run it directly with `--check`, using iTerm2's bundled Python. iTerm2 can leave more than one entry under `versions/` (e.g. a stale one alongside a freshly installed runtime), so pick whichever has been modified most recently rather than assuming there's only one:
```bash
python3=$(ls -t ~/Library/Application\ Support/iTerm2/iterm2env/versions/*/bin/python3 2>/dev/null | head -1)
"$python3" ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/pi_iterm2_daemon.py --check
```
This is read-only — it never injects anything, just prints. Pass `--session <id>` to check a different tab than the one you're running it from.

`--check-all` covers every live session instead — all panes of all tabs of all windows, plus buried sessions. Tabs that have a stored record get the full report; the rest are summarized one line each (still showing whether pi is live in them), since a tab with no record has nothing to preview. The tab you ran it from is marked, and a closing line counts stored records belonging to tabs that no longer exist. It needs no `ITERM_SESSION_ID`, so it also works from outside iTerm2.

## Development

```bash
npm install
npm run verify
```

Individually:

```bash
npm run check   # tsc --noEmit
npm test        # runs test/run.ts under pi
npm run smoke   # loads the extension under pi
```

Before publishing, verify the tarball includes every runtime dependency:

```bash
npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE).
