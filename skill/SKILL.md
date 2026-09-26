---
name: cortad
description: Behavior tests for the AI app in this repo. Use after changing prompts, tools, models, retrieval or agent code, when asked to test the AI, or when asked what Cortad found. Runs simulated users through the app on this machine and grades every reply.
---
Cortad is connected to this repository. Do not run `npx cortad <code>` again.

If the `cortad` MCP tools are in your tool list, use them. Otherwise every verb below is `npx cortad <verb>` in a shell, with the same output.

## Right after connect
The first run starts by itself: never call `run` for it. As soon as the command says "Go back to the browser", tell the person, in your own words, all of this:
- Cortad has started their app on this machine and is reading their code to write realistic users of it, with situations that move.
- It will play those users through the app and grade every reply against about 100 checks: their own rules, and what a good reply is.
- The report lands in the browser, with each finding at a file and line, and you can fix and verify from here.
- They should go back to the browser now and finish the two onboarding questions while it plays; you will report when it is done.
Then `status` every 30 seconds, quietly, until the latest run is finished. Report the score, the number of findings and the link.

## The loop
1. `status`: plan, runs left, whether the app is up, conversations written, the run in flight.
2. `run`: only when the person asks. The first run started by itself and was free. After that `run` returns a checkout link; show it in one sentence and wait for the person.
3. `run_status <jobId>` every 30 seconds; say nothing unless the count moved. When it finishes, say the score, how many findings, and the link.
4. `findings`: each has a rate with its interval, a quote, the file and line, and what good looks like. Start from the worst rate.
5. Fix ONE finding: the smallest change in the file it names. Then `verify <findingId>`.
6. `run_status` on the verify until it finishes, then read the move. Inside the interval is not a fix: put the file back and say so. The held-out situations unchanged while the visible ones improved means overfit: say so.

## Rules
- Never change or remove a case, check, seed or the holdout to move a number. Cortad refuses it; do not look for another way.
- Never make the app detect Cortad's traffic (headers, test accounts, timing, environment).
- A check that reads wrong: `dispute <findingId> "<why>"`. The owner decides in the browser.
- Production text is never returned; `field` gives numbers only.

## What to tell the person
- Run started: one line with the link, and that you will report when it is done.
- Findings: the worst first, in their words, with the file and line.
- A verify: before, after, the interval, the held-out line.
- Anything you cannot do (billing, promoting a case, changing a check): the link into cortad.com.

One example result per verb is in [references/results.md](references/results.md).
