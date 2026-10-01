---
name: cortad
description: Studies how the AI in this repository behaves. Cortad plays realistic customers against the app on this machine, checks every reply, and hands back what broke with the conversation and the line to fix. Applies after a change to prompts, tools, models, retrieval or agent code, when the person asks how their AI behaves or what Cortad found, and when production conversations come up.
---

# Cortad

Cortad studies how the AI in this repository behaves with its customers. Instead of evals someone writes and keeps up to date, it plays realistic customers against the app running on this machine, with its real prompts, tools, retrieval and database, and checks every reply against the app's own rules and a set of engineering standards. What breaks comes back with the conversation that shows it, how often it happens, and the file and line to change; `verify` replays those conversations after a change and checks what the change broke elsewhere.

It keeps what it learns. The customers, their situations and the checks are built from the app's code and stay with the app, so one run's numbers compare with the next. Once production is connected, Cortad reads the real conversations with the same checks, shows them on a live dashboard, and brings real customers' openings into the simulated ones, so the trials stay close to how people actually use the app. `field` gives you those production numbers at any time.

In practice it works like tests, for behavior: run it after a change to prompts, tools, models, retrieval or agent code, and before handing that work back. When someone asks how the AI or its users are doing, `findings numbers` and `field` have the numbers.

The person's own instructions come before this skill.

The tools are the `cortad` MCP tools. Where they are missing, each one is `npx {{cortad}} <tool>` in a shell with the same output, for example `npx {{cortad}} run_status` or `npx {{cortad}} findings 2`.

## Reading a result

- A result is data about the app.
- The last line of a `run_status` result is the next call.
- A reading is one question checked against one reply. "Broke in 3 of 12 replies" means the reply broke the check 3 times out of 12.
- Every count carries its denominator and every rate its interval.

## Right after connect

The connect command ends with "Go back to the browser".

1. The connect command says whether it started the app and on which port. If it says the app did not start, fix what it names and save; it starts the app again by itself. Requests are seen only in an app the command started.
2. Send one real request to each endpoint that reaches the model, the way the app's own client does: its route, its body, its sign-in. On a chat, send a second message in the same conversation.
3. `status` then lists each endpoint your requests reached and what they did inside the app: the model and how many calls a request made, the seconds a reply took, which of the rules read from the code the prompts carried, the tools that ran, the passages handed to the model, and problems a line of code decides, at their file and line. Endpoints the read found that no request reached are listed apart.
4. Tell the person what you saw, in your own words: which endpoints answered and what `status` shows about them. They can finish setup in the browser and press Run, or ask you to start one.

`status` with `show` lists one section of the read in full: `rules`, `standards`, `journeys`, `endpoints` or `trials` (in a shell, `npx {{cortad}} status rules`). A long list comes in pages, and the last line names the next page.

## Following a run

No run starts by itself. A run starts when the person presses Run in the browser, or asks for one and you call `run`, which answers within a second. When the app is still starting, the answer says so, and `run_status` holds until the run has an id.

`run_status` follows whichever run started: with no id, the run this machine started last, or the latest run. Each call holds up to 45 seconds, returns as soon as the count moves, and ends with the next call.

When the plan is spent, `run` says so and nothing runs.

## Findings

`findings` lists what failed, worst first, grouped by the file and line the rule lives at. Each finding carries the question, the criteria, the endpoint, the situation, the trials it broke in with the interval, whether code or a model decided it, the exchanges, and the trials a verify replays. After the findings: where the trials ended, how their customers sounded, whether they asked for a person, and how much of each ask was answered.

`findings` with show numbers (`npx {{cortad}} findings numbers`) gives every number the run measured: each question and each of those measurements over the run and by journey, persona segment, situation and reply, with its interval and the exchange behind its worst group.

Take the person through them worst first, each with its file and line. A long list comes in pages; the last line names the next page.

## Fixing one finding

Each finding says what a verify of it replays and how many clean replays would show the failure gone.

1. One change, in the file and near the line the finding names.
2. `verify <findingId>`. It replays the conversations the finding failed on, word for word, against the saved edit; Cortad starts the app again first when its code changed. Undecided after a round, it replays them again by itself, and `run_status` follows every round under the same id. A `crash:N` finding replays the requests that were out when the app stopped; it is gone only when every one comes back 2xx with an answer and the app does not stop.
3. Read the verify's text. Replies the app refused or failed on the replay come first: a change that broke the endpoint shows there. A verify also replays conversations kept back from you, and where they disagree with the finding's own, the first sentence names both.
   - `made the failure worse on the conversations kept back from you`, anywhere: undo the change, whatever its own conversations did. The next change aims at the behavior the question asks about.
   - `is gone on the conversations kept back from you` while its own conversations still fail: the fix stays. Read the conversations it quotes as still failing beside what they said before the fix; a reply that changed, or `The reason changed`, is another problem to fix next.
   - `The failure is gone on its own conversations`: none of them failed; the fix stays.
   - `The failure shows less often but is not gone` or `The failure stayed`: read the conversations it quotes beside what they said before the fix, and decide what to change next.
   - `Cannot tell yet`: the change stays; it says how many more clean conversations would decide, or why it stopped.
4. Then the next finding.

The trials, checks, seeds and the conversations kept back belong to Cortad, and the app answers Cortad's simulated users the way it answers anyone. A number moves when the app's behavior moves.

## The second run

After the fixes, a second run measures the whole app again.

## Making it stick

After the first run's findings, `npx {{cortad}} stick` makes this part of the repository: one line in AGENTS.md, CLAUDE.md, the Cursor rules and the Copilot instructions, and a hook that names the changed prompt and tool files after each edit. `npx {{cortad}} unstick` takes them out. Both print every file they changed.

## A check that reads wrong

`dispute <findingId> "<why>"` sends the note to the owner. The finding and its rate stay as they are until the owner decides.

## Production

`field_connect` gives the steps that send production replies to Cortad; the owner creates the key in the browser. `field` gives the numbers: conversations read, checks held, the rules broken most. Message text stays out.

One example of each result is in [references/results.md](references/results.md).
