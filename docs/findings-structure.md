# Findings: StructureSettings and StructureTemplate on 1.26 (2026-09-30, agent-d)

`StructureSettings` has no out-of-line constructor, destructor or accessor on either build, and its fields were
reordered against 2024. bdsx now writes the object itself (`bdsx/bds/engine/structuresettings.ts`, `derived()` in
`implements.ts`). Probe `tools/structure-probe.ts` `stsetprobe`, drivers `stset40/51.ps1` (`STSET_PROBE=1`).

## Layout (identical on both builds; 2024 in brackets)

| field | offset | read from |
|---|---|---|
| paletteName (std::string, "default") | 0 (0) | placeInWorld passes the settings as the palette-name argument; the inline construction in the `/structure save` command (40 `0x3c762f0`, object at rbp+0x350) loads "default" from rdata |
| ignoreEntities / reloadActorEquipment / ignoreBlocks | 0x20 / 0x21 / 0x22 (same) | fillFromWorld skips `_fillEntityList`/`_fillBlockInfo`; placeInWorld skips the entity and block steps |
| ignoreJigsawBlocks | 0x24 (0x24) | placeInWorld's byte for `_placeNextBlockSegmentInWorld` |
| lastTouchedByPlayerId (int64, -1) | 0x28 (0x50) | the load helper |
| structureSize / structureOffset / pivot | 0x30 / 0x3c / 0x48 (0x28 / 0x34 / 0x40) | fillFromWorld (region = pos + offset, size), placeInWorld |
| mirror / rotation / animationMode | 0x54 / 0x55 / 0x56 (0x59 / 0x58 / 0x5a) | engine-built settings for `90_degrees z block_by_block 2` hold 2 at 0x54, 1 at 0x55, mode 2 at 0x56 |
| animationSeconds / integrityValue (100.0) / integritySeed | 0x58 / 0x5c / 0x60 (0x5c / 0x60 / 0x64) | tryPlaceStructureInWorld: `floor(seconds * 20) != 0 && mode != 0` |
| sizeof | 0x68 (0x68; bdsx had declared 0x60) | |

Addresses (resolved, both executed): `StructureTemplate::fillFromWorld` 40 `0x3bc5700` / 51 `0x1f62330`, `placeInWorld` 40
`0x3bc8290` / 51 `0x1f52300`, `bdsx:StructureTemplateData::tryGetBlockAtPos` 40 `0x3bcb4f0` / 51 `0x1f671d0`,
`bdsx:StructureManager::tryPlaceStructureInWorld` (probe hook) 40 `0x36deca0` / 51 `0x1f51a60`.

## Other findings

- **`StructureTemplate::tryGetBlockAtPos` is inlined** at its callers around one helper (pos, `StructureTemplateData`, a 24-byte
  `NonOwnerPointer<IUnknownBlockTypeRegistry>` by value that the callee releases). The template's registry is at +0xe0 on 40
  and +0xe8 on 51. The engine bounds-checks only the flat index `(sizeY*x+y)*sizeZ+z`, as 2024 did.
- **`placeInWorld` takes seven arguments** (telemetry pointer and a bool after the settings); bdsx bound four. Now bound in
  full with null/false, what `WorldBlockTarget::placeStructure` passes.
- `setIntegritySeed` is a uint32 (bdsx bound a float32).
- Table entries `getStructureSize`/`getIgnoreEntities`/`getRotation@StructureSettings` were folds at 2024 offsets: retracted.

## Execution (2026-09-30, `stset40`/`stset51`, 23/23 each; `nbts40/51` 8/8 after)

The engine reading bdsx's object: `fillFromWorld` stores the size and world origin bdsx set (offset applied), saves 1 entity or 0
under `ignoreEntities`, no blocks under `ignoreBlocks`; `placeInWorld` matches `/structure load` block for block in eight
rotation/mirror cases; integrity 50 with seed 1 twice gives one pattern, seed 2 another. bdsx reading the engine's object (hook):
rotation, mirror, size, pivot 1.5,0,1, integrity 100, and `getAnimationTicks` 40 / `isAnimated` true for `block_by_block 2`.
Regression: an out-of-range check I first wrote per axis was wrong (the engine checks the flat index only): probe fixed.

## The two flags, seen in the engine (2026-09-30, agent-f, `stset40/51`, stsetprobe 25 PASS each)

- **`setReloadActorEquipment` (0x21)**: placeInWorld's entity step (40 `0x3bc9ed0`, 51 `0x1f663e0`, r9 = the byte) keeps it in a local and,
  after each entity it loads, calls a function with the new Actor in rcx (40 `0xde3280`, 51 `0xd23480`; key
  `bdsx:Actor::_reloadEquipmentAfterStructureLoad`, `void(Actor*)`): an EnTT component lookup on the actor, then a tail call that fills
  `SlotDropChancesComponent`. A hook counts it: a saved armor stand placed with the flag false 0 calls, true 1 call (the armor stand),
  false again 0, on both builds. `/structure load` sets it false (0 calls). What the reload changes downstream (drop chances) is not read.
- **`setIgnoreJigsawBlocks` (0x24)**: a structure filled around a `jigsaw` block: placed with the flag false the jigsaw block is placed
  (`stone,jigsaw,gold_block`), true it is skipped (`stone,air,gold_block`), both builds. Same engine, our byte, opposite results.
- Unexplained: `/structure load` of that jigsaw structure placed nothing (`air,air,air`, all three cells, both builds), so the command's own
  jigsaw flag is not known. Placements must stay near the bot (x 2010..2040, z <= 66): at x 2100+ the first try placed nothing on 40.
