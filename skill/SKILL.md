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
- A reading is one question checked against one reply. "Held in 3 of 12 replies" means the reply met the question 3 times out of 12.
- Every count carries its denominator and every rate its interval.

## Right after connect

The connect command ends with "Go back to the browser". From then on `status` carries what Cortad read. Walk the person through it in this order, each item with its file and line:

1. The journeys: the paths the simulated users take through the app.
2. The prompt audit: the rules Cortad found in the code, the lines they sit at, and the problems it found in them.
3. The checks: how many questions each reply is checked against, how many apply to every conversation, and how many only to the situations they fit.
4. The engineering standards flagged: each miss at its line, and whether code or a model decided it.
5. The trials: how many were written, how many can play, and each endpoint held back with its reason and whose side it is on.

Then the findings, then the fixes.

## Following a run

The first run starts by itself after a connect. `run_status` follows it. Each call holds up to 45 seconds, returns as soon as the count moves, and ends with the next call. With no id it follows the run this machine started last, or the latest run.

`run` starts a run when the person asks for one, and answers within a second. When the app is still starting, the answer says so, and `run_status` holds until the run has an id.

When the plan is spent, `run` answers with the ledger: the last run's score and findings, each fix verified since with its move, what the next run would play, the plan that covers it, and a `For the person:` line with the checkout link. Nothing ran.

## Findings

`findings` lists what failed, worst first, grouped by the file and line the rule lives at. Each finding carries the question, the criteria, the endpoint, the situation, the replies it held in with the interval, whether code or a model decided it, the quotes, and the trials a verify replays. "Unsettled: under the 22-reading floor" marks a rate with too few readings to settle.

Take the person through them worst first, each with its file and line. A long list comes in pages; the last line names the next page.

## Fixing one finding

1. One change, in the file and near the line the finding names.
2. `verify <findingId>`. It answers within a second, and `run_status` follows it.
3. Read the move on the `Visible trials:` and `Held-out trials:` lines:
   - `improved` without `inside the noise`, with the held-out line improved too or `no pair`: the behavior moved. The change stays.
   - `inside the noise`, `no change` or `unsettled`: the trials cannot tell the change from chance. The file goes back to how it was.
   - An `Overfit:` line: the visible trials moved and the held-out trials stayed where they were, so the change fits the trials it could see. The file goes back, and the next change aims at the behavior the question asks about.
   - `regressed`: the file goes back.
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
