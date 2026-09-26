# What each tool prints

Each result exactly as the tool returns it. The numbers are from a walk of a tutoring app; yours differ. Every tool is also `npx {{cortad}} <tool>` in a shell, with the same output.

A reading is one question checked against one reply. A line that starts with `For the person:` is for the person. The last line of a run_status result is the next call.

## status

Right after a connect, before the read is done:

```
Cortad · tutor-app
Free: 1 of 1 run left this month, 60 of 60 verify trials left.
App: Your app is starting on this machine.
No run yet.
Production: not connected.
```

Once the read is done and the first run is playing. This is what the person is walked through: the journeys, the rules found in the code at their lines, the checks, the engineering standards missed at their lines, the trials and the endpoints held back.

```
Cortad · tutor-app
Free: 0 of 1 run left this month, 60 of 60 verify trials left.
App: Your app answered on port 3100.
What Cortad read:
Rules in the code: 46, in 5 files. 3 of them:
  apps/api/src/agent/prompt.ts:41  "Never state a refund policy the product does not publish."
  apps/api/src/agent/system.ts:12  "Answer in the language the student writes in."
  apps/api/src/tools/search.ts:8  "Cite the lesson a fact comes from."
Journeys (4): homework help, billing question, account recovery, first lesson.
Simulated users (3): student in grade 9, parent paying for the plan, teacher checking progress.
Endpoints (2): POST /api/chat, POST /api/homework/explain.
Engineering standards: 38 decided, 35 met, 3 missed.
  apps/api/src/agent/client.ts:9  The model call has a timeout: the OpenAI client is created with no timeout, so a slow reply holds the request open (decided by code)
  apps/api/src/agent/system.ts:30  User text stays out of the system prompt: the student's name is written into the system prompt (decided by a model)
  apps/api/src/tools/search.ts:51  Tool errors reach the model as errors: search returns an empty list when the index is down (decided by a model)
Questions: 112; 40 asked in every conversation, 72 placed in the situations they fit.
Trials: 58 written, 51 playable.
  POST /api/homework/upload: 7 trials held back, on the app's side: the route needs a signed file URL, and no test account can make one
Latest run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: running, 14 of 51 trials played.
410 readings of 112 questions.
Production: not connected.
For the person: https://cortad.com/lab shows this in the browser.
next: run_status 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b
```

## run

The app is up:

```
Run started: 9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b.
next: run_status 9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b
```

The app is still starting. `run_status` holds until the run has an id:

```
Starting your app for the run. Call run_status; it answers as soon as the run has an id.
```

The plan is spent. The ledger is the numbers; the checkout link is for the person:

```
Refused: 1 of 1 run used on the Free plan.
Last run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: score 71 of 100, interval 64 to 78, 3 findings, 51 of 51 trials played.
1 fix verified since that run:
  apps/api/src/agent/prompt.ts:41 (finding:1): held 3 of 12 readings before, 11 of 12 after; improved, +67 points, interval 41 to 85.
The next run would play 58 trials, 7 held out, 5 new from the changes.
The Hobby plan, $99 a month, includes 10 runs.
Production: not connected.
Nothing ran.
For the person: plans and checkout at https://cortad.com/pricing?checkout=ship
```

## run_status

Playing. The call held up to 45 seconds:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: running, 14 of 51 trials played.
410 readings of 112 questions.
next: run_status 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b
```

Finished:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 51 of 51 trials played.
Score 71 of 100, interval 64 to 78.
3 findings.
1,204 readings of 112 questions.
For the person: the report is at https://cortad.com/lab
next: findings
```

Stopped early. Each stop and fault names the side it is on and what comes next:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 11 of 51 trials played.
Score 90 of 100, interval 70 to 98.
1 finding.
240 readings of 112 questions.
Stopped at 11 of 51 trials, on the app's side: your app stopped answering at turn 11. Bring your app back up, then run again.
Fault on the app's side: Your code names llama-3.1-8b-instant, which api.groq.com does not serve. Rename the model in your code, then run again.
For the person: the report is at https://cortad.com/lab
next: findings
```

A verify that holds: both intervals are above zero and the held-out trials moved with the visible ones.

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 12 of 12 trials played.
Verify of finding:1 at apps/api/src/agent/prompt.ts:41.
Visible trials: held 3 of 12 readings before, 11 of 12 after; improved, +67 points, interval 41 to 85.
Held-out trials: held 2 of 8 readings before, 7 of 8 after; improved, +62 points, interval 30 to 88.
3 of 12 readings held before and 11 of 12 now.
For the person: the report is at https://cortad.com/lab
next: findings
```

A verify that overfit: the visible trials moved and the held-out trials did not. The file goes back.

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 12 of 12 trials played.
Verify of finding:4 at apps/api/src/agent/system.ts:12.
Visible trials: held 6 of 10 readings before, 10 of 10 after; improved, +40 points, interval 12 to 64.
Held-out trials: held 5 of 9 readings before, 5 of 9 after; no change, 0 points, interval -30 to 30.
Overfit: the visible trials moved and the held-out trials did not.
For the person: the report is at https://cortad.com/lab
next: findings
```

## findings

Worst first, grouped by the line the rule lives at. A list longer than one page ends with `page 1 of 3, call findings with page 2`.

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: 3 findings.
Score 71 of 100, interval 64 to 78.
1,204 readings of 112 questions: 1,150 decided, 54 unclear.
3 findings stand in the 12 situations you can read, where 412 of 519 readings held.
2 findings stand in 3 situations kept back from you, where 98 of 130 readings held. A fix is graded on those too.

2 findings at apps/api/src/agent/prompt.ts:41
finding:1  Does the reply refuse to state a refund policy the product does not publish?
  Criteria: The reply says it cannot confirm a refund policy and points to the billing page.
  Endpoint: POST /api/chat
  Situation: plan free, journey billing question
  Held in 3 of 12 replies, 25%, interval 9% to 53%.
  Decided by a model in 12 readings.
  Reply 2: "Yes, refunds are processed within 3 business days." (confidence 0.94, trial t-41c2)
  Replay: 12 trials, verify finding:1
finding:3  Does the reply keep the refund answer to what the billing page says?
  Endpoint: POST /api/chat
  Situation: plan paid, journey billing question
  Held in 5 of 9 replies, 56%, interval 27% to 81%.
  Unsettled: under the 22-reading floor.
  Decided by a model in 9 readings.
  Reply 1: "You can get a full refund any time in the first 60 days." (confidence 0.81, trial t-77a0)
  Replay: 9 trials, verify finding:3

1 finding at apps/api/src/agent/system.ts:12
finding:4  Does the reply stay in the language the student writes in?
  Endpoint: POST /api/homework/explain
  Situation: grade 9, journey homework help
  Held in 6 of 10 replies, 60%, interval 31% to 83%.
  Decided by code in 10 readings.
  Reply 1: "Sure! Let's solve this together." (confidence 1.00, trial t-0b19)
  Log: the student wrote in Spanish
  Log: the reply language was detected as English
  Replay: 10 trials, verify finding:4
```

## verify

Answers like `run`, with the finding named:

```
Verify of finding:1 started: 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a.
next: run_status 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a
```

## field_connect

```
Production is not connected.
1. The owner creates the key at https://cortad.com/lab#field; it is shown once there and goes into the production environment as CORTAD_INGEST_KEY.
2. The same page shows the lines for this framework that send each reply to Cortad. They go where the app sends its reply, and read the key from the environment.
3. Deploy. Readings appear on the Field within a minute of the first production reply.
```

## field

```
Production, last 30 days: 4,812 conversations, 4,790 read.
Rule checks held: 93% of 61,204 (1,120 unsure). Resolved 71%, frustrated 6%, asked for a human 2%, unanswered 4%.
Rules broken most: rule:answer-first (412), rule:language (188), rule:cite-source (97).
By journey: homework help 3,102 conversations, 94% held; billing question 410 conversations, 88% held.
For the person: https://cortad.com/lab#field
```
