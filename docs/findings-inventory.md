# A1: the class inventory (2026-09-23)

Phase A1 of `docs/plan-architecture.md`: every required name missing on either 1.26 build, plus every
`data/derived.json` entry, gets one of live / moved / absorbed / gone / unknown. **Static only**: nothing
here was executed, no bdsx code changed, and no table entry was added or removed.

```sh
node tools/entt-typenames.mjs work/bin/<v>/bedrock_server.exe --out=work/entt/typenames-<v>.json   # both builds, once
node tools/arch-inventory.mjs                 # -> data/arch-inventory.json, prints the counts
node tools/arch-inventory.mjs --list=unknown  # name, first bdsx site, hints
node tools/status-summary.mjs --write         # the counts go into docs/status.md's generated block
```

The counts are the generated block in `docs/status.md`, not typed here.

## 1. How a name gets its class

In this order (the first that applies wins):

1. **A hand verdict** in `data/arch-classes.json`: a full name or a unique prefix, the class, and the
   evidence with its findings-doc pointer. Only a hand verdict can say `gone`, and this pass wrote none.
2. **One build's table has it** → `live` (the function exists in 1.26; `missing` says where it is not).
3. **A `derived()` entry** → `moved` when it forwards the whole job to one other 1.26 function or vtable
   slot (`FORWARDERS` in the tool: `isSneaking` → `getStatusFlag(1)`, `sendArmorSlot` → the Mob slot,
   `PlayerInventory::*` → `FillingContainer::*`, the packet `getId`/`getName` thunks, ...); `absorbed`
   when it re-implements the body. `impl` records how: `layout`, `component`, `call`, `util`.
4. **A `bdsx:` key serves it** (`bdsx:Actor::hurt`, `bdsx:Mob::_hurt`, `bdsx:Player::setPlayerUIItem`)
   → `moved`: the 1.26 signature differs from the decorated name.
5. **Merged `unresolved`** (the game-thread lambda, inlined into `std::thread::_Invoke`) → `absorbed`.
6. **Endstone's `signatureChanged`** (`candidates-endstone-slots-<v>.json`: `knockback`, `startSleepInBed`)
   → `moved`.
7. **A vftable whose class Endstone defines with virtual members** → `live`.
8. **Endstone's `windows.h`** names it → `live`.
9. **Declared `virtual` in the matching Endstone release's class header** → `live`, with the declaration
   text in `evidence` so the prototype can be compared before anything is promoted. If the 2024 name is
   non-virtual (`Q`/`A`/`S` access code) the decoration cannot match → `moved` (`Spawner::spawnMob`,
   `spawnItem`).
10. Otherwise `unknown`.

Every entry also carries `hints` (not verdicts): an Endstone body or plain declaration, the class
missing from Endstone, an unshipped candidate address, the merge's argument-shape veto, a 2024 leaf
field access (`data/leaf-accessors.json`), and whether the class is an **EnTT type name** in that build
(section 3). `areas` in the output groups every name by first bdsx site file, then class, which is the
unit A2 and A3 work in.

## 2. Precision first: "Endstone does not declare it" is not a `gone` signal

The plan asked for the obvious pre-sort signal to be scored before use (section 4, rule 1). Population:
the required functions that **both** tables resolve by address, so every one of them is live.

| signal | live names it would call gone |
|---|---|
| the method is not declared (nor defined) in either Endstone release | **145 of 277 functions, 52%** |
| the class is not defined in Endstone at all | 13% |

Endstone's headers model what Endstone itself calls, not the engine. A coin flip is not evidence, so this
signal is a hint only, and nothing mechanical produces `gone`. (The tool prints the current rate as
`scoring` on every run.)

## 3. A better existence signal: the EnTT type names in the binary

`findings-components.md` ("The build carries the component names") found that 1.26 keeps EnTT type-name
strings (3,771 on 40, 3,990 on 51; 1.21.3.01 has none, so there is no before/after). A class in that list
exists in that build. It works as a **negative filter for `gone`**: if the class is listed, the concept is
there, whatever happened to one method. The tool matches a class against the full type name and against
its last `::` component, because some are namespaced (`SharedTypes::v1_20_50::FoodItemComponent`).
Of the twenty 2024 item components bdsx names, only three are listed under neither form on either
build: `Armor`, `KnockbackResistance`, `DyePowder` (section 7 settles the last two). *(Corrected
2026-09-23: the first version of this section also counted `Food` and `Shooter`, which are listed under
the `SharedTypes::v1_20_50::` namespace; a one-off exact-match check missed them, the tool did not.)*

Side result for queue Q1-3: `?tryGetFromEntity@SimulatedPlayer@@` looked for `SimulatedPlayerComponent`
(0 users). The type list spells it **`SimulatedPlayerFlagComponent`**: `fnv1a` `0xa83d07f5`, **9 users on
both builds** (`node tools/component-hash.mjs <v> SimulatedPlayerFlagComponent`). That is a lead, not a
promotion.

## 4. What the hand verdicts settled

`data/arch-classes.json` covers the unknowns the findings docs already had evidence for. The ones worth
knowing:

- **`moved`**: `Player::attack` (served as `bdsx:Actor::attack`); `ItemStackBase::canDestroySpecial` →
  `Item` slot 33; the three `use` names (Endstone comments out both `BlockType::use` overloads; the seam
  is `GameMode::useItemOn` or the block components, not chosen yet); `_sortAndPacketizeEvents` and its
  read lambda → the dispatcher swap and `_receivePacket`; `Block::onLightningHit`/`onProjectileHit` →
  their callers or the overriding `BlockType` slot (queue Q1-A item 1, a user decision);
  `HealthAttributeDelegate::change` (returns `std::optional<float>` in both Endstone releases);
  `printf` → the ucrt import `__stdio_common_vfprintf`, present in all three builds' import tables.
- **`absorbed`**: `std::_Allocate` (msAlloc on ucrt `malloc`), the `UpdateAbilitiesPacket` constructor
  (the A3 packet builder), `hasDimension`/`isUsingItem` (inlined field reads, candidates held back),
  `BlockActor::getType`, `Block::getDestroySpeed` (hardness at Block+0xb4), `Packet::handle` (one slot
  call), the two constants with no extraction, and the two `bdsx:` command enum names scrape-symbols
  picks up (`net-hud.ts`), which are not engine names at all.
- **`live`**: `levelCleanupQueueEntityRemoval` (the slot is the open question, not the function),
  `SurvivalMode::destroyBlock` (exists as two `.pdata`-less leaves, so not through the gated route), and
  the eleven gap-agreement candidates `findings-gaps-agree.md` listed as an execution queue.

## 5. The plan's one `gone` example is `absorbed`

`plan-architecture.md` and the queue cited the hurt-time field as the model `gone`. The sweep in
`findings-layouts.md` ("The hurt-time component") shows the **synched data item 11** is gone, but the
hurt time itself moved into `MobHurtTimeComponent` behind `Mob+0x428`, and `setHurtTime` ships as a
`derived()` writing it. By the plan's own definitions that is `absorbed`. Both docs are corrected. The
lesson belongs to the evidence bar: a sweep that shows a *storage* gone does not show the *concept* gone.

## 6. What this means for A2 (first pass; superseded by section 9)

**No name meets the `gone` bar yet**, so A2 has nothing to drop. The remaining unknowns are not
searches that failed: most have never been looked at. They are concentrated (by class: `ItemStackBase`,
`StructureSettings`, `SimulatedPlayer`, `Block`, `NavigationComponent`, `Scoreboard`, `Dimension`; by
file: `bds/implements.ts` far ahead of `bds/command.ts`, `launcher.ts`, the event files). The cheapest
evidence per area, in order: the EnTT type list (rules `gone` out), the component identifier or command
strings in the image, the Endstone header, then the 2024 body read against those.

## 7. A1-b: the scrape counted comments, and the first `gone` (2026-09-23)

**Twenty-nine "required" names were only ever in comments.** `tools/scrape-symbols.mjs`'s catch-all
regex read the raw text, and upstream parks dead calls as `// procHacker.js("?...")` (the
`StructureSettings` accessors under a `// deleted` banner, the `DyePowder`/`KnockbackResistance`
item-component lines, ...). The catch-all now reads the text with every comment blanked, using comment
ranges from the parsed tree (a raw `ts.createScanner` pass loses its place at the first regex literal and
blanked only 11 of the 29). Checked two ways: an independent scan of all 222 files for names whose
every occurrence sits in a comment gives the same 29, and the re-scrape removes exactly those 29 and adds
none. The committed list was also two names behind the source (`?clearRegion@NetworkChunkPublisher@@`,
`?getDescriptor@ItemStackBase@@`, both used by recent `derived()` work); the re-scrape picks them up.
Re-merging both builds with the new list leaves `data/symbols-<v>.json` identical in all four sections
(symbols, layouts, accessors, constants), so nothing that runs on the host changed. The coverage block
in `docs/status.md` moved because its denominator did.
**Same rule for error messages (2026-09-28).** `engine/itemdescriptor.ts` throws
`Error("??_7ItemDescriptor@@6B@: no address in this build")`, and the catch-all took each message as a
required name (two phantom names, both classed `live`). The scraper now also blanks the string-literal
arguments of any `Error`/`TypeError`/`new ...Error(...)` call; the re-scrape removes exactly those two and
adds none, and both shipped tables are unchanged.

Hand verdicts on names that left the set are kept in `data/arch-classes.json` with `notRequired` and
listed under `notRequired` in the inventory, not counted in the classes. Among them are **the first five
names that meet the `gone` bar**, the whole of two classes:

| class | 2024 PDB | 1.26 EnTT type list | Endstone | identifier string |
|---|---|---|---|---|
| `DyePowderItemComponent` | **no symbol at all** (siblings: 139-158 each, incl. every `??_7`) | absent on both | absent | `minecraft:dye_powder` absent from all three images |
| `KnockbackResistanceItemComponent` | **no symbol at all** | absent on both | absent | `minecraft:knockback_resistance` survives, but it is `SharedAttributes::KNOCKBACK_RESISTANCE`'s name (in the 2024 PDB) |

That is evidence (b) of plan section 4: everything the name touches is missing, and the class was gone
before the last PDB-bearing build. bdsx's calls were already commented out upstream, but
`bds/item_component.ts` still exports both classes and their `isDyePowder()`/`isKnockbackResistance()`
tests. That TS surface is what A2 drops.

The same check turned up four names bdsx referenced under a decoration the 2024 PDB does not have
(bdsx was already calling them dead in 2024). All four are `moved` and now `notRequired`:
`simulateNavigateToEntity`/`ToLocation` (2024 returns `ScriptModuleGameTest::ScriptNavigationResult`),
`sendActorCarriedItemChanged` (2024 dispatches `ActorCarriedItemChangedEvent` through `sendEvent`), and
`NetworkConnection::receivePacket` (2024 has the overload without `NetworkSystem&`). The tool now hints
"not in the 1.21.3.01 PDB" for any name `data/baseline-1.21.3.01.json` lacks.

## 8. A1-b: class by class (2026-09-23)

Every verdict is in `data/arch-classes.json` with its evidence. Method per class: the 2024 body (size,
callees, data refs, first instructions from `tools/disas-exact.mjs 1.21.3.01`), then the Endstone 1.26
header, the EnTT type list and image strings for the role. Two new rules came out of it:

- **A 2024 one-line forwarder is `moved` to what it forwards to**, when Endstone's 1.26 header still
  declares that target. Seven `ItemStackBase` getters jump through `item_` into an `Item` virtual
  (`getAttackDamage`, `getEnchantValue`, `getMaxDamage`, `isGlint`, `isPattern`, `isLiquidClipItem`,
  `isStackedByData`), and seven `Block` methods go through the `BlockLegacy` at `Block+0x30` into a
  `BlockType` virtual (`attack`, `getComparatorSignal`, `getDirectSignal`, `getVariant`,
  `hasComparatorSignal`, `isSignalSource`, `asItemInstance`). The slot is read by name from Endstone,
  never by the 2024 index.
- **`unknown` with `notGone`**: the role demonstrably exists in 1.26, but whether a callable function
  survives is still an address search (e.g. `ItemStackBase::hurtAndBreak`, 963B in 2024, with the
  `Unbreakable` key in both 1.26 images). A2 must not touch these; the status block counts them.

| class | outcome |
|---|---|
| `StructureSettings` | the accessors bdsx still calls are 2024 leaf field accesses; class listed in both type lists, `/structure` option strings survive, 40 keeps four siblings out of line → `absorbed` (the twelve commented-out ones are `notRequired`) |
| `NavigationComponent` | all sixteen are leaves or one-call forwarders (the navigation object at +0x60 and its vft[4]/[9], the `Path` at +0x68, `FOLLOW_RANGE`) → `absorbed` |
| `SimulatedPlayer` | its virtuals are named in both merged tables and every gametest verb bdsx wraps is a string in both images → `live` (18); `tryGetFromEntity` → `absorbed` on `SimulatedPlayerFlagComponent` |
| `ItemStackBase` | 7 Item-virtual forwarders + `setDamageValue` + `startCoolDown` → `moved`; bitfields `explodable_`/`fire_resistat_`, name tests, CompoundTag lore/enchant work, Endstone-bodied ones → `absorbed`; `hurtAndBreak`, `save`, `load` → `unknown`, not gone |
| `Block` | 7 BlockType-virtual forwarders + `popResource` + `getDescriptionId` → `moved`; field reads and Endstone-bodied ones → `absorbed`; `canHurtAndBreakItem`, `onFallOn` → `unknown`, not gone |
| `Scoreboard` | Endstone implements six of them in `world/scores/scoreboard.cpp` and declares the other four → `absorbed` |
| `Dimension` | moon/sun/time/isDay/nearest-player distance are formulas or one field → `absorbed`; four real bodies → `unknown`, not gone |

`ArmorItemComponent` stays `unknown`. 2024 had it as a legacy shell (three symbols: the vftable, the
EnTT resolve, the cereal bind), and 1.26 lists no such type, but `minecraft:armor` is still a string
in both images and bdsx's live code maps its vftable (`implements.ts`). What owns `minecraft:armor` in
1.26 is the open question.

## 9. What this means for A2

A2 has its first input: the two `gone` item-component classes (A1-c, section 11, adds none). Their calls are already dead, so the
drop is the TS surface in `bds/item_component.ts`, plus a `data/dropped.json` record. Everything else is
either placed (`live`/`moved`/`absorbed`), marked not gone, or still unexamined. The unexamined
remainder is led by free functions and then `CommandSelectorBase`, `BlockUtils`, `BlockLegacy`,
`LevelChunk`, `CommandOutput`.

## 10. A2: the first drop (2026-09-23)

The two classes from section 7 are gone from bdsx (revival commit `d94d77be`): `DyePowderItemComponent` and
`KnockbackResistanceItemComponent` with their `isDyePowder()`/`isKnockbackResistance()` tests in
`bds/item_component.ts`, and the five dead comment lines in `bds/implements.ts`. The knockback-resistance
**attribute** (`common.ts` `AttributeName`, `attribute.ts` id 9) is a different, live concept and stays.
`data/dropped.json` records each decorated name with the API that went with it; `status-summary` prints
the count next to the required total. The re-scrape gives the same 1080 names (they had already left
with the comment fix).

Execution, both builds, bdsx's own code (`verify-pair.mjs`, sessions 2026-09-23 13:35-13:46):

| driver | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `layout` | 23 PASS / 0 FAIL, tsc 0, exit 0, `Quit correctly` | same |
| `sig` | entityHurt 6, entityKnockback 6, playerDimensionChange 2; exit 0, `Quit correctly` | entityHurt 7, entityKnockback 6, playerDimensionChange 2; same |
| `pk` | 16 PASS / 2 FAIL (`authinput-bits`, `entitySneak`: the pre-existing pair that needs `BP_AUTH_INPUT`, `findings-packets.md`), exit 0, `Quit correctly` | same |

No boot line on either build mentions the dropped names. Note for the next person: `pk`'s tag is
`[pktprobe]`, and `session.mjs` keeps only `--grep` matches in the local transcript. A wrong tag gives a
clean-looking empty count, so read the host log with `peek.ps1` when a count comes back 0.


## 11. A1-c: free functions and the next five classes (2026-09-23)

Static only: nothing executed, no bdsx code changed, no table entry added. Every verdict is in
`data/arch-classes.json`; this section is the method and what is worth knowing. Scope: the unknowns of
`CommandSelectorBase`, `BlockUtils`, `BlockLegacy`, `LevelChunk`, `CommandOutput`, `ArmorItemComponent`
and every class-less one (templates, `std`, CRT, free functions). None is left `unknown` without a
reason; **none is `gone`**.

### A new existence signal: lambda scopes and `pretty_function` types

`tools/image-names.mjs <v>` → `work/entt/image-names-<v>.json` reads two string families off the image.

- **Lambda scopes.** RTTI is off for BDS's own classes (`findings-survey.md`), but a lambda stored in a
  `std::function` still gets a type descriptor, and MSVC names the lambda after its enclosing function:
  `.?AV<lambda_47>@?0??newResults@CommandSelectorBase@@IEBA?AV?$shared_ptr@...@Z@`. The scope is the
  **full decorated name**, so it proves the function exists in that build's source with exactly that
  signature (not that an out-of-line copy exists: the function may be inlined into every caller).
  1.21.3.01 has 49 of them, 1.26.40.8 3,830, 1.26.51.1 4,060. Precision: the three names Endstone marks as
  changed signatures (`knockback`, `startSleepInBed`, `changeDimension`) never appear under their 2024
  decoration; 12 names in our merged tables do appear. Yield on the required set is small (5 names, one
  already shipped: `WeatherManager::updateWeather`), but it settles four as `live` with no hand work:
  `CommandSelectorBase::newResults`, `ActorEventCoordinator::sendActorCreated`,
  `ServerInstanceEventCoordinator::sendServerThreadStarted`, `CommandOutputSender::sendToAdmins`.
  `tools/arch-inventory.mjs` now applies it as the last mechanical rule (source `lambda-scope`).
- **`pretty_function() [Type = X]`**: 11,129 / 11,687 type names, a superset of the type-info scan
  (section 3) for existence. It names `DamageSensorComponent`, `ShooterComponent` and `ArmorItemComponent`,
  which the type-info scan misses. Hint only.

### What was settled

| group | outcome |
|---|---|
| `Actor::tryGetComponent<T>` (12) | 11 `absorbed` (component): the 2024 body is the inlined registry lookup, and each `fnv1a(T)` has 6-306 users on both builds (the `UserEntityIdentifierComponent` `derived()` is the pattern). **`PushableComponent` is `moved`**: 1.26 split it into `PushableByEntityComponent` (13 users) and `PushableByBlockComponent` (6); `fnv1a("PushableComponent")` has 0 users and neither string list names it. `minecraft:pushable` and the two `push()` members need remapping (**done 2026-09-30**: bdsx now exposes the pair, `findings-components.md` "Pushable: the 1.26 split") |
| `CommandOutput` (9) | Endstone's 1.26 layout (type +0, data_ +8, messages_ +16, success count +40) is exactly what the 2024 constructor zero-fills → ctor, dtor, `success`, the five `set<T>` (Json::Value in the property bag, only for `DataSet`) `absorbed`; `error` `moved` to `addMessage(..., Error)` (ships on 51 only) |
| `LevelChunk` (8) | `getMin/getMax/getPosition` at +96/+108/+120 in both 2024 and Endstone's 1.26 layout; `toWorldPos`, `getEntity`, `getChunkEntities`, `isFullyLoaded` `absorbed` (the last two read offsets past Endstone's modelled layout); `getBiome` `unknown`, not gone (lead: Endstone's `BlockSource::getBiome(BlockPos)`) |
| `BlockLegacy` (8) | 1.26 calls the class **`BlockType`**, which is why the mechanical Endstone rules missed it. `asItemInstance` `live` (a `BlockType` virtual); `tryGetStateFromLegacyData` `moved` to `?tryGetStateFromLegacyData@BlockType@@QEBAPEBVBlock@@G@Z`, **40 `0x1ee8230` / 51 `0x1a21750`** from Endstone's `windows.h`; the rest `absorbed` on Endstone's layout (`creative_category_` +352 and `block_entity_type_` +353 are one byte now, 4 in 2024; no destroy-time field on the type, hardness is per `Block` +0xb4) |
| `BlockUtils` (8) | all `absorbed` (util): name, state and material predicates plus one height formula. The class lives (`isFullFlowingLiquid` ships on both) |
| `CommandSelectorBase` (8) | `newResults` `live` (lambda scope); `getName`/`hasName`/`setType`/`setIncludeDeadPlayers` `absorbed` (2024 field writes, 1.26 offsets unmeasured); ctor, dtor, `filter` `unknown`, not gone: selectors work in every session, and both images carry eight `add*Filter` decorations of the class as lambda scopes |
| the other class-less names (13) and `ArmorItemComponent` | see below |

Free functions and templates:

- **`std::getline<char>`**: `live`, candidate **40 `0x1135c0` / 51 `0x110700`** (435B, the same instruction
  sequence on both builds modulo addresses): `_Ipfx(true)`, clear the string, `sgetc`, a loop against the
  `r8b` delimiter, `snextc` through a register loaded from its import slot. That is why
  `tools/iat-refs.mjs` shows 0 direct calls of `snextc` in 1.26. Not shipped.
- **`BedrockLogOut`**: `moved`. The one function that references `"!!! ERROR: Unable to format log"` (unique
  in all three images) is 40 `0x1c35a0` / 51 `0x263d70`. It has one caller, spills only r8/r9, and passes a
  **constant `"%s"`** to `__stdio_common_vsprintf`. 2024's only caller passed `"%s"` too, so the format
  parameter was constant-propagated away: priority in ecx, message in r8, rdx dead. bdsx's `logHook` reads
  rdx as the format and must change before this can be hooked.
- `parseEnum<E>`: `moved`. 2024 folds every 4-byte instantiation into one body, and bdsx's `selectMore()`
  already relies on that. `parse<std::string>` and `CommandRegistry::Parser` ctor/dtor: `unknown`, not gone.
  The lead for the parse pair: read the parse pointer from a registered parameter at
  `registerOverloadInternal`.
- `Json::Value::operator[](int)` `moved` to `operator[](unsigned)` (ships on both); `operator[](const char*)`
  `unknown`, not gone (bdsx needs the reference, so the shipped `get()` copy does not serve).
- `mce::Blob` ctor/dtor, `CreativeItemCategoryFromString`, `_Ref_count_obj2<bool>`'s vftable: `absorbed`.
- **`ArmorItemComponent`** (the open question from section 8): the class is still in both 1.26 images
  (pretty_function, the cereal loader, and the `ArmorItemComponentVersioning::UpgradeTo12020` lambdas). It
  was already deprecated in 2024, and the upgrade moves an old `minecraft:armor` into
  `minecraft:wearable`'s protection (`WearableItemComponent`). `unknown`, not gone: the vftable is a search.

### Two things to keep

- **The Endstone `windows.h` values are decimal. Convert them with a tool.** A hand conversion put
  `tryGetStateFromLegacyData` in the middle of a string setter. `node -e 'console.log((32408112).toString(16))'`
  gives the `.pdata` start. This is rule 6 again.
- `data/candidates-gaps-1.26.51.1.json` names `0x1a21750` `LegacyStructureTemplate::_mapPropertyToExtraBlock`,
  which contradicts Endstone's exact table. It was never merged, but it is a gap-agreement error in the wild.

## 12. A1-d: eight more classes, and a sweep for `gone` (2026-09-23)

Static only, same method as sections 8 and 11. Verdicts are in `data/arch-classes.json`.

**The eight classes** (`Actor`, `MobEffectInstance`, `ContainerComponent`, `ItemStack`, `StructureTemplate`,
`ChestBlockActor`, `BlockActor`, `Player`): every one of the 43 names has a verdict, and none is `gone`.
Worth knowing:

- **1.26 restructured `BlockActor`.** Endstone's 1.26 `BlockActor` is a 48-byte base (position +8, type +20,
  and three component pointers) with only the destructor virtual. `VanillaBlockActor` adds three interfaces
  (`IVanillaMain/Render/TickBlockActorComponent`), each with its own vtable. `getContainer`,
  `get/setCustomName` (now `RedactableString`) and `setChanged` live on the main interface. So
  `ChestBlockActor::getContainer` and the custom-name pair are `moved`, `setChanged` is `absorbed`
  (`properties_` +76, bit `Changed`), and `save`/`getServerUpdatePacket` stay `unknown`, not gone.
- `ItemStack::getDestroySpeed`/`use`/`useOn` are forwarders into `Item` virtuals (`getDestroySpeed`, `use`,
  `_useOn`, the last two shipping on both builds). The `ContainerComponent` trio forward to the `Container`
  at +0x10, and `Container::addItem`/`getSlots`/`getEmptySlotsCount` ship on both builds → `moved`.
- `MobEffectInstance::getAmplifier` is the +0x20 field already confirmed by execution
  (`findings-layouts.md`), so it is `absorbed`.
- `Actor::canSee`×2, `fetchNearbyActorsSorted` and `isInClouds` are compositions over Endstone-declared
  `BlockSource::clip`/`fetchEntities` and a Dimension virtual → `absorbed`. `canAttack` stays `unknown`:
  Endstone comments it out of the 1.26 Actor vtable.

**The sweep** (`node tools/arch-gone-sweep.mjs`): for every class that still has a name with no reason,
list every existence signal for the class. The signals are the type-info list, `pretty_function`, the
class inside any mangled name in the image, our merged tables, and Endstone. Twenty-one classes had none,
and every one of them turned out to be live by its role string. Examples: "TickingArea" appears 72 times
per 1.26 image, `commands.help.description` exists, and so do the `freeze_on_hit`/`potion_effect` keys,
"OnFire" and "PlayerMovement". Others are RakNet types, or namespaces of free functions with no string
footprint at all (`ExtendedCertificate` is in no image, 2024 included). They are now `unknown` with a
`notGone` reason. **The inventory has no `gone` candidate left, so A2 has no input.** What remains
`unknown` without a reason is classes that do show a signal, where the open question is an address, not
existence.

The sweep found one change worth recording. 1.26.51.1 moved projectile on-hit subcomponents to data-driven
definitions (`SharedTypes::v1_26_50::FreezeOnHitSubcomponentDefinition` and siblings, with pretty_function
and cereal schema strings). 1.26.40.8 has no such names yet.

## 13. A1-c-x: the candidates, run (2026-09-23)

Each candidate from section 11 ran through bdsx's own code on both builds. Runs: `verify-pair.mjs`,
drivers `con40/51` and `lg40/51`, with exit 0 and `Quit correctly` on all four sessions.

| name | outcome |
|---|---|
| `bdsx:BedrockLogOut` (40 `0x1c35a0` / 51 `0x263d70`) | **shipped, confirmed.** `launcher.ts` writes `mov rdx,"%s"; jmp logHook` at the clone (revival `1858aa94`). Every boot line comes out in bdsx's colours (INFO `[97m`, the pack ERROR `[91m`), and a line BDS logs after plugin load (the ERROR for an unknown command) reaches `events.serverLog` with the right severity (`tools/console-probe.ts`, `conprobe`) |
| `?tryGetStateFromLegacyData@BlockLegacy@@` (Endstone's `BlockType` address, 40 `0x1ee8230` / 51 `0x1a21750`) | **shipped under the 2024 decoration, confirmed.** With the chunk held by a ticking area, `oak_log` with `pillar_axis` x / z / y comes back from legacy DataID **4 / 8 / 0** (the 2024 log encoding). Stone's DataIDs 0..6 give its seven variants and 7..15 the default. An unknown DataID gives the default state, not null (1.26 `BlockType` has `return_default_block_on_unidentified_block_state_`) (`legacyprobe`) |
| `ConsoleInputReader` ×4 + `std::getline<char>` | **not patchable.** The reader thread (40 `0xf3810` / 51 `0xf3580`: `GetConsoleMode`, `_setmode`, `std::wcin`) is passed straight to `_beginthreadex` from inside `DedicatedServer::start` (Endstone `windows.h`: 40 `0x7a760` / 51 `0x7a770`). The constructor is inlined there, with no copy to neuter. bdsx keeps BDS's own reader, and console commands work as they did. Taking stdin over needs Endstone's route: close stdin before `start`, then feed `ConsoleInputReader::console_input_` (an `SPSCQueue<std::string>`). That is engine-layer work, and `getline` has no consumer until it exists |

**`executeCommandOnConsole`, 2026-10-02.** The reader being out of reach had a second effect. `executeCommandOnConsole`
enqueues into the `commandQueue` that only the `getLine` patch drained, so on 1.26 it silently dropped every command.
`conx40/51` showed it: 0 of 2 objectives created, no `events.command`, no output. Without the `getLine` symbol, the
function now runs each command through `executeCommand` with output on. It does this from the node loop on the game
thread after `serverOpen` (`setImmediate`), where a dequeued line used to run (bdsx `8289eace`). The same drivers then
gave 6/6 on each build: the objective exists 3 s later, `events.command` fires once, and the output
(`Added new objective ...`) reaches `events.commandOutput`, the console printer. Typed console input is still BDS's
own reader.

Two things this turned up:

- **`Block.blockLegacy` was declared at 2024's +0x30.** So `block.blockLegacy` read garbage on 1.26,
  while `implements.ts` already used `layouts.Block.blockLegacy` (+0x68) internally. The field now takes
  its offset from the layout (revival `3ceb56fc`), and the `legacyprobe` calls go through it.
- **`Block+288` (`layouts.Block.data`) is not the legacy DataID.** For those same three log states it reads
  **0/1/2**, while the engine's own `tryGetStateFromLegacyData` maps them from **0/4/8**. The derived
  `ItemStackBase::getAuxValue` returns +288 for block items, on the premise that +288 is 2024's `data_`
  (+40). Its check read 0/0/1/2 and called that right, but nothing checked those numbers against the
  engine's DataID. Whether 1.26's inlined `getAuxValue` also reads +288 (making 1/2 the new
  semantics) or converts was open; section 14 settles it: +288 is what the engine reads.

## 14. The `getAuxValue` doubt, settled: +288 is the engine's aux value (2026-09-23)

Section 13 left open whether 1.26's own (inlined) `getAuxValue` reads `Block+288` or converts to the
legacy DataID. **It reads +288.** The shipped `derived()` is unchanged.

**Static, both builds.** A scan for `0x7FFF` with a `0x120` displacement within 40 bytes finds nine
sites on 40 and eight on 51, all the same five instructions:
`block_ && aux_ != 0x7FFF ? *(u16*)(block_+0x120) : aux_`. Two of them are in named functions:
`ItemStackBase::_setItem` (Endstone's exact table; 40 `0x1bc1f70` / 51 `0x1a546f0`), which is 2024's
`_setItem` (`0x1b54020`) with `block_+0x28` → `+0x120`, and a 20-caller two-stack compare that is
`ItemStackBase::isStackable(const ItemStackBase&)` (below). Endstone's source reconstruction says
the same (`return block_->data_`, `data_` at +288 in `block.h`).

**Executed, both builds** (`stack40`/`stack51`, `itemprobe stackaux`, exit 0, `Quit correctly`).
`isStackable(other)` compares the two stacks' inlined `getAuxValue()`, but only when the Item is
stacked by data (`Item::isStackedByData`, bit 2 of `Item+0x152`; 2024 `+0x14a`). A flattened log
has it clear (`+0x152 = 0x50`), so the first run answered `true` five times and proved nothing. With
the bit set for the trials only, two oak_log stacks with swapped `block_` (the y/x/z Blocks that
`tryGetStateFromLegacyData` gives for 0/4/8) and hand-set `aux_` gave:

| blocks | `aux_` | bdsx `getAuxValue()` | engine `isStackable(other)` |
|---|---|---|---|
| y/y | 0/0 | 0/0 | true |
| x/y | 0/0 | 1/0 | **false** (reading `aux_` would say true) |
| x/z | 0/0 | 1/2 | false |
| y/y | 5/0 | 0/0 | **true** (reading `aux_` would say false) |
| y/y | 0x7FFF/0 | 32767/0 | false (the wildcard branch) |

That is 9 of 9 in agreement on both builds, with both answers seen. So in 1.26, `Block::data_` is the
state-packed DataID the engine means by "aux" (oak_log y/x/z = 0/1/2). The legacy numbering 0/4/8
survives only as the upgrade table behind `tryGetStateFromLegacyData`. A plugin that wants the 2024
number has to go through that table in reverse; bdsx does not offer it.

**A bdsx bug found on the way: `isStackable`.** Upstream bound the no-argument `isStackable()` to the
one-argument decoration `?isStackable@ItemStackBase@@QEBA_NAEBV1@@Z`, so `other` was whatever rdx held.
The revival now binds both overloads, `isStackable()` and `isStackable(other)`, and both have
addresses:

- `isStackable(other)` (40 `0x1bc44f0` / 51 `0x1a56a20`): the body matches 2024's `0x1b654c0` step for
  step (item compare, `other.isStackable()`, `isStackedByData` slot `+0x108` → `+0x118`, the aux
  compare, `hasSameUserData`, then three u64 compares shifted by −8). All four of its named callers
  (`Container::hasRoomForItem`/`addItem`/`addItemWithForceBalance`, `FurnaceBlockActor::setItem`)
  are also 2024 callers.
- `isStackable()` (40 `0x1bc41a0` / 51 `0x1a566d0`): `getDescriptor` → Item slot 100 (`getMaxStackSize`)
  `> 1` → slot 14 (`isDamageable`) → the damage tag, the same as 2024's `0x1b65620`, and it is what the
  two-argument body calls on `other` at the point 2024 inlined it. Executed as `itemprobe stackable`:
  log true, sword false.


## 15. Keeping the hand verdicts current (2026-09-25)

`tools/arch-inventory.mjs` classifies only names that are missing on a build, plus every `derived()`
entry. A name that gets an address on both builds leaves that set, and the hand verdict keyed on it then
matches nothing, which makes the tool exit 2. Nothing ran the tool between 2026-09-23 and 2026-09-25, so 23
verdicts had gone stale by the time `?levelCleanupQueueEntityRemoval@Level@@` got flagged.

- **19 now resolve by address on both builds** (`isStackable`, `getOrCreate@StructureManager`, the six
  `SimulatedPlayer::simulate*`, `add/removeObjective`, the `MobEffectInstance`/`Actor`/`BlockActor`/
  `StructureTemplate` `save`/`load`, `fetchNearbyActorsSorted`, `inventoryChanged`, `startCooldown`,
  `onBlockInteractedWith`, `levelCleanupQueueEntityRemoval`). Their verdicts were deleted. The table says
  `live` now (`source: "table"`), and each name's evidence is in `data/resolved-<v>.json` provenance.
  Several of them had hand verdicts of `absorbed` or `moved` that bdsx carried before an address was found.
  Those verdicts were accurate when written, but the address overrides them.
- **4 left the required set** because bdsx binds a successor and no longer names the 2024 decoration.
  All four are now `moved` + `notRequired`, with the successor in `target`: `change@HealthAttributeDelegate`
  (the `optional<float>` override), `onFallOn@Block` (`bdsx:BlockType::onFallOnBase`), `pairWith@ChestBlockActor`
  (`bdsx:ChestBlockActor::pairWith`), and `doOnHitEffect@SplashPotionEffectSubcomponent`
  (`ThrownPotionEffectSubcomponent`). Each event was confirmed on both builds by the commit its evidence cites.
  So `notRequired` no longer means only "mentioned in comments". The tool's output and the status block say
  "outside the required set".

Rule: **`node tools/docs-check.mjs` now runs `arch-inventory --dry`** and fails on a stale verdict. When a
resolved name trips it, delete the verdict. When bdsx switched to a successor, mark it `notRequired` and
keep the evidence.

## 14. Actor `unknown` three (2026-09-30)

- `?setVariant@Actor@@` and `?getOwner@Actor@@` were already `derived()` in `bds/implements.ts` (findings-audit.md "Audit follow-ups",
  executed then) but had no `data/derived.json` entry, so `open-absorbed.mjs` still listed them. Entries added; `varprobe`
  (`tools/actor-layout-probe.ts`) re-ran them on both builds 2026-09-30 (`effdis40/51`, 8 PASS / 0 FAIL each): `setVariant` 0 -> 3 -> 11 ->
  0 read back through BDS's own `getVariant`, and a player's `getOwner()` null. The non-null owner was not re-run today.
- `?canAttack@Actor@@`: **done 2026-09-30, `absorbed`/`util`, `derived()`.** The virtual is gone from the Actor vtable: `setTarget` is slot 50
  in both 1.26 tables, and Endstone's `actor.h` (canAttack commented out) puts `setTarget` at declared index 49, one behind the real slot 50
  because slot 0 is not declared. Not `gone`: mob targeting exists. 2024 body (`0x19abf70`): null target -> false; `getStatusFlag(98 =
  PLAYING_DEAD)` true -> false; else `!ActorClassTree::isInstanceOf(target, 0xb29)`. **`0xb29` is Ghast** (`Ghast = 41 | Monster`, the
  ActorType enum in `bds/actor.ts`), so the base test is "not a ghast". 2024's `isInstanceOf` (`0x17fce00`) with a non-zero low byte only
  compares the low byte with `getEntityTypeId`, so 1.26 needs no `isInstanceOf`: the body is `getStatusFlag` (derived) plus `getEntityTypeId
  & 0xff !== 0x29`, both of which 1.26 already serves. 1.26's `hasType` (40 `0xde56e0`) is the same test over `ActorTypeComponent`. Executed
  (`cattack40/51`, `atkprobe` in `tools/actor-layout-probe.ts`, 7 PASS / 0 FAIL each): a player -> zombie and cow true, ghast false (its
  type id read `0xb29` on both builds; zombie `0x30b20`, cow `0x130b`, `happy_ghast` `0x1393`, which stays attackable), null false, a cow
  with PLAYING_DEAD set through `setStatusFlag` false and true once cleared. Caveat: this is 2024's *base* body; a 1.26 Mob subclass may
  override targeting rules no longer reachable by name, and bdsx does not call BDS's own copy.
- `mce::Blob` constructor and destructor, `Dimension::distanceToNearestPlayerSqr2D`: **done 2026-09-30, `absorbed`, `derived()`**
  (`a1misc40/51`, `blobprobe` + `dnpprobe` in `tools/misc-a1-probe.ts`, 16 PASS / 0 FAIL each). The Blob pair is 2024 `0x279a880` (store
  a deleter at +0, zero +8 and +0x10) and `0x279a980` (call `*this` on `this[8]` when non-null); bdsx stores the ucrt `free` (default
  deleter = `delete[]` = `free`, msAlloc's premise) in `engine/blob.ts`. Executed: constructed state, a counting deleter called once
  with exactly the malloc'd pointer, zero calls for null bytes. Not checked: that an engine-made Blob's deleter is that same `free`.
  `distanceToNearestPlayerSqr2D` (2024 `0x1f490d0`) is not a loop of its own: it zeroes the argument's y, then a `forEachPlayer` virtual
  (slot 9) with a lambda (`0x1f40600`: `(x-px)^2 + y^2 + (z-pz)^2` with that zeroed y, `minss` into a FLT_MAX-initialised result). So it
  is XZ-only and never subtracts the player's y; bdsx takes the minimum over `Dimension.getPlayers()`. Executed against hand-computed
  values (1080.5, 320908.5625, 0 for a point straight above the player; FLT_MAX for a dimension without players; 0.5 and 340450.5625 in the
  nether after the bot moved). `?canSee@Actor@@QEBA_NAEBVVec3@@@Z` was never open: 1.26 serves it as `bdsx:Actor::canSee` (closed
  2026-09-24, `findings-slots.md` "canSee"); `tools/open-absorbed.mjs` now skips a name whose `bdsx:` key both tables carry.

## 16. Ten `unknown` names, all `absorbed` over layouts (2026-09-30, agent-j)

`node tools/open-absorbed.mjs --class=unknown` listed 48; these ten now have `derived()` entries (`data/derived.json`) and ran on both
builds (`uk40/51`, `tools/uk-a1-probe.ts` `ukctx`/`ukcb`/`ukdmg`, 27 PASS / 0 FAIL each). None is `gone`: every one is a field access or an
entt walk whose 2024 body was read first, and 1.26 kept the fields.

- **EntityContext family** (`bds/engine/entitycontext.ts`): `_registry` (`EntityRegistry&` at +0), `_getEntityId` (+0x10, returned in a fresh
  4-byte buffer), `isValid`, and the optional-shaped storages' `OwnerStorageEntity::_getStackRef`, `StackResultStorageEntity::_getStackRef`,
  `_hasValue`. 2024: `_registry` `0x576d70` (`mov rax,[rcx]`), `_getEntityId` `0x2728ae0`, `isValid` `0x2728b20`, one shared
  `_getStackRef` `0x1046820` (`optional::value`: flag at +0x18, throw `bad_optional_access` if clear, else `this`), `_hasValue` `0x4d72f0`
  (`movzbl 0x18(%rcx)`). So an EntityContext is `{EntityRegistry& +0, entt registry +8 (= EntityRegistry + 0x30), id +0x10}` and a storage
  is that plus the flag at +0x18 (size 0x20, BDS's own `Level::getUsers()` element). Executed: `ctxbase +0 + 0x30 == +8 == actor +16`, the
  id equals the actor's +24 word, the live users storage has flag 1 / id = the bot and `_getStackRef` returns the same address, a copy with
  the flag cleared reports no value and throws. **`isValid` is entt `registry.valid(id)` over the entity storage's sparse pages at registry
  `+0xe0/+0xe8`** (2024's offsets, unchanged). A static hunt found 0x110/0x118 lookalikes (11-13 inlined copies per build); they were wrong
  (one build faulted, the other answered false for the bot). A runtime scan of the registry (`ukscan`: every aligned (begin,end) pair that is
  a page vector holding the bot's id with the right version and rejecting a bumped one) found exactly one pair, +0xe0, on both builds; lesson:
  an inlined-copy census picks the most common shape, not the right class. Then: true for the bot and a live pig; false for the bot id with a
  bumped version, an index past every page, `entt::null`, and the pig 4 s after `kill` (through a copy of its context words). Layouts:
  `EntityContext.{entityRegistry,enttRegistry,entityId,storageEngaged}`, `EnTTRegistry.entitySparse{Begin,End}` in
  `candidates-instances-<v>.json` (`engine-deps --missing` empty).
- **`CommandBlockComponent::getTicking` / `setTicking` / `resetCurrentTick`**: 2024 `0x577460` (`movzbl 0x9c`), `0x57a3e0` (store the flag; when
  it becomes false the count `+0x98` = 0 if `shouldExecuteOnFirstTick` (+0x94) else `getTickDelay` (+0x90)), `0x579ca0` (count = delay). 1.26's
  save reads ticking +0xc4 / count +0xc0 (section 15 of findings-nbt), so delay/first-tick sit at +0xb8/+0xbc; the engine's own
  `readAdditionalSaveData` with TickDelay 13 / ExecuteOnFirstTick 0 leaves exactly 13 and 0 there, on both builds. Executed against the
  engine's own `addAdditionalSaveData`: `setTicking(true)` saves Ticking 1 and leaves the count (5); `setTicking(false)` saves 0 and count 13,
  or count 0 with first-tick set; `reset` 5 -> 13. (First run failed because the probe's reload reset the delay to 0 -- a probe bug, not a
  wrong offset.)
- **`ActorDamageSource::setCause`**: 2024 `0x5bacf0` `mov [rcx+8],edx`; the 1.26 constructor bdsx builds already stores the cause at +8. Executed
  through BDS's own `Actor::hurt` on a cow: built with Contact, `setCause(Wither)`, `getLastHurtCause` -1 -> 15.

Left in the class (36 after the two siblings' closures): `ServerPlayer::_nextContainerCounter` (2024 `0xcc08d0`: a byte counter at +0x1e40,
`inc`, wrap 100 -> 1, return it; 1.26 has no lookalike of that exact byte pattern on either build, so find the field through a caller such as
`ServerPlayer::openInventory`), `NetworkSystem::_getConnectionFromId` (`layouts.NetworkSystem.connections` +160 and `NetworkConnection.id` +0
are known; the loop needs a NetworkIdentifier equality), `Item::setAllowOffhand` (2024 `0x1cb3c10` sets bit 7 of byte +0x14a: find a 1.26
reader), `Dimension::removeActorByID` / `transferEntityToUnloadedChunk` / `_sendBlockEntityUpdatePacket`, `LoginPacket::_read/write`,
`GameplayUserManager::getActiveGameplayUsers`, the `CommandArea`/`CommandAreaFactory` pair, `Minecraft::getLevel`,
`MinecraftCommands::getRegistry`, `ChunkSource::getLevel` (probably field reads: `launcher.ts` already derives `minecraftCommands`/`level`
from layouts), `Biome::getBiomeType`, `LevelChunk::getBiome`, `BlockActor::getServerUpdatePacket`, `Item::getSerializedName`, `ItemStackBase::hurtAndBreak`.

## 17. The `moved` names, closed (2026-09-30, agent-i)

`node tools/open-absorbed.mjs --class=moved` listed thirteen. **Six were already served** and only looked open because the tool
matched the 2024 spelling: `Actor::hurt`, `Player::getItemCooldownLeft`, `Player::isHiddenFrom`, `Player::setPlayerUIItem` and
`SimulatedPlayer::create` ship under `bdsx:` keys and `Mob::knockback` under 1.26's `KnockbackParameters` spelling (all bound in
`implements.ts` before the old name). The tool now knows those seven (`bdsxKey`). The other seven:

| name | how | 40 / 51 |
|---|---|---|
| `Spawner::spawnMob` / `spawnItem` | **`bdsx:` keys**: 1.26's `Spawner` has a vftable (`??_7Spawner@@6B@`, 21 slots); Endstone's order gives spawnMob slot 8, spawnItem slot 9. Both bodies are 2024's (`0x1b3f5a0`, `0x1b3f440`): region vf `0x158` -> `ActorFactory` (Level vf `0x908`) -> `createSpawnedActor`, spawnItem with `ActorType 0x40`, `tryGetFromEntity<ItemActor>`, the stack assigned at `+0x3b0`, throw time at `+0x450`. Prototypes unchanged. Slot 9 is a `jmp` thunk; the table holds its target | mob `0x2d02cf0` / `0x118caf0`, item `0x2d03010` / `0x118ce10` |
| `ItemStackBase::startCoolDown` | `derived()`: 2024 `0x1b6e6a0` = item and player present, `!isRemoved`, `Player::startCooldown(item, **false**)` (the bool is "send the packet"). The two 99-byte callers of `startCooldown(Item, bool)` that `findings-slots.md` took for it (40 `0x1bc37a0`, `0x24e2f40`) test an Item virtual against a bool argument and pass true: other functions | - |
| `Block::getDescriptionId` | `derived()`: BlockType `description_id_` at `+8` (2024: `BlockDisplayNameComponent` string, else the legacy's `+8`). The table's `?getDescriptionId@BlockLegacy@@` (40 `0xbcaf30` = `lea 0x100(%rcx)`, 51 `0x1165480` = `lea 0x28(%rcx)`) returns a different member per build, so it is not this | - |
| `Block::popResource` | `derived()`: nothing for count 0, else `spawnItem` at `pos + r*0.7 + 0.15` (three fresh randoms), throw time 10. 2024 `0x1bb7a40` -> `0x1bf2d40` (ItemInstance) -> `0x1bf2de0` (ItemStack). bdsx's random is `Math.random`, and 2024's first test (a BlockSource virtual `+0x180` that must be true) is not read | - |
| `Block::use` | `derived()` over `bdsx:Block::use` (40 `0x1bb2b50`, 51 `0x2ceb030`), through `simInteractBlock`: already the function `simulateInteract(BlockPos)` calls | - |
| `FreezeOnHitSubcomponent::readfromJSON` (51) | `derived()` in `engine/freezeonhit.ts`: `size` float (default 1.0), `snap_to_block` bool (default false), `shape == "sphere"`, into `+0xc/+0x10/+0x8`. 40 keeps the virtual (`0x1aedb80`, whose defaults 1.0/false/"" are what the JS reads); 51's slot 1 copies from a `SharedTypes::v1_26_50` definition | - |

**Executed, both builds** (`verify-pair.mjs mv40 mv51`, `tools/mv-a1-probe.ts` `mvprobe`, **12 PASS / 0 FAIL each**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/mv40-20260930-162*.txt`, `mv51-...`; and `icomp40/51`, `icprobe freeze`, 37 PASS / 0 FAIL each):
- `startCoolDown`: an empty stack leaves the `goat_horn` cooldown at 0; a goat horn stack starts it at 140 (asked namespaced and bare).
- `getDescriptionId`: `tile.stone.stone`, `tile.chest`, `tile.dirt.default`, each translating (`<id>.name`) to Stone, Chest, Dirt.
- `spawnItem`: diamond x3 at (24.5, ~70.4, 34.5), the actor holds diamond x3; `spawnMob`: a `minecraft:cow` at the asked x/z.
- `popResource`: an emerald x2 stack lands inside the +0.15..+0.85 box of the block position; count 0 pops nothing (a null air stack has
  count 1 and does pop, as 2024's count test would).
- `Block::use`: a lever's interned `Block` permutation goes off -> on (still on 8 s later) -> off across two uses, each true; stone is false and
  unchanged. **The player must be a simulated one**: with the headless bot (still on the loading screen) `use` answered true and the lever
  never toggled (two builds, pointer and runtime id compared, immediate and 8 s later). Why the bot's use does nothing is not known.
- `readfromJSON`: on 40 the engine's reader and `freezeOnHitReadJson` agree on three JSONs (the pair and `{}`: 0/1/0); on 51 bdsx's derived gives
  the same three answers.

Not done: a `BlockDisplayNameComponent` (custom block display name) is not read by `getDescriptionId`; `popResource` does not read the
BlockSource virtual test; the prototype of `spawnMob` was exercised with `naturalSpawn=false, surface=true, fromSpawner=false` only.

## 18. Five field reads, closed (2026-09-30, agent-a)

`MinecraftCommands::getRegistry`, `ChunkSource::getLevel`, `Minecraft::getLevel`, `NetworkSystem::_getConnectionFromId` and
`ServerPlayer::_nextContainerCounter` now have `derived()` entries (`data/derived.json`, code in `bds/engine/serverfields.ts` and
`engine/networkhandler.ts`) and ran on both builds (`ukb40/51`, `tools/uk-a1-probe.ts` `ukb`: 14 / 15 PASS, 0 FAIL, tsc 0, exit 0).
None is `gone`; each is a field walk whose 2024 body was read first.

- **`getRegistry`**: 2024 `0x4998d0` is `mov 0x10(%rcx),%rax`; Endstone's MinecraftCommands is `{vftable, context_provider_ +8,
  registry_ +0x10, output_sender_ +0x18}` and +0x18 is already a confirmed 1.26 member. The read equals the registry the register hook
  saw, on both builds, and no other word in +0..+0x40 holds it. launcher.ts now takes the registry from it at every boot and warns when
  it differs from the hook's (it never did).
- **`ChunkSource::getLevel`**: 2024 `0x6e2940` is `mov 0x20(%rcx),%rax`; Endstone: the 0x18-byte `EnableNonOwnerReferences` base, `chunk_side_`
  +0x18 (read back as 0x10), `level_` +0x20. Every loaded dimension's chunk source returned `bedrockServer.level` (overworld on 40,
  overworld and end on 51).
- **`Minecraft::getLevel`** is not a field: 2024 `0x17f8550` loads `game_session_` (+0xc0), requires the session's `level_entity_` storage
  to hold a value (flag at +0x10+0x18, the `_hasValue` of section 16), then follows the pointer at +0x30. `game_session_` is the member
  after `commands_`, so it is `Minecraft.commands + 8` (0xc0 on 40, 0xc8 on 51; new layout `Minecraft.gameSession`). **1.26's
  `NonOwnerPointer` is 24 bytes** ({control, count block, object}, `findings-nbt.md` section 17), so the Level is the word at session +0x40;
  following +0x30 once like 2024 returned the control block. That was the first run's FAIL on both builds (`0x...A040` vs the Level), found
  by dumping the session's words, fixed by reading +0x40; second run equal to the Level on both.
- **`_getConnectionFromId`**: 2024 `0x810b60` walks the vector (+0x40), skips a connection whose id type (+0x98) differs, then
  `equalsTypeData`. 1.26 has the loop inlined in `getPeerForUser` (40 `0xbfd6f0`, 51 `0x93bfa0`; type +0xa8, plus a `should_close_connection_`
  check this function never made). The bot's identifier finds a connection whose +0 id equals it, distinct from our copy, and which is one of
  `networkConnectionIds`; a copy with a flipped guid byte and a copy with another type both find nothing (both sides of the lookup).
- **`_nextContainerCounter`**: 1.26 inlines it in `ServerPlayer::openInventory` (40 `0x6931c0`, 51 `0x756800`): `movzbl 0xd98; incb; cmpb $0x64;
  cmovl 1; movb`. The earlier "no lookalike" search missed it because `cmovl` replaced the 2024 branch. New layout
  `ServerPlayer.containerCounter` 0xd98 on both builds (the other ServerPlayer offsets differ by one between builds; this one does not).
  BDS's own `openInventory` moved the byte 1 -> 2 on both builds, which is the independent witness of the offset; bdsx's call continues 2 -> 3 and
  wraps 99 -> 1. **Not seen:** BDS's own copy wrapping (a second `openInventory` is skipped while the first container is open, gate at
  `+0x5a0`); the wrap is read from both bodies and run through bdsx's code only.

Left in `unknown` (31): `Item::setAllowOffhand`, `Item::getSerializedName`, `ItemStackBase::hurtAndBreak` (agent-b's batch),
`Dimension::removeActorByID` / `_sendBlockEntityUpdatePacket`, `LoginPacket::_read`, `GameplayUserManager::getActiveGameplayUsers`, the
`CommandArea`/`CommandAreaFactory` pair, `Biome::getBiomeType`, `LevelChunk::getBiome`, `BlockActor::getServerUpdatePacket`; take the rest from
`node tools/open-absorbed.mjs --class=unknown`.

## 19. The world batch, first three (2026-09-30, agent-a)

`Dimension::getDefaultBiome`, `GameplayUserManager::getActiveGameplayUsers` and `PlayerMovement::getInputMode` are closed and ran on
both builds (`uka40/51` with the bot sending input mode mouse, `ukat40/51` with touch, `tools/uk-a2-probe.ts` `uka`: 13 PASS / 0 FAIL in
each of the four sessions, tsc 0, exit 0, `Quit correctly`). None is `gone`.

- **`getDefaultBiome` changed its return type, the concept stayed.** The Q3 audit retracted the endstone-slots candidate (Nether slot 25,
  40 `0x8111670`, 51 `0x880e5e0`) because it is `mov %rdx,%rax; movw $0x8,(%rdx); ret` and never builds a `HashedString` as 2024's
  `0x2883f0` did (copy of `VanillaBiomeNames::Hell`). That observation was right and is the finding: 1.26's virtual returns the biome id
  (a `uint16` through the sret pointer). Overworld's slot-25 body writes 0, The End's 9, Nether's 8, and 8/9 are what bdsx's old
  `getDefaultBiome(): number` polyfill hard-coded. So it ships as **`bdsx:Dimension::getDefaultBiome`** (address of Nether's copy);
  `procHacker.jsv` finds the slot by scanning `??_7NetherDimension@@6BIDimension@@@` and calls through each dimension's own vftable.
  `getDefaultBiomeString()` maps 0/8/9 to `ocean`/`hell`/`the_end`. The old 2024 name stays retracted. Executed: overworld 0, nether 8,
  end 9 on both builds (three dimensions loaded by teleporting the bot through the end and the nether first).
- **`getActiveGameplayUsers`** (`derived()`, `engine/worldfields.ts`): 2024 `0xb72f0` is `mov rax,rcx; ret`, and 2024's `Level::getActiveUsers`
  (`0xc964a0`) is `_getGameplayUserManager()` then a jump to it. 1.26's `Level::getActiveUsers` (40 `0x73f3d0`, 51 `0x7d72c0`) is
  `mov 0x458(%rcx),%rax; add $8,%rax`: the manager is a pointer at `Level+0x458` (new layouts `Level.gameplayUserManager`,
  `GameplayUserManager.activeUsers` = 8, same on both builds). Executed: the manager's vector is at the address `Level::getActiveUsers`
  returns, holds one `WeakEntityRef`, and its player is the bot. `Level.getRandomPlayer` used this through 2024's embedded manager at
  `Level+0x2e30` and a `StackResultStorageEntity` copy-constructor 1.26 does not have (a `Symbol not found` on both builds); it now walks
  `getActiveUsers()` with `tryUnwrapPlayer()` and returns the bot.
- **`getInputMode`** (`derived()`): 2024 `0x186b220` is the entt lookup of `struct PlayerInputModeComponent` (the hash 0xf87b6d93 is
  fnv1a of the spelling **with the `struct ` prefix** -- how a 2024 hash is named when `entt-typenames.mjs` finds nothing) and returns the
  first int of the 8-byte element, 0 when the entity has none. 1.26: hash `0xbd68c2e2`, and a reader that is there (40 `0x1f357e0`)
  strides 8 and compares the first int with 2 (touch). Executed both ways: the bot reads 1 when its `player_auth_input` says mouse and 2
  when it says touch (`probe-client.cjs` `BP_INPUT_MODE`), a pig reads 0. New helper `enttComponentIn` in `engine/entt.ts` (a registry and
  an id instead of an Actor), layout `PlayerInputModeComponent.size`.

Not seen: a second player (one bot), gamepad/motion-controller values.

## 20. The command / login / network batch (2026-09-30, agent-b)

Fifteen names were assigned; seven are closed and ran on both builds (`ukc40/51`, `tools/uk-b2-probe.ts`, **31 PASS / 0 FAIL each**, tsc 0,
exit 0, `Quit correctly`). Two probe flaws showed up first and were fixed (`@a` does not test the type, so the third filter case is
`@e[type=player]`; `execute as @a` without `at @s` gives a zero position).

| name | how | check |
|---|---|---|
| `CommandSelectorBase::filter` | **address**: 40 `0x383f20`, 51 `0x3d3180`, the six-site callee of `newResults` with 2024's prologue (`cmpb $1,0xbd(%rcx)`, `cmpl $0x1e`) | engine-parsed `@e[type=pig]`/`cow`/`player` asked about every actor: true for exactly that type, both builds |
| `CommandUtils::getFeetPos` | `derived()` (`engine/commandfields.ts`): x/z of the position, y = AABB min.y (pointer at Actor +0x220), raised to the vehicle's; inlined in the origins' `getWorldPosition` | equals an actor origin's own `getWorldPosition` under `execute as @a at @s`, equals the tp target (eyes are 1.62 higher); riding branch not seen |
| `Command::isWildcard` | `derived()`: `hasName() && getName() == "*"` (2024's token is built from the literal `*`) | engine-parsed `*` true, `@e` and a player's name false |
| `StackResultStorageEntity(WeakStorageEntity const&)` | `derived()` (`engine/entitycontext.ts`): `_isSet`, use count, entt validity, copy the three words | the bot's own `WeakEntityRef` gives its context; stale id, no control block, null id give none; count unchanged |
| `JsonUtil::getBlockLegacy` | `derived()` over `BlockTypeRegistry.lookupByName` | stone == bare `stone` == what `Block.create` reaches; a made-up name null |
| `JukeboxBlock::use` (= `BlockLegacy.use`) | `derived()` over `bdsx:Block::use` (1.26 has no `use` slot) | lever off -> on -> off through a simulated player, stone false |
| `ServerNetworkHandler::fetchConnectionRequest` | `derived()` (`engine/networkhandler.ts`): walk `clients_` (list head +0x58 on 40, +0x60 on 51, node key +0x10, `unique_ptr<Client>` +0xc0, `primary_request_` at +0) read off `_getActiveAndInProgressPlayerCount` | the bot's request, whose certificate name is the player's; a flipped-guid copy finds none |

**Shipped as STATIC only:** `??_7ScriptCommandOrigin@@6B@` (40 `0xa5f7d30`, 51 `0xa713780`). Two 34/35-slot tables share the origin functions; this one
belongs to the class whose deleting destructor is sized 0x70 and destroys the `std::function` at +0x50 (2024's is also 0x70; its
`handleCommandOutputCallback` reads that callback). The other table (40 `0xa5f7e40`, 51 `0xa7138a0`, 0x88 bytes, a shared_ptr at +0x78) derives
from it. No script origin can be made without the script engine, so it was not executed.

**Not done, with what was learned:**
- `LoginPacket::write` / `_read`: in both builds' `??_7LoginPacket@@6B@` (17 slots, Endstone `packet.h` order with MSVC's reversed overloads) slot 6 is
  `write(BinaryStream&)` (40 `0x2aa2b90`, 51 `0x2d69080`; slot 7 is the tail-jump `write(bs, ctx)`) and slot 15 is `_read(stream)` (40 `0x2aa2fc0`,
  51 `0x2d69480`; slot 8 calls it). Neither was shipped: neither `BinaryStream` nor `ReadOnlyBinaryStream` has a vftable in the table, so no stream can be
  built to call them, and bdsx's `read` prototype has no hidden return pointer while `Result<void, error_code>` is returned through one.
- `CommandArea` dtor / `getDimensionBlockSource` / `CommandAreaFactory::findArea`: 2024's dtor deletes the object at `*this` through its virtual destructor;
  `getDimensionBlockSource` is `blockSource->dimension(+0x28)->mainBlockSource(+0xd0)`; `findArea` is a 282-byte wrapper over a big `_getArea`
  (ChunkViewSource, bounds, loads). No 1.26 caller is named in the table, so no address was found and a JS rebuild would have to create chunk views.
- `GameRules::createAllGameRulesPacket`: 2024 builds a `GameRulesChangedPacket` with `make_unique` and `addRule` per rule; 1.26's `GameRules` was re-laid by bdsx's
  derived functions and `GameRulesChangedPacketData::addRule` has no address. Oracle would be the packet the bot receives.
- `ItemStackRequestData::tryFindAction`: 2024 `0x1aa0860` scans the vector at +0x30/+0x38 of `unique_ptr<Action>` for `getActionType() == type`. Only a client
  inventory click makes an engine-parsed request (Q7), so it stays a static candidate.

### 19b. Block-entity packet and entity removal (2026-09-30, agent-a)

`BlockActor::getServerUpdatePacket`, `Dimension::_sendBlockEntityUpdatePacket` and `Dimension::removeActorByID` ran on both builds (`ukw40/51`,
`tools/uk-a2-probe.ts` `ukbe`/`ukrm` in stages -- timers do not fire while the server runs in this harness, they run after the stop and find
`bedrockServer.level` decayed: one console command per stage -- 19 PASS / 0 FAIL each). None is `gone`.

- **`getServerUpdatePacket`** is a virtual at slot 18 of `??_7BlockActor@@6B@` on both builds (2024: 40). Found from the base copy (`mov %rdx,%rax;
  movq $0,(%rdx); ret`, the 2024 default too) and from the override 40 `0x2906660`, which sits at slot 18 of the Campfire, Chest, ... tables
  (saves into a `CompoundTag` and wraps it with the block position). Ships as **`bdsx:BlockActor::getServerUpdatePacket`** (base copy 40
  `0x23cf10` / 51 `0x2cbf40`). Executed: chest, jukebox, standing sign, barrel, command block give a packet with the right position and NBT;
  furnace and hopper give null.
- **`_sendBlockEntityUpdatePacket`** (`derived()`): getBlock / `hasBlockEntity` / getBlockEntity / the virtual above /
  `IDimension::sendPacketForPosition` (slot 3, same arguments as 2024) / reliability `+12` = 1. Executed against the bot's `packetSend(BlockActorData)`:
  a packet for exactly the five positions, none for the furnace, hopper, stone or air.
- **`removeActorByID`** (`derived()`): 2024 looks the id up in the dimension's map and calls `Level` slot 210, `forceRemoveEntityfromWorld`
  (a jmp to `ActorManager::forceRemoveActorFromWorld`, ActorManager at `Level+0x418` on 1.26). 1.26's slot is 242 on both builds (new layout
  `Level.forceRemoveEntityFromWorldSlot`). bdsx uses `Level::fetchEntity` plus a dimension check for the lookup. Executed on two summoned pigs
  (natural spawns add others, so they are tracked by id): wrong dimension and unknown id remove nothing, the right dimension removes A and keeps B.
  The first count-based checks failed on a third, naturally spawned pig: a test bug, not a wrong slot.

**Still `unknown`, with what was found** (none attempted to the point of a wrong guess):
- `Dimension::fetchNearestAttackablePlayer` (both): 2024 builds a lambda and calls `forEachPlayer` (IDimension slot 9; 1.26 slot 10, `mov 0x50(%rax)`);
  the lambda (2024 `0x1f3cc50`) is the mob-targeting predicate -- invulnerable ability, isAlive virtual, `distanceToSqr` against the block centre, a
  0.8 factor when sneaking, armour cover, `hasCategory`. A port is a piece of work of its own; 1.26's generic `fetchNearestPlayer` core is at
  40 `0x178bf40` (FLT_MAX initial distance, predicate `0x179d7f0`).
- `Dimension::transferEntityToUnloadedChunk`: 2024 `0x1f56e00` saves the actor into a `CompoundTag` (Actor virtual `+0x2b8`), queues it in
  the dimension's unloaded-chunk transfer map (`Dimension+0x288`) and sets moved-to-limbo / moved-to-unloaded flags; 1.26 has
  `actor_unloaded_chunk_transfer_queue_` (Endstone dimension.h) but no name or caller chain was found (40 `0x178d8f0` has the
  `EntityStorageKeyComponent` hash but is another function).
- `BlockSource::removeBlockEntity`: 2024 = `getChunkAt` (vf `+0x78`) then `LevelChunk::removeBlockEntity` (an unordered_map erase at chunk `+0x1058`).
  1.26's `getChunkAt` is BlockSource slot 40 (vf `+0x140`); no function of that shape was found, and `LevelChunk::removeBlockEntity` has no name.
- `LevelChunk::getBiome` / `Biome::getBiomeType`: 1.26 stores biomes in `SubChunkStoragePaletted<Biome,...>` and `getBiomeType` needs the
  runtime type id of `VanillaBiomeTypeAttributes`; neither was located.
- `ActorMobilityUtils::shouldApplyLava`: 2024 `0xbc5f90` reads three components (a flag 0x38bcde77 whose 1.26 spelling was not found, `AABBShapeComponent`,
  `SubBBsComponent`), then `Actor::getLiquidAABB` and BlockSource virtual `+0x50` = `containsMaterial(AABB, MaterialType lava)`. 1.26's BlockSource
  vftable is reordered (getChunkAt 15 -> 40) and no `containsMaterial` was identified. `WasInLavaFlagComponent` (hash 0x832a2768) exists but is the
  tick system's result, not this function.

## 22. Streams, the login packet and the game rules packet (2026-09-30, agent-a)

Two of the three names section 20 left are closed and ran on both builds (`ukd40/51`, `tools/uk-a3-probe.ts`, **login 7 PASS + rules 9 PASS, 0 FAIL** each;
the tsc lines in those sessions are another agent's `zz-ukcprobe.ts`, tsc 0 errors in mine). The third, the `CommandArea` trio, did not move.

**The two streams.** 1.26 has no out-of-line constructor for either (195 functions store the `BinaryStream` vftable, e.g. `0xbcc320` on 40 builds
the stream inline). The tables were found by shape: the 2-slot table (dtor, `read`) is `ReadOnlyBinaryStream` (40 `0xa560810`, 51 `0xa67fde0`; 481 and
519 referencing functions), the 29-slot table whose slot 1 is the same `read` is `BinaryStream` (40 `0xa5f2700`, 51 `0xa7122c0`; the `writeBool`/`writeByte`
bodies are folded in pairs exactly as Endstone's order predicts). `0xbcc320` stores the BinaryStream table at +0 and the ReadOnly one while tearing the base
down, which names the pair. Layout from `read` (40 `0x82b050`, 51 `0x8b89b0`) and `writeByte` (40 `0x82bcc0`): +8 owned string, +0x28/+0x30 view
pointer/size, +0x38 read pointer, +0x40 overflow flag, +0x48 (BinaryStream) the `std::string&` every write appends to, then it refreshes the view. So
`bds/engine/binarystream.ts` lays the object out itself (`JsBinaryStream`, `JsReadOnlyBinaryStream`) and calls the engine's virtuals. `read`
returns its `Result<void, error_code>` through rdx; the success value is a 1 at +0x40 (`VoidErrorCodeResult.isOk()`).
The old `ReadOnlyBinaryStream.read` prototype in `event_impl/packetevent.ts` still lacks `structureReturn` (not exercised on 1.26; untested, left).

**`LoginPacket::write` / `_read`** (slots 6 and 15, 40 `0x2aa2b90`/`0x2aa2fc0`, 51 `0x2d69080`/`0x2d69480`; `_read` gets `structureReturn`).
In 1.26 every packet's `write(stream)` builds a serializer context and calls slot 7 `write(stream, ctx)`; the body is reflection-driven. Executed on the bot's
own Login packet (`packetBefore`): `write` yields 587,948 bytes whose layout is a big-endian protocol int (2168 on 40, 2193 on 51, each build's own), a varint of the
rest (587,941) and exactly that many bytes (4 + 3 + 587,941); `_read` of those bytes gives protocol and certificate identity `bdsxprobe` and consumes every byte;
`_read` of the **client's raw wire bytes** (packetRaw, header varint `01` skipped) gives the same protocol and identity and consumes all 587,982 bytes; a
stream cut to 3 bytes fails with the overflow flag set, one cut to 10 fails (the string length check, flag not set). `write` does not reproduce the client's blob
byte for byte (it re-serializes the parsed request: `{"Authentication...` where the client sent `{"Certificate...`, 35 bytes shorter): a check "write == wire" was
written first, failed, and was replaced by the layout check above.

**`GameRules::createAllGameRulesPacket`** (40 `0x7c0030`, 51 `0x80fb40`, found as the `make_unique<GameRulesChangedPacket>` body: packet 0x50 bytes, rules
`vector<GameRule>` at +0x30 with stride 0x118, the same loop over `GameRules+0x18/+0x20` and the map at +0x30 as 2024 `0x1f079c0`; `rcx` this, `rdx` the
unique_ptr). Executed: the created packet holds 39 rules on both builds, identical to the live `GameRules` (name, type, value) for 39/39; with `gamerule
keepInventory true` the packet copy reads true, with false it reads false; and `Level.syncGameRules()` makes the bot log `game_rules_changed n=39
keepinventory ... value true` then `... value false` (the engine's own packet for the command has n=1), both builds (`C:\bdsx-again\ukd40.bot.log` / `ukd51.bot.log`,
the bot logs are not in the session's grep). `GameRulesChangedPacketData::getRules`'s old candidate (40 `0xa10180`) is not a function start: 1.26 folds `getRules`
into the shared `a10c80` getter.

**`CommandArea` dtor / `getDimensionBlockSource` / `CommandAreaFactory::findArea`: not done.** 2024's dtor address `0xc3890` is the ICF'd
`unique_ptr<T>::~unique_ptr` (delete `*this` virtually), so `CommandArea` is one owning pointer; `getDimensionBlockSource` is `(*this)->dimension()->mainBlockSource`.
Both are derivable, but neither can be shown without a live `CommandArea`, and only `findArea`/`_getArea` (2024 `0xcc5320`/`0xcc0060`, callers
`StructureAnimationAction::execute`, `StructureManager::loadPlacementQueueItem`, `StructureBlockActor::_loadStructure`, `CommandOrigin::getAreaAt`) make one.
`_getArea` calls `ChunksLoadedInfo::calculateChunksLoadedInfo` and `ChunkViewSource::move` then constructs a `ChunkViewSource` (size 0x1f8). 1.26.40's
`ChunkViewSource` constructor is `0xb92760` (12 callers, table `0xa5ff840`, 41 slots); none of its callers has that shape (checked `0x12e3790`, `0x399df70`,
`0x4580830`/`0x4580d30`, `0x4585ad0`, `0x66a1870`, `0x811a450`, `0x811a890`: they build a 0x1b0/0x1c0 object, i.e. a different class). Next try: the three structure
callers above (find them through `StructureBlockActor`'s vftable, `tools/ctor-from-vftable.mjs`), and look in each for a call that takes two BlockPos and three bools and
returns through rdx.

## 21. Biome, lava and block-entity removal (2026-09-30, agent-b)

`ActorMobilityUtils::shouldApplyLava`, `BlockSource::removeBlockEntity`, `LevelChunk::getBiome` and `Biome::getBiomeType` ran on both
builds (`uke40/51`, `tools/uk-b2-probe.ts` `ukl place|test|clean|rbplace|rbtest|rbclean` and `ukbio api|fmt`: **20 PASS / 0 FAIL each**, tsc 0,
exit 0, `Quit correctly`). None is `gone`. The probe's first versions scanned raw objects and hit junk pointers (`Access Violation: 0x2`, an
execute at 0 from a slot applied to a non-storage): read offsets off the object once, then use fixed ones.

- **`shouldApplyLava`** is an address: 40 `0x2a02be0`, 51 `0x1c64860` (1152 bytes, 14 callers each, one of them `Player::normalTick`). Found by
  intersecting component hashes: 2024's flag `0x38bcde77` is `FlagComponent<ImmuneToLavaDragFlag>` (its baseline names list it next to
  `AABBShapeComponent`/`SubBBsComponent`), 1.26 spells it `ImmuneToLavaDragComponent` (`entt-typenames.mjs`, hash `0xdd2da6e4`); the one function with
  that hash, `AABBShapeComponent` and `SubBBsComponent` is this one. The body is 2024's with `getLiquidAABB` inlined: flag -> false, else
  BlockSource vftable `+0x40` (the old `containsMaterial(AABB, MaterialType)`, `r8b = 6` lava) on the actor box and then on each sub-box.
  Executed through `Actor.isInLava`: a pig summoned in a lava block true, four blocks above it false, far away false, the player false, both
  builds. A strider is INFO only (40 false at y 69.7, 51 true at y 68.0: it walks on lava and differs by build).
- **`removeBlockEntity`** is a `derived()` over a new address key `bdsx:LevelChunk::removeBlockEntity` (40 `0xba5d60`, 51 `0x9f8270`). 1.26 has no
  out-of-line `BlockSource::removeBlockEntity`: `getChunkAt` (vft `+0x140`) then the chunk function is inlined into the `setBlock`-like bodies.
  The chunk function is `getBlockEntity`'s sibling (`0xba6b00`, found with the FNV-1a hash constant plus the map fields `+0x13a0/+0x13b0/+0x13c8`):
  it hashes the ChunkBlockPos, finds the entry, copies the `shared_ptr` out and erases. bdsx's old binding returned `void` over an sret function; the
  new one takes the returned pointer and disposes it. Executed: chest and furnace placed; stone, air and an unloaded chunk change nothing; the chest's
  block entity is gone afterwards and the furnace's stays; a second removal is harmless.
- **`getBiome`** (`derived()`, `engine/biome.ts`, new layouts `LevelChunk.biomeStorages` 0x358, `biomeGetElementSlot` 3): the chunk keeps a vector of
  `unique_ptr<SubChunkStorage<Biome>>`, one per sub-chunk (24 overworld, 8 nether, 16 end; null for an ungenerated sub-chunk), found by its length.
  Slot 3 of every storage class is `getElement(uint16)` and returns the `Biome` itself: the uniform class (`mov 0x8(%rcx),%rax`), the 1-bit and
  the 2-bit paletted ones (40 vftables `0xa5fed20`/`0xa5fedd0`/`0xa5fee80`, 51 `0xa719c40`/`0xa719cf0`/`0xa719da0`). 2024's extra
  `BiomeRegistry::lookupById` step is gone. The index was not assumed: over 63 loaded chunks and 413 edges of mixed sub-chunks next to uniform
  neighbours, `(x*16+z)*16+y` has 274 mismatches in 26432 cells and the five other orders 4045 to 8372 (same numbers on both builds, same world).
  The shipped function gives the raw formula's 274. Executed: the biome under the player is `minecraft:hell` in the nether and `minecraft:the_end`
  in the end; eight named overworld biomes (desert, plains, river, forest, jungle, jungle_edge, bamboo_jungle, lush_caves).
- **`getBiomeType`** (`derived()`): Endstone `biome_component_storage.h` is a vector of `(typeid_t, unique_ptr<component>)` at `Biome +0x170` on both builds
  (id u16 `+0x168`, full name std::string `+0x198`, new layouts `Biome.id/name/components`). The VanillaBiomeTypeAttributes entry is the one whose first
  int is 1 for desert, 11 plains, 12 river, 4 forest, 7 jungle, 5 hell, 17 the_end, and which lush_caves lacks (DataDriven 18, as in 2024's default):
  its typeid is the engine's runtime counter, **67 on 40 and 69 on 51** (`layouts.Biome.vanillaTypeAttributesTypeId`). Executed: every named biome met
  returns its vanilla type, every biome without the component (lush_caves, basalt_deltas, warped_forest, crimson_forest) 18. **Weak point:** the typeid
  is read from the table, not from the engine's static id (2024's `0x33cd62c` has no name in 1.26); it was identical in every run here, but a world
  whose startup order hands out ids differently would need it re-read. bdsx's `Biome` class now has `id` and `name` at the 1.26 offsets.

**Still `unknown`:**
- `Dimension::transferEntityToUnloadedChunk`: 2024's `0x1f56e00` (save the actor into a CompoundTag, `transferTickingArea`, `setMovedToLimbo`, a map of
  ChunkPos -> vector<unique_ptr<CompoundTag>>, `setMovedToUnloadedChunk`, then the second overload `0x1f57200`). None of those callees has a name in 1.26 and
  the map is at Dimension +0x80 by Endstone (`actor_unloaded_chunk_transfer_queue_`). `0x178d8f0`/`0x1548e10` (the function `findings` section 19b named)
  read floor(x/y/z) of a position and are something else. Next: find writers of Dimension `+0x80` (an unordered_map insert), or callers of
  `EntityStorageKeyComponent` users in Dimension's address range (`0xba5340`, `0xba5a20` are LevelChunk's). No oracle exists without moving an actor
  into an unloaded chunk. One more look (40 only): `0x178a960` (4198 bytes, `EntityStorageKeyComponent` hash, calls `Actor::getDimensionId`, `getChunkEntities`
  0xba5840 and `0x178d120`) is the consumer of the chunk-transfer queue (Dimension's per-tick body `0x1788af0` calls it), not the function that fills the unloaded-chunk map.
- `Dimension::fetchNearestAttackablePlayer` x2: not attempted (the mob-targeting lambda port, section 19b).

## 23. The `live` leftovers, closed (2026-10-01, agent-a)

`node tools/open-absorbed.mjs` listed five `live` names: `??_7Item@@6B@`, `??_7BlockLegacy@@6B@`, `Item::getCooldownType`,
`BlockPalette::getBlock` (each a `procHacker.jsv(vftable, name, ...)`, which needs the class's table by name; 1.26's tables name
neither `??_7Item@@6B@` on either build nor `??_7BlockLegacy@@6B@` on 51, and the palette's table is the abstract base's, not the
one the live object carries) and `Block::buildDescriptionId` (a 51-only gap-agreement candidate that was never shipped and never
executed). All five throw when called. They are all virtual calls, so none needs an address: bdsx calls the slot through the
**object's own vptr**. Ran on both builds, `ukf40`/`ukf51` (`tools/uk-a4-probe.ts`), **17 PASS / 0 FAIL each**, tsc 0, exit 0,
`Quit correctly` (`work/host-runs/ukf40-20261001-012603.txt`, `ukf51-...`).

| name | slot (2024 -> 1.26, both builds) | static basis | value that only a right slot gives |
|---|---|---|---|
| `Item::getCooldownType` | 90 -> **103** (`layouts.Item.getCooldownTypeSlot`) | `Player::startCooldown` (40 `0x21d850`, 51 `0x2ac040`) calls `item->vf[0x338]`, takes the result's string (`+8`, size `+0x18`), namespaces it with `"minecraft"`, then `vf[0x340]` (getCooldownTime). The result is a `HashedString const*` | goat_horn -> `"goat_horn"`; stone, apple -> `""`; ender_pearl -> `"ender_pearl"`; `getItemCooldownLeft(returned HashedString)` 0 before, 140 after the engine's `startCoolDown` |
| `BlockPalette::getBlock` | 3 -> **3** (`layouts.BlockPalette.getBlockSlot`) | dtor, `getPaletteType`, `appendBlock`, `getBlock`, `assignBlockNetworkId` (Endstone `block_palette.h`). The base table's slot 3 (40 `0x14f12f0`, 51 `0x15f11d0`, byte for byte the same shape) is the Hashed palette: a `std::map<uint, uint>` at `+0x88`, then the vector lookup at `+0x68` (2024 `0x1b0f790` was the vector lookup alone) | seven blocks (stone, oak_planks, dirt, chest, lever data 0 and 5, water data 3): `getBlock(block.getRuntimeId())` is the same object `Block.create` returned, the ids are seven distinct 32-bit hashes |
| `Block::buildDescriptionId` | 119 -> **97** (`layouts.BlockLegacy.buildDescriptionIdSlot`; `derived()`) | Endstone `block_type.h` counts it 6 before `getVariant` (102 on both builds, and the signal slots match, so the commented-out virtuals in between do not shift it); the base body (40 `0x1eec8b0`, from `??_7BlockLegacy@@6B@` slot 97) copies `description_id_` (`+8`) and appends the five bytes `.name` (`0xa8e354a`), reading neither r8 nor the Block | stone `"tile.stone.stone.name"` -> `Stone`, chest -> `Chest`, dirt `"tile.dirt.default.name"` -> `Dirt`, and **oak_planks `"tile.planks.oak.name"` while its `getDescriptionId()` is `"tile.oak_planks"`**: only an override reached through the type's own vptr gives that |

`BlockLegacy::asItemInstance` had the same jsv in its `derived()` fallback (the reason `??_7BlockLegacy@@6B@` was still a required
name); its slot fallback is now 2024's (96), one body serves every build, and no vftable name is left in bdsx's source for either
class. Both `??_7` names left the required set on the rescrape.

**Not done (weak point, written down):** 2024's `Block::buildDescriptionId` first asked the block type for a
`BlockDisplayNameComponent` string (custom blocks); the 1.26 read of that component is not ported, so a custom block's display-name
override is not seen. The palette's miss path (an id the palette does not hold) was not called: it logs an error first.

**The inventory tool.** `NetherDimension::getDefaultBiome` and `BlockActor::getServerUpdatePacket` are served under `bdsx:` keys
(`bdsx:Dimension::getDefaultBiome`, `bdsx:BlockActor::getServerUpdatePacket`, shipped on both builds) but kept showing as `unknown`:
the first key is spelled for the base class, the second had a stale hand verdict in `data/arch-classes.json` that outranks the
`bdsx:` rule. `tools/arch-inventory.mjs` now has an alias table for the base-class spelling and requires the key in **every**
build's table; `tools/open-absorbed.mjs` skips names the inventory class as served by a `bdsx:` key. The stale hand verdicts for
`?getServerUpdatePacket@BlockActor@@` and `?buildDescriptionId@Block@@` were removed. Counts: `live` 24 -> 23 (the two vftable names
and `getCooldownType`/`getBlock` left the required set; `buildDescriptionId` is now `derived`), `unknown` 42 -> 40.
`open-absorbed.mjs` now lists 7 names, none `live`: the `CommandArea` trio (`~CommandArea`, `getDimensionBlockSource`, `findArea`),
`fetchNearestAttackablePlayer` x2, `transferEntityToUnloadedChunk` (agent-b's) and `ItemStackRequestData::tryFindAction`.

## 24. `fetchNearestAttackablePlayer` x2 and the `CommandArea` trio, closed; `transferEntityToUnloadedChunk` not (2026-10-01, agent-b)

Ran on both builds, `ukg40`/`ukg51` (`tools/uk-b4-probe.ts`, `node tools/host/verify-pair.mjs`): **34 PASS / 1 FAIL each**, tsc 0, exit 0, `Quit correctly`
(`work/host-runs/ukg40-*`, `ukg51-*`; two earlier runs only fixed the probe's own console commands: `item replace` armour slots did nothing, `replaceitem` works).

**`Dimension::fetchNearestAttackablePlayer` x2** (`derived()`, `engine/attackable.ts`). 1.26 has no out-of-line function for either overload: every caller
builds the closure for `forEachPlayer` (dimension vftable slot 10) itself. What exists is the predicate lambda, one function per build (40 `0x179d510`,
51 `0x188aec0`; found as the 732-byte caller of `isHiddenFrom`, and its closure layout read from a caller, 40 `0x2386cc0`: five pointers, best float,
BlockPos, radius float, `Actor*`, `Player*` result). Its body is 2024's `0x1f3cc50` step for step (see the file header). **The engine's own lambda is the
oracle:** the probe calls it (`bdsx:Dimension::attackablePlayerPredicate`, probe-only) over the dimension's players with a hand-built closure and compares
found/none and the float distance with bdsx's port, both overloads and the BlockPos overload with a null mob, at 1.1x and 0.9x of each threshold and with no
limit. All rows agree on both builds for: plain, sneaking (x0.8), invisible without armour (x0.07), invisible with four armour pieces (cover 1, x0.7), a zombie
head against a pig (no effect), creative (never a target), no-limit radius. **Not seen:** the x0.5 `isHiddenFrom` branch firing. A zombie head (`skull 1 2`) against a
zombie gave the same answer from the engine and from the port, so the one FAIL row per build is the probe's expectation (0.9x expected none, both said
found), not a disagreement; whether the head was worn or the mob's flag bytes (`Actor +0x269` removed, `+0x210` bit 2) excluded the branch was not separated.
Also not seen: the component-present skip of the armour term (hash `0xa74de0e8`, identical on both builds, name unknown; `enttHas` over a raw hash), and a second player.
New layout: `Actor.categoryFlags` 0x210 (`Actor.removed` 0x269 already existed).

**`CommandArea`** (`bds/commandarea.ts`, three `derived()`). Section 22 missed `_getArea` because ChunkViewSource is 0x1b0 bytes in 1.26, not 0x1f8:
`0x12e3790` (40), which it had checked and dismissed, is the "no cached view source" branch of the real `_getArea`. `bdsx:CommandAreaFactory::_getArea` is 40 `0x12e3580`,
51 `0x12061e0` (same shape: `calculateChunksLoadedInfo` 40 `0xb963f0`, state == 2, `getChunkViewSource` `0xb96190`, `move` `0xb957a0`, an 8-byte unique_ptr target;
this = `{Dimension*}`). The `findArea` callers in command bodies build the Bounds inline (40 `0x12e5780`, `0x3d095a0`: a `CommandOrigin`-taking variant with an int and a bool),
so `findArea` is a bdsx function: Bounds = (x1>>4, 0, z1>>4, x2>>4, 0, z2>>4, dx, 1, dz, dx*dz, dx*dz, 16) then `_getArea` with the three bools. The destructor deletes the
owned `ChunkViewSource*` through its virtual destructor; `getDimensionBlockSource` reads the `Dimension*` at view source +0x28 (new layout `ChunkSource.dimension`)
and calls `Dimension.getBlockSource()`. Executed in the overworld and the nether: an area of loaded chunks around the bot gives a `CommandArea` for the bool patterns 000, 100 and 011;
its block source is the same pointer as `Dimension.getBlockSource()` and reads the same block; an area 200000 blocks away is null, a half-loaded one is null; 25 find + dispose loops
are fine. **Not seen:** what the three bools do for a caller (passed through), and the engine's own `/fill`/`/clone` calling the same `_getArea` (no hook was put on it).

**`Dimension::transferEntityToUnloadedChunk`: not done.** Nothing new could be shown. Read this round (40): `0x66ae80` is an actor-to-chunk unregistration (chunk `+0x210` map keyed by
ActorUniqueID through the FNV hash `0x178c050`), not the transfer; `0x178a960` consumes a list at Dimension `+0x2f0` (another actor-move queue) and saves actors through
`Actor::save` (`0xe00c70`, not in the Actor vftable); `0x1549390` (a `LevelChunk` saver) also calls `Actor::save`. None has the 2024 shape (save into a `CompoundTag`, `transferTickingArea`,
`setMovedToLimbo`, ChunkPos-keyed map insert, `setMovedToUnloadedChunk`). `Actor::save`'s 14 callers are listed by `node tools/callers.mjs 1.26.40.8 0xe00c70`; the ones not yet read are
`0x94aec0`, `0x105c500`, `0x105fed0`, `0x14e4460`, `0x28fc140`, `0x2e20890`, `0x2e219c0`, `0x3bc7e50`, `0x4613e40`. No oracle exists (it needs an actor moving into an unloaded chunk).

## 25. `Dimension::transferEntityToUnloadedChunk` is inlined on both builds (2026-10-01, agent-a)

Static only; nothing was run, and no table or `derived()` entry was added. The 2024 caller is `_tickEntityChunkMoves` (`0x1f470a0`, the only call site of `0x1f56e00`).
Its 1.26 successor is the function section 24 already named the "queue consumer", and the transfer is **inlined into it**:

- 40 `0x178a960` (4198 bytes; called from `Dimension::tick` `0x1788af0` at `0x1788e42` and a thunk `0x1790360`), 51 `0x1881c10` (3951 bytes; callers `0x187f9c0`, thunk `0x1887350`).
  Both swap a list at Dimension `+0x2f0`/`+0x2f8` (the `0x101` sentinel node), then per entry: `new CompoundTag` (vftable `??_7CompoundTag@@6B@`), `Actor::save` (40 `0xe00c70`, 51 `0xd40ec0`,
  at `0x178ad83` / `0x1881f68`), `movb $1, 0x26a(actor)` (the moved-to-limbo flag, 51 also `0x26b` later), then a `try_emplace` into the map at Dimension `+0x2b0` (`ChunkKey` ->
  vector of entries; Endstone's `actor_unloaded_chunk_transfer_queue_`) through `0x17ad4a0` on 40.
- `0x17ad4a0` has exactly one caller on 40, `0x178a960 + 0x56d`: the map insert exists nowhere else, so there is **no out-of-line `transferEntityToUnloadedChunk`** (neither the
  `(Actor&, LevelChunk*)` overload nor the 2024 `ChunkPos`/`AutomaticID` one) on 40. 51 has the same function shape, the same `+0x2f0`/`+0x2b0` offsets and the same flag stores.
  Of `Actor::save`'s 14 callers on 40, three more were read (`0x2e20890`, `0x3bc7e50`, `0x4613e40`: item/structure savers next to `setCustomName`/`getActorIdentifier`); the rest were not needed once the single-caller map insert was found.
- Not `gone`: the behaviour exists, fused into the per-tick chunk-move pass. Not callable either. A `derived()` would have to rebuild the `ChunkKey` hash map insert and the entry layout
  by hand and has no oracle (it needs an actor crossing into an unloaded chunk), so none was written. The throw stays; the class stays `unknown` with this evidence in `notGone`.
  The only way to call it is `_tickEntityChunkMoves` as a whole (40 `0x178a960`, 51 `0x1881c10`; `this` = Dimension), which moves every pending actor, not one.

## 26. `ItemStackRequestData::tryFindAction`: inlined, and the request layout moved (2026-10-01, agent-b)

Executed on both builds with no client: `ukh40`/`ukh51` (`tools/uk-b5-probe.ts`, `node tools/host/verify-pair.mjs`), **26 PASS / 0 FAIL each**, tsc 0, exit 0, `Quit correctly`
(`work/host-runs/ukh40-20261001-092927.txt`, `ukh51-20261001-092927.txt`); `pk40/51` still 16 PASS / 2 FAIL (the known two). Class `absorbed` over a layout; `derived()`.

**No function to call.** 2024's `0x1aa0860` scanned a `vector<unique_ptr<Action>>` at `+0x30/+0x38` for the byte at `action+8`. 1.26 inlines it into its one caller, which is
the one function in each build holding both a `cmpl $0x1a, (%rbx)` loop (`PlayerBlockActions::findFirstOfType`) and a `cmpb $0xb, 0x8(%rdx)` over `0x30/0x38`:
`ServerPlayerBlockUseHandler::onBeforeMovementSimulation`, 40 `0xaa3290` (3894 bytes), 51 `0x13e5680` (3894 bytes, byte-identical body; the 2024 one is `0x8d7820`,
type 11 = `ScreenHUDMineBlock`). That is the legacy object (unique_ptr actions, polymorphic, type byte at +8), built on the PlayerAuthInput path; no plugin reaches it today.

**The request an `ItemStackRequestPacket` carries is another layout**, found by writing the packet by hand and letting the engine read it
(`ItemStackRequestPacket.allocate()`, `pk.read(JsReadOnlyBinaryStream)` -- slot 15, the cereal path; the wire is the protocol schema of `minecraft-data` 1.26.51
`ItemStackRequest`, which Cloudburst's `v2168`/`v2193` helpers confirm: zigzag request id, actions `[varint wire id, u8 engine type, body]`, custom names, `li32` cause):
- the packet's request vector is at `+0x30` and the requests are **inline, 0x48 bytes each** (not pointers): `vftable +0`, request id `+8` (zigzag, **must be negative and the
  request must have at least one action**, or `read` fails with code 104 after the id), actions vector `+0x10`, custom names `vector<string>` `+0x28`, the cause `+0x40`;
- each action is a **0x60-byte `std::variant` slot** and its index byte is at `+0x58` -- **the protocol's wire id** (0 take ... 6 create, 7 lab table, 8 beacon, 9 mine block,
  10 craft recipe ... 16 non-implemented), not the old enum (`ScreenHUDMineBlock` is 11, wire 9). The second byte of the wire action (the engine's own enum value) is what the legacy
  object keeps at `+8`, so it is the independent oracle for bdsx's index -> `ItemStackRequestActionType` table. Payload seen for take (count at `+0`, then 0x28-byte slot infos at `+8`
  and `+0x30`: container `+0`, slot `+0xc`, stack id `+0x10`) -- **candidate only**, `ItemStackRequestActionTransferBase.getSrc` still has the 2024 offset.
- bdsx's old accessors were wrong here, silently: `getActions()` read `+0x30` (empty), `getStringsToFilter()` read `+0x10` (the actions), `ItemStackRequestAction.type` read `+8`, and
  `ItemStackRequestPacket.getRequestBatch()` returned `undefined` (`ItemStackRequestBatch` assumed pointer elements). Now: `ItemStackRequestPacket.getRequests()`, `ItemStackRequestData.getActions()`
  (`ItemStackRequestAction[]`), `ItemStackRequestAction.type` (variant index -> enum), `getStringsToFilter()` at `+0x28`, and `tryFindAction` = the first slot of that type. `ItemStackRequestBatch` is gone.

**What ran** (`ukh run`, `ukh types`): a two-request packet (55 bytes) is read whole and both ids come back (-7, -9: the stride is right); the first request's five actions
(create, mine, lab table, mine, craft creative) read back in order with bdsx types equal to the engine type bytes on the wire; `tryFindAction` over all 20 types returns the first slot for
the four present types (and `#1`, not `#3`, for the two mine blocks) and null for the other 16; the second request answers independently; the custom names `ab`, `cde` read back from `+0x28`,
none for the other request; and 17 of the 18 action types, one request each, give variant index == wire id and bdsx type == engine type byte on both builds.
**Not seen:** `results_deprecated` (wire 17: the engine rejects my body -- consumed 6 of 12 -- so index 17 is the schema's, not observed), an action's payload through bdsx's classes, the
legacy object (PlayerAuthInput), and a request a real client sent (the bot can send one; nothing here needed it). `getSrc`/`ItemStackRequestSlotInfo` and the filter cause (`+0x40`) are still 2024 / unread.

## 27. The item stack request action payloads: `getSrc` and the slot info (2026-10-01, main)

Leftover of section 26, same method: hand-written `ItemStackRequestPacket`s read by the engine's own reader, then the 0x60-byte variant slot dumped (`ukh slots`,
`tools/uk-b5-probe.ts`, drivers `ukhs40/51`) with **distinct values** (src container 12 / slot 33 / stack id 55, dst 13 / 44 / 66, count 2) so a misread offset cannot hit by chance.
The dump is **byte-identical on 40 and 51** for take, place, drop, destroy and consume; swap differs only in trailing padding (uninitialised bytes after the index byte).

- slot info is **0x28 bytes**: container id `+0` (u8), slot `+0xc`, client stack id `+0x10` (an `ItemStackNetIdVariant`, index 0 = the plain id; the stack id reads as an int32).
- take / place: `[count u8 +0, src +8, dst +0x30]`; swap: `[src +0, dst +0x28]` (no count); drop: `[count, src +8, randomly bool +0x30]`; destroy / consume: `[count, src +8]`.
- bdsx now has `ItemStackRequestActionTransferBase.getAmount()` (null for swap), `getSrc()`, `getDst()` (null for drop / destroy / consume), and `ItemStackRequestSlotInfo` is 0x28 bytes
  with `openContainerNetId`, `slot`, `stackNetId`. `getActions()` returns the resolved subclass through `resolveItemStackRequestAction` (before, the transfer family was never reached from it).
- 2024's `getSrc` read `+0x18`; that is gone.

**Checked** (`ukhs40`/`ukhs51`: 32 PASS / 0 FAIL each, tsc 0, exit 0, `Quit correctly`; `pk40/51` still 16 PASS / 2 FAIL, the known two): all six transfer-family actions read back amount, src and dst
equal to the wire values. **Not seen:** a request a real client sent (the wire format is the schema's, parsed by the engine's reader; a client's slot values were not observed), the `randomly` flag and
the filter cause at `+0x40` of the request through bdsx's classes, the `PlaceInItemContainer`/`TakeFromItemContainer` types (no wire id reaches them), `results_deprecated` (section 26).

**A real client's requests, 2026-10-02** (the live-bot harness, `findings-bot.md` section 10, `lb run stack`, both builds). The bot opened a
chest holding five diamonds and sent two ItemStackRequests, as the inventory screen does: take 2 from the chest to the cursor, then place
2 from the cursor in hotbar slot 0. Each came back `ok`, and the diamonds ended up in the hotbar. bdsx's reader returned what the wire said:
`#-3 Take 2 [7:0 id 4] -> [59:0 id 0]` and `#-5 Place 2 [59:0 id 5] -> [28:0 id 0]`. That is container (7), cursor (59) and hotbar (28),
the chest's stack id 4, and the cursor's stack id 5 from the take's own response.

## 28. `startLeaveGame`, `RecordItem`, and two left alone (2026-10-02, main)

**`?startLeaveGame@Minecraft@@QEAAX_N@Z`, shipped under the 2024 name** (40 `0x2e4140` / 51 `0x3787f0`, 373 B).

- 2024's only caller is the leave lambda (`_Do_call` `0xc71570`). It takes Minecraft from `ServerInstance+0xa8`, calls
  `startLeaveGame(true)`, then calls `ServerInstanceEventCoordinator::sendStartLeaveGame`.
- `sendStartLeaveGame` survives in 1.26 as a lambda scope. `tools/lambda-owner.mjs` names its builder (40 `0x6ae890` /
  51 `0x771000`, 286 B), and that builder is the 1.26 leave lambda: Minecraft from `ServerInstance+0xb8`, `mov dl,1`, then
  a call to this function.
- The body is 2024's, step for step:
  - the structure placement shutdown;
  - `[this+0xc0]`, then the ServerNetworkHandler shutdown through `+0x48`;
  - the bool-gated `+0xe8` variant block;
  - the ResourcePackManager at `+0x28`;
  - the tail call through `(this+0x18)->vtable`.
- The signature is unchanged, so bdsx's existing hook binds as it is.
- **Executed** (`conx40/51`): `events.serverLeave` fires once per `stop`, before `serverStop`, and `executeCommand("list")`
  inside it returns code 0.

**`??_7RecordItem@@6B@`: RecordItem is a ComponentItem subclass in 1.26** (40 `0xa6b4cd0` / 51 `0xa7df390`).

- `conprobe disc` read the Item vftable of three music discs. All three share this table, and none of diamond, stick
  (plain `Item`) or apple (`ComponentItem`) has it.
- The discs are also component items that carry `minecraft:record`.
- Against ComponentItem's table, it differs in exactly four slots, in Endstone `item.h` order: 3 `setDescriptionId`,
  94 `buildDescriptionId`, 116 `setIconInfo` and 117 `getIconInfo`. Those match 2024 `RecordItem`'s overrides.
- Slot 94 builds `"item.record.name"` with a 16-byte `movups` from a second copy of the literal. That is why
  `tools/string-users.mjs`, which follows `lea` to the NUL-terminated copy, found no user.
- bdsx changes (bdsx `d9a3b182`):
  - `RecordItem` now extends `ComponentItem`.
  - `isMusicDisk()` compares the vftable directly. 1.26's `ItemStackBase.getItem()` is a `derived()` read that skips
    `Item`'s resolver, so `instanceof` alone stayed false even with the address in the table.
- **Executed:** true for the three discs and false for the three other items, on both builds.

**`MapItemSavedData::_updateTrackedEntityDecoration`: left** (used only by `example_and_test/hidemapmarker.ts`).

- 2024 reached it from `tickCarriedBy` (124 B) through `_updateTrackedEntityDecorations`.
- In 1.26, `tickCarriedBy` is a lambda scope whose owner is 1123 B (40 `0x399bdf0` / 51 `0x371c520`), with two local
  callees (40 `0x399c260`, `0x399c420`) that match neither 2024 function by their calls.
- The map tracking was restructured, and the example's prototype (a `shared_ptr<MapItemTrackedActor>` by value) cannot
  be assumed.

**The `HelpCommand` trio: left.** bdsx uses it only for an assert on the `Command` vftable layout, guarded by `in proc`.
Plugin commands are confirmed by execution without it.

## 29. The release check: bdsx's stock examples on 1.26 (2026-10-03, agent-a)

Queue row 1 before the release: every example under `bdsx/example_and_test/` (and `bdsx/plugin-example/`) loads on
both builds without a red line beyond a known list, and what each prints is written down. Until now the stock
`example_and_test/index.ts` stopped at `lowlevel-asm.ts`, which threw at load, so nothing after it had run on 1.26
(`setblock`, `storage`, `test.ts`'s suite, `shoot-projectile`; `findings-bot.md` section 7).

### 29.1 How it was run

- **Per example**: `tools/host/index-release.ts` as the instance's `index.ts`
  (`--upload=tools/host/index-release.ts:C:/bdsx-again/inst<NN>/index.ts`), drivers `rel40`/`rel51`. The two
  `session.mjs` runs go side by side because `--upload` is per instance, so `verify-pair.mjs` cannot run them.
  - It `require`s the 41 examples and `plugin-example/index` one by one, inside try/catch. One that throws hides
    nothing after it.
  - Each `console.error` line printed during an example's load counts against that example. The output is
    `[exload] PASS|FAIL|KNOWN <name>`, and the known list is in the file. bdsx's cyan
    `[bdsx] ... using bdsx's own implementation` notes are not counted.
  - A live bot joins. The console runs every example command, the player-origin ones through
    `execute as @a at @s run ...`.
  - After the runner's `kill @a`, the bot's six `test` chats drive `test.ts`'s chat test, which stops the server
    itself through `bedrockServer.stop()`.
- **bdsx's own entry point**: `tools/host/index-examples.ts` (= the stock `import "./example_and_test"`), drivers
  `rels40`/`rels51`, run-full. The import chain reached its end: `storage.ts`'s counter and `test.ts`'s
  `[test] node version` were printed.
- Final-code transcripts are `work/host-runs/rel40-20261003-025749.txt`, `rel51-20261003-030602.txt`,
  `rels40-20261003-030602.txt` and `rels51-20261003-031428.txt`. All four had tsc 0, exit 0 and `Quit correctly`.
  The earlier passes are the `rel4x`/`rel5x` runs from 02:22.

### 29.2 Load verdicts (final code; the same on both builds)

| example | verdict | note |
|---|---|---|
| actor-effects, attribute, custommotd, setblock | PASS | Module-level intervals: effects every 1 s, health every 100 ms, the MOTD every 5 s, planks under each player every 100 ms |
| blockcustomname | PASS | Three cyan `CommandArea` notes |
| event-blockdestroy | PASS (known) | Red `?destroyBlock@SurvivalMode@@`. `blockevent.ts` installs 2024's hook beside the 1.26 one, and the event fires (2026-10-02) |
| hidemapmarker | PASS (known) | Red `_updateTrackedEntityDecoration` (section 28) |
| lowlevel-apihooking | PASS (known) | Red 2024 `useItemOn` and `_updateTrackedEntityDecoration` decorations |
| lowlevel-asm | **threw** -> PASS | `printf` had no address (29.3) |
| permissions (commented out of the stock index) | KNOWN | Upstream's own guard throws "The permissions system is currently on hold" |
| plugin-example | PASS | `[ExamplePlugin] allocated` / `closed` |
| the other 33 (net-* x14, lowlevel-dll/-nativeclass/-string-and-vector with all their asserts, form, storage, test, ...; entity, event-jump, net-chat-to-console, net-gametype, net-hud are not in the stock index) | PASS | |

After load, the only red lines are two `?startSwimming@Actor@@` lines from `test.ts`'s `events()` test, which installs
every event. `entityStartSwimming` fires through its 1.26 hook (bdsx `0f49dd03`).

### 29.3 Fixed (bdsx `e6b2fdbd`..`67b6bad9` and the tables)

- **`printf`** (used by `lowlevel-asm.ts`): 40 `0x342b960` / 51 `0x3426030`, 123 B.
  - Found by the IAT anchor, as `vsnprintf` was. Three functions call through `__stdio_common_vfprintf`. This is
    the only one that first calls `__acrt_iob_func(1)` and passes `rcx` as the format, step for step 1.21.3.01's
    `printf` (`0x2302e50`).
  - The other two are an `fprintf` (the `FILE*` in `rcx`) and a function that is not a wrapper.
  - Executed: `[example/lowlevel-asm] Hello, World!` on both builds, and both `console.assert`s held.
- **`executeCommand(..., Data)` had an empty `statusMessage`**. This was the gap noted in `findings-scoreboard.md`
  section 5.
  - The command now runs with output on. A first `events.commandOutput` listener collects the lines that
    `CommandOutputSender::send` hands on, and cancels them unless Output was asked for.
  - Executed: `executecommand.ts` prints `There are 0/10 players online:` (empty before), and `test.ts`'s
    `statusMessage` checks pass.
- **`ConnectionRequest.getJson/getDeviceId/getDeviceOS` threw "Json object not found"**. As a result,
  `net-login.ts` printed nothing and `net-disconnect.ts` printed `undefined> disconnected`.
  - In 1.26 the client data is the request's own `std::optional<WebToken>` at +0x8. Endstone `web_token.h`
    gives it 0x80 bytes, with the data `Json::Value` at +0x50. So the payload is at +0x58 and the engaged byte at
    +0x88, just before the game server token at +0x90 (Certificate section).
  - Shipped as `layouts.ConnectionRequest.clientDataJson`/`clientDataEngaged`.
  - Executed, two sides:
    - With `BP_DEVICE_OS=7`, 40 prints `PLATFORM=WINDOWS_10`.
    - With the bot's default, 51 prints `PLATFORM=NINTENDO`. That is 12, the `build_platform` the server's own
      `player_list` sends.
    - `test.ts`'s `actor` check `player.deviceId === fetchConnectionRequest(ni).getDeviceId()` passes on both.
    - `net-disconnect.ts` prints `bdsxprobe> disconnected`.
- **`bedrockServer.stop()` killed the server**: rel40 at 02:38 printed `Server stop requested.`, then 0xC0000005
  with no report.
  - bdsx called `DedicatedServer::stop` at `dedicatedServer+8`. That was AppIsland's base in 2024, behind
    IMinecraftApp's vptr.
  - The 1.26 constructor (40 `0x78800` / 51 `0x78890`) stores one vftable,
    `??_7DedicatedServer@@6BAppIsland@Bedrock@@@`, at +0. The live `this` of `stop` carried it
    (`findings-instances.md`), so the `xchg [this+0x48]` stop flag landed at +0x50.
  - Shipped as `layouts.DedicatedServer.stopThis` = 0.
  - Executed: the chat test's `bedrockServer.stop()`, called from a timer, ends in `Stopping server...` and
    `Quit correctly` (exit 0) on both builds.
- **`executeCommandOnConsole`'s 1.26 fallback** passed `__dummy_command` to listeners. A console line arrives as
  `/tp ...`, so the fallback now adds the slash.
- **Two wrong 51 entries, retracted**:
  - `?getId@PlayStatusPacket@@` (`0x28d550`) is `mov eax,3; ret`.
  - `?getId@ServerToClientHandshakePacket@@` (`0xa20220`) is `mov eax,4; ret`.
  - The vftable walk named both off by one. `test.ts`'s `checkPacketNames` found them by calling them. bdsx
    requires neither. The other 18 `getId` entries across the two builds return their own ids.
- **`test.ts` brought to 1.26**:
  - The unknown-command check also accepts `Syntax error: Unexpected "__dummy_command"`.
  - Attribute ids go through `nativeIdOf`.
  - `PassengerJump`, `PlayerInput`, `LevelSoundEventV1/V2` and `CompressedBiomeDefinitionList` are known
    not-created packets.
  - `getName()` stands in where the table has no `getId` by name. `ItemComponentPacket` is the engine's
    `ItemRegistryPacket`.
  - The 53 ids with no bdsx class are listed rather than failed.
  - The certificate identity is checked as a uuid, with no `Json::Value` behind the 1.26 view.

### 29.4 What the examples print at runtime (final code, both builds)

- `customcommand.ts`: `aaa`..`nnn`, both `kkk` overloads, `lll`'s soft enum (`Values: hello, world, foo`) and
  `whoami` (`You are the server console`) print their documented output.
- `net-ping.ts`: from the console, `You are Server`. Through `execute as`, the bot's average, last and lowest ping
  (0-1).
- `nbt-sign.ts`: the bot gets the `NBT` form with the sign's tag. `form.ts`: the modal, the custom form,
  `Alt Form` and `form2`'s `button2 selected` all reach the bot.
- `shoot-projectile.ts`: `(1) entities successfully shoot snowball.`; `entity.ts`: `Summoned an entity: pig`;
  `simulatedplayer.ts`: `Spawned SimulatedPlayer relsim`.
- `storage.ts`: the global counter goes up once per boot, and the player's `lastLoginDate`/`attendance` are
  printed at join.
- `net-login.ts`: `Connection: bdsxprobe> IP=127.0.0.1|<port>, XUID=, PLATFORM=...`. `net-chat.ts`: `test` is
  rebroadcast as `TEST YEY!`.
- `furnace`, `sign`, `example_score`, `bdsxtitle`, `set-hud`, `form` and `form2` through `execute as`: the engine
  adds `Failed to execute '<name>' as bdsxprobe` because these send no success message. They do run: the forms
  arrive.
- `net-printall.ts`, `net-rawpacket.ts` and `inventory.ts` print nothing. They are gated on the tester passing,
  and the suite fails (29.5).

### 29.5 Known, left

- **`net-scorepacket.ts`**: `Access Violation: 0x0` in `CxxVector.push` of `SetScorePacket.entries`
  (`net-scorepacket.ts:27`), on both builds. The JS error is caught and the server lives.
  - `SetScorePacket` and `ScorePacketInfo` are 2024 layouts, and Endstone's `set_score_packet.h` has only the enum.
- **`packetBefore`/`packetAfter` fire for packets the server sends to a SimulatedPlayer**, with no `packetRaw`
  before them.
  - `test.ts`'s `packetEvents` prints 3,000-5,000 `unexpected phase` lines per run, on clientbound ids 19, 21, 28,
    29, 39 and 111. The harness's `[exload] cmd` lines put every one of them after `spawnsimulatedplayer`.
  - The dispatcher vptr swap (`findings-packets.md` section 2) also sees the loopback's dispatch. 2024's patch in
    `_sortAndPacketizeEvents` saw only network packets.
  - **Kept as intended (user decision, 2026-10-03).** The packets go through the same dispatcher, and
    `SimulatedPlayer` is a `Player`, so firing for them is the right behaviour on 1.26, not a bug to filter. A
    plugin that wants network packets only checks the player or `packetRaw`. `test.ts`'s `packetEvents` failure
    under a spawned simulated player is expected; not a queue item.
- **`command.rawEnum("GameMode")` gives the string `default`, not 5.** `commandParser.getType` knows a built-in
  enum's parser by address, and the `parseEnum<...>` instances are among the red boot lines.
  - `test.ts`'s `commandrawenum` fails. `commandenum`'s `mappercheck` and `commandregister`'s `cmdtest2` fail with
    it as collateral: the concurrent tests share `events.commandOutput`, and `raw0`'s `failed` rejects every
    waiting listener.
- **`test.ts`'s `command`** expects the console's request id `00000000-0000-0000-0000-000000000000`.
  - On 1.26, `executeCommandOnConsole` runs through `bedrockServer.executeCommand`, whose origin's request id is
    `Server`.
  - Real console lines do carry the zero uuid on 1.26 (the harness logs each command's request id).
- **Suite totals**:
  - 40: `TEST FAILED (31/36)`.
  - 51: the same five failures: `command`, `commandenum`, `commandrawenum`, `commandregister`, `packetEvents`. The
    chat test stopped the server before the total printed (30 passed at the last count).
  - The suite had never run on 1.26 before. On its first run it also failed `checkPacketNames`, `attributeNames`
    (51) and `actor`.
- **The 51 bot and `BP_DEVICE_OS=7`**: with Windows 10 as the device OS (also with `BP_DEVICE_ID`), the 51 bot was
  closed 1.7 s after connecting, three runs of three. 40 takes it, and 51 takes the default (12). `rel51` sends
  neither.

