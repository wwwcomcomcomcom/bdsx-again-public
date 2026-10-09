---
name: bdsx-parallel
description: Run several next-steps queue items at once as subagents, sharing the two lab BDS instances through a ticket. Use ONLY when the user invokes /bdsx-parallel explicitly -- never start it on your own, and never use it for a single task.
---

# bdsx-parallel -- several queue items at once, as subagents

**This skill runs only when the user types `/bdsx-parallel`.** Do not start it on your own judgement.
A single-item task does not use this skill -- just do it.

**You (the main agent) only manage.** You do not look for symbols, read bodies or run probes. You do
four things: pre-flight check -> dispatch -> wait -> report.

## Invocation

```
/bdsx-parallel                          pick 3 mutually independent items from the top of the queue
/bdsx-parallel Q1-2 Q1-A-2 Q3           only those items
/bdsx-parallel --agents=4 Q1            number of agents
/bdsx-parallel --model=opus Q1-2 Q3     the subagents' model (asked if not given)
/bdsx-parallel --dry-run                show the dispatch plan and stop
```

Items are named by `docs/next-steps.md`'s section numbers (`Q1`; `Q1-2` is item 2 of Q1's "next";
`Q1-A-2` is item 2 of Q1-A). The user may also describe them in words -- find the matching items in the
queue and confirm.

## 0. Pre-flight -- if any of these blocks, stop and tell the user

```sh
git status --short                          # dirty: show what is uncommitted and ask what to do
git -C bdsx status --short                  # uncommitted bdsx edits would be verified by every agent
node tools/host/agent-lock.mjs status       # a verify/repo ticket left EXPIRED: tell the user
node tools/host/peek.mjs layout51 x         # the lab exists (no output is fine; an error is not)
```

If the lab is not set up (`node tools/host/setup-lab.mjs`) or this is not the Windows machine, ask
whether to run only static items.

If `--model=` was not given, **ask with `AskUserQuestion`** (recommended default: the same model as the
parent -- this project lives on reading bodies and judging evidence, and a weaker model promotes wrong
addresses).

## 1. Choosing items and checking independence

If the user named items, take them. Otherwise take N from the top of `docs/next-steps.md`'s queue.
**Check for conflicts first.** If two items share any of the following, give them to the same agent or
drop one:

- the same probe file (`tools/*-probe.ts`) or the same driver pair
- the same family of names in `data/resolved-<v>.json` (a class's getters, say)
- one item's result is the other's premise (the queue says so when it is)

With `--dry-run`, print the plan here and stop.

## 2. Run directory and dispatch

```sh
node -e "const d='work/parallel/'+new Date().toISOString().replace(/[-:]/g,'').slice(0,15);require('fs').mkdirSync(d,{recursive:true});console.log(d)"
```

Write the run id, the items, the agent ids (`agent-a`, `agent-b`, ...) and the model to `<run>/plan.md`.
`work/` is gitignored, so none of this is committed.

Then call the `Agent` tool **once per agent, all in one response** (they start in parallel).
`subagent_type` is `general-purpose`, `model` as chosen. The prompt is
`.claude/skills/bdsx-parallel/subagent-brief.md` with its blanks (`{{...}}`) filled in, verbatim.

## 3. While waiting

Do no work. If the user asks, answer **only the current state** with
`node tools/host/agent-lock.mjs status`, the run directory's listing and `git log --oneline -5`.
**Never make up the result of an agent that has not come back.** "Still running" is the answer.

If an agent comes back with a failure, do not fix it yourself. The agent has already recorded it.

## 4. Afterwards -- check the repository, then report

When all are back, run these and judge by **the repository's state, not the claims**:

```sh
git log --oneline -10
git status --short                                  # must be empty
git -C bdsx status --short                          # must be empty
node tools/host/agent-lock.mjs status               # all free; otherwise report the leftover ticket
node tools/merge-symbols.mjs 1.26.40.8 data/merged-1.26.40.8.json
node tools/merge-symbols.mjs 1.26.51.1 data/merged-1.26.51.1.json
```

If a ticket is left, do not clear it: **report it to the user** (that agent died midway, and the
repository may be half-written).

Report:

- one line per item: **DONE / FAILED / PARTIAL**, what was confirmed by execution on which build, the commit
- for a failure, why, and how it was left in the queue
- the change in numbers (the merge's last line, before and after)
- the next queue item

## The ticket rules (the one invariant you watch)

| ticket | covers | who |
|---|---|---|
| `verify` | the `bdsx/` working tree + inst40 + inst51 | agents that change bdsx or run sessions |
| `repo` | `data/`, `docs/`, `git commit` | every agent that writes files |

**`verify` first, `repo` second.** The reverse is a deadlock, and `agent-lock.mjs` refuses it.
`session.mjs`'s own `inst40`/`inst51` locks sit below that and are free for the `verify` holder.

Verification is **always both builds at once**, in one command:
`node tools/host/verify-pair.mjs <d40> <d51> --grep=...`.

## What this skill does not do

- Start without the user calling it.
- Spawn subagents for a single item.
- Pretend there is more than one lab: more than 3 agents is fine, but **there is one `verify` ticket** --
  a batch heavy on verification serialises on it. Say at planning time "N of these items need the lab".
- Rewrite subagents' commits.
