# What each verb answers

One result per verb, as the tool returns it. The numbers are from a walk of a tutoring app; yours differ.

## status

```
Cortad · ulaim · Free: 0 of 1 run left this month, 60 of 60 verify trials.
App: Your app answered during startup on port 3100. This is the last recorded state, not a new health check.
Conversations written: 51. A run can start.
Latest run 8f2a1c4e-... succeeded: played 51 of 51. Score 71 of 100. 7 findings; call findings. https://cortad.com/lab
Production: not connected. field_connect says how.
```

## run

```
Run started: 9a10b3d2-.... Poll run_status every 30 seconds and stay quiet unless the count moved. Watch it: https://cortad.com/lab
```

When the plan is spent:

```
The first run was free. Another needs Hobby ($99/month) or Growth ($499/month): https://cortad.com/pricing?checkout=ship
Show this link to the person in one sentence and wait for them.
```

## run_status

```
run 9a10b3d2-... running: played 14 of 51. Poll again in 30 seconds. https://cortad.com/lab
```

```
verify 7c31e0aa-... succeeded: played 12 of 12. Verify of finding:1: apps/api/src/agent/prompt.ts:41 · held 3 of 12 before, 11 of 12 after · move 67 (41 to 85) · improved. Held-out situations: no change. The move is outside the noise. https://cortad.com/lab
```

## findings

```
Run 8f2a1c4e-.... 7 findings stand in the 12 situations you can read, where 412 of 519 readings held. 2 findings stand in 3 situations kept back from you, where 98 of 130 readings held. You cannot read them, and a fix is graded on those too.
1. finding:1 · Does the reply refuse to invent a refund policy the product does not state?
   held 3 of 12 (25%, interval 8% to 53%) · apps/api/src/agent/prompt.ts:41 · plan free, journey billing
   reply 2: "Yes, refunds are processed within 3 business days." (p=0.94)
   replay: 12 trials · verify finding:1
2. finding:4 · Does the reply stay in the student's language?
   held 6 of 10 (60%, interval 31% to 83%) · apps/api/src/agent/system.ts:12 · grade 9, journey homework
   reply 1: "Sure! Let's solve this together." (p=0.88)
   replay: 10 trials · verify finding:4
Fix one finding at a time, in the file it names, then verify it. https://cortad.com/lab
```

## verify

```
Verify started: 7c31e0aa-.... Poll run_status every 30 seconds and stay quiet unless the count moved. Watch it: https://cortad.com/lab
```

## dispute

```
The dispute is in the owner's log. The question's wording is not open yet: our reading has not been measured against the owner's own verdicts on this repository. The check and its rate are unchanged.
```

## field_connect

```
Production is not connected yet.
1. The owner creates the key at https://cortad.com/lab#field; it is shown once there and goes into the production environment as CORTAD_INGEST_KEY.
2. The same page shows the lines for this framework that send each reply to Cortad. Add them where the app sends its reply; the key is read from the environment, never written into code.
3. Deploy. Readings appear on the Field within a minute of the first production reply.
```

## field

```
Production, last 30 days: 4,812 conversations, 4,790 read.
Rulings held: 93% of 61,204 (1,120 unsure). Resolved 71%, frustrated 6%, asked for a human 2%, unanswered 4%.
Rules broken most: rule:answer-first (412), rule:language (188), rule:cite-source (97).
By journey: homework 3,102 convs, 94% held; billing 410 convs, 88% held.
https://cortad.com/lab#field
```
