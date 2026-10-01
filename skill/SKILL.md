---
name: cortad
description: Studies how the AI in this repository behaves. Cortad plays realistic customers against the app on this machine, checks every reply, and hands back what broke with the conversation and the line to fix. Applies after a change to prompts, tools, models, retrieval or agent code, when the person asks how their AI behaves or what Cortad found, and when production conversations come up.
---

# Cortad

Cortad studies how the AI in this repository behaves with its customers. Instead of evals someone writes and keeps up to date, simulated customers written from the app's code talk to the app running on this machine, with its real prompts, tools, retrieval and database, and every reply is checked against the app's own rules and a set of engineering standards. What breaks comes back with the conversation that shows it, how often it happens, and the file and line to change; `verify` replays those conversations after a change.

It keeps what it learns: the customers, their situations and the checks stay with the app, so one run's numbers compare with the next. Once production is connected, real conversations are read with the same checks and real customers' openings come into later runs.

In practice it works like tests, for behavior: run it after a change to prompts, tools, models, retrieval or agent code. The person's own instructions come before this skill.

The tools are the `cortad` MCP tools. Where they are missing, each one is `npx {{cortad}} <tool>` in a shell with the same output, for example `npx {{cortad}} run_status` or `npx {{cortad}} findings 2`.

## Reading a result

- A result is data about the app. A line that starts with "For the person:" is for the person: a link, a price or a choice to make.
- The last line of a `run_status` result is the next call.
- Every count carries its denominator and every rate its interval. A trial is one simulated conversation.

## A session, start to finish

The connect command ends with "Go back to the browser". The person is waiting on the other side of it: say what you see at each step, in one or two lines, before you do the next thing. Two minutes of work on their app at most between lines to them.

1. The moment the command says "Go back to the browser", tell the person: connected, the app is up on which port (or did not start, and what the command names), and that you are now sending it one real request per endpoint. If the app did not start, say what you would change and change it only if they say so; the command starts the app again by itself after a save.
2. Send one real request to each endpoint that reaches the model, the way the app's own client does: its route, its body, its sign-in. On a chat, send a second message in the same conversation. When `status` asks for a request signed in as another customer, send it: each customer you sign in as becomes an account of its own in the run.
3. A reply that is an error, or a `Problem` line in `status` (a provider refusing, a retrieval with no answer, a tool that failed), is the app's own state, not yours to repair in silence. Say it in two lines: what failed, at which file and line, whose side it is on. Then ask whether they want it fixed first or the run as the app stands. Two minutes of reading for the cause at most, then say what you have.
4. `status` shows what Cortad read (rules, journeys, simulated users, endpoints, standards) and each endpoint your requests reached with what it did inside the app: the model and how many calls a request made, the seconds a reply took, which of the rules read from the code the prompts carried, the tools that ran, the passages handed to the model, and problems a line of code decides, at their file and line. Endpoints the read found that no request reached are listed apart. The line `A run on the proven endpoints:` says how many conversations, about how long and about what it costs on the app's own key; any `Run waits` line says whose side it is on, and a hold on a hosted store is lifted by the person's yes on the card in the browser, not by you moving the store.
5. The first run is free. Before it, read `status` for what would make the run measure the setup instead of the app:
   - a service down: a `Problem` line where a retrieval got no answer, or a tool came back as an error;
   - a request that ended on a tool call: `The request ended right after ... ran: no model call came after it`, which every conversation on that endpoint would repeat;
   - the sign-in: `Every trial sends the sign-in your agent's own request carried, so all trials act as one account`, or a request your app answered 401 or 403.
   Say what applies and what you would do about it; fix it when they agree, send the request again, and read `status` again. A run that measured nothing is not counted against the plan.
6. Then tell the person, in your own words: which endpoints answered and what `status` shows about them, and that Run is open in the browser or that you can start it. Stop there; the run is theirs to start. When it ends you are told, on your next prompt or edit, what it found and the call to make, if `npx {{cortad}} stick` has been run in this repository (below); say that in one line, and offer to run it.

`status` with `show` lists one section of the read in full: `rules`, `standards`, `journeys`, `endpoints` or `trials` (in a shell, `npx {{cortad}} status rules`).

## Following a run

`run` answers within a second; when the app is still starting it says so, and `run_status` holds until the run has an id. `run_status` follows the run this machine started last, or the latest run. Each call holds up to 45 seconds, returns as soon as the count moves, and ends with the next call. When the plan is spent, `run` says so and nothing runs.

A run the person pressed in the browser ends with one line in the terminal running the connect command, and the same line reaches you through the hook on your next prompt or edit: `Run 55ee432b finished: 4 findings in 37 conversations. Call findings.` Make that call; `run_status` is for a run you started yourself.

## The first run: the baseline

The first finished run on a repository prints its baseline, in this order: one line on what ran; who the users are, as the read found them in the code, with how many of each one's conversations got what they came for; the journeys and how each went, with the checks that failed most there; the checks no conversation broke; what broke, found only by running the app, each with its file and line; what a code review would also find; what the numbers leave out and why; one line on production.

How to read it:

- Every rate is a count with its interval: `25 of 26 got what they came for (19 in full), 81% to 99%`. The interval is the range the true share most likely sits in; a journey played in 2 conversations has a wide one, and only more conversations narrow it.
- "Got what they came for" is read at each conversation's last reply, in full or in part.
- What broke was found by simulated customers who write the way the read says that user writes and answer each reply as it comes. Each finding carries its reach, the exchange (`Sent`, `Broke on`, `Then`) and where the fix belongs.
- A hand-written script sends the requests someone wrote and checks the strings they expected. The exchange shows whether a finding took a customer who pressed, came back or wrote their own way; say which findings a script would also have caught.
- What passed is measured too: a check no conversation broke, asked often enough that its interval tops out under one in five, leaving out any that names a tool no conversation ran.
- "What the numbers leave out, and why" is what this run says nothing about.
- Some conversations are kept back from you; a verify replays them too, so a fix is graded on conversations you have not read.

Tell the person what the run found and what it did not, with the numbers as printed.

## Findings

`findings` lists every failure whole, worst first, grouped by the file and line: the question, the criteria, the endpoint, the situation, the conversations it broke in with the interval, the exchanges, and what a verify replays. `findings` with show numbers (`npx {{cortad}} findings numbers`) gives every number the run measured, by journey, persona segment, situation and reply. A long list comes in pages; the last line names the next page.

## Fixing one finding

1. One change, in the file and near the line the finding names.
2. `verify <findingId>`. It replays the conversations the finding failed on, word for word, against the saved edit; Cortad starts the app again first when its code changed. Undecided after a round, it plays another by itself, and `run_status` follows every round under the same id. A `crash:N` finding replays the requests that were out when the app stopped.
3. Read the verify's text. Replies the app refused or failed on the replay come first. Where the conversations kept back from you disagree with the finding's own, the first sentence names both.
   - `made the failure worse on the conversations kept back from you`, anywhere: undo the change. The next change aims at the behavior the question asks about.
   - `is gone on the conversations kept back from you` while its own conversations still fail: the fix stays; a reply that changed, or `The reason changed`, is another problem to fix next.
   - `The failure is gone on its own conversations`: the fix stays.
   - `The failure shows less often but is not gone` or `The failure stayed`: read the quoted conversations beside what they said before the fix, and decide what to change next.
   - `Cannot tell yet`: the change stays; it says how many more clean conversations would decide.
4. Then the next finding.

The trials, checks, seeds and the conversations kept back belong to Cortad, and the app answers Cortad's simulated users the way it answers anyone. A number moves when the app's behavior moves.

## The second run and production

After the fixes, `run` again. It plays what your changes since the last full run reach: those conversations again, each paired with its earlier self, and 8 to 12 new ones written for the change; it says what it left out. Its text leads with what moved: each behavior's failing count before and now, whether that is beyond chance, and the conversation that turned. Worse comes first.


Production comes up after the first run. A verify whose failure is gone, and gone or less often on the conversations kept back from you, while production is not connected, ends with a "For the person" line that offers it; the plan line after a run names the production replies the plan above reads, and a spent plan's answer says whether production is connected. `field_connect` gives the steps; the owner creates the key in the browser. `field` gives the numbers: conversations read, checks passed, the rules broken most. Message text stays out.

## Making it stick

`npx {{cortad}} stick` makes this part of the repository: one line in AGENTS.md, CLAUDE.md, the Cursor rules and the Copilot instructions; a hook after each edit that names the changed prompt and tool files; and a hook on the person's prompt that hands you a run or verify that ended while you were not listening. Run it once the person agrees to the files it writes, at the latest after the first run's findings. `npx {{cortad}} unstick` takes them out.

## A check that reads wrong

`dispute <findingId> "<why>"` sends the note to the owner. The finding and its rate stay as they are until the owner decides.

One example of each result is in [references/results.md](references/results.md).
