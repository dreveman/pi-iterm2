#!/usr/bin/env python3
"""Color an iTerm2 tab by host, for shells that aren't running pi.

The pi extension colors a tab while a session is live; this colors the same tab from a
plain shell prompt, using the same configuration and the same math, so a machine keeps one
identity whether or not pi happens to be running in that tab right now.

Prints the escape sequence to stdout and nothing else, so it can be captured into a shell
variable once and replayed by a prompt hook without forking again. See the README for the
bash and zsh snippets.

Deliberately standalone: no imports beyond the standard library, so it can be curl'd onto a
host and run there. `--check` prints what it resolved, and why, instead of the escape.

Only the resting (idle) color is available here. Saturation and lightness convey agent
status in the extension, and a shell has no agent, so this always emits the idle shade --
which is exactly the "which machine is this tab on" signal.
"""

import json
import math
import os
import re
import sys

HOME = os.path.expanduser("~")

# VS Code's machine-scope settings, the same two layouts the extension reads.
VSCODE_SETTINGS_PATHS = [
    os.path.join(HOME, ".vscode-remote", "data", "Machine", "settings.json"),
    os.path.join(HOME, ".vscode-server", "data", "Machine", "settings.json"),
]

# Entries of workbench.colorCustomizations that describe "the color of this window",
# most specific first. Mirrors VSCODE_COLOR_KEYS in extensions/core.ts.
VSCODE_COLOR_KEYS = [
    "titleBar.activeBackground",
    "titleBar.inactiveBackground",
    "activityBar.background",
]

CONFIG_PATH = os.path.join(HOME, ".pi", "agent", "pi-iterm2.json")

# STATUS_STYLE.idle in extensions/core.ts.
IDLE_SATURATION = 45
IDLE_LIGHTNESS = 30


def fnv1a(text):
    """FNV-1a 32-bit, byte-for-byte the same buckets as hashString() in core.ts."""
    hashed = 0x811C9DC5
    for char in text:
        hashed = ((hashed ^ ord(char)) * 0x01000193) & 0xFFFFFFFF
    return hashed


def rgb_to_hue(red, green, blue):
    """Hue in degrees [0,360). Grey has no meaningful hue, so it maps to 0."""
    r_n, g_n, b_n = red / 255, green / 255, blue / 255
    largest = max(r_n, g_n, b_n)
    delta = largest - min(r_n, g_n, b_n)
    if delta == 0:
        return 0.0
    if largest == r_n:
        sextant = ((g_n - b_n) / delta) % 6
    elif largest == g_n:
        sextant = (b_n - r_n) / delta + 2
    else:
        sextant = (r_n - g_n) / delta + 4
    return ((sextant * 60) % 360 + 360) % 360


def hue_from_css_hex(value):
    """#rgb, #rgba, #rrggbb, #rrggbbaa. Alpha is discarded along with saturation."""
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


def parse_color_spec(value):
    """A configured color: a hue in degrees, or a "#rrggbb" string, as core.ts accepts."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value % 360
    if not isinstance(value, str):
        return None
    text = value.strip()
    # Hex before a plain number, so a bare six-digit string stays a color.
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", text)
    if match is not None:
        digits = match.group(1)
        return rgb_to_hue(
            int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16)
        )
    if re.fullmatch(r"[+-]?\d+(\.\d+)?", text):
        return float(text) % 360
    return None


def hsl_to_rgb(hue, saturation, lightness):
    """Standard HSL -> RGB, matching hslToRgb() in core.ts including its rounding."""
    s_n, l_n = saturation / 100, lightness / 100
    chroma = (1 - abs(2 * l_n - 1)) * s_n
    sextant = (((hue % 360) + 360) % 360) / 60
    second = chroma * (1 - abs((sextant % 2) - 1))
    base = l_n - chroma / 2
    order = [
        (chroma, second, 0),
        (second, chroma, 0),
        (0, chroma, second),
        (0, second, chroma),
        (second, 0, chroma),
        (chroma, 0, second),
    ]
    red, green, blue = order[min(int(sextant), 5)]
    # Python round() uses ties-to-even; JavaScript Math.round() rounds positive
    # half-values up. RGB channels are nonnegative, so floor(x + 0.5) matches it.
    return tuple(
        math.floor((channel + base) * 255 + 0.5) for channel in (red, green, blue)
    )


def read_json(path):
    """Any unreadable or invalid file reads as absent: the caller always has a fallback."""
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def vscode_hue():
    """Hue of the VS Code window color for this machine, or None."""
    for path in VSCODE_SETTINGS_PATHS:
        settings = read_json(path)
        if not isinstance(settings, dict):
            continue
        colors = settings.get("workbench.colorCustomizations")
        # An empty dict is how the color gets turned off, and falls through as no color.
        if not isinstance(colors, dict):
            continue
        for key in VSCODE_COLOR_KEYS:
            value = colors.get(key)
            if isinstance(value, str):
                hue = hue_from_css_hex(value)
                if hue is not None:
                    return hue, "%s in %s" % (key, path)
    return None


def resolve(host, config):
    """(hue, source) for this host, following the extension's precedence exactly."""
    pinned = parse_color_spec((config.get("hostColors") or {}).get(host))
    if pinned is not None:
        return pinned, "hostColors pin"

    if config.get("vscodeColor", True):
        found = vscode_hue()
        if found is not None:
            return found[0], "VS Code window color (%s)" % found[1]

    palette = [
        hue
        for hue in (parse_color_spec(entry) for entry in (config.get("palette") or []))
        if hue is not None
    ]
    if palette:
        return palette[fnv1a("host:%s" % host) % len(palette)], "palette"
    return float(fnv1a("host:%s" % host) % 360), "hostname hash"


def colored_text(text, rgb):
    """Render text in a truecolor foreground without resetting other attributes."""
    return "\x1b[38;2;%d;%d;%dm%s\x1b[39m" % (rgb + (text,))


def tab_color_sequence(rgb):
    """The same three OSC 6 sequences buildTabColorSequence() emits, in the same order."""
    return "".join(
        "\x1b]6;1;bg;%s;brightness;%d\x07" % (name, value)
        for name, value in (("red", rgb[0]), ("green", rgb[1]), ("blue", rgb[2]))
    )


def wrap_for_tmux(sequence):
    """tmux's DCS passthrough envelope, with inner ESC bytes doubled."""
    return "\x1bPtmux;" + sequence.replace("\x1b", "\x1b\x1b") + "\x1b\\"


def main():
    check = "--check" in sys.argv[1:]
    host = os.uname().nodename
    config = read_json(CONFIG_PATH) or {}

    # Honor the same off switches as the extension, so one config disables both.
    disabled = None
    if config.get("enabled") is False:
        disabled = "enabled is false in %s" % CONFIG_PATH
    elif config.get("tabColor") is False:
        disabled = "tabColor is false in %s" % CONFIG_PATH

    if disabled is not None:
        if check:
            print("host:     %s" % host)
            print("disabled: %s" % disabled)
        return

    hue, source = resolve(host, config)
    rgb = hsl_to_rgb(hue, IDLE_SATURATION, IDLE_LIGHTNESS)
    sequence = tab_color_sequence(rgb)
    if os.environ.get("TMUX"):
        sequence = wrap_for_tmux(sequence)

    if check:
        print("host:   %s" % colored_text(host, rgb))
        print("hue:    %.1f deg" % hue)
        print("source: %s" % source)
        print(
            "color:  rgb(%d,%d,%d)  #%02x%02x%02x  \x1b[48;2;%d;%d;%dm  \x1b[49m"
            % (rgb + rgb + rgb)
        )
        print(
            "tmux:   %s"
            % ("yes, wrapping in DCS passthrough" if os.environ.get("TMUX") else "no")
        )
        return

    sys.stdout.write(sequence)


if __name__ == "__main__":
    main()
