#!/usr/bin/env sh
#
# Start the Steam idler inside a detached tmux session.
#
#   sh scripts/tmux-start.sh          # start (or reuse) the session
#   tmux attach -t steam-idler        # attach — type a Steam Guard code here if asked
#   Ctrl+B then D                     # detach, leaving it running
#   tmux kill-session -t steam-idler  # stop
#
# Safe to run from Termux:Boot or an SSH login: if the session already
# exists it just attaches instead of starting a second idler.

set -e

SESSION="${TMUX_SESSION:-steam-idler}"
PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed."
  echo "  Termux:  pkg install tmux"
  echo "  Debian:  sudo apt install tmux"
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' is already running."
  echo "Attach with: tmux attach -t $SESSION"
  exit 0
fi

# Keep Android from suspending the process when Termux is backgrounded.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

tmux new-session -d -s "$SESSION" -c "$PROJECT_DIR" "npm start"

# If node ever exits, keep the dead pane around so the error stays readable
# instead of the whole session vanishing.
tmux set-option -t "$SESSION" remain-on-exit on >/dev/null 2>&1 || true

echo "Started '$SESSION'."
echo "Attach:  tmux attach -t $SESSION"
echo "Detach:  Ctrl+B then D"
echo "Stop:    tmux kill-session -t $SESSION"
