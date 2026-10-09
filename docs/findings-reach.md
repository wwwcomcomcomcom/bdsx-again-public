# Reaching vftables from live objects

Done 2026-09-17 (evening), on 1.26.40.8; carried to 1.26.51.1. Step 1 of
`next-steps.md`: the vftables that were one member away from an object
already in hand, read rather than inferred, then filled with Endstone's
header order (route 8 of `findings-slots.md`).

## The tool

`tools/reach-probe-launcher.js` captures `this` at exact hooks (twelve
bytes of native code storing `rcx`, as `instance-probe-launcher.js` does)
and keeps every distinct object a hook hands over, told apart by vptr: one
pig, one arrow, one player. Each is scanned for what it holds:

| line | what it is |
|---|---|
| `INLINE +off` | a table start stored inside the object past its own bases: an embedded polymorphic member |
| `MEM +off` | a pointer to an object whose first qword is a table start: a `unique_ptr` or raw member |
| `MEM2 +off blk+off` | a pointer to a block whose first qwords point at such an object: a `weak_ptr`'s counter, an owner pointer's control block |
| `STR +off "minecraft:..."` | a game-prefixed string inline (SSO) or one pointer away |
| `CALL label` | a getter called at every sweep: by address, or by **index into the object's own vftable**, with an optional `BlockPos` in `rdx` |

Everything reached is scanned in turn (depth 2), names are decided offline
(`tools/reach-name.mjs` annotates each table with its slot count, what the
walk already calls it, and every path that reached it), and a member that
changes under a console command shows up as a `NEW` line at the next
rescan (`RP_RESCAN_EVERY`).

Five runs with the bot client (`tools/run-client-probe.ps1`, drivers
`rp1.ps1`..`rp5.ps1` in the session scratch). Two were lost to the tool
itself and are worth recording: walking a `std::vector` member of the
block palette recursed without a depth bound (stack overflow, run 2), and
with a bound it still walked the whole world through the palette, 19,000
objects, which held the game thread for 75 s and let no console command
land until the run was over (run 4). Vector walking is now confined to the
named object and its elements are scanned at the maximum depth.

## What was read

Exact by reach, on 1.26.40.8, now in `data/candidates-instances-1.26.40.8.json`
(`reach` block):

| table | rva | slots | reach |
|---|---|---|---|
| `OverworldDimension` (IDimension) | 0xa7ebd50 | 43 | pig and player `+0x1c8`: the `WeakRef<Dimension>` Endstone declares just before `Level*`, which is at `+0x1d8`; the control block beside it has the 4-slot `_Ref_count_base` table |
| `NetherDimension` (IDimension) | 0xa7ebad0 | 43 | the player's `+0x1c8` changed to this when teleported to the nether |
| `TheEndDimension` (IDimension) | 0xa7ebeb0 | 43 | and to this in the end, 24 s later, in that order in the output |
| `BlockSource` | 0xa62e960 | 66 | IDimension slot 12 (`getBlockSourceFromMainChunkSource` in Endstone's order) called on the live Dimension; **66 slots is exactly what Endstone's headers lay out**; holds Level `+0x20`, ChunkSource `+0x28`, Dimension `+0x30` |
| `GameMode` | 0xa666fe0 | 20 | player `+0xaa0` after `gamemode creative` |
| `SurvivalMode` | 0xa667080 | 20 | player `+0xaa0` before it; the two tables are adjacent, differ at 14 slots including `destroyBlock`, and Endstone lays out 20 |
| `Inventory` | 0xa5371e0 | 55 | player `+0x5b8` (`unique_ptr<PlayerInventory>`) `+0xb8`; 55 = Endstone's Container + FillingContainer + Inventory; the walk agrees |
| `ItemStack` | 0xa530730 | 7 | first element of the Inventory's item vector; 1,310 constructor references |
| `Block` | 0xa6502e0 | 1 | IConstBlockSource slot 2 (`getBlock(BlockPos const&)`) on placed blocks |
| `ChestBlock`, `StoneBlock`, `ButtonBlock` (= `StoneButtonBlock` = `WoodButtonBlock`, folded), `FarmBlock`, `CampfireBlock`, `SculkSensorBlock`, `PistonBlock` | 0xa78cc50, 0xa797da0, 0xa65f600, 0xa806750, 0xa660ee0, 0xa7c0580, 0xa792290 | 132 | `Block +0x68` is the `BlockLegacy`, and **every legacy block carries its own name at `+0xe8`** (a `HashedString`): `minecraft:chest`, `stone`, `stone_button`, `farmland`, `campfire`, `sculk_sensor`, `piston` |
| `ChestBlockActor` (primary), `CampfireBlockActor`, `SculkSensorBlockActor` | 0xa6a06d0, 0xa69fbd0, 0xa69fac0 | 35, 27, 27 | IConstBlockSource slot 3 (`getBlockEntity`) at the placed block; 35 = 27 + 8 as the baseline's 51 = 43 + 8 |
| `Pig`, `ItemActor`, `Arrow`, `EnderCrystal` | 0xa772d50, 0xa6bd000, 0xa61feb0, 0xa6c0ac0 | 175, 137, 140, 137 | `rcx` of `Mob::_hurt` under console damage and of `Actor::teleportTo` under console `tp` of summoned entities |

Structural, two or more independent routes agreeing, no live vptr:

| table | rva | evidence |
|---|---|---|
| `Actor` | 0xa60d150 | the slot-wise consensus of the 17 plain-actor tables (135 of 137); the walk's `ItemActor` constructor calls the constructor that stores it (0xdd66c0, 47 callers; the destructor storing it has 71); the resolved `teleportTo` sits at its slot 21; and **a pig destroyed after `_hurt` was read one tick later with this table as its vptr**, which is what the last base destructor writes. Endstone's Actor names read from it agree with the walk 18 of 18 |
| `BlockLegacy` | 0xa65d460 | equals the slot-wise consensus of all 268 block tables at 132 of 132, and has 9 constructor/destructor references, the most of any block table |
| `ItemStackBase` | 0xa651840 | purecall stubs at slots 1-3, shares slots 0 and 4-6 with the next |
| `ItemInstance` | 0xa6515b0 | the third 7-slot table of the family, 395 references, pointed to from GameMode `+0x2a8` |

Refuted by the same runs: the propagation candidate for
`BlockSource::getBlockEntity` (0xba6b00) returned null where slot 3 returned
the chest's block actor; the 53-slot object at player `+0x810` is not the
BlockSource. The walk, checked against the live tables where it had a name,
was right on 10 of 11 (`Arrow`, `ItemActor`, `EnderCrystal`, `Pig`,
`ButtonBlock`, `FarmBlock`, `CampfireBlock`, `SculkSensorBlock`,
`PistonBlock`, `Inventory`; the table it called `ClayBlock` carries
`minecraft:dirt`), consistent with its 90-95%.

## What the tables gave

`tools/endstone-slots.mjs` grew families for the new tables (dimension,
blocksource, gamemode, itemstack, container, blockactor, tag) and the
`Actor` table joined the actor family. Container names are no longer read
from `Inventory`'s table: `FillingContainer` and `Inventory` override them
and 3 of 9 disagreed with the walk that way.

| build | families | agree / disagree with the table | new | required coverage |
|---|---|---|---|---|
| 1.26.40.8 | all | 59 / 0 (actor alone 53 / 0) | 41 | 225 -> **254** |
| 1.26.51.1 | all, tables carried by `carry-pipeline.mjs` (3,474 / 34) | 87 / 0 | 10 | 221 -> **245** |

Endstone's `block_actor.h` declares one virtual and `tag.h` has no live
table yet, so those two families give nothing so far. The full lifecycle
ran clean on both builds with the new tables (`Server started.`, 15 of 16
fields, `Quit correctly`, exit 0; 1.26.51.1 under `tools/setup-bds-51.ps1`
with a regenerated stub, then restored).

## What did not settle

- **Block virtuals as hooks** (`ChestBlock::use`, `ButtonBlock::use`,
  `FarmBlock::transformOnFall`). The class tables are exact now, but the
  slot is not: Endstone has no `BlockLegacy` header, and aligning each
  class's override set against the baseline's is underdetermined. The one
  slot all six live block classes override on the target (74) is
  `neighborChanged`, which all six override in the baseline too; but
  `use`, which `ChestBlock`, `ButtonBlock` and `CampfireBlock` all override
  in the baseline (slot 151), has **no slot common to the three on the
  target**. Either the vtable was reordered past what set intersection can
  see, or `use` left one of them. A real client opening the chest under
  probes on the candidate slots would settle it; the bot cannot.

  **Settled 2026-09-18 (night), the other way.** Endstone does have the
  header: `BlockLegacy` is `BlockType` in 1.26 and `block_type.h` declares
  its virtuals in vtable order, with `tick`, `randomTick` and both `use`
  overloads **commented out** -- gone from the table. Run as a family in
  `tools/endstone-slots.mjs` (`--families=block`) it passes the 132-slot gate
  on 1.26.40.8 and agrees with the walk on `getRenderBlock`, but the slot it
  gives `transformOnFall` holds the empty stub 0x76150 in `FarmBlock`'s table:
  that override is gone too. So `ChestBlock::use`, `ButtonBlock::use` and
  `FarmBlock::transformOnFall` are not missing addresses but missing
  functions; the block-use events need a different seam in 1.26 (the block
  components, or `GameMode::useItemOn`, which is named). The family stays out
  of the default list: one required non-hook (`asItemInstance@BlockLegacy`,
  prototype changed) is not worth a disagreement.
- **`BlockActor`'s own table**: the block actors read are subclasses
  (27 and 35 slots); the 27-slot consensus has five equal candidates.
- **`CompoundTag`**: nothing reached a live tag.
- **`ItemStackBase` / `ItemInstance` / `BlockLegacy` / `Block`** did not
  carry to 1.26.51.1 (the carry drops tables it cannot align).
- On the way: `Mob::_hurt` (0x23faee0) is in the walk's `Mob` table at slot
  134 and in no other actor table, so the pig captured through it was a
  Mob; the plain-`Actor` vptr seen there belonged to the same object after
  its destructors ran.

## Rules this added

- **A member is exact where a header names it.** Endstone's field order
  (`WeakRef<Dimension>` then `Level*`) turned a pointer at `+0x1c8` into a
  named table without a slot count; the control block beside it is the
  check.
- **A getter called by header slot is a read, not an inference**, and a
  table whose length equals the header's layout confirms both at once
  (BlockSource: 66 and 66).
- **A swapped member names two tables**: `gamemode creative` replaced one
  object with another of a sibling class.
- **Legacy blocks name themselves** at `+0xe8`; read that field, not
  strings found anywhere in the object (the first attempt attributed
  neighbours' names to the wrong tables).
- **Never walk a world-sized container on the game thread.** Bound the
  depth, confine the walk to the named object, and expect console commands
  to stall while a scan runs.
- **A destroyed object's vptr is its root class's table.**

## The same run on 1.26.51.1 (2026-09-18, rp51)

Once the bedrock-protocol PR-804 bot survived on this build and the full
launcher stopped dying at join (`findings-instances.md`), the rp5/rp7
recipe ran here unchanged: the four raw captures translated by name
(`teleportTo`, `_hurt`, `respawn`, `die`), `RP_CALL` by the same Endstone
slots, the LevelData getter by its 1.26.51.1 address, and `RP_WATCH` on the
LevelData, the hurt mob and the player, under 23 console commands. 1,950
objects, 1,546 distinct tables.

Every table the carry had already named agreed with what was read live:
`GameMode`/`SurvivalMode` (the object at Player+0xaa0 swapped under
`gamemode creative`, 0xa7a0c70 -> 0xa7f1350), `OverworldDimension` at
Player+0x1c8, `BlockSource` from IDimension slot 12, `Inventory` (54 slots)
at PlayerInventory+0xb8, the chest, piston, sculk-sensor and stone-button
legacies at Block+0x68, `SculkSensorBlockActor`. New from the run:

| table | 1.26.51.1 | how |
|---|---|---|
| `Block` | 0xa7d6ce0 (1 slot) | IConstBlockSource slot 2 on the seven placed blocks, one table |
| `ChestBlockActor`, `CampfireBlockActor` | 0xa7863d0 (35), 0xa7858e0 (27) | IConstBlockSource slot 3 at the placed block |
| `ItemStack` | 0xa64feb0 | first element of the Inventory item vector at +0x198 |
| `ItemInstance` | 0xa770780 | GameMode +0x2a8, the path that named it on 1.26.40.8; inline in block actors and at Player+0x830 |
| `ItemStackBase` | 0xa7690e0 | structural: purecall stubs at slots 1-3, slots 0 and 4-6 shared with ItemInstance, the 1.26.40.8 shape |
| `CompoundTag` | 0xa7b0e30 | inline 11-slot object at Block+0xf0: a live route for the table the constructor's cross-build pair had placed |

Endstone's item family then named `ItemStackBase` and `ItemStack`'s virtuals
(+2 required). One trap: `setblock ... farmland` read back as
`minecraft:dirt` at BlockLegacy+0xe8 (the block reverted before the sweep),
so the carry's `FarmBlock` was not checked and the live table there is
`DirtBlock`, not merged. Still missing on this build: `BlockLegacy`'s own
table (the 1.26.40.8 consensus route was not rerun) and
`ServerNetworkHandler`'s LevelListener / `ServerLevel`'s BlockSourceListener
bases.

## PistonBlockActor, and a chest label fixed (2026-09-23, agent-z)

`docs/findings-blocks.md` section 15 is the extension of this section. The method is unchanged:
`Actor::teleportTo` (rcx, the `tp @a` command) +0x1c8 (`WeakRef<Dimension>`) -> IDimension slot 12
-> BlockSource -> IConstBlockSource slot 3 (`getBlockEntity`) -> the BlockActor at the target
position. Newly captured: 1.26.40.8's `??_7PistonBlockActor@@6B@`
(`0xa764eb0`, 27 slots, refs 2) -- exactly BlockActor's slot count (27) (single inheritance, no
virtuals of its own). The same run re-confirmed the chest (`0xa6a06d0`, 35 slots), which is the
basis for correcting `??_7ChestBlockActor@@6B@` (the suffix-less name, which does not exist in the
baseline) -- wrongly attached to 1.26.51.1 by the 09-17/18 session -- to
`??_7ChestBlockActor@@6BRandomizableBlockActorContainerBase@@@`.

1.26.51.1's PistonBlockActor was not captured this session -- the first attempt used
`Player::respawn`+0x1c8 as the source, which consistently gave an Access Violation (either that
field is not yet populated at this timing, or the respawn hook is catching the object before it's
initialized); the retry (via `Actor::teleportTo`, the verified method above) had the bot disconnect
5 seconds after joining, so the console command itself never fired. **One lesson**: `Player::respawn`
is a less reliable capture source than `Actor::teleportTo` -- a hook whose firing can be forced by
an explicit console command (`tp`) is better.

**Tripped twice on peek.ps1's `-First 120` default.** Grepping the entire `[rp]` tag lets the
0x1800-byte member scan that appears every time a `BlockSource` is captured (100+ lines) eat the
whole budget, so the CALL/OBJ result lines got truncated (even though `Quit correctly` itself was
cut off, the session was judged "successful" because exit code was 0 -- `session.mjs`'s failure
detection only checks for the absence of `Quit correctly` when the exit code is != 0). Next time
a reach session needs grepping, use a pattern like `\[rp\] (CALL|OBJ|hooked|SWEEP|DONE)` that
excludes the MEM/INLINE/STR dump lines, so the result lines fit within the 120-line window.
