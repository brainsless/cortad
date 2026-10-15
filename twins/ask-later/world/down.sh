#!/bin/sh
# Stops what up.sh started, by the pids it wrote, and the twin's own compose services.
set -u
TWIN=${TWIN:-$HOME/cortad-twins/ask-later}
STATE=$(dirname "$TWIN")/ask-later-world
# A process and every process under it, found by parent pid: the emulator is java under node under npx.
stop() { for child in $(pgrep -P "$1"); do stop "$child"; done; kill "$1" 2>/dev/null; }
for f in "$STATE"/pids/*; do
  [ -f "$f" ] || continue
  stop "$(cat "$f")"
  rm -f "$f"
done
(cd "$TWIN" && docker compose down >/dev/null 2>&1)
