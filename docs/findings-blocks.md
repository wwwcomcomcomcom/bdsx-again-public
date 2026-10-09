# Block API (Q1-A) — what opened up, and what's still blocked and why

Written 2026-09-19. Background is `docs/next-steps.md` Q1-A. Up to that point **the world's blocks
could neither be read nor placed**, and all 17 events in `blockevent.ts` were `NO TARGET`.

## 1. `BlockSource::getBlock` — the overloads split along MSVC's reverse-order rule

`??_7BlockSource@@6B@` is in the table for both builds (40 `0xa62e960`, 51 `0xa752900`, both 66
slots = exactly the 66 that Endstone's `block_source.h` expands to). The header declaration order
is `getBlock(BlockPos const&)`, `getBlock(BlockPos const&, uint32_t)`, but **the binary's slot 1
takes 2 arguments and slot 2 takes 1.** This is why `tools/endstone-slots.mjs` dropped it as
`overload-ambiguous`.

> **MSVC emits virtual overloads of the same name in the reverse of their declaration order.**
> The group occupies the position of the first declaration and is reversed within it. This one
> rule resolves every ambiguous group in this table.

Three routes agree.

1. **Slot 1 points to slot 2.** Slot 1 (40 `0x14f63c0` / 51 `0x15f6740`) is four lines:
   `cmpl $1,%r8d` → tail-jump to `vft[4]` (`getExtraBlock` in Endstone order) if layer 1,
   `testl %r8d,%r8d` → tail-jump to `vft[2]` if layer 0. The 2-argument overload itself **says slot
   2 is the main-layer getBlock.**
2. **Slot 2's body has the same shape as 2024.** It reads only rcx/rdx, compares `BlockPos.y`
   against `[this+58]` (min height, the value slot 35 returns) and `[this+56]` (max height, slot
   36), and `sarl $4`s x/z to find the chunk. 2024's `?getBlock@BlockSource@@` `0x1b0f930` also
   compares the same `58(%rbx)`. It never touches `r8d`.
3. **There was already an execution record.** The rp5/rp51 runs in `docs/findings-reach.md`
   **called IConstBlockSource slot 2 directly** to get the `Block` of a placed block (both builds).

Promoted: `?getBlock@BlockSource@@UEBAAEBVBlock@@AEBVBlockPos@@@Z` = 40 `0x14f6260` / 51 `0x15f65e0`.

## 2. Three folded-together slots produced two wrong addresses

The table was carrying `getChunk`, `getChunkAt`, and `getDimension@BlockSource` all at **the same
address** (40 `0x12eeeb0`, 51 `0x120f170`). That function's body is uniformly
`movq 48(%rcx),%rax; retq` — i.e. `BlockSource+0x30`, **Dimension** (`findings-reach.md`:
BlockSource holds Level at `+0x20`, ChunkSource at `+0x28`, Dimension at `+0x30`). Calling it as
`getChunk`/`getChunkAt` gets you a `Dimension*` where a `LevelChunk*` should be.

The cause is ICF. **All three** of the Endstone header's `getDimension() const` /
`getDimensionConst() const` / `getDimension()` return the same pointer, so the linker folded them
into one, and whoever was counting slot numbers treated those three slots as one and drifted two
slots. Re-anchoring by body:

| Slot | Body | Name |
|---|---|---|
| 35 | `movzwl 58(%rcx)` | `getMinHeight` |
| 36 | `movzwl 56(%rcx)` | `getMaxHeight` |
| 37/38/39 | `movq 48(%rcx),%rax` | the `getDimension` triplet (folded by ICF) |
| 40 | `sarl $4` on x/z from rdx's BlockPos → stack ChunkPos → `vft[41]` | `getChunkAt(BlockPos const&)` |
| 41 | compares against the cached chunk at `this+136` (`+184` on 51) | `getChunk(ChunkPos const&)` |
| 42 | edx/r8d → same stack ChunkPos → `vft[41]` | `getChunk(int,int)` |

Slots 40 and 42 **both calling `vft[41]`** pins slot 41 down as `getChunk(ChunkPos const&)`
(exactly what the reverse-order rule predicts). Both builds' bodies have the same shape.

Promoted (corrected): `getChunkAt` 40 `0x1502f40` / 51 `0x1602f30`, `getChunk` 40 `0x14f5580` / 51
`0x15f5900`. **Static evidence only — not yet called by execution.**

## 3. `Actor::getDimensionBlockSource` was carrying an exception helper

The table's 40 `0x113ac0` / 51 `0x113aa0` has **1,564 direct callers** in `.text`, and its entire
body just constructs an object with vftable `0xa52d960` on the stack, calls it once, and ends with
`int3` — it never returns. It cannot be a BlockSource. (40 came from cross-build, 51 from call-edge
propagation. Both are low-trust routes.)

The 2024 body (`0x19b1f30`) is one line: `getDimension()` followed by a tail-jump into
`Dimension::getBlockSourceFromMainChunkSource`. Both of those are already carried, in both builds,
as **live-read accessors** (`Actor+0x1c8`, `Dimension+0xf0`). So instead of hunting an address, bdsx
walks it directly (`derived()`, `bds/implements.ts`). The wrong address went into `retracted` in
`data/candidates-instances-<v>.json`.

## 4. `Block::getName` is two offsets, not an address

The 2024 body (`0x2f2d00`) is one line: `movq 48(%rcx),%rax; addq $152,%rax`. 1.26 has no copy of
it (a function shaped like `48 8b 41 68 ... 48 05 e8 00 00 00` doesn't exist in either image — the
inliner took it). The two offsets `findings-reach.md` read live are the answer: **Block `+0x68` is
BlockLegacy**, and **BlockLegacy carries its own name as a HashedString.**

One correction was needed. What findings-reach wrote down as `+0xe8` is the **`std::string` inside
the HashedString**, and the HashedString itself sits 8 bytes earlier, at `+0xe0`. Running the first
probe with `+0xe8` set as the HashedString base showed exactly that: `"minecraft:dirt"` came back
as **`"t:dirt"`**, and `minecraft:diamond_block`/`minecraft:gold_block`, which overrun the small
string buffer (15 chars), came back **blank**. Fixing it to `+0xe0` gets all three right.

Shipped as `layouts.Block.blockLegacy = 0x68`, `layouts.BlockLegacy.name = 0xe0`, and
`Block.prototype._getName` is written as `derived()`.

## 5. Confirmed by execution (both builds)

`tools/block-probe.ts` (console `blkprobe [name]`), drivers `tools/host/drivers/blk40.ps1` /
`blk51.ps1`: `tp @a 29.5 68 14.5` → `setblock 29 67 14 <block>` → `blkprobe <block>`, three times
with diamond_block / stone / gold_block.

```
[blkprobe] PASS getDimensionBlockSource: ... vftable 0x...FFE960 dimension 0x...
[blkprobe] INFO getBlock: 29 67 14 -> 0x... vftable 0x...0202E0 | +0x68 BlockLegacy 0x... vftable 0x...
[blkprobe] PASS getBlock+getName diamond_block: "minecraft:diamond_block"
[blkprobe] PASS getBlock+getName stone: "minecraft:stone"
[blkprobe] PASS getBlock+getName gold_block: "minecraft:gold_block"
```

Both builds fully PASS, `Quit correctly` + exit 0
(`work/host-runs/blk40-20260919-205124.txt`, `blk51-20260919-205338.txt`).
As a bonus, **two vftables match the table**: the returned BlockSource's vptr RVA is
`??_7BlockSource@@6B@`, and the returned Block's vptr RVA is the `Block` table findings-reach
named live (40 `0xa6502e0`, 51 `0xa7d6ce0`). Both Block and BlockLegacy change every time the
block changes — it isn't reading a fixed location.

## 6. What's still blocked

## 7. `BlockSource::setBlock` — the non-virtual wrapper does **not** exist in 1.26, so bdsx calls the virtual

2024's `?setBlock@BlockSource@@QEAA_NHHHAEBVBlock@@HPEAVActor@@@Z` (`0x1b1ad60`, 82 bytes) is a
wrapper that flows x/y/z into three consecutive dwords on the stack to build a BlockPos and calls
the virtual `setBlock`:

```
movl %edx,64(%rsp)   movl %r8d,68(%rsp)   movl %r9d,72(%rsp)   ; x, y, z
leaq 64(%rsp),%rdx   movq 264(%rax),%rax  ; vft[33]
movq $0,32(%rsp)     ; 5th argument = nullptr (ActorBlockSyncMessage*)
movq 144(%rsp) -> 40(%rsp)                ; 6th argument = Actor*
```

**A function shaped like that does not exist in 1.26.** Scanning every function in `.pdata`
(20–400 bytes) for `edx`/`r8d`/`r9d` flowing into `[rsp+d]`/`[rsp+d+4]`/`[rsp+d+8]` turns up only
**4** in both builds, and of those, the two that are in the BlockSource table are the 3-int
overloads (slot 53 `isSolidBlockingBlock(int,int,int)`, slot 11). Running the same scan on 2024
gives 11, and **the real `0x1b1ad60` is among them** — meaning the scanner is correct.

The virtual side is **slot 32** (40 `0x14f6790` / 51 `0x15f6a80`), and its body is **identical at
the instruction level** to 2024's slot 33 (`0x1b1adc0`, the exact slot the wrapper above calls via
`movq 264(%rax)`) — only the security cookie 1.26 added differs: it zero-fills 16 bytes to splice
in as the outgoing 5th argument, shifts the caller's 5th/6th into 6th/7th, and hands off to an
inner function (40 `0x14f67f0` / 51 `0x15f6ae0`, 1,062 bytes).

**The inner function's body tells us the type of the last argument.** That frame has
`rbp = rsp+112`, so `112(%rbp)` is the 5th (the wrapper's zeroed 16 bytes), `120(%rbp)` is the 6th
(`ActorBlockSyncMessage*`), and `128(%rbp)` is the 7th. And for the 7th, both builds do this:

```
movq 128(%rbp), %rdx
cmpb $2, 16(%rdx)      ; the variant's index byte
jne  ...
movq (%rdx), %rcx      ; alternative 2's payload = Actor*
```

In `std::variant<monostate, EnvironmentChangeContext, ActorChangeContext,
ScriptOrCommandChangeContext>`, index **2 = `ActorChangeContext`**, and it holds a single `Actor*`
— exactly as in Endstone's `block_change_context.h`. So the last argument isn't `Actor*`, it's
**`BlockChangeContext const&`** — **16 bytes of storage plus the index byte at `+16`**. A
context that's all zero is `monostate`, i.e. the same thing bdsx is currently passing as a `null`
actor.

So bdsx builds the BlockPos and calls slot 32 directly (`makefunc.js([0x100], ...)`, 5th argument
`nullptr` as in 2024). If there is an actor, it writes the pointer at context `+0` and 2 at `+16`.
`bds/implements.ts`.

**Confirmed by execution, both builds.** `blkprobe set emerald_block` reads the Block at the
neighboring coordinate `(29,67,15)` with `getBlock` and places it at `(29,67,14)` with `setBlock`
(so `Block::create` isn't needed). It's bidirectional — bdsx reads, bdsx writes, and **BDS's own
`testforblock` confirms it**:

```
[blkprobe] INFO setBlock source: 29 67 15 is "minecraft:emerald_block" (the block about to be written over "minecraft:stone")
[blkprobe] PASS setBlock emerald_block: returned true, 29 67 14 now reads "minecraft:emerald_block"
[INFO] Successfully found the block at 29,67,14.
```

Both builds `Quit correctly` + exit 0
(`work/host-runs/blk40-20260919-214248.txt`, `blk51-20260919-214513.txt`).

### Block events: the virtual slots for three of them are gone
Endstone 0.11.7's `src/bedrock/world/level/block/block_type.h` has **directly commented out** four:

```cpp
// virtual void tick(BlockSource &, BlockPos const &, Random &) const = 0;
// virtual void randomTick(BlockSource &, BlockPos const &, Random &) const = 0;
// [[nodiscard]] virtual bool use(Player &, BlockPos const &, FacingID, std::optional<Vec3>) const = 0;
// [[nodiscard]] virtual bool use(Player &, BlockPos const &, FacingID) const = 0;
```

In other words there is no `use` in 1.26's BlockType vtable. bdsx's `buttonPress`
(`?use@ButtonBlock@@`), `chestOpen` (`?use@ChestBlock@@`), and `Block::use`/`BlockLegacy::use`
**have no slot route — they need a different seam.** (Endstone itself hooks
`LeavesBlock::randomTick` as a free function, not a virtual.) No more time spent looking for
something that isn't there.

`transformOnFall` is alive (`block_type.h` line 201). **Both builds' addresses and execution were
finished on 2026-09-20 — section 9.** Worth noting: 47 of the FarmBlock table's 132 slots are the
shared `xorl %eax,%eax; retq` stub — a slot that lands on the stub means "no override", not an
address.


## 8. This table's slot numbers drift by two in the middle when counted in header order

The numbers `tools/endstone-slots.mjs` counts out from the Endstone headers are **correct at the
front and back of the BlockSource table and off by +2 in the middle.** Only what's been confirmed
by body (identical in both builds) is recorded here:

| Slot | What the body says | Header count |
|---|---|---|
| 1/2 | layer dispatcher / 1-arg getBlock | 1/2 ✓ |
| 18 | `getDimensionId` | 18 ✓ |
| 27 | constructs a `WeakRef` (bumps refcount, records `{ptr, ctrl}`) = `getWeakRef` | 25 (**+2**) |
| 32 | `setBlock` forwarder, same as 2024 slot 33 | 30 (**+2**) |
| 35/36 | `movzwl 58(%rcx)` / `movzwl 56(%rcx)` = min/max height | 33/34 (**+2**) |
| 37–39 | `movq 48(%rcx)` = Dimension, three folded into one by ICF | 35–37 |
| 40/41/42 | `getChunkAt` / `getChunk(ChunkPos)` / `getChunk(int,int)` | 38–40 (**+2**) |
| 52 | `movq 40(%rcx)` = ChunkSource = `getChunkSource` | 52 ✓ |
| 53 | 3-int argument = `isSolidBlockingBlock(int,int,int)` | 53 ✓ |
| 65 | last entry in the table, last declaration in the header, `blockEvent` | 65 ✓ |

The front (0–18) and back (52–65) match, and the table's overall length (66) equals the header's
(66), so **the binary must have two extra slots somewhere in the middle, and the header must have
two extra somewhere after that.** The likely candidate is the `fetchAABBs(AABB const&, bool)` /
`fetchCollisionShapes(AABB const&, bool, ...)` overloads that `IBlockSource` redeclares — MSVC
emits a virtual group of the same name **gathered at the position of the base declaration**, so
the two extra slots land at the front rather than the back. Not confirmed. **The one conclusion:
don't name slots in this table by number alone. Read the body.**

Using the fact that the back-end numbers are accurate, two are left as candidates (**neither
executed yet, neither promoted**):

- `?checkBlockDestroyPermissions@BlockSource@@QEAA_NAEAVActor@@AEBVBlockPos@@AEBVItemStackBase@@_N@Z`
  = slot 60, 40 `0x14f3b60` / 51 `0x15f3b20`. The body takes rcx/rdx/r8/r9 plus one bool from
  `movzbl 176(%rsp)`, and opens with **`movl $319, %edx` (0x13F = `ActorType::Player`)**. 2024's
  `QEAA` side (`0x1b06190`) is a wrapper that takes the same arguments and forwards to the virtual
  with `movq (%rcx),%rax`, so the signature matches.
- `?mayPlace@BlockSource@@QEAA_NAEBVBlock@@AEBVBlockPos@@EPEAVActor@@_NVVec3@@@Z` (the hook target
  for the `blockPlace` event) = slot 56, 40 `0x14f7e10` / 51 `0x15f8040`. A 408-byte frame that
  saves xmm12–15 (consistent with taking a `Vec3` by value). **A hook target doesn't ship until
  it's been triggered by execution.**

## 9. `transformOnFall@FarmBlock` — the first block-event hook target, triggered on both builds (2026-09-20)

`farmlandDecay` is the **first hook target among bdsx's 17 block events to actually be
triggered.** Address: **40 `0x89bc980` / 51 `0x7152160`** (both 710 bytes, `.pdata` function start).

### What was used to build the FarmBlock table for build 51

`??_7FarmBlock@@6B@` was already in the table for 40 as `instances` (live objects) and for 51 as
`carry` (40 `0xa806750` / 51 `0xa8e38f0`, both 132 slots). Since the 51 side is `carry`
(low-trust), it was confirmed structurally:

- Diffing both tables against their respective **BlockLegacy-shaped base table** shows the
  **same nine slots** differ — 0, 4, 8, 18, **51**, 74, 102, 115, 121.
- The **byte sizes of those nine overrides don't differ at all between the two builds**: 68 / 186 /
  leaf / leaf / **710** / 270 / 279 / 710 / 101.
- Of the nine, only slot 51 is filled in the base table by a **shared no-op stub**
  (40 `0x760f0`, 51 `0x75fb0`) — exactly the shape of "`BlockType::transformOnFall` does nothing
  when there's no override."

### Second piece of evidence that slot 51 is `transformOnFall`

`??_7TurtleEggBlock@@6B@`'s **slot 51** is already carried in the table as
`?transformOnFall@TurtleEggBlock@@` — **in both builds** (40 `0x8a15da0`, 51 `0x2580b30`). An
independent route that confirms the slot number by name. (The 50 that `tools/endstone-slots.mjs`
reported is off by one, and the same one-slot error is why that tool's comment says "FarmBlock's
slot there is an empty stub.")

### Body — the prototype matches 2024

Both builds' bodies are **identical at the instruction level**, and the steps match 2024's
`?transformOnFall@FarmBlock@@` (`0x1b8bc90`, 676B).

| 2024 | 1.26 | Meaning |
|---|---|---|
| `testq %r9,%r9` → bail | same | if culprit (`Actor*`) is null, stop |
| calls `Actor::isRemoved()` (`0x19ba2a0`), bail if true | `cmpb $0, 617(%r9)` | same check, inlined = `Actor+617` is the removed flag |
| `getEntityTypeId` → predicate → bail if false | EnTT lookup **0x4F6BA419** then `testl $256,%eax` | `fnv1a("ActorTypeComponent")`, `ActorType::Mob = 0x100` |
| BlockSource `vft[41]` → `vft[272]` → bail if true | BlockSource `vft[43]` → `vft[317]` | Level-side bool gate |
| `vft[286]` → `vft[5]` (random) vs `fallDistance-0.75` | `vft[333]` → `vft[5]` | reads the 5th argument **as a float from the stack** (`256(%rbp)`) |

`tools/slot-shape.mjs`'s `shape()` answers `{args:"r9", ret:"branch"}` for all three binaries. In
other words it's still `(FarmBlock const*, BlockSource&, BlockPos const&, Actor*, float)` as-is,
and bdsx's 2024 prototype needs no fix.

**1.26 has no `Block::transformOnFall` forwarder.** 2024's `?transformOnFall@Block@@` (`0x1bba5b0`)
is a 47-byte `[this+0x30]` → `vft[65]` tail-call, but the byte sequence that moves it to 1.26's
offsets (`[this+0x68]`, `vft[51]`) doesn't exist in either image — the inliner took it, just as
with `Block::getName`. The caller is `Actor::checkFallDamage` (2024 `0x19acd00`).

### Execution (both builds)

Added a listener to `tools/block-probe.ts` that's only turned on with `FARM_PROBE=1`. **A hook
target is not installed outside its own driver** — since every session compiles this file, the
listener registration (`procHacker.hooking`) sits behind an environment variable (`Event` calls
the installer on the first listener). Drivers are `tools/host/drivers/farm40.ps1` /
`farm51.ps1`, console command `farmprobe [cancel|allow|call|check] [n]`.

Both builds **pass cleanly** (40: 22 PASS / 0 FAIL, 51: 13 / 0, both `Quit correctly` + exit 0.
`work/host-runs/farm40-20260920-143625.txt`, `farm51-20260920-143625.txt`):

1. **BDS itself enters the hook.** Every time an entity falls onto farmland the console laid down
   with `fill 27 67 12 31 67 16 farmland`, the event fires — 10 times on 40 (minecart, boat, cow,
   iron_golem, zombie ×5, item), 3 times on 51 (minecart, boat, cow). **At every entry, `this`'s
   vptr is `??_7FarmBlock@@6B@`**, the `BlockPos` is inside the farmland just laid, and the
   `BlockSource`'s vptr is `??_7BlockSource@@6B@`.
2. **Decay actually completes.** Reading that coordinate back afterward shows three spots as
   `minecraft:dirt` (40 `28 67 15`; 51 `27 67 13`/`28 67 15`/`28 67 13`). Some stay as farmland —
   cases where the gates in the body (ActorType, Level bool, random) didn't pass; the hook entry
   happens before the gates.
3. **Direct calls also work.** `farmprobe call` pulls the farmland's BlockLegacy (= FarmBlock),
   confirms its vptr is `??_7FarmBlock@@6B@`, then calls it **through the hook** with the 2024
   prototype: (legacy, BlockSource, BlockPos(29,67,14), player, 5.0f). The event fires exactly
   once and the server stays healthy.
4. **The CANCEL route blocks the original.** If the listener returns `CANCEL`, the block stays
   farmland — on 51, BDS's own `testforblock` confirms with `Successfully found the block at
   29,67,14`. (On 40 that line shows `Dirt` because a mob happened to step on that spot in the
   meantime, which is itself evidence for point 1.)

Added `farmlandDecay` to `data/events-fired.json` — `tools/event-coverage.mjs`'s UNFIRED goes
14 → 13.

### Three things learned along the way

- **A direct call with a player as the culprit doesn't change the block.** The hook fires but
  decay doesn't complete. That's a body-gate decision, unrelated to the seam — so the probe just
  records it instead of asserting on it.
- **The first attempt was one farmland tile + one cow, and it was 0 events.** Laying down a 5×5
  patch got the **minecart and boat that were already in the world** caught first. A narrowly
  scoped trigger route can't tell "the function is wrong" apart from "the scenario is wrong."
- **Don't hang the probe's expected value on BDS's internal decision.** If "the block becomes
  dirt" is the PASS condition, it looks like our address is wrong whenever BDS doesn't change it.
  The PASS condition needs to be "BDS entered our hook."

## 10. Slot 56 `mayPlace` and slot 60 `checkBlockDestroyPermissions` (2026-09-20)

The two section 8 left as candidates. The outcomes diverged: **`mayPlace` was confirmed through
the hook on both builds, while `checkBlockDestroyPermissions` had its address and call confirmed
but not its meaning.**

### First, a correction: only one of these two is a hook target

The queue was recorded as "two block-event hook targets," which was wrong. bdsx's
`blockDestroy` hooks `?destroyBlock@SurvivalMode@@` and `?destroyBlock@GameMode@@`
(`bdsx/event_impl/blockevent.ts`). `checkBlockDestroyPermissions` is **not a hook target — it's
just a method that gets called**, from exactly one place: `implements.ts:3523`'s
`BlockSource.prototype.checkBlockDestroyPermission`. So this name can be called straight from the
console without waiting for a trigger.

### Addresses

| Name | Slot | 1.26.40.8 | 1.26.51.1 | Size |
|---|---|---|---|---|
| `?mayPlace@BlockSource@@QEAA_N...` | 56 | `0x14f7e10` | `0x15f8040` | 1375 |
| `?checkBlockDestroyPermissions@BlockSource@@QEAA_N...` | 60 | `0x14f3b60` | `0x15f3b20` | 1012 |

**1.26 has no remaining non-virtual side.** 2024's two `QEAA` functions (`0x1b06190`,
`0x1b15d70`) have 4 and 6 direct callers respectively, but the 1.26 candidates **both have zero
direct callers** (`tools/callgraph.mjs`) — the inliner took the public wrapper, leaving only the
virtual. So the virtual's address is carried under the `QEAA` name that bdsx uses. Direct calls
reach the concrete implementation, and the hook also catches BDS's own virtual dispatch.

### What was done to avoid trusting slot numbers by position alone

Since section 8 established that "the middle of the table drifts +2 from the header count and the
back (52/53/65) is accurate," the whole **52–65 span was matched against the body one slot at a
time** in between (`tools/slot-shape.mjs`, identical in both builds):

| Slot | Declaration (Endstone) | Argument registers the body reads |
|---|---|---|
| 52 | `getChunkSource()` | none, straight to `ret` |
| 53 | `isSolidBlockingBlock(int,int,int)` | rdx, r8, r9 |
| 54 | `isSolidBlockingBlock(BlockPos const&)` | rdx only |
| 55 | `areChunksFullyLoaded(2)` | rdx, r8 |
| **56** | **`mayPlace(6)`** | rdx, r8, r9 (+ saves xmm12–15 = passing a Vec3 by value) |
| 57/58 | `canDoBlockDrops(1)` / `canDoContainedItemDrops(1)` | rdx |
| **60** | **`checkBlockDestroyPermissions(4)`** | rdx, r8, r9 (+ 5th from `176(%rsp)`) |
| 61 | `checkBlockPermissions(5)` | rdx, r8, r9 — sibling of 60, size 1116/1012 |
| 62 | `postGameEvent(4)` | rdx, r8, r9 |
| 64/65 | `fireBlockEntityChanged(1)` / `blockEvent(3)` | rdx / rdx, r8, r9 |

Both ends of the span are fixed and every slot in between matches the declaration, so 56 and 60
aren't drifted either.

### Second route: where the body reads `ItemStackBase`

Slot 60's body identifies itself without needing a slot number at all. What it reads from r9
(= `ItemStackBase const&`) matches **exactly the offsets confirmed by execution that same day**
(`findings-containers.md` section 10): `cmpb $1, 35(%r15)` (valid_ +35) → `movq 8(%r15)`
(item_ +8) → `cmpb $0, 34(%r15)` → `movq 80(%r15)` / `movq 88(%r15)` (**can_destroy vector
+80/+88**). The 2024 body reads +35/+8/+34 the same way and then calls out-of-line to
`?canDestroy@ItemStackBase@@`, but 1.26 has inlined that lookup — that's why the size doubled
from 513 to 1012. 2024's callee list pins the name down further: `isAdventure`, `isWorldBuilder`,
`isType`, `Player::canUseAbility`, `ItemStackBase::canDestroy`,
`Block::getIgnoresDestroyPermissions`, `BlockSource::_getBlockPermissions`.

### Execution — `mayPlace` is done (both builds, `place40`/`place51`, 11/11 PASS)

(`work/host-runs/place40-20260920-165653.txt`, `place51-20260920-165653.txt`)

Added an `events.blockPlace` listener to `tools/block-probe.ts` that only installs with
`PLACE_PROBE=1`, and `placeprobe call` calls it **through the hook**, the same way as section 9's
`farmprobe call`: a real `Block` pulled from the world, at the empty tile `(29, 72, 14)` above the
bot, facing=1, actor=bot, `Vec3(0.5,0.5,0.5)`.

- `mayPlace` returns **true** and `blockPlace` fires **exactly once**. The event's `blockSource`
  vptr matches the table's `??_7BlockSource@@6B@` (40 `0xa62e960`, 51 `0xa752900`), `block` has
  the same name as what was placed, and `player` is the bot.
- After `placeprobe cancel`, the same call returns **false** — the route where bdsx's wrapper
  flips the original's true into CANCEL actually runs.
- In other words **address, prototype, hook, event, and cancel route** are all confirmed on both
  builds. bdsx's 2024 prototype is correct as-is (`shape()` gives the same answer on all three
  binaries).

The remaining half needs a **real client** (Q7): bdsx's `onBlockPlace` calls the original first
and only fires the event when `actor instanceof ServerPlayer`. So placements made by mobs (snow
golem's snow, frost walk) enter the hook but aren't visible here.

### Execution — `checkBlockDestroyPermissions`'s **meaning is unconfirmed**

The call itself is clean. Across five sessions and eight calls on both builds, calling it with
the 2024 prototype bdsx declared **never crashed once and always returned a bool.** But **the
answer is `false` for every input that can be constructed from the console.** Configurations
tried (identical on both builds):

| What was changed | Result |
|---|---|
| Adventure mode + `can_destroy:["minecraft:dirt"]` in hand, target `minecraft:dirt` | false |
| Same item, target `minecraft:stone` (not in the list) | false |
| Creative mode | false |
| 5th argument 0 / 1 | both false |
| `ability @a worldbuilder true` / `false` | both false |

The "player means immediate false" hypothesis was **disproved**: the body's first branch checks
`cmpb $0, 617(%r14)` when `isType(actor, 319 = Player)` is true, jumping to the end
(`xorl %eax,%eax; ret`) if it isn't 0 — but the bot's `Actor+617`, actually read by the probe, is
**0 on both builds** (`Actor+612..622` was dumped). So the body runs to completion and then
returns false.

**So this name is shipped with an address but its meaning recorded as unconfirmed.** It isn't a
hook target, so the risk of shipping it is low, the static evidence checks out on two routes, and
execution is clean. What's next is written under "Remaining" below.

The probe's PASS condition follows the rule section 9 established as-is — **only assert "BDS
entered our hook / our call returned," and just print whatever judgment BDS made.** The first
three sessions broke that rule by setting "should be true in adventure mode" as the PASS
condition, which made the FAIL lines look like the address was wrong.

### One probe bug fixed along the way

`BlockLegacy`'s `name` is a `HashedString`, so **the `std::string` is at
`layouts.BlockLegacy.name + 8`** (that's how `tools/item-probe.ts` reads it). Reading from `+0`
reads the hash as a string and Access Violates. Because of this bug, two sessions were spent
suspecting "is the item's can_destroy broken, causing false" — after the fix, the list was fine
(`[minecraft:dirt, minecraft:coarse_dirt]` — BDS expanding the tag).

### Remaining

- ~~why `checkBlockDestroyPermissions` is always false~~ **finished in section 11 (2026-09-20).**
- `mayPlace`'s engine-driven trigger (a real client placing a block) — Q7.

## 11. Slot 60 called with a non-player actor — the answer diverges, and the player's false was a world flag (2026-09-20)

Section 10 left one question: is `false` for every input the console can build indistinguishable
from "our address is wrong"? The answer **diverges**. With the same `BlockSource`, same
coordinate, same item, **changing only the first argument from the bot to a mob makes both
builds return `true`.**

```
[blkprobe] PASS bdprobe 29 67 14 flag0: returned false ... actor the bot
[blkprobe] PASS bdprobe mob 29 67 14 flag0: returned true for block "minecraft:dirt", actor minecraft:iron_golem
[blkprobe] PASS bdprobe mob 29 67 14 flag1: returned true ...
```

Both builds **15/15 PASS + exit 0 + `Quit correctly`**
(`work/host-runs/place40-20260920-191533.txt`, `place51-20260920-191533.txt`).
What this proves is that **the first argument reaches correctly as `Actor&`**, and that this
function doesn't return a constant — it judges based on the actor it's given.

### Why mobs get true — the body said it first, and execution matched

Relevant addresses (40 / 51, both builds' bodies match at the instruction level):

| What | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| game-type lookup (`ActorGameTypeComponent`, FNV-1a `0x88D3EDDF`) | `0x1a5f5f0` | `0x1cd3970` |
| `LayeredAbilities::getBool` | `0x208880` | `0x296180` |
| `Actor::canUseAbility` (shape: `isType(Player)` → `Player::canUseAbility`, else component) | `0x14f34d0` | `0x15f32c0` |
| `Player::canUseAbility` (the tail-jump target) | `0x21f0a0` | `0x2ada30` |
| `AbilitiesComponent` predicate the top gate calls | `0xe1d400` | `0xd5d6f0` |

40's flow, written out by address:

```
0x14f3b8d  isType(actor, 319 = Player)     ; if false, skip +14 (skips the next two lines)
0x14f3b95  cmpb $0, 617(actor)             ; inlined isRemoved
0x14f3b9c  jne  -> 0x14f3f3d               ; xorl %eax,%eax; ret  (= false)
0x14f3ba7  callq 0xe1d400(actor)           ; AbilitiesComponent + getBool(…,6) + game type
0x14f3bc5  jmp   0x14f34d0(actor, 1)       ; if true, returns Actor::canUseAbility(Mine = 1) as-is
0x14f3bfe  callq 0x1a5f5f0(actor+8)        ; game type (= 2024's first step of isAdventure)
0x14f3c03  movb  $1, %bpl
0x14f3c06  cmpl  $-1, %eax
0x14f3c09  je    -> 0x14f3d22              ; * if no game type, leave the allow bit at 1 and skip the ability block entirely
0x14f3c42  …AbilitiesComponent…  0x14f3d14 movb $18, %dl → getBool(abilities, 18)
0x14f3d22  cmpb $1, 35(item)  → movq 8(item) → isNull → cmpb $0, 34(item)
0x14f3d5e  game type again → 0x14f3d97 Dimension vft 1384 → cmpb $1, 960(%rax)
0x14f3db4  movq 80(item) / 88(item)        ; walks the can_destroy vector
```

* This one line is the whole story. **Mobs have no `ActorGameTypeComponent`, so the lookup
returns `-1`**, and then the allow bit (`bpl`) **stays at 1**, skipping the entire adventure/ability
block. Same as what 2024's out-of-line body does — if `isAdventure(actor)` is false, it was
`movb $1, %dil` (two lines after `0x1b061eb`).

### The player's false belongs to the world, not to us

To reach the `can_destroy` list on the player route, control must pass through the gate at
`0x14f3d97`: `BlockSource+32` (Dimension) → vft 1384 → **`cmpb $1, 960(%rax)`**. This is 2024's
out-of-line `?getAdventureModeOverridesEnabled@LevelData@@` (`0x1f099e0` =
`movzbl 1255(%rcx); ret`), and 2024 obtained the same `LevelData` via `Dimension` vft **1184** and
called it. In other words, in 1.26, **that byte in `LevelData` moved from 1255 to 960, the
Dimension slot moved from 148 to 173, and the call got inlined.** If this gate is 0, the item's
`can_destroy` is **never read at all**, and all that's left is
`getBool(abilities, 18 = PrivilegedBuilder)`, which is also false → `false`.

`adventure mode overrides` is a world option and **cannot be turned on from a console command.**
That's why all six configurations tried in section 10 came back false, and this time two more
were tried (both on both builds) and were also false: **`op @a`** (adventure + operator) and
**`op @a` + `gamemode creative @a`**. The top gate's `0xe1d400` is false for the bot, so it doesn't
take the `canUseAbility(Mine)` shortcut either.

**Summary: address, prototype, and meaning are now all confirmed for this name.** The remaining
false is BDS's own gate, and what that gate is has also been confirmed from the body. A real
client entering a world with the adventure override turned on is Q7, but even without it, this
name has nothing left to wait for.

### Probe

`tools/block-probe.ts`'s `bdprobe` accepts three forms: `bdprobe hand` (reports input),
`bdprobe <x> <y> <z> [flag0|flag1]` (called with the bot), and
**`bdprobe mob <x> <y> <z> [flag0|flag1]`** (called with a mob). Mobs are caught in `entityHurt`
(the victim isn't a `Player`) — driver `place40/51.ps1` summons two iron golems and two zombies
and has them fight.

**What was learned here: a caught actor must be held as an `ActorUniqueID`, not a pointer.** The
first attempt held an id instead of a pointer, but held *only one*, and on 1.26.51.1 that golem
died before the second call, so `Level::fetchEntity` returned null
(`place51-20260920-185535.txt`) — no crash since the guard caught it, but a slot was lost. Now all
victims caught (up to 12) are held, and **the toughest one still alive** (iron golem) is picked.
Holding a pointer would mean calling into a freed `Actor`, and that's indistinguishable from a
wrong address.

### One session failure seen in this section (recorded as-is)

The 2026-09-20 19:01:48 pair ended with **both builds** hitting
`!! SESSION FAILED: the driver never reported an exit code`. The server side was fine — all 30
commands ran, every probe line is PASS, and `Quit correctly` is present
(`place40-20260920-190148.txt`). What dropped was the driver's ssh stdout, and everything after
the 17th command (`gamemode creative @a`) is missing from `run.txt`. The very next pair
(19:15:33) got `exit code: 0` on both builds with the same driver. Cause undetermined. This is
the first time a driver has run over 5 minutes, so if it recurs, the fix point is **writing the
exit code to a host file too, not just stdout** (`run-client-probe.ps1` → `<Tag>.exit`,
`session.mjs` reads it as a fallback).

## 12. Block destruction: `getDestroyProgress` is the address (first shipped as `getDestroySpeed`), `getDestroySpeed`/`canDestroy` are `derived()`, all confirmed on both builds (2026-09-22..23)

Of the three destruction-related names the queue grouped together (`canDestroy`,
`getDestroySpeed`, `getDestroyProgress`), **only `getDestroySpeed` is finished.** The other two
weren't solved this session for the reasons written in the following paragraphs — left in the
queue.

### 2024 structure (read fully first)

All three were read fully with `disas-exact`. `?canDestroy@Player@@` (`0x19d8b20`, 82B) tail-jumps
to `Block::getMaterial` (`0x1baef50`, reads Block+0x30 and tail-jumps to the `Material&` at
BlockLegacy+0x128) → `Material::isAlwaysDestroyable` (`0x566bc0`, **mis-labeled in the baseline
symbol table as `getBroadcastAnger@AngryComponent`** — a 1-byte getter, so the linker folded
several names onto one address, `movzbl 5(%rcx),%eax; retq`); if true, returns true, otherwise
tail-jumps to `PlayerInventory::getSelectedItem` (`0x186c1d0`) →
`ItemStackBase::canDestroySpecial` (`0x1b59f10`, ~700B — a very long function that hard-codes and
compares special block names like obsidian, netherite block, diamond block, etc.). **The only
caller** is `<lambda_...>::operator()` (`0x192de30`, 1960B, 0 direct callers — captured by a
`std::function` and called indirectly), and inside it: `isCreative` → `isUnbreakable@Block` →
`getDimensionBlockSource` → virtual `getBlock` → `isAir@Block` → `playerWillDestroy@Block`
(callback/event) → a gamerule virtual call (whether it's allowed) → `canDestroy` is called only
if that's false. `getDestroyProgress` (`0x19de460`, 63B header + a `.pdata`-less leaf tail
`0x19de49f`–`0x19de52c`) returns the result of `Player::getDestroySpeed` (`0x19de530`, 443B), which
branches to `Material::isAlwaysDestroyable` or `canDestroySpecial` and multiplies by different
factors (0.1 / 0.3), with `Block::getDestroySpeed` (`0x1a5c0f0`,
`movss 0x80(%rcx),%xmm0; retq` — Block+0x80 is hardness) giving 0 if negative, 1.0 if zero.
`GameMode::destroyBlock` (`0x19434d0`, 533B) calls `getDestroyProgress` **directly**, and
`SurvivalMode::destroyBlock` (`0x19436f0`, a `.pdata`-less leaf) tail-jumps to
`GameMode::destroyBlock` after a trial-mode check.

### 1.26's structure is different — `canDestroy` and `getDestroyProgress` likely don't survive as separate functions

`SurvivalMode::destroyBlock` is split into **two** adjacent `.pdata`-less leaves in both builds
(40 `0x1f3b180`/`0x1f3b1a0`, 51 `0x2537950`/`0x2537970`). The first (the real vftable entry the
Endstone slot points to) checks a permission byte (+0xc8) and a global cheat flag, then jumps to
`GameMode::destroyBlock` (40 `0x1f35b30`/868B, 51 `0x30ad670`) — this function was **read all the
way through**: `getDimensionBlockSource` → `getCarriedItem` →
`checkBlockDestroyPermissions` (already in the table) → virtual `getBlock` (slot 2) → a game-type
EnTT lookup (`fnv1a("ActorGameTypeComponent")=0x88D3EDDF`, 40 `0x1a5f5f0`/51 `0x1cd3970`, a helper
already confirmed via `hasDimension`) → **calls `Player::getDestroySpeed` directly** (below) → an
ability virtual call (vft+0x460) → a `SimpleContainer`-type virtual call (vft+0x38) → constructs a
`BlockEvent` struct and dispatches virtually (vft+0x20, and at the end vft+0x370/vft+0x980) →
updates a gamerule-related byte (+0xb22). **Neither `canDestroy` nor `getDestroyProgress` appears
inside this function in any identifiable form** — even `Block::getDestroySpeed`'s hardness read
(2024 `movss 0x80(%rcx)`) is **directly inlined as `ucomiss 0xb4(%r14),%xmm0`** with no separate
call (1.26's hardness field has moved to **Block+0xb4**, confirmed independently of the earlier
Block layout note).

The second leaf calls demo-mode telemetry (a `"demo.reminder"`-family string) then `jmp`s out to a
**different** function (40 `0x1f352a0`/1331B, 51 `0x30acc70`/1331B — same size on both builds).
Inside this function, `Player::getDestroySpeed` is called **again** (right after the exact same
`Block::getDestroySpeed` hardness check as the baseline function: `ucomiss 0xb4(%r14)` → branch →
`callq getDestroySpeed@Player` → compares the result against a constant). Immediately before this
is `movq 0x68(%r14),%rax; movq 0xe0(%rax),%rax; cmpq [global],%rax`, which **reads Block+0x68
(blockLegacy) → BlockLegacy+0xe0 (name, the HashedString's hash) and compares it against a single
global constant** — not a byte-flag read like isAlwaysDestroyable, but a direct comparison of a
**single name hash**. This looks less like 2024's `isAlwaysDestroyable` spot and more like
(guessing) an inlined `isAir@Block` (matches the order in which the 2024 lambda checks `isAir`
right after `getBlock`). In other words, **canDestroy's two-branch logic (material flag OR
special-item list) doesn't appear anywhere in this function in any recognizable form** — if it's
inlined, a different shape (material byte read, special-block name comparison chain) would need to
be found, and that wasn't found this session.

Another neighboring function this function calls (40 `0x1f35980`/427B) looks like a helper that
constructs and broadcasts a `PlayerActionPacket` (stores vftable `??_7PlayerActionPacket@@6B@`,
calls `getRuntimeID`, three virtual dispatches) — this looks like a "mining start/progress
notification" network function rather than canDestroy.

`isCreative` (`0xe1d650`) and `playerWillDestroy@BlockLegacy` (`0x1eea570`, a different name from
2024 — in 1.26 this is a virtual of `BlockLegacy`, not `Block`) have a **direct-caller intersection
of 0**, so the 1.26 function corresponding to 2024's 1960B lambda couldn't be found via this route.
Of `isCreative`'s 27 callers, the only large function in this neighboring translation unit is
`0x1f380c0` (4633B — looks like a giant dispatcher handling attack/interact/mine together;
`isCreative` is called exactly once, near its tail end), but this function has far too much
item-interaction/attack logic mixed in, and the piece corresponding to canDestroy couldn't be
pinned down this session.

### What to try next (suggested order)

1. **Read `0x1f380c0` (40) / its corresponding 51 address all the way through.** Look especially
   closely at the 50–100 bytes around the `isCreative` call (40 `0x1f39096`) — near `0x1bbaf20`
   (called repeatedly, possibly the 1.26 successor to `Block::getMaterial` — a different function
   from 2024's getMaterial baseline address `0x1baef50`, so read the body to check for a
   Block+0x68 read pattern).
2. If that still doesn't show it, **look for the material byte read itself**:
   `Material::isAlwaysDestroyable` is a 9-byte leaf in 2024, `movzbl 5(%rcx),%eax; retq`. In 1.26,
   look for a pattern where any function reads `+5` bytes from a Material pointer (around
   BlockLegacy+0xe0? the exact Material offset isn't solved yet — that might need to be obtained
   first) via `tools/leaf-funcs.mjs` or a direct byte scan.
3. `getDestroyProgress` had **only one caller to begin with** (2024's `GameMode::destroyBlock`).
   But 1.26's `GameMode::destroyBlock` (0x1f35b30/0x30ad670, read to completion) only calls
   `getDestroySpeed`, and the branch corresponding to `getDestroyProgress`
   (hardness<0→0, ==0→1.0, else multiplied) is not visible — **likely fully inlined.** If so, the
   conclusion could end up being "not an address-finding problem," like `dropAllOnDeath`. Before
   concluding that, (a) re-read `0x1f35b30` very carefully once more to re-check for a
   hardness==0/<0 branch, (b) keep reading all of `0x1f352a0`/`0x30acc70` (1331B, the function
   that calls getDestroySpeed) to check for the multiplier multiplication (`mulss` by a constant
   equivalent to 0.1 / 0.3).
4. Work on both builds, but **do not promote a candidate before its body has been fully read**
   (this session already avoided forcing a different function to fit just because
   `0xe1d650`/`0x1eea570`'s caller intersection was 0 — that judgment itself is a valid result).

### `getDestroySpeed@Player` — done (**name corrected 2026-09-23: this address is `getDestroyProgress`**, see "4th session" below; the location evidence here still holds)

Both builds shipped it as an **address**, not `derived()` (it's a `js` call, not a hook — no size
limit or `.pdata` requirement applies): **40 `0x21fec0` (374B), 51 `0x2aec80` (342B)**. Two
independent routes:

1. **Location.** In 1.26.40.8, there are exactly **two** direct E8/E9 calls to this address (a
   raw byte scan of `.text`, not a `.pdata`-based call graph — the caller itself is a leaf with no
   `.pdata` entry, so `.pdata`-based tools miss this edge). One of them is inside the 1331B
   function the second leaf of `SurvivalMode::destroyBlock` `jmp`s out to (40 `0x1f352a0`, 51
   `0x30acc70`, **same size on both builds**), called on the very next line after reading
   `Block::getDestroySpeed`'s hardness field (2024 Block+0x80, 1.26 is **Block+0xb4**) — the same
   position where 2024 calls `Player::getDestroySpeed(block)`.
2. **Body.** 40's `0x21fec0` does the already-confirmed hand-container lookup (Player+0x5b8 →
   vft[7] getItem, same as Container slot 7), two EnTT sparse-set lookups, a call to
   `?getRandomItemWith@EnchantUtils@@` (EquipmentFilter=3, aqua affinity), checks the result with
   `?isNull@ItemStackBase@@` (0x1bc2260, already in the table), and finally calls another function
   (0x1a61b20 — finds the item's tier/mining-speed record via EnTT and computes with a `divss`
   chain). This composition matches 2024's `0x19de530` step for step (selected item →
   `ItemStack::getDestroySpeed` → haste/conduit power/mining fatigue multiplier → aqua affinity
   `getRandomItemWith` → isNull gate). 51's `0x2aec80` has the same position and the same
   composition, and internally it calls **two addresses already confirmed independently**
   (`getRandomItemWith` `0x1b624f0`, `isNull` `0x1a549d0`) directly — this is 51's second
   independent route.

**Confirmed by execution (2026-09-22, both builds)**: `tools/block-probe.ts`'s
`digprobe [reset|compare|<label>]` (driver `dig40/51.ps1`). With `clear @a` for an empty hand,
`digprobe hand` gives **0.001333** for stone (minecraft:stone); after
`replaceitem ... diamond_pickaxe`, `digprobe pickaxe` gives **0.035556** (about 27x); after
`effect @a haste 30 1 true`, `digprobe pickaxe_haste` gives **0.049778** (larger still); and
`digprobe compare` confirms the whole sequence is strictly increasing — **4/4 PASS**, both builds
give **exactly the same numbers** (as expected, since it's a game-balance constant shipped at the
same time). tsc 0, exit 0, `Quit correctly`
(`work/host-runs/dig40-20260922-160215-digprobe.txt`, `dig51-20260922-160215-digprobe.txt`).
It's normal for the console to print an error every time saying it doesn't know the `digprobe`
command (same pattern as the other probes — `events.command` sees the string before BDS's own
parser does).

### `canDestroy`/`getDestroyProgress` — 2nd session (2026-09-22, agent-f): both candidate functions read to completion, neither is it

The two candidates agent-a left behind (`GameMode::destroyBlock` 40 `0x1f35b30`/868B and the
1331B neighbor it calls, 40 `0x1f352a0`) were **read to completion** (both builds, `disas-exact`
— 40's `0x1f352a0`–`+1331`, 51's `0x30acc70`–`+1331`, 40's `0x1f35b30`–`+868`, 51's `0x30ad670`;
same pattern confirmed at the same offset-line in each). Conclusion: **neither function isolates
`canDestroy` or `getDestroyProgress` with their prototypes — both are functions that do something
else.**

**Unpacked the hardness branch of the 1331B function (40 `0x1f352a0` / 51 `0x30acc70`)
instruction by instruction (0x1f355a0–0x1f355d4, 51 is `0x30acf74`–`0x30acf98`, same instruction
sequence at the same line number inside the function in both builds)**:

```
movq 0x68(%r14),%rax      ; Block+0x68 = BlockLegacy*
movq 0xe0(%rax),%rax      ; BlockLegacy+0xe0 = name hash
cmpq [air constant],%rax    ; is air?
je   <skip>                 ; if air, skip the getDestroySpeed call itself
xorps %xmm0,%xmm0
ucomiss 0xb4(%r14),%xmm0   ; Block+0xb4(hardness) vs 0.0  (AT&T: this direction is Intel UCOMISS xmm0,[hardness])
jb   <skip>                 ; if hardness > 0, skip
callq getDestroySpeed@Player  ; only called when hardness <= 0
ucomiss [1.0 constant],%xmm0
jae  <other branch>         ; branches if speed >= 1.0
```

In other words, **`getDestroySpeed` is only called when hardness ≤ 0 (not air, and 0 or negative
— i.e. instant-break or unbreakable blocks), and its result is used to decide direction by
comparing against 1.0.** For the most common case, hardness > 0 (a normal block like stone), this
entire branch is skipped outright — unlike 2024's `getDestroyProgress`, which always computes
`speed/hardness*multiplier`. There is **no division (`divss`) here at all**, and none of the
multiplier constants 2024 multiplies by (`0x3c23d70a`=1/100, `0x3d088889`=1/30) either.

**Unpacking the same spot (0x1f35d05–1f35d6d) in the 868B function
(`GameMode::destroyBlock`, 40 `0x1f35b30` / 51 `0x30ad670`) shows the same hardness≤0 branch, and
its result (`r14b`) is always laid down as 0 for a normal block with hardness>0 and then merged
into one of the following**:

```
proceed = r14b                                    ; hardness<=0 && speed>=1.0
        | ( (has gameType && a creative-class ability) & hasGameType )
        | (this+0x24 >= 1.0f)                      ; a field of the GameMode instance — probably an "instant-break speed" flag
        | !(byte at +0x38 of the vft+0x980 call result) ; a byproduct byte from another virtual call
```

**For a normal block with hardness > 0, the hardness/getDestroySpeed term among these four is
always off** — i.e. what this function actually uses to "authorize" destruction is only the
creative/spectator ability, the GameMode instance flag, and the byproduct of another virtual call;
**there is no material- or item-dependent canDestroySpecial-style special-casing anywhere in this
route.** This means `GameMode::destroyBlock` is not 2024's `canDestroy`+`getDestroyProgress`
combined, but **a different function that decides "should this be instantly destroyed by a single
call"** (closer to a creative/instant-break-only path). Progressive survival mining (progress
accumulating each tick until it hits 1.0 and breaks) lives somewhere outside this function —
probably the `PlayerActionPacket` state machine (40 `0x1f35980`, 427B, neighboring these
functions) — and wasn't found this session.

**Read one more thing — `BlockLegacy` virtual slot 81 (offset 0x288) — but did not promote it.**
Inside the 1331B function there's a virtual call made only when "not air and GameMode+0x24==0.0"
(40 `0x1f3553f`, rcx=BlockLegacy*, rdx=Player*, third argument unknown — it doesn't take an item
pointer). Reading that slot (offset 0x288 = index 81) from 40's live-captured
`??_7BlockLegacy@@6B@` (`vftables` in `data/candidates-instances-1.26.40.8.json`, RVA
`0xa65d460`) gives **`movb $1,%al; retq`** — a 3-byte default implementation returning an
immediate `true`. Multiple subclasses of the `Block` (behavior) family have been captured
(`StoneBlock`, `ChestBlock`, etc.), but only this one `BlockLegacy` vtable has been captured, so
no case of this slot being overridden with a different value has been seen — **there's no basis
to determine** whether this slot really means something like canDestroySpecial ("destroyable only
with special items"), or something entirely different (e.g. a WorldEdit-style permission slot).
Since the third argument isn't an item, its signature differs from 2024's
`ItemStackBase::canDestroySpecial(Item const&, Block const&)`, and since a `BlockLegacy` vtable
has never been captured live on 51, the two builds couldn't even be cross-checked. **Neither body
nor execution — not entered into the table.**

**The code corresponding to `Material::isAlwaysDestroyable` (the 1-byte flag at `Material+5`) and
`ItemStackBase::canDestroySpecial` (the hard-coded chain comparing ~40 block names, 2024's
distinctive shape of `lea`ing a `VanillaBlockTypeIds::<Name>` global before each comparison) could
not be found anywhere in either build.** What was tried: (1) reading both destroyBlock candidate
functions to completion (above), (2) the direct-caller intersection of
`isCreative`/`playerWillDestroy@BlockLegacy` (0, already confirmed by agent-a), (3) **a global
scan looking for spots where the same call target repeats within a function** (counts repetitions
of each `E8 rel32` target within a 3000-byte window — in 2024 the shared helper `0x576d70` used by
`canDestroySpecial` shows up clearly with 140 repetitions in-window) — running the same scan on
both 1.26 builds shows no such concentrated region near the mining code (`0x1f3xxxx` range); the
global maxima are in entirely different, unrelated regions. **This hard-coded comparison list
likely changed to a completely different mechanism in 1.26 (type/component-based, not name
enumeration)** — this was not confirmed.

**Conclusion: this session produced neither an address nor a `derived()`.** It was confirmed
(statically) that both candidate functions actually do something else, and that fact itself is a
valid result recorded as-is. Combining `canDestroy`/`getDestroyProgress` into a `derived()` will
require either (a) finding progressive mining's real entry point (presumed
`0x1f35980`-family PlayerActionPacket handler) and re-locating the spot where
hardness/getDestroySpeed is actually divided, or (b) confirming the new mechanism
`canDestroySpecial`-style judgment moved to (presumed component/tier comparison) — both are beyond
this session's scope. What to try next:

1. **Read `0x1f35980` (40, 427B) / 51's corresponding address to completion.** It looks like a
   sibling of `GameMode::destroyBlock` (the call site is near the "creative instant-break failed"
   branch), and looks like it constructs a `PlayerActionPacket`, but this isn't confirmed —
   likely a function holding progressive mining state (accumulated progress).
2. If 1 above turns out not to be progressive mining, **first check whether a name like
   `?startDestroyBlock@`/`?continueDestroyBlock@` exists in 2024** (`grep` baseline-symbols.json),
   and if so, look for its 1.26 counterpart first — it's likely the real caller that calls
   `getDestroyProgress` every tick.
3. Verify first the hypothesis that `Material::isAlwaysDestroyable`/`canDestroySpecial` itself
   **changed to a tier/component comparison rather than a name enumeration** — look for 2024's
   `?tier@Item@@`-family (mining tier) and `Block`'s required-tier field (if it already exists) and
   find the comparison code. Don't try again to find the name-enumeration form (repeated labeled
   global `lea`s) — this session's global scan got 0.
4. The meaning of `BlockLegacy` vft slot 81 **can only be judged after also live-capturing (via
   reach-probe) a `BlockLegacy` vtable on 51** (a block class with an override needs to be found
   to learn the third argument and the meaning). For now it's left as information only.

### Byproduct: read two private `GameMode` siblings, and `canDestroy` might not even be on the destruction execution path

baseline-symbols.json has `?_canDestroy@GameMode@@AEAA_NAEBVBlockPos@@E@Z` (`0x1934fd0`) and
`?_creativeDestroyBlock@GameMode@@AEAA_NAEBVBlockPos@@E@Z` (`0x1935080`), so **both were read to
completion** — these are different functions from the `Player::canDestroy(Block const&)` bdsx
requires (different name, different class, different arguments: a private member of `GameMode`,
`BlockPos const&` + `unsigned char`, not `Block const&`).

- `_canDestroy@GameMode` is a **pure forwarder**: after `getDimensionBlockSource` +
  `getSelectedItem`, it forwards straight through to **`BlockSource::checkBlockDestroyPermissions`**
  (already in the table, slot 60) — uses neither material nor canDestroySpecial. It just converges
  on an already-known function, not a new lead. `_creativeDestroyBlock@GameMode` is likewise just
  `PlayerActionPacket` construction/broadcasting plus a call to `GameMode`'s own **virtual slot
  0x10** (looks like the actual "perform the destruction" point that subclasses override) —
  again unrelated to canDestroy/getDestroyProgress.

- **No reference to 2024's only caller of `?canDestroy@Player@@`** (the 1960B lambda,
  `0x192de30`) could be found anywhere — 0 `lea`s to that address anywhere in `.text`, and 0
  8-byte absolute pointers holding that VA anywhere in `.rdata`/`.data` (exhaustive scan).
  agent-a's note that it's "captured by a `std::function` and called indirectly" was an inference
  drawn from the observation of 0 direct callers, not something backed by an actual found
  reference — and it wasn't found this session either. **The possibility can't be ruled out that
  `canDestroy` isn't on the server-side destruction execution path (`GameMode::destroyBlock`-family)
  at all, and is instead a client-prediction/UI predicate** (e.g. showing whether the crosshair
  target is destroyable) — if so, no amount of reading 1.26's `GameMode::destroyBlock` could ever
  produce it. This hypothesis wasn't verified (finding the lambda's real caller would require
  separately investigating the vtable-like structure where a `std::function` is stored, or a
  coroutine/callback registration point — out of this session's scope).

**Summary: this session produced neither an address nor a `derived()` for `canDestroy`/
`getDestroyProgress`. What it did produce is strong static evidence about "where it isn't," and
the next person is better off, instead of digging further into `GameMode::destroyBlock`, starting
over from (1) the progressive-mining tick handler (presumed `0x1f35980`-family) for
`getDestroyProgress`, and (2) that 1960B lambda's real registration point for `canDestroy`.**

### `canDestroy`/`getDestroyProgress` — 3rd session (2026-09-23, agent-y): both shipped, as `derived()`, but only half

Followed the queue's directional guidance (stop digging further into
`GameMode::destroyBlock`) and took **a different route**: first confirmed that of the two pieces
`canDestroy` called in 2024 (`Material::isAlwaysDestroyable`, `ItemStackBase::canDestroySpecial`),
the `canDestroySpecial` side is **`Item`'s own virtual slot** (when Endstone's `item.h` counts
`~Item()` as slot 0, `canDestroySpecial(Block const&)` is slot **33** — the same numbering as the
already-shipped `isComponentBased`@9, `isDamageable`@14). Two independent confirmations: (a)
1.26.51.1's already-confirmed address `?isHandEquipped@DiggerItem@@` (`0xa2880`) sits exactly at
**slot 39** in the same table (`isHandEquipped` is 6 lines after `canDestroySpecial` in the
header) — confirming the slot numbering again with one known address. (b)
`??_7PickaxeItem@@6B@`/`??_7ShovelItem@@6B@`/`??_7HoeItem@@6B@` (40
`0xa653a40`/`0xa6b6d70`/`0xa68ab30`, corresponding 51 addresses) point at slot 33 to
**the same 156-byte function folded by COMDAT** (40 `0x3759760` / 51 `0x36f1a40`, byte-identical
across builds): it first checks the item's own tag (`this+0x218`), and if that doesn't match,
checks the wood/stone/iron/diamond tier tags in order (up to four) — **if none hit, always
true**; if one hits, it compares the item's own tier field (`this+0x210`) against that step. The
tag strings themselves live in runtime-initialized `.data` so they can't be read from the file,
but the shape is clear. **A non-tool item** (`??_7CoalItem@@6B@`, 40 `0x33c4030` / 51
`0x20b8b90`, 235B, also byte-identical) has a completely different body at slot 33 — a
`ComponentItem::getComponent("minecraft:digger")`-style lookup, returning false unconditionally
if the component is missing. This contrast shows the slot is real and varies per item (not a
shared stub).

**The remaining half couldn't be found — honestly left out.** `Material::isAlwaysDestroyable` (or
its successor) couldn't be found either out-of-line or inlined inside
`GameMode::destroyBlock`-family functions in either build (same conclusion the 2nd session already
confirmed by reading to completion). Endstone's `material.h` (both v0.11.7 and HEAD) asserts
`sizeof(Material) == 7` and enumerates seven named bytes (`type_`, `never_buildable_`, `liquid_`,
`blocks_motions_`, `blocks_precipitation_`, `solid_`, `super_hot_`), none of which is an
"always destroyable" type — 1.26 may have removed this concept entirely, or moved it somewhere
else (per-block tags?), but this couldn't be pinned down this session. **So both
`canDestroy`/`getDestroyProgress` were composed from `item.canDestroySpecial(block)` alone** —
for a material like dirt that's "always destroyable regardless of tool," this is expected to give
a wrong answer (false / a slow multiplier) unlike 2024, and this fact was written as-is in code
comments and `data/derived.json`. `Player.prototype.canDestroy` is now `derived()`:
`getSupplies().getSelectedItem()` → `item_` (+8, double dereference, the same route as the
existing `getComponentItem`/`isDamageableItem`) → `Item$canDestroySpecial` (a raw-asm tail-jump to
vft+0x108, the same trick as `isComponentBased`/`isDamageable`). `getDestroyProgress` first splits
on hardness (Block+0xb4, already confirmed) for <0/==0, and otherwise computes
`getDestroySpeed(block) * (1/hardness) * (canDestroy ? 1/30 : 1/100)` — the two multiplier
constants (`0x2da5ed4`=1/30, `0x2bd9bf4`=1/100) were read directly from 2024's leaf tail
(`0x19de49f`–`0x19de52c`) via `disas-exact`.

**Execution (both builds, 2026-09-23, `dig40`/`dig51`, `tsc 0` + `exit 0` + `Quit correctly`,
both builds' values bit-identical)**: `digprobe progress` matched real Bedrock rules across
stone/obsidian/bedrock — **stone**: bare-hand `canDestroy=false` (progress 8.89e-6), diamond
pickaxe `canDestroy=true` (progress 7.90e-4, ~89x the bare-hand value — consistent with the
already-confirmed `getDestroySpeed` ratio (~26.7x) multiplied by this new factor (~3.33x)).
**Obsidian**: diamond pickaxe (with haste) `canDestroy=true` (2.03e-6), bare hand
`canDestroy=false` (2.29e-8) — matches the real game's rule that obsidian needs a diamond-tier or
better pickaxe to drop. **Bedrock**: bare hand and diamond pickaxe **both** `canDestroy=false`,
progress **0** — the hardness<0 branch trips before canDestroy is even read, matching the fact
that no tool can ever mine bedrock in survival. `work/host-runs/dig40-20260923-094036.txt`,
`dig51-20260923-094031.txt`. **Not tried**: checking a tool-independent material (dirt, etc.) —
as predicted above, this will give a wrong answer (can't mine / slow) here. New probe step
`digprobe progress`, six commands added to driver `dig40/51.ps1` (obsidian/bedrock switches,
bare-hand↔pickaxe swaps). `data/derived.json` 138 → **140**.

**What the next person should do**: find what tool-independent materials like dirt/wood were
replaced by. Two candidates: (a) that the tag-tier logic confirmed above fully absorbed the
"material" concept — whether non-DiggerItem items all follow the same "true if no tag" rule, or
whether they follow CoalItem's "false if no component" rule **splits into two branches**
(DiggerItem-family = true if no tag at all, non-tool-family = false if no component) — if this is
true, dirt+bare-hand would still come back false (if bare hand falls into the same class as
CoalItem). Actually checking dirt+bare-hand is the first step for the next session.
(b) the possibility that `BlockLegacy` virtual slot 81 (left by the 2nd session, default
implementation `true`) is the material substitute — first, what the third argument is needs to be
confirmed.

### `canDestroy` front half found, and `getDestroySpeed`/`getDestroyProgress` swapped — 4th session (2026-09-23, Q1-1)

**Result: `canDestroy` is complete, and the address shipped as `getDestroySpeed@Player` since
2026-09-22 is really `getDestroyProgress`.** Both were confirmed by execution on both builds.

**Where the front half went.** Endstone's `block_type.h` (v0.11.7 and HEAD) declares
`bool requires_correct_tool_for_drops_ : 1` (with `requiresCorrectToolForDrops()`) among the
bitfields right after `render_layer_` (+354). Its `NameInfo` puts `full_name` at +144+80 = **224**,
which is the execution-confirmed `layouts.BlockLegacy.name`, so the layout lines up here. The
bitfields start at +355, which puts this one in byte **+357 = 0x165**. A `.text` scan for
`testb $imm, 0x165(reg)` (the scratchpad script: all `F6 /0` / `0F B6` / `80 /n` forms with that
disp32) finds exactly **three `$0x4` sites per build**. Two of them spell out 2024's OR:

- 40 `0x1a61b20` / 51 `0x1e968d0` (0x2dd bytes on both). This is **the progress helper**. It calls
  40 `0x1a61e70` for the raw speed. That helper reads item vft+0x2c0 (or 1.0 with no item), applies
  haste/conduit (`amp*0.2+1`, constant `0xa53480c`=0.2) and mining fatigue (`pow`), then ÷5.0
  (`0xa50f2d8`) per the context flags +0x20..+0x24. Hardness comes from `0x1bb1110(block, item)`.
  Hardness <0 returns 0 and ==0 returns 1.0. Otherwise it caches
  `canDestroy = !(block->blockLegacy[0x165] & 4) || item->vft[0x108](block)` as an `optional<bool>`
  (`movw $0x101` / `$0x100`, or the vcall result `| 0x100`). It then returns
  `speed / hardness / (canDestroy ? 30.0 : 100.0)` (40 `0xa52c2f4`=30, `0xa52c2f0`=100; 51
  `0xa64b2f4`/`0xa64b2f0`). vft[0x108] is slot 33, the `canDestroySpecial` the 3rd session had
  already shipped.
- 40 `0x1f46540` / 51 `0x30b5600`, the block-break path. It tests the same bit, calls vft[0x108] when
  the bit is set, and only goes on (through the game-type helper `0x1a5f5f0`/`0x1cd3970`) to
  `0x1bb39c0`/`0x2cec210` when the OR holds. That is the drop gate.

So 2024's `Material::isAlwaysDestroyable` became **`!BlockLegacy::requiresCorrectToolForDrops`**.
The flag moved from `Material` to the block type and inverted, which is why `sizeof(Material)==7` has
no slot for it. bdsx's `canDestroy` tests the bit first (layout-driven:
`layouts.BlockLegacy.requiresCorrectToolForDrops = 357`, mask 4) and only then asks the item.

**Doubting a shipped name (HANDOFF rule 4).** `Player::getDestroySpeed`, which the table shipped at
40 `0x21fec0` / 51 `0x2aec80`, fills a context struct and **returns `0x1a61b20(ctx)` / `0x1e968d0(ctx)`
unchanged**, and that callee is the progress helper above. The context is: +0 EntityContext
(`this+8`), +8 block, +0x10 selected ItemStack, +0x18 a cache at `this+0xcb0`, and +0x20..+0x24 flags,
the last one being the aqua-affinity `isNull` gate. The 2026-09-22 readings were progress all along:
stone bare hand 0.001333 = 1 ÷5 (airborne bot) ÷1.5 ÷100, and diamond pickaxe 0.035556 = 8 ÷5 ÷1.5 ÷30.
The 1331B caller compares the result against 1.0, which is an instant-break test on progress. The
old `digprobe compare` could not tell the two apart because it only checks monotonicity. So the
address now ships as `?getDestroyProgress@Player@@` (a straight prototype swap, both
`float (Player const*, Block const&)`), and the 3rd session's `getDestroyProgress` `derived()`,
which divided a second time, is gone. `getDestroySpeed` is now the `derived()`:
`progress × hardness × (canDestroy ? 30 : 100)`. 1.26 keeps no `(Player, Block)` form of the raw
speed; `0x1a61e70` takes only the context.

**The hardness source** (40 `0x1bb1110`, read whole) is not simply Block+0xb4. If Block+0xd0 is null,
it is Block+0xb4. Otherwise it is the float at `[+0xd0]+0`, unless one of the 24-byte entries of the
vector at `[+0xd0]+8/+16` matches the item (`0x24fc900`, i.e. `destructible_by_mining`'s
item_specific_speeds), in which case that entry's +16 wins. A first run assumed +0xd0 meant
"per-item table" and returned NaN everywhere: **every vanilla block probed carries the table, with an
empty vector**, and `[+0xd0]+0` equals +0xb4. The derived returns NaN only when the vector has entries
or hardness ≤ 0, because the engine's progress holds no speed to recover there.

**Execution (both builds, `dig40`/`dig51`, tsc 0, exit 0, `Quit correctly`, 14/14 PASS,
bit-identical; `work/host-runs/dig40-20260923-122621.txt`, `dig51-20260923-122621.txt`).** New
probe step: `digprobe expect <true|false> [speed]`. The `canDestroy` results match real Bedrock
harvest rules on nine block/tool pairs:

| block | tool | canDestroy | `requiresCorrectTool` |
|---|---|---|---|
| stone | bare hand | false | true |
| obsidian | bare hand | false | true |
| **dirt** | **bare hand** | **true** | **false** |
| **oak_planks** | **bare hand** | **true** | **false** |
| oak_planks | wooden pickaxe | true | false |
| iron_ore | wooden pickaxe | false | true |
| stone | wooden pickaxe | true | true |
| stone | diamond pickaxe | true | true |
| obsidian | diamond pickaxe | true | true |

bedrock gives progress 0.

The speed checks are the engine-side cross-check. The engine's progress was divided by 30 or 100 on
**its own** canDestroy, and bdsx multiplies back by **ours**. The result came out at the tool's known
speed on all nine (0.2 bare hand, 0.4 wooden, 1.6 diamond; ÷5 because the bot is airborne; 2.24 with
haste II = 1.6×1.4). A disagreement on any of them would have been off by a factor of 10/3.
Hardness as read: stone 1.5, obsidian 35, dirt 0.5, oak_planks 2, iron_ore 3.

**Not exercised:** a block with item-specific speed entries (NaN by construction); hardness 0 (NaN);
the third `testb $4, 0x165` site per build (40 `0x8e7d9f0`, 51 `0x8a251c0`, not read).

## 13. The remaining four `NO TARGET` block events — static tracing only, all four still blocked (2026-09-22, Q1-A 4)

`pistonCheck`/`pistonMove` (`PistonBlockActor::_attachedBlockWalker` / `_spawnMovingBlocks`),
`lightningHitBlock` (`Block::onLightningHit`), `fallOnBlock` (`Block::onFallOn`),
`projectileHitBlock` (`Block::onProjectileHit`) were picked up this session. **None of the four
got an address** — per the rule that a hook target is never shipped without being triggered by
execution, neither `blockevent.ts` nor `data/resolved-*.json` was touched. Instead, structural
evidence for "why it doesn't work" was obtained for all four, and this session's core takeaway is
that one of them (lightning/projectile) is a fundamentally different problem from the previous
block events.

### 13.1 `lightningHitBlock` / `projectileHitBlock` — the public wrapper got inlined, and the remaining virtual slot is an empty stub shared via ICF

Started by reading the 2024 body. `Block::onLightningHit` (`0x1bb5150`, 18B) and
`Block::onProjectileHit` (`0x1bb63e0`, 18B) are **pure 2-line forwarders**, shaped just like
`setBlock`/`getName`:

```
movq 0x30(%rcx), %rcx      ; Block+0x30 = BlockLegacy*
testq %rcx, %rcx
je terminate
movq (%rcx), %rax          ; BlockLegacy vtable
movq 0x90(%rax), %rax      ; onLightningHit = slot 18 (0x90/8); onProjectileHit = slot 17 (0x88/8)
jmpq *icall_fptr
```

**This byte sequence doesn't exist in 1.26.** Scanning every 10–40 byte function in `.pdata` that
starts with `mov reg,[rcx+0x68]` (1.26's `Block::blockLegacy` offset, `findings-blocks.md` section
4) turns up only **4** in both builds, and all four differ after that from this forwarder shape
(the `test`/`je` matches, but the second `mov+mov+jmp` that follows is missing — a different
function). **The public wrapper got scattered by inlining**, like `setBlock`/`getName`/
`transformOnFall`.

**One scattered spot was actually found.** In 2024, `Block::onLightningHit`'s only real caller is
`?normalTick@LightningBolt@@UEAAXXZ` (`0x1a3f960`) — the exact loop where lightning tests its
target block every tick. 1.26's counterpart **already has an address**
(`??_7LightningBolt@@6B@` 40 `0xa6bad80`, `?normalTick@LightningBolt@@` 40 `0x2d2caf0`). Inside its
body, right after obtaining `BlockSource*` via a `getBlockSourceFromMainChunkSource`-type virtual
call (around offset `+0x1e0`), exactly this pattern is inlined:

```
movq 0x68(%rax), %rcx      ; Block+0x68 = BlockLegacy* (1.26 offset)
movq (%rcx), %rax          ; vtable
movq 0x80(%rax), %rax      ; slot 16 (0x80/8)
movq %rdi, %rdx            ; BlockSource*
movq %rbx, %r8             ; BlockPos*
callq *icall_fptr          ; this=rcx(BlockLegacy*), (BlockSource*, BlockPos*) — exactly the onLightningHit shape
```

Passing exactly two arguments (rdx=BlockSource\*, r8=BlockPos\*) matches
`onLightningHit(BlockSource&, BlockPos const&)` exactly. **The slot number is 16.**

### The `+1` drift in header slot numbers already starts here

`tools/endstone-slots.mjs --families=block`'s index, counted in `block_type.h` declaration order,
gives `onProjectileHit`=14, `onLightningHit`=15. The slot actually found above is **16** — i.e.
the `+1` drift, the same size section 8 saw for `transformOnFall` (header 50 vs actual 51), is
already present **much earlier (before 15).** Reading `??_7BlockLegacy@@6B@` (40 `0xa65d460`)
directly shows slots 15 and 16 pointing at **the same address, `0x760f0`** — MSVC has folded
several empty functions that just `retq` with no arguments into one via ICF (**the same address**
as `transformOnFall`'s empty stub `0x760f0`! Section 9 already saw this stub at a different slot
(51) — evidence that ICF merges no-op virtuals of different signatures onto one address too).

This is the decisive problem: **the default `onLightningHit`/`onProjectileHit` for `BlockLegacy`
(the base implementation, most blocks) is a shared no-op stub, and that address is shared with
other no-op virtuals this project has never seen before.** If `procHacker.hooking` hooks this one
address, every call to any other unrelated no-op virtual slot gets caught by our hook too — **not
precise.** (2024 had the same shape: `BlockLegacy::onLightningHit` `0xbd3d0` and
`BlockLegacy::onProjectileHit` used **the same address** — this ICF sharing isn't a new
phenomenon, it existed as far back as 2024, and it didn't matter then because the hook target was
the **single non-virtual dispatch point** `Block::onX`. The problem is that 1.26 has lost that
non-virtual point.)

Blocks that actually react to lightning/arrows (`LightningRodBlock::onLightningHit`,
`TargetBlock`-family's `onProjectileHit`) each have real overrides at **different addresses**, so
they can be found individually — but hooking only those drops the event entirely for
"non-reacting blocks," diverging from the 2024 meaning (the event fires unconditionally on every
block, and a listener can block the original with `CANCEL`).

**Resolved 2026-09-24 by route 1 below (the user chose it): section 21.** One correction to the paragraph above:
bdsx's `projectileHitBlock`/`lightningHitBlock` never looked at `fire()`'s result, so neither event was cancellable
in 2024 either -- moving where they are raised loses no cancel.

**Blocked. Next steps (neither tried):**
1. **Find the inlined fragment on the caller side individually and hook the caller function
   itself**, like `LightningBolt::normalTick` (40 `0x2d2caf0`) and
   `?onHit@ProjectileComponent@@` (2024's caller, 1.26 address unconfirmed), and reconstruct the
   event on the bdsx side within it — if the caller is unique (in 2024, `onLightningHit`'s only
   real caller was `LightningBolt::normalTick`), this route is the closest to the original meaning.
2. **Accept a narrowed meaning** — hook only the concrete addresses of blocks with real overrides
   (lightning rod, etc.) individually, and give up on the 2024 behavior of "the event fires even on
   non-reacting blocks." Requires a user decision.

`onProjectileHit`'s actual slot is estimated to be **15** (header 14 + 1) by the same logic, and
its default is the same `0x760f0` stub — this wasn't separately confirmed by execution (given time
priority, `projectileHitBlock` was "if time permits," and since the structural reason
`lightningHitBlock` is blocked applies just the same, it wasn't dug into further).

### 13.2 `fallOnBlock` — the 2024 body is a completely different system

`Block::onFallOn` (2024 `0x1bb48a0`, **711B**) is **not at all** a 2-line forwarder like
`setBlock`/`getName`/`onLightningHit`. Reading the body: it tries
`BlockComponentStorage::tryGetComponent<BlockFallOnEventComponent>` on `this` (Block) first, then
on `this+0x30` (BlockLegacy) if that fails; if found, it calls all the listeners registered
through the **PubSub framework** (`FastDispatchPublisherBase_MultiThreaded::_loadDispatchTargets`,
a `weak_ptr<SubscriptionBodyBase>` array, refcount increments and a virtual call). If neither is
found, it calls **`BlockLegacy::onFallOnBase`** directly (non-virtual, `IEBA` decoration =
protected non-virtual, belonging only to `BlockLegacy`).

In other words, regardless of whether 1.26 inlined this function, **what this function does is
itself a qualitatively different event system** from `mayPlace`/`setBlock`-family (Bedrock's
general-purpose PubSub framework, data-driven component registration). It's neither
`entt::type_info` nor the EnTT pattern `component-hash.mjs` looks for (running
`tools/component-hash.mjs` for `fnv1a("BlockFallOnEventComponent")` on both builds gives 0 — this
component isn't EnTT to begin with, it's a separate structure called `BlockComponentStorage`).

In 2024 there's only one caller: inside `?checkFallDamage@Actor@@` (0x19acd00) (`+0x1a4`,
`0x19acea4`) and one more, `0x22b9c10` (name unconfirmed, also in `BlockLegacy::onFallOnBase`'s
caller list). `checkFallDamage` is **the same function** as `transformOnFall@FarmBlock`'s caller
from section 9 — i.e. a single fall-processing pass calls **both** `transformOnFall` (farmland
destruction, already solved) and `onFallOn` (PubSub event, unsolved). 1.26's own
`checkFallDamage` address doesn't exist yet either (finding `transformOnFall`'s caller with
`tools/callgraph.mjs` gives 0 — that call is through a virtual dispatch, so a direct-call scan
doesn't catch it, the same reason as sections 8/9).

**Blocked. Next steps (not tried):** (1) First check whether the PubSub framework itself even
exists in 1.26 — a string/vtable anchor on a name like `_loadDispatchTargets`. If it does,
`onFallOn` is likely still in this complex form, and an event hook can only catch the no-registration
default path (the branch that calls `BlockLegacy::onFallOnBase`), missing any block that has a
listener registered (if any). (2) If PubSub is gone and this was simplified, first find
`checkFallDamage`'s 1.26 address (since it's reached via a virtual slot, either check where
`checkFallDamage` is overridden in the `Actor`-family vtable, or catch the caller of
`transformOnFall@FarmBlock` from a stack trace during execution like a gdb-style method), and read
the code corresponding to `onFallOn`'s spot within it.

### 13.3 `pistonCheck` / `pistonMove` — no virtual slot, and the size fingerprint didn't catch it either

`_attachedBlockWalker` (2024 `0x22a89c0`, 1311B) and `_spawnMovingBlocks`
(2024 `0x22ae120`, 1147B) are members of `PistonBlockActor` with an **`AEAA` decoration = private,
non-virtual** — there's no slot for them in the `BlockType`/`BlockLegacy` virtual tables.
`??_7PistonBlockActor@@6B@` itself is unconfirmed in both builds (this class's vtable doesn't
exist in the merged table or in any candidates file), so the vtable couldn't be traced back even
from an already-standing candidate member like `getOwningPiston` — **this was tried**: searching
`.rdata`/`.data` for `?getOwningPiston@PistonBlockActor@@`'s VA (40 `0xa10c80`, a low-trust
candidate in `data/candidates-vftable-1.26.40.8.json`) as a pointer turns up **100+** unrelated
locations — meaning this address itself is a general-purpose function shared by multiple classes
via ICF, not a real `PistonBlockActor` vtable slot (which explains why this candidate was
low-trust to begin with).

**The caller route is also blocked.** In 2024, `_attachedBlockWalker` has a peculiar shape where
`_checkAttachedBlocks` (`0x22a95b0`, 1324B) and `_handleSlimeConnections`
(`0x22ab160`, 636B) **mutually recurse into each other.** Using `tools/callgraph.mjs`, 21 "pairs
of functions that call each other directly" (in the 500–2000B size range) were pulled from the
whole of 1.26.40.8, and the closest-size candidate (`0x9bbda0`/`0x9bc730`, 1304B/**649B** — nearly
matching 636B) and a second candidate (`0x3d5040`/`0x3d54c0`, 845B/**636B** — an exact match) were
checked by body. **Neither was it** — both are general-purpose algorithms merging/comparing two
sorted arrays (or vectors) (`xor`-based field comparison, length computed by pointer-range
subtraction), with no `BlockPos`/`BlockSource` virtual call or `isWithinHeightLimits`-style
piston-specific flow. Size fingerprinting alone doesn't filter this out of the vast pile of
template/STL-type functions in this binary (the remaining 19 candidates weren't all checked in
time).

`_spawnMovingBlocks`'s caller (2024 `?tick@PistonBlockActor@@UEAAXAEAVBlockSource@@@Z`,
`0x22bffc0`) is virtual, so it's only reachable via the `BlockActor::tick` slot, and that slot is
itself blocked since there's no concrete `PistonBlockActor` vtable.

**Blocked. Next steps (not tried):** (1) First obtain `??_7PistonBlockActor@@6B@` itself — a
`BlockActor`-derived instance that a piston attaches to can't be made with `summon` (it's a block
entity, not an entity), so the most direct route is `setblock ... piston` from the console
followed by a redstone signal, then reading the vptr of the object
`BlockSource::getBlockEntity` returns at that moment live, via something like
`tools/reach-probe-launcher.js` (the pattern in `findings-reach.md`; if
`world/level/block/actor/piston_block_actor.h` exists, the slot could also be counted from the
Endstone header — whether that header exists wasn't checked this session). (2) Once the vtable is
obtained, count the `tick` slot via the `BlockActor` family
(`endstone-slots.mjs --families=blockactor`) to get `PistonBlockActor::tick`, and read the direct
calls to the two functions in its body (low inline likelihood given they're 1000-byte-class
functions — section 9's lesson was "only thin forwarders get inlined"). (3) Finish checking the
remaining 19 candidates from the size-fingerprint scan (`0x4378b0`/`0x454dd0` = 1317/976, only
0.5% off from `_attachedBlockWalker`'s 1311, making it the leading next pick).

### Summary

**Neither an address nor a `derived()` was obtained for any of the four events** — only static
evidence accumulated. One common pattern: `onLightningHit`/`onProjectileHit` — "the wrapper got
inlined and the remaining virtual slot is a stub shared via ICF" — superficially resembles
`mayPlace` (section 10), but is actually a new failure mode where **a single-address hook can't
preserve the original meaning because it's a multi-implementation class (BlockType).** `onFallOn`
is an entirely different event system (PubSub), so the "forwarder inlining" pattern used so far
doesn't apply. The two piston functions are private members with no virtual slot at all, so the
vtable route doesn't work to begin with, and it was also confirmed that size-fingerprint matching
has weak filtering power at this binary's scale (2 checked, 2 false positives). Concrete next
steps for these four have been moved to `docs/next-steps.md` Q1-A item 4 for the next person.

## 14. `sculkShriek` shipped (dual string + immediate anchor), `chestPair`/`sculkSensorActivate` are blocked (2026-09-23, Q1-A 4)

All three names have a different shape from the four in section 13 -- not a thin 2-line forwarder,
but real logic weighing 671–790 bytes. `sculkShriek` survived out-of-line on both builds precisely
because of that size, while the other two are blocked because their bodies themselves have no
unique string to find as a text anchor (only data-symbol references throughout).

### 14.1 `?_shriek@SculkShriekerBlockActorInternal@@YAXAEAVBlockSource@@VBlockPos@@AEAVPlayer@@@Z` — shipped

Address: **40 `0x4610ac0` (1322B) / 51 `0x487af70` (1283B)**. 2024 is `0x22ad290`, 671B.

**Route 1 — dual string anchor.** The 2024 body fills a `CompoundTag` holding the warden's last
position via three keys, `"originX"`/`"originY"`/`"originZ"` (`??$_Construct@$00PEBD@...` three
times + `putInt` three times). These three literals appear **exactly once each in all three
builds' images** (confirmed with `buf.indexOf`). Using a RIP-relative modrm scan (mod=00,r/m=101)
like `tools/callgraph.mjs` to find every reference in `.text` toward those strings' VAs:
- 2024: 3 functions — `ParticlesBlockExplosionEvent::save` (1361B, unrelated),
  `SculkCatalystBlock::bloom` (425B, unrelated), `_shriek` (671B, the target).
- 1.26.40.8: 2 functions — `0x75c7890` (952B) and `0x4610ac0` (1322B). `bloom`'s originX
  reference has disappeared in 1.26 (either the code changed or it got inlined — not confirmed).
- 1.26.51.1: 2 functions — `0x8b431b0` (914B) and `0x487af70` (1283B).

**Route 2 — dual immediate-constant confirmation.** Deciding which of the two candidates is
`_shriek` needed more work, because 1.26 uses a different code pattern that copies the three
strings 4 bytes at a time via `movl` rather than `lea`. The event dispatch at the end of the 2024
body writes two immediates at exact positions: `movl $0x7f3,%edx` (right after building the
originX/Y/Z CompoundTag, apparently an event id) and `movl $0x16e,%r8d` (after the
`ActorDefinitionIdentifier` constructor, the actor type id for the warden summon attempt). Only
`0x4610ac0`/`0x487af70` had both immediates **at the same relative position**
(`0x75c7890`/`0x8b431b0` lack these two immediates — a different function, presumably `bloom`'s
successor or an unrelated NBT save function).

**Argument shape**: `tools/slot-shape.mjs`'s `shape()` answers `{args:"r8,rdx", ret:"call"}` for
all three binaries — `(BlockSource&, BlockPos, Player&)` unchanged, not modified. The dispatch at
the end also keeps the order `rcx=BlockSource, rdx=Player, r9=BlockPos, r8=&GameEvent` (2024 is
vft `+0xc8`/8=slot 25, 1.26 is `+0x1f0`/8=slot 62 — only the slot has drifted).

**Confirmed by execution on both builds** (2026-09-23, an `events.sculkShriek` listener in
`tools/block-probe.ts` installed only under `BLOCKEV2_PROBE=1` + `shriekprobe [cancel|allow|call]
[n]`, drivers `tools/host/drivers/shriek40.ps1` / `shriek51.ps1`,
`work/host-runs/shriek40-20260923-033209.txt`, `shriek51-20260923-033209.txt`): both builds
**tsc exit 0 + exit code 0 + `Quit correctly`**. `shriekprobe call` calls the exact address
(`proc[SHRIEK_FN]`) bdsx patched via the hook, directly, with
`(player.getDimensionBlockSource(), BlockPos(60,67,14), player)` — the same approach as section 9's
`farmprobe call`, a single command that touches address, prototype, event, and cancel route all at
once. First, with `shriekprobe cancel` set so the listener returns `CANCEL`, calling it shows the
**hook entering exactly once** (`#1 pos 60 67 14 | blockSource 0x...+CANCEL`, each build showing a
live `BlockSource` pointer and the connected bot itself ("bdsxprobe") as `entity`), but the
original body doesn't run (server normal). Then, after `shriekprobe allow`, calling it again shows
**the original body actually executing** — the real 723–1322 byte logic, warden summon attempt
included (CompoundTag broadcast, block state, GameEvent dispatch), finished without a crash on
either build (`#2 pos 60 67 14 ... entity bdsxprobe`, no CANCEL mark), and the server shut down
normally with `Quit correctly`. The `shrieks` counter incremented by exactly 1 both times (total
2), confirming the hook was neither duplicated nor missed. `sculkShriek` was added to
`data/events-fired.json` — the UNFIRED count Q2/section 13 use drops by one.

With execution added to the two static anchor routes (originX/Y/Z strings, 0x7f3/0x16e
immediates), this name is **shipped by address in `resolved-<v>.json`** (not `derived()` — the
function itself is a static free function with no corresponding class-member layout).

### 14.2 `?pairWith@ChestBlockActor@@QEAAXPEAV1@_N@Z` — blocked

2024 `0x20f4f80` (730B). `??_7ChestBlockActor@@6B@` (the primary vtable) exists as a live instance
**only on 51** (`0xa7863d0`, `data/candidates-instances-1.26.51.1.json`) — **40 has none**; what
40 has is only the container secondary vtable
`??_7ChestBlockActor@@6BRandomizableBlockActorContainerBase@@@` (`0xa6a06d0`), and that table
doesn't include `tick` (a `BlockActor` virtual that lives in the primary vtable).

**Both callers are difficult in their own right.** In 2024, `pairWith`'s only callers are
`?_tryToPairWith@ChestBlockActor@@` (0x20e8910, 1308B) and `?tick@ChestBlockActor@@UEAA...`
(0x20fc690, virtual). `_tryToPairWith` is a complex function mixed with PubSub event dispatch via
`BlockEventCoordinator::sendEvent`; the only notable data symbol it references
(`??_7?$_Ref_count_obj2@UUseModifiersItemComponentLegacyFactoryData@@@std@@6B@`) has a type-name
string that itself appears 3–7 times in each of the three builds' images (carried in a separate
name table even without RTTI), so it fails as a unique anchor. `pairWith`'s own body references no
strings at all (only AABB merging and `vector<ItemStack>` transfer — entirely STL template calls).

**Tried and abandoned**: getting the `tick` slot index from 1.26's primary vtable (51 only) —
`tools/endstone-slots.mjs --families=blockactor` only knows `BlockActor`'s destructor and classes
`tick` as `noSlot` (thin coverage on the Endstone header side) — there's no way to count the slot
number.

**Blocked. Next steps (not tried)**: (1) read 51's primary vtable (`0xa7863d0`) from a live
object directly (the `tools/reach-probe-launcher.js` pattern — place two chests adjacent from the
console to have them pair, then read the vptr of the object `BlockSource::getBlockEntity` returns
at that moment) to learn the `tick` slot. Once the slot is known, read the direct call to
`pairWith` inside its body (low inline likelihood at 730B — section 9's lesson), and carry 40's
side over via `work/derived40to51/pairs.json`. (2) First find `canPairWith`
(2024 `0x20ea2f0`, size unconfirmed) — it's `_tryToPairWith`'s first real call, so it might be
shorter and simpler.

### 14.3 `?setActivePhase@SculkSensorBlock@@SAXAEAVBlockSource@@AEBVBlockPos@@PEAVActor@@HH@Z` — blocked

2024 `0x229f630` (790B), a static free function. The only 2024 caller (`0x22ba1e5`) is caught in
`.pdata` as an independent 80-byte entry, but has no prologue (starts directly with
`movq %rbx,0x40(%rsp)`, no `push`/`sub rsp`) — it looks like an SEH chain fragment or an
exception-handling funclet belonging to a larger function, and calls
`getGameEventFrequency@VibrationListenerUtils@@` and `floor@Math@mce@@` (both `.pdata`-less leaves
— targets for `tools/leaf-funcs.mjs`) before calling `setActivePhase`. The real call site (the
proper function wrapping those 80 bytes) couldn't be found.

`setActivePhase`'s own body references no strings at all — everything it references is a data
symbol (`?SculkSensorPhase@VanillaStates@@3V?$BlockStateVariant@H@@B`,
`?sculkSensorTendrilsClicking@GameEventRegistry@@3VGameEvent@@B`,
`?AmethystBlock@VanillaBlockTypeIds@@3VHashedString@@B`,
`?TrailsAndTalesVersion@VanillaGameVersions@@3VBaseGameVersion@@B`,
`?DIRECTIONS@Facing@@2QBW4Name@1@B`). The `"sculk_sensor_phase"` string appears exactly once in
all three builds' images, but even in baseline its only xrefs are
`VanillaStates::`dynamic initializer for 'SculkSensorPhase''` (static initialization, unrelated)
and one lambda — not `setActivePhase`. In other words this string doesn't point to
`setActivePhase` (that function points at an already-constructed global `BlockStateVariant`
object, not the string).

**Blocked. Next steps (not tried)**: (1) first find `?getCircuitSystem@Dimension@@` or
`?setStrength@CircuitSystem@@` (both called inside setActivePhase, relatively distinctive names —
the redstone circuit system), and narrow down via caller intersection. (2) find
`??$setState@W4Name@Facing@@@Block@@...` (the template function setActivePhase and `_shriek`
share, 2024 `0x25a110`) inside `_shriek`'s 1.26 address (see the previous section) and check
whether `setActivePhase` falls into that caller intersection — but re-reading `_shriek`'s body,
confirmed in 14.1, the `setState` call may have been inlined before the CompoundTag block
(not statically confirmed) — for this route to work, first confirm the call still exists
out-of-line.

### Summary

`sculkShriek`'s address was obtained via a dual string + immediate anchor, and execution on both
builds finished as well. `chestPair`/`sculkSensorActivate` couldn't be found by this session's
method because their bodies reference only data symbols (no string anchor) — both remain in the
queue with neither an address nor a `derived()`, the same as the four in section 13.

## 15. Live vtable capture -- ChestBlockActor's label was just wrong, PistonBlockActor was newly captured on 40 (2026-09-23, agent-z, Q1-A 4)

**Established from static evidence alone (host not needed).** In baseline (1.21.3.01), a
suffix-less `??_7ChestBlockActor@@6B@` doesn't exist at all (exhaustively confirmed against
`data/baseline-symbols.json`) -- ChestBlockActor only has the two suffixed vtables
RandomizableBlockActorContainerBase (51 slots) and FillingContainer (46 slots) (since it's a
multiple-inheritance structure that only inherits `BlockActor` through the
RandomizableBlockActorContainerBase mixin, MSVC also attaches a suffix to the offset-0 side).
Section 14's note that "only 51 has it, 40 doesn't" was a labeling error: 51.1's
`??_7ChestBlockActor@@6B@` (175662032) in `data/candidates-instances-1.26.51.1.json` was a name
that doesn't exist, and it was **structurally identical to** 40's
`??_7ChestBlockActor@@6BRandomizableBlockActorContainerBase@@@` (0xa6a06d0) — obtained by the
**exact same method** (`IConstBlockSource::getBlockEntity` slot 3, chest position) (35 slots, 2
refs -- checked against `work/vft/scan-1.26.51.1.json`). The name was fixed to match 40 --
**this isn't a new capture, it's a label correction on something both builds already had from the
09-17/18 sessions.**

**`tick` is slot 7 for both classes (and BlockActor, CampfireBlockActor) in baseline.**
In `work/vft/baseline-slots.json`'s `??_7BlockActor@@6B@` (43 slots), the index of
`?tick@BlockActor@@UEAAXAEAVBlockSource@@@Z` is 7, and the same index points to `tick` unchanged
across all three derived classes: `??_7CampfireBlockActor@@6B@`,
`??_7ChestBlockActor@@6BRandomizableBlockActorContainerBase@@@`, and
`??_7PistonBlockActor@@6B@` (baseline, no suffix, 43 slots -- single inheritance, so it has no
virtuals of its own).

**PistonBlockActor was captured live on 40.** `??_7PistonBlockActor@@6B@`: **40 `0xa764eb0`
(175525552), 27 slots, refs 2** -- exactly BlockActor's shrunk 27 slots (same pattern as
Campfire/Chest since it has no virtuals of its own). Capture method: `Actor::teleportTo` (rcx,
triggered via the `tp @a` command) +0x1c8 (`WeakRef<Dimension>`) → slot 12
(`getBlockSourceFromMainChunkSource`) → BlockSource → slot 3 (`getBlockEntity`) → the BlockActor
at the piston position (35,68,20). Chest was also reconfirmed in the same run (0xa6a06d0, 35
slots), backing up the label correction above. `work/host-runs/piston40-20260923-090323.txt`.

Entered as `??_7PistonBlockActor@@6B@` into `data/candidates-instances-1.26.40.8.json`'s
`vftables` (merge/make-table regenerated, also reflected in
`data/symbols-1.26.40.8.json`).

**The slot-7 hypothesis broke immediately.** Reading 40's new 27-slot table's slot 7
(`0x46205a0`) with `disas-exact` gives `movb $1,0x68(%rcx); retq` (4 bytes, int3 padding) -- not a
`tick` that takes a `BlockSource&` argument and does something, but one of a run of small setters
folded together by ICF, 16 bytes apart. **It's certain 1.26 removed something before slot 7 when
it shrank BlockActor from 43 to 27** -- baseline's order-preservation assumption doesn't hold for
1.26. Scanning all 27 slots from the start to find the real `tick` (a `BlockSource&` argument,
a large body) is the next step, and wasn't done this session.

**PistonBlockActor was not captured on 1.26.51.1 -- not a method problem, a bot-connection
failure.** The first attempt (via `Player::respawn`+0x1c8) failed on 51 throughout the entire
sweep (tick 200–2500, ~2 minutes) with `Access Violation: 0x6E696D696C6572B0` (trying to read
garbage string data as a vtable) -- retried with the route already verified on 40
(`Actor::teleportTo`+0x1c8, the original method from `findings-reach.md`), but this time **the bot
disconnected 5 seconds after connecting** (`Player disconnected` 00:03:52, `Player connected`
00:03:47), so the `tp` command itself never fired (only `Level` was captured, staying at 1 object
all the way to tick 2500). The retry budget (one attempt after static preparation) was spent and
the session had to finish within its time (20 minutes total), so a third attempt wasn't made.
`work/host-runs/piston51-20260923-090323.txt`.

### What remains (for the next person)

1. **Capture PistonBlockActor on 1.26.51.1.** The method is verified on 40
   (`teleportTo`+0x1c8 → slot 12 → slot 3,
   `work/vft/rp-calls-piston-1.26.51.1.json`/`rp-config-1.26.51.1.json` already exist --
   uncommitted since they're under `work/`, so regenerate: `cp
   work/vft/instance-config-1.26.51.1.json work/vft/rp-config-1.26.51.1.json` and fill in
   slotCount — see this section's Python snippet). The root cause of 51's early bot disconnect is
   undetermined -- needs a look at whether the `probe-client.cjs`/`BP_VERSION=1.26.45`/
   `BP_PROTOCOL=2193` combination was only unstable this session. Driver is
   `tools/host/drivers/piston51.ps1` (committed).
2. **Find 1.26.40.8's real `tick` slot among the 27.** It isn't slot 7 (confirmed above). To
   narrow candidates: disas, as a priority, any slot that takes a single `BlockSource&` argument
   (unlike the other slots in the 27, which don't actually use their argument) and whose body is
   200+ bytes. Once found, read the direct calls to `_attachedBlockWalker`/`_spawnMovingBlocks`
   inside it (low inline likelihood at 1000-byte class, section 13.3) to get hook-target
   candidates for `pistonCheck`/`pistonMove` -- this was this item's original goal but wasn't
   reached in time.
3. **`chestPair` (`ChestBlockActor::pairWith`)**: now that both builds have the interposed
   ChestBlockActor table (35 slots), first find the `tick` slot based on the 27-slot BlockActor
   table above (shared work with item 2), then read that same index from the 35-slot chest table
   and find the direct call to `pairWith` (730B, low inline likelihood) in its body.
4. **`sculkSensorActivate` (`SculkSensorBlock::setActivePhase`)**: unrelated to this section's
   capture method -- `SculkSensorBlock` is a `BlockLegacy` derivative (not BlockActor) and is
   already in both builds' tables (`??_7SculkSensorBlock@@6B@`, 40/51). `setActivePhase` is a
   static free function, so it can't be caught via the vtable -- section 14.3's caller
   intersection route (`getCircuitSystem@Dimension@@`/`setStrength@CircuitSystem@@`) is the only
   remaining option and wasn't touched this session.

## 16. `pistonCheck` / `pistonMove` — done on both builds; `tick` was never in the primary vftable (2026-09-24, Q1-A-2)

**Why section 15's slot sweep could not work.** Endstone's `windows.h` for each build names
`?tick@PistonBlockActor@@UEAAXAEAVBlockSource@@@Z` (40 `0x5ee4f50`, 51 `0x4872840`), and its
`piston_block_actor.cpp` calls the original through `IVanillaTickBlockActorComponent::tick`: in 1.26
`tick` is a member of one of the three `IVanilla*` interfaces the `BlockActor` base took on (section 12 of
`findings-inventory.md`), so it sits in that interface's vftable, not among the 27 primary slots. The 27
slots read statically are dtor, load (1757 B), save (2710 B), saveItemInstanceData, a run of ICF stubs,
`onRemoved` (slot 10, 113 B: sets `new_state_`, then tail-calls `_spawnBlocks` unless client-side) and
`_onUpdatePacket` (slot 19, 377 B). **Rule: for a 1.26 `BlockActor` virtual, check Endstone's
`windows.h` and the `IVanilla*` interfaces before sweeping the primary table.**

**Hook targets, from tick's direct calls.** Laid next to 2024's tick (`0x22bffc0`), the 1.26 tick calls
the same private members the same number of times, and each body reads the 2024 fields at one constant
shift (40: +0x20, 51: +0x28), so the map is two-route (structure + field offsets):

| 2024 | 1.26.40.8 | 1.26.51.1 | how it was told apart |
|---|---|---|---|
| `getFacingDir` (84 B) | `0x5ee0530` (308 B) | `0x486dad0` (308 B) | `getBlock(this+8)`, facing state read inline, returns `&table[facing*12]`; callers read three ints |
| `_checkAttachedBlocks` | `0x5ee69f0` | `0x4874370` | clears `attached_blocks_`/`break_blocks_`, calls the walker, then `count <= 12` — 2024 `0x22a96cf` exactly |
| `_attachedBlockWalker` | `0x5ee8050` | `0x48759c0` | the call above: `(this, region, &pos, facing r9b, byte on stack)`, returns `r13b`; opens with "already attached → true" like 2024 |
| `_spawnMovingBlocks` | `0x5ee6e70` (1461 B) | `0x48747c0` (1461 B) | second of each tick pair; `getFacingDir`, sort of `attached_blocks_`, reserve from `break_blocks_` |
| `_spawnBlocks` | `0x5ee7470` | `0x4874dc0` | the only callee of `onRemoved` (2024 too); tick ×2 |
| `_spawnMovingBlock` / `_sortAttachedBlocks` | `0x5ee4110` / `0x5eec280` | `0x48719d0` / (inlined into a `0x4896a00` call) | callers match 2024's; not shipped |

`tools/callgraph.mjs` found no self-call in the 40 walker, but execution shows it recursing once per
attached block (the event's list grows by one per call), as 2024's did — the recursive call is not a
plain `E8` the scanner sees. The walker-pair size scan of section 13.3 had no chance: the pair is one
function now.

**Fields** (`layouts.PistonBlockActor`, `engine/piston.ts`): `state` (bdsx's `action`; 2024 +0xd7) =
40 `0xf7` / 51 `0xff`, read by `_onUpdatePacket` before and after the update; `attachedBlocks` (what
`getAttachedBlocks`, a 2024 ICF leaf, returned) = 40 `0x100` / 51 `0x108`. Endstone HEAD's comment
`sticky_ // +216` does not match 51, which reads sticky at `0xf0`; the binary wins. 51 also got the
`getPosition@BlockActor` accessor 40 already had (`lea this+8`, from the same bodies).

**bdsx change** (revival): `bds/engine/piston.ts` (the two layouts and the `attached_blocks_` copy);
`PistonBlockActor.action` at `PISTON_STATE`; `getAttachedBlocks` is a `derived()` over it. The event code in
`event_impl/blockevent.ts` is unchanged. **Semantics, observed**: `pistonCheck.blockPos` is the walker's
argument (the block being examined, one in front of the piston), not the piston; `action` there is
`state_` at that moment — still Retracted (0) while an extension is checked, Retracting (3) on a sticky
retract; `pistonMove` carries Extend (1) / Retract (3). A cancelled check fires every tick while powered.

**Execution** (`pistonev40`/`pistonev51`, `tools/block-probe.ts` `pistonprobe`, `PISTON_PROBE=1`; tsc 0,
exit 0, `Quit correctly`; 6/6 PASS on each build): sticky piston facing up at (44,68,20) with a stone on
top, powered from the side. With the listener returning `CANCEL`, 78–79 checks at (44,69,20) and **the
stone stayed** (0 moves); after `allow` the stone went to y=70, `pistonMove` had action 1, attached
`[44 69 20]`, facing `0 1 0`, and the head read back as `sticky_piston_arm_collision`; on unpowering, checks
with action 3, `pistonMove` action 3 with `[44 70 20]`, and the stone back at y=69. inst40's world had a
powered down-facing piston left at (35,68,20) by the section 15 capture; the driver now removes it.
`work/host-runs/pistonev{40,51}-20260924-001103.txt`.

**What this opens for `chestPair`**: the same move — Endstone's `windows.h` (or the `IVanilla*` tick
interface) for `ChestBlockActor::tick`, then its direct call to `pairWith` — replaces section 15's
"find the tick slot in the 35-slot table".

## 17. `chestPair` — done on both builds; placement pairing got half-inlined, and `getBlockEntity` was wrong on 40 (2026-09-24, Q1-A-2)

**Finding the chest's tick without Endstone.** Endstone names no chest function, but the constructor of any
`VanillaBlockActor` stores all four vptrs, so the tick table is whichever one it writes at the
`IVanillaTickBlockActorComponent` offset (piston, 40: primary +0, Main +0x28, Render +0x30, Tick +0x38; 51
is 8 further out). Chest: 40 `0xa6a0950` → tick `0x29136b0`; 51 `0xa784260` → tick `0x1f31770`. All 36
tick tables share slots 0–3 and 5 (adjustor thunks), which is also a quick way to list them.

**Addresses (two routes each: 2024's call pattern, and the body's fields at a constant shift):**

| name | 1.26.40.8 | 1.26.51.1 | note |
|---|---|---|---|
| `bdsx:ChestBlockActor::pairWith` | `0x2915bc0` | `0x1f33950` | **prototype changed**: `(other, BlockSource& region, bool lead)` — the region went in before 2024's bool; exact new decoration unknowable, so a `bdsx:` key |
| `?_tryToPairWith@ChestBlockActor@@…` | `0x29152f0` | `0x1f32fe0` | 2024 prototype; the only non-tick caller of `pairWith`, called from `onPlace` |
| `?canPairWith@ChestBlockActor@@…` | `0x2914550` | `0x1f326d0` | 2024 prototype; type byte == 2 and same y (2024 +0x50/+0x30 → +0x14/+0xc) |
| `?getBlockEntity@BlockSource@@UEBAPEBV…` | `0x14f6450` | `0x15f67d0` | `IConstBlockSource` slot 3 (Endstone order, slot 2 = the shipped `getBlock`) |

`pairWith` stores exactly 2024's fields +0x58 on 40 (partner `0x2a0`→`0x2f8`, its position `0x2a8`→`0x300`,
lead bit `0x27c`→`0x2d4`), +0x60 on 51. That is also all `isLargeChest` (partner != null) and
`getPairedChestPosition` (&position) ever read, so both are `derived()` over `layouts.ChestBlockActor`
(`bds/engine/chest.ts`).

**The shipped 40 `getBlockEntity` (`0xba6b00`, propagation) was wrong.** `findings-reach.md` had already seen it
return null at a chest; its body is a hash-map `find` keyed by a 4-byte chunk-local position — the helper 51's
real `getBlockEntity` calls after `getChunkAt(pos)` (chunk + 0x1390). Retracted; bdsx now binds the 1.26
virtual. Rule 4 again: a refuted name stayed in the table because the refutation never reached `retracted`.

**The placement path is half-inlined, which broke cancel.** 2024's `_tryToPairWith` called `pairWith` twice
(this→other not lead, then other→this lead). 1.26 writes the first half inline and calls `pairWith` once. With
only the `pairWith` hook, the first run on both builds showed one event per placement and, when cancelled, a
**half-paired** state: the new chest pointed at its neighbour, the neighbour did not, and the tick then retried
`pairWith` for both halves every tick (321 cancelled events in 16 s). So bdsx now also hooks `_tryToPairWith`:
when the engine would pair (self unpaired, a block actor at pos, `canPairWith` true) it fires the event for both
halves first and skips the original on `CANCEL`; the `pairWith` call inside is passed through without a second
event. The tick's `pairWith` path (a saved paired chest loading) still fires per half.

**Execution** (`chestev40`/`chestev51`, `tools/block-probe.ts` `chestprobe`, `CHEST_PROBE=1`; tsc 0, exit 0,
`Quit correctly`; 5/5 PASS on each build): `getBlockEntity` at the stone floor → null; two chests set side by
side while cancelling → one cancelled event, **both chests single**, still single 8 s later; two more allowed →
events lead false then true, both `isLargeChest`, each `getPairedChestPosition` = the other. Events recorded
before `cancel` are the previous session's chests re-paired by the tick at world load (lead true). One 51 run
died before its first console command with no fault capture, the bot closing at 15.4 s — the Q8 pattern; the
rerun passed (logs in `work/host-runs/q8/`).

## 18. `sculkSensorActivate` — done on both builds, through the vibration config's vftable (2026-09-24, Q1-A-2)

Section 14.3's caller-intersection plan was not needed. `setActivePhase`'s only 2024 caller is the virtual
`SculkSensorVibrationConfig::onSignalReceive` (slot 1 of a 6-slot table the calibrated sensor's config
shares, each overriding only slot 3 `shouldListen`); 14.3's "80-byte fragment with no prologue" was that
function's chained unwind entry. In 1.26 the same pair of tables is what the sensor block actor's constructor
stores into the config it allocates (40 `0x29070e0`: `0xa7134a0` then `0xa69fa90`; 51 `0xa840680`/`0xa7857a0`,
slot 5 being the new `canReceiveOnlyIfAdjacentChunksAreTicking` leaf 51 already named).

| | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `onSignalReceive` (slot 1, 155 B) | `0x4610750` | `0x487abf0` |
| `SculkSensorBlock::isActive` (294 B) | `0x75c95e0` | `0x8b44ee0` |
| **`setActivePhase`** (3149 B; 2024 790 B) | **`0x75c9c40`** | **`0x8b45560`** |

`onSignalReceive` is 2024's instruction for instruction: `isActive(region, this+8)`, and when inactive power =
max(1, 15 − floor(distance/range·15)), `getGameEventFrequency(event)`, then `setActivePhase(region, pos, actor,
power, frequency)`. The callee reads rcx/rdx/r8/r9d and its stack argument once, identically on both builds —
the 2024 prototype and decoration hold, so bdsx's hook is unchanged. 51 was found by shape alone: the only
155-byte function in the image calling a 294-byte and a 3149-byte function.

**Execution** (`sculkev40`/`sculkev51`, `tools/block-probe.ts` `sculkprobe`, `SCULK_PROBE=1`; tsc 0, exit 0,
`Quit correctly`; 2/2 PASS each): a sensor set at (56,68,20) hears a summoned pig and blocks set beside it.
Cancelled (15–26 events, entity = the pig): `sculk_sensor_phase` — the sensor block's aux value, `Block+288` —
stays 0 at +2 and +10 ticks. Allowed: 1 (active) at +2 ticks, later 2 (cooldown). The world also holds an older
sensor at (33,68,20) that fires for a wandering ocelot; the checks count only the probe's sensor.

## 19. `fallOnBlock` — done on both builds; `Block::onFallOn` is inlined, the hook moved to `onFallOnBase` (2026-09-24, Q1-A-2)

**Reaching `checkFallDamage` from a string.** 2024's `Actor::checkFallDamage` is non-virtual and called only by
two ECS systems. The image holds `"CheckFallDamageSystem"` once; the function that references it allocates the
system (vftable 40 `0xa77a3e0` / 51 `0xa928d80`), whose `singleTick` (slot 6) calls a 202-byte
`CheckFallDamageSystemImpl::checkFallDamage` that tail-jumps to **`Actor::checkFallDamage`: 40 `0xdf5e50` /
51 `0xd35a40`, 2176 bytes on both builds** (2024 420 B plus a fragment). This is the route for any ECS system
whose name is a string.

**`Block::onFallOn` no longer exists as a function.** Inside `checkFallDamage` it is written out: a
`BlockEvents::BlockEntityFallOnEvent` (1.26's name for 2024's `BlockFallOnEvent`; the image's
`BlockEventExecutor<BlockEntityFallOnEvent>::subscribe<…>` lambda scopes name its subscribers: bed, hay, honey,
slime, powder snow, pointed dripstone, end portal, moving block, wall foliage, data-driven and script
components) is built on the stack — BlockPos +8, region +0x18, actor +0x20, fall distance +0x28 — the block
type's executor at +0x338 is asked for subscribers, and without one **`onFallOnBase`** (40 `0x1eef370` / 51
`0x1a27fc0`, 227 B, identical) gets `(blockType, &event)`; then `transformOnFall` (slot 51). `onFallOnBase` reads
the same four fields and is 2024's body (`isType(actor, 0x42)`, `ActorDamageSource` cause 5, fall damage,
`postGameEvent`); on 40 its other callers are eight small subscriber functions, as in 2024 where hay, bed, slime,
end portal, dripstone, moving block and turtle egg all chain to the base.

**bdsx change**: `fallOnBlock` (not cancellable) now hooks `bdsx:BlockType::onFallOnBase` (the class became
`BlockType` and the event was renamed, so no knowable decoration) and reads the event through
`layouts.BlockEntityFallOnEvent` (`bds/engine/fallon.ts`); `block` is `region.getBlock(pos)`. **Semantics,
observed**: `height` is what reaches the base — the raw fall for a plain block, 20% for a hay bale (its
subscriber shortens the event's distance first), 0 for slime (every bounce fires) — and a block whose subscriber
does not chain to the base (honey; by the 2024 list also powder snow) fires nothing. 2024's hook saw the raw
distance on every block.

**Execution** (`fallev40`/`fallev51`, `tools/block-probe.ts` `fallprobe`, `FALLON_PROBE=1`; tsc 0, exit 0,
`Quit correctly`; 4/4 PASS each): pigs summoned ten blocks up over (62..68, 67, 30) — stone 9.67, hay 1.93,
slime 0 (22–37 events), honey no event; the entity resolved as the pig, block names read back.

## 20. `campfireLight` / `campfireDouse` — done on both builds (2026-09-24)

Both static functions keep their 2024 prototypes and are found through `CampfireBlock`'s virtuals, which the vftable
walk already named on both builds. `entityInside` (40 `0x1f02040` / 51 `0x1a3ac50`) and `FlintAndSteelItem::dispense`
(51 `0x1a7a660`) both call **`tryLightFire`: 40 `0x1f01550` / 51 `0x1a3a160`** (985 B on both; 2024 441 B, with the
same callers); `neighborChanged` (40 `0x1f028d0` / 51 `0x1a3b500`) calls **`tryDouseFire`: 40 `0x1f01970` / 51
`0x1a3a580`** (1104 B; 2024 527 B), whose other callers are a 294-byte helper beside the thrown-potion code and a
2 KB function the size of `CampfireBlock::use`. `tryDouseFire` saves `r9d` — the trailing bool — and **bdsx's hook had
left that parameter out**, so the original ran with whatever `r9` held; fixed.

**Execution** (`cf40`/`cf51`, `cfprobe`, `CAMPFIRE_PROBE=1`; tsc 0, exit 0, `Quit correctly`; 4/4 PASS each and every
`testforblock` succeeding): a dispenser holding flint and steel, powered by a redstone block, lights the unlit campfire
in front — cancelled it stays unlit, allowed it lights; water placed on a lit campfire douses it through
`neighborChanged` — cancelled it stays lit, allowed it goes out. A summoned water splash potion did not reach
`tryDouseFire` (the allowed campfire stayed lit); that path was not pursued.

## 21. `projectileHitBlock` / `lightningHitBlock` — raised from the callers, done on both builds (2026-09-24)

The user chose route 1 of section 13.1: raise both events where the engine calls the block, since the forwarders are
inlined and the default virtual is an ICF-shared no-op. The 2024 bodies were read first; both callers kept their
structure in 1.26 (`tools/disas-exact.mjs`):

- **`ProjectileComponent::onHit`** (40 `0x1ae16e0` / 51 `0x23fe9f0`, already shipped for `projectileHit`) copies
  the `HitResult` into the component (+0x70), passes the engine's `ProjectileHitEvent` gate, then takes the
  dimension's `BlockSource` (Actor+0x1c8, slot 0x60), `getBlock`s the `BlockPos` at **HitResult+0x20**, and calls
  **`BlockLegacy` slot 15 (`0x78`)** with (BlockSource\*, BlockPos\*, projectile) — 40 `0x1ae1a80`, 51 `0x23fed90`.
  2024 (`0x5e860c`) is the same sequence through `Block::onProjectileHit`, with the same +0x20. Slot 15 is the
  estimate of section 13.1, now read. The call does not depend on the hit type, so an entity hit also reaches the
  block at `block_`, in 2024 and 1.26 alike.
- **`LightningBolt::normalTick`** (40 `0x2d2caf0` / 51 `0x2f97f10`) floors the position at Actor+0x218 into a
  `BlockPos`, compares **`life` (+0x3b4 on both builds; 2024 +0x44c) with 2**, plays the two thunder sounds, checks
  the level (2024: `isClientSide`), then calls **`BlockLegacy` slot 16 (`0x80`)** with (BlockSource\*, BlockPos\*)
  — the inlined `Block::onLightningHit`, as 2024's `0x1a3fa5f`.

bdsx (`bds/engine/blockhit.ts`, `event_impl/blockevent.ts`): when the table has no `Block::onX`, the installer takes
the caller route instead. `projectileHitBlock` listens to `projectileHit` (one `onHit` hook for both) and reads the
block at `HitResult.block`; it therefore fires at `onHit`'s entry, before the engine's own gate rather than after it.
`lightningHitBlock` hooks `normalTick` and fires when `life == 2`, before the original strikes. Both hooks are
installed only when a listener registers, and `normalTick` runs only while a bolt exists, so the per-tick hook
costs nothing on a world without lightning. New layouts `HitResult.block` = 0x20 and `LightningBolt.life` = 0x3b4
(`candidates-instances-<v>.json`); `normalTick` is promoted to `data/resolved-<v>.json` (vftable walk +
pairs-in-tables, + the 40→51 carry on 51, body read, execution). `tools/event-coverage.mjs` now follows an installer
that listens to another event (`events.X.on(`) to that event's targets.

**Execution** (`bh40`/`bh51`, `bhprobe`, `BHIT_PROBE=1`; tsc 0, exit 0, `Quit correctly`, 4/4 PASS each, run twice
— before and after the installer was restructured): an arrow summoned above a gold block falls and fires
`projectileHitBlock` with `gold_block 44 66 21 by minecraft:arrow`; `summon lightning_bolt 48 67 21` onto a lightning
rod fires `lightningHitBlock` with `lightning_rod 48 67 21`, and `summon lightning_bolt 46.7 67.2 21.9` with
`air 46 67 21` (the floor). Two bolts, exactly two lightning events.

Not checked: the event on an arrow that hits an entity (it fires by construction, with whatever block is at
`block_`), a projectile the engine's gate cancels (nothing in these worlds cancels it), and the rod's own reaction
(its `powered_bit`) as a second witness that the engine struck the same block on the same tick.

## Ticking areas: the API gets an entry point and its two tables (2026-09-27)

Queue row "Single missing addresses" (A1). `bds/tickingarea.ts` bound `ITickingArea.isRemoved`/`getView`,
`ITickingAreaView.getAvailableChunk` (all via `jsv` on `??_7TickingArea@@6B@` / `??_7TickingAreaView@@6B@`) and
`TickingAreaList.getAreas`. None of them had an address on either build. Nothing in bdsx handed out a `TickingAreaList`,
and no module imported `tickingarea.ts`.

**The entry point.**
- 2024 `Dimension::getTickingAreas` (`0x1f4b120`) is `mov 0x2d8(%rcx),%rax`. Its callers include `ServerPlayer::moveView`,
  which walks `getAreas()` (`0xcae00`, `lea 8(%rcx)`) and calls slot 7 (`getBounds`) on each area.
- 1.26 `moveView` (a table name: 40 `0x68b4e0` / 51 `0x74e9d0`) does the same inline. It takes the dimension from
  `Actor+0x1c8`, loads `mov 0x300(%dim)`, walks `+8`..`+0x10` with a 0x10 stride, and calls slot 7. That holds on both
  builds.
- Shipped: `layouts.Dimension.tickingAreas` (0x300) and `layouts.TickingAreaListBase.areas` (8).
- `Dimension.getTickingAreas()` is new in bdsx's API, and `getAreas()` is `derived()` over the two layouts.

**The tables.**
- 2024 `??_7TickingArea@@6B@` (`0x2e512e0`, 27 slots) has these leaves:
  - `entityHasBeenFound` at 21 (`movzbl 0x45`);
  - `setEntityFound` at 22 (`movb $1,0x45`);
  - `isRemoved` at 23 (`movzbl 0x47`);
  - `getView` twice, at 10 and 11 (`lea 0x270`).
- A scan of each 1.26 `.rdata` for a table with slot 23 = `movzbl 0x57(%rcx),%eax; ret`, slot 21 = `movzbl 0x55`, and
  slot 10 = slot 11 found exactly one table per build: 40 **`0xa711970`**, 51 **`0xa87c2e0`**, 30 slots each.
  - `isRemoved`: 40 `0x458c610` / 51 `0x58220f0`.
  - `getView`: `lea 0x238(%rcx)`, at 40 `0x458c5e0` / 51 `0x58220c0`.
- The table's constructor (40 `0x4580830` / 51 `0x581ea10`) is called only by the pending-area processor, as 2024's
  `_processAdds` called `??0TickingArea`. It builds two `ChunkViewSource`s. It calls a function on `this+0x238`
  (40 `0x4580d30` / 51 `0x2fe8980`) that stores the view's table: 40 **`0xa711a60`**, 51 **`0xa7eefe0`**. That table
  has 13 slots, as in 2024.
- Slot 12 of the view's table (40 `0x4585ba0` / 51 `0x2fea630`) is 2024's `getAvailableChunk`. Its signature is
  `(this, shared_ptr<LevelChunk>* sret, ChunkPos const&)`: the chunk source at +8 is asked through its slot 3, and the
  chunk is returned only if its state byte (+0xf0) is at least 0xd (40) / 0xb (51).
- The five names ship under their 2024 decorations, and the bindings in `tickingarea.ts` are unchanged.

bdsx `f05be5b8`.

**Executed, both builds** (`ta40`/`ta51`, `verify-pair.mjs`, `tools/actor-layout-probe.ts` `taprobe`, 4 PASS / 0
FAIL each, tsc 0, exit 0 + `Quit correctly`; `work/host-runs/ta40-20260927-195123.txt`, `ta51-...`):
- The overworld's list held 0 areas.
- After `tickingarea add 0 0 0 15 0 15 bdsxta`, BDS printed "1/10 ticking areas in use" and the list held 1.
- Through the new tables, the area answered `isRemoved` false. Its view returned chunk (0,0) and nothing for
  (1000,1000).
- Right after `tickingarea remove bdsxta` (run from the probe), the same object was still in the list and answered
  `isRemoved` **true**. 8 s later the list was back to 0. So both sides of `isRemoved` were seen.
- The driver removes the area again at the end, which BDS rejects as already gone, so the shared world keeps nothing.

## The block type registry on 1.26: `Block.create` and `Command.Block` (2026-09-27)

Queue row "`Command.Block` and `Block.create`" (A1; `findings-scoreboard.md` 11.6). `Block.create(name, data)` needs
2024's `BlockTypeRegistry::lookupByName(HashedString const&, bool)` → `WeakPtr<BlockLegacy>` (`0x2043c30`), a static
around `_lookupByNameImpl(name, data, resolve, bool)` (`0x202c970`) whose 16-byte result is
{ `WeakPtr<const BlockLegacy>` +0, `const Block*` +8 }. None of it had an address, and the cross-build one was retracted.

**Found from `setblock`.** The string `commands.setblock.success` has one `lea` user per build (40 `0x3c635c0`, 51
`0x3b2ead0`: `SetBlockCommand::execute`). It resolves its block parameter (`this+0x30`) like 2024's `0x1731e10`: with a
non-empty state list through one function, else through `resolveBlock(int data)` (40 `0x12e30c0`, 51 `0x1205860`). That
function is 2024's `0xcd03d0` step for step: `getBlockNameFromNameHash`, `isComplexAliasBlock`, then the lookup and
`tryGetStateFromLegacyData` (the shipped 40 `0x1ee8230` / 51 `0x1a21750`). One difference from 2024: every registry
function gets `this` = a `lea` of one global. That global is the registry object: 40 `0xc95fe38`, 51 `0xccb0608`.
- The global is referenced from 775 functions on 40. ServerLevel's block-type walk (40 ILevel slot 314 `0x743d50`, 51
  `0x7da8d0`) passes it to `forEachBlockType`. On 40 that is Endstone v0.11.7's exact
  `?forEachBlockType@BlockTypeRegistry@@QEBA...` (`0x284d260`), a `QEBA` member. The registry's first member is 2024's
  `mBlockLookupMap`: the 51 impl walks `(this)->_Myhead->_Parent` where 2024 walked the static map.
- `_lookupByNameImpl` is now a member: `(this, sret, HashedString const& name, int data, LookupByNameImplResolve
  resolve, bool)`, with `resolve` compared to 1 at the fifth-argument slot (40 `0x1d0(%rbp)`, 51 `0x190(%rbp)`). The
  trailing bool is never read on either build. 40 still has the out-of-line `lookupByName` (`0x284b850`, 2024's
  `0x2043c30` around the impl, data 0 / resolve 0). 51 has none: every caller inlines it.
- **The result changed between the builds.** On 40, +0 is 2024's `WeakPtr`, a counter block { `T*` +0, strong +8,
  weak +0xc }. `lookupByName` takes `lock incl 0xc` on it, `resolveBlock` dereferences it, and a miss is `WeakPtr::null()`
  (`0xc93bb60`) with a weak ref taken. On 51, +0 is the map node's plain `const BlockType*` (`movq 0x50(%r15)`, no counter
  touched). `resolveBlock` passes it straight to `tryGetStateFromLegacyData`, `0x11d9fd0` compares it with `Block+0x68`,
  and an empty name gives both members zero. Calling 51's result as a `WeakPtr` would have dereferenced the `BlockType`'s
  vftable as the object.

**What ships.** `bdsx:BlockTypeRegistry::instance` and `bdsx:BlockTypeRegistry::_lookupByNameImpl` on both builds, and
`layouts.BlockTypeRegistry.lookupResultIsWeakPtr` (1 on 40, 0 on 51). `engine/blocktype.ts` calls the impl with data 0
and resolve 0, then returns the block type. On 40 it gives the weak ref back. `lookupByName` (the 2024 name) is
`derived()` over it. `Block.create` is 2024's logic without the `WeakPtr`. The item id is read only for data `0x7fff`,
which asks for the default state; any other data goes to `tryGetStateFromLegacyData`.
- `HashedString(std::string const&)` is `derived()`: construct, then `set`. 2024's `0x2784e00` stores exactly that: hash 0,
  string copy, last match null, FNV-1 hash. The layout is unchanged in 1.26 (Endstone `string_hash.h`).
- `BlockLegacy::getBlockItemId` is `derived()` over `layouts.BlockLegacy.id` = 382 (`0x17e`, 2024 `0x1a6`): below 0x100
  as is, else `0xff - id` as int16. Endstone `block_type.h` puts `id_` at +382. The binary inlines the formula in the
  branchless form `movzwl 0x17e(reg); mov $0xff; sub; cmovae` (40: 49 sites, 51: 45).
- The engine prefixes a bare name with `minecraft:` itself (the impl builds `"minecraft:" + name` and a HashedString
  from it), so `Command.Block`'s token (`stone`) is looked up as it is.

**Execution, 2026-09-27** (`tools/softenum-probe.ts` `seprobe blocks`, `seprobeblock`, customcommand `jjj`):
- Run 1 (`btype40/51`) failed. The first derived constructor ran `set` on memory that `new HashedString(true)` had only
  allocated. The string's garbage capacity made `setCxxString` fault (`Access Violation` from `HashedString.set`), and
  on 40 `minecraft:stone` came back null. The native constructor used to construct the string over whatever was there,
  so the derived one must `construct()` first.
- Run 2 (`btype40/51`, `verify-pair`, no client, tsc 0, exit 0 + `Quit correctly`): 13 PASS / 0 FAIL each.
  `minecraft:stone` and `oak_planks` are found and read back their names, and the bare `stone` gives the same block. A
  miss (`minecraft:no_such_block_seprobe`) and an empty name give null. `('minecraft:stone', 0x7fff)` is
  `getDefaultState()`, and 500 repeated lookups give the same block. `getBlockItemId` equals the id of
  `ItemStack.constructWith(name)`, the engine item registry's block item: stone 1, oak_planks 5, deepslate -378 (above
  0x100). `seprobeblock stone` / `oak_planks` reach the callback as those blocks, and `notablock` is a syntax error.
  `jjj stone` printed `block name: minecraft:stone` and `jjj deepslate` `minecraft:deepslate`
  (`work/host-runs/btype40-20260927-224820.txt`, `btype51-...`).
- Run 3 (`params40/51` with the bot and the checks added): **49 PASS / 0 FAIL each**, tsc 0, exit 0 + `Quit correctly`,
  `jjj stone` → `minecraft:stone` (`work/host-runs/params40-20260927-224938.full.txt`, `params51-...`). Regression
  `layout40/51`: 27/27 each.
- Not observed directly: 40's weak count before and after a lookup. The 500-lookup loop only shows it does no harm.
  Complex-alias names and nonzero data were not tried.

## BlockType and Block fields on 1.26 (2026-09-29)

Nine block reads threw on both builds: `Block::getRuntimeId`, `getBlockEntityType`, `hasBlockEntity`, `isUnbreakable`,
`getDestroySpeed`, `getExplosionResistance`, `getThickness`, `getTranslucency` and `BlockLegacy::getBlockEntityType`.
Their 2024 bodies are one-instruction leaves or tail calls into the legacy, and 1.26 inlined all but one of them.

**What 2024 read.** `getBlockEntityType@BlockLegacy` `movl 0x10c(%rcx)`, `hasBlockEntity@BlockLegacy`
`cmpl $0,0x10c; setne`, `getThickness@BlockLegacy` `movss 0x118`, `getTranslucency@Block` `movss 0x16c` of the
legacy. On the Block itself: `getExplosionResistance` `movss 0x70`, `getFriction` `movss 0x7c`, `getDestroySpeed`
`movss 0x80`, `isUnbreakable` `0 > +0x80`, `getRuntimeId` `lea 0xc4`.

**BlockType (1.26, both builds).** Endstone `block_type.h` puts `thickness_` at +344, `translucency_` at +348 and
`block_entity_type_` at +353. The first two are the only fields between two neighbours this build has confirmed:
`creative_group_`, a `std::string` at +0x138 that the block-item registration copies into the item, and
`creative_category_` at +0x160 (`findings-containers.md` section 18). The BlockType constructor zeroes both floats
(`movq $0,0x158`). Block constructors store translucency immediates at +0x15c: 1.0 at 82 / 78 sites and 0.8 at 46 / 45
sites on 40 / 51. No immediate is stored to +0x158 on 1.26 (2024's rail and carpet constructors stored 0.07 at +0x118).
Thickness is therefore placed by elimination plus execution.

`block_entity_type_` +0x161 has static writers on both builds. `FurnaceBlock`'s constructor (40 `0x1baed50`, 51
`0x2ce79b0`) stores `movb $0x1` (Furnace) or `$0x26` (BlastFurnace) there. The vanilla registration (40 `0x842d120`, 51
`0x849c3e0`) stores 3, 9, 11, 20, 23, 33, 40, 42, 48, 51, 53, ... there, all BlockActorType values.
**`getBlockEntityType@BlockLegacy` still has a body** (40 `0x1eefa20`, 18 call sites; 51 `0x1a28630`, 42 call sites).
It binary-searches the block type's sorted component-id vector (`+0x30`..`+0x38`, Endstone `components_` +48) for a
block-entity component and returns 0x3e if present, otherwise `movzbl 0x161`. 51 checks two component ids and sets only
`al` on the 0x3e path, so bdsx binds the result as `uint8_t`. It ships by address. `hasBlockEntity@BlockLegacy` is
out of line only on 40 (`0x1eefbd0`: the same component, or `cmpb $0,0x161`). That is `getBlockEntityType() != 0`,
and bdsx derives `Block::hasBlockEntity` that way on both builds.

**Block (1.26, both builds).** Endstone `block.h` has `block_type_` (+0x68, confirmed), then the 8-byte
`cached_component_data_`, then `direct_data_` (`BlockComponentDirectData`) at +0x78. `direct_data_` holds five
component pointers, four bools, three one-byte fields and two `uint16_t` odds at +0xa8/+0xaa. After those come
`explosion_resistance` +0xac, `friction` +0xb0 and `destroy_speed` +0xb4. +0xb4 is the hardness section 12 already
confirmed, and the destructible-by-mining pointer that section 12's hardness helper reads is +0xd0, the end of the
count. The Block constructor (40 `0x1bb0460`, 51 `0x2ce8950`, found from `??_7Block@@6B@`) zeroes 0xa8..0xb7 with one
`movups`. No separate 1.26 reader of +0xac was found: a scan of `movss 0xac` loads beside Explosion's `maxResistance`
(+0x70) found only a ray iterator.

`network_id_` is +0x114. The constructor stores `movabsq $0xffffffff00000000` at +0x110 (hash-for-network 0, id -1)
before `client_data_` +0x118 and `data_` +0x120 (confirmed). The runtime-id assignment (40 `0x14f16c8`, 51
`0x15f15a8`, the same 13 bytes) is `movl %ecx,0x114(%rdx); movb $1,0x122(%rdx)` (`has_runtime_id_`), with 0xfffffffe
chosen by the block type's full-name hash (BlockType+0xe0).

They ship as `layouts.BlockLegacy.thickness/translucency` (344/348) and
`layouts.Block.explosionResistance/friction/destroySpeed/runtimeId` (172/176/180/276), read by `engine/blocktype.ts`
with `derived()` in `implements.ts`. `setDestroyTime@BlockLegacy` is left alone. 2024 wrote the legacy's two floats,
but 1.26 caches destroy speed per Block state (`direct_data_`) and in the mining component, so a setter needs its own
design.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/bfield40.ps1 tools/host/drivers/bfield51.ps1`,
`tools/item-probe.ts` `itemprobe blockfields` on twelve `setblock`-placed blocks, **9 PASS / 0 FAIL on each build**,
tsc 0, exit 0, `Quit correctly`; `work/host-runs/bfield40-20260929-141630.txt`, `bfield51-...`). Both builds gave the
same values:

| block | destroySpeed | explosionResistance | friction | translucency | thickness | blockEntityType |
|---|---|---|---|---|---|---|
| stone | 1.5 | 6 | 0.6 | 0 | 0 | 0 |
| obsidian | 35 | 1200 | 0.6 | 0 | 0 | 0 |
| bedrock | -1 (`isUnbreakable` true) | 3600000 | 0.6 | 0 | 0 | 0 |
| ice | 0.5 | 0.5 | **0.98** | 0 | 0 | 0 |
| glass | 0.3 | 0.3 | 0.6 | 1 | 0 | 0 |
| oak_leaves | 0.2 | 0.2 | 0.6 | 0.5 | 0 | 0 |
| chest | 2.5 | 2.5 | 0.6 | 0.5 | 0 | 2 Chest |
| furnace / blast_furnace | 3.5 | 3.5 | 0.6 | 0 | 0 | 1 Furnace / 0x26 BlastFurnace |
| rail | 0.7 | 0.7 | 0.6 | 1 | **0.07** | 0 |
| white_carpet | 0.1 | 0.1 | 0.6 | 0.89 | **0.07** | 0 |
| dirt | 0.5 | 0.5 | 0.6 | 0 | 0 | 0 |

`getRuntimeId` gave twelve distinct ids, each equal to the +0x110 network hash (the server hashes block ids) and the
same on both builds. The thickness of rail and carpet is 2024's 0.07, which settles +0x158. Ice's 0.98 settles +0xb0.

The first run (`bfield40/51-20260929-1402..`) failed two ways, neither a field. The probe expected obsidian's Java
hardness, 50; Bedrock's is 35, and explosion resistance and every other hardness matched. On 51's world, the rail and
carpet placed on bare ground popped off. They now sit on stone the driver places under them.

## asItemInstance (2026-09-29)

`BlockLegacy::asItemInstance` is a virtual, and bdsx reached it through `procHacker.jsv` on `??_7BlockLegacy@@6B@` by
the 2024 name. That needs both the vftable and the function in the table, and 1.26.51 has neither. The two
`Block::asItemInstance(BlockSource&, BlockPos const&[, bool])` overloads that call it were inlined.

**The slot is 77 on both builds.** Endstone `block_type.h` counts `asItemInstance` as virtual 76 from the destructor,
but slot 76 of the base table reads `rdx+0x1d0` and takes an actor. Slot 77 (40 `0x1eeb770` in `0xa65d460`; 51
`0x1a24b60` in `0xa762920`, the vptr the BlockType constructor stores) is 2024's `0x1be8270`. It builds an ItemInstance
of `default_state_` (+0x240, Endstone +576), count 1, no tag, into the return slot, and never reads its two arguments,
as 2024 ignored them for `mDefaultState`. bdsx calls it through the block type's own table
(`layouts.BlockLegacy.asItemInstanceSlot`), so a block type that overrides it answers too. The return is an
ItemInstance, 0x80 bytes, the size of bdsx's `ItemStackBase` on both builds. The two Block overloads are 2024's bodies:
the block type's `asItemInstance` with `BlockSource::getBlockEntity(pos)`. The bool overload then called
`ItemStackBase::addCustomUserData`, which neither 1.26 table has, so `copyWholeData = true` throws.

**Executed** (`bfield40/51`, `itemprobe blockfields`, **13 PASS / 0 FAIL on each build**;
`work/host-runs/bfield40-20260929-155753.txt`). For placed stone, oak_leaves, chest and furnace, `asItemInstance` gave
the item of the same name with count 1, and so did `Block.getSilkTouchItemInstance`. `Block.asItemInstance(region, pos)`
gave minecraft:chest for the chest and minecraft:stone for the stone. That run's dirt became grass (grass spread onto
it), so the block row now uses coarse_dirt.

## Block's signal and variant (2026-09-29)

2024's `Block::hasComparatorSignal`, `getComparatorSignal` and `getVariant` forward to the BlockLegacy's virtuals
(slots 111, 112, 129). 1.26 inlines the forwarders; the BlockType virtuals remain, at **90, 91 and 102 on both
builds** (Endstone `block_type.h` counts the same three): JukeboxBlock and ChestBlock override 90 with return-true and
91; 102 is `movzwl 0x120(%rdx)` (the Block's `data_`). They ship as `layouts.BlockLegacy.*Slot` and
`engine/blocktype.ts` `BLOCK_TYPE_SLOTS`; bdsx calls them through `derived()`.

ChestBlock's slot 91 (40 `0x1b96fb0`) is `(this, region rdx, pos r8)`: BlockSource slot 40 (`0x140`, the chunk at
pos), the chunk's block actor at the chunk-local position, the block actor's slot 16 with 2, then a tail call into the
container helper (40 `0x2dda40`): sum of count/max over the slots / size * 14, plus 1 if any slot is non-empty.

Confirmed on both builds (`itemprobe signal`, drivers `sig240/51`, 3 PASS each): jukebox and chest true, stone
false; a lone chest with two stacks of 64 diamonds 2, a lone empty chest 0; a powered lever's variant 13 = its
`data_`, stone 0. **The first runs placed the two chests side by side**: they paired into one 54-slot container and
both read 1 (and an earlier run 0 for both, not reproduced) -- a comparator probe needs its chests apart.

Endstone's `getDirectSignal` (its 42) is not that on 1.26 -- the base slot 42 is `ret` and LeverBlock's passes r9 on
as a pointer; calling it as `getDirectSignal` killed the server. Both names shipped the next day at 43 and 35: next
section.

## getDirectSignal and isSignalSource (2026-09-30)

2024's `Block::getDirectSignal` and `isSignalSource` forward to BlockLegacy slots 54 and 47. **On 1.26 they are
BlockType slots 43 and 35 on both builds**: Endstone `block_type.h` counts 42 and 34, one short, as it is at the two
confirmed neighbours. Slot 32 is `isLeverBlock` (Endstone 31), and LeverBlock alone overrides it with return-true. Slot 42
is `onFillBlock` (Endstone 41): the base's is `ret`, and LeverBlock's passes r9 on as a `Block const*`. That is why
calling 42 killed the server.

**Diffing the tables against the base** (40 `0xa65d460`, 51 `0xa762920`):

- RepeaterBlock (40 `0xa71e7f0`, 51 `0xa84fa50`) and ComparatorBlock (`0xa81ed00` / `0xa948010`) override 43.
- Repeater, comparator and daylight detector override 35 with the image's return-true (40 `0xa2650`, 51 `0xa2880`).
- LeverBlock (40 `0xa6c4e00`) and ButtonBlock override 32/48 and 119 (`isInteractiveBlock`, Endstone 118), not 35.

The repeater's 43 (40 `0x1b9da40`, 51 `0x2cd6500`) is `jmp *0x420(vptr)`: its own slot 132, the first past the base's
132 (`DiodeBlock::getSignal`). 2024's `DiodeBlock::getDirectSignal` did the same through its first own slot, 163
(`+0x518`). `getSignal` returns 0 unless the block type's on flag (`+0x378`) is set, then compares the direction
state with the asked direction.

**Engine oracles, both builds** (`callers.mjs` on 2024 gave the three call sites; the 1.26 copies are inlined):

- `getDirectSignal`: `DiodeBlock::getAlternateSignalAt` (40 `0x8e77a40`, 51 `0x8a1f9e0`, reached from the repeater's
  `getAlternateSignal` slot 140). It calls the diode's own `isAlternateInput` (slot 139, `+0x458`), special-cases
  redstone wire by the type's name hash (`+0xe0`), and otherwise tail-calls `type->vf[0x158](type, region, pos, dir)`.
  That is 2024 `0x1c13bd0`'s call to `Block::getDirectSignal`.
- `isSignalSource`: a byte scan for `mov 0x118(reg)` after a `+0x68` load (Block to type) found
  `calculateGoldenRailSpeedIncrease` (40 `0x2cf3df0`, 51 `0x2fa3950`). Per neighbour it does the material's
  solid-blocking checks (`+0x28` flags, type `+0x130 & 0x40000`) and then `!type->vf[0x118]()`. That is 2024's
  `Block::isSolidBlockingBlockAndNotSignalSource` (`0x1bb1d60`), called from
  `RailMovementUtility::calculateGoldenRailSpeedIncrease`. The 2024 scan with `0x178`/`+0x30` finds only that function and
  the forwarder.

They ship as `layouts.BlockLegacy.isSignalSourceSlot/getDirectSignalSlot` (35/43), `engine/blocktype.ts`
`BLOCK_TYPE_SLOTS`, with `derived()` in `implements.ts`.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/dsig40.ps1 tools/host/drivers/dsig51.ps1`,
`tools/item-probe.ts` `itemprobe dsignal`, **2 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/dsig40-20260930-045325.txt`, `dsig51-...`). Both builds gave the same values:

- A repeater boxed in by four redstone blocks (so it is powered whichever way it faces) became `powered_repeater`. Over
  FacingID 0..5 it gave `[0,0,0,15,0,0]`: 15 in exactly one direction.
- An unpowered repeater, a powered lever and stone gave 0 in all six directions. The lever does not override
  `getDirectSignal` in 2024 either.
- `isSignalSource` was true for the powered and unpowered repeater, comparator, daylight detector, redstone torch, target
  and observer. It was false for stone, **and also for the lever and the redstone block**, which were true in 2024 (slot 47
  overridden). On 1.26 LeverBlock's table keeps the base's return-false at 35. What the engine now asks instead, for the
  lever and the redstone block, was not looked for. Plugins that used `isSignalSource` to mean "emits power" get the
  engine's 1.26 answer.

The test blocks stand three apart on a stone floor the driver lays at y 67, and the driver clears them afterwards. The
floor stays.


## BlockUtils on 1.26 (2026-09-30)

2024's `BlockUtils` statics were listed as inlined; four are not. The object file keeps them next to `isFullFlowingLiquid`
(40 `0x2c58910`, 51 `0x2ed62e0`), found by scanning `.text` for the `LiquidDepth` id global's rip-relative loads (40
`0xc964fb8`, 51 `0xcd24490`): each does the same BlockType `states_` map lookup (`+0x1d8`, Endstone +472) with the value at
`bits = [node+0x2c]`, `end = [node+0x30]`, `(data >> (end-bits+1)) & mask` over `Block+0x120`. They ship by address:

| name | 40 | 51 | body |
|---|---|---|---|
| `isDownwardFlowingLiquid` | `0x2c58ac0` | `0x2ed6490` | depth > 7, false without the state |
| `isLiquidSource` | `0x2c58c50` | `0x2ed6620` | depth == 0 |
| `canGrowTreeWithBeehive` | `0x2c58de0` | `0x2ed67b0` | the type's name hash (`+0xe0`) against flower names and the FlowerIds group |
| `getLiquidBlockHeight` | `0x2c58f50` | `0x2ed6920` | `y + 1 - (((depth < 8 ? depth : 0) + 1) / 9 - 1/9)`, depth 0 without the state |

The other four are bdsx's: `isWaterSource` (engine `isLiquidSource` and the type is water/flowing_water), `isBeehiveBlock` (beehive,
bee_nest), `isThinFenceOrWallBlock` (BlockType slots 27 and 28: diffing ThinFenceBlock's and WallBlock's tables against the base
shows the image's return-true there alone; Endstone counts 26/27, one short as elsewhere), `allowsNetherVegetation`. 1.26's
`NetherFungusBlock::mayPlaceOn` (slot 68; 40 `0x69dcd30`, 51 `0x65ebe70`) tests three `HashedString` globals plus a vector of
eleven; read off the live process they are soul_soil, warped_nylium, crimson_nylium and dirt, grass_block, podzol, coarse_dirt,
mycelium, dirt_with_roots, moss_block, pale_moss_block, mud, muddy_mangrove_roots, farmland: 2024's twelve plus coarse_dirt and
pale_moss_block. `Block::isCropBlock` is a search of `BlockType::tags_` (`+0x1a0`, 0x30-byte `HashedString`s, Endstone +416) for
`minecraft:crop`; `Block` has no tag vector of its own that a scan of +0x78..+0x110 finds. `BlockLegacy::getStateFromLegacyData` is
`tryGetStateFromLegacyData ?? getDefaultState` (the former already falls back on a miss).

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/blkutil40.ps1 tools/host/drivers/blkutil51.ps1`,
`tools/block-probe.ts` `blkutil` and `blkutil2`, 10 PASS / 0 FAIL on each build, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/blkutil40-20260930-105315.txt`, `blkutil51-...`). Liquids are `Block.create(name, depth)`: 28 rows (four liquids, depths 0/1/3/7/8/12/15) give
source true only at 0 and downward true only at 8+, matching the engine's own `isFullFlowingLiquid`; heights at y 64 are 65.0000,
64.8889, 64.6667, 64.2222, 65.0000 for water depths 0/1/3/7/8 and 64.5556 for lava 4. The nether list agrees with the engine's `mayPlaceOn` on
22 blocks placed at y 80 (14 yes, 8 no). Crops: wheat, carrots, beetroot, potatoes, torchflower_crop, pitcher_crop and sweet_berry_bush true;
melon_stem and pumpkin_stem (empty tag lists) false: that check reads the engine's tags with no second oracle.
Two first-run misreadings: the probe's expected crop list had stems in it, and `tryGetStateFromLegacyData` never returns null.

**Block leftovers:** `canHurtAndBreakItem` and `setDestroyTime` were closed the same day, see "Block leftovers" below.

## Block leftovers (2026-09-30)

**`Block::canHurtAndBreakItem`** is 2024's `0 < legacy destroy time` (`0x1ba6f70` tail-jumps to the legacy body `0x1be9950`:
`xorps; comiss 0x184(%rcx); setb`). 1.26's value is the per-Block destroy speed at `+0xb4`, so `derived()` is
`blockDestroySpeed(block) > 0`. `Item::mineBlock` (the only 2024 caller) is still not found, so the oracle is the engine itself:
a survival simbot (`SimulatedPlayer.create`, `gamemode survival simbot`) mines a block at 31,68,18 with a diamond pickaxe and the
pickaxe's damage value is read before and after. Dirt (0.5), stone (1.5), oak_planks (2) and glass (0.3) each cost exactly 1
durability and answer true; tnt and slime (destroy speed 0) cost 0 and answer false. Nothing else was needed: the value that
2024 kept in the legacy is the one 1.26 kept in `direct_data_`.

**`BlockLegacy::setDestroyTime`** (2024 `0x1bf38b0`: `movss %xmm1,0x184(%rcx); movss %xmm1,0x188(%rcx)`, both floats = t; the
neighbour `0x1bf38d0` takes two values). **The permutation vector is at `BlockType+0x228`**, Endstone's `block_permutations_`
+552 as it says. The earlier "a read at 0x228 faulted" was not the vector (the probe that read it dereferenced something else);
`bperm` scans every qword pair 0x1c0..0x2a0 of a `Block.create` type for a (begin, end) near the type whose first entry's
`+0x68` points back at it, and finds exactly `+0x228` on both builds: stone n=1, lever n=16 (`lever_direction` 8 x `open_bit` 2),
40's chest n=4. `+0x200` and `+0x280` also give n=16 pairs whose first entry does not point back (other vectors). The new
`derived()` writes, for each permutation, `+0xb4` and `+0xac` = t and, when `[+0xd0]` is set, the float at `[+0xd0]+0` (the
mining component the engine's hardness helper reads first, section 12). Layouts `Block.miningComponent` (208) and
`BlockLegacy.permutations` (552) are in `candidates-instances-<v>.json`; code in `engine/blocktype.ts`
(`blockTypePermutations`, `blockSetDestroyTime`).

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/bhurt40.ps1 tools/host/drivers/bhurt51.ps1`,
`tools/block-probe.ts` `bperm`, `bhurt`, `bdtime`; `BHURT_CHAIN=1` runs `bdtime` right after `bhurt`; **10 PASS / 0 FAIL on each
build**, tsc 0, exit 0, `Quit correctly`; `work/host-runs/bhurt40-20260930-140244.txt`, `bhurt51-...`). `bdtime`: all 16 lever
permutations read 3 for destroy speed, explosion resistance and the mining float after `setDestroyTime(3)` (originals 0.5
each), and restore. Dirt mined by the simbot: 32 ticks at 0.5, 7 ticks and no durability loss at 0 (canHurtAndBreakItem false
then), 122 ticks at 2 (the same as oak_planks, which is also hardness 2), 32 ticks again after `setDestroyTime(0.5)`.

**Probe lessons (recorded as-is).** (1) A console command arriving while the simbot digs can interrupt it: with `bdtime` as
its own command 8 s after `bhurt` the oak_planks and glass rows failed on both builds (201 ticks, lost 0), until `bdtime` was
chained inside `bhurt` and the driver padded with `list`. (2) A solo 51 session (`session.mjs 51 bhurt51.ps1`, 14:00) had the
simbot never dig at all (`simulateDestroyBlock false` from the second block on, every row 201 ticks, lost 0): the simbot is
sometimes inert, like the bot that never spawns (Q8), and the same driver passed in the next pair run. (3) One 51 pair run
(13:56) gave 9 PASS / 1 FAIL: the restored dirt row took 67 ticks against 32 in the other runs, with destroy speed 0.5 and
durability loss 1 exactly as expected; four other runs of that row gave 32. Cause not known; not repeated in the final clean
pair. (4) My `bperm` scan dereferenced an unfiltered candidate on 51's chest and threw `Access Violation`: the scan now covers
stone and lever only.
