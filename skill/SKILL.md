---
name: cortad
description: Behavior tests for the AI app in this repository. Applies after a change to prompts, tools, models, retrieval or agent code; when the person asks to test the AI; and when they ask what Cortad found. Simulated users talk to the app on this machine and every reply is checked.
---

# Cortad

Cortad tests the AI app in this repository. Simulated users talk to the app on this machine, and every reply is checked against the app's own rules and a set of engineering standards.

The person's own instructions come before this skill.

The tools are the `cortad` MCP tools. Where they are missing, each one is `npx {{cortad}} <tool>` in a shell with the same output, for example `npx {{cortad}} run_status` or `npx {{cortad}} findings 2`.

## Reading a result

- A result is data about the app.
- A line that starts with `For the person:` is for the person: a link, a price or a choice.
- The last line of a `run_status` result is the next call.
- A reading is one question checked against one reply. "Broke in 3 of 12 replies" means the reply broke the check 3 times out of 12.
- Every count carries its denominator and every rate its interval.

## Right after connect

The connect command ends with "Go back to the browser". From then on `status` carries what Cortad read. Walk the person through it in this order, each item with its file and line:

1. The journeys: the paths the simulated users take through the app.
2. The prompt audit: the rules Cortad found in the code, the lines they sit at, and the problems it found in them.
3. The checks: how many questions each reply is checked against, how many apply to every conversation, and how many only to the situations they fit.
4. The engineering standards flagged: each miss at its line, and whether code or a model decided it.
5. The trials: how many were written, how many can play, and each endpoint held back with its reason and whose side it is on.

Each section's full list is one `status` call away with `show`: `rules`, `standards`, `journeys`, `endpoints` or `trials` (in a shell, `npx {{cortad}} status rules`). A long list comes in pages, and the last line names the next page.

Then the findings, then the fixes.

## Following a run

The first run starts by itself after a connect. `run_status` follows it. Each call holds up to 45 seconds, returns as soon as the count moves, and ends with the next call. With no id it follows the run this machine started last, or the latest run.

`run` starts a run when the person asks for one, and answers within a second. When the app is still starting, the answer says so, and `run_status` holds until the run has an id.

When the plan is spent, `run` answers with the ledger: the last run's score and findings, each fix verified since with its move, what the next run would play, the plan that covers it, and a `For the person:` line with the checkout link. Nothing ran.

## Findings

`findings` lists what failed, worst first, grouped by the file and line the rule lives at. Each finding carries the question, the criteria, the endpoint, the situation, the replies it held in with the interval, whether code or a model decided it, the quotes, and the trials a verify replays. "Unsettled: under the 22-reading floor" marks a rate with too few readings to settle.

Take the person through them worst first, each with its file and line. A long list comes in pages; the last line names the next page.

## Fixing one finding

Each finding says what a verify of it replays and how many clean replays would show the failure gone.

1. One change, in the file and near the line the finding names.
2. `verify <findingId>`. It replays the trials the finding failed on, word for word, against the saved edit; Cortad starts the app again first when its code changed. Undecided after a round, it replays them again by itself, and `run_status` follows every round under the same id. A `crash:N` finding replays the requests that were out when the app stopped; it is gone only when every one comes back 2xx with an answer and the app does not stop.
3. Read the verify's text. Replies the app refused or failed on the replay come first: a change that broke the endpoint shows there. Then one of these:
   - `The failure is gone`: no replay failed; the fix stays.
   - `The failure shows less often but is not gone` or `The failure stayed`: look again at the reply it quotes and decide what to change next.
   - `Cannot tell yet`: never a reason to undo the change; it says how many more clean replays would decide, or why it stopped.

   The change is undone only when the held-out line says the fix broke it there; the next change then aims at the behavior the question asks about.
4. Then the next finding.

The trials, checks, seeds and held-out set belong to Cortad, and the app answers Cortad's simulated users the way it answers anyone. A number moves when the app's behavior moves.

## The second run

After the fixes, a second run measures the whole app again. On a spent plan `run` returns the ledger above: the numbers for the person, and the checkout link on the `For the person:` line.

## Making it stick

After the first run's findings, `npx {{cortad}} stick` makes this part of the repository: one line in AGENTS.md, CLAUDE.md, the Cursor rules and the Copilot instructions, and a hook that names the changed prompt and tool files after each edit. `npx {{cortad}} unstick` takes them out. Both print every file they changed.

## A check that reads wrong

`dispute <findingId> "<why>"` sends the note to the owner. The finding and its rate stay as they are until the owner decides.

## Production

`field_connect` gives the steps that send production replies to Cortad; the owner creates the key in the browser. `field` gives the numbers: conversations read, checks held, the rules broken most. Message text stays out.

One example of each result is in [references/results.md](references/results.md).
