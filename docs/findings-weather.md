# The weather five, and the three that are one component lookup (route 11)

Q1 item 0, A-1 and A-2. `docs/findings-components.md` ("The 39 that are left") put
five Actor names in bucket C -- blocked on `Dimension::getWeather` and the three
`Weather::is*At` -- and four in bucket A, the ones whose whole 2024 body is a
component lookup. The queue's plan for A-1 was to resolve `Weather` first and let
the five fall out. **That plan was unnecessary**: 1.26 kept all five Actor getters
out of line. What the `Weather` work bought instead was the evidence that names
them.

## What the route is

A function whose body is a chain of one-line calls is named by **the innermost
function it ends in**, and that innermost function is named by its own 2024
body. It is the vftable-walk idea (`findings-vftable.md`) turned inside out: the
callee, not the position, carries the label -- and then position is the second,
seed-independent route that has to agree.

## The chain, in 2024 and in 1.26

2024's five differ from each other by exactly one line:

```
getDimensionConst()                            -> Dimension&
  getWeather()                                 -> Weather&          (leaf: mov rax,[rcx+432]; ret)
BlockPos(position)                             -> BlockPos          (leaf)
getDimensionConst()->getBlockSourceFromMainChunkSource()
Weather::isPrecipitatingAt | isRainingAt | isSnowingAt   (and isInThunderstorm also isLightning)
```

1.26 inlined `getWeather` and the `BlockPos` constructor, and took the
`BlockSource` from a Dimension virtual (slot 12) rather than the leaf accessor,
but it left the chain otherwise intact:

| | 2024 | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `?isInPrecipitation@Actor@@QEBA_NXZ` | `0x19b9720` | **`0xe21480`** (314B) | **`0xd61650`** (314B) |
| `?isInRain@Actor@@QEBA_NXZ` | `0x19b9790` | **`0xe215c0`** (314B) | **`0xd61790`** (369B) |
| `?isInSnow@Actor@@QEBA_NXZ` | `0x19b9820` | **`0xe21700`** (314B) | **`0xd61910`** (369B) |
| `?isInThunderstorm@Actor@@QEBA_NXZ` | `0x19b9890` | **`0xe21840`** (385B) | **`0xd61a90`** (431B) |
| `?isInWaterOrRain@Actor@@QEBA_NXZ` | `0x19b99e0` | **`0xdea2a0`** (490B) | **`0xd2a130`** (545B) |

The offsets the inlined copies spell out, read off `isInPrecipitation` on
1.26.40.8: the Dimension is `Actor+456` (the accessor this table already ships)
behind a weak reference at `Actor+464`, **the Weather is `Dimension+488`** (2024:
+432), the position is `Actor+536` and the box `Actor+544` -- the same two
pointers `?setSpawnBlockRespawnPosition@ServerPlayer@@` reads
(`findings-layouts.md`).

## Naming the inner three

On 1.26.40.8 they are still out of line:

* **`Weather::isRainingAt` `0x2d13080`** and **`Weather::isSnowingAt`
  `0x2d13220`**, 415 bytes each, with an identical callee list and 23 differing
  bytes -- the same relationship 2024's pair has (85 bytes each, 8 differing).
  The tail is 2024's tail: `BlockSource::getBiome` (`0x1502fa0`), then
  `Biome::getTemperature` (`0x1271120`), then `ucomiss` against a constant and
  **`setb` for rain, `setae` for snow** -- 2024's `jbe` / `ja`.
* **`Weather::isPrecipitatingAt` `0x2d12f00`**, 371 bytes, the shared first
  callee of that pair, which reaches `getBiome` and never `getTemperature`.

A structural search finds the 2024 pair and nothing else: of every `.pdata`
function of 50..200 bytes with exactly three callees whose body contains a
`comiss`, a `test al,al` and a `mov al,1`, exactly one same-size pair with an
identical callee list exists, and it is `isRainingAt` / `isSnowingAt`. **The same
search returns nothing on either 1.26 build**, which is what sent the first hour
down the wrong path -- the pair is there, it is just 415 bytes because
`isPrecipitatingAt` and `getBiome` were inlined into it, outside the window the
search was given.

On 1.26.51.1 `isRainingAt` and `isSnowingAt` are inlined into their callers, so
the Actor functions carry the `setb` / `setae` themselves and call
`isPrecipitatingAt` (`0x119d6b0`), `getBiome` (`0x1602f90`) and
`getTemperature` (`0x119c8c0`) directly. That is why 51's `isInRain` and
`isInSnow` are 369 bytes and 40's are 314.

`Weather::isLightning` has no out-of-line copy on either build. 2024's is a
21-byte leaf, `lightningLevel(+68) * rainLevel(+56) > 0`, and that is exactly
what the tail of `isInThunderstorm` does on both 1.26 builds -- with 1.26's
two-field interpolation (`[+52]`,`[+56]` and `[+64]`,`[+68]`) which reduces to
the same two fields. So the Weather field offsets did not move.

## The second route: position

In all three builds the four are consecutive and in the 2024 declaration order --
precipitation, rain, snow, thunderstorm -- with the same 86-byte neighbour in
front of them on both 1.26 builds. The two routes are seed-independent (one is
"what does it call", the other "where does it sit") and they agree on all four.

## `isInWaterOrRain`: 1.26 folded two functions into one

The address `0xdea2a0` / `0xd2a130` was already shipping, under
`?isInContactWithWater@Actor@@` and from propagation. Its body is
`hasComponent<WasInWaterFlagComponent>` followed by `isRainingAt` at the head
position, **with no third term** -- 2024's `isInContactWithWater` has one more
(`Actor+1088`), and 2024's `isInWaterOrRain` does not. Its caller set on 1.26 is
the *union* of the two 2024 caller sets: `TridentItem::use` and `::releaseUsing`,
`CampfireBlock` / `SoulFireBlock` / `FireBlock::entityInside` from
`isInWaterOrRain`, and `EnderMan::newServerAiStep` from `isInContactWithWater`.
ICF folded them, so both names ship at the one address.

## What the console proved (A-1)

`tools/actor-layout-probe.ts`, `wxprobe`; drivers `wx40.ps1` / `wx51.ps1`.
**Both builds 14/14 PASS, exit 0, `Quit correctly`**
(`work/host-runs/wx40-20260921-153122.txt`, `wx51-20260921-153122.txt`).

The driver builds the test site rather than trusting the world: a stone block at
`29 120 14` and the player on top of it, so the column is open to the sky by
construction and the heightmap is the block under his feet. Then:

| step | reading |
|---|---|
| `/weather rain` | precip **true**, rain **true**, snow false, thunder **false** |
| `/weather thunder` | precip true, rain true, snow false, thunder **true** |
| a stone block at `29 125 14` | **all four false**, weather untouched |
| the block removed | precip true, rain true, thunder true again |
| `/weather clear` | all four false |

and `isInWaterOrRain` equals `isInRain` at every one of the five, which is what
it must be for a player standing on a platform in the air. The checks that
matter are the relations, not any single reading: exactly one of rain/snow is
true while it precipitates (the biome temperature picks, and this world picks
rain at both sites), thunderstorm is false under `/weather rain` and true under
`/weather thunder`, and a block placed *above* the player turns all four off
without the weather changing -- that is `isPrecipitatingAt`'s heightmap test, and
no wrong address produces it.

A second site a thousand blocks away (`1029 121 1014`, same platform trick) reads
the same under thunder; it is there because a biome without precipitation would
have made every reading false, which is indistinguishable from a wrong address.

## A-2: the three that need no chain

| name | how it ships | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `?isInWater@Actor@@QEBA_NXZ` | `derived()`, `hasComponent<WasInWaterFlagComponent>` | hash `0x78e89f39` | same |
| `?isJumping@Actor@@QEBA_NXZ` | `derived()`, `hasComponent<MobIsJumpingFlagComponent>` | hash `0x8fd20e98` | same |
| `?isInsidePortal@Actor@@QEBA_NXZ` | address | **`0xe12b80`** (259B) | **`0xd52d80`** (259B) |
| `?getArmorCoverPercentage@Mob@@QEBAMXZ` | **not done** | | |

2024 writes the first two as two instructions each -- `add rcx,8; jmp
ActorEnvironment::getIsInWater` and `add rcx,8; jmp MobJump::isJumping` -- and
both callees are `ctx.hasComponent<...>()`. 1.26 has no out-of-line copy of any
of the four functions, so bdsx does the lookup. The water hash is not a guess and
not a header reading: it is the immediate in front of the rain test **inside
`Actor::isInWaterOrRain`**, the address this same item confirms, so the two
halves corroborate each other.

A flag component is an *empty* type, and `entt` keeps no payload for one. The
existing `enttComponent` walked on to the payload, which for these would have
been a pointer read past the end of the storage; it is now split into
`enttSlot` (sparse-set membership, which is all `hasComponent` is, and exactly
where 1.26's inlined copies stop) and `enttComponent` on top of it. Riding is
unaffected: the masked slot it computes is the same value the old code used.

`isInsidePortal` is 259 bytes on both builds and one of only ten (eleven on 51)
functions that contain `fnv1a("InsideBlockComponent") = 0xc1c8fb69` at all. Two
routes: its body is 2024's with the `try_get` inlined -- same `Actor+16` /
`Actor+24`, the inside block's `BlockLegacy` at `[component+104]+224`, compared
against two globals, returning a plain bool -- and **its caller is 2024's sole
caller of `isInsidePortal`**, `?canOpenContainerScreen@Player@@QEAA_NXZ`, 65
bytes in 2024 and 65 bytes here, with the same four steps in the same order.

**Which two globals matters, because it is what the console has to build.**
2024's body (`0x19b9b00`, 66 bytes) is two comparisons and nothing else:

```
movq  0x1a70407(%rip), %rax   # 0x143429f38 = ?mPortal@VanillaBlockTypes@@ (WeakPtr<BlockLegacy>)
cmpq  (%rax), %rcx            # the inside block's BlockLegacy == the portal block's
...
addq  $0x98, %rcx             # else BlockLegacy+0x98, the name's HashedString
callq 0x140576d70
leaq  0x1a789ad(%rip), %rcx   # 0x143432500 = ?EndPortal@VanillaBlockTypeIds@@ (HashedString)
callq 0x140576d70
cmpq  %rax, %rbx
```

So it is true inside `minecraft:portal` **or** `minecraft:end_portal`, and false
inside everything else. The two blocks behave very differently under a console:
a portal block placed without an obsidian frame deletes itself, and an end portal
block has no validity rule at all but teleports what touches it at once.

### What the console proved

`wxmob` and `wxjump` in `tools/actor-layout-probe.ts`; drivers `wx240.ps1` /
`wx251.ps1`. Both builds **9/9 PASS, exit 0, `Quit correctly`**
(`work/host-runs/wx240-20260921-183604.txt`, `wx251-...`). The first pair of
sessions stopped at 7 PASS / 2 FAIL
(`work/host-runs/wx240-20260921-160354.txt`); the two lines below that say
"1920 ticks" and "nether portal" are from the later pair.

**The bot cannot answer any of these.** A headless client that never sends
movement runs no player physics on the server: stand it in a water block and its
`isInWater` stays false -- and so does the *binary's own* `isInWaterOrRain`,
which is how we know it is the world and not the lookup. Every positive here
therefore comes from a mob, and every phase is sampled **every tick** rather than
read once.

* **`isInWater` PASS on both builds.** Six rabbits in a walled room: 0 true in
  1920 ticks on dry stone, then teleported into a sealed water basin,
  **1926 true out of 1926 ticks** (1914/1914 on 51), with the probe reporting the
  rabbit's own feet block as `34,121,13 = minecraft:water`. Back on dry stone, 0
  again in 1920 ticks. The rabbits survive the basin now because the console
  gives them `water_breathing` first -- see the sessions below.
* **`isJumping` PASS on both builds.** Every one of the seven sampled rabbits was
  seen both jumping and not jumping (on 1.26.51.1: 1475/2783, 1488/2728,
  1795/2530, ...), while the bot, which never jumps, read false 7458 times and
  true 0 times.
* **`isInsidePortal` PASS on both builds -- positive and negative.** In the same
  walled room, on plain stone, 0 true of 1920 ticks; with a **lit obsidian nether
  portal** standing in it, **482 of 2880 ticks true on 1.26.40.8 and 263 of 2880
  on 1.26.51.1** (the rabbits hop in and out of a two-wide portal, which is why
  it is a fraction and not all of them); the bot false throughout. The frame is
  built by the console -- four `fill`s of obsidian, then `setblock 29 120 14
  fire`, which lights it: **BDS's own `testforblock 29 121 14 portal` answers
  `Successfully found the block at 29,121,14`** on both builds, twice, sixteen
  seconds apart.
  A second phase places `end_portal` with one `setblock` and reads true 16 of 483
  ticks on 1.26.40.8 and **0 of 320 on 1.26.51.1** -- an end portal teleports
  what touches it at once, so there is almost nothing to sample, and the check
  therefore asks for a positive in *either* phase. The nether portal is the one
  that answers.
  One thing the probe reports is **not** corroboration: the "portal witness" line
  names the mob's own feet block at the first true tick and it reads
  `29,120,15 = minecraft:air` on both builds. The inside-block component is the
  block the engine last found the *bounding box* in, sampled a tick earlier than
  our read, and a hopping rabbit has already moved; the tick counts are the
  evidence, that line is not.
* **`getArmorCoverPercentage` was not attempted.** 2024's body (`0x19119d0`, 201
  bytes) walks `ActorEquipment::getAllArmor` and asks each piece for its armour
  value; `getAllArmor` is unresolved on both builds, and narrowing by "small
  callers of `ItemStackBase::isNull`" gives about thirty candidates on 1.26.40.8
  alone. It stays in bucket A of `findings-components.md` as half an answer.

### Six sessions, and what each one was

Worth writing down, because none of the failures was ever about an address:

1. Blocks placed, nothing read true. The player never moved after the
   `setblock`, so nothing re-evaluated -- and the first "negative control"
   reading was taken on a portal block left behind by the run before it.
2. A `tp` after each block change. Still false for the player: this is where the
   binary's own `isInWaterOrRain` agreeing with our `isInWater` showed the bot,
   not the lookup, was the problem. Switched every positive to a mob.
3. Mobs, but the wrong ones: at `difficulty easy` the background zombies and
   golems hurting each other filled the capture list before the rabbits did.
   Capture restricted to rabbits.
4. Rabbits only -- and they walked off the edge of the 5x5 platform and died 20
   ticks after capture. A walled room fixed it, and then water and jumping both
   answered on both builds. The portal phase still had no live mob: the rabbits
   had **drowned** in the sealed basin of the phase before it, 32 seconds under
   water against 15 seconds of air.
5. `effect @e[type=rabbit] water_breathing 900 1 true` before the basin. All six
   rabbits now live through every phase (1920 sampled ticks each) -- and the
   portal phase still read 0 true, with the probe's own feet report saying
   `30,120,14 = minecraft:air` where eighteen portal blocks had just been filled.
   BDS said `18 blocks filled` and then, at the end, **`0 blocks filled`** when
   the cleanup tried to clear them: a bare portal block deletes itself. That is
   also what the "portal block left behind by the previous run" in session 1
   really was -- it was not left behind at all.
6. An obsidian frame lit with `setblock fire`, plus an end portal block, plus
   `testforblock` after each so BDS says whether the block is there. 9/9 on both
   builds.

The shape of all six: **four of them were the world, none was an address.** The
one measurement that would have shortened sessions 5 and 6 is the one BDS
volunteers for free -- `testforblock` after every block the probe depends on.


## Loose ends found on the way

* **`?hasOpenContainer@Player@@` is `Player+1440` on 1.26.40.8** (2024: +1872).
  2024's `?canOpenContainerScreen@Player@@QEAA_NXZ` (`0x19d8f60`, 65 bytes) opens
  with `cmpq $0,1872(%rcx)`, and its 1.26.40.8 counterpart (`0x225ad0`, also 65
  bytes, also calling `isInsidePortal` as its second step) opens with
  `cmpq $0,1440(%rcx)`. That is bucket B in `findings-components.md` -- not
  promoted here, because it was not executed.
* **`?randomTick@FarmBlock@@` looks wrong in both merged tables.** It ships
  `0x89bc910` / `0x7151df0`, a 101-byte function that reads the block one above
  the position and returns `!(block+113)`; 2024's `randomTick` is 606 bytes and
  calls `Weather::isRainingAt`, `Block::getMaterial` and `FarmBlock::_becomeDirt`
  (whose 1.26 counterpart, `0x89bc730`, is right there and is called by the
  execution-confirmed `transformOnFall`). It came from a vftable slot, and
  Endstone's 1.26 header has `randomTick` commented out of the BlockType vtable
  (`next-steps.md` Q1-A 3), so the slot is probably somebody else's. Not
  retracted here -- that is an audit item, not this one.
