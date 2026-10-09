# HANDOFF

The point of this single document is to let the next worker (AI or human) pick
up the work immediately. Reading order: **this document -> `docs/next-steps.md`
(task queue) -> `docs/lab-runbook.md` (running BDS)**.
Read the rest of the docs only as needed, from the "Doc map" below.

## 1. What this project does

[bdsx](https://github.com/bdsx/bdsx) (MIT, archived 2024-11-14) is a Node.js
modding framework for the Minecraft Bedrock Dedicated Server (BDS). It used to
parse `bedrock_server.pdb` at runtime to get function addresses, but Mojang has
not shipped a PDB since 1.21.20. This project replaces that part with a
**statically, offline-generated `name -> RVA` table** (`symbols.json`). The
target builds are BDS **1.26.40.8** and **1.26.51.1**; the baseline (the last
build that has a PDB) is **1.21.3.01**.

bdsx requires about 1,100 names (`data/required-symbols.json`). How many are
covered -- by address, by offset/value, and by bdsx's own implementation -- is
the generated block at the top of `docs/status.md` (`node tools/status-summary.mjs`);
no other doc types those numbers. The full launcher boots on both builds, a
client connects, events fire, and the server shuts down cleanly.

**Direction (2026-09-23):** the aim is a plugin loader that works like bdsx on current BDS, not
compatibility with 2024 plugins. Concepts gone in 1.26 are dropped from the API instead of emulated,
the bdsx fork may diverge from upstream, and new work goes through an explicit 1.26 engine layer rather
than per-name shims. `docs/plan-architecture.md`; queue section A.

## 2. How we work (fixed rules)

1. Grab the **top item** of the queue in `docs/next-steps.md`. If the user asks
   for something else, that takes priority.
2. Do the work (per the procedures and rules in sections 5-7 below).
3. When done, always wrap up in this order:
   - Record the evidence in `data/resolved-<v>.json`'s `provenance` (what was
     run, how, and what came out) and in the relevant `docs/findings-*.md`. If
     it's a new route, create a new findings doc.
   - Regenerate the numbers (`node tools/status-summary.mjs --write`, after the
     merge).
   - **Move the finished item out of `docs/next-steps.md` into the
     "Completion Log" of `docs/completed-task.md` (top of its list), and write the next task at the
     top of the queue, concretely enough (commands, candidate addresses, done criteria) that the next
     person can start right away.**
   - If bdsx itself was changed, commit inside `bdsx/` (section 4) and, after a table rebuild,
     `node tools/ship-tables.mjs`.
   - `node tools/docs-check.mjs` must exit 0: the auto-loaded docs within
     budget, no hand-typed coverage numbers, the status block current. If the
     queue is over budget, the finished text in it belongs in
     `docs/completed-task.md` or the findings doc.
   - Commit. Format `type(scope): summary` (`add`, `fix`, `docs`).
   - **Report to the user**: what was done, what was confirmed (on which build, statically or by
     execution), what was not done, and what the next queue item is.
4. If a test failed, write that it failed along with the output. Never write
   something as confirmed if it was not actually run.

Why the harness is built this way: `docs/harness.md`.

## 3. Environment

```
bdsx/          git submodule: the bdsx fork (github.com/wwwcomcomcomcom/bdsx)  <- all bdsx-side edits go here
tools/         all tooling                      tools/host/  the lab: setup, sessions, drivers, probes' index
data/          symbol tables, candidate files, the evidence for each name
docs/          documentation
lab/           the two BDS installs, the bot, run outputs (gitignored; tools/host/setup-lab.mjs)
work/          binaries, the 1.21.3.01 baseline, caches, intermediate outputs (gitignored)
```

**One Windows machine runs everything** (Windows 10/11 or Server, x64): the analysis tools and BDS.
The analysis tools are plain Node and also run on macOS or Linux; only BDS needs Windows. The lab is
two complete bdsx installs, one per build, that run side by side (`docs/lab-runbook.md`):

```bat
git clone --recurse-submodules https://github.com/wwwcomcomcomcom/bdsx-again.git
cd bdsx-again
node tools\host\setup-lab.mjs
```

Needed: Node 18+ (tested with 20), git, the Microsoft Visual C++ 2015-2022 x64 redistributable (BDS
will not start without it; Windows Server does not ship it), PowerShell 5.1 (built in), and LLVM
(`winget install LLVM.LLVM`; `tools/llvm.mjs` finds it, or set `LLVM_BIN`): the disassembly tools and
`merge-symbols.mjs`'s argument-shape check run `llvm-mc`. To read a
single function use `node tools/disas-exact.mjs <v> 0x<rva>`: exact addresses and call-target names
(`tools/disas.mjs` drifts on longer spans). Ghidra is not needed for anything in the queue (if it
becomes needed, read `docs/findings-binexport.md` first).

**Never commit `bedrock_server.exe`, extracted binary fragments, or anything derived closely enough to
substitute for one** (`.gitignore` blocks exe/pdb/dll/zip). What is committed is the name -> RVA table
and the evidence for it.

## 4. The bdsx side

`bdsx/` is a submodule pinned to a commit of the fork, `github.com/wwwcomcomcomcom/bdsx` (master is the
`revival` branch: upstream `3cb7d80` plus this project's commits). Edit bdsx there; sessions copy the
changed files into both lab instances and compile them (`tools/host/session.mjs`), so an edit is tested
before it is committed. Then commit inside `bdsx/` (its messages are English), push to the fork, and
commit the new submodule pointer here.

The fork ships each build's table and `pdbcache.bin` stub in its tree (`symbols/<v>/`, copied by bdsx's
installer): after a table rebuild run `node tools/ship-tables.mjs` and commit in `bdsx/` (`check` exits 1
when stale; `docs/findings-survey.md` "Release packaging").

## 5. Core structure (the seam)

`bdsx/bdsx/bds/symbols.ts`'s `proc` is a Proxy backed by
`pdbcache.search(name) -> rva`. Below that, the 952 `procHacker.*` call sites
and every decorated-name string literal are unchanged. `symboltable.ts` reads
`symbols.json` and refuses to load if the MD5 of `bedrock_server.exe` differs.
`pdbcache.bin` survives only as the 28-byte header that bdsx-core's native
bootstrap reads to find `main`.

`symbols.json` carries four things:

| field | content | source | doc |
|---|---|---|---|
| `symbols` | name -> RVA | `data/merged-<v>.json` <- candidate files | "Data flow" below |
| `layouts` | class -> member -> offset (for objects whose getter is gone) | `offsets` in `candidates-instances-<v>.json` | `findings-instances.md`, `findings-slots.md` |
| `accessors` | field accessors: bdsx emits the body at load time | `accessors` in the same file | `findings-layouts.md` |
| `constants` | bytes for static consts whose storage is gone | `data/constants*.json` | `findings-layouts.md` "Constants" |

The **engine layer** (`bdsx/bdsx/bds/engine/`, A3) is where new work goes: it reads the build only
through `engineLayout`/`engineSymbol`/`componentHash`, so `node tools/engine-deps.mjs` prints its
per-build dependencies. Beyond that, there are **names that need no address**: the ones bdsx implements
itself (`data/derived.json`, `derived()` in `bds/symbols.ts` -- if the table
resolves that name, the binary wins). And a function whose current signature
has no knowable decoration ships under a **`bdsx:` key**
(`bdsx:Mob::_hurt`, `bdsx:Actor::hurt`).

### Data flow

```
data/resolved-<v>.json            human-confirmed (execution, or two routes agreeing). provenance required. highest trust.
data/candidates-*-<v>.json        per-route candidates (instances, packets, ctors, netevent, level, endstone-slots,
                                  carry, vftable, propagation, gaps-agree, crossbuild, corroborated)
        |  node tools/merge-symbols.mjs <v> data/merged-<v>.json
        |    priority merge . hook targets only from trusted routes + 16+ bytes + has a .pdata entry . rejects names
        |    whose signature changed . rejects by argument shape (slot-shape) . applies `retracted` from candidates-instances
        v
data/merged-<v>.json  --  node tools/make-table.mjs --exe=work/bin/<v>/bedrock_server.exe --bdsVersion=<v>
        v                      --symbols=data/merged-<v>.json --out=data/symbols-<v>.json
data/symbols-<v>.json  --  copied into lab/inst<NN>/bedrock_server/symbols.json by every session
```

To re-extract the required-name list from bdsx's source (whenever a new name
string is added to bdsx): `node tools/scrape-symbols.mjs`. After a merge,
`node tools/status-summary.mjs --write` puts the coverage into `docs/status.md`.

## 6. Procedure library

**Standard flow for adding one name**

```sh
# 1. Find a candidate (depends on route: component-hash, level-anchored, endstone-slots,
#    cross-build-fill, or just reading the body)
node tools/component-hash.mjs 1.26.40.8 MobEffectsComponent --max=400
node tools/disas-exact.mjs 1.26.40.8 0xe1a9d0                  # addresses are always 0x-prefixed hex
# 2. Add symbols + provenance to data/resolved-<v>.json (both builds)
# 3. Merge and build the table (bash; in PowerShell use foreach ($v in "1.26.40.8","1.26.51.1") { ... })
for v in 1.26.40.8 1.26.51.1; do node tools/merge-symbols.mjs $v data/merged-$v.json | tail -1
  node tools/make-table.mjs --exe=work/bin/$v/bedrock_server.exe --bdsVersion=$v --symbols=data/merged-$v.json --out=data/symbols-$v.json; done
# 4. Confirm by execution on both builds at once (after adding a check to the probe)
node tools/host/verify-pair.mjs tools/host/drivers/layout40.ps1 tools/host/drivers/layout51.ps1 --grep='\[layout\]'
```

**Probes (bdsx plugins for execution confirmation)** -- `tools/*-probe.ts`.
Every session copies them into the instance and `tools/host/index-probes.ts` imports them. Driven by
console command, printing `[tag] PASS|FAIL ...`.

| file | console command | what it confirms |
|---|---|---|
| `actor-layout-probe.ts` | `layoutprobe`, `gmprobe <mode>` | Actor accessors, getRuntimeID, game-mode functions -- **add new Actor getters here** |
| `entity-sig-probe.ts` | (listeners only; install one with `SIG_ONLY=hurt\|knockback\|dimension`) | hurt / knockback / dimension change / sleep events |
| `gamerules-probe.ts` | `grprobe`, `wxprobe` | derived GameRules functions, weather events |
| `origin-probe.ts` | `originprobe` + join/respawn/left hooks | derived ActorCommandOrigin, UUID |
| `accessor-probe.ts` | `accprobe`, `constprobe` | LevelData accessors, constants |
| `abilities-probe.ts` | `abilprobe base\|survival\|creative\|abilities\|write\|perms op\|perms member` | Abilities layout and the fourteen `derived()` on top of it |
| `packet-probe.ts` | `pkprobe arm\|form\|report\|disarm\|after-disarm` (`PK_ARM=1` arms on load) | inbound packet events raw/before/after, cancellation, `Form` responses -- drivers `pk40/51` |
| `itemcomp-probe.ts` | `icprobe sweep\|freeze\|synth <c>` | item component vftables over real items or bdsx-built objects, `FreezeOnHitSubcomponent` -- drivers `icomp40/51` |
| `livebot-probe.ts` | `LB_RUN="<scenario...>\|all"` in the driver (or `lb run ...`; needs `LB_PORT`), `lbtimers` | **the client harness**: drives `tools/livebot.cjs` as a real 1.26 client (attack, jump, break, right-click, drop, use, bed, swim...) -- drivers `lb40/51`, `findings-bot.md` 7-10 |

The NetherNet probe (`nethernet-probe.ts`, `findings-nethernet.md`) arrives with the bdsx commit it tests.

**When you just want to count calls** (to confirm an address; a counter never
proves a prototype):
`node tools/host/make-probes.mjs 1.26.40.8 work/p.json "label=0xaddress" ...` ->
`--upload=work/p.json:sig-probes-40.json` and name it in a driver's `IP_PROBES` (`sigc40.ps1`). This
tool refuses an address that isn't 16+ bytes and the start of a `.pdata` function.

**Calling a Level slot directly**: in `tools/level-getter-probe-launcher.js`,
`LG_RAW` = `[[label, slot, "int"|"ptr"|"sret", dump-bytes-or-int-arg,
offset-to-follow]]` (`levelraw2-40/51.ps1`). **Only call a slot whose body you've read.**

**Restoring work/** (new machine): `node tools/host/setup-lab.mjs` copies each build's exe to
`work/bin/<v>/` and fetches the baseline (`tools/fetch-baseline.mjs`: 1.21.3.01's exe and PDB,
bdsx's published `pdbcache` for it, and `data/baseline-symbols.json`), then `tools/prepare-work.mjs`:
shallow clones of Endstone at the revisions the candidate files were made from (`work/endstone` =
`0c7cf5e` for 1.26.51, `work/endstone-0.11.7` = tag `v0.11.7` for 1.26.40), the EnTT/image name lists,
and the merge's shape cache (`docs-check` needs the first two; the third needs LLVM). Everything after that is the "Commands"
section of `docs/reference.md`. `work/vft/scan-<v>.json` comes from `node tools/vftable-scan.mjs` (setup
does it), the vftable candidates from `node tools/vftable-pipeline.mjs`, and `work/derived40to51/` is what
`node tools/carry-pipeline.mjs` reads. Launcher configs: `node tools/host/make-configs.mjs`.

**Procedure for a new BDS build**: (1) put the exe in `work/bin/<v>/`.
(2) Read that build's matching Endstone release's
`src/bedrock/symbols/windows.h` first -- it's the exact table for that binary.
(3) `main` RVA: `tools/find-crt-wrapper.mjs` -> `tools/make-pdbcache-stub.mjs`.
(4) `tools/vftable-pipeline.mjs`, `tools/carry-pipeline.mjs <previous> <new>`, `tools/endstone-slots.mjs`,
`tools/level-anchored.mjs`, `tools/netevent-align.mjs`, `tools/cross-build-fill.mjs`. (5) Don't copy the
previous build's `data/resolved-<new>.json` -- re-confirm per route (slot
numbers do not carry between builds: `_hurt` was 134 -> 133).
(6) Add an instance: an entry in `INSTANCES` of `tools/host/lab.mjs` (its own server port and live-bot
port) and the exe's MD5 in `tools/host/setup-lab.mjs`; copy the same build's drivers, changing only the
instance, `-BotPort` and `-Tag`. **At most 2 run concurrently** (`docs/findings-host-parallel.md`).
(7) `node tools/engine-deps.mjs --missing` must be empty. (8) Boot -> run every probe.

## 7. Rules earned by measurement -- breaking them costs the same amount again

1. **Report precision before yield.** A match count has never meant anything
   on its own. Every route is scored against `data/resolved-1.26.40.8.json`
   before anything is promoted.
2. **Accept where independent routes agree.** Two-route agreement is 4/4 on
   the checkable sample; single-route is 0/1.
3. **A counter probe proves an address, never a prototype, and not always the
   address.** `Mob::_hurt` was execution-"confirmed" and still killed the
   server on the first hit (a changed prototype), and `Actor::hurt` was
   promoted on a call count and turned out to be a constructor. ->
   **Read the body** before promoting, and **fire it via bdsx's own hook**
   before calling an event done.
4. **If a later route disagrees with the name that shipped, doubt the name
   first.** `getGameRules` shipped wrong for weeks, and that mismatch was
   misread as "the header shifted."
5. **Do not fill a slot by position alone.** Even an equal-length gap can have
   different content (4 of 9 new Level slots were wrong).
6. **Never type an address in decimal by hand.** Four sessions were lost that
   way. Use `make-probes.mjs`.
7. **Do not pass long PowerShell commands on a command line.** Quoting breaks.
   Write a `.ps1` driver.
8. **If a fixed table doesn't take effect, suspect the cache
   first** (`bedrock_server\pdbcache.l2`; keyed on exe+table MD5).
9. **If it only dies on 51, diff the required-name sets between the two
   tables.** bdsx's `Actor` resolver calls `Actor::hasType` while converting
   hook arguments -- without it, the hook's own code never runs before it dies.
10. **Never walk a world-sized container on the game thread**
    (`findings-reach.md`).
11. The do-not-retry list (byte matching, wildcard signatures, BinDiff,
    version chaining, RTTI, ...) is the table at the end of
    `docs/next-steps.md`. **No newer PDB-bearing build exists.**

## 8. Licence discipline

Endstone is Apache-2.0 -- its tools and headers can be used directly.
LeviLamina is LGPL/GPL -- **read-only reference only**, clean-room
re-derivation only. Committing the Mojang binary or close derivatives of it is
forbidden. **Do not use IDA Free** (its decompiler is cloud-based, which would
upload the Mojang binary to a third party). `NOTICE` lists what is included from whom.

## 9. Doc map

The findings docs are lab notebooks, written while BDS ran on a remote Windows host driven over ssh
(`C:\bdsx-again\...`, `peek.ps1`, uploads). Their commands have been updated to this repository's local
tools; their narrative, and the provenance strings in `data/`, still name the scripts of that time.

| doc | when to read |
|---|---|
| `docs/next-steps.md` | **Always.** Task queue (open items only), do-not-retry table |
| `docs/lab-runbook.md` | Before running anything on BDS |
| `docs/harness.md` | How this harness works and why: the auto-loaded set, the budgets, the queue, the evidence bar, the tickets |
| `docs/reference.md` | What each findings doc settled and the one rule it earned; every command that regenerates `work/` and the candidate files |
| `docs/completed-task.md` | The completion log of finished queue items (most recent first) |
| `docs/status.md` | The generated coverage numbers |
| `.claude/skills/bdsx-parallel/` | The skill for running several queue items concurrently as subagents (`/bdsx-parallel`). Only when the user invokes it directly |
| `docs/plan-architecture.md` | **The active plan** (queue section A): the three layers, the five classes (live/moved/absorbed/gone/unknown), the evidence bar for dropping an API, phases A1-A4 |
| `docs/findings-survey.md` | The first survey: what the PDB gave bdsx, how `main` was found, what the release ships |
| `docs/findings-components.md` | **Q1.** Route 10: component type hashing |
| `docs/findings-slots.md` | The full virtual-function-slot route set (4-9), the `getGameRules` correction, changed signatures, the audit. Q2-Q4 |
| `docs/findings-layouts.md` | Accessors, constants, Actor built-in components. Names that are offsets rather than functions |
| `docs/findings-abilities.md` | The abilities block: `Abilities`/`LayeredAbilities`/`Ability` layout and the fourteen `derived()` on top of it |
| `docs/findings-instances.md` | vftables/layouts read from live objects, constructors, packet handlers, client-join crashes |
| `docs/findings-reach.md` | How to probe live objects, and what not to do |
| `docs/findings-weather.md` | Route 11: the end of the chain names it. Five Actor weather getters and three EnTT ones |
| `docs/findings-blocks.md` | The block API (Q1-A): `BlockSource::getBlock` overloads, the MSVC reverse-order rule, the two offsets of `Block::getName`, the missing `use` slot |
| `docs/findings-bot.md` | The headless bot as a real client: the wire format against Cloudburst (Geyser's codec), and the client harness (sections 7-10): what a 1.26 client sends, the engine checks it passes, what it found in bdsx |
| `docs/findings-nethernet.md` | NetherNet (WebRTC) clients: the test client, identifier equality, `getAddress()` through native hooks, what is left |
| `docs/findings-packets.md` | Packet events (Q5): dispatcher vptr swap, `_receivePacket` raw, NetworkConnection layout, `disas-exact` |
| `docs/findings-synched.md` | The SynchedActorData seam: wrapper getters, `Actor+0x128`, the two addresses that were retracted |
| `docs/findings-utils.md` | The standard for names bdsx implements itself with no address (`derived`) |
| `docs/findings-scoreboard.md` | Q1-C: the scoreboard; command soft enums (section 8) |
| `docs/findings-nbt.md` | The NBT layer: tag vftables, `put`/`get`, `Actor::save`, what bdsx carries (`derived()`) |
| `docs/findings-inventory.md` | A1: how `tools/arch-inventory.mjs` classes names, why "absent from Endstone" is not a `gone` signal, lambda-scope decorated names |
| `docs/findings-gamethread.md` | How the game thread was moved to a node thread; the join loops and fault capture |
| `docs/findings-host-parallel.md` | Two instances at once: ports, locks, and how a session judges failure |
| `docs/findings-vftable.md`, `findings-gaps-agree.md`, `findings-signatures.md`, `findings-audit.md` | Per-route measurements and the low-trust audit. Only when re-running or fixing that route |
| `docs/findings-binexport.md` | Before touching Ghidra/BinExport (the record of the 4h45m burn) |
| other `docs/findings-*.md` | `armor`, `containers`, `riding`, `structure`: one area each |

**Reading a big doc**: most of the docs above are 30-190KB. Don't read one
whole -- `node tools/docs-check.mjs toc docs/<doc>.md` prints its headings with
line numbers and section sizes; read only the range you need.
