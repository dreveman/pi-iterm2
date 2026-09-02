# pi-iterm2

**Never lose a Pi session after an iTerm2 or system restart.** The macOS companion daemon remembers the remote host, working directory, and Pi session ID for every tab. When iTerm2 restores a tab, it prints exactly what was running there:

```text
Last Pi session in this tab was 01abc... (idle) on devvm123 /home/me/project, 2m ago.
Run ssh -t -- me@devvm123 'cd -- /home/me/project && exec pi --session 01abc...' to restore this session.
```

The hostname is printed in that host's tab color, so it remains recognizable at a glance. The message tells you which host to reconnect to, which working directory to enter, and which exact Pi session to resume, followed by a shell-quoted command ready to copy and paste. Remote tabs without a Pi session get a command that reconnects and changes to their last directory; local shell tabs need no command because iTerm2 restores their cwd itself. The command is shown in bold without literal backticks, so copying it cannot accidentally invoke shell command substitution. The shell integration reads the newest matching state record while the shell rc file is sourced and prints it before Powerlevel10k's instant-prompt preamble, making it normal selectable startup output. Remote sessions are launched through `build_remote_launch_argv` (`ssh -t --` by default), so a deployment can override that function for another launcher. Recovery is independent of SSH, mosh, devserver tooling, or any other connection method because pi-iterm2 records session identity rather than managing the connection.

The extension also ties iTerm2 tabs to the live Pi sessions running in them:

- **Tab color** is derived from hostname (primary), session id (secondary nudge), and live agent status (idle/working/waiting/error) — so tabs on different machines are visually distinct, sessions on the same machine stay in the same color family, and a glance at the tab tells you whether that session needs attention.
- **Tab title** gets a status icon prefixed while there's something to flag (working/waiting/error), on top of pi's own default title.
- **cwd, session name and ID, status, resolved host color, and a per-Pi-instance token are published as iTerm2 user-defined variables** (`\(user.pi_cwd)`, `\(user.pi_session)`, `\(user.pi_session_id)`, `\(user.pi_status)`, `\(user.pi_host_color)`, `\(user.pi_instance)`), so the companion daemon and custom iTerm2 badges or titles can use them.
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
  "promptRestore": false,
  "vscodeColor": true
}
```

- `enabled` — `"auto"` (default) detects iTerm2 via `TERM_PROGRAM`; `true`/`false` force it on or off (`true` is useful for terminals that also implement these sequences, and required on hosts reached over plain SSH — see below).
- `tabColor` — color-code the tab background by host/session/status.
- `tabTitle` — prefix a status icon on the tab title (see [How the tab title is chosen](#how-the-tab-title-is-chosen)).
- `currentDir` — emit iTerm2's native `CurrentDir`/`RemoteHost` sequences.
- `userVars` — publish `pi_cwd`, `pi_session`, `pi_session_id`, `pi_status`, `pi_host_color`, and the internal `pi_instance` liveness token as iTerm2 user-defined variables.
- `promptRestore` — after printing a restore command, ask `Run it now? [y/N]`; a single `y`/`Y` runs it immediately without Enter, and any other key declines (default `false`; `/iterm2-install` can enable it).
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
| working | ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ (Pi's Working spinner, 80ms per frame) |
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

## Shell tabs without Pi

The installed shell integration treats ordinary shell tabs as the same recoverable tabs with optional Pi metadata. On the Mac it applies the host's resting identity color. On remote hosts it publishes `RemoteHost` and `CurrentDir` at each prompt using shell builtins, allowing the Mac recorder to store the remote host and cwd without Pi or Python. It uses the same `~/.pi/agent/pi-iterm2.json` precedence as Pi (`hostColors` → VS Code window color → `palette` → hostname hash).

After a restart, a tab with Pi metadata gets the exact `pi --session` resume command. A remote tab without a Pi session ID gets a command that reconnects, changes to the recorded directory, and opens an interactive login shell. A local shell tab needs no restore command because iTerm2 restores its cwd. Agent status brightness is naturally available only while Pi is running.

## tmux

Sequences are wrapped in tmux's DCS passthrough envelope (`ESC Ptmux; ... ESC \`) whenever `$TMUX` is set, so tab color and user vars work inside a tmux session running in iTerm2. This does not require `allow-passthrough` to be configured in tmux.

## Displaying host, cwd, and session id

`pi_cwd`, `pi_session`, `pi_session_id`, `pi_status`, `pi_host_color`, and `pi_instance` are ordinary iTerm2 user-defined variables, referenceable as `\(user.pi_cwd)` etc. `pi_cwd`, `pi_session`, `pi_session_id`, `pi_host_color`, and `pi_instance` are set at session start and when their values change; `pi_status` tracks the live agent status (`idle`/`working`/`waiting`/`error`), updating at the same moments as the tab color. `pi_session` is the display name when one is set (otherwise the ID), while `pi_session_id` is always the immutable ID accepted by `pi --session`. `pi_host_color` is the resolved resting host color as `#rrggbb`, before the per-session nudge and live-status brightness. `pi_instance` is a random token used by the companion daemon to distinguish a freshly started Pi from session variables restored after a force quit. All six are cleared on session shutdown.

For **cwd and host specifically, prefer iTerm2's built-in variables instead**: `\(session.path)` and `\(session.hostname)` are auto-populated from the same `CurrentDir`/`RemoteHost` sequences this extension already sends, so `pi_cwd` is redundant with `session.path`. (`session.hostname`/`session.username` normally require iTerm2's own shell-integration script to be installed on the remote host — this extension's `RemoteHost` sequence populates them without that.) `pi_session` and `pi_session_id` have no iTerm2 built-in equivalents, since iTerm2 has no concept of a Pi session.

Put whichever combination you want in **Settings → Profiles → General → Badge**, a tab title format, or a status bar "Interpolated String" component, e.g.:
```
\(session.hostname) — \(user.pi_session)
```

`pi_cwd`/`session.path` reflect the session's project root (`ctx.cwd`), not a live shell `$PWD`: Pi's bash tool always runs from that same fixed directory, so there is no in-session directory to track — a `cd` inside a bash command only affects that one subprocess. The project root only changes when the session itself changes (`/new`, `/resume`, `/fork`), which is when it's refreshed.

Note that none of badge/title/status-bar text is mouse-selectable (it's UI chrome, not real terminal content).

## macOS companion daemon

`macos/pi_iterm2_daemon.py` is a standalone script that runs on the Mac, separately from the Pi extension. It records each tab's built-in host and path plus any Pi session metadata into `~/.pi-iterm2/state.json` (keyed by iTerm2 session id, capped at the 200 most recent), so restored Pi and ordinary shell tabs can show an appropriate resume command. The restored reminder and check reports render each hostname in its recorded host color.

On a new iTerm2 application launch, the daemon merges completed `state.json` records into `state.previous.json` before recording the new launch. Records for tabs that were not resumed remain available across later restarts. Check reports combine both files, preferring a new record when the same tab has already been seen again and marking that record `(active)`; previous-only records are left unmarked.

The reminder is printed while a newly launched restored shell sources its rc file, before Powerlevel10k's instant-prompt preamble. Ordinary tabs print nothing. The reminder includes a shell-quoted command that changes to the recorded cwd and launches `pi --session` with the recorded session ID. Local sessions run directly; remote sessions use `build_remote_launch_argv`, which defaults to `ssh -t --` against the recorded `username@hostname` and can be replaced for other remote launchers.

### Prerequisites (once, on the Mac)

1. **Settings → General → Magic → Enable Python API**.
2. **Scripts → Install Python Runtime** (renamed to **Check for Updated Runtime** once this has been done before). This provisions iTerm2's bundled Python interpreter under `~/Library/Application Support/iTerm2/iterm2env/versions/`.
3. Add the installed shell integration to the local Mac shell configuration:
   ```zsh
   test -e "${HOME}/.pi-iterm2/shell.sh" && source "${HOME}/.pi-iterm2/shell.sh"
   ```
   Put it in `~/.zshrc` for zsh or `~/.bashrc` for bash. `/iterm2-install` places it before Powerlevel10k's instant-prompt preamble and can configure either or both files. A login bash setup must already source `~/.bashrc` from `~/.bash_profile`. The hook runs only in local, non-tmux iTerm2 shells and checks once per shell.

### If pi-iterm2 is installed locally on the Mac

One Pi command is registered when Pi runs on macOS:

- `/iterm2-install` — separately prompts to install or update the AutoLaunch recorder and the shell integration. Shell installation copies `~/.pi-iterm2/shell.sh` and its Python helper, can apply the same host identity to ordinary shell tabs, can enable the default-no restore execution prompt, and can add the guarded `test -e ... && source ...` line to `~/.zshrc` and `~/.bashrc`. Existing guarded lines are detected and unguarded source lines are upgraded, so rerunning it is safe.

Sourcing the hook adds two ordinary shell commands, available without starting Pi:

- `pi-iterm2-check` — report the current tab's stored record and reminder preview.
- `pi-iterm2-check-all` — report every stored tab record.

Both commands read `state.json` and `state.previous.json` directly; they do not require the recorder to be running.

On macOS, `/iterm2-install` offers the recorder, shell integration, and optional ordinary-shell host identity. On remote Linux hosts it skips the macOS recorder and installs only the shell hook, which publishes `RemoteHost` and `CurrentDir` using shell builtins—no Python runtime is required. After installation, reload the configured shell file or open a new shell. Restart iTerm2 after updating the macOS recorder.

### Otherwise

None of this requires the pi extension — the daemon is a plain, standalone file. Download it straight from GitHub, from the Mac's own terminal:
```bash
mkdir -p ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch

curl -fsSL https://raw.githubusercontent.com/dreveman/pi-iterm2/main/macos/pi_iterm2_daemon.py \
  -o ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/pi_iterm2_daemon.py
mkdir -p ~/.pi-iterm2
cp ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/pi_iterm2_daemon.py \
  ~/.pi-iterm2/pi_iterm2.py
curl -fsSL https://raw.githubusercontent.com/dreveman/pi-iterm2/main/shell/pi_iterm2_restore.sh \
  -o ~/.pi-iterm2/shell.sh
python3=$(ls -t ~/Library/Application\ Support/iTerm2/iterm2env/versions/*/bin/python3 2>/dev/null | head -1)
"$python3" ~/.pi-iterm2/pi_iterm2.py --refresh-record-index
```
`mkdir -p` first because that folder doesn't exist until iTerm2's Scripts/Python API has been used at least once. Add `test -e "${HOME}/.pi-iterm2/shell.sh" && source "${HOME}/.pi-iterm2/shell.sh"` to `~/.zshrc` or `~/.bashrc`, then restart iTerm2. A login bash setup must source `~/.bashrc` from `~/.bash_profile`. AutoLaunch scripts aren't hot-reloaded, so re-run the downloads and restart iTerm2 again any time the daemon is updated. See the file's own header comment for how it works.

After sourcing the hook, check the current tab or every stored session directly from the shell:

```bash
pi-iterm2-check
pi-iterm2-check-all
```

Both are read-only. `pi-iterm2-check --session <id>` targets a different tab.

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
