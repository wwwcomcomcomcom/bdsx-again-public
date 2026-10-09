# Accessors that are offsets, not functions

Done 2026-09-18, on 1.26.40.8. Step 3 of `next-steps.md`: the required
names whose body is a field access are shipped as the field, and bdsx
emits the body.

## Why they cannot be found

Of the 543 required non-virtual members that have a 2024 address, 208
have no `.pdata` entry: they touch no stack, so there is no unwind
record, and their bodies are a few bytes. `tools/leaf-accessors.mjs`
reads those bodies and finds **112 that are a field and nothing else**:

| kind | count | body |
|---|---|---|
| get | 61 | `mov rax,[rcx+X]; ret` (any width; `movzx`/`movsx` for narrow ones; `movss` for floats) |
| lea | 28 | `lea rax,[rcx+X]; ret` (a member returned by reference) |
| set | 21 | `mov [rcx+X],rdx; ret` |
| get-hidden | 2 | a 4-byte struct copied into the hidden return buffer |

The other 96 have a branch or a tail call and are functions in the
ordinary sense. The 112 are unfindable by construction: the bytes differ
from hundreds of other accessors by the offset alone, the linker folds
identical bodies, and there is no call edge to anchor on because every
caller inlines them. 193 of the 208 are `implements.ts` API surface;
2 are hook targets, which no thunk can serve.

## What ships instead

`symbols.json` carries an `accessors` map beside `symbols`: name ->
`{ kind, width, off, float?, sx?, zx? }`. On the bdsx side
(`revival` branch) `pdbcache.ts` parses it and `bds/symbols.ts`, when a
name has no address but has an accessor, emits the body with bdsx's own
assembler (the one that already builds hook trampolines) into executable
memory and returns that pointer. The calling convention is the accessor's
own (`this` in `rcx`, the value in `rdx`/`xmm1` for a setter, the hidden
buffer in `rdx`), so `makefunc` and every `proc[...]` site are unchanged;
`in proc` reports it present; `ProcHacker` never sees one because a name
with an accessor has no address, so hooking it is reported missing as
before. The 2024 offset is kept as `baselineOff` in the candidate file as
a prior; only the offset read on the target ships.

`tools/merge-symbols.mjs` copies `accessors` from
`data/candidates-instances-<v>.json`, drops any name that also has an
address (the address wins), and `make-table.mjs` writes the map. An
accessor counts as coverage only where it is in the table under its name;
the required count moved 254 -> 255 because the same runs named
`??_7CompoundTag@@6B@` (the tag every Block holds inline), and the 36
shipped accessors are counted separately.

## Where the 36 offsets came from

Two routes each, as everywhere:

| accessors | target offset | routes |
|---|---|---|
| `Actor::getLevel` | +0x1d8 | the Level pointer in the pig and the player; Endstone: `level_` after the `WeakRef<Dimension>` at +0x1c8 |
| `Player::getSupplies` | +0x5b8 | the `unique_ptr<PlayerInventory>` (its object holds the Inventory at +0xb8); Endstone field order |
| `Player::getGameMode` | +0xaa0 | the object replaced by `gamemode creative` |
| `Player::getName` | +0xbc0 | the one `bdsxprobe` in the object, laid out as a `std::string` (size 9 at +0xbd0, capacity 15 at +0xbd8) |
| `Minecraft::getCommands` | +0xb8 | `layouts.Minecraft.commands`, in use since the instances job |
| `Dimension::getBlockSourceFromMainChunkSource` | +0xf0 | the object slot 12 returned; Endstone `block_source_ // +240` |
| `Dimension::getChunkSource` | +0x1d8 | the 41-slot object that `BlockSource+0x28` (Endstone `chunk_source_`) also holds |
| `Dimension::getMinHeight`, `getHeight` | +0xc8, +0xca | int16 -64 and 320 in the overworld object, the baseline's own offsets |
| `Block::getSerializationId` | +0xf0 | the inline 11-slot tag every Block carries (which also named `CompoundTag`'s table) |
| `BlockActor::getPosition` | +0x8 | (29,68,20) in the chest's block actor; Endstone `position_ // +8` |
| `LevelData::getGameDifficulty` (+set) | +0x3b8 | **execution**: 1 > 0 > 3 > 2 > 1 under `difficulty peaceful/hard/normal/easy` |
| `LevelData::getRainLevel`, `getRainTime`, `getLightningLevel`, `getLightningTime` (+set) | +0x36c, +0x370, +0x374, +0x378 | **execution**: the float rose 0 > 0.17 > 0.57 > 0.97 > 1 after `weather rain` and fell after `clear`; the countdowns reset and tick down 40 per 40 ticks; the four keep the baseline's order |
| `CommandOutput::getType`, `getSuccessCount`; `CommandOutputMessage::getType`, `getMessageId`, `getParams`; `ItemStackBase::getUserData`; `Objective::getName`, `getDisplayName`; `IdentityDefinition` x4; `ScoreboardIdentityRef::getScoreboardId`; `Container::getContainerType`; `LayeredAbilities` x3 | baseline offsets | Endstone declares the offset or the field order explicitly and it equals the 2024 offset |

Checked on the live server (`tools/accessor-probe.ts`, driven by
`run-full.ps1 -Commands`): `Minecraft::getCommands` through the emitted
body returned the same pointer `launcher.ts` reads through `layouts`;
`LevelData::getGameDifficulty` read 1, then 3 after `difficulty hard`;
`getRainLevel` read 0, then 0.41 after `weather rain` with `getRainTime`
reset to 11,619. The full lifecycle ran clean with the plugin loaded.

## How an offset is read

`tools/reach-probe-launcher.js` grew `RP_WATCH`: the first sweep dumps an
object's bytes, later sweeps print the 8-byte words that changed, and the
console command issued between two sweeps names the field
(`docs/findings-reach.md` has the launcher). `RP_CALL` reaches objects
without a vtable too (LevelData is one). Reading the dump offline is
`indexOf` for a known value: a name, a position, a height range.

## What is left of the 112

- 74 accessors have no two-route offset yet. Most need an instance nobody
  holds (`StructureSettings` 20, `NavigationComponent` 8, `LevelChunk` 5,
  `MobEffectInstance`, `GameRule`) or a value to watch for (`Actor`'s
  seven `lastHurt*` fields: the watch caught no pig that survived long
  enough; `Player::isSpawned`, `getPlatform`, `getSpawnPosition`, where
  one candidate `(29,32767,14)` at +0x670 is one of two spawn fields).
  Endstone-only offsets that differ from the baseline (`GameRule` value
  moved from +4 to +8, `MobEffectInstance::amplifier_` to +0x20,
  `BlockActor::getType` +0x14) are one route each and not shipped; they
  are the first things a watch run there should confirm.
- `BlockLegacy::getDefaultState` is a live pointer to a `Block` at +0x240
  beside the permutation vector, one route.
- Nothing is shipped for 1.26.51.1: offsets move between builds
  (`Minecraft.commands` did), so each needs its own watch run there.
- The two hook targets among the leaves stay missing; a thunk is not a
  function in the binary.

## 1.26.51.1 (2026-09-18, night)

The same 36 minus three ship on this build, each again with two routes on
the build itself, from the rp51 run (`findings-reach.md`) and Endstone HEAD,
whose headers for these classes are unchanged from v0.11.7 (`diff` of
`objective.h`, `identity_definition.h`, `command_output.h`,
`layered_abilities.h`, `permissions_handler.h`, `item_stack_base.h` around
`user_data_`, `block.h`; `block_actor.h` grew by a member after `position_`):

| accessors | 1.26.51.1 | routes |
|---|---|---|
| `Actor::getLevel` | +0x1d8 | Player+0x1d8 is the ServerLevel; Endstone `level_`; the inlined read in `VirtualCommandOrigin(Actor&)` |
| `Player::getGameMode` | +0xaa0 | **execution**: the object swapped under `gamemode creative`, SurvivalMode -> GameMode |
| `Player::getSupplies` | +0x5b8 | the `unique_ptr<PlayerInventory>` whose object holds the 54-slot Inventory at +0xb8 |
| `Player::getName` | +0xbc0 | the one `bdsxprobe` in the dump, size 9 at +0xbd0, capacity 15 at +0xbd8 |
| `Minecraft::getCommands` | +0xc0 | `layouts.Minecraft.commands` on this build |
| `Dimension::getBlockSourceFromMainChunkSource`, `getChunkSource` | +0xf0, +0x1d8 | the BlockSource slot 12 returns, the 41-slot object BlockSource+0x28 also holds; Endstone `block_source_ // +240` |
| `Block::getSerializationId` | +0xf0 | the inline 11-slot tag in every placed block |
| `LevelData` (10) | +0x3b8, +0x36c, +0x370, +0x374, +0x378 | **execution**: 1 > 0 > 3 > 2 under `difficulty`, the rain float 0 > 1.0 after `weather rain`, lightning after `weather thunder`, both times counting down |
| the 17 Endstone-declared ones | as 1.26.40.8 | header unchanged + the 2024 offset |

Not shipped here: `BlockActor::getPosition` (Endstone HEAD says +8 but no
dump of a block actor was taken) and `Dimension::getMinHeight`/`getHeight`
(no dimension dump). Checked through the emitted bodies on the server
(`tools/accessor-probe.ts`): `Minecraft::getCommands` returned the
`layouts` pointer, `getGameDifficulty` 1 -> 3 under `difficulty hard`,
`getRainLevel` 0 -> 0.4 and `getLightningLevel` 1 -> 0.6 under `weather rain`
with both times reset to 11,280; the 17 constants 17/17; lifecycle clean.
Resolvable names on 1.26.51.1: 288 -> **326** (259 by address + 33
accessors + 23 constants + 11 carried by bdsx).

## `Actor::getDimension` (2026-09-18, night)

The 2024 body is not a field read: it takes the `WeakRef<Dimension>` at
+584 through its control block, bumping the counter. In 1.26 the reference
sits at +0x1c8 (Endstone: `dimension_` before `level_`) and is a
`std::weak_ptr`, whose first word under MSVC is the object pointer, so a
plain `get 8 at +0x1c8` returns the same dimension while the reference is
live and null where the unwrap would fail. Both builds hold the live route
too: the qword at +0x1c8 points at the object carrying the dimension's
IDimension table, it swapped under the nether and end teleports on
1.26.40.8, and IDimension slot 12 called on it returned the BlockSource on
1.26.51.1. Checked by execution on 1.26.40.8: the emitted accessor and the
engine's own `ActorCommandOrigin::getDimension` (the unwrap, called through
the real vftable in `tools/origin-probe.ts`) returned the same pointer for
the joined player. Resolvable names: 333 -> **334** and 326 -> **327**.

## Actor's built-in components: `getPosition`, `getRotation` (2026-09-19)

Call-edge propagation had put a 1,528-byte function with an exception frame
under `Actor::getPosition` on 1.26.51.1 (nothing on 1.26.40.8) and a 651-byte
one under `Actor::getRotation` on 1.26.40.8 -- for two getters that were 27
bytes each in 2024. In 1.26 an Actor holds pointers to its three hot
components side by side (Endstone's `actor.h`, `BuiltInActorComponents`:
`StateVectorComponent*`, `AABBShapeComponent*`, `ActorRotationComponent*`)
and the getters are reads through them. `tools/actor-layout-probe.ts` finds
the offset on a live player: after `tp @a 29.5 68 14.5 90 45` exactly one
pointer in the player's first 0x600 bytes leads to (29.5, 69.62, 14.5) -- at
**+0x218 on both builds**, followed there by the previous position and a
zero delta; the next pointer leads to the box 29.2 68 14.2 .. 29.8 69.8
14.8 and the one after to (45, 90), pitch then yaw. The component's first
member is the value the getter returns a reference to, so both ship as plain
`get 8` accessors (+0x218, +0x228), the two propagation names are retracted,
and `player.getPosition()` / `getRotation()` read back the teleport on both
builds.

## Rules this added

- **A field is exact where a value proves it.** The cheapest proof is a
  console command that changes the field between two sweeps.
- **An address wins over an emitted body.** Two `lea` accessors already
  had addresses from the walk (folded with a virtual); the merge drops the
  accessor for them.
- **Ship the target's offset only.** The 2024 offset is a prior that was
  wrong for 18 of 36 shipped (Actor, Player, Dimension, Block, BlockActor and
  LevelData all moved; the small command and scoreboard structs did not).

# Constants that are values, not addresses

Done 2026-09-18, on both builds. The same idea one step further: a name
whose body is a field became an offset, and a name whose *storage* the
compiler no longer keeps becomes the bytes.

## Why they cannot be found

`?ZERO@Vec3@@2V1@B` and its eleven siblings are `static const Vec3`. In
1.21.3.01 eleven of them sit in one `.rdata` block at `0x2eef3c8`, 16
bytes apart -- `ONE(1,1,1)`, `TWO`, `HALF`, `UNIT_X/Y/Z`, `NEG_UNIT_*`,
`MAX(FLT_MAX x3)`, `MIN(-FLT_MAX x3)` -- and `ZERO` is in a zero-filled
tail with no bytes in the file at all. Searching 1.26.40.8 and 1.26.51.1
for that 176-byte block, for the unpadded variant, for the 96-byte run of
six unit vectors and for the 48-byte `ONE/TWO/HALF` run returns **0 hits
in `.rdata` on both builds**. The constants are immediates at every use
now; there is no storage, so there is no address a match could find.

Endstone reached the same place from the other side: its Windows symbol
table (`src/bedrock/symbols/windows.h`, 129 lines) holds no Vec3 name at
all -- "Vec3" appears in exactly three entries, always as a parameter type
in a function it hooks -- and `src/bedrock/core/math/vec3.h` declares the
class itself, with `inline const Vec3 Vec3::ZERO{0,0,0}` in Endstone's own
binary and `BEDROCK_STATIC_ASSERT_SIZE(Vec3, 12, 12)` fixing the layout.
Vec3 crosses the ABI as a layout, never as an address.

## What is shipped

bdsx only ever reads through these pointers (`proc[...].as(Vec3)`), so any
address holding the right bytes is correct. `tools/extract-constants.mjs`
reads the bytes from the last build with a PDB and writes
`data/constants.json`, which is **not per-build**: `Vec3::ONE` is (1,1,1)
in every build. `symbols.json` carries them as `constants`, and bdsx's
`proc` allocates each one at first use (`bds/symbols.ts`, `allocConstant`),
keeping it alive through the property it defines on `proc`.

Two gates offline, both measured, plus one human check:

1. **Width** comes from bdsx's own `@nativeClass` -- exactly the bytes bdsx
   can read through the pointer (Vec3 12, BlockPos 12, ActorUniqueID 8).
2. **No relocation inside the range.** A constant holding an address is
   build-specific and must not be carried across. This is what rejects
   `?EMPTY_ITEM@ItemStack@@2V1@B`, whose first eight bytes are a relocated
   vftable pointer. `IdentityDefinition::Invalid`, `ScoreboardId::INVALID`
   and `Abilities::INVALID_ABILITY` hold no relocation but have no
   established width, and are left out rather than guessed.
3. **The value must mean what the name says.** It does, 17 for 17:
   `UNIT_Y` is (0,1,0), `BlockPos::MAX` is `INT_MAX x3`,
   `ActorUniqueID::INVALID_ID` is `0xffffffffffffffff` -- which is also
   exactly the default bdsx's own `procConst` call site carries, an
   independent agreement on the one value that is not self-evident.

`?CurrentVersion@CommandVersion@@2HB` is deliberately **not** extracted: it
is a version number, different in every build, and bdsx already reads it
through `procConst` with a default.

## Measured

17 names, all required by bdsx, on both builds: 12 `Vec3`, 4 `BlockPos`,
`ActorUniqueID::INVALID_ID`. Coverage by address is unchanged (255 and
247) -- these never had an address -- and the names bdsx can resolve go
**255 -> 308 on 1.26.40.8** (255 + 36 accessors + 17 constants) and
**247 -> 264 on 1.26.51.1**.

Five more followed the same day (`findings-utils.md`):
`ScoreboardId::INVALID` joined this set once bdsx's own `@nativeClass`
established its width, and `SharedConstants`' version integers ship
**per build** in `data/constants-<v>.json`, which `merge-symbols.mjs`
reads after this one. 23 constants per build, 314 and 270 resolvable.

Checked by execution on both builds (`tools/accessor-probe.ts`,
`constprobe`, driven by `run-full.ps1 -Commands`): all 17 values read back
correctly through bdsx's own `Vec3`, `BlockPos` and `ActorUniqueID`
classes, `pdbcache.search` confirms none of them has an address in the
binary, and the full lifecycle ran clean -- `Server started.`,
`Quit correctly`, on 1.26.40.8 and on 1.26.51.1.

## Rules this added

- **A constant needs a value, not an address.** Where the compiler kept no
  storage, ship the bytes; only a name bdsx *writes* or *hooks* needs the
  binary's own copy, and `merge-symbols.mjs` refuses to serve those from
  `constants`.
- **A relocation is what makes a value build-specific.** No relocation in
  the range means no address inside, which is what lets the bytes carry to
  every future build; `ItemStack::EMPTY_ITEM` is the counter-example.

## `MobEffectInstance` (2026-09-19)

Not an accessor and not a name -- a class bdsx lays out itself whose 1.26
layout is not the 2024 one. The address work for the effect family
(`findings-components.md`, route 10) produced a live
`MobEffectInstance*` for the first time, and the first 0x28 bytes read off
it after `effect @a speed 30 1` are:

```
+0x00 01000000   id        = 1 (Speed)
+0x04 58020000   duration  = 600
+0x08 ........ 00000000
+0x10 ........ ........      a pointer (0x0000_02xx_........)
+0x18 ........ ........      a pointer
+0x20 01000000   amplifier = 1
+0x24 00 00 00 01              displayAnimation, ambient, noCounter, showParticles
```

The class grew from 0x80 to 0x88, the three difficulty durations
(`durationEasy` / `durationNormal` / `durationHard`, 2024's +8 / +0xc /
+0x10) are gone, and two pointers took their place. bdsx was reading
`amplifier` at +0x14 and got 0x100 -- the high half of the pointer at
+0x10 -- which is the kind of wrong value that never throws.

`bdsx/bds/effects.ts` now declares the class as 0x88 with `amplifier` at
0x20 and the four flags at 0x24, and drops the three durations rather than
guess at what replaced them. Two console commands pin it:
`effect @a speed 30 1` gives amplifier 1 with `showParticles` true, and
`effect @a speed 20 2 true` gives amplifier 2 with `showParticles` false --
both fields move as commanded, on 1.26.40.8 and 1.26.51.1
(`tools/actor-layout-probe.ts` `effprobe speed` / `effprobe speed2`).

Nothing else in bdsx reads those fields, and `MobEffectInstance::create`
cannot run in these builds anyway (`??0MobEffectInstance@@QEAA@IHH_N00@Z`
has no address), so the only reader is the instance `Actor::getEffect`
hands back.

**The size is not the same on the two builds** (2026-09-24): 0x88 on 1.26.40.8, 0x90 on 1.26.51.1, read off each
build's own `vector<MobEffectInstance>` push in `AreaEffectCloud`. `effects.ts` takes it from
`layouts.MobEffectInstance.size`, since `MobEffectInstance.load` has the engine construct into an instance bdsx
allocates (`docs/findings-nbt.md` section 9).

## `BaseAttributeMap` and `AttributeInstance` (2026-09-19)

The same move as `GameRules`, and for the same reason: the container
changed shape and the accessor over it is gone, so the accessor is written
in bdsx against offsets the table ships.

2024's `BaseAttributeMap::getMutableInstance(unsigned int)` is a leaf that
hashes the attribute id with FNV-1a-64 and probes an open-addressed table.
1.26 has no such function in any form -- not inlined somewhere findable,
not renamed. Its map is a different container:

```
BaseAttributeMap
  +0x00  unsigned int* idsBegin      a std::vector<unsigned int>, sorted
  +0x08  unsigned int* idsEnd
  +0x18  AttributeInstance* instances    parallel array, index = id's index
  +0x20  (the end sentinel the not-found path compares against)
```

which the two surviving lookups walk with `equal_range`. They are read off
`BaseAttributeMap::getInstance(Attribute const&)` -- 1.26.40.8 `0x2364500`,
1.26.51.1 `0x1ebcc60` -- where `movq (%rcx),%r9; movq 8(%rcx),%rdx;
sarq $2` is the id vector and the id being searched for is `4(%r8)` of the
`Attribute`. **The element stride is the one number that differs between
the two builds**, and it is visible only as the shift applied to the byte
offset before `addq 24(%rcx)`:

| build | code | stride |
|---|---|---|
| 1.26.40.8 | `shlq $5, %r8` | `4 * 32` = **128** |
| 1.26.51.1 | `shlq $5, %r9; leaq (%r9,%r8,2), %r8` | `4 * 34` = **136** |

`AttributeInstance` itself kept its field order and moved down by eight,
which a live instance settles. With the health attribute of a full-health
player, and again after `effect @a health_boost 60 1 true`:

```
        +0x68   +0x6c   +0x70   +0x74   +0x78   +0x7c
base      0      20      20       0      20      20
boost     0      20      20       0      28      20
```

Only `+0x78` moves, so that is `maxValue`; `+0x7c` is the `currentValue`
`ActorAttribute::getHealth` reads; `+0x74` is 0, the health minimum; and
`+0x70` is 20, the default. In order, 1.26 is `defaultValue` `+0x70`,
`minValue` `+0x74`, `maxValue` `+0x78`, `currentValue` `+0x7c` -- 2024's
`+0x78 / +0x7c / +0x80 / +0x84` shifted down by eight, the same eight the
2024 `AttributeInstance` lost. (`+0x6c` holds 20 too and is not one of the
four bdsx names.)

Both go into `data/candidates-instances-<v>.json` `offsets` and ship as
`layouts.BaseAttributeMap` / `layouts.AttributeInstance`.
`bdsx/bds/implements.ts` runs the `lower_bound` itself over the id vector
and returns `null` where the binary returns its static invalid instance,
under `derived()` so a build whose table does resolve the name uses the
binary. `AttributeInstance.abstract` takes its four offsets from the table
and falls back to the 2024 literals.

Checked on both builds (`tools/actor-layout-probe.ts` `attrprobe`):
`getAttribute(Health)` is 20 with min 0 / max 20 / default 20,
`getMutableInstance(JumpStrength)` -- an attribute a player does not have --
is `null`, the maximum follows `health_boost` to 28 while the current value
stays 20, and `setAttribute(Health, 15)` is read back as 15 by
**`Actor::getHealth`**, which is the binary's own function reading `+0x7c`
of the instance bdsx located. That last one is the check that matters: the
write goes through bdsx's layout and the read comes back through BDS's.

One thing it does not fix. `ServerPlayer::setAttribute` also sends an
`UpdateAttributesPacket`, and allocating a packet from JS needs
`??$_Allocate@$0BA@U_Default_allocate_traits@std@@$0A@@std@@YAPEAX_K@Z`
(`bdsx/msalloc.ts`), which no build's table has: the probe therefore calls
`Actor.prototype.setAttribute` directly. Every JS-side packet allocation is
blocked on that one name (`next-steps.md`).

## `AttributeData`: a struct that grew in the middle (2026-09-19)

`ServerPlayer.setAttribute` killed the server for weeks, and
`findings-utils.md` ("Where it still stops") had narrowed it to a layout
rather than a string: an element with no heap string in it died just the
same. This is what it was.

**The `Packet` base did not change.** That had to be ruled out first, because
if it had, every packet class would have shifted with it (Q5). It did not:
the packet constructor (`0x31b4820` on 1.26.40.8, `0x12f76d0` on 1.26.51.1,
316 bytes on both) writes `priority`/`reliability` at `+0x08`, senderSubId
and isHandled at `+0x10`, `recvTimepoint` at `+0x18`, `handler_` at `+0x20`,
`compressible` at `+0x28`, and the derived vftable at `+0x30` --
`sizeof(Packet)` = 0x30, matching Endstone's static assert. The second
image pointer at `+0x20` in the live dump, the one bdsx's declaration has no
field for, is **not a second vftable**: it points into `.data`, into an array
of per-id `IPacketHandlerDispatcher` instances spaced 0x10 apart.

**`AttributeData` went from 88 to 96 bytes.** 1.26's protocol added two
floats, and `AttributeData::write` (`0x235f140` / `0x1eb7670`, 525 bytes on
both builds) names them itself -- the `r8` of each call is the field's stream
name:

```
movss   4(%rcx), %xmm1   ->  "Min Value"            +0x04
movss   8(%rdi), %xmm1   ->  "Max Value"            +0x08
movss    (%rdi), %xmm1   ->  "Current Value"        +0x00
movss  16(%rdi), %xmm1   ->  "Default Min Value"    +0x10   new in 1.26
movss  20(%rdi), %xmm1   ->  "Default Max Value"    +0x14   new in 1.26
movss  12(%rdi), %xmm1   ->  "Default Value"        +0x0c
movq   48(%rdi), %rax    ->  "Attribute Name"       +0x18 (HashedString, 48 bytes)
```

Neither string exists in 1.21.3.01, and 2024's `AttributeData::write`
(`0x1a64170`) writes only `4 / 8 / 0 / 12`. Everything after the two new
floats moved down by eight: the name at `+0x18`, the modifier vector at
`+0x48 / +0x50 / +0x58`, `sizeof` 96. The stride shows up independently in
four places -- `addq $96, %rbx` in the packet destructor (`0xb04818` /
`0x9c4ba8`) and in its copy constructor, `addq $96, %rdi` in an inlined stack
teardown, and `movl $96, %edx` as the sized `operator delete` argument.

That is exactly the failure. `CxxVector` strides by
`componentType[NativeType.size]`, so bdsx pushed elements 88 bytes apart into
storage BDS's destructor then walked 96 bytes at a time: `end` is never hit
and the walk runs off the heap. No string needed.

`UpdateAttributesPacket` grew two fields of its own after the vector: `+0x50`
an 8-byte tick (serialized as `"Input tick"`) and `+0x58` a `SerializationMode`
u32 the constructor sets to 1 (`movl $1, 88(%rsi)`), which is what the live
`pk0` dump had been showing at `+0x58` all along. `sizeof` 0x60.

The two new floats come from `AttributeInstance`, and the copy that proves it
also corroborates the offsets already shipping. `AttributeData`'s constructor
from an `AttributeInstance` (`0x235e5b0` / `0x1eb6b90`, 550 bytes, byte-identical
on the two builds) reads `+0x74 / +0x78 / +0x7c / +0x70` for min / max / current /
default -- the four `layouts.AttributeInstance` already carries -- and `+0x68`
and `+0x6c` for the two new ones. So `defaultMinValue: 104` and
`defaultMaxValue: 108` join that layout, and `setAttribute` sends what BDS
itself would send rather than zero.

Fixed on the bdsx side, not in `symbols.json`: what was wrong is an element
*size*, and `layouts` is a class→member→offset map. `bdsx/bds/packets.ts`
declares the two new floats and the two new packet fields, as
`MobEffectInstance` was fixed before it.

**Executed on both builds** (`alloc40` / `alloc51`): `pk2` reports
`sizeof(AttributeData)=96` and measures one pushed element at 96 bytes,
`pk` builds a packet with a heap string and lets BDS free it, and `packet`
runs the whole `ServerPlayer.setAttribute` 20 → 15 → 20 and reads it back
through BDS's own `Actor::getHealth`. Session `Quit correctly`, exit 0.

Unverified: the member *names* `defaultMin` / `defaultMax` (they come from
the stream field names; Endstone publishes no `update_attributes_packet.h`),
the type of the `+0x50` tick, and whether a real client minds the values --
the bot cannot check that (Q7).

## The last-hurt block (2026-09-19)

`Actor` keeps nine "last hurt" fields and 1.26 has **no getter for any of them**:
not out of line, and not as a leaf either. The five encodings that would be a
one-line getter (`mov eax,[rcx+0x340]; ret` and its kin) each appear at most
once in the image, three of them are the tail of an eight-byte read rather than
a four-byte one, and `tools/leaf-funcs.mjs --at=` says the two that are the
right shape are *not the target of any direct branch*. So the whole block goes
through `accessors` and `derived()`.

The offsets were read from the **writers**, on both builds, never carried from
2024 by a delta — and that mattered, because the block was reordered:

| bdsx name | 2024 | 1.26 | how it ships | the writer it was read from |
|---|---|---|---|---|
| `getLastHurtMob` | +944 | **+800** | derived (id → `Level::fetchEntity`) | `Mob::doHurtTarget` 40 `0x240a03e` / 51 `0x29f1d61` (`Actor::setLastHurtMob`, inlined) |
| `getLastHurtByMob` | +952 | **+808** | derived | `Actor::setLastHurtByMob` 40 `0xdeee90` / 51 `0xd2eca0`; `Actor::baseTick` 40 `0xdee579` |
| `getLastHurtByPlayer` | +960 | **+816** | derived | `Actor::setLastHurtByPlayer` 40 `0xdef020` / 51 `0xd2ee30` |
| `getLastHurtTimestamp` | +992 | **+824** | accessor, get 8B | `Mob::hurtEffects` 40 `0x23fb9ec` / 51 `0x29e6792` |
| `getLastHurtCause` | +984 | **+832** | accessor, get 4B | `Mob::hurtEffects` 40 `0x23fb9cc` / 51 `0x29e6772` |
| `getLastHurtDamage` | +980 | **+836** | accessor, get 4B **float** | `Mob::hurtEffects` 40 `0x23fb9b9`/`0x23fb9c1` / 51 `0x29e675f`/`0x29e6767` |
| `getLastHurtMobTimestamp` | +968 | **+840** | accessor, get 4B | `Mob::doHurtTarget` 40 `0x240a04b` / 51 `0x29f1d6e` |
| `getLastHurtByMobTime` | +972 | **+844** | accessor, get 4B | `Actor::setLastHurtByMob` (`$0x3c`), `Actor::baseTick` (decrement) |
| `getLastHurtByMobTimestamp` | +976 | **+848** | accessor, get 4B | `Actor::setLastHurtByMob` (`movl 0x198(%rsi),%eax`) |
| `wasLastHitByPlayer` | +392 | **+276** | derived (`> 0`) | `Actor::setLastHurtByMob` and `setLastHurtByPlayer` (`movl $0x190`), `Actor::baseTick` (decrement) |

The deltas are −144, −144, −144, −168, −152, −144, −128, −128, −128, −116. **A
constant subtracted from the 2024 offsets would have been wrong for six of the
ten**: the 8-byte timestamp moved from the end of the block to the front, and
cause and damage swapped sides of the three int counters. This is the same
lesson as the slot work — an equal-length gap whose content changed cannot be
filled by position.

Two things each field has, which is what made the reading safe:

1. **The writer and the 2024 writer are the same function.** Every 1.26 store
   above has a 2024 counterpart at the same point in the same body, so the pair
   is matched by *what the code does*, not by where the field sits.
2. **A second, independent writer.** `Actor::baseTick` pairs +808 with +844 and
   +816 with +276 and decrements both countdowns, exactly as the 2024 body pairs
   +952/+972 and +960/+392. `Actor::setLastHurtByPlayer` (found here: 40
   `0xdef020` / 51 `0xd2ee30`) writes +816 and +276 a second time.

### `getLastHurtDamage` was declared `int32_t`

An upstream bdsx bug, there since 2024: the decorated name is
`?getLastHurtDamage@Actor@@QEBAMXZ` — `M` is `float` — and the 2024 body is
`movss 980(%rcx), %xmm0`. `implements.ts` declared the return `int32_t`, so
makefunc read `eax`, which the function never writes. It is now `float32_t`.
The probe checks the exact value 3 after `damage <zombie> 3`, which is the
cheapest thing that tells the two apart.

### The three actor references are ids

`getLastHurtMob` / `getLastHurtByMob` / `getLastHurtByPlayer` hold an
`ActorUniqueID`, not a pointer; the 2024 bodies read the field, compare it with
−1 and hand it to a `Level` virtual. bdsx does the same over
`Level::fetchEntity`, which both builds resolve — the criterion in
`findings-utils.md` (the memory it touches is a layout bdsx defines, and the
call it makes is a name bdsx already has). The real bodies also write −1 back
when the fetch fails; that is a cache detail `Actor::baseTick` does anyway, so
bdsx leaves the field alone.

`wasLastHitByPlayer` cannot be a field accessor even though it is one field:
the value is a 400-tick countdown and `bool_t` reads the low byte, which is 0
for 256 and for 0x190 itself.

### `Player::isHurt`

`getHealth() > 0 && getHealth() < getMaxHealth()` — literally what the 2024 body
(`0x19e1990`) does with `Actor::getHealth` and `Actor::getMaxHealth`, both of
which bdsx already has on 1.26 as `ActorAttribute::getHealth` / `getMaxHealth`.
Carried by bdsx.

### Executed on both builds

`hurt40` / `hurt51` (`tools/host/drivers/hurt40.ps1`, new; probe `hurtprobe` in
`tools/actor-layout-probe.ts`). The fields are written inside `Mob::_hurt` and
`Actor::baseTick` clears the byMob id 60 ticks later, so a console command 8 s
after the damage reads a cleared block: the probe captures the victim on the
`entityHurt` hook and snapshots the values three ticks later on `levelTick`.

```
difficulty normal | tp @a 29 68 14 | time set midnight | hurtprobe none
execute as @a at @s run summon zombie ~2 ~ ~2
execute as @a at @s run damage @e[type=zombie,c=1] 3 entity_attack entity @s
hurtprobe hit | kill @e[type=zombie]
```

| step | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `none` (the bot, untouched) | damage 0, cause **−1**, the three references null, `wasLastHitByPlayer` false, `isHurt` false | the same |
| damage | **2.940000534057617** | **2.700000762939453** |
| cause | 2 = `EntityAttack` | 2 |
| who | `getLastHurtByMob` and `getLastHurtByPlayer` are the bot (pointer equality), `wasLastHitByPlayer` true | the same |
| times | byMobTime 58, byMobTimestamp 160, timestamp 207771 | 58, 161, 209413 |
| decay (8 s later) | byMob null, byMobTime 0, damage/cause/timestamp unchanged | the same |

Both sessions `Quit correctly`, exit 0, host md5 back to `0FECD1F7…`.

Four things in that table are worth more than the PASS:

- **The damage is a fraction**, and a different one on each build (the zombie's
  armour roll). An `int32_t` read of that slot gives `eax`, which the function
  never writes; a float read at a wrong offset does not land within 10% of the
  number the console asked for.
- **The untouched cause is −1** (`ActorDamageCause::None`), not 0. A dword
  picked at the wrong offset is very unlikely to be exactly −1.
- **`byMobTimestamp` (160) and `timestamp` (207771) disagree**, which is what
  the bodies predict: the first is the actor's own tick counter (`Actor+0x198`),
  the second the level's. A single wrong offset would have made them equal or
  both nonsense.
- **The decay step reads the same six offsets twice**: 160 ticks later BDS's own
  `baseTick` has cleared exactly the two fields it clears (+808 and +844) and
  left the other four alone.

### The non-null `getLastHurtMob` (2026-09-20)

The run above left one field with only its zero reading: `getLastHurtMob`
returned null throughout, and `getLastHurtMobTimestamp` 0, because nothing the
bot could arrange made a mob hurt anything. **Those two are not the victim's
fields at all** -- they belong to the *attacker*, which is why no amount of
`damage @e ... entity @s` moves them: the player path never reaches the writer.

The writer is `Mob::doHurtTarget`, with `Actor::setLastHurtMob` inlined into it.
1.26.40.8 `0x240a03e`:

```
testb  $2, 528(%rdi)          ; rdi = the target
je     66
movq   %rdi, %rcx
callq  ...                    ; -> &target->ActorUniqueID
movq   (%rax), %rax
movq   %rax, 800(%rbx)        ; rbx = the attacker: +800 = the target's id
movl   408(%rbx), %eax
movl   %eax, 840(%rbx)        ; +840 = the attacker's own tick counter
```

2024's out-of-line `?setLastHurtMob@Actor@@QEAAXPEAV1@@Z` (`0x19c66b0`) is the
same three steps -- the same bit tested on the target (`movl 648(%rdx),%eax;
shrl %eax; testb $1,%al`, i.e. target+648 bit 1, which is 1.26's target+528 bit
1), then `movq %rdx, 944(%rbx)` and `movl 520(%rbx),%eax; movl %eax, 968(%rbx)`.
So the pair is +944/+968 in 2024 and +800/+840 in 1.26, and it is written on the
attacker, under a flag on the target.

That shape is also the check. `hurtprobe mob` takes the hit from the other end:
on every `entityHurt` whose victim is not a player it asks the victim who hit it
(`getLastHurtByMob`, +808, confirmed in the run above), and then asks *that*
actor what it last hurt. If +800 is the field the body says it is, the answer is
this very victim -- not merely non-null, but the same pointer.

The scenario is `sig40`'s: an iron golem and two zombies summoned beside the
bot at midnight, `difficulty normal`, a 24 s fight, then `hurtprobe mob`. The
driver is `hurt40.ps1` / `hurt51.ps1`, which now runs the bot-damage sequence
above and this one back to back (17 commands, `-BotSecs 260`).

| | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| attacker | `minecraft:zombie@0x1B5DA6C2060` | `minecraft:skeleton@0x2A673305E60` |
| victim, per the `entityHurt` hook | `minecraft:iron_golem@0x1B5DB9F0980` | `minecraft:iron_golem@0x2A672D27870` |
| the attacker's `getLastHurtMob()` | `0x1B5DB9F0980` -- **the same pointer** | `0x2A672D27870` -- **the same pointer** |
| the attacker's `getLastHurtMobTimestamp()` | 23 | 1201 |
| the *victim's* `getLastHurtMobTimestamp()` | 0 | 0 |

Both sessions: 7/7 PASS, exit 0, `Quit correctly`. Three things in that table
carry the weight:

- **Pointer identity, not non-nullness.** +800 holds an `ActorUniqueID`, so the
  value has to survive `Level::fetchEntity` and come back as the object the
  hook independently named. A neighbouring eight bytes that happened to be a
  plausible id would fetch a different actor or nothing.
- **The victim's own +840 stayed 0** in the same tick the attacker's read 23 (or
  1201). The field is per-actor and the read is not a constant or a shared
  counter; the golem had hurt nobody and says so.
- **The two builds disagree on the number** (23 vs 1201) and on who won the
  attacker role -- 1.26.51.1's world supplied a wandering skeleton before the
  summoned zombies closed in. What the body copies into +840 is `Actor+408`
  (`+0x198`), the attacker's own tick counter, the same field `setLastHurtByMob`
  copies into +848; the two builds' numbers differ because the two attackers had
  been alive for different lengths of time, which is what a per-actor counter
  does and a constant does not.

The eleven names of this block are now all execution-confirmed on both builds.

## The respawn point, and the two permission bytes (2026-09-20)

Ten names off one structure and two bytes. Nothing here needed a new search
technique: the entry point was the command that writes the field.

### Finding the struct

`commands.spawnpoint.wrongDimension` is referenced by exactly one function in
every build -- 2024 `0x1733590` (`SpawnPointCommand::execute`), 40 `0x3c66360`,
51 `0x3b45350`. The 2024 one calls `Player::clearRespawnPosition` and
`Player::setRespawnPosition`; the 1.26 ones call **40 `0x233610` / 51
`0x2be820`**, and that function opens with the same four comparisons as the 2024
body, in the same order, against the same three fields plus the dimension.

The fields are **+2784 / +2796 / +2808**, which is 2024's +6512 / +6524 / +6536
shifted by a constant −3728. Endstone's `player.h` declares exactly that struct:

```cpp
struct PlayerSpawnPoint {
    BlockPos spawn_block_pos;
    BlockPos player_position;
    DimensionType dimension;
} player_respawn_point_;
```

**The sentinel is spelled differently in 1.26 and that is worth knowing.** 2024
loads a global int and compares it with each of x, y, z; 1.26 writes
`xorl %eax,%eax; cmpl <field>,%eax; jno` -- the overflow flag of `0 - field` is
set exactly when the field is `INT_MIN`. The dimension sentinel, also a global
in 2024, is the immediate `3` (Undefined). `BlockPos::MIN`, which both builds
already ship as a `constants` entry, is three `INT_MIN`s, and that is the value
bdsx uses.

### One function where 2024 had two

2024 has two siblings: `setSpawnBlockRespawnPosition(BlockPos, DimensionType)`
(`0x19e93d0`, callers `SimulatedPlayer::create` and
`RespawnAnchorBlock::_trySetSpawn`) and `setBedRespawnPosition(BlockPos)`
(`0x19e7d00`, caller `Player::startSleepInBed`). 1.26 has **one** function, 40
`0x2332c0` / 51 `0x2be4d0`, with exactly those three callers -- one of them the
`?startSleepInBed@Player@@` already in our table (40 `0x214c20`). The surviving
signature is the three-argument one: the body keeps the third integer in `ebp`
and both compares it with +2808 and stores it there. So the address ships under
`setSpawnBlockRespawnPosition` and bdsx derives the bed form as that call with
the player's own dimension.

The body also says what "the player's position" means here: x and z are the
floor of the Vec3 at `Actor+536`, but **y is the floor of the box at
`Actor+544`** (`movq 544(%rcx),%rcx; movss 4(%rcx),%xmm1`) -- the block under
the feet, not `floor(position.y)`. The first probe asserted `floor(position.y)`
and failed on both builds with 68 against 69; the check was wrong, not the
address (the same lesson as the `can_destroy` counts in
`findings-containers.md`).

### What ships

| name | how |
|---|---|
| `?setRespawnPosition@Player@@` | address, 40 `0x233610` / 51 `0x2be820` |
| `?setSpawnBlockRespawnPosition@Player@@` | address, 40 `0x2332c0` / 51 `0x2be4d0` |
| `?getSpawnPosition@Player@@` | accessor, `lea` +2796 (2024: `leaq 6524(%rcx),%rax; retq`) |
| `?getSpawnDimension@Player@@` | accessor, `get-hidden` 4B +2808 (2024 returns the `AutomaticID` through the hidden pointer, which is why bdsx declares `structureReturn`) |
| `?hasRespawnPosition@Player@@` | `derived()` |
| `?clearRespawnPosition@Player@@` | `derived()` |
| `?setBedRespawnPosition@Player@@` | `derived()` |

`layouts.Player` carries the three offsets.

### The two permission bytes

`Player::getPlayerPermissionLevel` (2024 `0x19df780`) and
`Player::setPermissions` (2024 `0x19e8b60`) are the same four instructions:
`entt::registry::try_get<AbilitiesComponent>` on the entity context, then a tail
jump into `LayeredAbilities` -- `getPlayerPermissions`, which is
`movzbl 1(%rcx),%eax`, and `setCommandPermissions`, which is `movb %dl,(%rcx)`.
bdsx already has both halves on 1.26: `Player::getAbilities` resolves as an
address and those two `LayeredAbilities` names ship as accessors at +1 and +0.
Both are `derived()` -- no address needed.

### The XP curve

`Player::getXpNeededForNextLevel` (2024 `0x19dfcd0`) truncates the level
attribute, divides by 15 and picks one of three affine pieces:
`leal 7(,%rcx,2)` below 15, `leal -38(,%rcx,4)` + L below 30,
`leal -158(,%rcx,8)` + L above -- the vanilla 2L+7 / 5L−38 / 9L−158, cached in
a field beside a dirty flag (Endstone's `player_level_changed_` /
`previous_level_requirement_`). None of those three `leal` forms appears
anywhere in either 1.26 build, and none is needed: the level is the
`PlayerLevel` attribute bdsx already reads, so this is `derived()` too.

### Executed on both builds

`spawnprobe` in `tools/actor-layout-probe.ts`, drivers `spawn40/51.ps1`.
**13/13 PASS on both builds, exit 0, `Quit correctly`**
(`work/host-runs/spawn40-20260920-230733.txt`, `spawn51-...`). The session
alternates the two directions: BDS's `clearspawnpoint` / `spawnpoint` /
`deop` / `op` / `xp <n>L` write and bdsx reads, then bdsx writes through
`setRespawnPosition` / `setSpawnBlockRespawnPosition` / `setPermissions` /
`clearRespawnPosition` and either BDS's own getter reads it back
(`Player::getCommandPermissionLevel` returns the level bdsx just set) or BDS's
own `spawnpoint` still works afterwards.

## The attribute ids are not the same in the two 1.26 builds (2026-09-20)

Found while checking the XP curve: `xp 5L @a` on 1.26.51.1 makes BDS print
"Gave 5 levels" and leaves bdsx reading level **0**. Dumping every id in the
live `BaseAttributeMap` explains it -- the two builds carry the same seventeen
attributes under **different ids**:

```
40: 2,3,4,5,6,7,8,9,10,11,12,13,14,15,17,18,19
51: 1,2,3,4,5,  7,8,9,10,11,12,13,14,15,17,18,19
```

Matching them by their min/max/default, which are unchanged:

| attribute (current/min/max/default on a fresh player) | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| hunger 20/0/20/20 | 2 | **1** |
| saturation 5/0/20/5 | 3 | **2** |
| exhaustion 0/0/20/0 | 4 | **3** |
| level 0/0/24791/0 | 5 | **4** |
| experience 0/0/1/0 | 6 | **5** |
| health 20/0/20/20 | 7 | 7 |
| everything from 8 up | same | same |

51 has no id 6 at all. The mapping is confirmed by execution, not by the table:
`xp 10L @a` on 51 moves **id 4** from 0 to 35 while id 5 stays 0.

bdsx's `AttributeId` enum is the 2024 numbering, which 1.26.40.8 still matches
and 1.26.51.1 does not, so on 51 every player-attribute call reaches the
neighbour one slot along. **This also corrects an earlier note**: the
2026-09-19 entry that read `isHungry` as "20/20 on 40, 5/20 on 51, so it is a
world difference" was this bug -- 51's id 2 is saturation, whose default is 5.

### Fixed by translating at the one seam (2026-09-20)

`AttributeId` stays the 2024 numbering -- it is public API and plugins are written against it --
and the id is translated where it reaches the binary, which is exactly one place:
`BaseAttributeMap::getMutableInstance`. `symbols.json` carries a per-build
`layouts.AttributeId` (name -> this build's id) and `nativeAttributeId()` in
`bds/implements.ts` maps through it, logging each difference once at load. Both the
`derived()` body and the binary fallback go through it; a build whose table has no
`AttributeId` layout keeps the enum's own numbering, which is what 1.26.40.8 does anyway.
`BaseAttributeMap.nativeIdOf()` exposes the same map so a probe (or a plugin) can ask.

`JumpStrength` is deliberately **not** in the table: a player has no instance of it, so it was
never measured, and an absent name falls through to bdsx's enum value.
`UnderwaterMovementSpeed` and `LavaMovementSpeed` share a fingerprint (0 / FLT_MAX / 0.02); they
are assumed to keep their relative order, as every distinguishable neighbour from 8 to 15 does.

### Two routes, and the one that was nearly fooled

**Route A, the fingerprint.** Every name is pinned by the min/max/default its instance carries,
which do not change between the builds. 11 of 11 on both builds (`attridprobe ids`).

**Route B, execution, which does not know the mapping at all.** Snapshot every instance by
walking `BaseAttributeMap` directly, run a console command, and report which **native** id moved:
`xp 5L @a` moves id **5 on 40** and id **4 on 51**, and `xp 7 @a` moves id **6 on 40** and id
**5 on 51** -- exactly where bdsx maps `PlayerLevel` and `PlayerExperience`.

The first version of route B walked the live id vector but read each instance through
`getMutableInstance`, which now translates -- so it translated twice and reported 40's numbering
on both builds. It "passed" on 40 (identity) and produced a contradiction on 51 that read like
the mapping being wrong. **A route that is supposed to be blind to the thing it checks has to
reach the object without going through it**; the fixed version indexes the instance array itself.

### Executed on both builds

`attridprobe` in `tools/actor-layout-probe.ts`, drivers `attr40/51.ps1`. **29/29 PASS on both
builds, exit 0, `Quit correctly`** (`work/host-runs/attr40-20260920-232902.txt`, `attr51-...`).
The end-to-end check is the one that used to fail: `getXpNeededForNextLevel` now returns
23 / 102 / 184 at levels 8 / 28 / 38 on **both** builds (51 previously read level 0 forever), and
`isHungry` reads hunger 20/20 on both (51 was reading saturation 5/20). On 51 bdsx logs the five
translations at load; on 40 it logs none.

### A route that is not there

`attridprobe dump` walks all 17 live instances and looks for anything in the first 0x70 bytes
that reaches a readable string. **Nothing does, on either build** -- an `AttributeInstance` does
not name itself, so there is no runtime name -> id resolution to be had from the object, and the
table has to be measured per build. The static route is closed too: the `Attribute` statics
(`?HUNGER@Player@@2VAttribute@@B`, `?HEALTH@SharedAttributes@@2VAttribute@@B`, fifteen of them
with names in the 2024 PDB) live in `.data` and are built by dynamic initialisers, so the ids are
assigned at startup and the file image says nothing.

## The hurt-time component, and two fields that needed no address (2026-09-21)

Three names from the Q1 batch: `?setHurtTime@Actor@@QEAAXH@Z`, `?isSpawned@Player@@QEBA_NXZ`,
`?getDirection@Player@@QEBAHXZ`. None of them ships as an address. Two are one-line derivations
from a body that only ever called something bdsx already has; the third was supposed to be the
same and was not, and that is the result worth recording.

### `setHurtTime`: the queue's premise was wrong

`docs/next-steps.md` had this one down as free: the 2024 body (`0x19c5fb0`) is four instructions,
`movl %edx,16(%rsp); movl $11,%edx; leaq 56(%rsp),%r8; addq $400,%rcx; call set<int>`, i.e.
`set<int>(entity_data, 11, time)`, and both halves -- `Actor::entity_data` at `+0x128` and
`SynchedActorDataEntityWrapper::set<int>` -- were already carried by bdsx
(`docs/findings-synched.md`). So: one line, no address.

It compiled, it ran, and it did nothing. **In 1.26 there is no Int item at id 11 at all.** The
probe asks the engine rather than the header: a sweep of `getInt` over ids 0..63 on a mob one tick
after a console `damage`, and the same sweep four ticks later. On both builds only two ids read
non-zero (1 and 55) and **nothing moves**. `getInt` is the binary's own getter and returns 0 for an
id whose item is absent or of another type, so this is not a bdsx-side accident: the slot is gone.

Where it went is in Endstone's `mob.h`: `struct BuiltInMobComponents { DeathTickingComponent*,
MobAnimationComponent*, MobHurtTimeComponent* }`, held by `Mob` as `built_in_mob_components_`.
So the countdown is behind a pointer in the Mob, the way `StateVectorComponent` and friends are
behind pointers in the Actor.

Finding *which* pointer was done by behaviour, not by position. A hurt-time countdown is a word
that goes down by exactly one per tick. So: follow every pointer-shaped word in the Mob (high dword
between 1 and 0xffff, which keeps floats and packed ints out of the dereference), read the first
eight dwords behind each, once one tick after the hit and once five ticks after, and keep the words
that fell by exactly four. On 1.26.40.8 that is **one word out of 2,080 followed**: `Mob+0x428
[+0]`, `10 -> 6`. On 1.26.51.1 it is that same word plus one alias of it in the EnTT pool
(`Mob+0xd48 [+12]`, the same absolute address reached by a different pointer), out of 1,552.
`0x428` is the third of the three consecutive pointers at `0x418`/`0x420`/`0x428`, which is exactly
where Endstone's declaration order puts `mob_hurt_time_component`.

The binary says it a third time. Both builds carry `mov rax,[reg+0x428]; movl $10,(%rax)` where
2024 called `setHurtTime(10)` -- 2024 has exactly two such call sites, each with `movl $10,%edx`
in front of the call -- and `movl $0,(%rax)` where 2024 cleared it.

Ships as `layouts.Mob` (`hurtTimeComponent` 0x428, `hurtTime` 0) on both builds, and
`Actor::setHurtTime` becomes a `derived()` that writes through it. A non-mob actor is left alone
(`getEntityTypeId() & ActorType.Mob`), because a non-mob has no such component.

### `isSpawned`: an offset read off the functions that share the field

2024's getter is two instructions, `movzbl 2904(%rcx),%eax; retq` (`0x19e20c0`), and 1.26 keeps no
copy. `docs/next-steps.md` suggested finding the writer via
`?setLocalPlayerAsInitialized@ServerPlayer@@`; that was wrong -- that function writes `+7754`.

What worked is an intersection. Take two functions that are named in **all three** builds and that
both touch the field in 2024, and ask which byte displacements they have in common:

| build | the two functions | byte displacements they share |
|---|---|---|
| 1.21.3.01 | `Player::_hurt` `0x19d49b0`, `Player::respawn` `0x19e7100` | **2904** and nothing else |
| 1.26.40.8 | `0x226fa0`, `0x2310c0` | **1801 (0x709)** and nothing else |
| 1.26.51.1 | `0x2b5fe0`, `0x2bc2f0` | **1801** and nothing else |

A singleton in every build is already the answer, and the whole access set corresponds as well.
2024 has six functions touching `+0xb58` that belong to Player (`_hurt`,
`_shouldProvideFeedbackOnArmorSet` at its very first instruction, `respawn` twice,
`getExpectedSpawnDimensionId`, `updateSpawnChunkView`, `tickWorld`, `ServerPlayer::isPlayerInitialized`)
plus exactly one `movb imm8` writer, `ServerPlayer::doInitialSpawn`. Both 1.26 builds have
**twelve** functions at `+0x709` with **exactly one** `movb imm8` writer, and the readers that are
named in our tables are the same ones, `_shouldProvideFeedbackOnArmorSet` again reading it at its
first instruction.

Ships as an `accessors` entry (`get`, 1 byte, zero-extended, `+1801`) on both builds.

### `getDirection`: trigonometry and a nine-instruction leaf

2024's `Player::getDirection` (`0x19de6f0`) calls `Actor::getRotation`, multiplies `rotation.y` by
float32(pi/180) (`0x2be5568` = 0.01745329238474369) twice, calls `mce::Math::cos`, flips its sign,
calls `mce::Math::sin`, and tail-calls the static `?getDirection@Direction@@SA?AW4Type@1@MM@Z`
(`0x17f8190`) with `xmm0` = sin and `xmm1` = -cos. That static is nine instructions of pure
arithmetic:

```
|x| > |z| ? (x > 0 ? 1 : 3) : (z > 0 ? 2 : 0)
```

which is bdsx's own `Direction.Type` in its declared order -- South 0, West 1, North 2, East 3 --
and the same quadrant convention `Facing.convertYRotationToFacingDirection` already carries by a
different formula (`floor(yaw/90 + 0.5) & 3`). `getRotation` is a field accessor on both builds,
so nothing here needs an address; it is a `derived()`.

One caveat kept in the open: BDS's sin and cos are a 65,536-entry table
(`mulss; addss; cvttss2si; movzwl; movss (table,rcx,4)`), so on a yaw sitting exactly on a quadrant
boundary (45, 135, ...) their rounding and ours may disagree.

### Executed on both builds

`hurtprobe hit` (extended) and the new `dirprobe`, in `tools/actor-layout-probe.ts`, drivers
`hurt40/51.ps1`. **17/17 PASS on both builds, exit 0, `Quit correctly`**
(`work/host-runs/hurt40-20260921-102234.txt`, `hurt51-...`):

- `hurtprobe component`: of the 24 dwords behind the three `BuiltInMobComponents` pointers, the
  only one that falls by exactly four over four ticks is `Mob+0x428 [+0]`, `10 -> 6`. The check is
  re-derived every run rather than asserted from the table.
- `hurtprobe hurttime`: three ticks after the hit BDS had left **8** in that dword; `setHurtTime(17)`
  made it 17; putting 8 back made it 8. Both directions, both builds.
- `dirprobe south|west|north|east`: `tp @a 29 68 14 <yaw> 0` at 0, 90, 180, 270 gives 0/1/2/3, and
  `Facing.convertYRotationToFacingDirection` -- bdsx code that was already executed on both builds,
  and a different formula -- agrees at every one.
- `dirprobe spawned`: `isSpawned` is true on a player standing in the world. It was also true at
  `playerJoin`, so no false-to-true transition was observed; the check asserts only what was seen
  and says so in its own output.

### Two costs paid on the way, both worth writing down

**A probe that writes must hold its subject as an `ActorUniqueID`.** The hurt-time round trip is
the only write in `actor-layout-probe.ts`, and the first version did it through the raw `Actor*`
captured three ticks earlier. Two sessions died with **0xC0000409** (`__fastfail`) several seconds
later, in the middle of the golem-versus-zombie brawl, with no crash block in the `.err` -- writing
17 into a freed `Actor` is heap corruption, and the fail-fast comes when BDS next touches the heap.
The rule was already in `docs/findings-blocks.md` 11 for a *read*; it matters far more for a write.
The round trip now fetches the victim back with `Actor::fromUniqueIdBin(id, false)` and runs once
per session, on the player-caused hit.

**An unbounded pointer walk is a diagnostic, not a check.** The walk that found `Mob+0x428`
dereferences whatever looks like a pointer; it is how the offset was found, and it is not what the
probe runs now. The committed version follows only `0x400..0x440`, which is the component block --
still a real discrimination (it tells the three built-in mob components apart) with nothing wild in
it.

**A flake fixed in passing.** `hurtprobe hit` used to snapshot whichever non-player hurt landed
last, and a midnight session at difficulty normal has mobs hurting each other in the background:
one run reported `getLastHurtDamage 3` for a wandering trader that no armour had softened, and read
as a failure of the float fix. The player-caused hit is now sticky, and the decay reading is taken
from the very actor the snapshot belongs to.

## The Q1-0 B batch: ten names that are one field each

`docs/next-steps.md` Q1-0 B listed ten Actor/Player non-virtuals whose 2024 body
is a single field access and which 1.26 inlined away. **Four of the ten shipped;
this section says where the other six stand, because the interesting part is why
the method stops.**

The method is `tools/field-offset.mjs`, widened for this batch. It used to decode
only byte-sized `[reg+disp32]` forms -- enough for `isSpawned` -- and now takes
`--ops=byte,word,dword,lea,float,all` and has two more moves:

```sh
node tools/field-offset.mjs move <disp-hex> [--ops=...] [--callers-of=<rva>]
```

`move` is the whole correspondence in one command: it finds the baseline
functions that touch a displacement (or, with `--callers-of`, the callers of a
baseline leaf the inliner took), keeps the ones our tables name on the target
build, and ranks the target's displacements by how many of them touch it. Run on
the known answer it is unambiguous -- `move b58` (2024's `isSpawned`) gives
**1801 with support 3/3 on both builds and nothing else above 1/3**.

### What shipped

| name | how | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `?distanceTo@Actor@@QEBAMAEBVVec3@@@Z` | `derived()` | — | — |
| `?getSpeedInMetersPerSecond@Actor@@QEBAMXZ` | `derived()` over `layouts.Actor.stateVector` | +536 | +536 |
| `?hasOpenContainer@Player@@QEBA_NXZ` | `derived()` over `layouts.Player.containerManager` | +1440 | +1440 |
| `?setLocalPlayerAsInitialized@ServerPlayer@@QEAAXXZ` | `derived()` over `layouts.ServerPlayer.localPlayerInitialized` | **+3510** | **+3511** |

plus one address that is only an instrument:
`?canOpenContainerScreen@Player@@QEAA_NXZ`, 40 `0x225ad0` / 51 `0x2b4ac0`.

**The state vector.** 2024's `distanceTo` and `getSpeedInMetersPerSecond` both
take the `StateVectorComponent*` at `Actor+656` and work on `pos` (+0) and, for
the speed, `pos_prev` (+12), times 20. That pointer is **`Actor+536`** on 1.26 --
which this project has been reading since the first probe, because it is exactly
what the execution-confirmed `?getPosition@Actor@@` accessor returns. Endstone's
`state_vector_component.h` declares `pos` +0, `pos_prev` +12, `pos_delta` +24,
and a live falling rabbit shows all three.

**The container manager.** 2024's `hasOpenContainer` is
`cmpq $0,1872(%rcx); setne`. Two routes give +1440: `setContainerManager` stores
at 1440/1448/1456 on both builds where 2024's stores at 1872/1880, and
`canOpenContainerScreen` -- 65 bytes on all three builds, four steps in the same
order -- opens by testing the same member, with **`isInsidePortal` as its second
step**, the address confirmed by execution the same day.

**The initialized byte.** 2024's `setLocalPlayerAsInitialized` is
`movb $1,7754(%rcx); retq` and its only other baseline user is
`ServerPlayer::isPlayerInitialized`, which our tables *do* resolve on both
builds. 2024's (`0xccbad0`, 65B) is four steps: `cmpb` +2904, `cmpb` +7752, a
component check on `this+8`, `cmpb` +7754. 1.26's is the same four in the same
order with the component check inlined: `cmpb` **+1801** (the confirmed
`isSpawned`, 2024's +2904), `cmpb` +3508, the EnTT lookup, then `movzbl` of the
field as the return value -- **+3510 on 1.26.40.8 and +3511 on 1.26.51.1**. It is
the only offset in this batch that differs between the two builds.

### What the console proved

`fieldprobe dist|init|container|speedon|speed` in `tools/actor-layout-probe.ts`;
drivers `field40.ps1` / `field51.ps1`. Both builds **16/16 PASS, tsc 0, exit 0,
`Quit correctly`** (`work/host-runs/field40-20260921-194708.txt`, `field51-...`).
Every step is written so the thing that answers is not the thing being checked:

* **`distanceTo`** is measured to two points the *console* placed ten blocks
  apart on x, from a bot the console teleported to a known x. Whatever the
  player's own y is, `d2² - d1²` must be 100: it is **100.000** at two different
  positions on both builds.
* **`setLocalPlayerAsInitialized`**: BDS's own `isPlayerInitialized()` says true
  for a joined bot, **false** once bdsx zeroes +3510/+3511, and true again after
  `setLocalPlayerAsInitialized()`.
* **`hasOpenContainer`**: false for a bot with nothing open; true the instant
  bdsx writes a non-null pointer at +1440, at which moment **BDS's own
  `canOpenContainerScreen()` turns false**; both answers come back when bdsx
  clears it.
* **`getSpeedInMetersPerSecond` took three sessions and the first two were not
  about the address.** Read from a `levelTick` hook it is **0 for every actor**,
  always, on both builds -- and the probe's own dump says why: `pos` and
  `pos_prev` are *bit-identical* there while `pos_delta` holds that tick's
  movement. The engine has already copied pos into pos_prev by the time a tick
  hook runs, so 2024's formula is zero there too; this is not a 1.26 difference
  and not a wrong offset. The reading that answers comes from **inside** the
  actor's own tick -- a hurt hook on a falling rabbit -- where the two are still
  a tick apart: 1.26.40.8 gives **3.330 m/s** with pos and pos_prev 0.1665 apart
  in y, 1.26.51.1 gives **3.414** and **3.986** where the separation is 0.1707
  and 0.1993. Each is exactly twenty times the other, which is the function.

  The rule that costs the least to remember: **a getter over "what changed since
  last tick" cannot be checked from a tick hook.**

### Where the other six stood (all six are done -- next section)

As of the first pass nothing below was promoted and none of it was executed.

* **`?isInWorld@Actor@@` -- the offsets are found, the name it calls is not.**
  2024 is `this[+233] && hasDimension() && !this[+737]`, and `move e9` / `move
  2e1` give **+138 (support 2/2)** and **+617 (support 3/3)** on both builds,
  each unique at that support. It is blocked on `?hasDimension@Actor@@`, which is
  **unresolved on 1.26.40.8** and, on 1.26.51.1, ships an address that looks
  wrong: 242 bytes in 2024 against **1033** here, and a prologue that saves eight
  registers for what is a pointer test. That belongs in the Q3 audit.
* **`?setRespawnReady@Player@@` -- two of its three writes are found.** The body
  is a Vec3 store plus `movb $1,+2864` and `movb $0,+2905`. Both bytes moved into
  the block around the confirmed `isSpawned`: `Player::respawn` writes `movb imm`
  to **+1800** where 2024 writes it to +2864 (and `cmpb` twice to +1801 where
  2024 reads +2904), and `changeDimensionWithCredits` writes `movb imm` to
  **+1802** where 2024 writes +2905 -- the access *kind* is what separates them
  from their neighbours. Endstone's `player.h` declares `respawn_ready_`,
  `is_initial_spawn_done_`, `respawning_from_the_end_` consecutively, which is
  1800/1801/1802. The Vec3 is not found: `respawn_message_` is the `std::string`
  at **+1768** (its size at +1784 and capacity at +1792 are in `Player::respawn`,
  and 1768+32 = 1800), and Endstone puts `respawn_original_position_` immediately
  before it, so the Vec3 is +1756 or +1752 with padding -- and no function we
  resolve writes it.
* **`getPlatform` (+1580), `getSkin` (lea +1920), `setName` (+7472),
  `isUsingItem` (+2936) are blocked on the same thing**: `move` finds 15, 11, 1
  and 1 named baseline users respectively and **none of them is a name our 1.26
  tables resolve**, with or without `--callers-of`. They need a different lever
  than this one -- the obvious candidate is computing Endstone's declared Player
  layout and checking it against the seven offsets this project has confirmed.
  `setName` is also worth checking for survival first: it is 366 bytes in 2024,
  not a one-liner, so unlike the rest of this batch it may still be out of line.


## The rest of the B batch: six names, and the layout that was wrong about one of them

2026-09-22. The six names the section above left behind all shipped, and both
builds ran them: **20/20 PASS, tsc 0, exit 0, `Quit correctly`**
(`work/host-runs/field240-20260922-001821.txt`, `field251-...`). **Two of the
six were then taken back out of the table** because their check saw only one
side -- see "Candidates held back" below; the other five ship, and the rerun
without the two is **16/16 PASS** on both builds
(`work/host-runs/field240-20260922-005516.txt`, `field251-...`; `fieldprobe
platform|skin|name|using|worldon|world|respawnread|respawnwrite`, drivers
`field240.ps1` / `field251.ps1`).

| name | how | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `?setRespawnReady@Player@@` | `derived()` | Vec3 +2904, bytes +1800 / +1802 | same |
| `?isInWorld@Actor@@` | `derived()` | +138, +617, dimension ref +456 | same |
| `?hasDimension@Actor@@` | `derived()` since 2026-09-27 (51's shipped address stays retracted; "hasDimension: both sides") | dimension ref +456 / +464 | same |
| `?getPlatform@Player@@` | accessor `get` 4 | +1164 | +1164 |
| `?getSkin@Player@@` | `derived()` | `*(*(+2736))` | same |
| `?setName@Player@@` | **address** | `0x217380` (619B) | `0x2a4bd0` (533B) |
| `?isUsingItem@Player@@` | `derived()` since 2026-09-24 (see "`isUsingItem` promoted") | item at +1840 | same |

### The lever the previous section asked for

It said the four blocked names needed "a different lever -- computing
Endstone's declared Player layout and checking it against the offsets this
project has confirmed". That works, **but only locally**: count Endstone's
declarations forward or backward from the nearest confirmed member, never
from the top of the class. Every offset below was predicted that way and then
found in a 1.26 function that does the thing 2024's body did:

* **build_platform +1164**, counted back from the container manager (+1440).
  Both ServerNetworkHandler player creators (40 `0xa8ae00` / `0xa9bfb0`,
  51 `0x99dd70` / `0x9aea10`) call a function that builds the key
  `"DeviceOS"` (`movabsq $0x534F656369766544`) -- `ConnectionRequest::getDeviceOS`
  -- and store eax to +1164, where 2024's `createNewPlayer` / `_createNewPlayer`
  store the same call to +1580.
* **item_in_use_ +1832** (item +1840), counted forward from the respawn bytes
  (+1800..+1805, two optionals). `Player::getItemUseStartupProgress` (40
  `0x21d080` / 51 `0x2ab7b0`) opens with `lea 1840(%rcx)` and a call to the
  table's `ItemStackBase::isNull` -- 2024's `isUsingItem`, inlined -- and
  Endstone's own symbol table entry for `?completeUsingItem@Player@@` (40
  `0x21aa40` / 51 `0x2a86b0`) copies the ItemStack at `lea 1840(%rcx)` first.
* **skin_ +2736**, counted back from the respawn point (+2784). In 1.26 it is a
  `unique_ptr<SerializedSkinRef>` -- 2024 embedded the SerializedSkin at +1920
  -- and `Player::getActorRendererId` loads `movq 2736(%rcx)` and passes it to
  the same Level virtual that 2024 handed `lea 1920(%rsi)`. SerializedSkinRef is
  a shared_ptr to `ThreadOwner<SerializedSkinImpl>`, whose base is empty in a
  release build, so the impl is at the pointer's +0 and its members are 2024's
  SerializedSkin members in 2024's order.
* **respawn_position_candidate_ +2904** and **name_ +3008**, counted forward
  from the respawn point.

**The one Endstone was "wrong" about was our reading of it.** The queue said
the setRespawnReady Vec3 must be `respawn_original_position_` at +1756 or
+1752, because Endstone declares it right before `respawn_message_` (+1768).
The binary says otherwise: +1744 is a pointer loaded with `lea (%rip)`, +1752 a
qword and +1760 a byte, all written by the same respawn code. The Vec3 that
2024's setRespawnReady writes (+6604) is the same one 2024's
`setRespawnPositionCandidate` writes -- the **candidate** -- and in 1.26 that is
+2904: 1.26 inlined the whole three-store body into the successor of
setRespawnPositionCandidate (40 `0x56a6960` / 51 `0x9109070`: cvtsi2ss of the
confirmed respawn position +2796/+2800/+2804 plus 0.5, stored to 2904/2908/2912,
then `movb $1,1800; movb $0,1802`), and `Player::respawn` reads it with
`lea 2904` where 2024 reads `lea 6604`.

### setName survived

It was the one name in the batch not expected to be a one-liner (366B in 2024),
and it is still out of line: **40 `0x217380` / 51 `0x2a4bd0`**, the only
function in each image that takes `lea 3008(%rcx)` into rbx. The body is 2024's
three steps: assign the string to +3008 (with the self-assign guard and
size/capacity at +3024/+3032), copy it into the SynchedActorData wrapper's entry
4 (NAMETAG, through the confirmed `entity_data` at +296), clear the string at
+736 (2024 +880, `filtered_name_tag_`). It has exactly four callers on both
builds, as 2024's has four, and two of them are the DeviceOS-storing creators
above. +3008 is also where the already-shipping `?getName@Player@@` accessor
points.

### hasDimension: the address 51 shipped was not it

2024's `hasDimension` (242B) is a weak_ptr lock test on +576/+584. The
propagation address 51 shipped (`0xd4ee00`) is 1033B, saves eight registers
and reads rdx, r8, r9 and a stack argument -- retracted. No 1.26 function has
the 2024 shape; the ones that load the WeakRef control block (+464) first are
unconditional locks (getDimension-style). The reference itself is the
live-confirmed `getDimension` accessor at +456, so bdsx derives the test.

### What the console proved

* **getPlatform / getSkin**: the bot now puts chosen values in its login chain
  (`BP_DEVICE_OS=12`, `BP_SKIN_ID=bdsx-revival-probe.Custom`,
  `tools/probe-client.cjs`). bdsx reads 12 and that SkinId back, and `fullId`
  -- two strings later -- starts with it. `playFabId` reads empty although the
  library sends a random one; the server evidently does not keep it for an
  untrusted skin. Nothing after the five strings (images, geometry JSON) was
  checked.
* **setName**: BDS's own function (the address) renames the bot; the `getName`
  accessor and **BDS's own `getNameTag()`** both read the new name, and renaming
  back restores both. bdsx's public `Player.setName()` then throws in
  `updatePlayerList`: `??0PlayerListEntry@@QEAA@AEBVPlayer@@@Z` is not in either
  table. The rename has happened by then.
* **isUsingItem**: the qword at +1840 on a live bot **is `??_7ItemStack@@6B@`**;
  isUsingItem() is false; with the selected apple's 152 bytes copied over the
  slot it is true, and false again once the original bytes are restored (no BDS
  code runs in between). A bot cannot really use an item, so the engine never
  set this slot in front of the probe.
* **isInWorld / hasDimension**: every captured mob is fetched each tick twice
  through BDS's own `Level::fetchEntity` -- allowing removed actors and not --
  and isInWorld() agreed with the second on **1204 / 684 samples, 0
  disagreements**, including the one tick per mob where BDS had set the removed
  byte and no longer returned it. hasDimension() was only ever seen true.
* **setRespawnReady**: after `spawnpoint @a 34 68 16` and `kill @a`, the engine
  itself leaves **34.5 / 16.5** at +2904 and the player standing there; then
  bdsx's setRespawnReady((31.5, 69.25, 17.5)) followed by **BDS's own
  `Player::respawn()`** puts exactly (31.5, 69.25, 17.5) into the state vector's
  pos_prev and the player at x 31.5 z 17.5.


### Candidates held back

A check that could only ever answer one way does not ship. Both of these have
two static routes and a live reading, and both are **documented candidates,
not table entries**: no `layouts` key, no `derived()`, not in
`data/derived.json`. bdsx still calls them through `procHacker.js`, which is
"Symbol not found" on both builds, exactly as before.

**`?isUsingItem@Player@@` -- candidate `!isNull(Player+1840)`.**
PlayerItemInUse at +1832, its ItemStack at +1840 (2024 +2928/+2936). Routes:
`Player::getItemUseStartupProgress` (40 `0x21d080` / 51 `0x2ab7b0`) opens with
`lea 1840(%rcx)` and the table's `ItemStackBase::isNull` (that is 2024's
isUsingItem, inlined); Endstone's own `?completeUsingItem@Player@@` symbol
(40 `0x21aa40` / 51 `0x2a86b0`) copies the ItemStack at `lea 1840(%rcx)`; and
Endstone's declarations counted from the respawn bytes (+1800) land there.
Live: the qword at +1840 is `??_7ItemStack@@6B@` on both builds and `isNull`
is true for an idle bot (`fieldprobe using`, printed as `CAND`).
**What is missing:** the engine has never been seen putting an item there -- a
headless bot cannot start using one, and the only positive reading was bdsx
copying bytes into the slot itself. To promote it: a real item use (Q7, a
human client eating or drawing a bow) with the slot read non-null while BDS's
`ActorFlags::USINGITEM` flag (already readable) is set, and null again after.

**`?hasDimension@Actor@@` -- candidate: the WeakRef<Dimension> at +456 locks.**
Control block +464 non-null with a non-zero use count, then the pointer at
+456 non-null (2024 0x19b69f0 does the same on +576/+584). +456 is the
live-confirmed `getDimension` accessor. **What is missing:** the false branch.
Every actor ever read had a dimension. To promote it: read an actor whose
dimension reference is dead or empty (an actor mid-dimension-change, or one
constructed but not yet added) and see false where BDS's own code treats it as
dimensionless.

**Mid-dimension-change ruled out (2026-09-24, `dimw40`/`dimw51`, `tools/block-probe.ts` `dimwatch`/`dimreport`).**
The bot's and simbot's reference was sampled every tick for 400 ticks, through `execute as @a in nether run tp` and
back. Neither changed state once on either build: the pointer was set, the control block was set, and the use count
was 1 throughout. The transfer swaps the reference within a tick, or keeps it valid. Of the cases left:
- "constructed but not yet added" has no bdsx event: `entityCreated` (`bdsx:ActorEventCoordinator::sendActorCreated`)
  fires after the add;
- "after removal" would read a freed object, which `findings-reach.md` forbids.

`isInWorld` ships and uses the same dimension test internally. Its check is
strong for the `added`/`removed` bytes -- it agreed with BDS's
`fetchEntity(id,false)` on every sample, including the removal tick -- but its
dimension clause has the same one-sided evidence as above.


## `isUsingItem` promoted (2026-09-24)

The candidate held back above had been seen only false, because the loading-screen bot never uses an item. A simulated
player can: `bdsx:SimulatedPlayer::create`, then `simulateUseItemInSlot` on a bow with arrows
(`docs/findings-slots.md` "SimulatedPlayer actions"). **Executed** (`sbow40`/`sbow51`, `tools/block-probe.ts
simact bow`):
- Before drawing, simbot's ItemStack at `+1840` is null and the `USINGITEM` actor flag is clear.
- While the bow is drawn, the slot holds the bow and the flag is set.
- The connected bot shows null and clear.

Both sides agree with the flag on both builds. `isUsingItem` is now a `derived()` over `layouts.Player.itemInUse`, and
bdsx's own `isUsingItem()` matched the slot in every case. `hasDimension` stays held back: it has only ever been seen
true.

## hasDimension: both sides (2026-09-27)

The candidate above had only ever been seen true. What was missing was an actor the engine had built but not yet
added. The `ILevel` add functions receive exactly that.

**Where.** Endstone's `level_interface.h` declares `addEntity`, `addGlobalEntity`, `addAutonomousEntity` and
`addUser` in that order. On both builds the header runs one slot behind ServerLevel's ILevel table (read from a
live object, so exact). Three confirmed neighbours show the +1: `getDimension` is table slot 6 (header 5),
`getDifficulty` 36 (35), `hasCommandsEnabled` 40 (39). So the four are slots 43-46: on 40 `0x7385d0`,
`0x7381b0`, `0x7384f0`, `0x738ed0`, and on 51 `0x7cf340`, `0x7cef20`, `0x7cf260`, `0x7cfc40`.

Bodies read on both builds:
- 43 and 44 are the same code with a different actor-manager call (40 `0x14e03d0` / `0x14e04b0`, 51 `0x1654840` /
  `0x1654920`). Each takes `rdx` = `BlockSource&`, `r8` = the `OwnerPtr<EntityContext>`, and moves the context
  out: 16 bytes at +0, the id at +0x10, the engaged byte at +0x18 cleared. It then hands the context to
  `this+0x418` and returns the `Actor*`.
- 45 does the same through `this+0x438`.
- 46 takes only the `OwnerPtr` (`rdx`) and goes through `this+0x458`: the `addUser` shape.

Both 40 and 51 also destroy a leftover entity through `(%rdx)+0x30`: the entt registry inside `EntityRegistry`.
That matches `engineLayout("EntityRegistry", "registry", 0x30)`.

**The probe.** `tools/block-probe.ts`, `ADD_PROBE=1`, drivers `addp40`/`addp51`. It puts pass-through hooks on
the four slots. At entry it takes the Actor from the context: the `ActorOwnerComponent`'s +0 through
`enttComponent(owner - 8, ...)`, since an Actor's own context starts at +8. It then reads the dimension
reference, calls the original, and reads it again. Each call also checks that `owner+8` equals
`owner[0]+0x30`. The session summons a pig, a zombie, an armor stand and a pig in the nether, and makes a
simbot; the world spawns the rest.

**Result, executed** (`addp40-20260927-164807`, `addp51-20260927-164807`; tsc 0, exit 0, `Quit correctly`,
`addreport` PASS on both):

| build | `addEntity` calls | reference empty at entry | set after the add | `addUser` (players) |
|---|---:|---:|---:|---|
| 1.26.40.8 | 49 | 32 | 49 of 49 | 2, set on both sides |
| 1.26.51.1 | 53 | 33 | 53 of 53 | 2, set on both sides |

- In every call the log kept (the first 24 per session), an empty reference had both the control block and the pointer null (`uses -1`). Afterwards it was
  set with a use count of 1, and the returned `Actor*` was the actor read at entry every time.
- `owner+8 == owner[0]+0x30` held on every call.
- An earlier pair (`addp40/51-20260927-164451`, before the change below) gave the same split with the raw
  reading alone: 20 of 40 and 20 of 44 empty at entry, all set after.
- Some actors arrive with the reference already set. They were built through a path that sets it at
  construction; the test does not depend on which path.
- Slots 44 and 45 were never called in these sessions.

**Shipped.** `?hasDimension@Actor@@` is now `derived()` over the test `isInWorld` already used
(`actorHasDimension` in `implements.ts`). It is declared on `Actor`, where 2024 had it, instead of `Player`;
`Player` inherits it. In the PASS runs the counts above are bdsx's own `hasDimension()`, compared on every
call with the raw reading: 0 disagreements. 51's propagation address `0xd4ee00` stays retracted
(`candidates-instances-1.26.51.1.json`). `data/derived.json` has the entry.


## OnFireSystem: `setOnFire` by address, `setOnFireNoEffects` through the script entry point (2026-09-27)

Queue row "Single missing addresses" (A1). `Actor.setOnFire`/`setOnFireNoEffects` called
`?setOnFire@OnFireSystem@@SAXAEAVActor@@H@Z` / `?setOnFireNoEffects@...`, neither with an address on either build.

**2024** (1.21.3.01): `setOnFire` (`0xa800d0`) = `isInWaterOrRain`, Fire Protection levels for a mob
(`EnchantUtils::getTotalProtectionLevels`, type bit `0x100`), `thawFreezeEffect`, then on the server with seconds > 0
(and not in water/rain with a dimension set): ticks = seconds*20 scaled by the protection, `getOrAddComponent
<OnFireComponent>`, ticks = max, and the byte at +4 set to 1. `setOnFireNoEffects` (`0xa80200`) is only the
getOrAdd + max: no thaw, no tests, and the +4 byte left alone. 17 callers of the first, 6 of the second, and
`ScriptActor::setOnFire` (`0x17011b0`) calls both by its `useEffects` argument.

**1.26, the route.** `FireBlock`/`SoulFireBlock::entityInside` are table names on both builds and 2024 tail-jumped
from them to `setOnFire`. In 1.26 they compute the water test and the protection levels themselves and tail-jump to
a four-argument core (40 `0x2cb44b0` / 51 `0x2f1d890`: `(Actor&, int, bool inWater, int protection)`, the rest of
the 2024 body; the OnFireComponent hash `0x7e613ff3` inline). The core's callers include a 70-byte function
(40 **`0x2cb4460`** / 51 **`0x2f1d840`**) with exactly the old interface, `(Actor&, int)`: `isInContactWithWater`,
the protection levels, then a tail-jump to the core. That is `OnFireSystem::setOnFire`, shipped under its 2024
name. Its callers include `ArmorStand::_hurt`, a 2024 caller.

`setOnFireNoEffects` has no copy. The OnFireComponent-hash users include one 536-byte function on each build
(40 **`0x4350fa0`** / 51 **`0x44b11a0`**) with 2024 `ScriptActor::setOnFire`'s shape: `(this, Result<bool>* sret,
Actor&, int seconds, bool useEffects)`, seconds <= 0 gives false, `useEffects` runs the inlined wrapper and calls the
core, and the other arm is 2024's `setOnFireNoEffects` inlined (storage lookup, emplace if missing, `shl 2; lea
*5` = *20, `cmovg`). `this` (rcx) is never read, and the 5th argument is read at `[rsp+0x80]` after five pushes and
`sub 0x30`. The result is written at +0x00..+0x47; its error half is an empty `entt::meta_any` with nothing to free.
Shipped as `bdsx:ScriptActor::setOnFire`, and `setOnFireNoEffects` is `derived()` over it with `useEffects` false
(`bdsx/bds/engine/onfire.ts`, bdsx `d6ca8d27`).

**What the fire system does with the +4 byte.** 2024 `OnFireServerSystem::_tickServerImpl` (`0xa6cb00`) zeroes the
ticks of a player whose `Invulnerable` ability is set unless the byte is set, and puts out the passengers. A joining
bot is invulnerable from an ability layer (`abilities-probe.ts`), so a no-effects fire on it goes out on the next
tick. That is the engine's own rule, and the probe tests it as one.

**Executed, both builds** (`fire40`/`fire51`, `verify-pair.mjs`, `tools/actor-layout-probe.ts` `fireprobe`, 11 PASS /
0 FAIL each, tsc 0, exit 0 + `Quit correctly`; `work/host-runs/fire40-20260927-182850.txt`, `fire51-...`). The
witness is the OnFireComponent read through the engine layer's entt lookup (8 bytes: ticks, byte), plus
`ActorFlags.OnFire` and health:

| step | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| before: cow and bot | no component, flag false | same |
| `setOnFireNoEffects(12)` on a summoned cow and the bot | ticks 240, byte 0 on both | same |
| 8 s later, cow | ticks 80, flag true, health 10 -> 2 (burnt to death before the next step) | ticks 81, same |
| 8 s later, bot (Invulnerable true) | component gone, flag false: the engine's rule above | same |
| `setOnFire(12)` on the bot | ticks 240, byte 1 | same |
| 8 s later, bot | ticks 79, flag true | ticks 80, flag true |

Three earlier runs of the pair were probe mistakes, and none of them was a wrong address. A `setTimeout` check ran only at
shutdown, on a decayed `Player`. The bot was expected to burn under the no-effects form, which the invulnerable rule
forbids. A console `tag @e[...,r=3]` missed a cow that had walked off. In all three, every `setOnFire` check passed on
both builds.

## `Actor.teleport`: `TeleportCommand::computeTarget` / `applyTarget` (2026-09-27)

Queue row "`Actor.teleport`" (A1). bdsx's `Actor.teleport(pos, dimensionId, facePosition)` called
`?computeTarget@TeleportCommand@@SA?AVTeleportTarget@@...` and `?applyTarget@TeleportCommand@@SAXAEAVActor@@VTeleportTarget@@_N@Z`,
neither with an address on either build. Endstone declares both but lists neither, and does not use them: its own
`Actor::teleport` is `teleportTo` for the same dimension, `Level::requestPlayerChangeDimension` for a player going
elsewhere and `Level::entityChangeDimension` for anything else. That is also exactly what 2024's `applyTarget` does.

**2024** (1.21.3.01): `computeTarget` (`0x17317c0`) = `(TeleportTarget* sret, Actor&, Vec3 (by value, so a pointer to
the caller's copy), Vec3* facing, DimensionType, optional<RotationData> const&, int commandVersion)`. It returns a
0x30-byte `TeleportTarget`: `optional<Vec2>` rotation (+0, engaged +8), `optional<TeleportData>` (+0xc destination,
+0x18 stop-riding, +0x1c cause 3, +0x20 entity type 1, engaged +0x24) when the dimension is unchanged, and
`unique_ptr<ChangeDimensionRequest>` (+0x28) when it differs. `applyTarget` (`0x17315d0`) takes the target by value
and owns it: rotation, then the request goes to ILevel `+0x70` (player) / `+0x78` (other), else `teleportTo` (vftable
`+0xb8`); `teleportPassengersTo`, `setYBodyRotation` for a Mob; frees the request. The two are called together by four
functions: the tp command's `std::function` lambda (`0x171c9e0`, stored at command+0x20 by
`allocateCommand<TeleportCommand>`) and three `ScriptActor` teleports.

**1.26, the route.** The literals `commands.tp.success.coordinates` / `safeTeleportFail` / `far` have one `lea` user
per build: 40 `0x3c88a80`, 51 `0x3a15e70`, slot 2 of an .rdata table (40 `0xa6fa850`, 51 `0xa811d60`) whose slot 1 is
`Command::collectOptionalArguments` -- `TeleportCommand`'s vftable. Its only other `lea` user is
`allocateCommand<TeleportCommand>` (40 `0x3cb8d30`, 51 `0x3a53c70`, 0x2f0 bytes as in 2024), which stores the lambda's
`_Func_impl` vftable at +0x20 (40 `0xa6faa10`, 51 `0xa811fc0`). Its slot 2, `_Do_call` (40 `0x3cb9040`, 51
`0x3a53f60`), is 2024's lambda: two calls, the first one's sret handed to the second.

| | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `computeTarget` | **`0x3c88710`** | **`0x3a15b20`** |
| `applyTarget` | **`0x3c88370`** `(Actor&, TeleportTarget, bool)` | **`0x3a15770`** `(Actor&, TeleportTarget, int version, bool)` |
| callers of each | the lambda + `0x433f180`, `0x433fb10`, `0x4358f40` | the lambda + `0x449ff30`, `0x44a0830`, `0x44b9510` |

Both are still out of line, and each has 2024's four callers (5 call sites: one script teleport calls the pair on two
paths, and `0x4358f40` also calls `actorToLocationTeleportAnalysis`, as 2024's `ScriptActor::_teleport` does).

- **`computeTarget` is unchanged** on both builds. It has the same registers and stack arguments (dimension at the 5th
  slot, compared with 3 = `Undefined`, then with `getDimensionId`; the optional at the 6th, engaged byte +0x1c; the version
  at the 7th, compared with 0x15 / 0x17 / 2) and the same 0x30-byte target (`movabs $0x100000003` into +0x1c). The
  `ChangeDimensionRequest` is still 0x30 bytes and now has a polymorphic owned pointer at +0x28, which `applyTarget`
  deletes through its vftable. `DimensionType` is still one int, and `optional<RotationData>` is 0x20 bytes: two
  `RelativeFloat`s, an `optional<Vec2>` at +0x10/+0x18, and the engaged byte at +0x1c. bdsx's old
  `TeleportRotationData` (0x18 bytes) + `CxxOptional` was not checked against that layout. The engine layer passes its
  own zeroed 0x20-byte nullopt instead. It ships under the 2024
  decoration.
- **`applyTarget` changed on 51.** It has a third argument, the command version (`r8d`; the bool moved to `r9b`),
  compared `cmpl $0x33` into a flag in the request handed to ILevel slot 19 (0x98) for a non-player. On 40 it is 2024's
  three arguments, with ILevel slot 17 (0x88, `requestPlayerChangeDimension`, already shipped) for a player, slot 19
  otherwise, and `teleportTo` at Actor vftable `+0xa8` (slot 21 on both builds). The 2024 decoration no longer names the
  51 function, so both builds ship it as **`bdsx:TeleportCommand::applyTarget`**. The per-build fact
  `layouts.TeleportCommand.applyTargetVersionArg` (0 / 1) says whether to pass the version.

**The command version.** The engine's own `ScriptActor` teleports pass `0x32` to both functions on both builds
(`movl $0x32, 0x30(%rsp)` / `movl $0x32, %r8d`). 2024 bdsx passed 0, and at a version <= 0x17 `computeTarget` adds a
player's height offset to y when the dimension changes. The first run showed it: the bot arrived in the nether at eye
y 83.24 for a requested 80, which is 1.62 too high. `engine/teleport.ts` passes 0x32. The position is copied into a
fresh buffer, because `computeTarget` writes the caller's copy of it.

**bdsx** (`bdsx/bds/engine/teleport.ts`, bdsx `dad3a58a`; `implements.ts` `Actor.prototype.teleport` calls `teleportActor`).

**Executed, both builds** (`tp40`/`tp51`, `verify-pair.mjs`, `tools/actor-layout-probe.ts` `tpprobe`, 10 PASS / 0
FAIL each, tsc 0, exit 0 + `Quit correctly`; `work/host-runs/tp40-20260927-231204.txt`, `tp51-...`). The witness is
BDS's `getPosition()` / `getDimensionId()` after the call, and 8 s later. A pig is re-created when it changes dimension,
so it is found again by its tag. An overworld ticking area keeps the pig's chunk loaded while the bot is in the nether.
The bot's `getPosition()` is its eye, 1.62 above the feet.

| `teleport(...)` | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| bot -> (35.5, 68, 20.5), Overworld | dim 0, 35.50, 69.62, 20.50; same 8 s later | same |
| pig -> (24.5, 68, 10.5), Overworld | dim 0, 24.50, 68.00, 10.50 | same |
| bot -> (0.5, 80, 0.5), Nether | dim 1, 0.50, 81.62, 0.50 | same |
| pig -> (1.5, 79, 1.5), Nether | re-listed at once: dim 1, 1.50, 79.00, 1.50; still dim 1 8 s later | same |
| pig -> (31.5, 68, 17.5), Overworld, from the nether | dim 0, 31.50, 68.00, 17.50 | same |
| bot -> (29.5, 68, 14.5), Overworld, from the nether | dim 0, 29.50, 69.62, 14.50 | same |

The first pair (version 0, `tp40-20260927-230801.txt`) moved every actor the same way. It differed in the player's
+1.62 across dimensions, and in two checks that expected a pig to stand still for 8 s (it had walked 10 blocks). The
`layout` regression pair after the change: 27 PASS / 0 FAIL on each build (`layout40-20260927-231526.txt`, `layout51-...`). `facePosition` (the rotation branch) was not exercised.

## `ActorDefinitionIdentifier` and `spawnEntityAt` (2026-09-27)

Queue row "`ActorDefinitionIdentifier.constructWith`" (A1). `constructWith` bound
`??0ActorDefinitionIdentifier@@QEAA@W4ActorType@@@Z` and `...@AEBV?$basic_string...@Z`, and `Actor.summonAt` goes on to
`?spawnEntityAt@CommandUtils@@...`: none of the three had an address on either build.

**The object** is 0xb0 bytes on both 1.26 builds, as in 2024: namespace, identifier, initEvent, fullName (std::string
at +0x00/+0x20/+0x40/+0x60), then `HashedString canonicalName` (+0x80 hash, +0x88 string, +0xa8 last match). Every
constructor below writes exactly that range, and all of them end in `_initialize` (40 `0x18fe290`, 51 `0x1cdecd0`), the
call 2024's constructors end in too (`0x17e0e10`). Its 20 direct callers per build are where the constructors are.

| | 2024 | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `ActorDefinitionIdentifier(const std::string&)` | `0x17bdfa0` | `0x18ffbe0` (208 B) | `0x1ce0310` (208 B) |
| `ActorDefinitionIdentifier(ActorType)` | `0x17be390` | gone | gone |
| `ActorDefinitionIdentifier(ActorType, std::string)` | -- | `0x18ffd00` (476 B) | `0x1ce0430` (476 B) |
| `CommandUtils::spawnEntityAt` | `0xd216d0` | `0x386a60` (225 B) | `0x3d5c10` (225 B) |

- **String constructor**: 2024's body instruction for instruction (clear the five members, `_extractIdentifier(name,
  *this)` -- the one with the `<`, `>`, `:` byte compares -- then `_initialize`). Same signature: it ships under its
  own decorated name. The propagation candidate (40 `0x652d400`, 51 `0x30d00c0`) is an uninitialized-move loop over
  0x80-byte records; merge-symbols' shape check had vetoed it, and `resolved` now wins the conflict.
- **ActorType**: the one-argument constructor is gone. What propagation offered for it (40 `0x18ffd00`, 51
  `0x1ce0430`, vetoed because the body reads r8) is its replacement, `(ActorType, std::string initEvent)` with the
  string by value: "minecraft" into +0x00, `EntityTypeIdWithoutCategories(type, 0)` into +0x20, the r8 string moved
  into +0x40, `EntityCanonicalName(type)` copied into +0x80, `_initialize`, then the by-value string destroyed. It is
  the only function that calls both `EntityTypeIdWithoutCategories` and `EntityCanonicalName` on either build. 2024's one-argument body is this with an empty initEvent, so bdsx passes an empty small string. It ships
  as `bdsx:ActorDefinitionIdentifier::ActorDefinitionIdentifier(ActorType,std::string)`; the one-argument name is in
  `retracted` so propagation cannot bring it back.
- **`spawnEntityAt`**: found from `SummonCommand::execute` (the only `lea` user of `commands.summon.success`: 40
  `0x3c7ea90`, 51 `0x3a0af80`), right after its inlined identifier copy and `_initialize`: rcx = the area's
  BlockSource, rdx = &Vec3, r8 = the identifier, r9 = &ActorUniqueID(-1), stack = summoner -- 2024's prototype. The
  body is 2024's with its callees inlined: forward the stack argument to `_spawnEntityAt` (40 `0x386b50`, 51
  `0x3d5d00`, its only caller), then `isRemoved` (Actor+0x269), the isMob tests as a type-bit test, and
  `setPersistent` as an EnTT emplace (hash 0xFAD8D24F). Its three callers are the summon command and RideCommand's
  summonPassenger/summonVehicle folded into one function (40 `0x3d685b0`, 51 `0x3b010d0`, two calls): 2024's three.

`constructWith` is now `engine/actordefinition.ts` (A4 form), and `Actor.summonAt`'s type also takes an `EntityId`
string, which its body always handled.

**Execution** (`tools/actor-layout-probe.ts` `summonprobe`, drivers `summon40`/`summon51`, three paired runs, 10 PASS /
0 FAIL on each build each time, tsc 0, `Quit correctly`; last `work/host-runs/summon{40,51}-20260927-233948.txt`):
`constructWith("minecraft:pig")`, `("pig")` and `(ActorType.Pig)` read back namespace "minecraft", identifier "pig",
initEvent "", fullName "minecraft:pig<>", canonical "minecraft:pig" with hash `0xBD8B47AF002B8760` on both builds; an
unknown name constructs just as well (the constructor does not validate). `"minecraft:pig<minecraft:entity_born>"`
splits into identifier "pig" and initEvent "minecraft:entity_born". `Actor.summonAt` by name, by numeric `ActorType`
and from a prebuilt identifier each returned a `minecraft:pig` at the asked position, all three still listed by the
level 8 s later; the unknown name returned null -- the other side. `layout40`/`layout51` stayed 27 PASS / 0 FAIL.

Not checked: `CommandSelectorBase.addTypeFilter`, which also calls `constructWith`, was not run (its selector layout is
its own question). An aside for the audit: 1.26's `_spawnEntityAt` tail-jumps for `ActorType` 0x138 (Agent) with
(Vec3, summoner) to the address the table calls `?_spawnActorAt@ActorPlacerItem@@...` (40 `0x259ba00`, from
gaps-agree), which is where 2024 called `ActorPlacerItem::spawnOrMoveAgent(Vec3 const&, Actor&)`. bdsx does not
require that name, so it was left alone. And the gaps route's candidate for `spawnEntityAt` on 40 (`0x18fe290`,
`data/candidates-gaps-1.26.40.8.json`) is `_initialize`, not the function; the hand verdict in `data/arch-classes.json`
("gap-agreement candidate, not executed") is removed now that the name ships.

## `SerializedSkin`: 1.26's `SerializedSkinImpl`, its constructor, its inlined destructor, no copy (2026-09-28)

Agent-aa. The four names in `bds/skin.ts` had no address on either build:
- `??0SerializedSkin@@QEAA@XZ`, the default constructor;
- `??1SerializedSkin@@QEAA@XZ`, the destructor;
- the copy constructor `...@AEBV0@@Z` and the move constructor `...@$$QEAV0@@Z`.

The class is gone under that name. The "skin: +2736" note above already has the shape: the Player holds a
`unique_ptr<SerializedSkinRef>`, and a `SerializedSkinRef` is a `shared_ptr<ThreadOwner<SerializedSkinImpl>>` (Endstone
`serialized_skin.h`/`.cpp`, Apache-2.0). `ThreadOwner`'s base is empty, so bdsx's `SerializedSkin` is `SerializedSkinImpl`.

**Where every Impl comes from.** Each one is made by `std::make_shared`:
- the engine allocator gives 0x240 bytes;
- the control block's vptr and two counts come first, then 0x230 bytes are memset;
- a constructor runs on block+0x10.

The block's vftable is 40 `0xa621b20` / 51 `0xa79f500`. Slot 0 is `_Destroy`, slot 1 deletes the block. The vftable is
stored at exactly 19 places on each build. Each store is followed by one of four constructor calls, and those four
constructors have no other callers:

| constructor | 40 | 51 | sites |
|---|---|---|---|
| `SerializedSkinImpl()` | `0x1262bc0` | `0x24c2810` | 16 (`SerializedSkinRef()`, `PlayerListEntry(const Player&)`, `PlayerSkinPacket()`, ...) |
| from `ConnectionRequest`, `SubClientConnectionRequest`, and the many-argument form | `0x124bf90`, `0x124d970`, `0x124efe0` | `0x24a6fc0`, `0x24a8a70`, `0x24a9fe0` | one each |

- **No copy or move constructor exists**, out of line or inlined. Every construction is one of those 19, and none takes
  an Impl.
- The only destructor with the Impl's shape is the control block's `_Destroy`. That was checked by scanning every call
  to `Json::Value`'s destructor for two members 0x30 apart plus the string tail. So no Impl lives outside a control block.
- A skin is shared, never copied. `PlayerListEntry`'s constructor makes a default Impl, then overwrites the pointer with
  the Player's `shared_ptr` (`lock inc`).

**The constructor.** `SerializedSkinImpl()` is 597 B and was read in full on both builds. It writes every member and
reads none. The two builds differ in one immediate only, the `CurrentCmdVersion` it stores: 50 on 40, 52 on 51.

**The destructor.** It exists only inlined into `_Destroy`: 40 `0x1262590` / 51 `0x24c21e0`, 1420 B, the same shape on
both builds, with no direct callers.
- It destroys every Impl member at block+0x10 and up, in reverse order.
- It never touches block+0..+0xf and frees neither the block nor the Impl.
- So `_Destroy(impl - 0x10)` is `~SerializedSkinImpl()`.

**The layout.** Fixed from three functions that agree member for member: the constructor, `_Destroy`, and
`SerializedSkinImpl::operator==` (40 `0x12511e0` / 51 `0x24ac590`, 948 B). The 51 bodies of all three have 40's shape
once addresses are masked.

| member | 2024 | 1.26 |
|---|---|---|
| five strings, two `mce::Image`, animated images, `geometryData` | +0 .. +0x118 | same |
| geometry engine version | `SemVersion` +0x128 (0x70 B) | **`MinEngineVersion`** +0x128 (0x20 B): a 24-byte SemVersion (u16 major/minor/patch, then `StaticOptimizedString`s), `CurrentCmdVersion` +0x18, `MolangVersion` +0x1c |
| `geometryDataMutable`, `animationData`, `capeId`, `personaPieces` | +0x198, +0x1a8, +0x1c8, +0x1e8 | +0x148, +0x158, +0x178, +0x198 |
| `armSizeType` | +0x200 | +0x1b0, a **byte** (`persona::ArmSize::Type : uint8_t`) |
| tint map, colour | +0x208, +0x248 | +0x1b8, +0x1f8 |
| trusted, premium, persona, capeOnClassic, primaryUser | +0x258..+0x25c | +0x208..+0x20c |
| `overridesPlayerAppearance` (login `"OverrideSkin"`) | +0x25d | +0x20d |
| `profileHash` (login `"ProfileHash"`, new) | -- | +0x210 |
| size | 0x260 | **0x230** |

The login-key names come from the `ConnectionRequest` constructor's stores. It calls getters whose SSO-immediate keys
are `"PremiumSkin"`, `"PersonaSkin"`, `"TrustedSkin"`, `"OverrideSkin"` and `"ProfileHash"`, and stores their results
to +0x209, +0x20a, +0x208, +0x20d and +0x210.

`PlayerSkinPacket` also changed. Its default constructor (40 `0x1f5ad60` / 51 `0x3332ff0`) stores the uuid at +0x30 and
a `SerializedSkinRef` at +0x40/+0x48, where 2024 held the skin by value. The names follow at +0x50/+0x70, and the
serialization mode at +0x90.

**The skin check on login.** After `SerializedSkinRef(ConnectionRequest)`, `ServerNetworkHandler` (40 `0xa8d870`) checks
the skin. A skin that fails is replaced by a default Impl marked trusted (2):
- a persona skin needs a valid geometry version;
- a non-persona skin needs an 8K/16K/64K image and must be trusted;
- width and height must be 1..4096, pieces at most 28, the tint map no larger than the piece list, animated frames at
  most 0xfa00 bytes, and arm size 0 or 1.

The first `skin40/51` run sent `PersonaSkin: false` and read back exactly that default. The run is recorded, not
counted.

**What ships** (`bds/engine/serializedskin.ts`, `bds/skin.ts`, `bds/packets.ts`):

| bdsx name | how |
|---|---|
| `??0SerializedSkin@@QEAA@XZ` | `derived()`: `??0SerializedSkinImpl@@QEAA@XZ`, now an address |
| `??1SerializedSkin@@QEAA@XZ` | `derived()`: `bdsx:std::_Ref_count_obj2<ThreadOwner<SerializedSkinImpl>>::_Destroy` on `this - 0x10`. A `bdsx:` key, because `ThreadOwner`'s enum template argument makes the decoration unknowable |
| copy, move | **dropped as `gone`** (`data/dropped.json`). `ctor_copy`/`ctor_move` throw "not available on BDS 1.26" instead of bdsx's field-wise copy, which would double-free |

- The layout goes to `layouts.SerializedSkin` and `layouts.PlayerSkinPacket` through `engineLayout`.
- `geometryDataEngineVersion` is now a `MinEngineVersion`, and `armSizeType` is a `uint8_t`.
- `AnimatedImageData.animationExpression` (+4) and the two new members are added.
- `PlayerSkinPacket.skin` follows the pointer.

**Execution, both builds.** Drivers `skin40`/`skin51` through `verify-pair`, with `tools/actor-layout-probe.ts`
`skinprobe read|life|packet <cmdVersion>`. The bot's skin is set with `BP_SKIN_ID` and the new `BP_SKIN_JSON` of
`tools/probe-client.cjs`. Result: 21 PASS / 0 FAIL each, tsc 0, exit 0, `Quit correctly`
(`work/host-runs/skin40-20260928-024905.txt`, `skin51-...`).
- **read**: `getSkin()` is the object 0x10 into a control block whose vftable slot 0 is the shipped `_Destroy`. Through
  bdsx's 1.26 layout, 13 fields match what the bot sent:
  - id, `fullId` (starts with the id), `capeId`, and `animationData` (the base64 decoded);
  - `profileHash`, and geometry version 1.21.30;
  - arm size slim (0), premium, persona, cape-on-classic, override;
  - a 256x256 image holding w*h*4 bytes, and 9 persona pieces, each with an id and a type.
- `playFabId` still reads empty (see "What the console proved" above), so `fullId` at +0x40 is the check there.
- **life**: `SerializedSkin.construct()` on 0xcd-filled memory reads back every member as the constructor writes it
  (`CurrentCmdVersion` 50 / 52, molang -1). Then 200 rounds: construct, three heap strings written and read back,
  destruct. After each destruct the engine had reset the strings to empty SSO and zeroed the tint map's buckets.
- **copy and move**: both throw the message, including a copy of the bot's live skin.
- **packet**: 200 engine-made `PlayerSkinPacket`s hold a default Impl behind the ref at +0x40. Both names at +0x50/+0x70
  read back, and `dispose` is clean.
- `layout40/51` was 27/27 after the change.

## LevelChunk and BlockActor on 1.26 (2026-09-29)

`LevelChunk::getMin`, `getMax`, `getPosition` and `toWorldPos`, and `BlockActor::getType`, threw on both builds. Each
was a 2024 leaf (`lea 0x60`, `lea 0x6c`, `lea 0x78`, three adds, `lea 0x50`) that 1.26 inlined.

**LevelChunk.** Endstone `level_chunk.h` (0.11.7 and HEAD, identical members) declares
`block_entity_access_lock_, level_, dimension_, min_, max_, position_`. `level_` is +0x50 on both builds:
`getLevel@LevelChunk` ships (40 `0x741e40`, 51 `0x7d9700`) and is `movq 0x50(%rcx),%rax`. That puts `min_` at +0x60,
`max_` at +0x6c and `position_` at +0x78, 2024's offsets. 1.26 still has inlined copies of 2024's `toWorldPos`
(`0x218cb50`), found by a scan for three `add disp8` loads of +0x60/+0x64/+0x68 on one base register. There are six on
40 and seven on 51 (e.g. 40 `0xba1532` in `0xba1510`, 51 `0x9f3d82`). Each adds the ChunkBlockPos bytes to `min_`.

Those copies also show that **bdsx's `ChunkBlockPos` was laid out wrong**. It declared x, y, z, which puts z at +4. The
engine's struct is `{ uint8 x +0, uint8 z +1, int16 y +2 }`, 4 bytes, and 2024 was the same. It is now declared with
explicit offsets.

**BlockActor.** Endstone `block_actor.h` puts `type_` at +20 in both releases, right after `position_` (+8, a BlockPos
the `getPosition` accessor already reads on both builds). No static reader was found: a scan for `movl $imm, 0x14(reg)`
gives a spread no different from any other small offset. The field is counted from the confirmed neighbour, and
execution settled its width. **The field is one byte.** The first run read four bytes and got 0xffffff01 for a furnace
and 0x656f6426 for a blast furnace. Their low bytes are 1 and 0x26, the right types, and the three bytes above them are
other data. The chest happened to have zeros there.

They ship as `layouts.LevelChunk.min/max/position` (96/108/120) and `layouts.BlockActor.type` (20), read by
`engine/chunk.ts` and `engine/blocktype.ts`, with `derived()` in `implements.ts`.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/bfield40.ps1 tools/host/drivers/bfield51.ps1`,
`itemprobe blockfields`, **11 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/bfield40-20260929-143514.txt`, `bfield51-...`). The chunk holding (30,68,16) comes from
`BlockSource::getChunkAt`. On it, `getPosition` gave (1,1), `getMin` (16,-64,16) and `getMax` (31,319,31). `toWorldPos`
of ChunkBlockPos (14, 132, 0) gave (30,68,16). `BlockSource::getBlockEntity` found the placed chest, furnace and
blast furnace, and `getType()` returned 2, 1 and 0x26 for them.

## Dimension::isDay (2026-09-29)

2024's `isDay@Dimension` (`0x1f4bd30`) is `cmpb $0x4, 0x170(%rcx); setb %al`: the sky darkness is under 4.
`Dimension.isDay()` threw on 1.26 because bdsx reached it through the `OverworldDimension` vftable by the 2024 name.
Endstone `dimension.h` places `sky_darken_` after `ultra_warm_` (+422), `has_ceiling_` and `has_skylight_`, which puts
it at +0x1a9, just before `dispatcher_` (+432). 1.26 inlines the same compare at that offset on both builds (40
`0x215163`, `0x2186ee`; 51 `0x2a2963`, `0x2a5fee`: `cmpb $0x4, 0x1a9(reg)`). It ships as
`layouts.Dimension.skyDarken` (425) with a `derived()` in `engine/dimension.ts`.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/day40.ps1 tools/host/drivers/day51.ps1`, run-full,
`gamerules-probe.ts` `dayprobe`, **4 PASS / 0 FAIL on each build**; `work/host-runs/day40-20260929-151153.txt`,
`day51-...`). The overworld read `sky_darken_` 2 on 40 and 3 on 51, with `isDay` true, after `time set noon` and
`time set 1000`. It read 11, with `isDay` false, after `time set midnight` and `time set 20000`.

**`getTimeOfDay` and `getSunAngle` (the same day).** 2024's `getTimeOfDay(float alpha)` (`0x1f4b1e0`) sets alpha to 0
when DoDaylightCycle is off, then calls the dimension's own virtual `getTimeOfDay(int time, float alpha)` (vft +0xe8)
with the level's time. `getSunAngle` (`0x1f4af80`) multiplies the result by 2π. 1.26 inlines both. The virtual is slot
30 on both builds (`layouts.Dimension.getTimeOfDaySlot`). OverworldDimension's slot 30 (40 `0x178f880`, 51 `0x1886900`,
the same code) takes `time % 24000` (`imul $0x5dc0`), adds alpha, folds the result into [0, 1) and applies the cosine
easing. Its slot 32 (40 `0x178bd60`) shows the slot number: it checks the rule, reads the level's time and calls
+0xf0. bdsx's declarations had no alpha, so the old binding passed whatever was in xmm1; they now take `alpha = 0`.
With DoDaylightCycle off (`day40/51` again, 8 PASS / 0 FAIL each; `work/host-runs/day40-20260929-152127.txt`), the
overworld gave 0 at 6000, 0.5 at 18000, 0.8267 at 1000 and 0.5987 at 20000, the same on both builds. 0.8267 is
Minecraft's formula: 1000/24000 − 0.25 folded to 0.7917, then a third of the way to the cosine value.

**`getMoonPhase` and `getMoonBrightness`.** 2024 forwarded to `LevelUtils::getMoonPhase` (`0x1abf870`). It divides the
time by 24000, takes the absolute value, bit-inverts it for a negative time and keeps the low three bits.
`getMoonBrightness` then indexes `MOON_BRIGHTNESS_PER_PHASE` (1, 0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75). 1.26 has no copy
of either. The same 32 table bytes occur exactly once in each image (40 `0xa638530`, 51 `0xa75b000`). Seven functions on
40 reference the table, and the smallest (`0x23197a0`, the actor filter for moon brightness) runs the same arithmetic
inline before indexing it. bdsx computes both itself (`engine/dimension.ts`). `day40/51` now also run `moonprobe` and
got phases 0, 1, 4, 7, 0 and brightness 1, 0.75, 0, 0.75, 1 at times 18000, 42000, 114000, 186000 and 210000 (13
PASS / 0 FAIL on each build; `work/host-runs/day40-20260929-152440.txt`). That check compares bdsx's arithmetic with
the day number of the same time. It confirms `Level.getTime` and the formula, but not a second engine read.

**`getMinHeight` and `getHeight` on 1.26.51.** They were accessors on 40 only. Endstone HEAD, the release for 51, counts
`height_range_` at +200 as well (`actor_chunk_transfer_queue_` +104, the unordered_map, `level_` +192). The 51
accessors ship with the same +0xc8/+0xca, and `dayprobe` now also reads the overworld's range: -64 / 320 on both builds
(`day40/51-20260929-160355`, 18 PASS / 0 FAIL each). One run in between had 40's world raining, so at noon
`sky_darken_` was 4 and `isDay` false. That is the engine's own compare, so the driver now clears the weather first.

**`getChunkEntities` (the same day).** 2024's `lea 0x1028` gives a `std::vector<WeakEntityRef>` of the chunk's actors,
0x18 bytes each. Endstone stops declaring LevelChunk members before it. A live scan of the chunk holding a summoned pig
finds it at +0x1360 on both builds: the only vector whose element names that pig by EntityRegistry and entity id,
where the scan compares memory and dereferences nothing unbounded. The same 471-byte function walks +0x1360 by 0x18
on both (40 `0xba5840`, 51 `0x9f7d50`), and it is the only loop of that shape at that offset in each image. It ships
as `layouts.LevelChunk.entities`.

Unwrapping the references needed a second fix. `WeakEntityRef.tryUnwrap` built a `StackResultStorageEntity`, whose
constructor neither 1.26 table has. On 1.26 it now resolves the reference through ActorOwnerComponent
(`engine/entt.ts` `enttActorFromWeakRef`, as `HitResult.getEntity` does), and an expired reference gives null. That
repairs every bdsx API that unwraps a WeakEntityRef. `chent40/51` (`itemprobe chunkents`, 1 PASS / 0 FAIL each) got
[item ×4, pig, pig] on 40 and [pig, ocelot] on 51, with the probed pig among them.
`LevelChunk::getEntity(ActorUniqueID)` is 2024's walk over that vector as a `derived()`. In `chent40/51-20260929-170425`
(2 PASS / 0 FAIL each) the pig's own id gave that pig and a made-up id gave null. The probe's scan now reads only
+0x1360, because an earlier pass that read up to +0x3000 hit an unmapped page past the chunk on 40.

## isFullyLoaded (2026-09-29)

Queue item 1(a). 2024's `?isFullyLoaded@LevelChunk@@QEBA_NXZ` (`0x2180b80`) is a leaf with no `.pdata` entry:
`movzbl 0xd8` (load_state_, what getState's `lea 0xd8` returns), `movzbl 0x11ba`, `cmpb $9; jb` → true, flag set →
true, else the byte at +0xde4. That byte has two writers in 2024, the move-assign and the store of 1 at the end of
`setupRedstoneCircuit`. So the function says true for a chunk still below Loaded, and for a Loaded chunk it says
whether its redstone circuit has been set up. No direct writer of +0x11ba was found in any of the three images.

1.26 inlined it. Two scans over each `.text` located the copies:
- **The inlined copies.** Every `movzbl 0xf0(reg)` with a second `movzbl disp32` of 0x800-0x2000 within 24 bytes
  gives ten sites per build. All ten have 2024's body instruction for instruction: `movzbl 0x1526` (40) /
  `0x152e` (51), `movzbl 0xf0`, `cmpb $0xd` (40) / `$0xb` (51), `jb` → true, the flag → true, then +0x10d1.
  The sites are in `candidates-instances-<v>.json` `offsets.LevelChunk.note`.
- **The redstone byte.** +0x10d1 has exactly two writers on each build, a register store and a store of 1, as
  in 2024.

**The Loaded constant differs between the builds**, and three routes agree on it:
- Endstone's `chunk_state.h` has `Loaded = 13` in 0.11.7 (it still has the two `NeighborAwareUpgrade` states) and
  `Loaded = 11` at HEAD.
- The ticking-area view (`findings-blocks.md`) returns a chunk only when +0xf0 is at least 0xd on 40 and 0xb on 51.
- A live chunk reads 13 on 40 and 11 on 51 (below).

The four facts ship as `layouts.LevelChunk.loadState/stateLoaded/fullyLoadedFlag/redstoneSetUp`, read by
`engine/chunk.ts` `levelChunkIsFullyLoaded`, the `derived()`.

**The engine as oracle.** One of the ten copies (40 `0x14f60a5`, 51 `0x15f6425`) is in BlockSource's non-virtual
`areChunksFullyLoaded(BlockPos const&, BlockPos const&)` (40 `0x14f5f70`, 51 `0x15f62f0`). Its only vftable
caller is slot 55 (40 `0x14f5ef0`, 51 `0x15f6270`, 121 bytes each), the `(BlockPos const&, int)` virtual that
builds pos ± r and calls it. With r = 0 it answers for exactly the chunk that holds the position.

**Executed, both builds** (`chload40/51-20260929-182436`, `verify-pair.mjs`, `itemprobe chunkloaded` twice, 4 PASS /
0 FAIL each, tsc 0, exit 0 + `Quit correctly`):
- **Live chunks.** 413 chunks around the player read state 13 (40) / 11 (51), flag 0, redstone 1. bdsx and slot 55
  both said true for every one.
- **Trials on the player's chunk.** Each byte was set for the trial alone and put back, and the probe checked
  afterwards that all three bytes were restored.
  - Redstone byte 0: false from both.
  - State Loaded−1 with the redstone byte 0: true from both.
  - Flag 1 with the redstone byte 0: true from both.

  A wrong offset or a wrong Loaded value would split bdsx's answer from the engine's in one of these trials.

The first run had a tsc error (TS2345 on the `this` cast). Its PASS lines were not counted, and the rerun above
compiled clean.

## BlockActor::setChanged (2026-09-30)

2024's `setChanged@BlockActor` (`0x20f9660`) is `movb $1, 0xc0(%rcx)`, a bool on BlockActor itself, with 81 callers.
1.26 has no such member on the base. Endstone's `vanilla_block_actor.h` (both releases) moves the flag into
`VanillaBlockActor::properties_`, an `EnumSet<BlockActor::Property>` whose `Changed` is bit 0, and implements
`setChanged` inline as `properties_.insert(Changed)`. The offset differs per build, because the base grew by a
`unique_ptr` between the releases. 0.11.7 (1.26.40) has a 40-byte BlockActor, three interface vptrs and `tick_count_`,
which puts `properties_` at +68. HEAD (1.26.51) has a 48-byte BlockActor and puts it at +76.

**Static.** A byte search for the out-of-line virtual, `orb $1, 0x1c(%rcx); ret`, finds exactly one function per build
(40 `0x4614200`, 51 `0x486c4a0`). It sits at slot 22 of 31 vftables on each build, all 27 slots long, and slot 23 of
the same tables is `movzbl 0x1c(%rcx),%eax; and $1; ret` (40 `0x461c0b0`, 51 `0x4885e10`). That is Endstone's
`IVanillaMainBlockActorComponent` slot for slot: 25 public virtuals plus two protected, with `setChanged` 22nd and
`isChanged` 23rd. The interface sub-object sits at +40 / +48, so +0x1c on it is +68 / +76 on the BlockActor. The engine
also inlines the write about 120 times per build as `orb $1` at +0x44 (40) and +0x4c (51), e.g. the four-float colour
setter at 40 `0x290aaac` / `0x290ab39`, which stores a packed ARGB at +0x28c and then marks the actor changed. No
`and $0xfe` clear at either offset was found. The engine's clear is not located, but execution shows one exists: a
chest untouched since `setblock` reads the bit clear.

It ships as `layouts.BlockActor.properties` (68 / 76, fallback 0xc0 for a 2024-shaped table). `blockActorSetChanged`
in `engine/blocktype.ts` ORs bit 0 into that byte, and `implements.ts` has the `derived()`.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/changed40.ps1 tools/host/drivers/changed51.ps1`,
`itemprobe changed`, **3 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/changed40-20260930-095851.txt`, `changed51-...`). The driver placed three chests three blocks apart
(so they do not pair), plus a furnace, barrel, hopper, jukebox, standing sign and beacon.
- All nine block actors carry the same function at slot 22 of the interface table at +40 / +48: 40 `0x4614200` and
  51 `0x486c4a0`, the static addresses. Each is a VanillaBlockActor, and the interface offset is right.
- A fresh chest reads `properties_` 0xa (Movable and SaveCustomName) with the engine's `isChanged`, called through slot
  23, returning false. After bdsx's `setChanged` it reads 0xb and `isChanged` returns true.
- A second chest runs `replaceitem block ... slot.container 0 diamond 3` through `bedrockServer.executeCommand`, and the
  engine's own write takes it from 0xa/false to 0xb/true. That is the same byte bdsx wrote.
- The third chest, untouched, stays 0xa/false.
