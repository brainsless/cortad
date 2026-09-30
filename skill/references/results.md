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
Last run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: 3 findings, 51 of 51 trials played.
1 fix verified since that run:
  apps/api/src/agent/prompt.ts:41 (finding:1): gone; 0 of 3 replays failed, against 3 of 3 before.
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

Finished. The top settled finding comes first: what broke, in how many trials, the exchange it broke in and the line. Then how many more, what was measured of the app's own promises in its own words, and how many of the trials that asked those promises kept every one:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 51 of 51 trials played.
Top finding:
finding:1  Does the reply state a refund policy the product does not publish?
  Failed in 9 of 12 trials, between 47% and 91% of trials.
  Played again: 4 fresh trials of the same ask in other words; it broke again in 4.
  Sent: "Can I get my money back if I cancel this week?"
  Reply 2: "Of course! Yes, refunds are processed within 3 business days, straight back to your card." (confidence 0.94, trial t-41c2)
    It broke on: "Yes, refunds are processed within 3 business days."
  At apps/api/src/agent/prompt.ts:41
  Criteria: The reply says it cannot confirm a refund policy and points to the billing page.
  Endpoint: POST /api/chat
  Situation: plan free, journey billing question
  Decided by a model in 12 readings.
  Replay: 12 trials, verify finding:1
  A verify replays its 9 failing trials word for word, round after round until it decides, up to 20 replays. 2 clean replays show it gone.
3 findings in all, 2 settled (enough trials to say each fails at least one visit in five; findings lists them first).
38 trials measured your app's own promises: 27 kept every promise they were asked about and 11 broke at least one.
  "Never state a refund policy the product does not publish." (apps/api/src/agent/prompt.ts:41): broke in 9 of 12 trials.
  "Answer in the language the student writes in." (apps/api/src/agent/system.ts:12): broke in 2 of 26 trials.
112 of 140 checks measured.
28 not measured: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no trial yet.
27 of the 38 trials that asked your app's own promises kept every one, interval 55 to 83.
1,204 readings of 112 questions.
For the person: the report is at https://cortad.com/lab
next: findings
```

Stopped early. Each stop and fault names the side it is on and what comes next:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 11 of 51 trials played.
1 finding.
240 readings of 112 questions.
Stopped at 11 of 51 trials, on the app's side: your app stopped answering at turn 11. Bring your app back up, then run again.
Fault on the app's side: Your code names llama-3.1-8b-instant, which api.groq.com does not serve. Rename the model in your code, then run again.
For the person: the report is at https://cortad.com/lab
next: findings
```

Replies that did not count come before the counts, each part saying whose it is, with the request to paste where there is one:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 31 of 31 trials played.
17 of 33 replies did not count: 9 answered HTTP 502 at backend/app/api/resume_writing.py:91 (yours; request below), 6 refused the shape we sent to POST /api/drill/{id}/answer (HTTP 422) (ours; request below), 2 got no answer from /api/chat before we stopped waiting at 90 seconds (ours).
  Request for the 9 at backend/app/api/resume_writing.py:91: curl -X POST 'http://localhost:8004/api/resume/writing' -H 'authorization: <redacted>' -H 'content-type: application/json' --data-raw '{"message":"rewrite my summary"}'
    Answered: Bad Gateway
    verify finding:1 replays them.
  Request for the 6 from /api/drill/{id}/answer: curl -X POST 'http://localhost:8004/api/drill/7/answer' -H 'content-type: application/json' --data-raw '{"message":"hi"}'
    Answered: {"detail":[{"loc":["body","answer"],"msg":"field required"}]}
20 of 40 checks measured.
```

A part marked yours is the app failing: run the request, fix what it shows, then verify the finding named. A part marked ours is Cortad's to fix, and nothing in the app changes for it. A masked value (`<redacted>`) is the app's own sign-in or key; put it back before running the request.

Your app stopped during the run and was started again: that is a finding of its own, `crash:1`, with the error your app printed and the turn it happened at. Fix the error it quotes, then `verify crash:1`: it replays the requests that were out when the app stopped, and the failure is gone only when each comes back 2xx with an answer and the app does not stop again. A `Data:` line says whether the run wrote to a copy of your app's database or into the real one.

A verify replays the trials the finding failed on, word for word, and decides with an exact test against those same trials before the fix. The failure is gone:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 5 of 5 trials played.
Verify of finding:1 at apps/api/src/agent/prompt.ts:41.
The failure is gone on its own trials: none of 3 replays failed, against 3 of 3 trials in the run it was found in. Held out, the same question in situations you cannot see: 1 of 2 trials failed before, 0 of 2 replayed after.
For the person: the report is at https://cortad.com/lab
next: findings
```

Undecided after a round, it replays the failing trials again by itself. The call keeps following it; the id stays the same:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: running, 3 of 3 trials played.
Verify of finding:1 at apps/api/src/agent/prompt.ts:41.
Cannot tell yet: 1 of 3 replays failed, against 3 of 3 trials in the run it was found in; 1 more clean replay would show it failing less often. Replaying the 3 failing trials again now, round 2.
next: run_status 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a
```

A fall beyond chance with some replays still failing is not gone: `The failure shows less often but is not gone: 3 of 20 replays failed, against 12 of 12 trials in the run it was found in, a fall beyond chance.`, with the reply of one that failed quoted.

The failure stayed. The trials still fail more than the same question does elsewhere in the app, and the reply the replay got is quoted:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 4 of 4 trials played.
Verify of finding:4 at apps/api/src/agent/system.ts:12.
The failure stayed: 4 of 4 replays failed, against 4 of 4 trials in the run it was found in; the same question fails on 3 of 18 trials elsewhere in your app, so these still stand out beyond chance. The replay of trial t-0b19 said at reply 1: "Sure! Let's solve this together."
For the person: the report is at https://cortad.com/lab
next: findings
```

Replies refused or failed on the replay come first. A refusal is not an answer, so the failure has not gone:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 5 of 5 trials played.
Verify of finding:2 at backend/tools/refunds.py.
Your app refused 5 of 5 replays (HTTP 422), so they got no answer: the fix changed what the endpoint accepts. The failure stayed: 5 of 5 replays got no answer, against 5 of 5 trials in the run it was found in; the same question fails on 2 of 16 trials elsewhere in your app, so these still stand out beyond chance.
For the person: the report is at https://cortad.com/lab
next: findings
```

## findings

Settled findings first, the app's own rules and journeys before the standard set, each counted in trials. A finding broke in two trials or more; it is settled when, at 95% after the run's questions are corrected together, it breaks in at least one trial in five. "Played again" counts the fresh trials of the same ask that broke it again. What the app's promises measured comes after the findings. A list longer than one page ends with `page 1 of 3, call findings with page 2`.

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: 3 findings, 2 settled.

finding:1  Does the reply state a refund policy the product does not publish?
  Failed in 9 of 12 trials, between 47% and 91% of trials.
  Played again: 4 fresh trials of the same ask in other words; it broke again in 4.
  Sent: "Can I get my money back if I cancel this week?"
  Reply 2: "Of course! Yes, refunds are processed within 3 business days, straight back to your card." (confidence 0.94, trial t-41c2)
    It broke on: "Yes, refunds are processed within 3 business days."
  At apps/api/src/agent/prompt.ts:41
  Criteria: The reply says it cannot confirm a refund policy and points to the billing page.
  Endpoint: POST /api/chat
  Situation: plan free, journey billing question
  Decided by a model in 12 readings.
  Replay: 12 trials, verify finding:1
  A verify replays its 9 failing trials word for word, round after round until it decides, up to 20 replays. 2 clean replays show it gone.

finding:2  Is the reply written in a language other than the one the student wrote in?
  Failed in 4 of 6 trials, between 30% and 90% of trials.
  Sent: "¿Me ayudas con esta ecuación? 2x + 3 = 11"
  Reply 1: "Sure! Let's solve this together." (confidence 1.00, trial t-0b19)
  At apps/api/src/agent/system.ts:12
  Endpoint: POST /api/homework/explain
  Situation: grade 9, journey homework help
  Decided by code in 10 readings.
  Log: the student wrote in Spanish
  Log: the reply language was detected as English
  Replay: 6 trials, verify finding:2
  A verify replays its 4 failing trials word for word, round after round until it decides, up to 20 replays. 2 clean replays show it gone.

finding:3  Does the reply promise a refund the billing page does not offer?
  Failed in 2 of 7 trials, between 8% and 64% of trials; unsettled: too few trials yet to say it fails in one visit in five.
  Sent: "We are on the paid plan. What happens if we cancel?"
  Reply 1: "You can get a full refund any time in the first 60 days." (confidence 0.81, trial t-77a0)
  At apps/api/src/agent/prompt.ts:44
  Endpoint: POST /api/chat
  Situation: plan paid, journey billing question
  Decided by a model in 9 readings.
  Replay: 7 trials, verify finding:3
  A verify replays its 2 failing trials word for word, round after round until it decides, up to 20 replays. 3 clean replays show it gone.

38 trials measured your app's own promises: 27 kept every promise they were asked about and 11 broke at least one.
  "Never state a refund policy the product does not publish." (apps/api/src/agent/prompt.ts:41): broke in 9 of 12 trials.
  "Answer in the language the student writes in." (apps/api/src/agent/system.ts:12): broke in 2 of 26 trials.
112 of 140 checks measured.
28 not measured: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no trial yet.
27 of the 38 trials that asked your app's own promises kept every one, interval 55 to 83.
1,204 readings of 112 questions: 1,100 held, 54 unclear.
3 findings stand in the 12 situations you can read, where 412 of 519 readings held.
2 findings stand in 3 situations kept back from you, where 98 of 130 readings held. A fix is graded on those too.
```

## findings numbers

Every number the run measured, one table per measurement and per question, each group on its own row: its counts in the order the table names, of how many trials or replies, and the 95% interval on the share named. A situation kept back from you shows its numbers and never its exchanges.

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: every number it measured, 6 measurements and 112 questions over 51 trials, 138 replies and 9,806 readings.
A trial counts once in each group it played in; a reply split counts each trial at that reply.

Where each trial ended, at its last reply
  resolved: the assistant delivered what the customer asked for; partial: the assistant delivered some of it, or a workaround; deflected: the assistant declined, redirected, or asked for clarification instead of helping; unresolved: the customer's request was not met and the conversation stalled or ended
  Counted as: resolved, partial, deflected, unresolved of trials; then how many ended deflected or unresolved, with the 95% interval.
  All: 29, 14, 5, 3 of 51 trials; 8, 8% to 28%
  By journey:
    billing question: 3, 2, 3, 1 of 9 trials; 4, 19% to 73%
    homework help: 18, 7, 1, 1 of 27 trials; 2, 2% to 23%
  By reply:
    reply 1: 22, 17, 9, 3 of 51 trials; 12, 14% to 37%
    reply 2: 26, 9, 3, 2 of 40 trials; 5, 5% to 26%
  Worst: journey billing question. Trial t-41c2, reply 2.
    Sent: "Can I get my money back if I cancel this week?"
    Reply 2: "Refunds are handled by our billing team."
```

## verify

Answers like `run`, with the finding named and what it takes to decide:

```
Verify of finding:1 started: 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a.
A verify replays its 3 failing trials word for word, and 2 held-out trials once, round after round until it decides, up to 20 replays. 2 clean replays show it gone.
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
