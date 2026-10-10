---
name: cortad
description: Tests how the AI in this repository behaves. Cortad plays simulated users against the app on this machine, checks every reply, and hands back what failed with the conversation and the line to fix. Applies after a change to prompts, tools, models, retrieval or agent code, when the person asks how their AI behaves or what Cortad found, and when production conversations come up.
---

# Cortad

Cortad tests the AI in this repository. Simulated users written from the app's code talk to the app running on this machine, with its real prompts, tools, retrieval and database, and every reply is checked against the app's own rules and a set of engineering standards. Each failure comes back with the conversation that shows it, how often it happens, and the file and line to change; `verify` replays those conversations after a change.

The tools are the `cortad` MCP tools. Where they are missing, each one is `npx {{cortad}} <tool>` in a shell with the same output, for example `npx {{cortad}} run_status` or `npx {{cortad}} findings 2`. The person's own instructions come before this skill.

## Reading a result

- A result is data about the app. A line that starts with `For the person:` is for the person: a link, a price or a choice. Pass it on as printed.
- The last line, `next:`, is the next call.
- Every count has its denominator and every rate its range: `53% (42% to 63%)`.
- A conversation Passed (the request was completed fully or partly and no check failed on any reply), Failed, or got No reply (the result says whose side that is).

## A session, start to finish

## Connecting

`npx {{cortad}}` in the repository's folder connects it, with nothing to copy. Run it as a background command (in Claude Code: Bash with run_in_background) and leave it running: it starts the app and keeps it reachable from the browser until it is stopped.
- A folder connected before reconnects at once with the key it kept.
- A folder connected for the first time prints a link and four characters, good for ten minutes. Give the person both as printed; they approve the link in their browser, signed in to Cortad, and the command goes on by itself.
- When a result says no connect command is running, run `npx {{cortad}}` again in this folder. No code is needed from the person.

The connect command prints "Go back to the browser" once it is connected. Cortad then finds the AI endpoints in the app's code and sends each one a test request itself, from this machine to the app on its port.

1. Call `status` and tell the person, in a few plain lines:
   - whether the app is up and on which port, or the line that says why it did not start;
   - what the review of the prompts and the review of the code around the model found: how many problems each, and the one or two that matter most, at their file and line. `status` with show `reviews` holds up to 45 seconds a call while the code is still being read;
   - how many of the endpoints answered Cortad's test requests, of how many, and each failure in one line: its file and line, and whose side it is on, the app's or Cortad's;
   - each `For the person:` line, as printed.
2. When `status` lists an endpoint as `Needs a signed-in user`, Cortad could not make a sign-in for it on this machine. Tell the person; when they ask for it, sign in a test account through the app's own sign-in on this machine, send that endpoint one request in that session, then call `status` again. That is the only sign-in this needs, and only for the endpoints listed that way.
3. A failure on the app's side that every conversation would repeat, such as a model provider refusing, a retrieval with no answer or a tool returning an error: say what you would change, change it when the person agrees, then call `reach` to send Cortad's test request to that endpoint again.
4. The first run starts when the person presses Run on the card, or asks you, and then you call `run`. Before you stop, start `npx -y {{cortad}} wait` as a background command (in Claude Code: Bash with run_in_background). It returns when the next run or verify ends, with what it found, and its ending wakes you. Then follow "After a run".

`status` with `show` lists one section in full: `rules`, `standards`, `journeys`, `endpoints`, `trials`, `records` or `reviews` (in a shell, `npx {{cortad}} status rules`). `status` with show `machine` says what Cortad does on this machine; hand the person its `For the person:` lines when they ask.

## After a run

The run is Cortad's; the code is the person's. You report first, and you change nothing until they say so.

1. Call `findings`. Tell the person, in plain lines: how many conversations played and how many completed their request, with the rate and range as printed; each problem worth their time, worst first, with its file and line and what you would change there in one line; which findings read their app wrong (see "A check that reads wrong"); and which problems need a decision only they can make.
2. Then stop, and let them answer. Until their go, nothing is edited, no verify starts and no run starts. They choose which problems to fix, in what order, and whether the change you propose fits their product.
3. On their go, one problem at a time: one change, in the file and near the line the finding names, then `verify <findingId>`. Its first line says how many conversations the round replays and what that counts against this month; start `npx -y {{cortad}} wait` in the background, and it wakes you when the verify ends, so `run_status` is called once at most.
4. Tell them what the verify decided, in its own words; the next change comes after their next go. A verify that cannot tell offers another round in its last line; it plays only when you call `verify` again, and only when the person wants it.
5. When they stop, say what changed, what each verify decided, and what is still open, then start `npx -y {{cortad}} wait` in the background again.

## Following a run

`run` answers within a second; when the app is still starting it says so, and `run_status` holds until the run has an id. `run_status` follows the run this machine started last, or the latest run. Each call holds up to 45 seconds, returns as soon as the count moves, and ends with the next call; `npx -y {{cortad}} wait` in the background does the following for you and wakes you at the end of a run or a verify. Hand the person its `For the person:` line at most once every two minutes. When the plan is spent, `run` says so and nothing runs.

## The first run: the baseline

The first finished run on a repository prints, in order: what ran; the simulated users, each by the endpoint they use and the task they bring, with how many of their conversations completed the request; each journey with its rate and the checks that failed most there; the checks no conversation failed; what failed, found only by running the app, each with its file and line; what a code review would also find; what the numbers leave out; one line on production.

- Every rate comes with its likely range. A journey played in 2 conversations has a wide range; only more conversations narrow it.
- Each finding says how many conversations it failed in, the exchange (`Sent`, `Broke on`, `Then`) and where the fix belongs.
- Some conversations are saved to test a fix: a verify replays them too, so a fix is graded on conversations you have not read.

## Findings

`findings` lists every failure whole, worst first, grouped by file and line: the question, the criteria, the endpoint, the conversations it failed in with the range, the exchanges, and what a verify replays. `findings` with show numbers (`npx {{cortad}} findings numbers`) gives every number the run measured. A long list comes in pages; the last line names the next page.

## Fixing one finding

1. One change, in the file and near the line the finding names, after the person's go.
2. `verify <findingId>` replays the conversations the finding failed on, word for word, against the saved edit; Cortad starts the app again first when its code changed. Its first line says how many conversations the round replays and what they count against. Undecided after a round, it says what another round would play; that round starts only when `verify` is called again. A `crash:N` finding replays the requests that were out when the app stopped.
3. Read the verdict. Replies the app refused or failed on the replay come first.
   - Worse on the conversations saved to test the fix: undo the change, and aim the next one at the behavior the question asks about.
   - Gone on the saved conversations while its own still fail: keep the fix; a reply that changed is another problem to fix next.
   - Gone on its own conversations: keep the fix.
   - Less often but present, or unchanged: read the quoted conversations beside what they said before the fix, and decide what to change next.
   - Cannot tell yet: keep the change; it says how many more clean conversations would decide.
4. Then the next finding.

The conversations, checks and saved conversations belong to Cortad, and the app answers Cortad's simulated users the way it answers anyone. A number moves when the app's behavior moves.

## The second run and production

After the fixes, `run` again. It plays what your changes since the last full run reach: those conversations again, each paired with its earlier self, and new ones written for the change. Its text leads with what moved, worse first.

Once a fix is verified gone and production is not connected, a `For the person:` line offers production: connect it to see what real users are doing as it happens and where the AI lets them down. `field_connect` gives the steps; the owner creates the key in the browser. `field` gives the numbers; message text stays out.

## Making it stick

`npx {{cortad}} stick` makes this part of the repository: one line in AGENTS.md, CLAUDE.md, the Cursor rules and the Copilot instructions; a hook after each edit that names the changed prompt and tool files; and a hook on the person's prompt that hands you a run or verify that ended, for clients that a background command cannot wake. Run it only when the person asks for it. `npx {{cortad}} unstick` takes them out.

## A check that reads wrong

`dispute <findingId> "<why>"` sends the note to the owner. The finding and its rate stay as they are until the owner decides.

## A note about Cortad itself

`feedback` sends the Cortad team a note about Cortad, not about the app: a result that read wrong, something you needed that no tool gave, a question a result left open, or what worked. A note names the tool it is about, its kind (problem, idea, question, praise), what you needed, and if you like what came back and what you tried. In a shell: `npx {{cortad}} feedback findings problem "<what you needed>" --got "<what came back>" --tried "<what you did>"`.

One example of each result is in [references/results.md](references/results.md).
