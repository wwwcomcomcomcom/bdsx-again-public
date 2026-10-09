# Lab runbook (running BDS on this machine)

BDS only runs on Windows. The lab is two complete bdsx installs on the same machine, one per build,
that can run at the same time, plus a headless client that joins them. Everything is driven from a
terminal (PowerShell or cmd) in the repository root, so every run is logged and reproducible by script.

## 0. Setting up

```bat
git clone --recurse-submodules https://github.com/wwwcomcomcomcom/bdsx-again.git
cd bdsx-again
node tools\host\setup-lab.mjs            :: --yes accepts the Minecraft EULA for you; --only=51 builds one instance
```

Needed first: Node 18+ (tested with 20), git, the Microsoft Visual C++ 2015-2022 x64
redistributable, and LLVM (`winget install LLVM.LLVM`) for the analysis side. `setup-lab.mjs` is idempotent (run it again to repair) and does, per instance:
clone `bdsx/` at the submodule's commit -> `npm i` (bdsx's own installer: BDS from minecraft.net,
bdsx-core from GitHub, the build's table) -> the `node_modules\bdsx` junction -> `server.properties`
(ports, `enable-lan-visibility=false`, the `smoketest` world from a fixed seed, `online-mode=false`,
`allow-list=false`, `transport=raknet`, cheats on) -> the exe into `work/bin/<v>/` and the vftable scan. Then the bot's `node_modules`
(`npm ci`, bedrock-protocol 3.60.1), the 1.21.3.01 baseline, and the rest of `work/` (Endstone clones,
EnTT name lists: `tools/prepare-work.mjs`). A first setup downloads about 400MB.

Windows Defender Firewall may ask about `bedrock_server.exe` the first time each instance boots;
loopback (the bot) works either way.

## 1. Sessions -- what you use day to day

```bat
node tools\host\session.mjs 51 tools\host\drivers\layout51.ps1 --grep='\[layout\]'
node tools\host\verify-pair.mjs tools\host\drivers\layout40.ps1 tools\host\drivers\layout51.ps1 --grep='\[layout\]'
::   --upload=src:dst   extra files into the lab (dst relative to it)      --no-sync   skip copying bdsx/ changes
```

What `session.mjs` does: **takes the instance lock** -> copies the `bdsx/` files that differ into the
instance -> copies the probe plugins into it and `tools/host/index-probes.ts` as its `index.ts` -> `tsc` -> installs that build's `data/symbols-<v>.json` and `pdbcache.bin` -> runs the driver -> prints
the lines matching `--grep` and every crash marker. Transcript: `work/host-runs/<tag>-<timestamp>.txt`;
the raw output stays in `lab/runs/<Tag>.out`, `.err`, `.bot.log`.

**The first argument is the instance, not the build** (`40` = `lab\inst40`, BDS 1.26.40.8; `51` =
`lab\inst51`, BDS 1.26.51.1). `verify-pair.mjs` runs the 40 and 51 driver at once and **exits 0 only if
both are clean, no FAIL came back, and each printed at least one PASS**. The completion bar is that command
passing.

**`session.mjs` does not fail silently.** It prints the reason and exits 1 if any of the following hold
(`docs/findings-host-parallel.md`): the driver never reported an exit code · not even
`Server started` appeared · there's a crash marker · the exit code is nonzero and `Quit correctly` is
missing. (An exit code of `-1` *after* `Quit correctly` is the known late-GC issue and counts as a pass.)

**Two instances at once, not three.** Two sessions on the same instance queue up -- the later one waits
on the lock (`work/locks/<inst>`, up to 20 minutes; a lock whose process died is taken over).

**With several agents**, don't take an instance directly -- use the tickets
(`node tools/host/agent-lock.mjs`): `verify` covers `bdsx/` + inst40 + inst51 together, `repo` covers
`data/`/`docs/`/the commit. **Always `verify` before `repo`** (the reverse order is a deadlock and the
script refuses it). The skill is `/bdsx-parallel`.

## 2. Layout

```
lab\
  inst40\                     bdsx install for BDS 1.26.40.8 (server-port 19132/19133, live-bot control 19150)
    bedrock_server\           symbols.json, pdbcache.bin, pdbcache.l2 (cache), worlds\smoketest, server.properties
    node_modules\bdsx         -> junction to inst40\bdsx (if it's a real directory, tsc throws TS2451)
    example_and_test\zz-*.ts  probe plugins       index.ts  probe import list
    full-launcher.js          bdsx's compiled launcher, refreshed after every tsc
  inst51\                     the same for BDS 1.26.51.1 (19134/19135, live-bot control 19152)
  bot\node_modules            bedrock-protocol 3.60.1 for tools\livebot.cjs
  runs\                       <Tag>.out .err .bot.log .bot.err .session.txt -- re-running the same Tag overwrites
  *-config*.json              launcher configs (node tools\host\make-configs.mjs)
```

The lab is `lab\` in the repository unless `BDSX_LAB` says otherwise. Drivers and runners read
`$env:BDSX_REPO` and `$env:BDSX_LAB`, which `session.mjs` sets; to run a driver by hand, set both.

**Both instances run `transport=raknet`.** 1.26.51.1 ships `transport=nethernet`, which the bot's RakNet
connection cannot join: it connects and then receives nothing. A NetherNet session sets it for itself.

**Both instances have `enable-lan-visibility=false`.** BDS opens ports 19132/19133 for LAN discovery
regardless of `server-port` -- leave it on and whichever one starts second dies with
`Port [19132] may be in use ... Exiting program`, and all the session log shows is 0xC0000005.
`tools/ping-protocol.cjs`, which needs an MOTD, is used only with `enable-lan-visibility` briefly set back
to `true` on that instance.

## 3. Drivers, runners and launchers

A driver (`tools/host/drivers/*.ps1`) is one runner call with its arguments. Copy one for a new check
and change `-Tag` and `-Commands`:

| driver | what |
|---|---|
| `layout40/51.ps1` | full launcher + bot, `layoutprobe`/`gmprobe` -- the template for confirming Actor getters |
| `sig40/51.ps1` | full launcher + bot, iron golem vs zombie + nether tp -- the template for confirming mob events |
| `lb40/51.ps1` | the live-bot harness: `LB_RUN` scenarios played by a real client |
| `pk40/51.ps1`, `icomp40/51.ps1`, `abil40/51.ps1`, `q2ev40/51.ps1` | packet events, item components, abilities, the event sweep |
| `gr40/51.ps1` | full launcher, no client (`run-full`) -- GameRules/weather |
| `rel40/51.ps1`, `rels40/51.ps1` | the release check of bdsx's stock examples (`findings-inventory.md` section 29) |
| `sigc40.ps1` | a counter probe (`IP_PROBES`) |
| `levelraw2-40/51.ps1` | calling Level slots by number (`LG_RAW`, `level-raw-example.json`) |
| `left51.ps1` | the bot leaves before the server shuts down (short `-BotSecs`) |
| `jl51.ps1`, `jlf40/51.ps1` | join loops: the bot joins and leaves N times, `-Fresh` reboots per join (`findings-gamethread.md`) |

| runner (`tools/`) | purpose |
|---|---|
| `run-client-probe.ps1` | boot server -> wait for bot join -> feed `-Commands` to the console **8 seconds apart** -> `kill @a` -> `stop`. Almost every driver uses this |
| `run-full.ps1` | no client: boot -> feed `-Commands` 2 seconds apart -> `stop` |
| `run-join-loop.ps1` | the bot joins and leaves `-Joins` times; a death is logged and the server rebooted. `-ProcDump <procdump64.exe>` takes a dump per crash (read with `tools/minidump.mjs`) |

Key arguments: `-Root` (instance), `-Launcher`, `-Tag`, `-Bot`, `-BotModules`, `-BotPort` (inst40
19132, inst51 **19134**), `-BotSecs` (bot lifetime -- **must exceed the full command sequence**,
command count x 8s + margin), `-JoinSecs`, `-AfterJoin`, `-AfterKill`, `-ExitSecs`, `-Env @{...}`,
`-Commands @(...)`. Both runners kill **only their own instance's** `bedrock_server.exe` (filtered by
image path) -- `Get-Process bedrock_server | Stop-Process` would shoot the other instance mid-probe.

| launcher | purpose | env vars |
|---|---|---|
| `full-launcher.js` (= bdsx's launcher) | **all of bdsx.** Probe plugins and event hooks only run here | per-probe (`SIG_ONLY`, `GR_NOHOOK`) |
| `tools/instance-probe-launcher.js` | counting function calls, capturing objects/member scans | `IP_CONFIG`(required) `IP_PROBES` `IP_CAPTURES` `IP_DUMP` `IP_SCAN` `IP_REPORT_EVERY` `IP_TICKS` |
| `tools/level-getter-probe-launcher.js` | call a live Level's slot by number directly | `LG_CONFIG`(required) `LG_RAW` `LG_EVERY` `LG_TICKS` |
| `tools/reach-probe-launcher.js` | read vftables off captured objects, call getters by Endstone slot number | `RP_CONFIG`(required) `RP_CAPTURES` `RP_CALL` `RP_WATCH` ... (`findings-reach.md`) |

Drivers for 1.26.51.1 use `-Root "$env:BDSX_LAB\inst51"`, `-BotPort 19134`,
`-Env @{ BP_VERSION = "1.26.51" }` (section 4).

## 4. Bot (headless client)

`tools/livebot.cjs` -- a 1.26 client on bedrock-protocol 3.60.1 (`lab\bot\node_modules`, the runners'
default) for both builds: `BP_VERSION=1.26.40` (port 19132) or `BP_VERSION=1.26.51` (port **19134**).

- **Client-side checks: the harness.** `tools/livebot-probe.ts` drives the bot over `LB_PORT` (40 19150,
  51 19152): `lb40/51.ps1`; a new check is a scenario in the probe (`docs/findings-bot.md` sections 7-10).
  `node tools/livebot.cjs --selftest` checks the packets locally first.
- **Live by default**: the loading-screen end, then 20 auth inputs a second; it takes damage, walks, sneaks.
  **`BP_LIVE=0`** keeps it on the loading screen (most probe drivers only need a player in `@a`).
  **`BP_AUTO_ATTACK=1`** hits the mobs around it every 1.5 s for 15 s.
- Env: `BP_SNEAK=<ms>`, `BP_CHAT="<ms>:<text>;..."`, `BP_FORM_REPLY`, `BP_COMMAND`, `BP_LEAVE_AFTER_START=<ms>`
  (the join loops), the login extras (`BP_DEVICE_OS`, `BP_SKIN_ID`, ...); the list is at the top of its
  environment section.
- The bot's first connection is runtime id 1, spawn Y = 32769 (the world's spawn sentinel), so **the first
  command is always `tp @a 29 68 14`**. Console commands that change player state (`gamemode`, `effect`,
  `xp`, `tag`, `tp x y z yaw pitch`) all work -- probes use these to move values.
- Mob damage/knockback without the harness: `difficulty normal`, `time set midnight`, `summon iron_golem` +
  `summon zombie` x2, wait 24s. Dimension change: `execute as @a in nether run tp @s 0 80 0`; `kill @a` then
  fires the overworld-respawn path once more.

## 5. Reading results

```bat
node tools\host\peek.mjs sig40 "\[sigprobe\]"
```

`peek.mjs` always shows crash markers alongside the match (`Native Crash`, `JS Crash`, `EXCEPTION_`,
`error TS`, `Quit correctly`). **Silence is not success** -- always check `exit code` and `Quit correctly`.

| symptom | meaning |
|---|---|
| `exit code: 0` + `Quit correctly` | normal |
| `exit code: -1073741819` (0xC0000005), no crash block in `.err` | died instantly on the native side. Almost always **the original was called with the wrong prototype** or the wrong address was hooked |
| `[ JS Crash ] Native crash without error object` | a JS exception **during argument conversion** for the hook (e.g. the `Actor` resolver calls `hasType`, which is missing) |
| `exit code: -1` with `Quit correctly` present | the late-GC `StructurePointer::finalize` after shutdown -- or the middle of a function was hooked |
| red `Symbol not found: ...` lines during boot | **normal.** The table is incomplete by design. Only worry about a new line that wasn't there before |
| `tsc exit: 2` | a type error in a probe or in bdsx. JS is still emitted so the session still runs, but don't trust the result -- fix it |
| the table was fixed but the old address still shows up | delete `bedrock_server\pdbcache.l2` |
| `Port [19132] may be in use ... Exiting program` (followed by 0xC0000005) | two instances fighting over the LAN-discovery port. Check both have `enable-lan-visibility=false` (section 2) |
| `!! SESSION FAILED: ...` | `session.mjs` caught this. The line is the reason -- it exists so a quiet empty output isn't read as success |
| `[ Fault Capture ]` block (`#N read/write/execute of <address> at <RIP>`, registers, `bedrock_server.exe+0x...`, `[reg+0xNN]` rows) | context bdsx captured via a vectored exception handler at a native crash. The record matching the report's first address line is the fatal one, and the `+0x...` RVA maps to a name directly from our table (end of `docs/findings-gamethread.md`). Disable with `BDSX_NO_FAULT_CAPTURE=1` |
| `exit code: -1073741819` with no report | a crash outside bdsx-core's `__except` -- the thread running console commands, code called via makefunc from JS, or a stub with no unwind info |
| tsc `TS2451: Cannot redeclare ... 'brightCyan'` | that instance's `node_modules\bdsx` isn't a junction. Re-run `setup-lab.mjs` |

To separate causes: install just one hook, e.g. `entity-sig-probe.ts`'s `SIG_ONLY=<one>`. If it still
dies, try the minimal hook inside the probe -- `procHacker.hooking` passing the arguments through
unchanged -- and if that also dies, the prototype is wrong (argument count/type, hidden return pointer).
Check which registers the first 20 instructions of the 1.26 body read (`rdx` saved -> hidden return
pointer, `xmm3` -> 4th arg is float, `288(%rbp)`-style -> 5th+ argument).

## 6. How bdsx-core attaches

bdsx-core attaches via DLL search-order hijacking (BDS imports only one symbol from
`VCRUNTIME140_1.dll`, so the real one is renamed to `VCRUNTIME140_1_.dll` and a proxy takes its place;
bdsx's installer does this). It is per directory, so **each instance has its own pair.**

If the exe changes, **both `symbols.json` and the 28-byte `pdbcache.bin`** must be for that MD5:
bdsx-core checks the stub before JS runs, and `symboltable.ts` checks the table after, so a mismatch
fails twice with two different messages. (`session.mjs` installs both per instance.)
