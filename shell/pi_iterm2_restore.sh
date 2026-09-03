# shellcheck shell=bash
# pi-iterm2 restored-session pre-prompt hook.
# Source this from ~/.zshrc or ~/.bashrc: on the Mac running iTerm2 for restore reminders,
# and on any host, local or remote, for the host color and the host/cwd sequences. Only the
# reminder needs the Mac's Python helper; everything else is shell builtins.

# shellcheck disable=SC2012 # ls -t is the newest-by-mtime pick; find -printf is GNU-only (absent on macOS)
_pi_iterm2_run_helper() {
  local runtime helper
  runtime=$(ls -t "$HOME"/Library/Application\ Support/iTerm2/iterm2env/versions/*/bin/python3 2>/dev/null | head -n 1)
  helper="$HOME/.pi-iterm2/pi_iterm2.py"
  if [[ -z $runtime || ! -x $runtime || ! -f $helper ]]; then
    printf '%s\n' "pi-iterm2 helper or iTerm2 Python runtime is not installed" >&2
    return 127
  fi
  "$runtime" "$helper" "$@"
}

pi-iterm2-check() {
  _pi_iterm2_run_helper --check "$@"
}

pi-iterm2-check-all() {
  _pi_iterm2_run_helper --check-all "$@"
}

pi-iterm2-identity() {
  local sequence source host hue
  _pi_iterm2_shell_identity_color
  sequence=$_pi_iterm2_identity_sequence
  source=$_pi_iterm2_identity_source
  host=$_pi_iterm2_identity_host
  if [[ -z $sequence ]]; then
    printf 'host:     %s\n' "$host"
    printf 'disabled: %s\n' "$source"
    return 0
  fi
  hue=$_pi_iterm2_identity_hue
  printf 'host:   \033[38;2;%d;%d;%dm%s\033[39m\n' \
    "$_pi_iterm2_red" "$_pi_iterm2_green" "$_pi_iterm2_blue" "$host"
  printf 'hue:    %d.%03d deg\n' "$((hue / 1000))" "$((hue % 1000))"
  printf 'source: %s\n' "$source"
  printf 'color:  rgb(%d,%d,%d)  #%02x%02x%02x\n' \
    "$_pi_iterm2_red" "$_pi_iterm2_green" "$_pi_iterm2_blue" \
    "$_pi_iterm2_red" "$_pi_iterm2_green" "$_pi_iterm2_blue"
}

_pi_iterm2_sanitize_osc() {
  REPLY=$1
  REPLY=${REPLY//$'\e'/}
  REPLY=${REPLY//$'\a'/}
  REPLY=${REPLY//$'\r'/}
  REPLY=${REPLY//$'\n'/}
}

# shellcheck disable=SC2319 # $? is the caller's status at hook entry; a separate `local` line would capture local's own status instead
_pi_iterm2_publish_location() {
  local previous_status=$?
  if [[ ${PI_ITERM2_SKIP_NEXT_LOCATION_HOOK:-} == 1 ]]; then
    unset PI_ITERM2_SKIP_NEXT_LOCATION_HOOK
    return "$previous_status"
  fi
  # REPLY is declared local so the sanitizer's writes cannot clobber the REPLY the user's own
  # shell config or another precmd hook may rely on; this hook runs at every prompt.
  local user=${USER:-unknown} host=${HOSTNAME:-${HOST:-unknown}} cwd=${PWD:-} sequence REPLY
  _pi_iterm2_sanitize_osc "$user"; user=$REPLY
  _pi_iterm2_sanitize_osc "$host"; host=$REPLY
  _pi_iterm2_sanitize_osc "$cwd"; cwd=$REPLY
  sequence=$'\e]1337;RemoteHost='"${user}@${host}"$'\a\e]1337;CurrentDir='"${cwd}"$'\a'
  if [[ -n ${TMUX:-} ]]; then
    sequence=${sequence//$'\e'/$'\e\e'}
    # ANSI-C quoting keeps the DCS wrapper out of the printf format string (no SC1003), and
    # %s keeps the payload out of it too, matching how the identity hook builds its sequence.
    printf '%s' $'\ePtmux;'"$sequence"$'\e\\'
  else
    printf '%s' "$sequence"
  fi
  return "$previous_status"
}

# --------------------------------------------------------------------------------------
# Host identity color, resolved with shell builtins only.
#
# Pi and the macOS recorder derive a tab color from ~/.pi/agent/pi-iterm2.json. This hook
# repeats that derivation in the shell so the same condition that publishes RemoteHost and
# CurrentDir can also paint the tab: no Python runtime, no iTerm2 Python API, and therefore
# the same behavior on a Mac and on a remote host. Precedence matches hostHue() in core.ts:
# a hostColors pin, then the VS Code window color for this machine, then a configured
# palette, then the hostname hash. Hues are integer millidegrees because bash has no
# floating-point arithmetic; test/daemon_test.py pins the results against core.ts's.
# --------------------------------------------------------------------------------------

# A JSON reader small enough to live in an rc file. Values are consumed from the front of
# $_pi_iterm2_json_rest, which nested calls share by dynamic scoping in both bash and zsh.
# Comments and trailing commas are tolerated the way core.ts's JSONC fallback tolerates
# them, because VS Code writes settings.json with comments.
_pi_iterm2_json_skip_ws() {
  local trimmed run
  while :; do
    case $_pi_iterm2_json_rest in
      [$' \t\n\r']*)
        # A whole run at a time: every pattern operator rescans the remaining text, so
        # stepping over indentation one character at a time is what makes a parser like this
        # slow on a real settings file.
        run="${_pi_iterm2_json_rest%%[![:space:]]*}"
        _pi_iterm2_json_rest=${_pi_iterm2_json_rest#"$run"}
        ;;
      '//'*)
        # %% finds the first delimiter in one left-to-right pass, where the tempting #*delim
        # form makes a fresh match attempt per prefix and so costs O(length squared).
        trimmed=${_pi_iterm2_json_rest%%$'\n'*}
        if [[ $trimmed == "$_pi_iterm2_json_rest" ]]; then
          _pi_iterm2_json_rest=
        else
          _pi_iterm2_json_rest=${_pi_iterm2_json_rest:$((${#trimmed} + 1))}
        fi
        ;;
      '/*'*)
        trimmed=${_pi_iterm2_json_rest:2}
        run=${trimmed%%'*/'*}
        if [[ $run == "$trimmed" ]]; then
          _pi_iterm2_json_rest=
        else
          _pi_iterm2_json_rest=${trimmed:$((${#run} + 2))}
        fi
        ;;
      *) return 0 ;;
    esac
  done
}

# Decodes the string at the front of the input into REPLY. A \u escape outside the shell's
# representable range stands for nothing, since no key or color this hook compares needs it.
_pi_iterm2_json_string() {
  local out='' chunk char code
  _pi_iterm2_json_rest=${_pi_iterm2_json_rest#\"}
  while :; do
    chunk=${_pi_iterm2_json_rest%%[\"\\]*}
    [[ $chunk == "$_pi_iterm2_json_rest" ]] && { REPLY=; return 1; }
    out+=$chunk
    _pi_iterm2_json_rest=${_pi_iterm2_json_rest#"$chunk"}
    char=${_pi_iterm2_json_rest:0:1}
    _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
    if [[ $char == '"' ]]; then
      REPLY=$out
      return 0
    fi
    char=${_pi_iterm2_json_rest:0:1}
    _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
    case $char in
      '"' | \\ | /) out+=$char ;;
      b) out+=$'\b' ;;
      f) out+=$'\f' ;;
      n) out+=$'\n' ;;
      r) out+=$'\r' ;;
      t) out+=$'\t' ;;
      u)
        code=${_pi_iterm2_json_rest:0:4}
        _pi_iterm2_json_rest=${_pi_iterm2_json_rest:4}
        [[ ${#code} == 4 && -z ${code//[0-9a-fA-F]/} ]] || { REPLY=; return 1; }
        case $code in
          0000 | [dD][89abAB]??) ;;
          # %b keeps $code out of the format string (the digits are validated hex, but this
          # also satisfies SC2059) while still expanding printf's own \uXXXX escape.
          *) out+=$(printf '%b' "\\u$code") ;;
        esac
        ;;
      *) REPLY=; return 1 ;;
    esac
  done
}

# Consumes the balanced remainder of an object or array, keeping strings opaque so a brace
# inside one cannot unbalance the scan. Runs of uninteresting characters go in one step,
# which keeps a large settings.json cheap enough to parse at every shell start.
_pi_iterm2_json_skip_container() {
  local depth=0 chunk
  while :; do
    # The closing brace needs both the backslash and the surrounding quotes: unescaped it
    # would end the expansion, and unquoted zsh's parser still trips over it.
    chunk="${_pi_iterm2_json_rest%%[][{\}\"]*}"
    [[ $chunk == "$_pi_iterm2_json_rest" ]] && return 1
    _pi_iterm2_json_rest=${_pi_iterm2_json_rest#"$chunk"}
    case ${_pi_iterm2_json_rest:0:1} in
      '{' | '[')
        depth=$((depth + 1))
        _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
        ;;
      '}' | ']')
        depth=$((depth - 1))
        _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
        ((depth == 0)) && return 0
        ;;
      *) _pi_iterm2_json_string || return 1 ;;
    esac
  done
}

# Consumes one value, reporting its kind in $_pi_iterm2_json_type and its source text in
# $_pi_iterm2_json_raw so a container can be rescanned without a second pass over the file.
_pi_iterm2_json_value() {
  # zsh reserves $status, so the deferred result needs a name of its own.
  local before outcome=0
  _pi_iterm2_json_skip_ws
  before=$_pi_iterm2_json_rest
  case $_pi_iterm2_json_rest in
    '{'*)
      _pi_iterm2_json_type=object
      _pi_iterm2_json_skip_container || outcome=1
      ;;
    '['*)
      _pi_iterm2_json_type=array
      _pi_iterm2_json_skip_container || outcome=1
      ;;
    '"'*)
      _pi_iterm2_json_type=string
      _pi_iterm2_json_string || outcome=1
      ;;
    true*)
      _pi_iterm2_json_type=true
      _pi_iterm2_json_rest=${_pi_iterm2_json_rest#true}
      ;;
    false*)
      _pi_iterm2_json_type=false
      _pi_iterm2_json_rest=${_pi_iterm2_json_rest#false}
      ;;
    null*)
      _pi_iterm2_json_type=null
      _pi_iterm2_json_rest=${_pi_iterm2_json_rest#null}
      ;;
    [-0-9]*)
      _pi_iterm2_json_type=number
      while :; do
        case $_pi_iterm2_json_rest in
          [-+.0-9eE]*) _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?} ;;
          *) break ;;
        esac
      done
      ;;
    *)
      _pi_iterm2_json_type=
      outcome=1
      ;;
  esac
  _pi_iterm2_json_raw=${before:0:$((${#before} - ${#_pi_iterm2_json_rest}))}
  return $outcome
}

# Looks up one member of the object whose source text is $1. On success the member's kind is
# in $_pi_iterm2_json_type and its source text in $_pi_iterm2_json_raw.
_pi_iterm2_json_object_get() {
  local _pi_iterm2_json_rest=$1 key=$2 name
  _pi_iterm2_json_type=
  _pi_iterm2_json_raw=
  _pi_iterm2_json_skip_ws
  [[ ${_pi_iterm2_json_rest:0:1} == '{' ]] || return 1
  _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
  while :; do
    _pi_iterm2_json_skip_ws
    case ${_pi_iterm2_json_rest:0:1} in
      ',')
        _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
        continue
        ;;
      '"') ;;
      *)
        _pi_iterm2_json_type=
        _pi_iterm2_json_raw=
        return 1
        ;;
    esac
    _pi_iterm2_json_string || return 1
    name=$REPLY
    _pi_iterm2_json_skip_ws
    [[ ${_pi_iterm2_json_rest:0:1} == ':' ]] || return 1
    _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
    _pi_iterm2_json_value || return 1
    [[ $name == "$key" ]] && return 0
  done
}

# Finds one member of a possibly large object without walking the members before it: cut at
# each occurrence of the key's own quoted text and keep the first cut that really parses as a
# member. A settings.json runs to tens of kilobytes, and since every pattern operator rescans
# the remaining text, walking hundreds of members would cost the better part of a second at
# every shell start. The first occurrence that parses is the outermost one in document order,
# which is the one core.ts reads; a copy of the text inside some other value fails to parse
# here and is skipped.
_pi_iterm2_json_find_member() {
  local text=$1 quoted="\"$2\"" prefix
  while :; do
    prefix=${text%%"$quoted"*}
    if [[ $prefix == "$text" ]]; then
      _pi_iterm2_json_type=
      _pi_iterm2_json_raw=
      return 1
    fi
    text=${text:$((${#prefix} + ${#quoted}))}
    local _pi_iterm2_json_rest=$text
    _pi_iterm2_json_skip_ws
    if [[ ${_pi_iterm2_json_rest:0:1} == ':' ]]; then
      _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
      _pi_iterm2_json_value && return 0
    fi
  done
}

# Splits the array whose source text is $1 into $_pi_iterm2_json_items, one element of raw
# source text per entry.
_pi_iterm2_json_array_items() {
  local _pi_iterm2_json_rest=$1
  _pi_iterm2_json_items=()
  _pi_iterm2_json_skip_ws
  [[ ${_pi_iterm2_json_rest:0:1} == '[' ]] || return 1
  _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
  while :; do
    _pi_iterm2_json_skip_ws
    case ${_pi_iterm2_json_rest:0:1} in
      ']')
        _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
        return 0
        ;;
      ',')
        _pi_iterm2_json_rest=${_pi_iterm2_json_rest#?}
        continue
        ;;
      '') return 1 ;;
    esac
    _pi_iterm2_json_value || return 1
    _pi_iterm2_json_items+=("$_pi_iterm2_json_raw")
  done
}

_pi_iterm2_trim() {
  REPLY=$1
  while [[ $REPLY == [$' \t\n\r']* ]]; do REPLY=${REPLY#?}; done
  while [[ $REPLY == *[$' \t\n\r'] ]]; do REPLY=${REPLY%?}; done
}

# FNV-1a 32-bit, identical to hashString() in core.ts and fnv1a() in the recorder. printf -v
# reads a character code without forking, so a hostname costs no subprocesses.
_pi_iterm2_hash() {
  local text=$1 index=0 length=${#1} code hashed=$((0x811c9dc5))
  while ((index < length)); do
    printf -v code '%d' "'${text:$index:1}"
    hashed=$((((hashed ^ code) * 0x01000193) & 0xffffffff))
    index=$((index + 1))
  done
  REPLY=$hashed
}

# Hues are integers in millidegrees throughout, because bash has no floating-point
# arithmetic. A thousandth of a degree is far finer than the 1/255 quantization of the
# channel values it feeds, so the result agrees with the float implementations exactly.
_pi_iterm2_hue_from_rgb() {
  local red=$1 green=$2 blue=$3 largest=$1 smallest=$1 delta hue
  ((green > largest)) && largest=$green
  ((blue > largest)) && largest=$blue
  ((green < smallest)) && smallest=$green
  ((blue < smallest)) && smallest=$blue
  delta=$((largest - smallest))
  if ((delta == 0)); then
    REPLY=0
    return 0
  fi
  if ((largest == red)); then
    hue=$((60000 * (green - blue) / delta))
  elif ((largest == green)); then
    hue=$((60000 * (blue - red) / delta + 120000))
  else
    hue=$((60000 * (red - green) / delta + 240000))
  fi
  REPLY=$(((hue % 360000 + 360000) % 360000))
}

_pi_iterm2_hue_from_hex() {
  _pi_iterm2_hue_from_rgb "$((16#${1:0:2}))" "$((16#${1:2:2}))" "$((16#${1:4:2}))"
}

# "[+-]digits[.digits]" to millidegrees, the text form parseColorSpec() accepts. Base 10 is
# forced so a zero-padded value is not read as octal.
_pi_iterm2_decimal_milli() {
  local text=$1 sign=1 whole fraction=
  case $text in
    -*)
      sign=-1
      text=${text#-}
      ;;
    +*) text=${text#+} ;;
  esac
  whole=${text%%.*}
  [[ -n $whole && -z ${whole//[0-9]/} ]] || return 1
  if [[ $text == *.* ]]; then
    fraction=${text#*.}
    [[ -n $fraction && -z ${fraction//[0-9]/} ]] || return 1
  fi
  fraction=${fraction}000
  fraction=${fraction:0:3}
  REPLY=$((sign * ((10#$whole) * 1000 + (10#$fraction))))
}

# One configured color, given as raw JSON: a hue number, or a string holding "#rrggbb" or a
# hue. Hex is matched first so "123456" stays a color rather than becoming hue 123456,
# exactly as parseColorSpec() decides it.
_pi_iterm2_color_spec_hue() {
  local raw=$1 text hex
  case $raw in
    '"'*)
      local _pi_iterm2_json_rest=$raw
      _pi_iterm2_json_string || return 1
      text=$REPLY
      ;;
    *) text=$raw ;;
  esac
  _pi_iterm2_trim "$text"
  text=$REPLY
  hex=${text#\#}
  if [[ ${#hex} == 6 && -z ${hex//[0-9a-fA-F]/} ]]; then
    _pi_iterm2_hue_from_hex "$hex"
    return 0
  fi
  _pi_iterm2_decimal_milli "$text" || return 1
  REPLY=$(((REPLY % 360000 + 360000) % 360000))
}

# A CSS hex color in any form VS Code accepts: #rgb, #rgba, #rrggbb, #rrggbbaa. The leading
# # is required here, unlike a configured color, so shorthand cannot change what a bare
# number means there. Alpha is dropped along with saturation and lightness.
_pi_iterm2_css_hex_hue() {
  local text digits
  _pi_iterm2_trim "$1"
  text=$REPLY
  [[ $text == '#'* ]] || return 1
  digits=${text#\#}
  [[ -n $digits && -z ${digits//[0-9a-fA-F]/} ]] || return 1
  case ${#digits} in
    3 | 4) digits="${digits:0:1}${digits:0:1}${digits:1:1}${digits:1:1}${digits:2:1}${digits:2:1}" ;;
    6 | 8) digits=${digits:0:6} ;;
    *) return 1 ;;
  esac
  _pi_iterm2_hue_from_hex "$digits"
}

# Standard HSL to RGB, in millionths. $1 is a hue in millidegrees, $2 and $3 are percentages.
# Rounding is floor(x + 0.5) to match Math.round() in core.ts rather than Python's banker's
# rounding. Sets $_pi_iterm2_red, $_pi_iterm2_green, and $_pi_iterm2_blue.
_pi_iterm2_hsl_rgb() {
  local hue=$(((($1 % 360000) + 360000) % 360000))
  local saturation=$(($2 * 10000)) lightness=$(($3 * 10000))
  local spread=$((2 * lightness - 1000000))
  ((spread < 0)) && spread=$((-spread))
  local chroma=$(((1000000 - spread) * saturation / 1000000))
  local sextant=$((hue * 1000 / 60))
  local index=$((sextant / 1000000))
  ((index > 5)) && index=5
  local offset=$((sextant % 2000000 - 1000000))
  ((offset < 0)) && offset=$((-offset))
  local second=$((chroma * (1000000 - offset) / 1000000))
  local base=$((lightness - chroma / 2))
  local first=0 middle=0 last=0
  case $index in
    0) first=$chroma middle=$second ;;
    1) first=$second middle=$chroma ;;
    2) middle=$chroma last=$second ;;
    3) middle=$second last=$chroma ;;
    4) first=$second last=$chroma ;;
    *) first=$chroma last=$second ;;
  esac
  _pi_iterm2_red=$(((first + base) * 255 + 500000))
  _pi_iterm2_red=$((_pi_iterm2_red / 1000000))
  _pi_iterm2_green=$(((middle + base) * 255 + 500000))
  _pi_iterm2_green=$((_pi_iterm2_green / 1000000))
  _pi_iterm2_blue=$(((last + base) * 255 + 500000))
  _pi_iterm2_blue=$((_pi_iterm2_blue / 1000000))
}

# Hue of the VS Code window color for this machine, or failure when there is none. Machine
# scope is the right scope: it describes the host, which is what the tab hue conveys, and it
# does not travel between machines. Both remote server layouts are checked because the
# directory name differs by VS Code flavor.
_pi_iterm2_vscode_hue() {
  local path settings colors key
  for path in "$HOME/.vscode-remote/data/Machine/settings.json" "$HOME/.vscode-server/data/Machine/settings.json"; do
    [[ -r $path ]] || continue
    settings=$(<"$path") || continue
    _pi_iterm2_json_find_member "$settings" workbench.colorCustomizations || continue
    [[ $_pi_iterm2_json_type == object ]] || continue
    colors=$_pi_iterm2_json_raw
    for key in titleBar.activeBackground titleBar.inactiveBackground activityBar.background; do
      _pi_iterm2_json_object_get "$colors" "$key" || continue
      [[ $_pi_iterm2_json_type == string ]] || continue
      local _pi_iterm2_json_rest=$_pi_iterm2_json_raw
      _pi_iterm2_json_string || continue
      _pi_iterm2_css_hex_hue "$REPLY" || continue
      _pi_iterm2_identity_source="$key in $path"
      return 0
    done
  done
  return 1
}

# Resolves this host's resting color. $_pi_iterm2_identity_sequence is the escape sequence
# that paints it, empty when the config turns the tab color off. $_pi_iterm2_identity_source
# explains the choice for pi-iterm2-identity, and $_pi_iterm2_identity_hue plus the channel
# variables hold the color. REPLY is local so none of the helper return values disturb the
# REPLY the caller's shell may rely on.
_pi_iterm2_shell_identity_color() {
  local config_path=$HOME/.pi/agent/pi-iterm2.json
  local config='' host entry count=0 index=0 sequence hues=() REPLY
  _pi_iterm2_sanitize_osc "${HOSTNAME:-${HOST:-unknown}}"
  host=$REPLY
  _pi_iterm2_identity_host=$host
  _pi_iterm2_identity_hue=0
  _pi_iterm2_identity_source=
  [[ -r $config_path ]] && config=$(<"$config_path")

  # Only an explicit false turns the color off; "auto" is about Pi's own activation, and the
  # marker file is what opts an ordinary shell in.
  if [[ -n $config ]]; then
    if _pi_iterm2_json_object_get "$config" enabled && [[ $_pi_iterm2_json_type == false ]]; then
      _pi_iterm2_identity_source="enabled is false in $config_path"
      _pi_iterm2_identity_sequence=
      return 0
    fi
    if _pi_iterm2_json_object_get "$config" tabColor && [[ $_pi_iterm2_json_type == false ]]; then
      _pi_iterm2_identity_source="tabColor is false in $config_path"
      _pi_iterm2_identity_sequence=
      return 0
    fi
  fi

  if _pi_iterm2_json_object_get "$config" hostColors && [[ $_pi_iterm2_json_type == object ]] &&
    _pi_iterm2_json_object_get "$_pi_iterm2_json_raw" "$host" &&
    _pi_iterm2_color_spec_hue "$_pi_iterm2_json_raw"; then
    _pi_iterm2_identity_hue=$REPLY
    _pi_iterm2_identity_source="hostColors pin"
  elif { ! _pi_iterm2_json_object_get "$config" vscodeColor || [[ $_pi_iterm2_json_type != false ]]; } &&
    _pi_iterm2_vscode_hue; then
    _pi_iterm2_identity_hue=$REPLY
    _pi_iterm2_identity_source="VS Code window color ($_pi_iterm2_identity_source)"
  else
    if _pi_iterm2_json_object_get "$config" palette && [[ $_pi_iterm2_json_type == array ]] &&
      _pi_iterm2_json_array_items "$_pi_iterm2_json_raw"; then
      for entry in "${_pi_iterm2_json_items[@]}"; do
        _pi_iterm2_color_spec_hue "$entry" && hues+=("$REPLY")
      done
      count=${#hues[@]}
    fi
    _pi_iterm2_hash "host:$host"
    if ((count > 0)); then
      index=$((REPLY % count))
      for entry in "${hues[@]}"; do
        ((index == 0)) && {
          _pi_iterm2_identity_hue=$entry
          break
        }
        index=$((index - 1))
      done
      _pi_iterm2_identity_source=palette
    else
      _pi_iterm2_identity_hue=$(((REPLY % 360) * 1000))
      _pi_iterm2_identity_source="hostname hash"
    fi
  fi

  # The resting color is the idle status color: hue carries the host, and brightness stays
  # reserved for the agent status Pi reports while it runs.
  _pi_iterm2_hsl_rgb "$_pi_iterm2_identity_hue" 45 30
  sequence=$'\e]6;1;bg;red;brightness;'"$_pi_iterm2_red"$'\a\e]6;1;bg;green;brightness;'"$_pi_iterm2_green"$'\a\e]6;1;bg;blue;brightness;'"$_pi_iterm2_blue"$'\a'
  if [[ -n ${TMUX:-} ]]; then
    sequence=${sequence//$'\e'/$'\e\e'}
    sequence=$'\ePtmux;'"$sequence"$'\e\\'
  fi
  _pi_iterm2_identity_sequence=$sequence
}

# shellcheck disable=SC2319 # $? is the caller's status at hook entry; a separate `local` line would capture local's own status instead
pi_iterm2_shell_identity() {
  local previous_status=$?
  if [[ ${PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK:-} == 1 ]]; then
    unset PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK
    return "$previous_status"
  fi
  [[ -n ${PI_ITERM2_SHELL_IDENTITY:-} ]] && printf '%s' "$PI_ITERM2_SHELL_IDENTITY"
  return "$previous_status"
}

# shellcheck disable=SC2178 # PROMPT_COMMAND is intentionally handled as both an array and a string (both bash forms)
_pi_iterm2_unregister_shell_identity() {
  if [[ -n ${ZSH_VERSION:-} ]]; then
    autoload -Uz add-zsh-hook
    add-zsh-hook -d precmd pi_iterm2_shell_identity 2>/dev/null || true
    add-zsh-hook -d precmd pi_iterm2_tab_color 2>/dev/null || true
  elif [[ -n ${BASH_VERSION:-} ]]; then
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
      _pi_iterm2_prompt_commands=()
      for _pi_iterm2_hook in "${PROMPT_COMMAND[@]}"; do
        [[ $_pi_iterm2_hook != pi_iterm2_shell_identity && $_pi_iterm2_hook != pi_iterm2_tab_color ]] && _pi_iterm2_prompt_commands+=("$_pi_iterm2_hook")
      done
      PROMPT_COMMAND=("${_pi_iterm2_prompt_commands[@]}")
      unset _pi_iterm2_hook _pi_iterm2_prompt_commands
    else
      case ${PROMPT_COMMAND:-} in
        pi_iterm2_shell_identity) PROMPT_COMMAND="" ;;
        pi_iterm2_shell_identity\;*)
          PROMPT_COMMAND=${PROMPT_COMMAND#pi_iterm2_shell_identity;}
          PROMPT_COMMAND=${PROMPT_COMMAND# }
          ;;
        *\;pi_iterm2_shell_identity) PROMPT_COMMAND=${PROMPT_COMMAND%;pi_iterm2_shell_identity} ;;
        pi_iterm2_tab_color) PROMPT_COMMAND="" ;;
        pi_iterm2_tab_color\;*)
          PROMPT_COMMAND=${PROMPT_COMMAND#pi_iterm2_tab_color;}
          PROMPT_COMMAND=${PROMPT_COMMAND# }
          ;;
        *\;pi_iterm2_tab_color) PROMPT_COMMAND=${PROMPT_COMMAND%;pi_iterm2_tab_color} ;;
      esac
    fi
  fi
}

# shellcheck disable=SC2178 # PROMPT_COMMAND is intentionally handled as both an array and a string (both bash forms)
_pi_iterm2_unregister_location_hook() {
  if [[ -n ${ZSH_VERSION:-} ]]; then
    autoload -Uz add-zsh-hook
    add-zsh-hook -d precmd _pi_iterm2_publish_location 2>/dev/null || true
  elif [[ -n ${BASH_VERSION:-} ]]; then
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
      _pi_iterm2_prompt_commands=()
      for _pi_iterm2_hook in "${PROMPT_COMMAND[@]}"; do
        [[ $_pi_iterm2_hook != _pi_iterm2_publish_location ]] && _pi_iterm2_prompt_commands+=("$_pi_iterm2_hook")
      done
      PROMPT_COMMAND=("${_pi_iterm2_prompt_commands[@]}")
      unset _pi_iterm2_hook _pi_iterm2_prompt_commands
    else
      case ${PROMPT_COMMAND:-} in
        _pi_iterm2_publish_location) PROMPT_COMMAND="" ;;
        _pi_iterm2_publish_location\;*) PROMPT_COMMAND=${PROMPT_COMMAND#_pi_iterm2_publish_location;} ;;
        *\;_pi_iterm2_publish_location) PROMPT_COMMAND=${PROMPT_COMMAND%;_pi_iterm2_publish_location} ;;
      esac
    fi
  fi
}

# shellcheck disable=SC2178 # PROMPT_COMMAND is intentionally handled as both an array and a string (both bash forms)
_pi_iterm2_unregister_restore_hook() {
  if [[ -n ${ZSH_VERSION:-} ]]; then
    autoload -Uz add-zsh-hook
    add-zsh-hook -d precmd _pi_iterm2_restore_once 2>/dev/null || true
  elif [[ -n ${BASH_VERSION:-} ]]; then
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
      _pi_iterm2_prompt_commands=()
      for _pi_iterm2_hook in "${PROMPT_COMMAND[@]}"; do
        [[ $_pi_iterm2_hook != _pi_iterm2_restore_once ]] && _pi_iterm2_prompt_commands+=("$_pi_iterm2_hook")
      done
      PROMPT_COMMAND=("${_pi_iterm2_prompt_commands[@]}")
      unset _pi_iterm2_hook _pi_iterm2_prompt_commands
    else
      case ${PROMPT_COMMAND:-} in
        _pi_iterm2_restore_once) PROMPT_COMMAND="" ;;
        _pi_iterm2_restore_once\;*) PROMPT_COMMAND=${PROMPT_COMMAND#_pi_iterm2_restore_once;} ;;
      esac
    fi
  fi
}

_pi_iterm2_restore_once() {
  local previous_status=$?

  # The value is exported so nested shells do not replay the same record.
  if [[ ${PI_ITERM2_RESTORE_SESSION_ID:-} == "${ITERM_SESSION_ID:-}" ]]; then
    return "$previous_status"
  fi

  # The hook is only meaningful in a local iTerm2 shell. A tmux shell can share the
  # outer pane's ITERM_SESSION_ID even though it is not the restored shell itself.
  if [[ ${TERM_PROGRAM:-} != iTerm.app || -z ${ITERM_SESSION_ID:-} || -n ${TMUX:-} ]]; then
    export PI_ITERM2_RESTORE_SESSION_ID="${ITERM_SESSION_ID:-none}"
    return "$previous_status"
  fi

  # Avoid spawning Python—or touching the terminal at all—for ordinary tabs. The daemon
  # atomically maintains this small newline-delimited index whenever state changes.
  local session_guid record_id has_record=0
  session_guid=${ITERM_SESSION_ID##*:}
  if [[ ! -r $HOME/.pi-iterm2/record-ids ]]; then
    return "$previous_status"
  fi
  while IFS= read -r record_id; do
    if [[ $record_id == "$session_guid" ]]; then
      has_record=1
      break
    fi
  done < "$HOME/.pi-iterm2/record-ids"
  if [[ $has_record == 0 ]]; then
    export PI_ITERM2_RESTORE_SESSION_ID="$ITERM_SESSION_ID"
    return "$previous_status"
  fi

  local helper_status
  _pi_iterm2_run_helper --emit-pending
  helper_status=$?
  if [[ $helper_status == 0 || $helper_status == 3 ]]; then
    export PI_ITERM2_RESTORE_SESSION_ID="$ITERM_SESSION_ID"
  fi
  return "$previous_status"
}

# Print recovery text synchronously while this file is sourced. The installer places the
# source line before Powerlevel10k's instant-prompt preamble, so this output is ordinary
# shell initialization output rather than late console I/O.
_pi_iterm2_unregister_restore_hook
_pi_iterm2_restore_once

# Optional host identity for ordinary shell tabs. Resolve it once and replay the cached
# escape at each prompt so a Pi session's shutdown reset cannot leave the tab uncolored.
# The marker file is the only condition, exactly as it is for the location hook below:
# TERM_PROGRAM is not forwarded over SSH, so testing it would rule out every remote shell,
# and a terminal that does not understand the sequence discards it the same way it already
# discards the location sequences.
_pi_iterm2_unregister_shell_identity
if [[ -f $HOME/.pi-iterm2/shell-identity-enabled ]]; then
  _pi_iterm2_shell_identity_color
  PI_ITERM2_SHELL_IDENTITY=$_pi_iterm2_identity_sequence
  if [[ -n $PI_ITERM2_SHELL_IDENTITY && -n ${ZSH_VERSION:-} ]]; then
    pi_iterm2_shell_identity
    PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK=1
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd pi_iterm2_shell_identity
  elif [[ -n $PI_ITERM2_SHELL_IDENTITY && -n ${BASH_VERSION:-} ]]; then
    pi_iterm2_shell_identity
    PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK=1
    # shellcheck disable=SC2178,SC2128 # PROMPT_COMMAND is intentionally handled as both an array and a string (both bash forms)
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
      PROMPT_COMMAND+=("pi_iterm2_shell_identity")
    else
      PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}pi_iterm2_shell_identity"
    fi
  fi
fi

# A remote installation publishes host and cwd using only shell builtins. The local
# iTerm2 recorder observes these standard integration sequences even without Pi.
_pi_iterm2_unregister_location_hook
if [[ -f $HOME/.pi-iterm2/remote-location-enabled ]]; then
  if [[ -n ${ZSH_VERSION:-} ]]; then
    _pi_iterm2_publish_location
    PI_ITERM2_SKIP_NEXT_LOCATION_HOOK=1
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd _pi_iterm2_publish_location
  elif [[ -n ${BASH_VERSION:-} ]]; then
    _pi_iterm2_publish_location
    PI_ITERM2_SKIP_NEXT_LOCATION_HOOK=1
    # shellcheck disable=SC2178,SC2128 # PROMPT_COMMAND is intentionally handled as both an array and a string (both bash forms)
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
      PROMPT_COMMAND+=("_pi_iterm2_publish_location")
    else
      PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}_pi_iterm2_publish_location"
    fi
  fi
fi
