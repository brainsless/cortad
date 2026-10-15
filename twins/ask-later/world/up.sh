#!/bin/sh
# Raises the twin's world on this machine: the app as a fresh repository at $TWIN with its Poetry
# venv and layered env files, its stores in Docker, the model provider and the Firebase Auth
# emulator. Each process it starts is written to $TWIN/../pids; down.sh stops those pids and nothing else.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
TWIN=${TWIN:-$HOME/cortad-twins/ask-later}
PROVIDER_PORT=${PROVIDER_PORT:-18431}
POETRY=${POETRY:-$HOME/.local/bin/poetry}
STATE=$(dirname "$TWIN")/ask-later-world
mkdir -p "$STATE/pids"
[ -f "$STATE/key" ] || (umask 077; printf 'sk-twin-real-%s' "$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" > "$STATE/key")
KEY=$(cat "$STATE/key")

if [ ! -d "$TWIN/.git" ]; then
  mkdir -p "$TWIN"
  cp "$HERE/../app/main.py" "$HERE/../app/pyproject.toml" "$HERE/../app/docker-compose.yml" "$TWIN/"
  printf '.venv/\n.env*\n!.env.example\n__pycache__/\n' > "$TWIN/.gitignore"
  (cd "$TWIN" && git init -q && git add -A && git -c user.name=twin -c user.email=twin@example.invalid commit -qm "the app")
fi

cd "$TWIN"
"$POETRY" config virtualenvs.in-project true --local
"$POETRY" env use python3.12 >/dev/null
"$POETRY" install --no-interaction --quiet

# The test file holds a placeholder key and the stores; the developer's own file holds the real key.
cat > .env <<EOF
PORT=58889
EOF
cat > .env.test <<EOF
OPENAI_API_KEY=sk-test-placeholder-not-a-key
MONGO_URI=mongodb://127.0.0.1:27118
PG_DSN=postgresql://research:research-local@127.0.0.1:55433/research_test
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199
FIREBASE_PROJECT_ID=demo-twin
EOF
cat > .env.local <<EOF
OPENAI_API_KEY=$KEY
OPENAI_BASE_URL=http://127.0.0.1:$PROVIDER_PORT/v1
EOF
cat > .env.example <<EOF
OPENAI_API_KEY=your-key-here
EOF
chmod 600 .env .env.test .env.local

docker compose up -d --wait >/dev/null

started() { [ -f "$STATE/pids/$1" ] && ps -p "$(cat "$STATE/pids/$1")" >/dev/null 2>&1; }
if ! started provider; then
  TWIN_PROVIDER_KEY=$KEY nohup python3 "$HERE/provider.py" "$PROVIDER_PORT" > "$STATE/provider.log" 2>&1 < /dev/null &
  echo $! > "$STATE/pids/provider"
fi
if ! started emulator; then
  cd "$HERE"
  nohup npx -y firebase-tools@15.34.0 emulators:start --only auth --project demo-twin > "$STATE/emulator.log" 2>&1 < /dev/null &
  echo $! > "$STATE/pids/emulator"
  cd "$TWIN"
fi
for _ in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:9199/ >/dev/null 2>&1 && break; sleep 2; done
echo "twin at $TWIN, provider on $PROVIDER_PORT, emulator on 9199"
