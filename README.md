# cortad

Connects the AI app on your machine to Cortad, so Cortad can run test conversations against it, and gives your coding agent the tools to run them.

```
npx cortad <code>
```

Run it in your app's folder with the code from cortad.com. Nothing is installed in your project. Ctrl-C disconnects.

## What it does

- Starts your app with its dev script, or uses it if it is already running.
- Sends Cortad's test conversations to your app on localhost and returns the replies.
- Signs in as a test account when your app needs one: an account made for the session, never an existing user and never an admin.
- Makes Cortad known to the coding agents on this machine (Claude Code, Codex, Cursor): an MCP entry and a skill in each one's own home folder, so `npx cortad mcp` answers them from then on. Nothing is written into your repository.
- Never writes your files. The agent that edits your code is your own.

## For your coding agent

After the first connect, your agent has eight tools: `status`, `run`, `run_status`, `findings`, `verify`, `dispute`, `field_connect`, `field`. The same eight work as shell commands:

```
npx cortad status
npx cortad run
npx cortad findings
npx cortad verify <findingId>
```

A run needs your app up. When nothing on this machine is holding it, the command starts it with the key the first connect left in `~/.cortad`, and leaves when no run has needed it for ten minutes.

## What Cortad receives

- The files git would commit, once. Nothing git ignores, and no env, key or data files.
- Your app's replies to the test conversations, with values from your env files hidden and cookies removed.

## What stays on your machine

- Your env files and their values.
- Tokens and cookies. A signed-in test request gets its token added here.
- The key in `~/.cortad/<project>/token` (readable by you only). It starts runs and reads findings for this one repository and nothing else; revoke it from your account page.

## The test shell

Commands a run needs on this machine (your own test suite, a WebSocket door) are confined by the operating system (Seatbelt on macOS, bubblewrap on Linux). They can read your project and your toolchains, write only to temp and build folders, and reach only localhost.

## Loaded into your app

When cortad starts your app it preloads one short file, `lib/trace.cjs` for Node or `lib/pyhook/sitecustomize.py` for Python. It notes which request called a model, so Cortad finds your chat route. It writes only to cortad's temp folder.

## Flags

```
--explain            show what would be sent and started, then exit
--port 3000          use an app that is already running
--start "make dev"   how your app starts
--verbose            print your app's output
```

## Files it creates

- `~/.cortad/<project>/`     the key, the last tree digest, which process holds your app up
- `~/.cortad/identity.key`   the seed for the session's test accounts
- `$TMPDIR/cortad-<pid>/`    removed on exit

macOS and Linux, Node 20+. No dependencies, no install scripts.
