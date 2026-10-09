# Restoring the JavaScript API on 1.26.40.8

Done 2026-09-16. Verified on the Windows host against pristine 1.26.40.8
(md5 `0fecd1f7b9e1e8bc7154f461e67d9fdc`).

## What was blocking it

`tools/minimal-launcher.js` proved the seam with a hook written in assembly,
and said why it had to be:

> A JavaScript callback would run on BDS's game thread, and the machinery bdsx
> uses to make that safe -- the game-thread hook that alternates the two
> threads -- is part of what was stripped out.

That hook is the JavaScript API. Once the game loop runs on node's thread, a JS
callback hooked into any BDS function is an ordinary call. It needs two
symbols, and neither references a string literal, so nothing in
`docs/findings-signatures.md` reaches them.

## Finding them without a signature

`bdsx/launcher.ts` writes down the exact code it patches, and that code calls an
import:

```
48 8B D9              mov rbx, rcx
E8 rel32              call <lambda_261...>::operator()
E8 rel32              call _Cnd_do_broadcast_at_thread_exit
```

`_Cnd_do_broadcast_at_thread_exit` comes from MSVCP140, so its IAT slot is
*named* in the import directory — exact, not inferred. `tools/find-gamethread.mjs`
walks slot → thunk → the `E8`s reaching it → the containing `.pdata` function.

Validated on 1.21.3.01, where the PDB table can mark the answer. Four
candidates, all with the patch site at `fn+6` exactly as `launcher.ts` asserts,
and the call closures separate them cleanly:

| candidate | size | closure | markers |
|---|---|---|---|
| 0xb8180 | 794B | 24 | — |
| **0xc6a610** | **2632B** | **144** | **`ServerSimTick` `ClientSimTick` `ServerRealTick` `ClientRealTick`** |
| 0xc6d2f0 | 824B | 23 | — |
| 0x27878f0 | 571B | 42 | — |

0xc6a610 is the lambda and 0xbe38d0 the `_Invoke` containing it — both exactly
what the PDB table says. This is Endstone's own confirmation step: never by
pattern shape, always by marker strings in the call closure.

On 1.26.40.8 the same walk gives seven sites and **none** has the
`mov/call/call` shape. One stands out:

| candidate | size | closure | markers |
|---|---|---|---|
| 0xf3810 | 2408B | 8 | — |
| 0x1ee0a0 | 1148B | 53 | — |
| **0x6ae9b0** | **6046B** | **554** | **`Server - Update`, `ServerNetworkSystem &ClientOrServer...`** |
| 0x1231ab0 | 745B | 126 | a vcpkg build path |

and it carries `_Invoke`'s reference signature — address taken once, never
called directly, because `std::thread` passes it as the thread procedure:

| | `lea` | direct `call` |
|---|---|---|
| 1.21.3.01 `_Invoke` 0xbe38d0 | 1 | 0 |
| 1.21.3.01 lambda 0xc6a610 | 0 | 1 |
| **1.26.40.8 0x6ae9b0** | **1** | **0** |
| 0x373ad00 (occupies the lambda's slot in the tail) | 0 | 8 |

## The lambda is gone

`_Invoke` is 6046 bytes here against 45 in 1.21.3.01, its closure is 554
functions rather than 45, and the function sitting where the lambda's call used
to be is a 394-byte helper called from eight places. The lambda was inlined.
There is no function whose address `launcher.ts` can take.

`data/resolved-1.26.40.8.json` records `_Invoke` as resolved and the lambda as
unresolved with that reason, rather than inventing an address for it.

## The adaptation

`gameThreadEntry` needs `gameThreadInner` to be *callable*. With the lambda
inlined, `_Invoke` itself is that function: `procHacker.hookingRaw` relocates
its prologue — eight `push`es, exactly 12 bytes, ideal — and hands back a
callable original. So the hook replaces `_Invoke` instead of a call inside it.

One correction was needed. `gameThreadHook` was written to be patched *into*
`_Invoke`, after `_Invoke` had already pushed `rbx`; it clobbers `rbx` and
reserves no shadow space for the calls it makes. Standing in for a whole
function it must do both, so it is wrapped:

```
push rbx
sub  rsp, 0x20
call gameThreadHook
add  rsp, 0x20
pop  rbx
ret
```

`bdsx/launcher.ts` now branches on whether the lambda exists as a symbol, so
the original path is untouched for builds that still have it.

## Result

```
[gt] _Invoke at 0x00007FF6E107E9B0
[gt] lambda present as its own function: false
[gt] game thread hook installed
[gt] Level::tick hooked with a JavaScript callback
[gt] game loop is now running on the node thread
[gt] JS API ALIVE: a JavaScript callback ran on the game thread
[gt] SUCCESS: 600 ticks delivered to JavaScript
```

Server reached `Server started.`, stderr empty. `tools/gamethread-launcher.js`
plus `tools/run-gamethread.ps1` reproduce it.

## Shutdown, verified

The gap above -- the inlined body's own `_Cnd_do_broadcast_at_thread_exit`
running on the node thread while `gameThreadHook` tail-jumps to it again on the
BDS thread -- only reachable at thread exit, so only a shutdown exercises it,
and the failure it would produce is a hang rather than a message.

`tools/run-shutdown.ps1` drives a real `stop` over stdin (Start-Process cannot
redirect stdin and keep reading output, hence the raw
`System.Diagnostics.Process`) and bounds every wait, so a run that reports "did
not exit" would be the finding. It exits:

```
Server stop requested.
Stopping server...
Quit correctly            <- BDS's own clean-exit marker
[gt] game loop returned -- gameThreadFinish reached
[gt] t+20s after the game loop returned; node loop still responsive
[gt] process exiting, code=0, finished=true, ticks=410
```

The game loop hands back, `gameThreadFinish` fires, the node thread stays
responsive for 20s afterwards, and stderr is empty. Calling it twice on two
threads does not deadlock. Reproduced across six runs.

The process exit code is the launcher's own `process.exit(0)` after that 20s,
not a natural exit: this minimal launcher installs no `finishCallback`, which
is bdsx's full launcher's job. What is verified is the shutdown path through
the hook, not bdsx's process teardown.

## Probing addresses by whether they get called

With the JavaScript API working there is a direct test for an address: hook it
and see whether it fires when the game does the thing its name claims.
`tools/probe-symbols-launcher.js` installs raw counter hooks -- an increment and
a jump to the original -- so no signature has to be guessed and a wrong address
cannot be called with wrong arguments.

Note what it can conclude. Firing at the right moment is evidence for an
address. Never firing is not evidence against one: the run may simply not have
exercised it.

| symbol | source | calls | when |
|---|---|---|---|
| `CommandRegistry::registerCommand` | Endstone | **88** | during startup |
| `MinecraftCommands::executeCommand` | Endstone | **1** | on the stop command |
| `Command::run` | Endstone | **1** | on the stop command |
| `ServerNetworkHandler::updateServerAnnouncement` | Endstone | **1** | periodically |
| **`DedicatedServer::stop`** | **string anchor, unconfirmed** | **0 → 1 at stop** | **confirmed** |
| `CommandRegistry::serializeAvailableCommands` | Endstone | 0 | no client connected |
| `ItemStackBase::toDebugString`, `CommandItem::createInstance`, `ServerNetworkHandler::_onPlayerLeft`, `LoginPacket::write` | string anchor | 0 | never exercised |

`DedicatedServer::stop` at 0x7a400 reads 0 through startup and 200 ticks, then
exactly 1 immediately after `stop` is written to the console. It is promoted
into `data/resolved-1.26.40.8.json`. That makes string anchoring three for
three wherever a check existed -- two agreeing with the resolved table, one
confirmed by execution.

The 88 `registerCommand` calls also settle a prerequisite for command
registration, which is the next thing bdsx needs.

### A failure that did not reproduce

The first full-set run stopped producing output after `Server stop requested.`
and its runner never returned. The obvious reading was that one of the five
unconfirmed addresses was the wrong twelve bytes to overwrite, so each was
bisected: ground-truth-only, `DedicatedServer::stop` alone, the two item
candidates, `_onPlayerLeft` alone, `LoginPacket::write` alone, and finally the
identical full set again. All six were clean, including the configuration that
failed. The failure has not reproduced and is not attributed; the reading that
a candidate broke the shutdown is unsupported.

## Host state

The Windows host's `bedrock_server.exe` had been patched by PeEditor for the
LeviLamina experiments (md5 `6fdf9e30...`). It is restored to pristine from
`bedrock_server.orig.exe`, the patched copy kept as `bedrock_server.levilamina.exe`,
and `PreLoader.dll` renamed to `PreLoader.dll.off`. The MD5 guard in
`symboltable.ts` is what caught this, which is the guard working as designed.

## Native crash reports on the game thread, and the fault capture (2026-09-22)

A 1.26.51.1 session (`ui51-20260922-011528`) died during player creation -- after `Player connected`,
before the bot ever received StartGame -- and bdsx's report said only this:

```
EXCEPTION_ACCESS_VIOLATION(0xc0000005), Accessing an invalid memory address at 0x000000003f800000
   at 0x000002B4B88A04BB (asm) gameThreadEntry +0x17
   at ... VCRUNTIME140_1.dll!... uv_run ... node::Start ...
```

`gameThreadEntry +0x17` is the return address after `call gameThreadInner` -- the whole game loop
(`_Invoke`, above) -- so the report names no frame at all between the fault and the loop's entry.
0x3f800000 is a float 1.0 read as a pointer. The same code ran clean nine times afterwards (four
`ui51` reruns, two with the `pdbcache.l2` cache deleted to redo the first-run lookup, and three
`ui40`+`ui51` pairs); the cause is **not identified**. What the work below changed is that the next
occurrence will name it.

### Why the report is empty

bdsx-core catches native crashes with one SEH filter around the whole node thread
(`bdsx-core/bdsx/main.cpp`, `nodeStart`: `__except (... runtimeError::raise(...))`). `raise` walks the
stack from the exception context, and when that walk comes back empty it shifts RSP and walks again
(`sehandler.cpp`, `getStack`) -- which drops the faulting frame and anything else it could not unwind.
The release build never prints the context's RIP (that code is under `#ifndef NDEBUG`). And it only
prints `exceptionInfos[1]`, the address; `exceptionInfos[0]` -- read, write or **execute** -- was
thrown away.

Three ways of crashing **do not produce a report at all** -- measured on both builds with a crash
made on purpose (below), each exits with a bare `0xC0000005` and prints nothing, with or without the
capture:

1. a crash raised from JavaScript (a `makefunc` call to a bad address), even from a `levelTick` listener;
2. a crash in code the **console** runs: `/tag @a add ...` -> `Actor::addTag` is not on the node thread,
   so it is outside the only `__except` there is;
3. a crash below a generated stub that has its own frame and no unwind data (`sub rsp,28h; call rax`):
   SEH dispatch cannot unwind through it and never reaches the filter.

So the crash that *was* reported happened on the node thread, in code dispatch could unwind from.

### The capture (`bdsx/bdsx/crashcapture.ts`)

A vectored exception handler runs before any SEH filter and sees the full CONTEXT. bdsx now installs
one at load (`installErrorHandler`), written with bdsx's own assembler (no JavaScript may run inside
an exception): for every access violation it copies ExceptionAddress, ExceptionInformation[0..1], the
sixteen general registers, RIP and 40 qwords from RSP into a four-entry ring and returns
`EXCEPTION_CONTINUE_SEARCH`, so the process does exactly what it did before. On a native crash the
report gains a `[ Fault Capture ]` block: each record's access kind, address and RIP, the registers,
and every stack qword that points into a loaded image, as `module+0xRVA` -- RVAs that map straight
onto our tables. The access kind is also added to the first line. `BDSX_NO_FAULT_CAPTURE=1` turns it off.

Checked by crashing on purpose (`tools/alloc-probe.ts`, `crashprobe arm`; drivers `crash40/51.ps1`):
the probe raw-hooks `ServerPlayer::normalTick` with a bare `jmp` to 0x3f800000 -- an execute fault in
the game loop whose only return address is BDS's. On both builds bdsx's own stack is exactly the shape
of the real crash (fault, then `gameThreadEntry +0x17`), and the capture adds:

```
#1 execute of 0x3f800000 at 0x3f800000 (no module)
   rax=0x3f800000 rcx=... rip=0x3f800000
   stack, code pointers only: [rsp+0x0] bedrock_server.exe+0xdef87d, ...      (1.26.40.8)
                              [rsp+0x0] bedrock_server.exe+0xd2f68d, ...      (1.26.51.1)
```

`[rsp+0]` is right: 40 `0xdef87d` is 40 `0xdef420+0x45d` and 51 `0xd2f68d` is 51 `0xd2f230+0x45d` --
the same offset in the corresponding function on each build -- and the instruction before it is
`mov %rsi,%rcx; call *[rip+...]`, the CFG-dispatched virtual call that invokes `normalTick`
(`work/host-runs/crash40-20260922-023556.txt`, `crash51-...`).

One thing the comparison already says about the real crash: its report had **no** first frame at the
fault address, where the test's has `at 0x000000003F800000 (unknown)`. The walker's first attempt came
back empty there, so the real RIP was probably not a garbage address but code the walker (dbghelp)
cannot unwind and SEH dispatch can -- generated code such as bdsx's asm and makefunc stubs. That is a
lead, not a finding; the capture is what will settle it.

**With the capture on, eight more `ui40`+`ui51` pairs ran clean** (all 10/10 probe PASS, `exit 0`,
`Quit correctly`; `work/host-runs/ui40|ui51-20260922-023728` ... `-031731`). That is the check that the
handler changes nothing in a normal session, and it means 1.26.51.1 has now run this code clean
fourteen times since the one crash. It did not recur, so it is still unexplained -- next-steps Q8.

### The `0x3f800000` fault, named (2026-09-25)

The capture caught it on the third occurrence (51 `abil51`, `work/host-runs/q8/abil51-20260925-005708.err`).
All three are on 1.26.51.1 and all three at the same moment: about 1.5 s after `Player connected`, before
`Player Spawned` (`ui51-20260922-011528`, `nbts51-20260924-182549`, `abil51-20260925-005708`; the `crash*`
sessions of 2026-09-22 are the deliberate test above). Against that, 0 of 374 1.26.40.8 sessions with a
player connect, 3 of 364 on 1.26.51.1 (counted from `work/host-runs/*.txt`).

```
#1 read of 0x3f800000 at bedrock_server.exe+0x16086bf
   rcx=0x23271a9d910 rdx=0x2327a2de040 rsi=0x2327a2de0b8 rdi=0x3f800000 r8=0x0 r15=0x2327a2de040
   stack, code pointers only: [rsp+0x20] +0x16158a0, [rsp+0xb8] +0xa15ae0, [rsp+0xd0] ChakraCore.dll+0x208650
```

**The faulting function** is 51 `0x1608650` = 40 `0x1508990` (the 15 bytes at +0x34 occur exactly once
in each image, and the two bodies read the same instruction for instruction) = 2024
`?isChunkInTickRange@ChunkTickRangeManager@@QEBA_NAEBVLevelChunk@@V?$optional@H@std@@@Z` (1.21.3.01
`0x1b13ca0`). The match: `this+0x10` is the tick radius, squared; the `optional<int>` travels by value in
`r8` and `bt $0x20,%r8` is its `has_value` byte; the second argument's `+0x58` is what 2024 reads through
`LevelChunk::getDimension`; the lambda at `0x16158a0` whose address is on the stack is the callback it
hands to that object's vtable `+0x50`. 51 has fourteen call sites (`tools/callers.mjs`), one of
them `ServerNetworkHandler::handle(SubChunkRequestPacket)` as in 2024.

The fault is the first instruction that dereferences `rdi = *(rdx+0x58)`: **the `LevelChunk` passed as
the second argument has float 1.0 where its `Dimension*` should be.** `rsi = rdx+0x78` (the chunk's
position) rules out a wrong register: `rdx` was taken as a `LevelChunk*` and its memory is not one now --
freed and reused, or never a chunk.

**The caller** is the return address at `[rsp+0xb8]`: 51 `0xa15ae0`, inside `0xa15740` (1504 bytes; 40
`0x15f71e0`, also 1504 bytes, calling 40 `0x1508990`). It is 2024's
`<lambda_ed4def68e7128eccedd31516ff0fee6f>` (1.21.3.01 `0x1ed6ae0`), the
`std::function<void(buffer_span<Pos>, buffer_span_mut<shared_ptr<LevelChunk>>, int)>` built in
`ChunkSource::createEmptyView` -- the generator a `ChunkViewSource`'s `GridArea` calls for each position it
moves over. Both bodies do the same thing per position: `ChunkSource` vtable `+0x40` (2024
`getOrLoadChunk`) or `+0x18` (`getExistingChunk`) into a `shared_ptr<LevelChunk>`; if non-null and
`Level::isClientSide` (51 Level vtable `+0x9e8`, 2024 `+0x880`) is false,
`isChunkInTickRange(level->getChunkTickRangeManager() /* 51 +0x78, 2024 +0x60 */, *chunk, nullopt)`, stored in
a `LevelChunk` byte (51 `+0x10e2`, 2024 `+0xdea`). 51's version also calls `0x1608880` = 2024
`ChunkSource::shouldServerGeneratePos`. So **the bad argument is a chunk the `ChunkSource` itself just
handed back** for the new player's view.

**bdsx is not in this path.** bdsx binds a few `ChunkSource`/`LevelChunk` calls for plugins
(`bds/chunk.ts`, `dimension.ts`, `tickingarea.ts`), but nothing in bdsx or the probes hooks a chunk,
`Dimension` or `ChunkTickRangeManager` function, and bdsx's `playerJoin` seam (`SetLocalPlayerAsInitialized`)
fires after spawn, later than the crash. The ChakraCore address at `[rsp+0xd0]` is inside the caller's
own frame (its frame spans `rsp+0xc0` upwards), i.e. a stale slot on the node thread's stack, not a live
frame. The required-name sets of the two tables differ only in fourteen names, none reachable before spawn
(the 51-only ones are command output and item names). What is left:

- bdsx corrupting the heap earlier (a wrong-size engine object, the `MobEffectInstance` 0x88/0x90 kind)
  with the chunk as the victim. Nothing points at a specific object; the three sessions ran different
  probe sets (`ui`, `nbts`, `abil`) and died before any console command.
- the engine or the client: all three used the `bot-pr804` client, which speaks 1.26.45's packet format
  to 1.26.51.1 -- but so do 104 of the 114 51 drivers (4 use `bot-360`, 6 run no bot), so it does not
  separate.

What would separate them next time: the object at `rdx` itself (its first qwords: a heap free-list shape
vs another class's vftable). Since 2026-09-25 the capture copies that (next section). And a baseline no one
has run: vanilla 1.26.51.1 (no bdsx) with the same client joining a few hundred times.

### The memory behind each register (2026-09-25)

Each record now also holds the first **16 qwords (0x80 bytes)** at every general register except `rsp`.
Eight qwords were not enough, because the bad chunk's `Dimension*` is at `+0x58` and its position at
`+0x78`. The handler calls `VirtualQuery` on each value first and copies only when the memory is
`MEM_COMMIT`, readable (none of `PAGE_NOACCESS`/`PAGE_GUARD`, one of the six readable protections), and the
whole 0x80 bytes lie inside that region. A fault inside the handler would kill the process with no report,
so nothing is read without that check. To keep `rbx`/`rsi`/`rdi` across the calls, the handler pushes them
and reserves 0x50 bytes (shadow space + `MEMORY_BASIC_INFORMATION`), which leaves `rsp` 16-aligned at each
call. The record grew to 0x1000. The report prints four qwords per row, `[reg+0xNN]`, with `module+0xRVA`
after any qword that points into an image. A register that repeats an earlier register's address prints
`same as`, and registers that hold a pointer-sized value but were not copied are listed as `not readable`.
Every qword is now printed exactly from its two 32-bit halves: the old `hex(qword())` went through a double
and rounded anything above 2^53 (`0xfffffffffffffffe` printed as `0x10000000000000000`), which had also
affected the register line.

**Checked on both builds** with `crashprobe arm` (`crash40`/`crash51`, `work/host-runs/crash40|crash51-20260925-145034`, and after the
exact-hex fix `-145300`). The probe jumps from `ServerPlayer::normalTick` to 0x3f800000, so `rcx` is the `ServerPlayer`.
The first qword at `[rcx+0x0]` printed as `bedrock_server.exe+0xa5ead10` on 40 and `+0xa70b930` on 51, which
is exactly `??_7ServerPlayer@@6B@` in `data/merged-<v>.json` on each build. `rdx`/`rbx`/`r14` also start with
vftables in the image, `rsi`/`rdi` printed as `same as`, and `rax` (0x3f800000) was reported not readable.
After the change, `ui40`/`ui51` ran 21/0 PASS and `layout40`/`layout51` 27/0, all exit 0 with `Quit correctly`.
No handled access violation touched the new path in those sessions (no fault capture printed).

**An assembler bug found on the way** (`bdsx/assembler.ts`, fixed in the revival branch). A label jump
followed by 127+ bytes of code and then another label jump is sized early by `_genChunk` and left as an
`UnresolvedConstant`. `_normalize` ran `resolveAll()` only when the code had a def/memory area, so without
one that jump kept the placeholder `INT32_MAX` (`jne +0x7fffffff`): a jump into nowhere. The new handler's
`jnz done` over the 5 KB body hit it. Minimal repro: `jnz done`, 20 movs, `jb x`, one mov, `x:`, `done:`
gives `0f 85 ff ff ff 7f` before the fix and `0f 85 95 00 00 00` after. The fix is to always run
`resolveAll()`. Every runtime `asm()` in bdsx goes through it, so the `ui`/`layout` pairs above are the
regression check. Code assembled from `.asm` text with a def area (`asmcode`) was never affected.

**Assembling off the host.** `assembler.ts` has no native dependency, so on macOS Deno can build and
`llvm-mc` can disassemble a handler: `deno run --sloppy-imports --unstable-bare-node-builtins
--import-map=<map>` with `colors`, `source-map`, `core`, `dllraw`, `makefunc` and `nativetype` mapped to a
Proxy stub, `windows_h` mapped to a module with the one constant, `globalThis.__dirname` set before import,
and `code.buffer(true)` (the path `alloc()` takes; values above 2^53 get rounded, so use test constants below
that). The bytes wrapped as `.byte` in a `.s` file then go through `llvm-mc -filetype=obj` and `llvm-objdump -d`.

### The join loops: bdsx against vanilla (2026-09-27)

The queue asked whether the `0x3f800000` fault is bdsx's or the engine's, by joining one 1.26.51.1 server
hundreds of times under bdsx and under vanilla. `tools/run-join-loop.ps1` does it: per join it starts
`tools/probe-client.cjs` (`bot-pr804`, `BP_VERSION=1.26.45 BP_PROTOCOL=2193 BP_NO_ATTACK=1`) with the new
`BP_LEAVE_AFTER_START=4500`, so the bot leaves ~5 s after `Player connected`; it waits for the matching
`Player disconnected`, and a server that exits instead is a crash (logs kept as `<Tag>-crash<N>.*`, a new
server booted, the count goes on). `-Fresh` stops and reboots the server after every join, so each join is
the first one on a new server -- what every real session is. Vanilla is `C:\bdsx-again\van51`
(`tools/host/make-van51.ps1`: inst51's `bedrock_server\` without bdsx's files, the real
`VCRUNTIME140_1.dll` back, port 19136), so the two ran side by side on the same exe and world. Per-join
records: `work/host-runs/q8/`.

| run | server | joins | crashes | stop hung | notes |
|---|---|---|---|---|---|
| `jl51` warm | bdsx (inst51, all probes) | 300 | 0 | -- | one boot, exit 0 + `Quit correctly` |
| `jlvan51` warm | vanilla (van51) | 300 | 0 | -- | one boot, exit 0 + `Quit correctly` |
| `jlf51` fresh | bdsx | 114 | **8** | 1 | stopped by `-MaxCrashes`; 105 clean stops |
| `jlfd51` fresh + procdump | bdsx | 35 | **2** | 2 | 1 at the leave, 1 inside `stop`; one more `stop` exited -1 without `Quit correctly` |
| `jlfvan51` fresh | vanilla | 300 | 0 | 0 | all 300 stops exit 0 |

**The `0x3f800000` fault itself did not recur** in any of these joins (a hit prints the capture; none
did). What the loops found instead is wider: **a fresh bdsx server died at its first player's join 9 of 149
boots, and failed its `stop` 5 more times (3 hangs, 1 crash, 1 exit -1 without `Quit correctly`); vanilla
did neither.** A warm server takes 300 joins and leaves under either.

The bdsx deaths (`jlf51`) are all 0xC0000005 within 3.6-5.2 s of `Player connected`: five just after
`Player disconnected` (the bot's leave), two about 1 s after `Player Spawned`, one before spawn. **None
printed a bdsx report or a fault capture** -- the capture prints only from the node thread's `__except`, so
these are on another thread. WER LocalDumps (configured on the host for `bedrock_server.exe`) wrote
nothing either: bdsx-core's own unhandled-exception filter ends the process first. So `-ProcDump` attaches
Sysinternals procdump (`C:\bdsx-again\tools\procdump\procdump64.exe -e -ma`) after each boot -- a debugger
is asked before that filter -- and takes an on-demand dump of a server that ignores `stop`.
`tools/minidump.mjs` reads them (on the host, `node` is there; the dumps are ~1.5 GB each, in
`C:\bdsx-again\dumps\jlfd51`; this procdump's `-mp` writes empty thread and module lists, so `-ma`).

**The death at the leave** (`bedrock_server.exe_260926_174708.dmp`): a read of `0x988` at 51
`0xa17a41`, inside `0xa17440` (6350 bytes), on a **BDS worker thread** (the stack goes down through
task-scheduler frames `0x9e1871`, `0x9ef832`, `0xede76`, `0xeea4c`, `0x2812f6`, `0x28b47f`, not through
node). The function walks a vector of 16-byte `shared_ptr`s at `this+0x170..0x178` (the shape of a
`GridArea<shared_ptr<LevelChunk>>`), and for each non-null chunk takes `chunk+0x140`, an array of
0x68-byte elements (the sub-chunks), scanning it top down against the air block (the inlined
`BlockTypeRegistry::getDirectAccessBlocks` assert, strings at 51 `0xa9bd3b3`/`0xac70de8`). One chunk's
`+0x140` was **null**: `mov -0x8(%rbx,%rdi),%rcx` with `rbx=0`, `rdi=0x990`. At the same moment a second
worker (thread 4368, at `0x1862273`) had a return address in the same function (`0xa18192`). Same
neighbourhood as the named `0x3f800000` fault: chunk-view work on a chunk that is not a whole chunk,
during a new player's first seconds.

**The death inside `stop`** (`bedrock_server.exe_260926_174224.dmp`, `jlfd51` boot 12): a read of the
page just past a heap block (`r15+0x30`, `0x...32000`) at 51 `0x8281e7d` (in `0x8281910`, 3788 bytes).
**The two hangs** (`hang-260926-174545.dmp`, `hang-260926-175004.dmp`): the process's first thread -- the
node thread, which is bdsx's game thread -- is blocked in a wait called from BDS code (`0x9e38a5` in one,
`0x282cb8` in the other); `stop` is never read. Neither is named yet.

What this settles and what it does not: vanilla runs the same exe, world and client without a single
death or hang, so **bdsx is implicated** in the fresh-boot instability -- but nothing in bdsx hooks chunk
code, and the faulting thread is an engine worker. A warm server under bdsx is clean, so it is something
about the first seconds after boot under bdsx. The next step is to bisect it on the fresh-boot loop:
the bot's join delayed well past `Server started`, then no probe plugins, then bdsx with no plugins at all.

### The fresh-boot bisect: a freed buffer the this-getter hooks kept writing to (2026-09-27)

The join loops above left one question: what about bdsx makes a fresh 1.26.51.1 server die at its first
join (or at its `stop`) about one boot in ten, when vanilla never does. It was bisected on the same fresh-boot
loop (`tools/run-join-loop.ps1 -Fresh`, the bot joins once and leaves ~5 s later, `stop`, reboot), one variable
per run, ~100 boots each, procdump attached (`-ProcDump`), a vanilla fresh-boot loop on `van51` running beside
it as the second server so the host load matched the original `jlf51`. Per-join records, crash logs and dump
summaries: `work/host-runs/q8/bisect/`. Drivers: `tools/host/drivers/jlf*51.ps1`, `jlf40.ps1`, `jlfx40.ps1`.

| run | what differs from `jlf51` (bdsx, all probes, bot at `Server started`) | boots | died at join | `stop` failed |
|---|---|---:|---:|---:|
| `jlfa51` | the bot joins 30 s after `Server started` | 26 | 2 | 2 |
| `jlf40` | build 1.26.40.8 (inst40) | 100 | 0 | 1 |
| `jlfb51` | no probe plugins (`tools/host/index-examples.ts`: the stock examples) | 100 | 7 | 3 |
| `jlfc51` | no plugins at all (`tools/host/index-empty.ts`) | 100 | 3 | 7 |
| `jlfbare51` | bdsx-core and node only: `tools/bare-launcher.js` (no hook; the game loop on BDS's own thread) | 100 | **0** | **0** |
| `jlfreloc51` | bare + the game-thread relocation: `tools/reloc-launcher.js` | 100 | **0** | **0** |
| `jlfnvc51` | (c) with the fault capture off (`BDSX_NO_FAULT_CAPTURE=1`) | 100 | 3 | 4 |
| `jlfnpd51` | (c) without the packet dispatchers and raw hooks (`BDSX_NO_PACKET_DISPATCH=1`) | 10 | 2 | 0 |
| `jlfh51` | (c) minus the six boot hooks that are not this-getters (`BDSX_SKIP_HOOKS`, below) | 100 | **0** | **0** |
| `jlfi51` | (c) minus only the `Level::tick` hook (and so `serverOpen`, which falls back to the first tick on 1.26) | 100 | **0** | **0** |
| `jlftick51` | reloc + a `Level::tick` hook with an empty JS callback: `tools/tick-launcher.js` | 100 | **0** | **0** |
| `jlfk51` | (c) with the tick hook but `serverOpen` never run (`BDSX_SKIP=open`) | 100 | **0** | **0** |
| `jlfl51` | (c) with `serverOpen` reading the engine objects only (`BDSX_SKIP=open-late`) | 23 | 1 | 0 |
| `jlfm51` | (l) minus the two `NonOwnerPointer` acquisitions | 15 | 1 | 0 |
| `jlfn51` | (l) minus every acquisition: what is left of `serverOpen` took 3 ms | 13 | 1 | 1 |
| vanilla, beside the runs above | `van51`, five loops | ~1,240 | 0 | 0 |

A run that had already failed was stopped early: its question was answered. Every failure in every bdsx run has
one of the shapes the join-loop dumps showed: a worker thread reading `0x988` at 51 `0xa17a41` (the chunk with no
sub-chunk array), a `0xC0000409` fast fail, a node-thread fault inside the game loop (`gameThreadEntry +0x17` is the
return address after the whole loop) or an execute of a heap address with `rcx` the `Level`, at `stop` a read past
a heap block at `0x8281e7d` (a walk over 0x38-byte elements that runs off the end of its vector) or `0x81e143f`, and
hangs with the node thread waiting at `0x9e38a5`/`0x282cb8`. Nothing in the delay, the probes, the fault capture or
the packet hooks changes the rate.

What was left once `serverOpen` did nothing but its bookkeeping (`jlfn51`) was `thisGetter.finish()`. `ThisGetter`
(`bdsx/thisgetter.ts`) captures `this` of a few functions for `serverOpen`: each `register` allocates an 8-byte
`AllocatedPointer`, bakes its address into a hook that stores `rcx` there on every call, and `finish()` reads the
buffers and sets `this.items = []` -- dropping the only reference to them. An `AllocatedPointer`'s bytes are the tail of its
own JS wrapper object (bdsx-core `staticpointer.cpp`: `newAlignedExtra`, `setAddressRaw(data+1)`), so the garbage
collection that takes the wrapper frees them -- and the hooks stay installed. Upstream registered only
constructors that had all run before `finish()`, so a freed buffer was never written again. The revival (bdsx
`0384205b`, 2026-09-17) added two that run again for as long as the server does: `CommandRegistry::registerCommand`
and `ServerNetworkHandler::updateServerAnnouncement`. From the first GC after `serverOpen` on, each of their calls
wrote a pointer into a freed heap block, and whatever the heap had reused that block for was corrupted -- which is
why the fault sites are spread over chunk code, engine vectors and the game loop rather than bdsx code. Every clean
run above is one where `finish()` never ran (`jlfh51`, `jlfi51`, `jlfk51`: no `serverOpen`) or no this-getter was
installed (`bare`, `reloc`, `tick`); every failing one runs both.

The fix (bdsx, `thisgetter.ts`): every buffer a hook writes into goes into a module-level array that is never
cleared. Checked on the same loop with all probes, procdump attached, the fix synced and compiled
(tsc 0): **1.26.51.1 150 fresh boots, 0 deaths, 150 `stop`s exiting 0** (`jlfx51`; the same configuration failed
about one boot in ten before: `jlf51` 8 + 1 in 114, `jlfb51` 7 + 3 in 100), **1.26.40.8 100 of 100 clean**
(`jlfx40`; before the fix `jlf40` had 1 failed `stop` in 100). `layout40`/`layout51` afterwards: every `[layout]`
line PASS on both, exit 0, `Quit correctly`.

Not established: why a warm server takes 300 joins without a death (by then the freed blocks may belong to
allocations the stray write does not break), and why 1.26.40.8 showed no death at the join in 100 boots (one
`stop` failed there). Q8's other shapes are plausibly the same corruption -- the `0x3f800000` read of a bad
`LevelChunk` at a join, the execute of an address in no module ~15 s after a join, the one `0xC0000374` at `stop`
-- but none of them was reproduced and tied to it; they stay open until one recurs with the fix in.

Raw dumps kept on the host (2026-09-27; the other 32 were deleted for disk space, their `minidump.mjs` summaries are
in `work/host-runs/q8/`): one of each shape, `C:\bdsx-again\dumps\jlfb51\bedrock_server.exe_260926_210113.dmp` (the
`0xa17a41` join death), `...\jlfb51\bedrock_server.exe_260926_210259.dmp` (the `0x8281e7d` `stop` fault),
`...\jlfc51\hang-260926-212600.dmp` (a `stop` hang). Not yet done with them: look for the stray write itself -- a
`ServerNetworkHandler*` or `CommandRegistry*` value inside the corrupted chunk or vector memory (`minidump.mjs --mem`).

Tools this added: `BDSX_LOG_PATCHES=1` (`bdsx/unlocker.ts`: every code write, its address, size and JS frames --
how the boot hook list was taken, `tools/host/drivers/patches51.ps1`), `BDSX_SKIP_HOOKS=<substr,...>`
(`bdsx/prochacker.ts`: a hook, patch or write whose symbol contains one of them is not installed),
`BDSX_SKIP=open`, `open-late`, `open:<field>` (`bdsx/launcher.ts`), `BDSX_LOG_OPEN_TIME=1`. With no plugins bdsx
writes seventeen places into 1.26.51.1 at boot: the `_Invoke` relocation and `main`'s restore, six this-getters
(four constructors, `registerCommand`, `updateServerAnnouncement`), `bdsx:BedrockLogOut`, `Level::tick`,
`levelCleanupQueueEntityRemoval`, `~Actor`, `MinecraftCommands::executeCommand`, `BatchedNetworkPeer::_receivePacket`
and `sendPacket`, `NetworkSystem::send`, and the `_sendInternal` call in `sendToMultiple`.

### After the fix: the other Q8 shapes re-measured, and the audit (2026-09-27)

The bisect fixed the fresh-boot deaths. What it left open was whether Q8's older shapes were the same corruption.
Every run below has the fix in (`thisgetter.ts` keeps its buffers), all probes loaded, tsc 0. Records are in
`work/host-runs/q8/remeasure/`.

| run | build | what | result |
|---|---|---|---|
| `jlw51` (new driver: `jl51` + `-ProcDump`) | 51 | one warm server, the bot joins and leaves 300 times | 300 of 300 joins, 0 deaths, no dump written, `stop` exit 0 + `Quit correctly` |
| `layout51` ×10 | 51 | the standard Actor-getter session | 10 of 10 exit 0 + `Quit correctly`, no `FAIL` line |
| `sig51` ×10 | 51 | golem vs zombies, nether tp | 10 of 10 exit 0 + `Quit correctly`, no `FAIL` line |
| `layout40` ×10, `sig40` ×10 | 40 | the same, run beside the 51 runs as the second server | 20 of 20 exit 0 + `Quit correctly`, no `FAIL` line |

The transcripts keep only the `--grep` matches, so each session was checked for a `FAIL` line, the exit code and
`Quit correctly`. The PASS lines were counted from the host's `.out` for the last session of each driver:
`layout40` 50 PASS / 0 FAIL, `sig40` 20 / 0, `layout51` 50 / 0, `sig51` 20 / 0. In `jlw51` the bot did
not spawn in 54 of 300 joins; the pre-fix `jl51` had 53 of 300. That is the known bot shape (Q8, last bullet),
not a server one.

Each shape against its rate before the fix:

| shape | before | after the fix | reading |
|---|---|---|---|
| fresh boot dies at the first join (`0xa17a41` chunk read, fast fail, node-thread fault) | ~1 in 15 fresh 51 boots (`jlf51`, `jlfb51`) | 0 in 150 (`jlfx51`) + 0 in 20 (`layout51`/`sig51`) | **gone** |
| `stop` fails (hang, `0x8281e7d`/`0x81e143f` read, `-1` without `Quit correctly`) | ~1 in 25 fresh 51 boots | 0 in 170 on 51, 0 in 100 + 20 on 40 | **gone** |
| `0x3f800000` read at the bot's join (51) | 3 of 364 51 sessions | 0 in 170 fresh-boot joins + 300 warm joins | not seen. At the old rate, 170 sessions expect 1.4, so 0 has a 1-in-4 chance by luck: **consistent with gone, not proven** |
| execute fault ~15 s after a join, JIT'd code gone (51, and one `0xC0000409` on 40) | 5 seen in 2026-09-23..25 sessions | 0 in 20 + 20 full sessions | not seen. The denominator was never counted, so no rate |
| `0xC0000374` at `stop` | once, in an `EFF_STALE=1` session | 0 in 40 + 170 + 100 | not seen |
| `-1` after `Quit correctly` (late GC) | ~1 in 12 full sessions | 0 in 40 full sessions + 270 loop `stop`s | not seen. At the old rate, 40 sessions expect 3.3 (P(0) ≈ 4%): **likely the same bug** |

How these connect: the stray write was eight bytes of a `CommandRegistry*` or `ServerNetworkHandler*`, landing on
whatever the heap had reused the freed block for. A chunk that reads as bad (`0x3f800000` is `1.0f`, a
chunk-position read of a float), a freed JIT page, a corrupted heap at `stop` and a GC finaliser at exit are all
what such a write can do. None of them has been seen since. The shapes are recorded as not recurring with the
counts above, not as explained. If one recurs with the fix in, its dump is new evidence, and the cause is not
this bug.

**The audit.** It looked through bdsx (`bdsx/bdsx/**/*.ts`) and the probes (`tools/*-probe.ts`) for the same bug:
an address handed to asm or to engine memory whose owner is a JS object nothing else keeps. Each site falls into
one of these groups:
- **Baked into generated code, and kept.** `packetevent.ts` pushes every stub, vftable copy and `np` into
  `dispatcherKeepAlive`. `packetRawOffThread` and `packetSendRawOffThread` are module exports. `crashcapture.ts`
  keeps its record buffer in the module's `buffer`. `makefunc.npRaw` calls `JsAddRef`s on the JS function.
  `launcher.ts`'s `BedrockLogOut` format string is `capi.malloc` (never collected). Every `asm().alloc()` goes to
  bdsx-core's `ExecutableAllocator`, which is never freed.
- **Stored in engine memory beyond the call.** `CommandParameterData.enumNameOrPostfix` comes from
  `capi.permaUtf8` (`JsAddRef`). Command allocators come from `makefunc.np`, and the command objects they build
  come from `capi.malloc`. Symbol-table constants (`symbols.ts` `allocConstant`) are kept by the property defined
  on `proc`.
- **Read or written only during the call** (engine out-parameters, by-value structs, damage and knockback
  parameter copies, `BlockChangeContext`, `TeleportTarget`, the EnTT holder, `Village`/`StructureManager` out
  structs, `SimulatedPlayer::create`'s `NonOwnerPointer` and `optional`, `ItemStackBase::save`'s out pointer).
- **An `as()` view that outlives its buffer.** `ActorDamageSource.create` and `engine/abilities.ts`
  `noSuchLayer` both keep the buffer as `$buffer`. That was the `getEffect(Speed)` bug's shape, fixed 2026-09-25.
- **Command origins.** `bedrockServer.executeCommand`'s `ServerCommandOrigin` is JS-owned (`new (true)`) and goes
  into a `CommandContext` as a raw `CommandOrigin.ref()`. bdsx destructs it itself after the call, and the
  engine's `MinecraftCommands::executeCommand` (51 `0x3da4e0`) reads `ctx+0x20` but never clears or moves it.
  So this one is call-scoped too.

No second instance was found. `thisgetter.ts` was the only place where a hook's baked address pointed at a
collectable buffer.
