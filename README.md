# cortad

Runs Cortad test conversations against the app on your machine. Your env stays on your machine.

```
npx cortad <code>
```

Run it in your app's folder. The code comes from the connect screen at cortad.com. Nothing is installed. Ctrl-C disconnects.

## Behavior

- Starts your app with its dev script. If it is already running, uses it.
- Finds the route your AI answers on. Sends requests to that port on `localhost`, nowhere else.
- If it cannot find the route, the screen asks you to send one message in your app. It reads the route and body from that request.
- Restarts your app when it stops and you save a fix.
- The Cortad agent edits your files in place. Every edit can be undone from the screen. Git is never touched: no commit, stage, stash or push.

## Sent to cortad.com

- Source files, once. Not `.env*`, key files, `node_modules` or `.git`.
- Your app's replies to the test requests. Values from your env files are masked first.

## Never sent

- Env values.
- Tokens, cookies, API keys. Signed-in requests get their token attached on your machine.

## Never done

- Writes to `.env*`, key files, `.git`, `node_modules`.
- Requests to any port but your app's.
- Agent shell access to the network or to files outside temp and git-ignored build folders.

## Loaded into your app

When cortad starts your app it preloads one file: `lib/trace.cjs` for Node (`NODE_OPTIONS=--require`), `lib/pyhook/sitecustomize.py` for Python (`PYTHONPATH`). It records the one request during which your app called a model, to a file in cortad's temp folder, mode 0600. It makes no network calls. Read it; it is short.

## Flags

```
--explain            print what would be sent and started, then exit; no network
--port 3000          use an app that is already running
--start "make dev"   how your app starts
--verbose            print your app's output
```

## Files it creates

- `~/.cortad/checkpoints/`  undo data for agent edits
- `$TMPDIR/cortad-<pid>/`   removed on exit

macOS, Linux. Node 20+.
