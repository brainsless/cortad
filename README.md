# cortad

Runs Cortad's test conversations against the AI app on your machine, and gives your coding agent the tools to run them.

```
npx cortad <code>
```

Run it in your app's folder with the code from cortad.com. It starts your app, connects it to Cortad, and adds Cortad to Claude Code, Codex and Cursor on this machine. The first run starts on its own. Ctrl-C disconnects.

## Your coding agent

After that, your agent has eight tools: `status`, `run`, `run_status`, `findings`, `verify`, `dispute`, `field_connect`, `field`. The same eight work as commands:

```
npx cortad status
npx cortad run
npx cortad findings
npx cortad verify <findingId>
```

A run needs your app up. If nothing on this machine is holding it, the command starts it with the key in `~/.cortad` and stops it ten minutes after the last run.

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

macOS and Linux, Node 20 or later. No dependencies. What is sent and what stays on your machine: `npx cortad --explain`, and cortad.com/privacy.
