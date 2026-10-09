# Findings: bdsx's NBT layer on 1.26

Queue item "bdsx's NBT layer on 1.26" (2026-09-24). Before: `NBT.allocate` crashed on 40 and threw on 51, so
nothing in bdsx could hand the engine a tag, and `getBlockTarget` could only be checked weakly. After: every NBT
operation bdsx exposes runs on both builds, checked against the engine's own code (`nbtprobe`), and the engine
reads a tag bdsx built (`btprobe`: `getBlockTarget` strongly confirmed).

**The rule this earned: an address that returns a pointer can hide under a `bool` name.** `?contains@CompoundTag`
shipped on 51 (propagation), was added for 40 by position, and bdsx's `has()` looked right on both, because
`bool_t` reads `al`, the low byte of the `Tag*` that the function really returns. It is `CompoundTag::get`. It
surfaced only when a caller's body was read (EnderCrystal null-checks the result and calls `getId` on it). Before
promoting a `bool` function, read one caller and check what it does with `rax`. (The second time: `hasEffect` was
the first, `candidates-instances` `retracted`. `setCustomName`, section 8, was the same family of mistake: a
propagation address whose body belongs to another class.)

## 1. The layout is unchanged

Endstone (both releases, identical here) asserts the sizes and 1.21.3.01 agrees: `ListTag` = vftable, a
`std::vector<std::unique_ptr<Tag>>` at +8, the element type at +0x20 (40 bytes); `CompoundTag` = vftable and a
`std::map<std::string, CompoundTagVariant, std::less<>>` at +8; `CompoundTagVariant` = the `std::variant` of the
twelve tags, 48 bytes, index byte at +0x28 (-1 = valueless). 1.26's own code reads it the same way: the variant
destructor (40 `0x1beea90`: `cmpb $-1, 0x28(v)`, then slot 0 with edx = 0) and `deepCopy` (40 `0x1bee980`: map
node key at +0x20, variant at +0x40, index at +0x68). So bdsx's `nbt.ts` classes needed no change. What was
missing was addresses, and 1.26 has fewer out-of-line NBT functions than 2024 had.

The CompoundTag function span lines up one-to-one between the builds (40 `0x1bec220..0x1bf0570`, 51
`0x284d030..0x2851140`: same count, the same size at every position, in source order, not alphabetical as in
2024). An identification on one build therefore carries to the other by position, with the body compared.

## 2. The twelve tag vftables (`tools/nbt-vftables.mjs`)

Five of the shipped ones were wrong, all from the vftable walk (the do-not-retry table already says its output
for look-alike tables is unreliable): 40 `ShortTag` `0xa612b60` is IntTag's table (getId 3), 40 `StringTag`
`0xa71a5f0` and `Int64Tag` `0xa665700` are not tag tables at all, 51 `Int64Tag` `0xa7b0f50` is IntArrayTag's
(getId 11), 51 `StringTag` `0xa82bf30` is not a tag table. Eight were missing. Two independent routes now agree
on all 24:

1. **Shape.** In 1.21.3.01 every tag table is 11 slots, slot 8 is the shared `Tag::print(std::string const&,
   PrintStream&)`, and slot 5 is `getId`, whose body is the type constant (`mov al, N; ret`; End is
   `xor eax, eax; ret`). In 1.26, the tables whose slot 8 equals `CompoundTag`'s are exactly twelve, one per
   constant 0..11.
2. **The variant's move visitor** (40 `0x1bff2c0`, 51 `0x285f440`): each case stores a table, moves a payload of
   that type's width (byte, word, dword, qword, `movsd`, the SSO string reset, three pointers, the map), and sets
   the variant index. The index gives type → table directly.

| type | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| End | `0xa654a60` | `0xa7b11a0` |
| Byte | `0xa612aa0` | `0xa731040` |
| Short | `0xa654a00` | `0xa7b1140` |
| Int | `0xa612b60` | `0xa731100` |
| Int64 | `0xa6547b0` | `0xa7b0ef0` |
| Float | `0xa612b00` | `0xa7310a0` |
| Double | `0xa654750` | `0xa7b0e90` |
| ByteArray | `0xa654690` | `0xa7b0dd0` |
| String | `0xa612bc0` | `0xa731160` |
| List | `0xa613c90` | `0xa711630` |
| Compound | `0xa6546f0` | `0xa7b0e30` |
| IntArray | `0xa654810` | `0xa7b0f50` |

This is why 40 crashed: `IntTag`'s table was missing, and the engine's `put` calls `getId` on the tag it receives.

## 3. Functions: which are out of line

| name | 1.26 | how |
|---|---|---|
| `CompoundTag::put(string, unique_ptr<Tag>)` | 40 `0x1bed5f0` (shipped), 51 `0x284e370` | the only CompoundTag call `load(input, depth)` makes after reading a named tag (as in 2024); bodies identical after masking |
| `CompoundTag::get(string_view)` | 40 `0x1beead0`, 51 `0x284f7c0` | once shipped as `contains` (see the rule above). const and non-const fold |
| `Actor::save(CompoundTag&)` | 40 `0xe00c70`, 51 `0xd40ec0` | section 4 |
| `??_7DefaultDataLoadHelper@@6B@` | 40 `0xa5ecda0`, 51 `0xa70da40` | section 5 |
| `ListTag` ctor/dtor/`add`/`size`, `CompoundTag::contains`/`remove`/`clear`, `CompoundTagVariant` dtor/`emplace` | none | inlined everywhere: `derived()` (section 6) |

The unnamed neighbours in the span are the `put<X>` family (pairs of a 34-byte helper and a ~213-byte body), the
`get<X>Tag` family (seven 246-byte bodies from `0x1beebd0`; EnderCrystal calls `0x1beedd0` and reads `+8` as an
int, so that one is `getIntTag`), and `deepCopy` (`0x1bee980`). None were needed here.

## 4. `Actor::save` is no longer virtual, and its keys are immediates

Endstone's `actor.h` goes `consumeTotem` → `load`: `save` left the vftable. 2024's `save` + `saveWithoutId` keys
("LastDimensionId", "IsGlobal", "LinksTag", ...) are referenced as literals only by `Actor::load` in 1.26. The
save path builds them as SSO immediates (`movabs` of the first 8 bytes), so no `lea` points at them.
`tools/string-users.mjs` searches both ways. The one function holding "IsGlobal", "OnGround" and "LinksTag" as
immediates is 40 `0xe00c70` (26,948 bytes) and 51 `0xd40ec0` (26,328 bytes): `saveWithoutId` inlined into
`save`. The prototype is unchanged (`bool(Actor const*, CompoundTag&)`; rcx = this with the EnTT context at
+0x10/+0x18 and the ActorTypeComponent hash `0x4f6ba419` 2024's `save` opens with, rdx = the tag, r8/r9 written
before being read; returns 0 without a type component and 1 at the end). It is shipped under the 2024 decorated
name: a direct call doesn't care about the `U` → `Q` change.

## 5. `DefaultDataLoadHelper`'s vftable

With the tags fixed, `btprobe` faulted inside `EnderCrystal::readAdditionalSaveData` reading `0x10`: bdsx's
`DefaultDataLoaderHelper` had a null vptr (`??_7DefaultDataLoadHelper@@6B@` had no address), and the crystal
calls the helper's slot 2. In 1.21.3.01 the Default table has 18 slots, slots 13 and 14 are the same identity
function, and slot 16 returns 0. `NewUniqueIdsDataLoadHelper` has its own `loadActorUniqueID` in 13 and a non-zero
16. Each 1.26 build has exactly two 18-slot tables holding the shipped `loadMirror`/`loadDirection`/... body in
slots 8, 9, 11, 12, one of each shape. Second route: `CloneCommand::execute` (the only user of
"commands.clone.success") built a `DefaultDataLoadHelper` in 2024, and in 1.26 it calls a function that loads the
Default candidate (40 `0x6c9f20`, 51 `0x160c130`).

## 6. What bdsx carries (`derived()`, `data/derived.json`)

- `ListTag`: ctor = vftable + empty vector + type End (2024 `0x82fa50`); dtor = the engine's own, through vftable
  slot 0 with flag 0; `add` = `type = getId()`, then `push_back` (bdsx's `CxxVector`, grown through `msAlloc`);
  `size` = the vector's size.
- `CompoundTag`: `contains` = `get(key) != null` (Endstone's body); `clear` = the engine's destructor, then its
  constructor; `remove` = find + erase through bdsx's `CxxMap`, a port of MSVC's `_Tree`.
- `CompoundTagVariant`: dtor = what 1.26's own does (above); `emplace` = destroy, copy the tag's bytes in, set
  the index, re-construct the source empty. Moving by bytes is sound for MSVC's `std::string`, `std::vector` and
  `std::map`: none keeps a pointer back into its owner.

**Three upstream bdsx bugs fixed along the way** (all would have corrupted engine memory):
1. `CxxMap._Extract`: with two children, the successor is `_Min(erased._Right)`, but the port lifted the erased
   node itself. That took the one-subtree path and dropped the whole left subtree (seen: after `delete("s")`,
   `"ia"` was unreachable while `size` said 10).
2. `CxxMap._delete` destroyed the pair twice and freed `&node._Myval` (node + 0x20) instead of the node.
3. `ListTag`'s copy constructor did not copy `type`, so a cloned list of strings claimed to hold `End`.

`CxxMap<CxxString>` compares keys with JS `<` (UTF-16 code units), which matches `std::less<>`'s byte order for
every key without characters above U+FFFF.

## 7. Execution (both builds, 2026-09-24, `nbt40`/`nbt51`)

`tools/block-probe.ts` `nbtprobe`, then `btprobe`, drivers `tools/host/drivers/nbt40.ps1` / `nbt51.ps1`. Every
line PASS on both builds, tsc 0, exit 0, Quit correctly:

```
PASS nbtprobe vftables: engine getId through each table: 0,1,2,3,4,5,6,7,8,9,10,11 (want 0..11)
PASS nbtprobe build: size 11; engine toString "11 entries"
PASS nbtprobe get: i 3, str true, list [7,8,9] size 3 type 3, nested.x 10, missing null
PASS nbtprobe has: contains (engine get != null): f true, nested true, zz false, F false
PASS nbtprobe equals: engine equals: clone true, clone+extra false
PASS nbtprobe delete: remove s true, again false, ia true; engine get finds s false, ia false; lost []; size 9
PASS nbtprobe erase: 64 erases, every survivor found by the engine each time; engine destructor ran
PASS nbtprobe variant: i re-emplaced as StringTag 48 chars
PASS nbtprobe list: 40 pushes (true), copy in compound size 40 type 8
PASS nbtprobe clear: after clear empty true; put again -> 5, size 1
PASS nbtprobe dispose: engine CompoundTag destructor over what bdsx built returned
PASS nbtprobe value: {"c":{"y":{"_value":3}},"list":[{"_value":2}],"n":{"_value":1},"s":"x"}
PASS nbtprobe actor save: engine Actor::save: identifier minecraft:player, Pos [29.5,69.62001037597656,14.5], 110 keys
PASS btprobe: crystal minecraft:ender_crystal: before 0,0,0, after readAdditionalSaveData 5,71,-9, engine save 5,71,-9
```

1.26's `CompoundTag::toString` is just `"<n> entries"`, and `IntTag.value()` returns an `NBT.Int` wrapper, not a
number (the first run's FAILs were those two probe mistakes). Regression: `layout40` 23/23; `layout51` 21/23 in
the pair, the two `effprobe speed` checks (Q8, now also seen on 51), and 23/23 solo right after.

## 8. `ItemStackBase`: `save` gained a `SaveContext`, `load` is inlined

- **`save`** is 40 `0x1bc6230`, 51 `0x1a58680`: `unique_ptr<CompoundTag> save(SaveContext const&) const`. The
  merge's shape check had vetoed it under the 2024 name ("reads an argument the 2024 function never read"), which
  was right: the new argument's only use is being passed to one callee. Two routes: the shipped
  `ItemActor::addAdditionalSaveData` allocates a one-byte context, stores 0 (`SaveUseCase::SaveToDisk`) and passes
  it in r8. And the body is 2024's key for key: `Name`, `Count` (+0x22), `Damage` (+0x20), `WasPickedUp`
  (+0x25), `Block`, `tag`, the two block lists. It ships as `bdsx:ItemStackBase::save`, and the 2024 name is a
  `derived()` that calls it with a SaveToDisk context (`engine/itemsave.ts`).
- **`load`** has no body anywhere. `ItemStack::fromTag` (shipped) inlines it: `ItemStackBase::_loadItem` (40
  `0x1bc6730`, 51 `0x1a58b30`, the only "WasPickedUp" literal user, ending in `_setItem`), then
  `Item::fixupCommon(ItemStackBase&)` at item vftable `+0x358` (both builds; 2024's `fixupOnLoad` called `+0x2e8`),
  then 2024 `fixupOnLoad`'s tail: an aux that reads `0x7fff` becomes 0. bdsx does the same (`derived()`),
  with `_loadItem` shipped and the slot in `layouts.Item.fixupCommonSlot`. The `fromTag(tag, Level&)` overload
  calls `+0x350`: `fixupCommon`'s two overloads in MSVC's reverse declaration order.
- **`setCustomName` was wrong on both builds** (40 `0xe07bd0`, 51 `0xd47bb0`, propagation). It is an Actor
  function: it reads `this+0x128` (`Actor::entity_data`), takes synched item 4 (the name tag) if it is a string,
  and writes a string into an rdx return slot; `Actor::save` calls it. Called on an item stack it wrote into the
  argument and the server died without a report. Retracted. bdsx now carries 2024's body (`0x1b6ccf0`) as
  `derived()`: no item or an empty name → nothing; else create `user_data_` (+0x10) if missing, make `display` a
  compound, put `display.Name`. `CommandUtils::createItemStack` has no address either; `ItemStack.constructWith` now runs on bdsx's own
  `createItemStack` over `fromTag` (section 18).

## 9. `MobEffectInstance`: a size that differs between the builds

`save` 40 `0x2c7fbe0` / 51 `0x1c57070` (the "DurationNormal" immediate user, right before `load`), `load` 40
`0x2c80600` / 51 `0x1c57970` (the only "FactorCalculationData" literal user). Same prototypes as 2024, and
`AreaEffectCloud`'s add/read (and on 51 `Mob::readAdditionalSaveData`) call them. **The class is 0x88 bytes
on 40 and 0x90 on 51**: the stride of each build's own `vector<MobEffectInstance>` push in `AreaEffectCloud`
(`addq $0x88` / `addq $0x90` to the end pointer; Endstone HEAD's `unknown_40_`). bdsx hard-coded 0x88, so on 51
the static `load` (which constructs into an instance bdsx allocated) would have written 8 bytes past it.
`effects.ts` now takes the size from `layouts.MobEffectInstance.size`.

The engine loses `FactorCalculationData.factor_target` on its own: `save` writes the `factor_*` values as
`FloatTag`s and `load` reads them with `getIntTag` (then `cvtsi2ss`), so a float tag reads as absent. The probe
compares bdsx's round trip with the engine's own save → load → save (no JS in between), and the two are identical.

## 10. `BlockActor`: its vftable

`??_7BlockActor@@6B@` is 40 `0xa6a1760`, 51 `0xa7879b0`. Of the scanned tables, only two hold the shipped
`BlockActor::load` (slot 1, as in 2024). They are identical but for slot 0; this one has 41 code references (every
subclass destructor resets the vptr to it) against 1, and its own destructor stores it first. Slot 2 is `save`
(40 `0x460ea80`, 51 `0x486bef0`): 2024's prototype, one base writer (`id`, `x/y/z`, `isMovable`) and then
`CustomName` from `+0x90`. bdsx's `BlockActor.save`/`load` go through this table by slot.

## 11. Execution (both builds, 2026-09-24, `nbt40`/`nbt51` pair, 19/19 each)

```
PASS nbtiprobe iron_sword: setCustomName true; engine save {...,"tag":{"Damage":7,"display":{"Name":"probe-sword-name-past-fifteen"}}}; air -> bdsx load: minecraft:iron_sword x1 damage 7, re-save identical; fromTag agrees true
PASS nbtiprobe stone: engine save {"Block":{"name":"minecraft:stone",...},"Count":5,...} -> bdsx load: minecraft:stone x5, re-save identical; fromTag agrees true
PASS nbtiprobe apple: ... minecraft:apple x64, re-save identical; fromTag agrees true
PASS nbteprobe: size 0x88 (51: 0x90); Id 1 Amplifier 2; copy id 1 amplifier 2 showParticles false; bdsx round trip identical to the engine's own
PASS nbtbprobe: engine save id Chest at 33,68,14, 8 keys; after bdsx load + engine re-save: CustomName probe-chest-name-past-fifteen, id Chest
```

A first 51 attempt died right after the bot joined, before any probe ran (an execute fault in no module, only
ChakraCore on the stack: Q8's "JIT'd code gone", log `work/host-runs/q8/nbt51-20260924-174722.err`). The solo
rerun and the next pair passed.

## 12. Still missing

Nothing from the queue item is left: `StructureTemplate` (sections 13-14), `CommandBlockComponent` and the item
components' network tags (sections 15-16) round-trip on both builds. Open ends noted there: the other
`Bedrock.NonOwnerPointer` returns (section 13), and a `cereal::ReflectionCtx` for a component not reached through
`ComponentItem.getComponent` (section 15).

## 13. `StructureTemplate`: save, the manager, and a NonOwnerPointer bdsx had the wrong size for

Two-route identifications, then execution (section 14).

| name | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `StructureTemplateData::save` | `0x3bc54c0` | `0x1f621a0` |
| `StructureTemplate::save` | `0x3bc54a0` | `0x1f62180` |
| `StructureManager::getOrCreate` | `0x36dd080` | `0x1f4ff90` |
| `??_7StructureManager@@6B@` | `0xa6e5dc0` | `0xa787e70` |

- **The keys are no longer where 2024 had them.** "format_version" and "size" are string_view literals now, read
  as 16-byte `movups` (not `lea`, so `tools/string-users.mjs` does not list them). "structure_world_origin" (22
  bytes, over SSO) is still a static `std::string`: its initializer (40 `0x3bfa8c0`, 51 `0x1fa20f0`) is the only
  function holding the literal, and it builds the global at 40 `0xc9bdcf0`. Scanning `.text` for any RIP-relative
  operand into that global gives four functions: the initializer, its atexit destructor, the load-side parser
  (called only by the shipped `load`), and 40 `0x3bd0670`, a writer whose only caller is `0x3bc54c0`. That caller
  is 2024's `StructureTemplateData::save` shape: allocate a `CompoundTag`, put "format_version", then three
  writers (size, world origin, the `structure` compound). It sits right after `load`, as in 2024.
- **`StructureTemplate::save` is 2024's five-instruction forwarder** (`addq $0x28, %rcx; call`), directly before
  the data's `save`, with no direct caller: it became virtual, slot 5 of `??_7StructureTemplate` (40 `0xa61a480`,
  the table the constructor `0x3bc3100` stores), and the StructureTemplateDataRequest handler (40 `0xa6d570`)
  calls a template's slot 5 with an sret. The 2024 decorated name (`QEBA`) ships: a direct call ignores it.
- **`getOrCreate`** is one of the constructor's fifteen callers: it calls its own `this`'s slot 3 (`getStructure`:
  shared lock on +0x18, FNV-1a of the name, the `unordered_map` at +0x60) and on a miss takes the exclusive lock,
  allocates a template (0x118 bytes on 40, 0x120 on 51), constructs it and emplaces it at +0x60, returning node
  +0x30, which is 2024's body. No direct caller: it is slot 2 of StructureManager's table, whose slot 0 (the
  deleting destructor) stores the table: that is the vftable's second route.
- **The layout moved.** 1.26 added `neighbor_aware_block_upgrade_version` (an int keyed by a 36-byte static
  string) at +0xc, so `size` is at +0x10 and `structure_world_origin` at +0x1c on both builds (both writers read,
  both parsers store exactly there). bdsx read them at the 2024 +0xc/+0x18; `structure.ts` now takes
  `layouts.StructureTemplateData.structureSize`/`structureWorldOrigin`.
- **The builds differ in what they write.** 40 writes `format_version` from `this+8` (1) and `block_indices` as
  two `ListTag`s of ints; 51 writes the constant 2 and one `IntArrayTag` layer. Each build's load reads its own
  save back identically (section 14), which is all the round trip needs.
- **`bedrockServer.structureManager` was a wrong pointer on both builds.** 1.26's `Bedrock::NonOwnerPointer<T>`
  is 24 bytes `{control, count block, object}`: `Level::getStructureManager` (40 `0x72d300`, 51 `0x7c5190`) copies
  `Level+0x2c0..+0x2d0` into its sret and adds a use. bdsx's `Bedrock.NonOwnerPointer` is the 2024 16-byte shape,
  so `get()` read the wrong thing and the call wrote 8 bytes past the 16 bdsx allocated. `engine/structure.ts`
  now calls it with 24 bytes, takes +0x10 and drops the use; launcher.ts's vftable assert then holds. The other
  `Bedrock.NonOwnerPointer.make(...)` returns (the connector, `getNonOwnerPointerServerNetworkHandler`): section 17.
- **`CxxVector.toTypedArray` threw on an empty vector** (`copyTo` refuses a zero-length array; the `null` check
  never fired because `getPointer` returns an object). 51 saves a fresh template's `block_indices` as an empty
  `IntArrayTag`, which is how it surfaced.

## 14. Execution (both builds, 2026-09-24, `nbts40`/`nbts51` pair, 8/8 each)

`tools/structure-probe.ts` (`[stprobe]`), drivers `tools/host/drivers/nbts40.ps1`/`nbts51.ps1`: fill a 3x3x3 of
stone at 40,68,14 with an oak log and a chest, `structure save bdsxprobe ... memory`, `nbtsprobe`, `structure
load bdsxprobe_copy 50 68 14`, `nbtsprobe placed`, clean up. tsc 0, exit 0, Quit correctly on both:

```
PASS manager: Level::getStructureManager's object ...: vptr == ??_7StructureManager@@6B@
PASS getOrCreate: getOrCreate("mystructure:bdsxprobe") == the map's entry; its name field "mystructure:bdsxprobe"
PASS nbtsprobe save: keys format_version,size,structure,structure_world_origin; format_version 1 (51: 2); size 3,3,3;
     structure_world_origin 40,68,14; block_indices 2 layer(s) x 27 (51: 1); palette stone,chest,oak_log; block entities
     Chest; StructureTemplate::save = StructureTemplateData::save
PASS nbtsprobe fields: formatVersion 1 (51: 2); size 3,3,3; structureWorldOrigin 40,68,14 (the engine wrote the same)
PASS getOrCreate new: "mystructure:bdsxprobe_copy" is in the map, StructureTemplate vptr, its name
PASS nbtsprobe empty save: a fresh template saves (51: {"format_version":2,"size":[0,0,0],"structure":{"block_indices":[{}],...}})
PASS nbtsprobe roundtrip: load true; re-save 1422 chars (51: 870), identical to the original's
PASS nbtsprobe placed: 27 blocks of "mystructure:bdsxprobe_copy" placed at +10 x: all match the original
```

The first pair found the NonOwnerPointer and layout problems (an access violation walking a wrong manager), the
second the empty-vector throw and a probe that stopped its map walk at 64 of ~98 templates. Regression after the
fixes: `nbt40`/`nbt51` 19/19 each; `layout51` 23/23; `layout40` 21/23 in the pair (Q8's two `effprobe speed`
checks) and 23/23 solo right after.

## 15. `CommandBlockComponent` and the item components' network tags

| name | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `CommandBlockComponent::addAdditionalSaveData` | `0x2768f60` | `0x2a5fd00` |
| `??_7ItemComponent@@6B@` | `0xa69bb80` | `0xa793140` |
| `ItemComponent::buildNetworkTag` (base, slot 4) | `0x23cf10` | `0x2cbf40` |
| `??_7InteractButtonItemComponent@@6B@` | `0xa6dee20` | `0xa7922b0` |
| `InteractButtonItemComponent::initializeFromNetwork` (slot 5) | `0x3f95b00` | `0x3048300` |

- **`CommandBlockComponent::addAdditionalSaveData`** still exists and still has 2024's body (`0x575d70`): putBoolean
  "Ticking" (an SSO immediate) from +0xc4 (2024 +0x9c), putInt "CurrentTickCount" from +0xc0 (2024 +0x98), then
  `BaseCommandBlock::save(this, tag)` (the "LastOutput" immediate writer), now a call instead of a tail jump. It
  was found through its 16-byte key: `"CurrentTickCount"` is over SSO, so the save copies the literal with a
  `movups`, which `tools/string-users.mjs` (lea only) does not list. A scan for any RIP-relative operand into the
  literal gives the load (only reached from `MinecartCommandBlock::readAdditionalSaveData`) and this function. Its
  one caller is `Actor::save`, which inlines 2024's caller `Actor::_serializeComponents`.
- **Getting the component**: `??$tryGetComponent@VCommandBlockComponent@@@Actor@@` has no out-of-line copy (2024's
  was `add rcx,8; jmp EntityContext::tryGetComponent`). `MinecartCommandBlock::readAdditionalSaveData` inlines the
  lookup: hash `0x42d5de32` = fnv1a("CommandBlockComponent"), packed stride `imulq $0xc8` on both builds (2024:
  0xa0). It is now a `derived()` over `enttComponent` (`layouts.CommandBlockComponent.size`).
- **`ItemComponent`'s base table**: an 8-slot table with 152 (51: 113) references, so every component destructor
  resets to it. It has 2024's shape (`0x2dcbf08`: 10 slots, 172 references) without the last two slots: the slot 0
  destructor frees 0x10, then true / ret / false (`isNetworkComponent`) / **buildNetworkTag = `mov rax,rdx; mov
  qword [rdx],0; ret`** (an empty `unique_ptr`, 2024's body; a leaf with no `.pdata`) / true / ret / ret. bdsx
  only needs the slot: `jsv` finds +0x20 and dispatches through each component's own table. That is also what
  `ComponentItem::buildNetworkTag`'s loop does (+0x18 `isNetworkComponent`, then +0x20).
- **`InteractButtonItemComponent`** is the table whose slot 5 is the only user of the "requires_interact" literal,
  2024's body line for line (the ByteTag's byte into +0x10, "interact_text" assigned to the `std::string` at
  +0x18, return 1; r8 is not read). Its slot 4 writes the same two keys. The deleting destructor frees 0x38. The
  slot numbers are 2024's. No vanilla item has this component (no `interact_button` in the host's vanilla
  behaviour packs), so the probe builds one in bdsx memory with the engine's vftable.
- **`cereal::ReflectionCtx` is an engine object.** A `NetworkedItemComponent<T>`'s buildNetworkTag reads its r8
  argument (for example `+0x18` in 40 `0x3400d60`). bdsx's default, an 8-byte zeroed `ReflectionCtx(true)`, would
  crash there. `ComponentItem::buildNetworkTag` passes the pointer the item holds (the constructor's 4th argument,
  `layouts.ComponentItem.reflectionCtx`: +0x290 on 40, +0x298 on 51, 2024 +0x2c0). `ComponentItem.getComponent`
  now hands that pointer to the component it returns. `ItemComponent.buildNetworkTag`/`initializeFromNetwork`
  use it when no context is passed, and throw when there is none, instead of passing the zeroed stand-in.
- **`ItemStackBase.getComponentItem()` returned the wrong JS class.** The `derived()` returned the `Item` wrapper
  cast, so `getComponent`/`buildNetworkTag` threw "Object doesn't support property or method" (item-probe's
  `compid` had logged it as INFO since 2026-09-24 03:53). It now returns `item.as(ComponentItem)`.

## 16. Execution (both builds, 2026-09-24, `nbt40`/`nbt51` pair, 23/23 each)

`tools/block-probe.ts` `nbtcprobe`, `nbtnprobe`, added to the `nbt40`/`nbt51` drivers after the five earlier
probes. tsc 0, exit 0, Quit correctly on both:

```
PASS nbtcprobe: bdsx save: 12 keys, Ticking 0 CurrentTickCount 0 Command ""; vs engine Actor::save identical; after engine load:
     Command "say probe-command-block-past-fifteen" CurrentTickCount 7 Ticking 1, vs the tag loaded identical, vs engine Actor::save identical
INFO nbtnprobe slots: buildNetworkTag [32], initializeFromNetwork [40]
PASS nbtnprobe base: ItemComponent's own buildNetworkTag through the engine's base vftable: null (want null)
PASS nbtnprobe interact: engine initializeFromNetwork true: requires +0x10 1, text +0x18 "probe-interact-text-past-fifteen";
     engine buildNetworkTag {"interact_text":...,"requires_interact":1}, equals the tag read true; into a second one true and out again, equals true
PASS nbtnprobe food: engine ComponentItem::buildNetworkTag has it at /minecraft:food: {"can_always_eat":0,"nutrition":4,
     "saturation_modifier":0.3...,"using_converts_to":{}}; bdsx (slot 4, the item's ctx) identical; initializeFromNetwork true, then again identical
```

`nbtcprobe` puts a command block minecart next to the bot. `nbtnprobe` uses an apple in hotbar 0. The first pair
was 22/23 on each build: `food` threw on the `getComponentItem` class bug above. The earlier probes (`nbtprobe`,
`btprobe`, `nbtiprobe`, `nbteprobe`, `nbtbprobe`) passed in both pairs.

## 17. `Bedrock.NonOwnerPointer` itself: the 1.26 shape, and the two other returns (2026-09-24)

**The class is fixed, not each call.** `bds/bedrock.ts`'s `NonOwnerPointer<T>` is now Endstone's
`non_owner_pointer.h` layout, 24 bytes: `control` (a `CxxSharedPtr<NonOwnerControlBlock>`: element +0, count block
+8) and `pointer` (T*, +0x10). `get()` returns the pointer only when the control block's first byte (`is_valid`) is
set; `assign()` copies with a use, `dispose()` drops the use and empties it. Every place that used the class was
checked: the two getters below, the 2024 `SimulatedPlayer::create` fallback in `implements.ts` (only runs when the
table has the 2024 decoration and not `bdsx:SimulatedPlayer::create`: neither 1.26 table), and the launcher's
shutdown `dispose()`. No class had a `NonOwnerPointer` field, so no other layout moved. `engine/structure.ts`
keeps its own raw 24-byte buffer (confirmed; nothing to gain by moving it).

**`Minecraft::getServerNetworkHandler`** has no address in either table, and that is why the launcher printed
`nonOwnerPointerServerNetworkHandler` "unavailable" at every serverOpen (`Symbol not found`, not a size problem:
the call never ran). 2024's body (0x17fb750) is `game_session_` (+0xc0) → `GameSession::getServerNetworkHandler`
(0x17fb690, which zeroes a 16-byte sret and fills it from the session's handler). The inventory's "gaps" candidate
(40 `0x23c450`) is an EnTT lookup, not this. Instead of searching, the pointer comes from the Level, which holds the
same `NonOwnerPointer` at +0x220 (`layouts.Level.serverNetworkHandler`):

- ILevel's virtual +0xa48 (40 `0x73f520`, 51 `0x7d7410`, identical 18-instruction bodies) copies
  `+0x220/+0x228/+0x230` into its sret and `lock incl`s the count block: the 24-byte shape again.
- Its object is the handler's second base: `ServerNetworkHandler`'s constructor (40 `0xa58530`, 51 `0x96b9b0`,
  found with `tools/ctor-from-vftable.mjs`) stores the unnamed EnableQueueForMainThread table at +0, and
  `??_7ServerNetworkHandler@@6BNetEventCallback@@@` at +0x10. The GameTest callers' `lea -0x10` (findings-slots.md
  "SimulatedPlayer") is the same fact.

`engine/networkhandler.ts` copies those three words with one use of its own and moves the object back
`layouts.ServerNetworkHandler.nonOwnerBase` (0x10). `Minecraft.getNonOwnerPointerServerNetworkHandler` is now a
`derived()` over it (`data/derived.json`), and the launcher builds `bedrockServer.nonOwnerPointerServerNetworkHandler`
the same way. It checks `get()` against `updateServerAnnouncement`'s `this`, and the handler's +0x10 against the
NetEventCallback table. That assert replaces 2024's check of `??_7ServerNetworkHandler@@6BEnableQueueForMainThread...`,
a name neither table has. 2024's `get().subAs(ServerNetworkHandler, 0x10)` ("cut corners") is gone: in the 1.26 shape
the pointer is the handler itself.

**`NetworkSystem::getRemoteConnector`** has no address in either table either. The launcher already read the
connector from `ServerNetworkSystem+0xf0` (`layouts.ServerNetworkSystem.connector`), so the `NonOwnerPointer` branch
never ran on 1.26. Endstone implements the getter in its own code (`remote_connector_.get()`) instead of calling
the image; whether 1.26 keeps an out-of-line copy was not searched, because nothing needs one. The branch and its 2024 `-48` adjustment were removed, and the name left `data/required-symbols.json`
at the re-scrape. A table without the layout now says so instead of falling through to a getter it lacks.

**Executed** (`layout40`/`layout51` + `nonownerprobe` in `tools/actor-layout-probe.ts`). Two paired runs had a tsc
type error (a cast, then `setPointer(null)`; JS was still emitted and the four lines passed), then solo runs with
tsc 0: `layout40` once, `layout51` twice. Every run: exit 0, Quit correctly, no `Equals assertion failure`, no
"unavailable" line:

```
PASS nonowner size 0x18 (want 0x18)
PASS nonowner launcher: control ... valid 1, count block ..., get() X == serverNetworkHandler X: true;
     handler+0x10 0x..9940 (want ??_7ServerNetworkHandler@@6BNetEventCallback@@@ 0x..9940)      (51: ..5340)
PASS nonowner uses: 6 -> getNonOwnerPointerServerNetworkHandler 7 -> assign 8 -> dispose 7 -> dispose 6
     (want +1,+2,+1,+0); fresh.get() == handler true, copy.get() == handler true, emptied after dispose true
PASS nonowner connector: ServerNetworkSystem member ..., vftable == ??_7RakNetConnector@@6BConnector@@@
```

Regression: `pk40`/`pk51` 16 PASS / 2 FAIL each (the expected two: `authinput-bits`, `entitySneak`), `nbts40`/`nbts51`
8/8 each (the manager assert and `stprobe manager`). `layout40` 27/27 solo and in the first pair, 25/27 in the
second. `layout51` had 25/27 in every run with this change: the two `effprobe speed` checks (Q8, now queue row 1). That is not this change: the same driver with the pre-change `bedrock.ts`/`launcher.ts`/
`implements.ts`/`structure.ts` uploaded (`--no-sync`) passed once and failed the same two checks once.

## 18. `ItemStack.constructWith`: `createItemStack` over `fromTag` (2026-09-27)

`?createItemStack@CommandUtils@@` has no address on either build, and `ItemStack.constructWith` (every plugin that
makes an item) called it. 2024's body (1.21.3.01 `0xcf9d40`, 639 B, read in full): clamp the count to [1, 64], an aux
above `0x7fff` (an unsigned compare, so a negative one too) becomes 0, `ItemRegistryRef::lookupByName(HashedString)`;
no item returns `ItemStack()`, else `ItemStack(item, count, aux, nullptr)` then `set(min(count,
item->getMaxStackSize(getDescriptor())))`. Its only 2024 callers were `LootCommand::getToolItemStack` and the agent's
`TillCommand`: `/give` never used it (it goes through `CommandItem::createInstance`).

**No 1.26 copy found.** 40's `ItemStackBase(Item const&, int, int, CompoundTag const*)` is `0x1bba9f0` (read: the
1.26 constructor opening from `findings-containers.md` section 10, then `init(Item&, ...)` `0x1bc1870`, whose three
calls to `init(int id, ...)` `0x1bc1aa0` end in the shipped `_setItem`). Its 73 calling functions were scanned for
the `$0x40`/`$0x7fff` clamp pair; of the four hits, two are named (`CommandItem::createInstance`,
`ThrownPotionEffectSubcomponent::doOnHitEffect`), `0x1c0df10` was read (an `ItemInstance` built from a descriptor)
and the fourth is a 2917-line body. The "mainhand"/"offhand" and `commands.loot.failure.*` anchors did not lead to
`getToolItemStack` either. Endstone does not name it (its own `createItemStack` calls `ItemStack(item, count)`,
which it re-implements in C++).

**So bdsx derives it** (`implements.ts`, `CommandUtils.createItemStack`; `data/derived.json`): the same two
clamps, then `ItemStack::fromTag` over `{Name, Count: ByteTag, Damage: ShortTag}` -- the keys and tag types
`ItemStackBase::save` writes (section 8), so the engine's own `_loadItem` does the lookup by name -- and, when the stack
is not null, `amount = min(count, getMaxStackSize())` through the derived `getMaxStackSize`. No new address.

**Execution, both builds** (`cis40`/`cis51`, `tools/item-probe.ts` `itemprobe construct|constructcount|constructgone`,
11 PASS / 0 FAIL each, `Quit correctly`, exit 0; `work/host-runs/cis40-20260927-174954.txt`, `cis51-...`):
`constructWith("minecraft:diamond", 3)` prints (BDS's `toString`) `3 x Diamond(306)@0`, the id BDS's `give` gave,
and BDS's own `sameItemAndAux` against the given diamond is true; `"diamond"` without a namespace works;
`diamond_sword` x5 comes back 1, `apple` x100 64; `potion` aux 22 is kept; `stone` x2 is `Stone(1)`; an unknown name
is null (the other side of the check). `PlayerInventory::add` put the diamonds in the bot's slot 0, BDS's
`Container::getItemCount` counts 3, the console's `clear @a diamond -1 0` says "bdsxprobe has 3 items that match
the criteria", and `clear @a diamond` says "removing 3 items" and leaves 0.

Open ends seen on the way, both closed in section 19: `ItemStackBase.getName()` threw on 1.26 (it goes through
`?getCommandNames@Item@@`, which has no address), and `?isBlock@ItemStackBase@@` had no address.

## 19. Item names and `isBlock`: `getCommandNames` over `Item::full_name_` (2026-09-27)

Section 18 left two things: `ItemStackBase.getName()` threw on both builds (bdsx takes the first entry of
`?getCommandNames@Item@@`, which has no address) and `?isBlock@ItemStackBase@@` has no address either.

**Where the name is not.** BDS's `toString` (40 `0x1bbfb40` / 51 `0x1a52430`) prints `Diamond(306)` from
`getCustomName` (`0x1bc5020` on 40), the hover name, not the identifier, so it is no route to `minecraft:diamond`.

**Where it is.** 2024's `Item::getCommandNames` (`0x1cab320`, read in full): an item whose `getLegacyBlock()` (+0x1c8)
is set answers with `BlockLegacy::getCommandNames`; otherwise it pushes `toLower(full_name_)` (+0x118, the
`HashedString` `getFullItemName` `0x1cacd80` / `getFullNameHash` `0x1cacd90` return) with the flag byte at +0x20 set,
and when `namespace_` (+0xf8) is `"minecraft"` clears that flag and pushes `toLower(raw_name_id_)` (+0xc8) with it set.
`BlockLegacy::getCommandNames` (`0x1bedcc0`) is the same shape over the block's name (+0x98), namespace and raw name.
In 1.26 `full_name_` is at **+0x120 on both builds**: `ItemStackBase::isNull` (40 `0x1bc2260` / 51 `0x1a549d0`, the
same instructions) compares the hash at `Item+0x120` with the air global, then the last-match pointer at +0x148 and the
`std::string` at +0x128 (size +0x138, capacity +0x140); Endstone's `isNull` spells that test as
`getFullNameHash() == BedrockBlockNames::Air`, and its `item.h` order (`id_`, `description_id_`, `raw_name_id_`,
`namespace_`, `full_name_`) gives +0x120 from the confirmed `id_` at 170. Shipped as `layouts.Item.fullName` (288).

**So bdsx derives both lists** (`engine/item.ts` `itemCommandNames`/`commandNames`, `implements.ts`; `data/derived.json`):
the block type's full name (`layouts.BlockLegacy.name`, +0xe0) for a block item, else `Item::full_name_`, lowercased,
split at the colon for the namespace and raw name, written into a `std::vector<CommandName>` the caller destructs as
before. `BlockLegacy::getCommandNames` gets the same over its own name. `isBlock` is 2024's body (`0x1b64660`: `item_`
and `*item_` set, then the item's block pointer set) over `Item::block_type_` (+0x178; a `WeakPtr` on 40, a raw pointer
on 51, `layouts.Item.blockTypeWeak` -- the field the wearable-block test already reads).

**Execution, both builds** (`cis40`/`cis51` through `verify-pair`, `tools/item-probe.ts` `itemprobe construct`,
16 PASS / 0 FAIL each, tsc 0, exit 0, `Quit correctly`; `work/host-runs/cis40-20260927-180825.txt`, `cis51-...`):
`getName()` is `minecraft:diamond` for `constructWith("minecraft:diamond", 3)` and for the diamond BDS's `give` put in
the bot's slot; the diamond's list is `[minecraft:diamond/false, diamond/true]`, 2024's shape; `constructWith(n).getName()`
gives back `n` -- the name the engine's own registry looked up -- for diamond, diamond_sword, apple, potion, stone, torch
and oak_log (the last three through the block path); `isBlock()` is true for stone, torch and oak_log and false for both
diamonds, diamond_sword, apple, potion and a null stack; stone's block type answers `minecraft:stone` first.

Not covered: an item whose full name is not `namespace:raw` (none seen), and an add-on item's namespace (the split gives
the add-on's; 2024 read the field).

## 20. `EnchantUtils.applyEnchant`: the instance overload, and `hasEnchant` over `getEnchantLevel` (2026-09-28)

`?applyEnchant@EnchantUtils@@SA_NAEAVItemStackBase@@W4Type@Enchant@@H_N@Z` had no address on either build, so every
plugin that enchants an item threw. `hasEnchant` had none either.

**2024.** The (item, type, level, allowUnsafe) overload (1.21.3.01 `0x1add0e0`, 53 B) only builds an
`EnchantmentInstance` on the stack and calls the (item, `const EnchantmentInstance&`, allowUnsafe) overload
(`0x1add040`). The instance constructor is `0x1a8cb30`, ICF'd with `ContainerValidationSlotData`'s: `movb %dl,(%rcx);
movl %r8d,4(%rcx)`, so the type is a byte at +0 and the level an int at +4. The instance overload does
`constructItemEnchantsFromUserData` → `ItemEnchants::addEnchant(instance by value, allowUnsafe)` → on success
`_convertBookCheck` and `saveEnchantsToUserData`. The (type, level) overload's only callers are
`EnchantCommand::execute` (twice) and `CompassItem::_useOn`.

**1.26.** `EnchantCommand::execute` (40 `0x1850590`, 51 `0x1956790`) is the only `lea` user of
`commands.enchant.success`. It writes the byte and the int inline into a stack slot (40 `-0x10(%rbp)`, 51 `-0x20(%rbp)`).
It calls `EnchantUtils::canEnchant(sret, item, &instance, 0)` and then, at both of 2024's `applyEnchant` sites,
**40 `0x1c66a90` / 51 `0x1b56000`** with (item, &instance, 0). So the wrapper is inlined and the instance overload is
not. The two bodies are the same instructions. They are 2024's `0x1add040` with `addEnchant` inlined:
- `constructItemEnchantsFromUserData` (40 `0x1bc3be0`, 51 `0x1a56170`).
- The instance loaded by value.
- `ItemEnchants::canEnchant(sret, instance, allowUnsafe)` (40 `0x1c00040`, 51 `0x1af34d0`).
- `determineActivation` inlined (type ≤ `0x29` into a table).
- Result 3 pushes the instance and result 2 overwrites the level. Anything else returns 0.
- Then the book check and `saveEnchantsToUserData` (40 `0x1bc3d40`, 51 `0x1a562d0`), and a return of 1.

This build's `getEnchantLevel` (in the table) uses the same `constructItemEnchantsFromUserData` and the same activation
table. The 1.26 callers include `EnchantCommand::execute` ×2 and `CompassItem::_useOn`, which were 2024's (type, level)
callers. The address now ships under its own decoration
(`?applyEnchant@EnchantUtils@@SA_NAEAVItemStackBase@@AEBVEnchantmentInstance@@_N@Z`).

**What `canEnchant` tests** (40 `0x1c00040`, read in full; 2024's `ItemEnchants::canEnchant` `0x1addd70` is the same
shape):
- The item's enchant slot against the enchantment's two slot masks (`+0x14`/`+0x18`). allowUnsafe skips this test.
- A loop over the enchantments already in the same activation group, asking each for compatibility (vft `+8`). This
  loop runs even with allowUnsafe.
- For the same type already present, **the existing level against `getMaxLevel`** (vft `+0x28`). A new level is never
  compared with the maximum: the command makes that test itself, before it calls `applyEnchant`.

So the queue's "a level past the maximum without allowUnsafe returns false" is not what the function does. The other
side it does have is an existing level at the maximum, a wrong slot, or an incompatible enchantment.

**So bdsx derives the (type, level) overload** (`engine/enchant.ts` `applyEnchantOwn`, `implements.ts`;
`data/derived.json`). It allocates the 8-byte instance (the byte at +0, the int at +4, the padding zeroed) and calls the
instance overload. **`hasEnchant` is `getEnchantLevel(type, item) > 0`.** 2024's two bodies (`0x1ae8650`,
`0x1ae3740`) are the same instructions, and `hasEnchant`'s ends in `setg`.

**Execution, both builds** (`ench40`/`ench51` through `verify-pair`, `tools/item-probe.ts` `itemprobe enchantbds` +
`itemprobe enchant`; 14 PASS / 0 FAIL each, tsc 0, exit 0, `Quit correctly`; `work/host-runs/ench40-20260928-000818.txt`,
`ench51-...`):

*The engine writes, bdsx reads (`enchantbds`).* After the console's `enchant @a sharpness 3` on the bot's main-hand
diamond sword:
- `getEnchantLevel(Sharpness)` is 3.
- BDS's `ItemStackBase::save` gives `ench [9:3]`.
- The derived `hasEnchant` is true for Sharpness and false for Smite.

*bdsx writes (`enchant`).* On a fresh sword (`ench []`, `hasEnchant` false):

| call | returns | level after | NBT `ench` |
|---|---|---|---|
| Sharpness 2 | true | 2 | `[9:2]` |
| Sharpness 2 again (equal level) | true | 3 | |
| Sharpness 1 (lower level) | true | 3 | |
| Sharpness 5 | true | 5 | |
| Sharpness 1 (existing level at the maximum) | **false** | 5 | |
| Protection 1, no allowUnsafe (wrong slot) | **false** | 0 | |
| Smite 1 (incompatible with Sharpness) | **false** | 0 | |
| Protection 1, allowUnsafe | true | 1 | |
| Unbreaking 10, no allowUnsafe (new, past its maximum of 3) | true | 10 | |

- The `[9:2]` read shows the byte at +0 and the int at +4 are where the body reads them.
- The three refusals left the item unchanged.
- The list at the end is `[0:1, 9:5, 17:10]`.
- `layout40/51` was 27/27 after the change.

Found on the way, not done: `constructItemEnchantsFromUserData` and `saveEnchantsToUserData` are the callees named
above, and bdsx declares both. `isEnchanted` and `hasCurse` also have no address. All four are done in section 21.

## 21. The rest of the enchant layer: `ItemEnchants` in and out, `hasEnchant`, `hasCurse`, `isEnchanted` (2026-09-28)

Section 20 named the two callees of the instance `applyEnchant`. bdsx already declared both; neither had an address.

**`constructItemEnchantsFromUserData`** (40 `0x1bc3be0`, 51 `0x1a56170`, 289 B each, the same instructions). The
`this` is rcx (the `ItemStackBase`) and the sret is rdx, as in 2024 (`0x1b5a9d0`). The body:
- reads the user tag at `this+0x10`, finds `"ench"` (a 4-byte `string_view` over the literal) and tests the tag's
  `getId()` (vft `+0x28`) against 9, a `ListTag`;
- writes the item's enchant slot (the `Item` vft `+0x1c0`, 2024's `+0x190`) as an int at sret `+0`;
- zeroes sret `+0x8..+0x50`, the three vectors;
- with a list, calls the `ItemEnchants`-from-`ListTag` loader (40 `0x1bffc70`, 51 `0x1af3170`), which is 2024's
  `ItemEnchants(int, const ListTag&)` constructor split in two.

So the sret is **0x50 bytes on both builds**: the slot at +0 and the vectors at +8/+0x20/+0x38, bdsx's `ItemEnchants`
as it was. The 51 address was also the gaps route's candidate (`candidates-gaps-1.26.51.1.json`), which was not merged.

**`saveEnchantsToUserData`** (40 `0x1bc3d40`, 491 B; 51 `0x1a562d0`, 400 B). The `this` is rcx and the `const
ItemEnchants&` is rdx, as in 2024 (`0x1b6b760`). The body:
- does nothing without an item (`this+8`, then `*item`);
- inlines `ItemEnchants::isEmpty` as the three begin/end pairs `+8/+0x10`, `+0x20/+0x28`, `+0x38/+0x40`;
- when empty, removes `"ench"` from the user tag;
- otherwise makes the user tag if there is none (a `CompoundTag` built inline), turns the enchants into a list
  (40 `0x1c00fd0`, 51 `0x1af4390`, 2024's `_toList`) and `put`s it under `"ench"`.

**`hasCurse`** (2024 `0x1ae8610`): `hasEnchant(27) || hasEnchant(28)`, 51 bytes. Its 2024 callers are the grindstone's
two result functions and `RepairItemRecipe::assemble`. A scan of `.text` for `mov cl,0x1b` followed within 48 bytes by
`mov cl,0x1c` finds 2024's own body and two sites per 1.26 build (40 `0x1c65f44`, `0x8f4f01c`; 51 `0x1b5530f`,
`0x46e3a7c`). In each, the pair is inlined into a larger function, and both calls go to one out-of-line function:
**40 `0x1c73a00` / 51 `0x1b62680`, `EnchantUtils::hasEnchant(Enchant::Type, const ItemStackBase&)`**. Its body is the
table's `getEnchantLevel` (40 `0x1c75410`) instruction for instruction, the same `"ench"` list test,
`constructItemEnchantsFromUserData` and activation-table walk, except that it ends in `cmpl $0,4(%rax); setg %sil`, which
was 2024's `hasEnchant` ending. So `hasCurse` has no 1.26 copy, and `hasEnchant` does.

**`isEnchanted`** (2024 `0x1b64970`): the user tag exists and `contains("ench", List)`. None of the 34 users of `"ench"`
on either build is that function alone. The smallest are `ThrownTrident::isEnchanted` (40 `0x1ac7fd0`, 51 `0x1cce430`)
and an `isGlint`-shaped function (40 `0x24e82a0`, 51 `0x1a8cef0`), and each inlines the test followed by its own. So it
is inlined everywhere.

**What ships.**
- Addresses: `constructItemEnchantsFromUserData`, `saveEnchantsToUserData`, and `?hasEnchant@EnchantUtils@@`. The
  address makes the derived `hasEnchant` of section 20 fall back to the binary. The type now goes in as a byte.
- Derived in `implements.ts` (`data/derived.json`):
  - `hasCurse` is 2024's body over `EnchantUtils.hasEnchant`.
  - `isEnchanted` is the inlined test: the user tag at `+0x10`, `get("ench")`, `getId() == Tag.Type.List`.

**Execution, both builds** (`ench40`/`ench51` through `verify-pair`, `tools/item-probe.ts` `itemprobe enchantbds`,
`enchantcurse`, `enchant`; 22 PASS / 0 FAIL each, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/ench40-20260928-004720.txt`, `ench51-...`). The first pair of runs also passed 22/22 but had a type error
in the probe (tsc 2), so it is not counted.

| step | `constructItemEnchantsFromUserData` | NBT `ench` (BDS's `save`) | `isEnchanted` | `hasCurse` |
|---|---|---|---|---|
| console `enchant @a sharpness 3` | slot 16, `[9:3]` | `[9:3]` | true | false |
| the copy with Sharpness 4, `saveEnchantsToUserData` | | `[9:4]` (`getEnchantLevel` 4) | | |
| console `enchant @a vanishing` | `[28:1, 9:4]` | `[9:4, 28:1]` | true | true |
| a fresh sword | slot 16, `[]` | `[]` | false | false |
| after section 20's `applyEnchant` steps | `[0:1, 17:10, 9:5]` | the same | true | false |
| bdsx's `applyEnchant(BindingCurse, 1, allowUnsafe)` | | `+27:1` | true | true |
| an empty `ItemEnchants` saved back | | `[]`, the tag gone | false | false |

- Every entry the constructor lists equals `getEnchantLevel` for that id.
- `hasEnchant` now comes from the table on both builds. It is still true and false where section 20 saw it, and it is
  true for `VanishingCurse` after the console's enchant.
- `layout40/51` was 27/27 after the change.

## 22. The item component vftables and `FreezeOnHitSubcomponent` (2026-09-28, agent-u)

bdsx's `ItemComponent.setResolver` picks a component's JS class by comparing its `+0` vptr against nineteen
`??_7<X>ItemComponent@@6B@` names. Before this, only `FoodItemComponent` had an address, so every other component
`ComponentItem.getComponent` returned came back as the base class. Sixteen more ship now. Two were never
`ItemComponent`s and leave the resolver. `FreezeOnHitSubcomponent` ships its table, `getName` and `writetoJSON` on both
builds, and `readfromJSON` on 40 only.

**How the tables are named.** Every 1.26 networked component table has the base `ItemComponent` table's 8-slot shape:
dtor, `checkComponentDataForContentErrors`, `writeSettings`, `isNetworkComponent` (`true`), `buildNetworkTag`,
`initializeFromNetwork`, `handleVersionBasedInitialization`, `_initializeComponent`. That is 2024's ten slots without
`_canUseOn`/`_useOn`. `NetworkedItemComponent<T>::buildNetworkTag` (slot 4) builds a cereal type descriptor and stores
`fnv1a("T")`, T's bare class name, into it: `movl $hash, 0x2d8(%rbp)` on 40, `0x2c8(%rbp)` on 51. Scanning every table of
that shape (45 per build; `.rdata` scan output `work/vft/scan-<v>.json`) for that store names 42 of them, no two sharing
a hash. The already-executed `FoodItemComponent` table (`0x337e001`) is one of the 42. `PlanterItemComponent` stores its
hash at `0x338(%rbp)`, `InteractButtonItemComponent` has custom bodies, and one table uses only `"autoSucceedOnClient"`.
Two more routes agree for all sixteen:
- **2024's slot shape** (`work/vft/baseline-slots.json`). The class-specific slots sit where 2024 has them: Throwable and
  EntityPlacer have `handleVersionBasedInitialization`; Icon, Wearable, Shooter and EntityPlacer have
  `_initializeComponent`; Shooter's slot 1 is non-trivial.
- **The component's own registration code.** The functions that hold `fnv1a("X")` as an immediate (7-19 per component)
  `lea` this table 3-5 times, and no other `ItemComponent`-shaped table.

Only `FoodItemComponent`'s destructor stores a second table (`IFoodItemComponent`, `+0x10`), so every other name is the
plain `6B@` one. On 40, `RenderOffsets` sits merged into a longer table in the scan file; its first 8 slots are
the table.

| component (id) | 1.26.40.8 | 1.26.51.1 | checked |
|---|---|---|---|
| Cooldown (`minecraft:cooldown`) | `0xa6deae0` | `0xa791f70` | executed, a real item (wind_charge) |
| Durability | `0xa6dec20` | `0xa7920b0` | executed, real items (fishing_rod, wolf_armor, ...) |
| DisplayName | `0xa6debe0` | `0xa792070` | executed, real items (apple, trial_key, ...) |
| Fuel | `0xa6df7d0` | `0xa793550` | executed, real items (coal, charcoal) |
| Icon | `0xa6dede0` | `0xa792270` | executed, real items |
| Planter (`minecraft:block_placer`) | `0xa6df4a0` | `0xa7928d0` | executed, real items (sugar_cane, kelp, cake, repeater, ...) |
| Projectile | `0xa6df4e0` | `0xa792910` | executed, real items (snowball, wind_charge, arrow) |
| Record | `0xa701ee0` | `0xa792990` | executed, real items (seven music discs) |
| Throwable | `0xa69b9d0` | `0xa793070` | executed, real items (snowball, wind_charge) |
| Wearable | `0xa69baf0` | `0xa7930f0` | executed, a real item (arrow) |
| RenderOffsets | `0xa701f20` | `0xa7929d0` | executed, a bdsx-built object |
| Digger | `0xa6deba0` | `0xa792030` | executed, a bdsx-built object |
| Repairable | `0xa6df560` | `0xa792a10` | executed, a bdsx-built object |
| EntityPlacer | `0xa6deca0` | `0xa792130` | executed, a bdsx-built object |
| Armor | `0xa6dadc0` | `0xa78b630` | **static only**: three routes, see below. No 1.26 item JSON can hold it (section 24) |
| Shooter | `0xa76dc60` | `0xa8e99e0` | executed, a data-driven item (section 24) |

**Weapon and OnUse are not `ItemComponent`s.** In 2024, `??_7WeaponItemComponent@@6B@` (`0x2e1e598`) and
`??_7OnUseItemComponent@@6B@` (`0x2e1e218`) are one-slot tables: a destructor and nothing else. Their only users are
copy constructors, `std::optional<T>::_Construct/_Assign`, `cereal::internal::fillOptional` and
`IItemComponentLegacyFactoryData::Components::set`. They were data held in the legacy factory data, never objects in
an item's component map. `WeaponItemComponent`'s 0x338 bytes are three `DefinitionTrigger`s. In 1.26 both type hashes
(`0x900f5379`, `0x099c72d3`) occur only in cereal schema descriptors and `std::function` bodies, never in an
`ItemComponent`-shaped table. bdsx dropped the two resolver entries (`960def76`), so the names are no longer
required. `isWeapon()`/`isOnUse()` stay and are always false, as in 2024.

**`FreezeOnHitSubcomponent`.** The projectile on-hit factory registers one `std::function` per subcomponent name.
Under `"freeze_on_hit"` (an SSO immediate) its call allocates 0x18 bytes and stores the table: 40 `0x1acebd0` stores
`0xa649b30`, 51 `0x24c6450` stores `0xa79fc00`. 2024's deleting destructor frees 0x18 too. The 5 slots are 2024's:
dtor, `readfromJSON`, `writetoJSON`, `doOnHitEffect`, and `getName` (`lea "freeze_on_hit"; ret`, a leaf with no `.pdata`:
40 `0x1acec70`, 51 `0x24c64c0`). `writetoJSON` (40 `0x1aedcd0`, 51 `0x240d5c0`) writes the same fields on both builds:
`size` from `+0xc` as a double, `snap_to_block` from `+0x10`, `shape` from `+0x8` (`"sphere"` when it is 1, else
`"cube"`). `readfromJSON` (40 `0x1aedb80`) is 2024's body and never reads r8, the `SemVersion`. **On 51, slot 1 is no
longer `readfromJSON`.** `0x240d3e0` copies `+0xc`/`+0x10`/`+0x8` from a
`SharedTypes::v1_26_50::FreezeOnHitSubcomponentDefinition`, whose own reader (`0x240d400`) now parses the JSON. So 51
ships no `readfromJSON`, bdsx's binding throws there, and `data/arch-classes.json` classes it `moved`.

**Execution** (`verify-pair`, drivers `icomp40`/`icomp51`, `tools/itemcomp-probe.ts`, tag `[icprobe]`, no client). Every
run had tsc 0, exit 0 and `Quit correctly`:
- **`sweep` and `freeze` together: 27 PASS / 0 FAIL on each build** (`work/host-runs/icomp40-20260928-005922.txt`,
  `icomp51-...`). The sweep builds 177 vanilla item names with `ItemStack.constructWith`; 174 exist and 28 have a component map. For each of the
  nineteen ids, `getComponent` on every item that has the component returns an object with this table at `+0` that
  resolves as bdsx's class. That object's `buildNetworkTag` equals the entry the engine's
  `ComponentItem::buildNetworkTag` writes for the id. The other eleven ids the engine lists (tags, use_modifiers,
  storage_item, dyeable, ...) resolve as the base class. No item holds armor, digger, entity_placer, render_offsets,
  repairable, shooter, weapon or on_use.
- **`freeze`: 4 PASS on each build.** The object is built like the factory builds one. `getName` gives
  `"freeze_on_hit"`. `writetoJSON` gives `{"shape":"sphere","size":2.5,"snap_to_block":true}` from fields 1/2.5/1 and
  `{"shape":"cube","size":0.75,"snap_to_block":false}` from 0/0.75/0. On 40, `readfromJSON` of those two JSONs into a
  zeroed object gives 1/2.5/1, then 0/0.75/0. On 51 it throws `Symbol not found` and leaves the object untouched.
- **`synth <c>`** covers the components no vanilla item holds. The object is the component's size (what its deleting
  destructor frees), zeroed, with the table at `+0`. It goes through bdsx's
  `ItemComponent.buildNetworkTag`/`initializeFromNetwork` (the vptr's slots 4/5) with the apple's engine
  `ReflectionCtx`.
  - The first run: **9 PASS / 2 FAIL on each build** among the synth lines, the only ones the transcript kept
    (`icomp40/51-20260928-010220.txt`).
  - The second run: **36 PASS / 1 FAIL each**, all three steps (`icomp40/51-20260928-010425.txt`).
  - Every FAIL was the probe's own expectation. The engine's slot 4 writes each component's schema:
    - RenderOffsets: `main_hand`/`off_hand` with `first_person`/`third_person` transforms.
    - Digger: `{destroy_speeds:[],use_efficiency:0}`. With `use_efficiency` set to 1, slot 5 reads it and slot 4 writes 1.
    - Repairable: `{repair_items:[]}`.
    - EntityPlacer: `{dispense_on:[],entity:"",use_on:[]}`.
  - Every one reads its own tag back identical. EntityPlacer's slot 5 refuses the empty entity (false, first run's
    FAIL). Given `"minecraft:pig"`, it returns true and writes back `"minecraft:pig<>"`, `ActorDefinitionIdentifier`'s
    full name. The probe wanted the literal (the remaining FAIL), and its expectation is now corrected but **not rerun**.
    The retry budget was spent.
  - Armor writes `{}` even with `+0x8`/`+0xc` set to 7. That is consistent with section 11 of `findings-inventory.md`:
    1.26 moved an old `minecraft:armor` into `minecraft:wearable`'s protection, so this schema has no networked field.
- `layout40/51` afterwards: 27 / 0 each. `engine-deps --missing` is empty on both builds.

**Static only: Armor and Shooter.** Both rest on the three routes above: the hash store in slot 4, 2024's shape, and
the registration code's `lea`. Neither is executed. No vanilla 1.26 item carries either component: bow and crossbow are
native, and a behaviour-pack search on the host finds only entity `shooter`s. Armor's network schema is empty, so
execution cannot tell it apart. Shooter holds an `ItemDescriptor` (a vptr: its destructor stores `0xa55da30`), which a
zeroed object cannot fake. Executing either needs a data-driven item that carries the component: a
`format_version` < 1.20.20 item for armor, or any item with `minecraft:shooter`. **Update (section 24):** Shooter was executed
with a data-driven item. Armor cannot be: 1.26 rejects every item JSON that would hold it.

**Rules.**
- **A networked item component names itself.** Its `buildNetworkTag` stores `fnv1a` of its bare class name. The name
  does not have to be an EnTT type-list entry: Armor, Shooter and Food are not.
- **A component no vanilla item holds can still be driven through its own table.** Build an object the size its
  deleting destructor frees, zeroed, with the table at `+0`, and hand it an item's `ReflectionCtx`. This only works
  when no member needs a vptr.

## 23. `ItemDescriptor`: every constructor and the destructor are inlined (2026-09-28, agent-v)

`ItemDescriptor` is 0x10 bytes on both builds: its vptr, then `std::unique_ptr<BaseDescriptor> impl_` at +8 (Endstone's
`item_descriptor.h`, Apache-2.0). 2024 kept `??0ItemDescriptor@@QEAA@XZ` (0x1b486f0), the copy (0x1b476a0) and
`??1ItemDescriptor@@UEAA@XZ` (0x149790) out of line. None of the three has a 1.26 copy on either build.

**The vptr.** `?getDescriptor@ItemStackBase@@` (40 `0x1bc1d60`, 51 `0x1a544e0`, in the table) stores
**40 `0xa55da30` / 51 `0xa64fef0`** into its sret with a null `impl_` on its no-item path. That pair of stores is
2024's default constructor exactly. `tools/ctor-from-vftable.mjs` reads it as a 3-slot table on both builds, the same
shape as 2024's `??_7ItemDescriptor@@6B@` (`0x2bd3c28`):
- slot 0 is the scalar deleting destructor (below);
- slots 1-2 are the two `serialize` overloads.

**Nothing out of line but slot 0.** About 1,200 functions per build store the vptr. A scan of every `lea` of it finds
the following, and nothing else:
- no leaf without `.pdata` that is only the two stores;
- no function that opens with the vptr store and a clone of `[rdx+8]`.

The copies are inlined into their callers, e.g. the vector growths 40 `0x1b23d50` / 51 `0x2441e20`. Each stores the
vptr, then calls `[[other.impl_]+0]` with rdx = `&new+8`, or stores 0.

**The destructor.** Slot 0 is 40 `0x23e110` / 51 `0x1cea20`, 78 B each, both read in full. It:
- stores the vptr;
- releases `impl_` through its own table's deleting destructor with 1 (`BaseDescriptor` slot 16 `+0x80` on 40, slot 17
  `+0x88` on 51);
- calls `operator delete(this, 0x10)` only when edx != 0.

With 0 it is 2024's `~ItemDescriptor`. It ships as `??_GItemDescriptor@@UEAAPEAXI@Z`, beside `??_7ItemDescriptor@@6B@`.

**`BaseDescriptor`'s table** (`??_7InternalItemDescriptor@@6B@`, 17 slots on 40 and 18 on 51):
- **slot 0 is `clone`** (40 `0x2533930`, 51 `0x1adab90`): 0x18 bytes from the engine allocator, the vptr, the 16-byte
  `ItemEntry` copied, the pointer written to `[rdx]`, rdx returned;
- **slot 3 is `getFullName`**, which returns `std::string` by value in 1.26 (2024 returned a `const&`);
- slots 14-16 on 40 are `shouldResolve`, `resolve` and the destructor, as `getDescriptor` calls them. 51 adds one
  virtual after `toString`, so they sit one slot later there.

**What ships** (`bdsx/bds/engine/itemdescriptor.ts`, `derived()` in `implements.ts`, `data/derived.json`):
- default: the vptr and a null `impl_`;
- copy: the vptr, then `impl_ = other.impl_ ? other.impl_->clone() : null`, with clone's sret pointed at `&this->impl_`
  as the inlined copies do;
- destructor: `??_G` with 0.

`impl_` is the engine's memory from end to end: allocated by clone, freed by its own deleting destructor. bdsx's derived
`ItemStackBase.getMaxStackSize` now destructs the descriptor it builds; before this it leaked one `impl_` per call.

**Execution, both builds** (`idesc40`/`idesc51` through `verify-pair`, `tools/item-probe.ts` `itemprobe descriptor
<name|empty>` and `stacksize 64`; 10 PASS / 0 FAIL each, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/idesc40-20260928-011634.txt`, `idesc51-...`):

| held | `getDescriptor()` then a bdsx copy | 200 rounds |
|---|---|---|
| diamond sword | new `impl_` pointer, `InternalItemDescriptor` vptr, the held `Item*`, aux 0, `Item::id_` 318 = `getId()`, `getFullName` `"minecraft:diamond_sword"` | clean, `getMaxStackSize` 1 |
| 5 stone (the block path of `getDescriptor`) | the same checks, id 1, `"minecraft:stone"` | clean, 64 |
| empty hand | `impl_` null in the source and in the copy | clean, 255 |

- Each round is a default construct, `getDescriptor`, two chained copies, four destructs, and `getMaxStackSize`.
- A default construct gives this build's vptr and a null `impl_`.
- `layout40/51` was 27/27 after the change.

## 24. The rest of the item components: Shooter executed, Armor unreachable, and the six component methods (2026-09-28, agent-w)

A throwaway behaviour pack (`tools/host/icpack.ps1`) holds six data-driven items: `bdsxprobe:shooter`, `:armor`, `:repair`, `:food`,
`:throw` and `:placer`. The drivers `icx40`/`icx51` install it into the instance's world for one run and remove it in
`finally`. Every run printed `same=True` for the world's entries before and after on both builds, and an ssh listing
afterwards showed only `db`, `level.dat`, `level.dat_old` and `levelname.txt` on both.

**(a) Shooter: executed.** `icprobe sweep` builds `bdsxprobe:shooter`. The engine-built component's `+0` is the shipped
table (40 `0xa76dc60`, 51 `0xa8e99e0`) and resolves as `ShooterItemComponent`. Its `buildNetworkTag` equals the engine's
entry. The pack's Repairable and EntityPlacer items now also check their tables on real engine objects, not only on
bdsx-built ones.

**Armor cannot be executed on 1.26.** BDS refuses every item JSON that could hold it:
- With `format_version` 1.20.10 and `minecraft:armor` plus `minecraft:wearable`: `[Item] To use item component
  'minecraft:wearable', use json format version 1.20.20 or higher`.
- The same without wearable: `[Components] upgrade items/armor.json | ... | minecraft:armor | ... Item must have a
  'minecraft:wearable' component to be equippable`. This comes from `ArmorItemComponentVersioning::UpgradeTo12020`.
- With 1.16.100: that error, plus `To use item 'bdsxprobe:armor2', use json format version 1.20.0 or higher`.

So the table stays static-only: three routes, section 22. The class and its upgrade still exist in both images, so the
`gone` bar (`plan-architecture.md` section 4) is not met, but no content can put one in an item's component map.

**(b) `synth entity_placer`:** the corrected expectation passed on both builds. `initializeFromNetwork` with
`"minecraft:pig"` returns true and writes back `"minecraft:pig<>"`.

**(c) The six methods.** Two are still out of line, one moved to a static, and three are inlined:

| name | 1.26.40.8 | 1.26.51.1 | what 1.26 did |
|---|---|---|---|
| `ProjectileItemComponent::shootProjectile` | `0x62a6a40` | `0x717fbd0` | out of line, 2024's prototype and body |
| `RepairableItemComponent::handleItemRepair` | `0x62b2d90` | `0x718bc80` | out of line, 2024's prototype and body |
| `bdsx:EntityPlacerItemComponent::_setActorCustomName` | `0x3f77080` | `0x302a020` | now a static `(Actor&, const ItemStack&)` |
| `ProjectileItemComponent::getShootDir` | - | - | inlined into the throw, `derived()` |
| `ThrowableItemComponent::_getLaunchPower` | - | - | inlined into both throwable callbacks, `derived()` |
| `FoodItemComponent::getUsingConvertsToItemDescriptor` | - | - | inlined into the script getter, `derived()` |

How each was found:
- **The throw.** Throwable's slot 7 (`_initializeComponent`: 40 `0x27d1e60`, 51 `0x2c5b9d0`) registers two callbacks:
  use (40 `0x281e800`, 51 `0x2c94120`) and release (40 `0x27cd1c0`, 51 `0x2c56d90`). Each computes the launch power
  inline. Each then calls 2024's `_doThrow` (40 `0x27ccdc0`, 51 `0x2c56990`) with the component, the item, the player,
  the `"minecraft:projectile"` component and the power. `_doThrow` inlines `getShootDir` and `getAimPos`, then calls
  `shootProjectile` with the BlockSource, &aim position, &direction, power and player: 2024's order.
- **`getShootDir`, inlined.** It reads the rotation at `Actor+0x228`: pitch at +0, yaw at +4. When the player rides,
  the yaw comes from the vehicle's vftable +0x390 (40) or +0x388 (51). Those are slot 114 and slot 113, where the table's
  `getPassengerYRotation` sits; 2024 used +0x3c8, slot 121. The direction uses mce::Math's 65,536-entry sin table:
  index = radians × 10430.378, cos a quarter turn on, with constants -π/180 and -π. The angle offset is folded to 0.
  `engine/itemcomponent.ts` repeats the float steps and the table exactly.
- **`_getLaunchPower`, inlined.** In either image, the only matches of `mulss 0x1c(r); minss 0x20(r)` are the two
  callbacks, and no leaf references 2024's 1/3 and 2/3 constants any more. The formula is `min((t*t + 2t)/3, 1)`, with
  `t = (maxUse - left) / (int)(max_draw_duration * 20)`. The fields: +0x14 min_draw, +0x18 max_draw, +0x1c
  launch_power_scale, +0x20 max_launch_power, +0x24 scale_power_by_draw_duration, +0x25 do_swing_animation (layouts
  `ThrowableItemComponent`).
- **`handleItemRepair`.** Found through the only `lea`s of `"minecraft:repairable"`:
  - `ComponentItem::isValidRepairItem` (40 `0x33c6280`).
  - The function with 3 callers, which matches 2024's anvil, grindstone and repair-recipe callers.
  - Its body is 2024's, instruction for instruction the same on both builds.
  - `RepairItemResult` is the repaired `ItemStack` (0x98), then an int at +0x98: how many materials `_repairItem`'s
    loop used. That loop repairs by `min(amount, damage)` per material and stops at 0 damage or at the material count.
  - bdsx's old binding returned an int, had no sret, and dropped the bool. It now returns a `RepairItemResult` class.
- **`_setActorCustomName`.** 1.26's body is 2024's:
  - EnTT `NameableComponent` (fnv1a `0x97d981a9`, stride 2), then the item's custom-name check (Item vftable +0x300),
    then the name (+0x2f8), then `nameEntity`.
  - It has exactly two callers: the entity placer's use-on callback (from slot 7, 40 `0x40b0300`) and the dispense.
  - The register use shows `rcx` = actor and `rdx` = item: no component. So it ships under a `bdsx:` key, and bdsx's
    method ignores its `this`.
- **`getUsingConvertsToItemDescriptor`, inlined.** The only `lea` of `"usingConvertsTo"` is the script getter (40
  `0x4f871a0`, 51 `0x55ea320`). It looks up `"minecraft:food"`, stores the `ItemDescriptor` vptr, and clones `+0x28`
  (the `impl_` of the descriptor at +0x20). bdsx returns `ItemDescriptor.construct(copy of +0x20)` (section 23's copy).

**Execution** (`verify-pair`, `icx40`/`icx51`, `tools/itemcomp-probe.ts`; run with a bot and a SimulatedPlayer
`icsim`): **51 PASS / 0 FAIL on each build**, tsc 0, exit 0, Quit correctly (`work/host-runs/icx40-20260928-015704.txt`,
`icx51-...`). `layout40/51` gave 27/0 afterwards.
- **`throw`.** bdsx hooks the shipped `shootProjectile`, and icsim throws its own snowball with `simulateUseItemInSlot`.
  - The engine's throw passes its inlined direction and power.
  - bdsx's `getShootDir(icsim, 0)` equals the direction within 1.8e-7 at three rotations: pitch 0 / yaw 30, pitch -35 /
    yaw -120, and pitch 40 / yaw 150.
  - `getLaunchPower` on the same component equals the engine's power (1).
  - A simulated player's pitch goes back to 0 every tick: `tp`'s pitch does not stay, and `simulateLookAt` has no
    address. So the step writes yaw and pitch through `getRotation()` in the same call, and checks that the engine's
    direction really has the sign of `-sin(pitch)`.
- **`shoot`.** bdsx's own `shootProjectile` returns a `minecraft:snowball`, and the hook sees bdsx's arguments unchanged.
  With a null player it returns null.
  - The flight check could not read the snowball 120 ms later: its wrapper was already decayed. That is recorded as
    INFO. The direction argument's meaning rests on the engine's own call above.
- **`launch`.** `bdsxprobe:throw` has scale 1, launch_power_scale 1.5 and max 2.5, read from the engine's tag. The
  results: (0,20,10) 0.625, (0,20,40) 1.5, (10,20,10) 0, (0,20,20) 1.5. The snowball (scale 0) gives 1 for all four.
- **`repair`.** `bdsxprobe:repair`, with Damage 60 set through save/load (`setDamageValue` has no address on 1.26):
  - Diamond ×1 gives 35 with 1 used. ×3 gives 0 with 3 used. ×5 gives 0 with 3 used.
  - A stick gives an empty stack and 0.
  - The inputs are unchanged each time.
- **`name`.** A named egg names a pig `"probe-placer-name"`; an unnamed one leaves the other pig's `""`. The call goes
  through the engine-built EntityPlacer component.
- **`food`.** `bdsxprobe:food`'s copy names `minecraft:bowl` (impl_ vft[3] `getFullName`), and the engine's tag writes
  `{"name":"minecraft:bowl"}`. The apple's copy has a null impl_, and the engine writes `{}`.

The first three pairs are not results. They failed on the probe's own mistakes, listed below; none was a bdsx or address
fault:
- the armor JSON;
- `setDamageValue`/`simulateDisconnect` with no address;
- NBT number wrappers read as truthy;
- a wrong impl_ walk (an access violation on the string `"minecraft"`);
- the simulated player not staying where it was put between console steps.

**Not run:** `getShootDir`'s vehicle branch (a riding player), and a non-zero angle offset, which the engine's only caller
never passes.

**Rules.**
- **A simulated player's rotation does not stay between steps.** Write it through `getRotation()` and act in the same
  call.
- **A behaviour pack is the way to get a component no vanilla 1.26 item holds.** Install it for one run and remove it in
  `finally`. `world_behavior_pack_history.json` is removed with it.


## 25. `ItemStack::clone`: out of line on both builds, and so are both copy constructors (2026-09-28, agent-x)

`?clone@ItemStack@@QEBA?AV1@XZ` had no address on either build, and neither had `ItemStack`'s or `ItemStackBase`'s copy
constructor. Unlike `ItemDescriptor` (section 23), all three are still out of line in 1.26. The decoration is unchanged
(`ItemStack clone() const`), so bdsx's binding (`procHacker.js`, the source in rcx, a 152-byte `new ItemStack(true)` as
the sret) is unchanged too: only the address was missing.

**How they were found.** There are 1,310 `lea` loads of `??_7ItemStack@@6B@` on 40 (1,306 on 51). For each one, take the
nearest `call` in the 32 bytes before it and count the targets. One target precedes 532 of them on 40 (540 on 51). It is
`ItemStackBase(const ItemStackBase&)`, 40 `0x1bbce30` / 51 `0x1a4f6c0`, 2024's `??0ItemStackBase@@IEAA@AEBV0@@Z`
(`0x1b48af0`) shape for shape:
- the `ItemStackBase` vptr, then 1.26's zeroing of the tail (section 8's layout);
- `block_` copied; if it is set and aux is `0x7fff`, `init(block)`, else `init(id, count, aux, false)` (`0x1bc1aa0`);
- `user_data_` through the `CompoundTag` clone into a local, then `setUserData`: a deep copy;
- `+0x24`/`+0x25` (show/was picked up) copied, then `_cloneComponents` and `_checkForItemWorldCompatibility`.

Among the functions that make that call and then store the `ItemStack` vptr, two are 94-100 B leaves. Both were read in
full on both builds:

| | 40 | 51 | body |
|---|---|---|---|
| `ItemStack(const ItemStack&)` | `0x1bbd390` | `0x1a4fbb0` | base copy (this, other), the vptr, the `ItemStackNetIdVariant` at +0x80 (index byte +0x90) zeroed and copied by the variant visitor (40 `0x1f457e0` / 51 `0x25474a0`) with index+1; 70 callers |
| `ItemStack::clone() const` | `0x1bbef20` | `0x1a51750` | the same with the registers swapped: rcx the source, rdx the sret; returns the sret. 2024's `clone` (`0x1b5a830`) instruction for instruction |

No other table name sits at any of these addresses. Only `clone` ships: it is the only one of the three bdsx names.

**Execution, both builds** (`clone40`/`clone51` through `verify-pair`, `tools/item-probe.ts` `itemprobe clone
<name|empty>`; 18 PASS / 0 FAIL each, tsc 0, exit 0, `Quit correctly`; `work/host-runs/clone40-20260928-021001.txt`,
`clone51-...`). Each run does `c1 = held.clone()`, then `c2 = c1.clone()`:

| held | both copies against the source | deep | 200 rounds |
|---|---|---|---|
| diamond sword, the console's `enchant sharpness 3` | this build's vptr, the same `Item*`, `minecraft:diamond_sword`, count 1, aux 0, id 318, net id `server:2`, and BDS's `save()` NBT equal, `tag.ench` `[9:3]` included | three different `CompoundTag` pointers; `setCustomName` on c1 reaches neither the source nor c2 | clean |
| 5 stone | the same, id 1, net id `server:3`, the `Block` compound, user data null in all three | a name on c1 creates c1's user data only | clean |
| empty hand | `isNull` in all three, count 0, net id `server:0` | `setCustomName` does nothing without an item | clean |

- c1 is destructed first, and c2 still reads the source's NBT; after c2 is destructed, the source still reads its own.
- A round is clone, clone, the full comparison, and two destructs.
- `layout40/51` was 27/27 after.

**Left open.**
- `ItemStack` has no `[NativeType.ctor_copy]` in bdsx, upstream included. So `ItemStack.construct(other)` and anything
  else that copies a stack through bdsx's generated field copy share `user_data_` with the source. That is a double free
  waiting to happen. Binding it to the copy constructor above (40 `0x1bbd390` / 51 `0x1a4fbb0`) would fix it. It is not
  a required name, so it is not in the table. **Done in section 26.**
- `cloneItem()` (deprecated) clones over a constructed air stack without destructing it first. That was upstream's
  behaviour too.

## 26. `ItemStack::fromDescriptor`: out of line on both builds; the descriptor's move is not (2026-09-28, agent-z)

`?fromDescriptor@ItemStack@@SA?AV1@AEBVNetworkItemStackDescriptor@@AEAVBlockPalette@@_N@Z` and
`??0NetworkItemStackDescriptor@@QEAA@$$QEAV0@@Z` had no address on either build. `fromDescriptor` is still out of line
with 2024's decoration and prototype, so bdsx's binding is unchanged and only the address was missing. The move
constructor is inlined everywhere and is now `derived()`.

**How `fromDescriptor` was found.** 2024's only callers are `InventoryTransaction::postLoadItems` (two calls) and the
three `Item*InventoryTransaction::handle`. Each 1.26 `handle` still builds its log line from literals, so
`tools/string-users.mjs <v> ", selectedSlot = " ", isSenderAuthority = " ", playerDistanceToBlockPos = " --any` gives the
three on each build (40 `0x258e130`, `0x2591460`, `0x2596380`; 51 `0x2a69040`, `0x2a6c4a0`, `0x2a71b60`). Near its top,
each makes one call with:
- rcx = a local sret;
- rdx = `&this->item_` (+0x88 on 40, +0x90 on 51, where Endstone's 51 header adds `HandSlot hand_`);
- r8 = the `Level` vftable's +0x2b0 (`getBlockPalette`, in the table);
- r9 = the `Level` vftable's +0x9e8 (the client-side flag, as 2024 passed it).

The target is **40 `0x1bbf280` / 51 `0x1a51b70`**. It has six call sites on each build: the three `handle`s, two in one
290-byte function (2024's `postLoadItems` had two), and a 102-byte wrapper that fetches the palette and the flag the same
way.

**The body** (read in full on both builds; the two differ only in `BaseDescriptor`'s slots, one later on 51 as section
23 found). It is 2024's `fromDescriptor` (`0x1b5dfb0`) with `ItemDescriptor::getId`/`_resolve` inlined:
- the runtime id from +0x38, and `&user data` = +0x40;
- `impl_`'s `shouldResolve`/`resolve`/destructor (+0x70/+0x78/+0x80 on 40), then `getItem` (+0x28) for the `Item*` and
  aux, and the id from `Item+0xaa`;
- `getItem<ItemStack>` (40 `0x1bdc860`) with 2024's argument order: sret, count (+0x10), aux, `Item*`, id, runtime id,
  `&user data`, palette;
- then the net id. With the flag set and a server id in the descriptor, it is re-made at `sret+0x80`; otherwise the
  variant is copied by the visitor (40 `0x1f457e0`), the one section 25's copy constructor uses. The sret is returned.

**The move constructor is inlined.** 2024's (`0x85ee90`) moves `ItemDescriptor` (takes `impl_`, nulls the source's),
copies the count, the `include_net_ids` byte, the variant and the runtime id, and moves the string. On 40, the functions
storing both `??_7ItemDescriptor` and `??_7NetworkItemStackDescriptor` that free nothing are the following:
- the **copy constructor**, 40 `0x2431a0` / 51 `0x2dbb80`. It clones `impl_` through its slot 0 and copies the string.
- a relocation, 40 `0x2734790`. It moves, then destroys the source.

Neither is a move. Both copy the variant member by member: the server id is an int at +0x20, and each client-id
alternative is a static vptr at +0x20 plus an int at +0x28. So a byte copy of the variant is the same thing.
`engine/itemdescriptor.ts` `networkItemStackDescriptorMove` works like this:
- writes the table's vptr;
- takes the other 0x58 bytes as they are;
- nulls the source's `impl_`;
- leaves the source an empty SSO string.

Nothing is allocated or freed.

**`ItemStack`'s `ctor_copy`** (section 25's leftover) is now the engine's `ItemStack(const ItemStack&)`, `??0ItemStack@@QEAA@AEBV0@@Z`
(40 `0x1bbd390` / 51 `0x1a4fbb0`, shipped). `ctor_move` goes through the same function, since a copy is a valid move.
Before this, bdsx's generated field copy shared `user_data_` with the source.

**Execution, both builds** (`fromdesc40`/`fromdesc51` through `verify-pair`, `tools/item-probe.ts` `itemprobe fromdesc
<name|empty>`; **27 PASS / 0 FAIL each**, tsc 0, exit 0, `Quit correctly`; `work/host-runs/fromdesc40-20260928-023141.txt`,
`fromdesc51-...`). `d = NetworkItemStackDescriptor.constructWith(held)`, then `ItemStack.fromDescriptor(d,
level.getBlockPalette(), false)`:

| held | `fromDescriptor(d)` against the held stack | move, then `fromDescriptor(m)` | `ItemStack.construct(held)` |
|---|---|---|---|
| diamond sword, the console's `enchant sharpness 3` | a new stack: this vptr, the same `Item*`, `minecraft:diamond_sword`, count 1, aux 0, id 318, net id `server:2`, BDS's `save()` NBT equal (`tag.ench [9:3]`), its own user data read back from the descriptor's 56-byte string | `m` has the table's vptr and `d`'s `impl_`, count, runtime id, variant and string; `d` has a null `impl_` and an empty string; the result equals the held stack again | equal, with a different user-data pointer; `setCustomName` on the copy stays on the copy |
| 5 stone | the same, id 1, net id `server:3`, the `Block` compound, runtime id `-2144268767`, 10 user-data bytes | the same | the same, user data null in both |
| empty hand | `isNull`, count 0, net id `server:0`, a null `impl_` in the descriptor | the same | the same |

- After each result is destructed, the source still reads its own NBT.
- 200 rounds per item ran clean. A round is descriptor, move, `fromDescriptor`, `ItemStack.construct` of the result, both
  compared, and four destructs.
- `layout40/51` was 27/27 after, and `engine-deps --missing` is empty.
- The first pair's transcripts were grepped for `[itemprobe]`, but the probe's tag is `[item]`, so `verify-pair` exited 1
  on "no probe line". The host log (`peek.ps1`) showed the same 27/0 on both builds. The rerun above is the recorded
  result.

**Left open.** bdsx binds `NetworkItemStackDescriptor`'s `ctor_copy` to
`??0NetworkItemStackDescriptor@@QEAA@AEBVItemStackDescriptor@@@Z`, which has no address; it is in `--list=unknown`.
The copy constructor above (40 `0x2431a0` / 51 `0x2dbb80`) is the candidate. **Done in section 27.**

**Rule.** **A function that lost its symbols can still be found through the log strings its callers build.** 1.26 kept
the `handle` diagnostics, and each diagnostic names its function's caller set.

## 27. `NetworkItemStackDescriptor`'s copy constructor: out of line on both builds, and upstream bound the wrong one (2026-09-28, agent-ab)

bdsx bound `NetworkItemStackDescriptor`'s `ctor_copy` to `??0NetworkItemStackDescriptor@@QEAA@AEBVItemStackDescriptor@@@Z`.
That name has no address on either build, so `construct(other)`, a field setter and a vector copy all threw.

**It was never a copy.** 2024 had both constructors:
- `(const ItemStackDescriptor&)` (`0x1b4a1e0`) builds an `ItemDescriptorCount` from the source's descriptor and stack size.
  It then stores the table, zeroes the `include_net_ids` byte, default-constructs the variant, zeroes the runtime id and
  leaves the string empty. So upstream's copies lost the net id, the block runtime id and the user data.
- `(const NetworkItemStackDescriptor&)` (`0x551160`, `??0NetworkItemStackDescriptor@@QEAA@AEBV0@@Z`) is the real copy:
  `ItemDescriptor`'s copy, the count, the byte, the variant's copy constructor, the runtime id, the string's copy.

No 1.26 address is known for the conversion. The class name `ItemStackDescriptor` does not appear in either 1.26 image
except inside `NetworkItemStackDescriptor`, and Endstone's headers declare no such class. That is not the `gone` bar
(1.21.3.01 has no such string either), and nothing needs it: bdsx never exposed the conversion, only misused it. It just
leaves the required set.

**The 1.26 bodies** (40 `0x2431a0` / 51 `0x2dbb80`, `.pdata` starts, both read in full with `disas-exact`; 65 direct
call sites each; no table name at either address). They are the same instruction for instruction, except the 51
allocation-failure path. Each is 2024's copy with `ItemDescriptor`'s copy inlined (section 23):
- `??_7ItemDescriptor` (40 `0xa55da30` / 51 `0xa64fef0`), then `impl_` cloned through `[[other.impl_]]+0` with rdx =
  `this+8`, or 0 stored;
- `ItemDescriptorCount`'s vptr (40 `0xa55da50` / 51 `0xa67d140`; 2024's COMDAT-folded name is `RecipeIngredient`),
  then the u16 count at +0x10;
- `??_7NetworkItemStackDescriptor` (40 `0xa55dbb0` / 51 `0xa67d120`), then the byte at +0x18;
- the variant member by member: index byte +0x30 set to 0xff, then index 0 copies the int at +0x20, and 1/2 store their
  static vptr at +0x20 and copy the int at +0x28 (the shape section 26 found in the relocation);
- the runtime id at +0x38, then the string at +0x40 (SSO, or an engine-allocator buffer);
- `rax = this`.

It ships as `??0NetworkItemStackDescriptor@@QEAA@AEBV0@@Z`. bdsx's `ctor_copy` is bound to it with the same prototype
(`procHacker.js`, void, `this` in rcx, the source in rdx).

**Execution, both builds** (`fromdesc40`/`fromdesc51` through `verify-pair`, `tools/item-probe.ts` `itemprobe fromdesc
<name|empty>` with a new step 1b; **36 PASS / 0 FAIL each**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/fromdesc40-20260928-025902.txt`, `fromdesc51-...`). `x = NetworkItemStackDescriptor.construct(d)` with `d =
NetworkItemStackDescriptor(held)`:

| held | `x` against `d` | `fromDescriptor(x)` | after `d` and its moved-to copy are destructed |
|---|---|---|---|
| diamond sword, `enchant sharpness 3` | the table's vptr; its own `impl_`, same `InternalItemDescriptor` vptr and `getFullName` `"minecraft:diamond_sword"`; count 1, byte 0, `server:2`, runtime id 0; 56 user-data bytes equal, in its own heap buffer | the held stack (`Item*`, name, count, aux, id, net id, `save()` NBT) | still the held stack |
| 5 stone | the same, `"minecraft:stone"`, count 5, `server:3`, runtime id `-2144268767`, 10 bytes (SSO) | the held stack | still the held stack |
| empty hand | `impl_` null in both, count 0, `server:0`, empty string | the held (null) stack | the same |

- 200 rounds per item ran clean. A round is descriptor, copy, move, `fromDescriptor` of the moved-to one, the `ItemStack`
  copy, then (after the source and the moved-to one are destructed) `fromDescriptor` of the copy, all compared, seven
  destructs.
- `layout40/51` was 27/27 after, and `engine-deps --missing` is empty.

**Rule.** **An upstream binding of a copy slot is a claim to check, not a fact.** Upstream's `ctor_copy` pointed at a
conversion that dropped half the object, and no 2024 run would have shown it unless the copy's fields were compared.

## 28. `InventoryTransaction` reads: `getActions` is inlined, `addItemToContent` is not (2026-09-28, agent-ac)

`InventoryTransaction.getActions(source)` and `addItemToContent(item, count)` had no address on either build, so every
plugin reading a transaction (bdsx's own `playerDropItem` hotbar path included) threw.

**The 2024 bodies.**
- `getActions` (`0x1bd2c10`) looks the source up in `actions_`, a `std::unordered_map<InventorySource,
  std::vector<InventoryAction>>` at +0 (MSVC: list sentinel +8, count +0x10, buckets +0x18 as lo/hi pairs, mask +0x30).
  The hash is `(type << 16) ^ (int8)containerId`. It walks the bucket from hi through `prev`, returns `node+0x20`, or a
  static `emptyObject`. Its only callers are the three `Item*InventoryTransaction::handle`.
- `addItemToContent` (`0x1bcbea0`) walks `content` (+0x40, 0x18-byte groups: id, aux, tag, count +0x10, overflow +0x14),
  adds to a group with the same id/aux/user data or pushes a new one. Its callers are `addAction` (three calls) and
  `ComplexInventoryTransaction::handle`.

**1.26: `getActions` is inlined on both builds.** The static empty vector (40 `0xa691560` / 51 `0xa7c8390`) is referenced
only from the three `handle`s (section 26's addresses), which inline the lookup for `{0,0,0}` (bucket 0, the key compared
by type and container id). There is no out-of-line copy.

**`InventoryTransaction::addAction`** (40 `0x258cbb0` / 51 `0x2a67320`, 1608/1577 bytes, the same code except the
allocation-failure path) is the one function in that `.obj` range computing the hash against the mask at +0x30. Read in
full, it gives the map on both builds:
- the node is 0x38 bytes: next +0, prev +8, key +0x10 (first 8 bytes, then flags at +0x18), vector +0x20;
- insertion links before the bucket's node and increments the count at +0x10;
- **1.26's key equality is per type**, through two jump tables: `ContainerInventory` (0) and `NonImplementedFeatureTODO`
  (99999) compare the container id byte, `GlobalInventory` (1) and `CreativeInventory` (3) the type only,
  `WorldInteraction` (2) the flags, and any other type is never equal. 2024 compared the container id for type 0, nothing
  for type 1, and found nothing otherwise;
- the elements are 0x200 bytes; `from` is at +0xd0 and `to` at +0x168 (counts read at +0xf2/+0x18a). bdsx's declared
  layout already gives that, because `ItemStack` is 0x98 (`layouts.ItemStack.size`); the stale 2024 offset comments in
  `inventory.ts` are replaced;
- its tail calls one function three ways, `(this, &from, -count)` and `(this, &to, +count)`: that is `addItemToContent`.

So `getActions` is `derived()` (`engine/invtransaction.ts`). It walks the list, not the buckets, so it needs no hash, and
compares keys with 1.26's equality. A source the map lacks gives an empty vector. `addAction` itself ships under its 2024
name for the probe's hook; bdsx does not bind it.

**`addItemToContent` is out of line** (40 `0x258d300` / 51 `0x2a67d80`, 585 bytes each, identical). Its only callers are
the three in `addAction`. It is 2024's body with `getId` (the valid byte +0x23, `Item+0xaa`), `getAuxValue`,
`isStackedByData` (Item vftable +0x118) and the user-data compare inlined. It keeps the prototype (void, this, `const
ItemStack&`, int), so bdsx's binding is unchanged; only the address was missing.

**Who builds a transaction on the server.** `InventoryTransactionManager::addAction` (40 `0x258db20` / 51 `0x2a68a50`) is
called from `Player::drop`, `take`, `setArmor`, `setOffhandSlot` and `inventoryChanged`. `Player::drop` adds
`{WorldInteraction, -1, randomly}`, slot 0, from `EMPTY_ITEM` to the stack. `inventoryChanged` adds `{Container, 0, 0}`
with the slot's old and new stacks. So a simulated player's give, drop and clear make the engine build real transactions.

**Execution, both builds** (`invtx40`/`invtx51` through `verify-pair`, `tools/block-probe.ts` with `INVTX_PROBE=1`;
**40 48 PASS / 0 FAIL, 51 40 PASS / 0 FAIL**, tsc 0, exit 0, `Quit correctly`; `work/host-runs/invtx40-20260928-041255.txt`,
`invtx51-...`). A bdsx hook on the engine's `addAction` calls the original, then, while armed, checks the transaction:

| check | what came back |
|---|---|
| the map, walked by the probe | 11 (40) / 9 (51) engine calls. `give` makes `{3,-1,0}` + `{0,0,0}` pairs, `Player::drop` `{2,-1,0}`, simbot's death drops `{2,-1,1}`, `clear` container removals. The walked count always equals the count at +0x10 |
| `getActions(added source)` | a copy of the added action at another address: source, slot, from and to (`minecraft:dirt x5`, `minecraft:stone x3`, empty) read back. One key held two actions (51, run 2) |
| every key the map holds | found at its own node's vector (+0x20), non-empty |
| sources the map lacks | nine per call (`{0,0,0}`, `{0,119,0}`, `{0,-1,0}`, `{1,0,0}`, `{2,-1,0}`/`{2,-1,1}` against the other flag, `{3,0,0}`, `{99999,0,0}`, `{-1,0,0}`, `{100,0,0}`), all empty |
| `addItemToContent` on the drop's transaction | the dropped dirt merged into the engine's own group: `[3:0:5]` +3 -> `[3:0:8]` -3 -> `[3:0:5]`. A `constructWith` diamond appended `{306, 0, 2, no tag, no overflow}`, then was removed. The engine carried on with the transaction |
| `InventoryAction` layout | `from` +0xd0, `to` +0x168, size 0x200 |

- `layout40/51` was 27/27 after, and `engine-deps --missing` is empty.
- Two earlier pairs are not the result. Both came back clean (tsc 0, exit 0), each with a probe error:
  - The first compared the merge against `toArray()` views, which the call itself had changed (1 FAIL each).
  - The second assumed simbot's slot 1 held a stack the content lacked. On 51, simbot's inventory had already gone to
    death drops before `simact drop` (1 FAIL).
  The engine-side values were right in both.

**Left open.** `?getItemInstance@InventoryTransactionItemGroup@@QEBA?AVItemStack@@XZ`
(`InventoryTransactionItemGroup.getItemStack`) is still in `--list=unknown`. **Done in section 29.** The hotbar path of `playerDropItem` (a
client's `InventoryTransaction` packet) still needs Q7, but its `getActions` call now resolves.

**Rule.** **A map lookup the compiler inlined is still readable in its writer.** `addAction` inserts into the same map, so
its body gives the node layout and the key equality that no reader kept. And 1.26 changed that equality from 2024's.

## 29. `InventoryTransactionItemGroup::getItemInstance`: out of line on both builds, 2024's body (2026-09-28, agent-af)

`?getItemInstance@InventoryTransactionItemGroup@@QEBA?AVItemStack@@XZ` had no address on either build, so
`InventoryTransactionItemGroup.getItemStack()` threw. It is still out of line with 2024's decoration and prototype, so
only the address was missing.

**How it was found.** 2024's only callers are `InventoryTransaction::forceBalanceTransaction`'s four. 1.26's
`forceBalanceTransaction` (40 `0x258bc20` / 51 `0x2a66390`, 1851 bytes) is the function that calls `addAction` four times
(section 28). It makes four calls to one callee, **40 `0x258c920` / 51 `0x2a67090`**. `tools/callers.mjs` gives exactly
those four sites on each build and no other. At each site, rcx is an element of `content` (0x18 stride, its count at
+0x10 tested first) and rdx is a local `ItemStack`. No other table name sits at either address.

**The body** (both builds read in full with `disas-exact`; they are the same instruction for instruction, apart from
addresses and the TLS slot offsets). It is 2024's `getItemInstance` (`0x1bd3920`) shape for shape:
- rcx is the group and rdx the sret. `ItemStack()` (40 `0x1bbccb0` / 51 `0x1a4ee60`) runs on the sret: the `ItemStackBase`
  vptr, the zeroed tail, `setNull`, the `ItemStack` vptr, and the net-id variant at +0x80 (index +0x90) zeroed. It
  writes up to +0x90, so it is the 152-byte stack of `layouts.ItemStack.size`.
- The `ItemRegistryRef` comes from TLS (2024 called `ItemRegistryManager::getItemRegistry`). Then `getItem` (40
  `0x152fe10`) runs with the **u16** id at +0 into a `WeakPtr<Item>`.
- If the item is live: `ItemStack(Item&, 1, aux, tag)` into a local (40 `0x1bba9f0`: the base constructor, then `init`
  with the tag). Its arguments are `r8d = 1` (a literal), `r9d =` the aux at +4 and `[rsp+0x20] =` the tag at +8. Then
  the `ItemStack` vptr, `ItemStackBase::operator=` (40 `0x1bbaf20`) into the sret, and the variant visitor (section 25's
  40 `0x1f457e0`) into sret+0x80. The local is destructed (40 `0x1bba1b0`).
- The `WeakPtr` is released, and the function returns the sret.

bdsx's binding was already `procHacker.js(..., ItemStack, { structureReturn: true })` with a 152-byte `new ItemStack(true)`
as the sret. Its `this` was typed `InventoryTransaction`, which was harmless (only the pointer passes), but it now names
the group.

**Execution, both builds** (`invtx40`/`invtx51` through `verify-pair`, `tools/block-probe.ts` with `INVTX_PROBE=1`;
**43 PASS / 0 FAIL each**, tsc 0, exit 0, `Quit correctly`; `work/host-runs/invtx40-20260928-043608.txt`,
`invtx51-...`). The section 28 hook on the engine's `addAction` now also calls `getItemStack()` on every group in
`content` after each engine call. The group's fields are copied out first.

| check | what came back (both builds) |
|---|---|
| every engine group, seven calls | `{3,0,-5}`, `{3,0,0}`, `{1,0,-3}`, `{1,0,0}`, `{3,0,5}`: each gives this build's `ItemStack` vptr, the group's id and aux, count 1, null user data. Its `getName()` equals the name the transaction's own actions hold for that id (`minecraft:dirt`, `minecraft:stone`). The group's count (negative, zero or positive) does not enter |
| 200 rounds | `getItemStack()` then `destruct()` on the first engine group, 200 times: 0 bad (id and count 1 each round) |
| a group of bdsx's own with a tag | id of `minecraft:diamond_sword`, aux 7, count 4, the tag = a named sword's user data: `minecraft:diamond_sword x1 aux 7`, its **own** `CompoundTag` (a different pointer) whose `save()` NBT equals the source's (`display.Name`, `Damage`). After it is destructed, the source's NBT is unchanged |
| id 0 | `isNull`, count 0, still the `ItemStack` vptr (the default stack comes back) |

- `invtx report` (7 calls, content and all three `getItemStack` checks tested) passed.
- `layout40/51` was 27/27 after, and `engine-deps --missing` is empty.
- This run saw 7 engine calls on each build (section 28's saw 11 and 9). Simbot's inventory differs from session to
  session, and every call's checks passed.

**Rule.** **A function's only caller set carries across builds when the caller is anchored.** Section 28 had already
named `forceBalanceTransaction` through `addAction`. Its one four-times callee was the whole search, and the body
confirmed it.
