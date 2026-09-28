# What each tool prints

Each result exactly as the tool returns it. The numbers are from a walk of a tutoring app; yours differ. Every tool is also `npx {{cortad}} <tool>` in a shell, with the same output.

A reading is one question checked against one reply. The last line of a run_status result is the next call.

## status

Right after a connect, before the read is done:

```
Cortad · tutor-app
Free: 1 of 1 run left this month, 60 of 60 verify trials left.
App: Your app is starting on this machine.
No run yet.
Production: not connected.
```

After the agent sent one real request to each endpoint that reaches the model, two on the chat, and before any run:

```
Cortad · tutor-app
Free: 1 of 1 run left this month, 60 of 60 verify trials left.
App: Your app answered on port 3100.
Endpoints your own requests proved (1):
  POST /api/chat: 2 requests reached gpt-4o-mini, 2 model calls each, 3.1 seconds a reply.
    The prompts carried 9 of the 46 rules read from your code, for example apps/api/src/agent/prompt.ts:41 "Never state a refund policy the product does not publish.".
    Tools that ran: search_lessons.
    Passages handed to the model: 3.
    Problem at apps/api/src/agent/system.ts:30: The reply carried "</student_profile>", markup from the prompt your app sent the model.
    Last request: "and the second question?", answered "For question 2, start by writing what the angle is opposite to.".
Endpoints the read found that no request has reached (1):
  POST /api/homework/explain  apps/api/src/routes/homework.ts:18
A run on the proven endpoints: 36 trials, 72 replies, about 6 minutes, about $0.38 on your OpenAI key for gpt-4o-mini.
No run yet.
Production: not connected.
A run starts only when the person asks: from Run in the browser, or from the run verb.
```

Once a run is playing, the read and the run:

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
Trials: 58 written.
  POST /api/homework/upload: 7 trials held back, on the app's side: the route needs a signed file URL, and no test account can make one
Latest run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: running, 14 of 51 trials played.
410 readings of 112 questions.
Production: not connected.
For the person: https://cortad.com/lab shows this in the browser.
next: run_status 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b
```

Each section in full, with `show` (`rules`, `standards`, `journeys`, `endpoints` or `trials`). A list longer than one page ends with `page 1 of 3, call status with show rules and page 2`.

```
Rules in the code: 16, in 5 files.
  apps/api/src/agent/prompt.ts:41  "Never state a refund policy the product does not publish."
  apps/api/src/agent/prompt.ts:44  "Point billing questions to the billing page."
  apps/api/src/agent/system.ts:12  "Answer in the language the student writes in."
  apps/api/src/agent/system.ts:15  "Keep an answer for a grade 9 student to grade 9 words."
  apps/api/src/agent/system.ts:19  "Ask which lesson the question is about before answering it."
  apps/api/src/agent/system.ts:22  "Give the method before the answer on homework."
  apps/api/src/agent/system.ts:30  "Leave the student's name out of the reply."
  apps/api/src/tools/search.ts:8  "Cite the lesson a fact comes from."
  apps/api/src/tools/search.ts:14  "Say so when search finds nothing, rather than answering from memory."
  apps/api/src/tools/search.ts:17  "Quote at most two sentences from a lesson."
  apps/api/src/agent/handoff.ts:6  "Hand a refund request to a person."
  apps/api/src/agent/handoff.ts:9  "Hand an account recovery to a person once the email is confirmed."
  apps/api/src/agent/billing.ts:21  "Tell a parent what the plan costs only from the pricing page."
  apps/api/src/agent/billing.ts:27  "Never promise a teacher a feature that is not released."
  apps/web/src/chat/welcome.ts:3  "Greet a first lesson with what the student can ask."
  apps/web/src/chat/welcome.ts:11  "End each homework answer with one practice question."
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

The plan is spent, and nothing ran:

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

Finished. Tell the person what was measured before the score, and what the rest waits on:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 51 of 51 trials played.
112 of 140 checks measured; score 71 of 100 on those 112, interval 64 to 78.
28 not measured: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no trial yet.
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

Replies that did not count come before the score, each part saying whose it is, with the request to paste where there is one:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 31 of 31 trials played.
17 of 33 replies did not count: 9 answered HTTP 502 at backend/app/api/resume_writing.py:91 (yours; request below), 6 refused the shape we sent to POST /api/drill/{id}/answer (HTTP 422) (ours; request below), 2 got no answer from /api/chat before we stopped waiting at 90 seconds (ours).
  Request for the 9 at backend/app/api/resume_writing.py:91: curl -X POST 'http://localhost:8004/api/resume/writing' -H 'authorization: <redacted>' -H 'content-type: application/json' --data-raw '{"message":"rewrite my summary"}'
    Answered: Bad Gateway
    verify finding:1 replays them.
  Request for the 6 from /api/drill/{id}/answer: curl -X POST 'http://localhost:8004/api/drill/7/answer' -H 'content-type: application/json' --data-raw '{"message":"hi"}'
    Answered: {"detail":[{"loc":["body","answer"],"msg":"field required"}]}
20 of 40 checks measured; score 88 of 100 on those 20, interval 70 to 96; the 17 of 33 replies that did not count are not in it.
```

A part marked yours is the app failing: run the request, fix what it shows, then verify the finding named. A part marked ours is Cortad's to fix, and nothing in the app changes for it. A masked value (`<redacted>`) is the app's own sign-in or key; put it back before running the request.

Your app stopped during the run and was started again: that is a finding of its own, `crash:1`, with the error your app printed and the turn it happened at. Fix the error it quotes. It has no trials to replay, so `verify` refuses it; the next run that finishes without it is the proof. A `Data:` line says whether the run wrote to a copy of your app's database or into the real one.

A verify that holds: both intervals are above zero and the held-out trials moved with the visible ones.

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 12 of 12 trials played.
Verify of finding:1 at apps/api/src/agent/prompt.ts:41.
Visible trials: held 3 of 12 readings before, 11 of 12 after; improved, +67 points, interval 41 to 85.
Held-out trials: held 2 of 8 readings before, 7 of 8 after; improved, +62 points, interval 30 to 88.
On the 12 trials replayed, 0 of 12 replies were errors before and 0 of 12 now. 3 of 12 readings held before and 11 of 12 now. On the 12 readings both runs settled, it gained 67 points, and the real move is between 41 points and 85 points. That is outside the 18 points that come back different on temperature alone. The evidence supports keeping the fix: 3 of 12 held before and 11 of 12 now, 67 points up.
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

A verify with no pair: the two runs read the finding's question on no common trial, so there is no move to print, and the line says why. It is not a verdict on the change.

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 1 of 1 trial played.
Verify of finding:2 at backend/tools/refunds.py.
Held-out trials: no pair for this question.
On the 1 trial replayed, 0 of 3 replies were errors before and 0 of 3 now. No reading of this question pairs between the two runs. Not paired: 1 trial (t-5d10): the replay took a different turn at reply 2, and the question was not asked on the replay because its condition did not hold (the customer has reached this step of the journey: Agent states amount, asks consent). The evidence cannot tell whether to keep the fix: no reading of this question pairs between the two runs. This finding rests on 2 readings, 2 of them failures, so a replay of its trials alone cannot leave the noise: even if both failures hold on the replay, 2 readings cannot tell that apart from chance. A verify of it plays 10 more trials in this situation to reach about 22 readings.
For the person: the report is at https://cortad.com/lab
next: findings
```

A verify whose replies did not pair: the replay took other turns and the reader settled other replies, so the question's failure rate on the same trials is compared instead, with the 10 new trials the verify played in the finding's situation. Readings the reader could not settle count on neither side.

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 11 of 11 trials played.
Verify of finding:2 at backend/tools/refunds.py.
Visible trials: failed on 2 of 2 settled readings before, 1 of 29 after, 4 unclear after, over 1 trial replayed and 10 new; improved, +97 points, interval 29 to 99.
Held-out trials: failed on 2 of 16 settled readings before, 0 of 15 after, 1 unclear after; too few to state a rate (15 of the 22 it needs).
On the 1 trial replayed, 0 of 3 replies were errors before and 0 of 4 now. On the 10 more trials played in this situation, 0 of 30 replies were errors. Reply for reply, nothing could be paired: the reader could not settle any reply of this question that both runs read. Across the 1 trial replayed in this situation and the 10 more this verify played there, this question failed on 2 of 2 settled readings before and 1 of 29 now; 4 readings now could not be settled either way and count on neither side. As two separate samples the failure rate fell 97 points, and the real fall is between 29 and 99 points. That is outside the 18 points that come back different on temperature alone. The held-out trials have too few readings to say (15 of the 22 each rate needs). The evidence supports keeping the fix: this question failed on 2 of 2 settled readings before and 1 of 29 now, 97 points fewer.
For the person: the report is at https://cortad.com/lab
next: findings
```

## findings

Worst first, grouped by the line the rule lives at. A list longer than one page ends with `page 1 of 3, call findings with page 2`.

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: 3 findings.
112 of 140 checks measured; score 71 of 100 on those 112, interval 64 to 78.
28 not measured: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no trial yet.
1,204 readings of 112 questions: 1,150 decided, 54 unclear.
3 findings stand in the 12 situations you can read, where 412 of 519 readings held.
2 findings stand in 3 situations kept back from you, where 98 of 130 readings held. A fix is graded on those too.

2 findings at apps/api/src/agent/prompt.ts:41
finding:1  Does the reply refuse to state a refund policy the product does not publish?
  Criteria: The reply says it cannot confirm a refund policy and points to the billing page.
  Endpoint: POST /api/chat
  Situation: plan free, journey billing question
  Broke in 9 of 12 replies, 75%, interval 47% to 91%.
  Decided by a model in 12 readings.
  Reply 2: "Yes, refunds are processed within 3 business days." (confidence 0.94, trial t-41c2)
  Replay: 12 trials, verify finding:1
  This finding rests on 12 readings, 9 of them failures: a verify shows the fix if at least 4 of the 9 hold on the replay.
finding:3  Does the reply keep the refund answer to what the billing page says?
  Endpoint: POST /api/chat
  Situation: plan paid, journey billing question
  Broke in 4 of 9 replies, 44%, interval 19% to 73%.
  Unsettled: under the 22-reading floor.
  Decided by a model in 9 readings.
  Reply 1: "You can get a full refund any time in the first 60 days." (confidence 0.81, trial t-77a0)
  Replay: 9 trials, verify finding:3
  This finding rests on 9 readings, 4 of them failures: a verify shows the fix only if all 4 failures hold on the replay.

1 finding at apps/api/src/agent/system.ts:12
finding:4  Does the reply stay in the language the student writes in?
  Endpoint: POST /api/homework/explain
  Situation: grade 9, journey homework help
  Broke in 4 of 10 replies, 40%, interval 17% to 69%.
  Decided by code in 10 readings.
  Reply 1: "Sure! Let's solve this together." (confidence 1.00, trial t-0b19)
  Log: the student wrote in Spanish
  Log: the reply language was detected as English
  Replay: 10 trials, verify finding:4
  This finding rests on 10 readings, 4 of them failures: a verify shows the fix only if all 4 failures hold on the replay.
```

## verify

Answers like `run`, with the finding named:

```
Verify of finding:1 started: 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a.
next: run_status 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a
```

When the trials it replays read the finding's question too few times for a rate, it says before they play how many new trials it adds in the finding's situation. They are verify trials from the plan.

```
Verify of finding:2 started: 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a.
Playing 10 more trials in this situation to reach about 22 readings of this question; the run before read it 2 times here.
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
