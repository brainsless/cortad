# cortad

Connects the AI app on your machine to Cortad, so Cortad can run test conversations against it.

```
npx cortad <code>
```

Run it in your app's folder with the code from cortad.com. Nothing is installed. Ctrl-C disconnects.

## What it does

- Starts your app with its dev script, or uses it if it is already running.
- Sends Cortad's test conversations to your app on localhost and returns the replies.
- Signs in as a test account when your app needs one: an account made for the session, never an existing user and never an admin.
- Lets the Cortad agent edit files in your project. Every edit can be undone from the browser. Git is left alone.

## What Cortad receives

- The files git would commit, once. Nothing git ignores, and no env, key or data files.
- Your app's replies to the test conversations, with values from your env files hidden and cookies removed.

## What stays on your machine

- Your env files and their values.
- Tokens and cookies. A signed-in test request gets its token added here.

## The agent's shell

Commands the agent runs are confined by the operating system (Seatbelt on macOS, bubblewrap on Linux). They can read your project and your toolchains, write only to temp and build folders, and reach only localhost.

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

- `~/.cortad/checkpoints/`  undo data for agent edits
- `$TMPDIR/cortad-<pid>/`   removed on exit

macOS and Linux, Node 20+. No dependencies, no install scripts.
