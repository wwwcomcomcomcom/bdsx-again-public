# bdsx-again

How [bdsx](https://github.com/bdsx/bdsx) was brought back to life on current Minecraft Bedrock Dedicated
Server builds after Mojang stopped shipping `bedrock_server.pdb`.

bdsx found every function it hooks by reading the PDB at runtime. Without it, bdsx cannot start. This
project replaced the PDB with a `name -> address` table generated offline for each BDS build, and
patched bdsx to run on it. The result is the bdsx fork,
**[wwwcomcomcomcom/bdsx](https://github.com/wwwcomcomcomcom/bdsx)**, which runs on BDS 1.26.40.8 and
1.26.51.1; its README explains the approach and its limits for plugin authors.

This repository is the workshop behind it: the tooling that finds addresses in a binary with no
symbols, the evidence for every address in the table, the lab that runs both BDS builds and checks each
result by execution, and the harness that let AI agents do most of this work across many sessions
without losing the thread. The bdsx fork is included as a submodule (`bdsx/`).

## 1. The agent harness

The work was done mostly by Claude Code, one session after another, each starting with no memory of the
last. The repository is built so that a fresh session picks up where the last one stopped, does not
repeat a mistake an earlier one paid for, and cannot report a result it did not get:

- **A small, fixed starting context.** `CLAUDE.md` imports exactly three documents
  (`docs/HANDOFF.md`, `docs/next-steps.md`, `docs/lab-runbook.md`); everything else is read by section on
  demand. `tools/docs-check.mjs` holds that set to a byte budget.
- **One queue, one workflow.** Take the top item of `docs/next-steps.md`, record the evidence, move the
  finished item to `docs/completed-task.md`, and leave the next item at the top of the queue concrete
  enough for a session with no memory to start on it.
- **Numbers that cannot drift.** Coverage figures are generated into one block of `docs/status.md`;
  the check fails on any hand-typed copy.
- **A strict bar for "done":** run on both builds, through bdsx's own code. A call counter proves an
  address, not a prototype; one route alone proves nothing. Every confirmed name carries provenance.
- **Mistakes become rules.** `docs/HANDOFF.md` section 7 and the do-not-retry table at the end of the
  queue record what each failure cost, so it is paid only once.
- **Several agents at once.** `/bdsx-parallel` (`.claude/skills/`) dispatches independent queue items to
  subagents that share one working tree and one lab through two ordered tickets
  (`tools/host/agent-lock.mjs`).

`docs/harness.md` explains each part and the incident behind it.

## 2. Finding addresses without symbols

The reference point is BDS 1.21.3.01, the last build with a PDB. Byte matching does not survive the
compiler and code changes in between (whole-function byte matching paired 1 of 736 functions), so every
route here anchors on structure the compiler and linker have to keep:

| route | idea | tools | doc |
|---|---|---|---|
| virtual tables | walk the vftables, align them with 2024's; keep a slot only where two independently seeded walks agree; name slots by Endstone's header order | `vftable-scan`, `vftable-match`, `vftable-corroborate`, `endstone-slots`, `level-anchored` | `findings-vftable.md`, `findings-slots.md` |
| ECS components | EnTT names a component by the FNV-1a hash of its type name: list every function that looks one up | `component-hash`, `entt-typenames` | `findings-components.md` |
| strings and constants | a log message, save key or constant used once points at its function | `string-users`, `lea-sites`, `xref-scan`, `image-names` | `findings-nbt.md`, `findings-inventory.md` |
| call graph | pair functions by what they call and who calls them, outward from confirmed seeds | `callgraph`, `propagate-gaps`, `gaps-agree`, `callers` | `findings-gaps-agree.md` |
| live objects | on a running server, capture objects, read their vftables, call getters by slot | `reach-probe-launcher`, `instance-probe-launcher` | `findings-reach.md`, `findings-instances.md` |
| the other build | carry names between 1.26.40.8 and 1.26.51.1 where the builds line up and the bodies agree | `carry-pipeline`, `cross-build-fill` | `findings-slots.md` |
| no address at all | bdsx implements the function itself (`derived()`) when 1.26 inlined it away | `util-classes`, `open-absorbed` | `findings-utils.md` |

Every route was scored for precision against confirmed names before anything it produced was used.
`tools/merge-symbols.mjs` folds the routes' candidate files (`data/candidates-*`) and the confirmed
names (`data/resolved-*`, with provenance) into one table per build, refusing hook targets from
low-trust routes and pairs whose argument shapes disagree with the 2024 function;
`tools/make-table.mjs` writes the `symbols.json` the fork ships. The current coverage is the generated
block at the top of `docs/status.md`.

## 3. Automated verification

A candidate address is accepted after its disassembly has been read against the 2024 function, and
confirmed only by running it. The lab is two complete bdsx installs on one Windows machine, one per
build, that run side by side (`tools/host/setup-lab.mjs`, `docs/lab-runbook.md`):

```bat
node tools\host\verify-pair.mjs tools\host\drivers\layout40.ps1 tools\host\drivers\layout51.ps1 --grep='\[layout\]'
```

copies the current `bdsx/` edits and the test plugins (`tools/*-probe.ts`) into both instances,
compiles them, installs each build's table, boots both servers, has a client join, feeds console
commands, and collects `[tag] PASS|FAIL` lines. It **exits 0 only if both builds ran clean, no FAIL
came back, and each printed at least one PASS**; a session that crashed, printed nothing or never reported an
exit code is reported as not run, never as a pass. Crashes are captured with register and memory context
(`findings-gamethread.md`), and the RVA maps straight back to a name in the table.

## 4. Verification with a real client

Many events only fire for a real client's packets. `tools/livebot.cjs` is a headless Bedrock 1.26
client (bedrock-protocol) that plays: it walks, jumps, sneaks, attacks, breaks and places blocks, uses
and drops items, sleeps, swims, chats, answers forms, and connects over RakNet or NetherNet.
`tools/livebot-probe.ts` runs inside the server and drives it over a control port, scenario by scenario,
checking that each bdsx event fires with the right values and that cancelling it really cancels it
(`lb40/51.ps1`, `docs/findings-bot.md` sections 7-10). Its wire format was checked against an
independent codec before it was trusted.

## Quick start (Windows)

Needed: Node 18+, git, the [Visual C++ 2015-2022 x64 redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe),
and LLVM (`winget install LLVM.LLVM`).

```bat
git clone --recurse-submodules https://github.com/wwwcomcomcomcom/bdsx-again.git
cd bdsx-again
node tools\host\setup-lab.mjs
node tools\host\verify-pair.mjs tools\host\drivers\lb40.ps1 tools\host\drivers\lb51.ps1 --grep='\[lb\]'
```

`setup-lab.mjs` installs both BDS builds through bdsx's own installer (you accept the Minecraft EULA
there), the bot, and the 1.21.3.01 baseline the analysis tools compare against. The analysis tools
alone run on macOS or Linux too (Node and LLVM): `node tools/fetch-baseline.mjs`, put the two 1.26
`bedrock_server.exe` in `work/bin/<version>/`, `node tools/prepare-work.mjs`.

To work it the way it was worked, open the repository in Claude Code: it loads `CLAUDE.md` and starts
from the top of the queue.

## Repository map

```
CLAUDE.md          the agent's entry point and workflow
docs/              HANDOFF (start here), next-steps (the queue), lab-runbook, harness, reference,
                   status (generated numbers), findings-*.md (one per route or area: the lab notebooks)
data/              required names, candidate files per route, confirmed names with provenance,
                   merged tables, the shipped symbols-<v>.json, derived/dropped lists, constants
tools/             analysis (Node), table pipeline, probes (*-probe.ts), launchers, livebot
tools/host/        the lab: setup, session, verify-pair, peek, agent-lock, drivers/
bdsx/              the bdsx fork (submodule)
.claude/skills/    /bdsx-parallel
```

The findings docs were written while BDS ran on a remote Windows host driven over ssh; their commands
have been updated to the local lab, their narrative has not.

## Licence

MIT (`LICENSE`). `NOTICE` lists the exceptions: two unmodified Endstone files (Apache-2.0) and the bdsx
submodule (MIT). No Mojang code or binary is included: the data holds addresses, offsets, a few constant
values and the evidence for each. Minecraft and Bedrock Dedicated Server are Mojang's; downloading BDS
means accepting the [Minecraft EULA](https://account.mojang.com/terms).
