# The harness

This project was worked mostly by AI agents (Claude Code), one session after another, each starting
with no memory of the last. The repository is built so that a fresh session can pick up the work in a
few minutes, does not repeat a mistake an earlier one already paid for, and cannot report a result it
did not get. This document explains the parts and why each exists. Most of them were added after
something went wrong; the incident is named where it explains the rule.

## 1. What a session loads, and what it does not

`CLAUDE.md` imports three documents with `@` lines, so every session starts with exactly these four
files in context:

| file | holds |
|---|---|
| `CLAUDE.md` | what the project is, the fixed workflow, the rules for keeping this set small |
| `docs/HANDOFF.md` | layout, the seam, the data flow, the procedures, the rules earned by measurement, the doc map |
| `docs/next-steps.md` | the task queue: open items only, and the do-not-retry table |
| `docs/lab-runbook.md` | how to run BDS and read what comes back |

Everything else is read on demand. The findings docs are 30-190KB each, so they are read by section:
`node tools/docs-check.mjs toc docs/<doc>.md` prints each heading with its line number and size, and the
session reads that range.

The set is paid for by every session before any work starts, so it has a budget:
`node tools/docs-check.mjs` fails when the four files exceed 64KB, or the queue alone exceeds 24KB. When it
fails, finished text moves out (to `docs/completed-task.md` or a findings doc); it is never squeezed.

## 2. One place for every number

The coverage numbers (how many required names have an address, how many resolve) are written in one
place: the block at the top of `docs/status.md`, generated from the data by
`node tools/status-summary.mjs --write`. On one day four auto-loaded files gave four different answers,
each a hand-typed copy from a different week. Now `docs-check` fails on any hand-typed coverage pair in
the auto-loaded set and on a stale generated block, and every other document points at the block.

The same check runs `tools/arch-inventory.mjs --dry`, which fails when a hand verdict in
`data/arch-classes.json` names something that no longer needs one: resolving a name silently
invalidates its verdict, and nothing else would notice.

## 3. The queue

`docs/next-steps.md` is the only list of what to do. Each item is about ten lines: the goal, the
candidates, the command to start with, the done criterion, and a pointer to the findings doc with the
evidence. The fixed workflow (`CLAUDE.md`, `HANDOFF.md` section 2):

1. take the **top** item (the user's request takes priority);
2. do it;
3. record the evidence in `data/resolved-<v>.json`'s `provenance` and in the findings doc;
4. regenerate the numbers;
5. move the finished item to the top of `docs/completed-task.md` and **write the next item at the top of
   the queue, concretely enough that a session with no memory can start on it**;
6. `docs-check` must exit 0; commit; report.

Step 5 is what makes the next session cheap: it never has to rediscover what to do or where to start.

## 4. What counts as done

**Done means run on both builds, with bdsx's own code.** Not one build, not static evidence, not a
call counter:

| level | proves | example of what it did not prove |
|---|---|---|
| a candidate from one route | nothing yet | single-route promotions were right 0 of 1 times on the checkable sample |
| two independent routes agree, body read | the address, statically | -- (4 of 4 on the same sample) |
| a counter probe fires | the address is called | `Actor::hurt` was promoted on a call count and was a constructor |
| bdsx's own hook fires, the probe checks the values | the prototype | `Mob::_hurt` was counter-"confirmed" and killed the server on the first hit: its parameters had changed |
| the live-bot harness drives it as a real client | the event under real traffic | some events only a client's packets reach |

A check that has only ever seen one answer (only `true`, only non-null) is a candidate in a findings
doc, not a table entry. The provenance of every confirmed name says what was run, how, and what came
out, so a later session can tell how a name got in.

## 5. Mistakes become rules

`HANDOFF.md` section 7 is a short list of rules, each paid for once: report precision before yield;
accept where independent routes agree; read the body before promoting; doubt the shipped name first when
a later route disagrees; never fill a slot by position; never type an address in decimal (four sessions
were lost that way: `tools/host/make-probes.mjs` refuses anything that is not the start of a function);
diff the required-name sets when only one build dies. The do-not-retry table at the end of the queue
does the same for whole methods (byte matching, BinDiff, RTTI, ...), with the measurement that closed
each, so no session spends a day rediscovering that it does not work.

## 6. Runs fail closed

A session that prints nothing reads exactly like a probe that found nothing. `tools/host/session.mjs`
therefore decides itself whether a run is a result, and exits 1 with the reason when the driver never
reported an exit code, nothing matched (not even `Server started`), a crash marker appeared, or the exit
code was nonzero without BDS's own `Quit correctly`. `tools/host/verify-pair.mjs` runs both builds at
once and exits 0 only if both sessions passed, no FAIL line came back, and each side printed at least one
PASS (a probe that failed to load, or whose client never joined, prints no FAIL either). The output filter always keeps crash
markers and FAIL lines, even past its line cap: a cap once hid a FAIL from the count.

## 7. Several agents at once

`/bdsx-parallel` (`.claude/skills/bdsx-parallel/`) runs several independent queue items as subagents.
The main agent only plans, dispatches and reports; each subagent gets the brief in `subagent-brief.md`
and owns one item to the commit. They share one working tree and one pair of BDS instances, so writes
happen under two tickets (`tools/host/agent-lock.mjs`):

| ticket | covers | why one ticket |
|---|---|---|
| `verify` | `bdsx/` and both lab instances | a session copies `bdsx/` into both instances: an agent editing bdsx while another runs a session would verify half of the edit |
| `repo` | `data/`, `docs/`, `git commit` | short; keeps two commits from interleaving |

`verify` is always taken before `repo` (the script refuses the reverse, which would deadlock). A ticket
is a name with a deadline rather than a process lock, because an agent holds it across many separate
tool calls. Reading and static analysis need no ticket, so agents overlap there.

## 8. Memory outside the repository

Claude Code keeps a per-project memory outside the repository. It held what must not be committed (the
test host's address) and what is about working with the user rather than about the code: the decision
to drop 2024-only concepts instead of emulating them, that one-sided checks belong in findings docs, how
to resume a subagent stopped by a rate limit. Anything a future session needs about the code itself goes
in the repository instead.

## 9. Where the parts are

| part | file |
|---|---|
| entry point and workflow | `CLAUDE.md`, `docs/HANDOFF.md` section 2 |
| budgets, stale numbers, stale verdicts | `tools/docs-check.mjs` |
| the generated numbers | `tools/status-summary.mjs` -> `docs/status.md` |
| the queue and the closed methods | `docs/next-steps.md` |
| the completion log | `docs/completed-task.md` |
| evidence per name | `data/resolved-<v>.json` `provenance`, `docs/findings-*.md` |
| sessions that fail closed | `tools/host/session.mjs`, `verify-pair.mjs`, `peek.mjs` |
| tickets and parallel agents | `tools/host/agent-lock.mjs`, `.claude/skills/bdsx-parallel/` |
| the client harness | `tools/livebot.cjs`, `tools/livebot-probe.ts`, `docs/findings-bot.md` |
