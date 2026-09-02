# shellcheck shell=bash
# shellcheck disable=SC1003,SC2012,SC2128,SC2178,SC2319
# pi-iterm2 restored-session pre-prompt hook.
# Source this from ~/.zshrc or ~/.bashrc on the Mac running iTerm2.

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

_pi_iterm2_sanitize_osc() {
  REPLY=$1
  REPLY=${REPLY//$'\e'/}
  REPLY=${REPLY//$'\a'/}
  REPLY=${REPLY//$'\r'/}
  REPLY=${REPLY//$'\n'/}
}

_pi_iterm2_publish_location() {
  local previous_status=$?
  if [[ ${PI_ITERM2_SKIP_NEXT_LOCATION_HOOK:-} == 1 ]]; then
    unset PI_ITERM2_SKIP_NEXT_LOCATION_HOOK
    return "$previous_status"
  fi
  local user=${USER:-unknown} host=${HOSTNAME:-${HOST:-unknown}} cwd=${PWD:-} sequence
  _pi_iterm2_sanitize_osc "$user"; user=$REPLY
  _pi_iterm2_sanitize_osc "$host"; host=$REPLY
  _pi_iterm2_sanitize_osc "$cwd"; cwd=$REPLY
  sequence=$'\e]1337;RemoteHost='"${user}@${host}"$'\a\e]1337;CurrentDir='"${cwd}"$'\a'
  if [[ -n ${TMUX:-} ]]; then
    sequence=${sequence//$'\e'/$'\e\e'}
    printf '\ePtmux;%s\e\\' "$sequence"
  else
    printf '%s' "$sequence"
  fi
  return "$previous_status"
}

pi_iterm2_shell_identity() {
  local previous_status=$?
  if [[ ${PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK:-} == 1 ]]; then
    unset PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK
    return "$previous_status"
  fi
  [[ -n ${PI_ITERM2_SHELL_IDENTITY:-} ]] && printf '%s' "$PI_ITERM2_SHELL_IDENTITY"
  return "$previous_status"
}

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
_pi_iterm2_unregister_shell_identity
if [[ ${TERM_PROGRAM:-} == iTerm.app && -f $HOME/.pi-iterm2/shell-identity-enabled ]]; then
  PI_ITERM2_SHELL_IDENTITY=$(_pi_iterm2_run_helper --shell-identity 2>/dev/null)
  if [[ -n $PI_ITERM2_SHELL_IDENTITY && -n ${ZSH_VERSION:-} ]]; then
    pi_iterm2_shell_identity
    PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK=1
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd pi_iterm2_shell_identity
  elif [[ -n $PI_ITERM2_SHELL_IDENTITY && -n ${BASH_VERSION:-} ]]; then
    pi_iterm2_shell_identity
    PI_ITERM2_SKIP_NEXT_IDENTITY_HOOK=1
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
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
      PROMPT_COMMAND+=("_pi_iterm2_publish_location")
    else
      PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}_pi_iterm2_publish_location"
    fi
  fi
fi
