#!/bin/sh
# Stops what up.sh started, by the pids it wrote, and the twin's compose services with their volumes.
set -u
TWIN=${TWIN:-$HOME/cortad-twins/ask-later}
STATE=$(dirname "$TWIN")/$(basename "$TWIN")-world
# A process and every process under it, found by parent pid: the emulator is java under node under npx.
stop() { for child in $(pgrep -P "$1"); do stop "$child"; done; kill "$1" 2>/dev/null; }
for f in "$STATE"/pids/*; do
  [ -f "$f" ] || continue
  stop "$(cat "$f")"
  rm -f "$f"
done
HERE=$(cd "$(dirname "$0")" && pwd)
(cd "$TWIN" && docker compose down -v >/dev/null 2>&1)
docker compose -f "$HERE/staging-compose.yml" down -v >/dev/null 2>&1
