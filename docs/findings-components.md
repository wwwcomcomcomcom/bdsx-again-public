# Route 10: component type hashes (2026-09-19)

## Why the getters stopped matching

Between 2024 and 1.26 most of `Actor`'s small getters stopped reading a
field and started looking a component up in the EnTT registry. The 27-byte
`getRotation` is gone; `hasType` went from 83 bytes to 440; `isSpectator`
from 84 to 282. That is why byte matching never found them, why call-edge
propagation misplaces them (three wrong names in one day:
`Actor::getPosition`, `getRotation`, `getRuntimeID`), and why a size ratio
cannot veto them (`findings-slots.md`, "The audit that followed").

## The label the lookup carries

Every inlined lookup masks and compares with a 32-bit constant -- in
`Actor::hasType`, `0x4F6BA419`, three times. That constant is
`entt::type_hash<T>`, and in these builds it is **FNV-1a (32-bit) of the
bare type name**:

```
fnv1a("ActorTypeComponent")     = 0x4F6BA419   (Actor::hasType, isType)
fnv1a("RuntimeIDComponent")     = 0xFC0DBBB5
fnv1a("ActorGameTypeComponent") = 0x88D3EDDF
```

So the functions that touch component `X` are exactly the ones containing
`fnv1a("X")` as an immediate, and the component names are public (Endstone's
headers, the 2024 PDB, Mojang's own scripting docs). `tools/component-hash.mjs
<version> <ComponentName>` lists them with sizes and whatever the merged
table already calls them. It is a semantic anchor that survives inlining,
reordering and a change of compiler -- the thing string literals were for
other code.

## From "touches X" to a name

The list for one component is short (26-41 functions, a handful under 320
bytes), the same on both builds, and the small ones are told apart by what
the 2024 source says they do:

- **`Actor::getRuntimeID`.** Of the small `RuntimeIDComponent` users, one
  reads the entity context from `this+0x10 / +0x18`, stores the component's
  8 bytes through the hidden return pointer and returns it (231 B); its
  neighbours are the bool test (218 B), the setter that writes `rdx` into
  the component (221 B) and the same getter behind a helper call (245 B).
  Through bdsx it returns 1, the runtime id `start_game` gave the bot, on
  both builds.
- **The game-mode family.** Four `ActorGameTypeComponent` users of 282 /
  282 / 282 / 302 bytes differ only in the constant the game type is
  compared with, after `Default` (5) is resolved through the Level vtable:
  `== 6` is `isSpectator` -- which the table already had from propagation,
  so this is that name's second route -- `== 1` `isCreative`, `== 2`
  `isAdventure`, and `(type & ~2) == 0` `isAttackableGamemode`, which in
  2024 was `isSurvival(type) || isAdventure(type)`. The 258-byte one among
  the Player functions that returns the type is `Player::getPlayerGameType`.
  There is no out-of-line `isSurvival` any more (none of the 41 users
  compares with 0 alone), so bdsx derives it: attackable and not adventure.
  `tools/actor-layout-probe.ts` `gmprobe` after `gamemode <m> @a`: all six
  values right in survival, creative, adventure and spectator, on both
  builds.

It also works as a **second route for names already shipped**: seven
propagation names (`getDimensionId` / `DimensionTypeComponent`, `hasEffect` /
`MobEffectsComponent`, `getAbilities` / `AbilitiesComponent`, `getArmor` and
`ActorEquipment::getHandContainer` / `ActorEquipmentComponent`, `isType`,
`isSpectator`) contain the hash their name predicts on both builds.

> Carrying the right hash is not the same as being the right function:
> `hasEffect` was one of those seven and turned out to be the
> `getEffect(unsigned int)` overload ("What the second route caught",
> below). The hash says which component a function touches, nothing more.

## The second batch: the effect family, the type id, the identifier (2026-09-19)

Seven more names, all on both builds, all with the value driven from the
console and read back through bdsx's own methods
(`tools/actor-layout-probe.ts`, `layoutprobe` and the new `effprobe`).

| name | 1.26.40.8 | 1.26.51.1 | how it was told apart |
|---|---|---|---|
| `Actor::getEntityTypeId` | `0xde5990` | `0xd25840` | byte-for-byte `isType` except the tail: `movl (%rax,%rdx,4), %eax` instead of `cmpl …; sete %al` |
| `Actor::getEffect(const MobEffect&)` | `0xe1a9d0` | `0xd5acb0` | reads the argument's +8 (`MobEffect::mId`) and indexes the effects vector with it |
| `Actor::addEffect` | `0xe189b0` | `0xd58c80` | six named callers are all 2024 `addEffect` callers |
| `Actor::removeEffect(int)` | `0xe19f80` | `0xd5a260` | the only one whose second argument is sign-extended and bounds-checked as an index |
| `Actor::removeAllEffects` | `0xe1a360` | `0xd5a640` | caller-set intersection (below) |
| `Actor::getAttributes` | `0xe18480` | `0xd58750` | the `not_null` shape: store through the hidden return pointer, throw on null |
| `Actor::getActorIdentifier` | `0xde4570` | `0xd24810` | the only user in the Actor region; same static-init fallback tail as 2024 |

Three things this batch adds to the method.

**A sibling is the cheapest discriminator.** Twice the answer was the
function *next to* one already named, with the same body and a different
last instruction: `getEntityTypeId` beside `isType`, `getEffect` beside
`getEffect(unsigned int)`. 1.26 emits the whole inlined lookup once per
overload, so an overload set is a run of near-identical functions whose
tails are the only difference. Read the tail first.

**Caller-set intersection names a function with no hash at all.**
`removeAllEffects` does not contain `fnv1a("MobEffectsComponent")` -- it
reaches the component through the `removeEffect` it calls. But
`Player::resetUserPos` and `BucketItem::useTimeDepleted` have **exactly
one callee in common** on each 1.26 build, and running the same
intersection on the 2024 baseline returns exactly
`?removeAllEffects@Actor@@`. Two already-named callers of a 2024 function,
intersected in the target build, is a route that needs no hash, no
signature and no size; `scratchpad` code, not a committed tool, because
picking the two callers is the judgement.

**The hash is not portable between builds.** `getActorIdentifier`'s 2024
body uses `0x334A4122` for `ActorDefinitionIdentifierComponent`, which is
not FNV-1a of that name, while 1.26 uses `0xDEB6534F`, which is. So the
constant has to be computed for the build being searched; a hash lifted
from the 2024 body finds nothing.

### What the second route caught: `hasEffect` was wrong

Propagation (and, independently, `gaps-agree` on 1.26.51.1) had shipped
`?hasEffect@Actor@@QEBA_NAEBVMobEffect@@@Z` at `0xe1ab10` / `0xd5adf0`.
Reading it for this batch showed it takes the effect id in `edx` and
returns the instance pointer (`cmovneq %rdx, %rax`): it is the
`getEffect(unsigned int)` overload. Under bdsx's `bool` return that is the
low byte of a pointer -- true most of the time, false whenever the
allocation happens to end in `0x00`, and never an error. It is the
[rule 4](HANDOFF.md) (section 7) case: the later route disagreed with a shipped
name, and the shipped name was the thing to doubt.

1.26 keeps no out-of-line `hasEffect` -- 2024's was 20 bytes (`call
getEffect; test; setne`) and the inliner removed it; nothing under 94
bytes calls `getEffect` in either build. So the name is `retracted` in
`data/candidates-instances-<v>.json` and bdsx carries it
(`data/derived.json`), which is the same definition the 2024 thunk had.

### Where it stopped

- `Actor::getOffhandSlot` has no out-of-line copy either: of the 97
  callers of `ActorEquipment::getHandContainer` only `getCarriedItem`
  (42 bytes, `getItem(0)`) is small, and the `getItem(1)` form appears
  only inlined inside larger functions. It is a `derived()` candidate,
  not an address.
- **A template component's name is the whole template spelling, with no
  spaces.** `TagsComponent` hashes to 0xBE4024EF and has zero users, which
  is why `hasTag` / `addTag` / `getTags` stalled;
  `fnv1a("TagsComponent<IDType<LevelTagSetIDType>>")` = **0x89ABB47B** has
  ten, *the same ten functions in the same size order on both builds*. Not
  `TagsComponent<IDType<LevelTagSetIDType> >` (a space before the closing
  angle bracket), and not the `class`/`struct`-qualified spellings MSVC's
  `__FUNCSIG__` prints -- all three give zero. Quote the argument, or the
  shell eats the angle brackets.
- `Player::isFlying` needs `LayeredAbilities::getBool(9)`; the small
  `AbilitiesComponent` users all read byte 0 or 1 of the 1464-byte
  component (the permission levels), not the ability flags.
- `getAttributes` is shipped but only half-checked: reading a value out
  of the map needs `BaseAttributeMap::getMutableInstance`, which is not a
  function in 1.26 at all (see "The health pair" below).

### Q8: `effprobe speed` reading null was the probe's key, not `getEffect` (2026-09-25)

The intermittent `getEffect(Speed)` null (Q8 since 2026-09-19; 6 of 7 `layout51` runs on 2026-09-24) was a
use-after-free in `tools/actor-layout-probe.ts`, not the engine and not the table. The probe built its `MobEffect`
key as `new AllocatedPointer(0x20)` with the id at +8 and kept only `buf.as(MobEffect)`. `as()` copies the address
and nothing else (`bdsx-core/bdsx/voidpointer.cpp` `VoidPointer::as`), and an `AllocatedPointer`'s bytes live inside
that JS object (`newAlignedExtra`, `staticpointer.cpp`), so they are freed when it is collected. After any GC
between load and `effprobe speed`, the key's +8 was freed memory. That is why it looked like timing, got more
frequent as probes that allocate were added, and never threw.

`getEffect` itself is as shipped (read on both builds): it loads the key's +8 as the index, bounds-checks it against
the effects vector (stride 0x90 on 51, 0x88 on 40, the same as `MobEffectInstance`'s size), and returns null when the
slot's first dword equals the global at 51 `0xccb5da8` / 40 `0xc9817a8`. On 51 that global sits right after
`MobEffect::mMobEffects[38]` (0x130 bytes at `0xccb5c78`), and the effect-iteration code (51 `0x66419d0`) uses it the
same way: it skips a slot whose id equals it, then indexes `mMobEffects` by id (`cmpl $0x25` bound). So it is the id an
empty slot holds, 2024's `MobEffectInstance::NO_EFFECT`. Index 0 is always such a slot, so a key whose +8 reads 0 gets
null.

Shown in one run: `EFF_STALE=1` (driver `layout51stale.ps1`) rebuilds the old unowned key, prints its +8, and
repeats the lookup with a key built in the same step:

```
[layout] FAIL effprobe speed: key id 0 getEffect null showParticles - hasEffect false (want Speed, duration <= 600, amplifier 1, showParticles true, true)
[layout] INFO effprobe speed fresh key: key id 1 getEffect id 1 duration 600 amplifier 1
```

(`work/host-runs/layout51stale-20260925-002605.txt`; `speed2` the same with duration 400 amplifier 2. That session
then exited 0xC0000374 at `stop`, a first; the first stale session died about 14 s after the bot joined, before any
command, which is the known Q8 bot-join crash. Neither is counted as a result.) The fix: the view holds its buffer
(`(e as any).$buffer = buf`, the idiom `ActorDamageSource.create` already uses). After it, three solo `layout51` in a
row were 27/27 (00:37, 00:42, 00:47; the run before them had the 51 bot never spawn, `[layout] no player`, and is not
counted), and the pair `layout40`/`layout51` was 27/27 each, `key id 1` on both.

The same pattern was in bdsx: `engine/abilities.ts` `noSuchLayer()` cached `ptr.as(Abilities)` and dropped `ptr`, so
`getLayer(n)` past the last layer could read freed memory after a GC. Fixed the same way (bdsx `4792462c`). `abilprobe`'s
`getLayer(6) reads as an empty Abilities` passed on both after it (`abil40` 54/0; `abil51` 54/0 solo, after the
paired `abil51` died at the bot's join with Q8's `0x3f800000` fault).

**Rule:** a view taken with `as()`/`addAs()` from an `AllocatedPointer` does not keep the buffer alive. Anything
that outlives the statement must hold the `AllocatedPointer` itself. A scan of `bdsx/` and `tools/*.ts` for
`<allocated>.as(` found no other view that outlives its buffer.

## The health pair, and the code `.pdata` does not describe

`Actor::getHealth` and `Actor::getMaxHealth` looked unreachable for the
same reason `getMutableInstance` did: in 2024 all three are **leaves**.
x64 Windows only requires a `RUNTIME_FUNCTION` for a function that touches
the stack, so `?getHealth@Actor@@QEBAHXZ` (0x19b3060), eleven bytes of
`addq $8, %rcx; jmp ?getHealth@ActorAttribute@@YAHAEBVEntityContext@@@Z`,
has no `.pdata` entry and is invisible to every tool in this repo that
starts from `tools/pdata.mjs`.

`tools/leaf-funcs.mjs` recovers them from the call graph instead: a leaf
is still *called*, and a direct `E8/E9 rel32` names its first byte
exactly, so every direct branch target inside `.text` that is not a
`.pdata` start is a leaf entry point. On the 2024 baseline that is 11,643
addresses, of which **7,124 (61%)** are exactly a baseline symbol -- the
rest are local labels and tail-call continuations, so it is an enumerator,
not an identification. All three wanted leaves are in it.

What it then showed is that the leaves are **gone from 1.26**. No
`48 83 C1 08 E9` thunk in either 1.26 build points at a function that
mentions `AttributesComponent`, and the FNV-1a-64 constants appear outside
`.pdata` only twelve times, none of them an id-keyed map probe. The
inliner took the thunks; only the free functions behind them survive:

| name | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `?getHealth@ActorAttribute@@YAHAEBVEntityContext@@@Z` | `0x1ac9180` | `0x1ccf880` |
| `?getMaxHealth@ActorAttribute@@YAHAEBVEntityContext@@@Z` | `0x1ac92a0` | `0x1ccf9a0` |

Both are 275 bytes, adjacent, and found by this route's own method:
`fnv1a("AttributesComponent") = 0xFD3B0613`, 52 users, and these are the
only two that inline the component lookup, call `BaseAttributeMap::get`
with **the same static `Attribute` in `r8`**, take a float off the
returned `AttributeInstance` and round it up inline (`cvttss2si` +
`ucomiss` + `adc`, which is `Math::ceil` from the 2024 bodies). They
differ in one number: `+124` against `+120`. 2024's `AttributeInstance`
has minValue `+124`, maxValue `+128`, currentValue `+132`, so 1.26 shifted
the three down by eight and the higher offset is the current value. The
callers agree -- `Mob::isAlive`, `Mob::baseTick`, `Mob::hurtEffects`,
`Player::respawn` and every `_hurt` override call `0x1ac9180` (52
callers), while `0x1ac92a0` has 18 and includes
`WitherBoss::reloadHardcoded`.

Execution settles it, because a full-health player cannot:
`effect @a health_boost 60 1 true` raises the maximum and leaves the
current value alone, and `hpprobe` reads 20/20 before it and **20/28**
after it, on both builds.

bdsx cannot call these on an `Actor*`, so it does what it already does for
`ActorEquipment::getHandContainer`: a `namespace ActorAttribute` bound to
the free functions, with `Actor.prototype.getHealth` passing
`this.ctxbase`. `?getHealth@Actor@@QEBAHXZ` therefore leaves
`data/required-symbols.json` and the `ActorAttribute` names take its
place.

`BaseAttributeMap::getMutableInstance(unsigned int)` does not survive in
any form. 2024's is an open-addressed hash table keyed on FNV-1a-64 of the
id; 1.26's map is a **sorted `std::vector<unsigned int>` of attribute ids**
at `+0 .. +8`, binary-searched by `equal_range`, with the
`AttributeInstance` array at `+24` (stride 128) and a static invalid
instance at `+32`. The only out-of-line lookups in the region take an
`Attribute const&` (`0x23643e0`, `0x2364500` on 1.26.40.8, reading the id
from `+4` of it) or a `HashedString const&` (`0x23642b0`). There is no
id-keyed entry point to name, so it is not an address at all: bdsx runs the
`lower_bound` itself over `layouts.BaseAttributeMap`, and the element stride
is the one number the two 1.26 builds disagree on (128 against 136).
`docs/findings-layouts.md`, "`BaseAttributeMap` and `AttributeInstance`",
has the layout and the execution.

## What it does not do

It finds functions that *look a component up*. A getter that reads a field
of the Actor (position, rotation: `findings-layouts.md`) has no hash; a
function that reaches its component through a helper has the helper's. And
"touches X" is not a name: the pick still needs the body read against the
2024 semantics, and an execution where the value can be driven from the
console. 91 non-virtual `Actor` / `Mob` / `Player` names are still missing
on both builds; the ones with an obvious component are the next batch
(`next-steps.md`, Q1).

## The tag family: a hash whose users are all nameable (2026-09-19)

`hasTag` / `addTag` / `removeTag` / `getTags` came out of route 10 in one
pass, and the run is worth recording because it is the cheapest shape this
route has: **the hash had six users and all six could be named**, so the
assignment was forced rather than argued.

The component is a template, so its EnTT type name is the full template
spelling with no spaces (`next-steps.md`, Q8):
`fnv1a("TagsComponent<IDType<LevelTagSetIDType>>")` = `0x89ABB47B`. Ten
occurrences in six functions, identical on both builds:

| size | 1.26.40.8 | 1.26.51.1 | what |
|---|---|---|---|
| 394 | `0xde5a70` | `0xd25aa0` | `Actor::hasTag` |
| 454 | `0xde5c00` | `0xd25c30` | `Actor::addTag` |
| 471 | `0xde5dd0` | `0xd25e00` | `Actor::removeTag` |
| 301 | `0xde5fb0` | `0xd25fe0` | `Actor::getTags` |
| 395 | `0xde60e0` | `0xd26110` | `Actor::deregisterTagsFromLevelCache` (not required) |
| 145 | `0xf0d330` | `0xe43430` | the EnTT `type_info` static initialiser, not a member |

The 40→51 delta is exactly `-0xBFFD0` for all five members, and every one is
instruction-for-instruction identical between the builds once rip-relative
displacements are ignored.

`getTags` is settled by return shape alone: it is the only user with a hidden
return pointer (rcx the Actor, rdx the caller's buffer), and its not-found path
writes 24 bytes of zero into that buffer and returns it -- the same three-word
`std::vector` clear the 2024 body does. `hasTag` is the only user that returns
bool from `(this, std::string const&)` without touching the Level slot pair the
add/remove path uses.

`addTag` and `removeTag` are overload siblings in the sense this document
already warned about: they share every instruction up to the tail. What
separates them is a **caller with its own strings**. `TagCommand::execute`
(`0x3c81c50` on 1.26.40.8, `0x3a0df60` on 1.26.51.1 -- the function carrying
all eleven `commands.tag.*` literals) calls them in order, each followed by a
lea of the matching message:

```
0x3c820c7  E8 -> 0xde5c00     0x3c821eb  lea "commands.tag.add.success.single"
0x3c823d7  E8 -> 0xde5dd0     0x3c824f7  lea "commands.tag.remove.success.single"
0x3c82660  E8 -> 0xde5fb0     0x3c827d7  lea "commands.tag.list.single.success"
```

2024 reaches the same three through `TagCommand::_addTag` / `_removeTag` /
`_listTags`; 1.26 inlined those into `execute`. The Level virtual slot pair
corroborates from the other side: addTag takes 2280 and removeTag 2272, the
same one-slot gap in the same direction as 2024's 2000 / 1992, and
`deregisterTagsFromLevelCache` calls 2272 for every tag it walks.

**Executed on both builds** (`tag40` / `tag51`, `[layout] PASS tagprobe
base|console|remove`). The probe is a cross-check rather than a call count:
bdsx adds `bdsxtag` and reads it back, the console's own `tag @a add
consoletag` writes through BDS's copy of the same four functions, each side
then reads what the other wrote, and `tag @a list` confirms from BDS's side
that bdsx's `removeTag` took the right one away. Endstone does not publish
these names, so there was no third route to check against.

**What this run adds to the method**: when a hash's user set is small, name
*all* of it. The six-of-six assignment is worth more than any single body
argument, because a leftover candidate is exactly where a mistake hides.

## The build carries the component names (2026-09-21)

Route 10 needs a component's *name*, because the type hash is fnv1a-32 of it.
Until now the name was guessed -- from Endstone's headers, or from a 2024
decorated symbol -- and both guesses miss. 2024 spells the jump flag
`FlagComponent<MobIsJumpingFlag>` (it is right there in
`??$hasComponent@V?$FlagComponent@UMobIsJumpingFlag@@@@@EntityContext@@`);
1.26 spells the same thing `MobIsJumpingFlagComponent`. The 2024 spelling
hashes to `0x7ae49d64`, which has **0 users on both 1.26 builds**. A guess that
misses is indistinguishable from a component the build does not have, which is
the expensive failure mode -- `TagsComponent` sat in the queue as "unresolved"
for two days for exactly this reason.

It does not have to be guessed. `entt::type_info<T>` is emitted as a 146-byte
function per type that fills a descriptor with the hash, a pointer to the type's
name and the name's length, and those three stores are a fixed 25-byte sequence:

```
c7 40 04 <hash:u32>        movl  $hash, 4(%rax)
48 8d 0d <rel32>           leaq  name(%rip), %rcx
48 89 48 08                movq  %rcx, 8(%rax)
48 c7 40 10 <len:u32>      movq  $len, 16(%rax)
```

`tools/entt-typenames.mjs` scans `.text` for it, reads the string, and **keeps
an entry only when fnv1a-32 of the name it read equals the hash it read**, so a
false positive from the byte scan cannot survive into the output.

```sh
node tools/entt-typenames.mjs work/bin/1.26.40.8/bedrock_server.exe --out=work/entt/typenames-1.26.40.8.json
node tools/entt-typenames.mjs work/bin/1.26.40.8/bedrock_server.exe --grep=jumping
node tools/entt-typenames.mjs work/bin/1.26.40.8/bedrock_server.exe --hash=89ABB47B
```

**3,771 names on 1.26.40.8, 3,990 on 1.26.51.1**, in half a second, and the two
builds agree on every hash they share (the hash is fnv1a of the name, so they
must). The precision check is the one this project always asks for: the five
component hashes that were established independently, by body and by execution,
come back exactly --

| name | hash | established by |
|---|---|---|
| `ActorEquipmentComponent` | `0xb06141a9` | `getHandContainer`, route 10 |
| `ActorGameTypeComponent` | `0x88d3eddf` | `checkBlockDestroyPermissions` |
| `PassengerComponent` | `0x98e40c0e` | riding (`findings-riding.md`) |
| `VehicleComponent` | `0x161f61ea` | riding |
| `InsideBlockComponent` | `0xc1c8fb69` | 2024's `try_get<InsideBlockComponent>` |

**5 of 5.** It also answers two names the headers did not: the water flag is
`WasInWaterFlagComponent` (`0x78e89f39`, 125 users on both builds) and there is
a second one next to it, `ActorHeadWasInWaterFlagComponent` (`0xf53d4c8a`) --
the kind of near-miss a guess walks straight into.

**Two limits, stated plainly.**

1. **The 2024 baseline yields nothing** (0 names). It builds EnTT differently
   and does not emit this descriptor form, so the tool is a 1.26-and-later
   instrument. That is the direction that matters -- the name is needed for the
   target build, not the baseline -- but it means the baseline still has to be
   read for *which* component a 2024 body used.
2. **Coverage is partial, not total.** 1,303 of the 3,771 are templates, but
   `TagsComponent<IDType<LevelTagSetIDType>>` (`0x89abb47b`, confirmed by
   execution in the tag batch) is **not** in the output -- some `type_info`
   instantiations are emitted in another form. So a miss means "this scan did
   not find it", never "the build does not have it", and the hash-user count
   (`tools/component-hash.mjs`) stays the check that decides.

## The 39 that are left, sorted by what they actually need (2026-09-21)

With `enttComponent` in bdsx (`findings-riding.md`) the question for the
remaining Actor/Mob/Player non-virtuals changed. It used to be "where is the
address"; it is now "what does the 2024 body actually read". Every one of the
39 that the Q1 query prints was disassembled on the baseline and sorted. **This
is static work: nothing below was promoted, and nothing was executed.** Each
bucket is a separate item with its own two-build run still ahead of it.

### A. The component is the whole body -- `derived()`, four names

| name | component | hash | users 40/51 |
|---|---|---|---|
| `?isInWater@Actor@@QEBA_NXZ` | `WasInWaterFlagComponent` (existence) | `0x78e89f39` | 125 / 125 |
| `?isJumping@Actor@@QEBA_NXZ` | `MobIsJumpingFlagComponent` (existence) | `0x8fd20e98` | 51 / 51 |
| `?isInsidePortal@Actor@@QEBA_NXZ` | `InsideBlockComponent` + a portal check | `0xc1c8fb69` | 10 / 11 |
| `?getArmorCoverPercentage@Mob@@QEBAMXZ` | `ActorEquipmentComponent` (`getAllArmor`) | `0xb06141a9` | — |

The first two are two-line tail jumps in 2024
(`ActorEnvironment::getIsInWater` and `MobJump::isJumping`, both
`ctx.hasComponent<...>()`), so in bdsx they are
`enttComponent(this, hash, 1) !== null` and nothing else. The third reads the
component and then compares the block; the fourth needs
`WearableItemComponent::getArmorValue` per armor piece, which is not resolved on
either build -- it is in this bucket for the lookup, not for the whole answer.

`?handleJumpEffects@Player@@QEAAXXZ` is a component user too (2024 hash
`0xBE2C53A0` after `isClientSide`), but it *applies* effects rather than reading
a field, so it sits in D.

### B. One field -- `layouts`/`accessors` + `derived()`, ten names

No component and no address; what is missing is the 1.26 offset, and the tool
for that is `tools/field-offset.mjs` (`findings-layouts.md`, "isSpawned").

| name | 2024 body |
|---|---|
| `?getPlatform@Player@@` | `movl 1580(%rcx),%eax; retq` |
| `?getSkin@Player@@` | `leaq 1920(%rcx),%rax; retq` |
| `?hasOpenContainer@Player@@` | `cmpq $0,1872(%rcx); setne` |
| `?setRespawnReady@Player@@` | Vec3 to +6604/+6608/+6612, `movb $1,2864`, `movb $0,2905` |
| `?setName@Player@@` | `basic_string::assign` into +7472 |
| `?setLocalPlayerAsInitialized@ServerPlayer@@` | `movb $1,7754(%rcx); retq` |
| `?isUsingItem@Player@@` | `+2928` then `ItemStackBase::isNull` (resolved on both), `sete` |
| `?isInWorld@Actor@@` | `+233`, `Actor::hasDimension`, `+737` |
| `?getSpeedInMetersPerSecond@Actor@@` | `Actor+656` -> pos minus posPrev, length |
| `?distanceTo@Actor@@` | the same `Actor+656`, against the argument |

Two of these already had queue entries; the point of the table is that they are
one kind of problem, not ten, and `Actor+656` and `Player+2928` are each shared
by two of them.

### C. Blocked on other unresolved names -- sixteen

These are compositions, and the honest finding is that **the things they compose
are mostly not resolved either**, so "bdsx can just write this" is false today.
The dependency check:

```
-/-   Dimension::getWeather, Weather::isRainingAt / isSnowingAt /
      isPrecipitatingAt / isLightning          <- five Actor names wait on these
-/-   Block::getMaterial, Material::isAlwaysDestroyable,
      ItemStackBase::canDestroySpecial, ItemStack::getDestroySpeed,
      WearableItemComponent::getArmorValue     <- the three destroy names
-/-   PlayerInventory::selectSlot, Actor::isClientSide, BlockPos(Vec3)
acc   Dimension::getBlockSourceFromMainChunkSource
addr  Actor::getEffect, ItemStackBase::isNull, Actor::isCreative
```

The weather five (`isInRain`, `isInSnow`, `isInPrecipitation`,
`isInThunderstorm`, `isInWaterOrRain`) are one unit of work, not five: all of
them are `getDimensionConst()` -> `getWeather()` -> `BlockPos(getAttachPos(...))`
-> `getBlockSourceFromMainChunkSource()` -> one `Weather::is*At`. **Resolve
`Weather` -- four names -- and five Actor names fall out together.** That is the
best ratio left in Q1.

The rest: `canDestroy@Player`, `getDestroySpeed`, `getDestroyProgress`,
`getPlayerUIItem`, `setPlayerUIItem`, `setCursorSelectedItem` (a one-line tail
jump into `setPlayerUIItem(0, item)`), `setSelectedSlot`, `resendAllChunks`,
`forceAllowEating`, `hurt@Actor` (a forwarder into the Actor vtable, slot 69 in
2024) and `setNameTagVisible` (a vtable slot -- `setStatusFlag`; done 2026-09-22 as `derived()`, `findings-synched.md`).

### D. A real function, or a big one -- nine

`canSee(Actor&)` and `canSee(Vec3&)` (a raycast through `BlockSource`),
`fetchNearbyActorsSorted`, `interact` (848-byte frame), `inventoryChanged`
(1616-byte frame), `startCooldown`, `isInRaid` (`Dimension::getVillageManager`),
`isInClouds` (a dimension virtual), `handleJumpEffects`.

**The shape of the answer**: of the 39, four are reachable by the mechanism that
just landed, ten need one offset each, sixteen are waiting on a different name,
and nine are ordinary address hunts. The queue's guess -- that the component
route would take most of them -- was wrong, and the cheapest next move is not a
component at all: it is `Weather`.

## `tryGetFromEntity`: three names over one component (2026-09-22)

`Level.getPlayers()` -- and with it `serverInstance.getPlayers()`, which a dozen bdsx APIs loop over --
calls `?tryGetFromEntity@ServerPlayer@@` for each of `Level::getUsers()`, and `Level.getEntities()` calls
the Actor one. Neither build has either, nor Player's. All three are `derived()` now.

The 2024 bodies are small: Actor's (`0x19ca400`, 63B) is `try_get<ActorOwnerComponent>` (`0xba0dd0`), the
component's actor, and the removed-byte test unless `include_removed`; Player's (`0x19ece30`) puts a
PlayerComponent test in front of it, and ServerPlayer's (`0xcd8660`) an inline `hasComponent` and a tail
jump. Endstone writes Actor's and Player's the same way for 1.26 and declares `ActorOwnerComponent` as one
`unique_ptr<Actor>`. The component names are the build's own (`tools/entt-typenames.mjs`:
`ActorOwnerComponent` 0x85b93800, `ServerPlayerComponent` 0x122c9226; `PlayerComponent` 0xf95d258f has
392 / 408 users). `SimulatedPlayerComponent` has **zero** users on both builds, so
`?tryGetFromEntity@SimulatedPlayer@@` is left alone -- its component is spelled some other way.

An `EntityContext` is the EnTT registry at +8 and the entity id at +16 -- the two words an Actor holds at
+16/+24, since the Actor's own context sits at +8 -- so the actor-keyed helpers (`enttSlot`,
`enttComponent`) read a context through a pointer eight bytes before it.

Executed on both builds (`fieldprobe entityctx`, `work/host-runs/pl40-20260922-091840.txt`, `pl51-...`):
the bot's own context gives back the bot through all three; BDS's `Level::getUsers()` holds one 32-byte
context and it resolves to the bot; `level.getPlayers()` is `[bot]`; the console's pigs resolve through
Actor to actors whose own context names the same entity id, and neither player variant accepts a pig.

## `forceAllowEating`: the slot the 2024 body calls names it (2026-09-22)

`?forceAllowEating@Player@@QEBA_NXZ` was in bucket C for the unnamed virtual call in its 2024 body
(`0x19dd740`, 68B): `isCreative()` and, failing that, `getILevel()->vft[32]() == 0`. Slot 32 of 2024's
`??_7Level@@6BILevel@@@` (`0x2dc3ef8`) is `?getDifficulty@Level@@UEBA?AW4Difficulty@@XZ` (`0x1abe790`), and
`Difficulty::Peaceful` is 0 -- so the function is "creative players and peaceful worlds may always eat". On 1.26
`getDifficulty` is Level slot 36, route 9's executed anchor, and `isCreative` is an address on both builds; nothing
was missing, only the name of the slot.

1.26 keeps no copy of the function: of the 27 callers of the out-of-line `isCreative` (40 `0xe1d650` / 51 `0xd5d940`)
none has the shape (the one small caller, 60B at 40 `0x232860` / 51 `0x2bd9f0`, takes an ItemStack and tests a tag),
and no function under 900B holds both the `ActorGameTypeComponent` hash and a Level `vft+0x120` call. The 2024 callers
(`FoodItemComponent::use`, `CakeBlock::use`, `CandleCakeBlock::use`) inlined it. So it is `derived()`:
`isCreative() || getLevel().getDifficulty() === Difficulty.Peaceful`.

**Executed** (`fieldprobe eating <expected>`, drivers `eat40/51.ps1`, `work/host-runs/eat40-20260922-150221.txt`, `eat51-...`): the console moves
both inputs (`difficulty peaceful|easy|normal`, `gamemode survival|creative`) and the value follows the rule in all six
steps on both builds -- survival+peaceful **true**, survival+easy **false**, creative+easy **true**, creative+peaceful
**true**, survival+peaceful **true**, survival+normal **false** -- with the pieces printed beside it (isCreative
false/true, getDifficulty 0/1/2). What the bot cannot do is eat, so BDS's own gate (the 1.26 successor of
`FoodItemComponent::use`) was not seen calling anything; the derived body is the 2024 rule over two BDS functions, not a
1.26 witness of the rule itself.

Bucket C after this: `setSelectedSlot` turned out to be an address (`findings-containers.md` 15), and the
`PlayerInventory::selectSlot` it waited on is an out-of-line copy after all. Left in C: the destroy trio
(`canDestroy@Player`, `getDestroySpeed`, `getDestroyProgress`).

## `resendAllChunks`: the name it waited on turns out to be its own sibling (2026-09-23)

`?resendAllChunks@Player@@QEAAXXZ` was the last name in bucket C. Its 2024 body (`0x19e6dd0`) is a
17-byte leaf outside `.pdata` (`tools/leaf-funcs.mjs --at=0x19e6dd0`): read `this+0xc38` as a
`NetworkChunkPublisher*` and, if non-null, call `?clearRegion@NetworkChunkPublisher@@QEAAXXZ`
(`0xc904d0`). 1.26 inlines the leaf away in every caller, so there is no out-of-line 1.26
`resendAllChunks` to find an address for -- but `clearRegion` itself does have one on both builds, and
the queue's guess that this waited on "a different unresolved name" turned out to be almost right: the
name it needed was never required by bdsx and so was never in any table, not because it was hard to
find but because nobody had looked for it.

**Two independent routes land on the same address.** (1) Position/call graph: the 2024 baseline's only
`.pdata` caller of `clearRegion` is `?suspendRegion@Player@@` (`0x19eb840`, virtual) -- its
three-instruction prefix is byte-for-byte the same shape as `resendAllChunks` itself (read `this+0xc38`,
test, call `clearRegion` if non-null). `suspendRegion`'s 1.26 successor was already a promoted, shipping
symbol before this session (vftable-walk on 1.26.40.8, carried to 1.26.51.1) and opens with that
identical shape at `this+0x7e8` (the pointer moved from 2024's `+0xc38`), calling 1.26.40.8 `0x661350` /
1.26.51.1 `0x720ec0`. (2) Body: those two addresses (266B, `.pdata` function starts, byte-identical
between the builds except two unrelated internal call targets) match the 2024 `clearRegion` body (291B)
step for step at a consistent `+0x10`/`+0x30` structural offset shift throughout -- the same
`ChunkViewSource` vtable-dispatch pair, the same inline `ChunkPos::INVALID`-derived `BlockPos` reset, the
same generation-request call gated on a `ServerLevel` bool, and the same trailing vector-walk destructor
loop. `resendAllChunks` ships as `derived()`: read `layouts.Player.networkChunkPublisher` (`+0x7e8`, same
on both builds; the 2024 fallback is `+0xc38`) and, if non-null, call `clearRegion` on it.

**Executed 2026-09-23, both builds** (`tools/actor-layout-probe.ts` `fieldprobe chunks`, drivers
`chunks40/51.ps1`; `work/host-runs/chunks40-20260923-014938.txt`, `chunks51-...`: PASS 2/2, tsc exit 0,
exit code 0, `Quit correctly`): the call returns without throwing and the player stays connected and
initialized right after. That alone only proves the prototype is right, not that the function does
anything -- `clearRegion` has nothing server-side to read back, since it only clears the publisher's
"already sent" tracking -- so the real witness is the bot's own packet stream: `tools/probe-client.cjs`
now logs a `level_chunk` counter every 2s. On both builds the count was flat at 393 (the bot's full view)
for over 40 seconds leading up to the console command, then jumped to exactly 786 = 2x393 within the next
2-second sample -- the server resent the bot's entire chunk view a second time, which is exactly what
clearing the "already sent" tracking should cause. Fetched from `chunksNN.bot.log` directly (not part of
`peek.ps1`'s default filter, which only reads the server's own `.out`/`.err`).

## `MobEffect::getById`: the registry array, inlined everywhere (2026-09-28)

`Actor.hasEffect(id)` / `getEffect(id)` go through `MobEffect.create(id)` (`?getById@MobEffect@@SAPEAV1@I@Z`), which
had no address on either build, so both threw before reaching the shipped `_getEffect`.

**2024.** `getById` (1.21.3.01 `0x18ae920`) is a 22-byte leaf: `cmpl $0x24,%ecx; ja -> 0; leaq mMobEffects(%rip);
movq (%rcx,%rax,8),%rax`. The array is `std::unique_ptr<MobEffect> MobEffect::mMobEffects[]` (`0x3408b50`, 37
slots). `getId` (`0x267c00`) is `movl 8(%rcx),%eax`.

**1.26 has no out-of-line copy of either.** A raw scan of `.text` for every RIP-relative reference to the array
(raw bytes, so leaves outside `.pdata` count too) gives 40 `0xc981670`: 69 sites in 56 functions, and 51 `0xccb5c78`:
71 sites in 57 functions plus one `.pdata`-less leaf that copies a byte of the effect. The smallest referring function
is 74 bytes on both builds, and none is a `getById`. The inlined lookup is the same everywhere and one element longer
than 2024: an unsigned `cmpq $0x25; ja`, then the 8-byte slot, then a null test. Examples: 40 `0xdf9c30` / 51
`0xd39660` (+0x12e, the walk over the effects vector, stride 0x88 / 0x90) and 51 `0x1c56770`. 38 slots is also
Endstone's `MobEffect::NUM_EFFECTS` (`mob_effect.h`, Apache-2.0), an independent second source. The 2024 byte-shape scan
for the leaf finds it in 1.21.3.01 and nothing in either 1.26 build. 51 `0x1a6a380` passes `mMobEffects[id]` straight
to `Actor::getEffect(const MobEffect&)`.

**What ships.**
- The array is an address, under the 2024 decoration: `?mMobEffects@MobEffect@@2PAV?$unique_ptr@...@std@@A`. MSVC drops
  an array data member's bound from the name, so the extra slot does not change it. It is dynamically initialised, so
  it has to be an address and cannot be a constant.
- `layouts.MobEffect` `{id: 8, count: 38}`, on both builds.
- `getById` and `getId` are `derived()` (`bdsx/bds/engine/mobeffect.ts` `mobEffectById`):
  - `getById` returns null for an id at or above `count`, compared unsigned, and for an empty slot;
  - `getId` reads +8.
- `MobEffect.create` is now typed `MobEffect | null`. `Actor.hasEffect` / `getEffect` return false / null for an id
  with no registered effect, where 2024 would have read through a null pointer.

**Executed 2026-09-28, both builds.** `verify-pair.mjs` ran `layout40` and `layout51`, and each came out 36 PASS / 0 FAIL
with tsc 0, exit 0 and `Quit correctly` (`work/host-runs/layout40-20260928-050239.txt`, `layout51-...`). The log shows
`?getById@MobEffect@@...: no address in this build, using bdsx's own implementation`, and the same for `getId`.
`effidprobe` found:
- `MobEffect.create(1).getId() === 1`, and Speed twice is the same object;
- ids 1..37 are 37 distinct registered MobEffects, and `getId()` and the `id` field both equal the index for each;
- ids 38, 39, 1000, -1 and 0x7fffffff are null;
- slot 0 is not empty: it holds a MobEffect whose id is 0 (UNKNOWN_EFFECT).

The new `effprobe <step> public` lines use the public API:
- before any effect: `hasEffect(Speed)` false and `getEffect(Speed)` null;
- after `effect @a speed 30 1`: true, with amplifier 1;
- after `effect @a speed 20 2 true`: amplifier 2;
- after `removeEffect` and after `removeAllEffects`: false / null again;
- `hasEffect(Haste)` false throughout;
- `hasEffect(1000)` false and `getEffect(-1)` null.

Still open next to it: `MobEffectInstance::getComponentName` reads the `HashedString` at 2024 +0x100 of
`mMobEffects[id]`. bdsx's `MobEffect` fields after `id` (`descriptionId` 0x20, `resourceName` 0x50, `componentName`
0x98) are 2024 offsets that nothing on 1.26 has checked. With `MobEffect.create` working, the 37 live objects can be read
directly. (Closed in the next section: the offsets were not even 2024's.)

## `MobEffect`'s fields and `getComponentName` (2026-09-28)

The paragraph above left two things open: `MobEffectInstance::getComponentName` had no address, and bdsx's `MobEffect`
name fields had never been checked on 1.26. Both are closed.

**The fields come from the constructor, not from a dump.** The only `lea` user of `"minecraft:mobspell_emitter"` is
the `MobEffect` constructor on each build: 40 `0x2c753d0` and 51 `0x1c4d480`. Its stores match 2024's
(1.21.3.01 `0x189e390`) offset for offset:

| offset | store | 2024 name |
|---|---|---|
| +0x8 / +0xc | id, harmful | `mId` |
| +0x10 | colour (4 floats) | |
| +0x20 / +0x50 | `HashedString` `minecraft:mobspell_emitter` / `_ambient` | particle ids |
| +0x80 | the 4th argument, a string | `getDescriptionId` = `leaq 0x80(%rcx)` |
| +0xa0 | icon int | |
| +0xa4 | 0.5 if harmful, else 1.0 | duration modifier |
| +0xa8 | byte 0 | |
| +0xb0 | the 3rd argument, a string | `getResourceName` = `leaq 0xb0(%rcx)` |
| +0xd0 | the stack string | icon name |
| +0xf0 | the particles byte | |
| +0x100 | `HashedString("minecraft:effect." + 3rd argument)` | what `getComponentName` returns |

bdsx's old offsets (`descriptionId` 0x20, `resourceName` 0x50, `componentName` 0x98) were older than 2024. They were
out by the two particle `HashedString`s (0x60), plus 8 for the byte at +0xf8.

Two readers on 1.26 confirm the offsets:
- **`getComponentName`** is inlined into `Mob::hasComponent(const HashedString&)` (40 `0x23f79e0`, 51 `0x29e31d0`),
  once per element of the effects vector (stride 0x88 / 0x90). The inlined code is `cmpl $0x25; ja default;
  movq (mMobEffects,%rax,8); leaq 0x100(%rax); testq; cmoveq default`. That is 2024's 22-byte leaf with the bound one
  higher.
- **The description.** The hover-text helper (40 `0x2c7f3a0`, 51 `0x1c56890`; it is called from
  `OminousBottleItem::appendFormattedHovertext`) takes `mMobEffects[id] + 0x80` and passes it to the I18n vtable.

`default` is `HashedString::defaultErrorValue` (40 `0xc8bf108`, 51 `0xcc27060`), shipped under its 2024 name. The
second route to that address is its dynamic initializer (40 `0x1f0840`, 51 `0x28d720`). The initializer has 2024's
shape (`0xb4bd0`): it copies the empty `HashedString`, then registers an atexit destructor.

**What ships.**
- In `layouts.MobEffect`, on both builds: `descriptionId` 0x80, `icon` 0xa0, `durationModifier` 0xa4, `resourceName`
  0xb0, `iconName` 0xd0, `showParticles` 0xf0 and `componentName` 0x100. bdsx's `MobEffect` reads each of them through
  `engineLayout`.
- The byte at +0xa8 (bdsx's `disabled`) read false for all 38 effects. That is one side only, so it is not in the
  table: bdsx keeps the 2024 offset as its fallback.
- `getComponentName` is `derived()` in `engine/mobeffect.ts` (`mobEffectInstanceComponentName`). It reads the
  instance's +0 as the id and returns `getById`'s slot + 0x100, or `defaultErrorValue`.
- `MobEffectIds` gains 31..37, named from the resource names read back from the registry: `TrialOmen`, `WindCharged`,
  `Weaving`, `Oozing`, `Infested`, `RaidOmen` and `BreathOfTheNautilus`.

**Executed 2026-09-28, both builds.** `verify-pair.mjs` ran `layout40` and `layout51`, and each came out 41 PASS / 0 FAIL
with tsc 0, exit 0 and `Quit correctly` (`work/host-runs/layout40-20260928-085816.txt`, `layout51-...`). The log shows
`getComponentName ... no address in this build, using bdsx's own implementation`. `effnameprobe` found:
- **`dump`.** Ids 1..37 have distinct, non-empty `resourceName`s, and every `componentName` is `minecraft:effect.` +
  that name, with the FNV-1 hash `computeHashOf` gives.
  - Speed is `speed` / `potion.moveSpeed` / `minecraft:effect.speed`, not harmful.
  - 28..37 have `effect.*` description ids. 37's is `effect.customNautilus`.
  - `iconName` is empty except `fatal_poison` (`poison`).
  - `showParticles` is false only for `bad_omen` and `darkness`.
  - Slot 0's name is `empty`.
- **`none`.** An allocated instance with id 99 gets `defaultErrorValue` back itself, and its string is `''`.
- **`speed` and `new WindCharged`.** `getEffect(1)` after `effect @a speed 30 1` reads `minecraft:effect.speed`.
  `getEffect(32)` after `effect @a wind_charged 30 0` reads `minecraft:effect.wind_charged`, and so does
  `MobEffect.create(32).resourceName`.

The first pair (`085128`) was identical except for one FAIL on both builds. That FAIL was the probe's own wrong
expectation, that `durationModifier` stays at the constructor's value. Registration changes seven of them afterwards:
`haste` becomes 1.5, and `nausea`, `regeneration`, `blindness`, `poison`, `wither` and `fatal_poison` become 0.25. The
check is now an INFO line that records them, and those values are the field's second side.

## MobEffectInstance's constructor on 1.26 (2026-09-29)

`MobEffectInstance.create` threw on both builds, because `??0MobEffectInstance@@QEAA@IHH_N00@Z` has no address.
`getAmplifier` threw as well. 2024's constructor (`0x189e7d0`, a leaf) stores id +0 and duration +4, the difficulty
durations as -1, amplifier +0x14, then display +0x18, ambient +0x19, the counter flag +0x1a (0) and visible +0x1b. The
visible flag is ANDed with `mMobEffects[id]`'s showParticles. After that comes the factor data with 1.0f.

**1.26 inlines it.** The one function on each build that uses both JSON keys `"amplifier"` and
`"display_on_screen_animation"` builds an instance from JSON (40 `0x2414720`, 51 `0x29fc0a0`; the keys read are
"amplifier", "ambient", "visible", "display_on_screen_animation", "duration"). Its constructor stores:

- id +0 and duration +4
- 0 in the engaged flags of the three `optional` difficulty durations (+0xc/+0x14/+0x1c)
- amplifier +0x20
- display +0x24
- **0 at +0x25** (`is_counter_paused_this_tick_`)
- **ambient +0x26**
- visible AND `mMobEffects[id]+0xf0` at +0x27

That is Endstone `mob_effect_instance.h`'s order. **Ambient and the counter flag swapped places from 2024**, and bdsx's
class had kept 2024's order, so `ambient` read the counter flag. It is now declared with explicit offsets. 1.26.51
stores one more byte, 0 at +0x28, and its factor data starts at +0x30 instead of +0x28. In both builds the factor data
is padding 0, start 0, target 1.0f and current 0, followed by a `std::function` (impl pointer at +0x70 / +0x78) and
two zeroed fields. The factor data's offset ships as `layouts.MobEffectInstance.factorData` (40 / 48).

bdsx's constructor is `derived()` (`engine/mobeffect.ts`). It zeroes the instance (the build's size), then writes those
fields. `getAmplifier` reads the amplifier at +0x20, which is execution-confirmed.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/effc40.ps1 tools/host/drivers/effc51.ps1`,
`actor-layout-probe.ts` `effcreate`, **9 PASS / 0 FAIL on each build** together with `itemprobe flags`, tsc 0, exit 0,
`Quit correctly`; `work/host-runs/effc40-20260929-150116.txt`, `effc51-...`). `MobEffectInstance.create(Haste, 600, 2,
ambient, no particles)` gave:

- **The engine's own `save()`**: Id 3, Amplifier 2, Duration 600 (and DurationEasy/Normal/Hard 600), Ambient 1,
  ShowParticles 0, DisplayOnScreenTextureAnimation 0, and FactorCalculationData with factor_target 1 and
  padding_duration 0.
- **`Actor::addEffect`** gave it to the player. `getEffect(Haste)` then read amplifier 2, ambient, no particles, and
  `getAmplifier()` 2.

The first run (`effc40/51-20260929-145801`) wrote the 1.0f through the fallback offset, because the layout was not in the
table yet. The engine saved `padding_duration` 1065353216, the bits of 1.0f, which shows the save really reads what
bdsx wrote.

## MobEffect.disabled: dropped (2026-09-30)

`engine-deps --missing` listed `MobEffect.disabled` (bdsx's byte at +0xa8) as the one layout with no entry on either build. The byte is the
constructor's zero store between `durationModifier` (+0xa4) and `resourceName` (+0xb0), it read false for all 38 effects on both builds
(one side only, so never a table entry), Endstone's `mob_effect.h` declares no such member, and nothing in `bdsx/` or its examples read it.
The field is removed from `bdsx/bds/effects.ts` (bdsx `47ff4ec4`). Not claimed: that no 1.26 code reads +0xa8, which was not searched
for in the binary. If a reader turns up, re-add it through `engineLayout` with a value that varies.
Executed 2026-09-30 (`effdis40`/`effdis51`, `verify-pair.mjs`): tsc 0, `effnameprobe dump` and Speed PASS on both builds, so the class still
loads and the other MobEffect layouts are unaffected. `engine-deps --missing`: 0 on both builds.

## `tryGetComponent`: the EnTT components (2026-09-30)

Eight `Actor::tryGetComponent<X>` names had no 1.26 address (every caller inlined the lookup) and thrown on both builds. They are `derived()`
over `enttComponent(actor, componentHash("X"), size)` (`bdsx/bds/implements.ts`, bdsx `3a0badfd`). **The size is the packed stride**: the
multiply after the sparse lookup. Read it only from a function that holds **one** lookup (`grep -c 'andl $0x7f'` = 1 in `disas-exact`):
in a function with two lookups the first `andl $0x7f` can belong to another component. That is how `PhysicsComponent` went wrong: its
users also read `ActorDataFlagComponent` (24 bytes, bit 49 = HasGravity), and the 24 was that one's.

| component | size (both builds) | evidence (single-lookup users) |
|---|---|---|
| `ProjectileComponent` | 0x300 | 40 `0x93b7a90` (`leaq (r,r,2); shll 8`), 51 `0x9bcded0` |
| `RideableComponent` | 0xa8 | `imulq $0xa8`: 40 `0xf92150`, `0xe10670`; 51 `0xeae9a0`, `0xd50710` |
| `NpcComponent` | 0x178 | `imulq $0x178`, six users on each build |
| `ShooterComponent` | 0xe0 | 40 `0x9edf0f0`, 51 `0x9fe7270` |
| `ConditionalBandwidthOptimizationComponent` | 0xd0 | 40 `0xaa53c0`, 51 `0x13e7600` |
| `DamageSensorComponent` | 0x28 | `leaq (r,r,4); leaq (b,r,8)`, three users on each build |
| `NameableComponent` | 2 | `addl r,r` / `leaq (b,i,2)`, five users on each build |
| `PhysicsComponent` | **empty type** | every user asks `contains` and hands on one static address (40 `0xf8b7c0` passes `0xc8dd844`) |

`PhysicsComponent` is therefore presence plus one shared pointer (`enttHas`); the first session walked a packed page it does not have
(`Access Violation: 0x0` on every entity, both builds). Layouts ship as `offsets.<Component>.size` in
`candidates-instances-<v>.json`; `engine-deps --missing` is 0 on both builds.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/comp40.ps1 tools/host/drivers/comp51.ps1`, `tools/component-probe.ts`
`compprobe`, **17 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`; `work/host-runs/comp40-20260930-110608.txt`, `comp51-20260930-110608.txt`).
The probe summons 19 entity types (16 spawn; `ender_pearl`, `painting`, `villager_v2` do not), and the matrix is **identical on the two builds**:

- projectile: arrow, snowball, egg only. shooter: skeleton, snow_golem only. npc: the `npc` entity only. Vanilla definitions fix all three.
- rideable: zombie, cow, pig, horse, boat, minecart; not skeleton, npc, arrow, snowball, armor_stand, iron_golem, lightning_bolt, xp_orb.
  **The int at +0 is the seat count** and reads pig 1, minecart 1, boat 2, horse 1 (zombie 1, cow 1) on both builds -- values the definitions
  fix, through six different entities, so pointer, stride and offset are all right. My expectation that zombie and cow hold no rideable
  was not from a definition (I had no source); their seat count is a sane 1, so it is recorded as an observation, not a check.
- nameable 9 of 16, damage_sensor 4 (pig, snow_golem, npc, iron_golem), conditional_bandwidth 15 (all but npc), physics 15 (not lightning_bolt):
  **both answers appear, but there is no vanilla truth or value behind them**, so their evidence is the size and the two answers only.
- Pointers are the same on two calls, distinct per entity (physics: one shared pointer by design), readable.

Members on top, all `derived()`:

- `ProjectileComponent::setOwnerId` writes the id at +8 (2024 `mov %rdx,8(%rcx)`; 1.26's inlined copies, 40 `0x12542d0` / 51 `0x1ccf050`, store
  `getOrCreateUniqueID` at `0x8(component)`). Read back at +8 on an arrow: equal. That shows the write lands in the component, not that +8 is
  what the engine reads as the owner (the same offset both ways).
- `PhysicsComponent::setHasCollision` is `actor.setStatusFlag(HasCollision, v)` (2024 `actor->vftable[1](0x30, v)`). A zombie read true, false after,
  true after: the engine writes, bdsx reads.
- `PhysicsComponent::setAffectedByGravity(flags, dirty, v)`: 1.26's `setActorFlag` takes the EntityContext and looks up ActorDataDirtyFlagsComponent
  (`0xc131f6a8`) and ActorDataFlagComponent (`0xc67426f3`), 24 bytes each; what follows is a bit set/clear in word N/64 and `orb $1,(dirty)` for flags
  under 64 (`$0x10,0xb` / `$8,0x11` above) -- 40 `0x2e7c90c-0x2e7c959`, 51 `0x2535ff9-0x25360b9`. bdsx writes that over the two pointers. On a zombie the
  engine's own `setStatusFlag(HasGravity)` and bdsx's call left the same word (`0001000000480000` off, `0003000000480000` on) on both builds, and the
  dirty bit cleared by hand came back.
- `RideableComponent::areSeatsFull(ride)` = the ride's VehicleComponent passengers (vector, stride 16) >= the int at +0 (the core of canAddPassenger reads
  the same pair: 40 `0x1aff9d0`, 51 `0x241ffa0`). A **fresh boat** (2 seats) with 0, 1 and 2 riders answered false/false/true where the riders were
  counted the other way round (each rider's own `getVehicle`, PassengerComponent); a minecart (1 seat) false empty and true with a zombie; empty pig false.
  The `ride` command would not seat a player on a saddle-less pig (INFO, no verdict).

**Not explained**: with the *first* boat, after the player had ridden it, `ride @a stop_riding` and a second `start_riding` in the same tick, the riders
counted by vehicle were 0/0/1 while `areSeatsFull` said false/false/true (a remount is probably refused, and the passenger vector may keep the entry). The
fresh-boat run agreed with the count 0/1/2, which is what the probe now asserts. Which side was stale in the first case was not looked at.

Not done, and why (all but `nameEntity` were done later the same day: last section): `DamageSensorComponent::isFatal` (2024 `movzbl 4(%rcx)` is identical-code-folded with 25 other bodies, and 1.26's component is 0x28
bytes with a trigger vector at +0x10; no reader of a fatal flag was found); `NameableComponent::nameEntity` (2024 = setNameTag + setNameTagVisible +
setPersistent + name_actions events through `NameableDefinition`; `Actor::setPersistent` and `initParams` have no 1.26 address); `RideableComponent::pullInEntity`
(a 400-byte body over `RideableComponentHelpers` state providers); `ShooterComponent::_shootProjectile` (needs `ProjectileFactory::shootProjectileFromDefinition`,
not resolved); `PushableComponent` (**no such component in 1.26**: done 2026-09-30 as the pair, next section).

## Pushable: the 1.26 split (2026-09-30)

**Decision (user, 2026-09-30):** bdsx's API follows the engine and exposes both halves rather than mapping one onto the other.
`PushableComponent` and the `"minecraft:pushable"` key are gone (`data/dropped.json`: its `tryGetComponent` and both `push`
overloads); in their place `tryGetComponent("minecraft:pushable_by_entity")` gives a `PushableByEntityComponent` and
`tryGetComponent("minecraft:pushable_by_block")` a `PushableByBlockComponent` (`bdsx/bds/components.ts`, `engine/pushable.ts`). The
keys are the engine's own: the 1.26 vanilla packs use `"minecraft:pushable_by_entity"` / `"minecraft:pushable_by_block"` as entity
components, and older pack files' `"minecraft:pushable" {is_pushable, is_pushable_by_piston}` land on the same pair.

**The two components.** 2024's one component held `is_pushable` (+0) and `is_pushable_by_piston` (+1) as bytes; the 2024 `push(Vec3)`
began with `cmpb $0,(%rcx)` on the first. In 1.26:

| | fnv1a | what it is | evidence |
|---|---|---|---|
| `PushableByEntityComponent` | `0xe0f57b82` | 0x28-byte element, present while the entity can be pushed by entities | emplace-from-definition 40 `0x1a416a0` / 51 `0x1e519d0` (one lookup, `leaq (r,r,4); shll 3`), remove 40 `0x1a41780`; its first 0x18 bytes are a vector of 0x80-byte presets (the pack's `presets`: `filters` + `push_mode`) |
| `PushableByBlockComponent` | `0xdc5e610` | empty tag, present while pistons can push it | get_or_emplace 40 `0xf8c860` / 51 `0xea93a0` passes no payload; `Mob::knockback`, the damage loop 40 `0x2383f90` only ask presence |

bdsx returns the element for the first and, as for `PhysicsComponent`, one shared stand-in pointer for the second.

**The two pushes lost their component.** Both 2024 members are free functions over the actor in 1.26, so they ship under `bdsx:` keys:

- `bdsx:Pushable::push(Actor&,Vec3 const&)`, 40 `0x2cf33d0` / 51 `0x2fa2f30`: 2024 `0x63ccf0` without the component byte test -- the
  boat/minecart branch (types 0x53/0x58), else two actor checks and the state vector's posDelta (+0x18) `+= vec`. The two builds'
  disassembly is the same but for one vtable slot (0x458/0x450).
- `bdsx:Pushable::push(Actor&,Actor&,bool)`, 40 `0x2cf1f50` / 51 `0x2fa1ab0`: 2024 `0x63c770` with `this` dropped (owner rcx, other rdx,
  pushSelfOnly r8b). skipPush (40 `0x2cf2540`: client side, either actor riding, ...), the owner's PushableByEntityComponent, then a
  **rule** (40 `0x2cf28e0`: the first preset whose filters match the other actor, else a default from level settings) whose mode byte
  (+0x40, 0 = none) picks one of four push-vector functions, with a distance window (+0x48 min, +0x4c max; `+0x50` asks for overlapping
  boxes). setPushedBy, push(owner, v), and -- when pushSelfOnly is false (2024 and 1.26 branch the same way) -- the other. Same code on
  both builds but for one vtable slot (0x3e8/0x3e0). Called by `Mob::pushActors` after the other's presence test.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/push40.ps1 tools/host/drivers/push51.ps1`, `tools/component-probe.ts`
`pushprobe` / `pushprobe2` / `pushprobe3`, **8 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/push40-20260930-124253.txt`, `push51-20260930-124253.txt`):

- The matrix against the packs, identical on the two builds: both components on zombie, pig, cow, boat, minecart, iron_golem, snowball
  and a standing camel; `pushable_by_block` only on armor_stand, arrow, xp_orb and the player; neither on shulker, bat, vex, npc,
  lightning_bolt. The expected values are the newest pack file of each entity on the host (sorted by version, not by name -- the first
  run sorted by name, read the 1.21.130 camel, and called a correct `1` wrong).
- One entity, both answers: the camel's `pushable_by_entity` sits in its `camel_standing` group; `event entity ... start_sitting_adult`
  swaps in `camel_sitting` and the answer goes 11 -> 01 one command later (the swap is not visible in the same call). Standing it again
  gave 11 in all three runs on 40 and in two of three on 51 (once 01: 51's camel.json is not readable on the host, so why is not
  known), so that step is INFO.
- `push(actor, vec)` on a zombie moves its posDelta by exactly (0.25, 0.5, -0.125); a zero vector leaves it alone.
- `push(owner, other, pushSelfOnly)` on frozen pig pairs (slowness 255): every pair that moved, moved the owner away from the other,
  and the other away from the owner exactly when pushSelfOnly was false (equal and opposite, e.g. 0.0082 / 0.0082 at 0.3). **The window
  differs by build**: overlapping pigs (0.3 apart) are pushed on both; 2 and 3 blocks apart only on 40. Pigs summoned 0.4/0.8 apart had
  already been pushed apart by the engine to ~0.95 on 51 (pigs are 0.9 wide) before the check, which is what gave the overlap reading.
  Not decoded: the rule's field values per build and which level setting picks the default rule.

## NavigationComponent: seventeen names, no address (2026-09-30)

All on both builds by `derived()` through `bdsx/bds/engine/navigation.ts`: `tryGetComponent`, `getAvoidSun`, `getCanFloat`,
`getCanPathOverLava`, `setAvoidSun`, `setAvoidWater`, `setCanFloat`, `getSpeed`, `setSpeed`, `getLastStuckCheckPosition`, `isStuck`,
`getMaxDistance`, `isDone`, `stop`, `setPath`, and the two `createPath`. The merged tables carry two other `NavigationComponent` names
(`getBlocksToAvoid`, `getPath`); `getPath`'s 40 address `0x3f7e480` is `movzbl 0x20(%rcx)`, not a path getter (not a bdsx name, left alone).

**The component** is an EnTT element (hash fnv1a "NavigationComponent" = `0xbb725ebe`) of **0x60 bytes on both builds** (2024: 0x70): every
user of the hash (40: 305 functions, 51: 306) indexes the packed page with `leaq (r,r,2); shll $5` (40 `0x8896f30`, 51 `0x8911c50`).
A live dump of six mobs (`tools/nav-probe.ts` `navprobe dump`, both builds, raw bytes alike apart from pointers and padding):

| offset | what | pinned by |
|---|---|---|
| +0x00 u16 | flags: bit 2 avoid_sun, 3 avoid_water, 5 can_path_over_water (bdsx `canFloat`), 6 can_path_over_lava | mobs against the packs' JSON (below) |
| +0x04 / +0x0c i32 | a tick and the tick of the last stuck check; `isStuck` = difference > t | 2024's body minus 0x10; `0x9f` on a zombie and a pig read in one tick |
| +0x14 f32 | speed | chasing zombie 1.0, spider and strider 0.8 (their goals set it) |
| +0x1c Vec3 | last stuck check position | a zombie's, back where it stood; a pig held exactly its summon point `33.5, 68, 20.5` on both builds |
| +0x50 / +0x58 | the PathNavigation object / the owned `Path` (null when idle) | vptr into the image / heap pointer on a chasing zombie |

2024 had the four flags as bytes at +2/+3/+5/+6; 1.26 packed them into one word **with the same bit numbers** and every later field
moved 0x10 closer (2024 +0x14/+0x1c/+0x24/+0x2c/+0x60/+0x68). **The bit assignment is a differential:** the packs (host `behavior_packs/
vanilla*/entities`) give zombie {can_break_doors, is_amphibious, can_pass_doors, can_walk}, pig {avoid_damage_blocks, avoid_water,
can_path_over_water}, skeleton {avoid_sun, is_amphibious, avoid_water}, spider (climb) {can_path_over_water}, chicken
{avoid_damage_blocks, can_path_over_water}, strider {can_path_over_lava, avoid_water, can_sink: false, can_walk_in_lava}; the words read
`0x3900 / 0x1929 / 0x390c / 0x1920 / 0x1921 / 0x09c8`. Bit 2 is on only for the skeleton, bit 3 for pig/skeleton/strider, bit 5 for
pig/chicken/spider, bit 6 only for the strider (bit 12 is missing exactly on the strider: `can_sink`). The description parser (40
`0x64b5170`, the JSON keys) lists its fields in a different order: its offsets are the description's, not the component's.

**The three that ran path code** are slots of the navigation object at +0x50 (GroundPathNavigation 40 `0xa626fb0` / 51 `0xa746c20`,
the spider's climb navigation 40 `0xa6c2e60` / 51 `0xa79b890`), 2024's numbers, read by body on both builds: **slot 9 = `stop(NavigationComponent&,
Mob&)`** (40 `0x254a820` / 51 `0x5974a90`: `[rdx+0x58] = null`, delete the old Path -- vector storage with the `[-8]` adjustment from 0x1000 bytes, then
`operator delete(p, 0x28)` -- one entt lookup), **slot 4 = `createPath(Mob&, Actor&)`** (40 `0x254a7b0` / 51 `0x5974a00`) and **slot 5 = `createPath(Mob&, Vec3
const&)`** (40 `0x254a6f0` / 51 `0x59748b0`): (nav, sret, component, mob, target), a slot-11 test on the mob first, null in the return slot on failure.
The `Path` is 0x28 bytes: node vector begin/end/capacity at +0/+8/+0x10, cursor +0x18, nodes of 0x10 (40 zombie 0xa0 bytes = 10 nodes,
cursor 3; 51 zombie 0x70 = 7 nodes, cursor 6); there is no out-of-line `Path::isDone`, so `isDone` is 2024's body over that shape. bdsx's
2024 declarations returned `Path.ref()` for a `unique_ptr` in a hidden pointer, which with the arguments shifted would have taken the actor for the
return slot; bdsx now passes an 8-byte slot. `setPath` swaps the pointer and frees the old Path (`msAlloc.deallocate` twice, slot 9's tail);
a Path `createPath` returns belongs to the caller -- give it to `setPath`.

**Execution** (2026-09-30, `navprobe check`, drivers `nav40/51.ps1`, `verify-pair.mjs`; night, difficulty normal, six mobs): **40 20 PASS / 0
FAIL, 51 21 PASS / 0 FAIL**, tsc 0, exit 0, `Quit correctly`. All 24 flag values equal the pack's; the three setters move the word by exactly their bit
(`0x3900 -> 0x3904 / 0x3908 / 0x3920`) and restore it; `setSpeed(2.5)` reads back 2.5 and raw +0x14 is 2.5; `isStuck(d-1)` true, `isStuck(d)`
and `isStuck(d+1000)` false; `getMaxDistance` = `Actor.getAttribute(FollowRange)` (16 on a 51 zombie, 32.35 on a 40 zombie). Engine paths:
`createPath(zombie, Vec3)` gives 6-7 nodes ending within a block of the target (51: last node `36,66,18` for target block `36,66,18`),
`createPath(zombie, player)` 5-23 nodes ending on the player's block; `setPath` puts exactly that pointer in the component (`isDone` false);
the second `createPath` + `setPath` frees the first path (engine-built, freed by bdsx), `stop` frees the second (bdsx-installed, freed by the
engine): pointer null, `isDone` true, no crash, clean shutdown. **Not claimed:** `+4`'s name (a per-mob tick counter is a guess), and the
last-stuck position is a snapshot (within 12 blocks of where the mob is), all zero for a mob that never walked (40's pig, first run). The first two runs
had three probe FAILs that were the probe's own assumptions (an idle pig's zeros; a snapshot compared at 3 blocks; a target's height against 40's
terrain) -- the engine values did not change between runs. Table entries: `layouts.NavigationComponent` and `layouts.PathNavigation` in
`data/candidates-instances-<v>.json`.

## The component leftovers: isFatal, pullInEntity, _shootProjectile (2026-09-30)

Three of the four leftovers of "`tryGetComponent`: the EnTT components" closed, each on both builds by `tools/component-probe.ts` (`dsprobe`,
`pullprobe`, `shootprobe`, tag `[comp2]`, drivers `comp2-40/51.ps1`, **8 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/comp2-40-20260930-132101.txt`, `comp2-51-20260930-132101.txt`).

- **`DamageSensorComponent::isFatal`** is `derived()` over one byte, `layouts.DamageSensorComponent.fatal` = 4. No 1.26 reader was needed: Endstone's
  `damage_sensor_component.h` lays the component out as `int damage_amount_ +0, bool damage_is_fatal_ +4, int damage_cause_ +8, vector triggers_ +0x10`,
  which is 2024's `movzbl 4(%rcx)` and the 0x28 element with the trigger vector at +0x10 found earlier. The probe reads all three fields around a hit:
  fresh iron golem and pig `+0 0 +4 0 +8 -1`; the golem after `damage 5` `+0 5 +4 0 +8 2` (health 95, not fatal); the pig after `damage 1000`
  `+0 1000 +4 1 +8 2` (fatal). Identical on 40 and 51. The int at +0 equals the damage dealt and the byte flips only for the lethal hit, so the offset
  cannot be a coincidence.
- **`RideableComponent::pullInEntity`** has an address, found by the callers of the core that `canAddPassenger` also calls (40 `0x1aff9d0`, 51 `0x241f7a0`),
  not by name: **40 `0x1b00340` / 51 `0x241fde0`**, 440 bytes, same body on both. It is 2024's `0x63c4d0` line for line: `cmpb $1, 0x58(component)`
  (pull_in_entities), rider vtable slot `0x2f8`/`0x2f0` (canBePulledIntoVehicle), float `+0x5c` against the rider's AABB width, rider not riding, not leashed,
  the canAddPassenger core, then `rider->startRiding(ride, false)` (Actor vtable `0xd8`). The prototype is unchanged (component, ride, rider), so bdsx's
  binding stays. Executed: a zombie beside a minecart (flag byte 1, float 0) returned true and its `getVehicle()` became the minecart; the same call again
  returned false (already aboard); a pig (flag 0) refused a zombie, false and no vehicle.
- **`ShooterComponent::_shootProjectile`**: **40 `0x1b13ab0` / 51 `0x24327b0`**, 282 bytes, found as the caller of `Actor::hasType` with `$0x100` that is
  called twice by the shooting routine (`0x1b138b0` / `0x24324f0`). 2024's `0x626450` again: `owner.hasType(0x100)` else nothing, the ILevel virtual (slot
  `0xb8`, was `0x90`) for the ProjectileFactory, `shootProjectileFromDefinition` (40 `0x1ac4b40`, 51 `0x24b75d0`, called with the same argument shape),
  `getAttachPos(2)`, `playSynchronizedSound` with the int at `+0xd4`. **The leftover note said this needed `shootProjectileFromDefinition` resolved; it does
  not**: the function is called whole, its callee is inside it. Executed: a snow golem produced one `minecraft:snowball`, a skeleton one
  `minecraft:arrow`, and each projectile's `ProjectileComponent` +8 equalled the shooter's unique id (that also confirms the +8 owner offset the
  earlier `setOwnerId` only wrote); a boat as the owner (not a Mob) produced none. The component's float at +0 read 0 for both mobs, so it is not a power
  the vanilla definitions set (unexplained; the projectiles were spawned).

`NameableComponent::nameEntity` is done, see the next section.

## `NameableComponent::nameEntity`: the address was inside the item that names an entity (2026-09-30)

**Address: 40 `0x2d8e0d0` / 51 `0x23f1a60`**, under **`bdsx:NameableComponent::nameEntity`** (not the 2024 decoration: the name is now a
`Bedrock::Safety::RedactableString const&`, the 0x48-byte class of `findings-containers.md` section 25). Found the way the leftover note
suggested, from `bdsx:EntityPlacerItemComponent::_setActorCustomName` (40 `0x3f77080`, 51 `0x302a020`): its last call is
`(rcx = the NameableComponent element it just looked up, rdx = the actor, r8 = the RedactableString the item's getCustomName filled)`. The
earlier note ("no out-of-line copy") was wrong: it had looked for callers of `Actor::setNameTag` (`0xe0e800`, the `std::string` overload), and this
function calls the RedactableString overload (40 `0xe0d7b0`) instead. It has seven callers on 40 (eight on 51): `ActorPlacerItem::_useOn` and `dispense`,
`_setActorCustomName`, and four unnamed ones (2024 also had a `CommandUtils::nameEntity` caller and a lambda among its five).

The body is 2024's, with everything that 2024 had (`rcx` is never read: the component is an empty two-byte element, the definition is looked up
on the actor):
1. `setNameTag(actor, name)` (the RedactableString overload); `SynchedActorDataAccess::setActorFlag(entity, 0xe = CanShowName, true)`
   (2024's `setNameTagVisible`);
2. `getOrAddComponent` of the persistent flag (EnTT hash `0xfad8d24f`, `setPersistent`);
3. a `VariantParameterList` on the stack filled by an inlined `initParams`;
4. the `BossComponent` (hash `0xf54c2a4b`): when present, `RedactableString::operator=` (`0x970420`) into it and an update (`0x2460530`);
5. the actor's `NameableDefinition` (read through the actor's definition descriptor): **the name_actions loop, 128-byte entries
   (`subq $-0x80`), each a vector of 0x20-byte names compared with `memcmp` against the new name**; a match runs that action's trigger
   (`entry + 0x18`), no match runs the default trigger (`descriptor + 0x18`), both through `ActorDefinitionDescriptor::executeTrigger` (`0xde9060`).

So 1.26 has the loop and it is the function's tail; a `derived()` without it would not have been the function. bdsx's `nameEntity(actor, name)`
keeps its signature: it builds the RedactableString (`engine/blockactor.ts` `withRedactableString`, shared with `setCustomName`) and calls the
address. **The first try with the 2024 `std::string` argument killed the server** (a `std::string` read as a RedactableString: the crash was in the
string-grow path under the RedactableString `setNameTag`, with a garbage length); that is how the
prototype change was found.

**Executed** (`hname40`/`hname51` through `verify-pair.mjs`, `tools/component-probe.ts` `nameprobe`, tag `[comp2]`, **9 PASS / 0 FAIL on each build**,
tsc 0, exit 0, `Quit correctly`; `work/host-runs/hname40-20260930-155254.txt`, `hname51-20260930-155254.txt`). The oracle is the engine's own
`Actor::save()`: a vanilla vindicator's `minecraft:nameable` has `name_filter "Johnny"` -> event `minecraft:start_johnny` (adds the component group
`minecraft:vindicator_johnny`) and `default_trigger` -> `minecraft:stop_johnny` (removes it, adds `minecraft:default_targeting`), and the saved
`definitions` list shows the active groups. Identical on both builds:
- fresh vindicator: `["+minecraft:vindicator","+minecraft:default_targeting"]`, tag `""`, CanShowName false;
- `nameEntity(v2, "Bob")`: tag `Bob`, CanShowName true, and the default trigger ran (`default_targeting` listed twice, no johnny);
- `nameEntity(v, "Johnny")`: tag `Johnny`, definitions `[vindicator, default_targeting, vindicator_johnny]` -- **the name action fired**;
- `nameEntity(v, "Jack")` afterwards: johnny gone, `default_targeting` back (twice) -- **the default trigger fired**;
- `nameEntity(v2, "Johnny")` on the second vindicator: johnny in; a pig (component, no actions): tag `Piggy`, CanShowName true.

Not distinguished: the persistent flag (step 2). A summoned pig already saves `Persistent: 1` named or not (`{"_value":1}` both), so the probe cannot
tell whether nameEntity's `getOrAdd` did anything: that step rests on the body only.

**Unchanged and worth knowing:** `Actor::setNameTag` with a `std::string` (40 `0xe0e800`) and the RedactableString overload (`0xe0d7b0`) are two
functions; a caller that has a plain `std::string` uses the first.
