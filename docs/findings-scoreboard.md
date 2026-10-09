# The scoreboard on 1.26 (Q1-C)

Started 2026-09-24. 16 required `Scoreboard`/`Objective`/`ScoreboardIdentityRef` names were missing on both builds,
and `objectiveCreate`/`scoreReset` had no target. Endstone (Apache-2.0) reimplements the non-virtual scoreboard API
over the 1.26 layout (`work/endstone/src/bedrock/world/scores/`), which says which functions Endstone did not want
to depend on — not that they are gone. Each name is checked for an out-of-line copy first.

## 1. `ServerScoreboard`'s vftable (40 `0xa52ebc0`, 51 `0xa650ec0`)

Laid against Endstone's `scoreboard.h` virtual order: 0 destructor, 1 `setDisplayObjective`, 2
`clearDisplayObjective`, 3–5 the three `createScoreboardId` overloads (reverse order, MSVC), 6 `onObjectiveAdded`
(40 1146 B), 7 `onObjectiveRemoved`, 8 `onScoreChanged`, 9 `onPlayerScoreRemoved` (40 678 B), 10
`onPlayerJoined`, 11 `onPlayerIdentityUpdated`, 12 `tick`, 13 `setPacketSender`, 14 `writeToLevelStorage`, 15
`isClientSide`. Sizes read on 40; not yet used for anything shipped.

## 2. `Scoreboard::addObjective` — shipped, `objectiveCreate` done on both builds

The only function that references `"commands.scoreboard.objectives.add.success"` is the scoreboard command handler
(40 `0x3d850a0`, 51 `0x3b1dcf0`). It calls **40 `0x133c40` / 51 `0x266b7d0`** with `(scoreboard, name,
displayName = parsed command +0xb0, criteria)` — the same instruction sequence on both builds — and branches on a
null return to `"…add.alreadyExists"`. The body (2934 / 2768 B) starts with FNV-1a-64 of the name (the
`objectives_lookup_` lookup) and ends in `this->vtable[6]` (`onObjectiveAdded`), the order of Endstone's
`addObjective`. The 2024 prototype holds, so bdsx's hook is unchanged.

**Execution** (`score40`/`score51`, `tools/block-probe.ts` `objprobe`, `SCORE_PROBE=1`; tsc 0, exit 0, `Quit
correctly`; 2/2 PASS each): with the listener returning `CANCEL`, `scoreboard objectives add probe_blocked dummy
Blocked` fires the event (name and display name read back) and `Scoreboard::getObjective` then returns null (the console then says "An objective with the name … already exists": the handler reads
any null from `addObjective` that way);
allowed, `probe_allowed` fires and `getObjective` returns the objective.

## 3. `scoreReset` — on `ScoreboardIdentityRef::removeFromObjective`, done on both builds

`Scoreboard::resetPlayerScore(id, objective)` has **no out-of-line copy** on either build: it is written out in
its callers — `ServerScoreboard::onObjectiveRemoved`'s bulk removal (40 `0x135670` / 51 `0x266d0a0`), the
all-objectives `resetPlayerScore(id)` (40 `0x135f70`), the `players` command handler (40 `0x3d86cd0`) and a
script binding. Every copy ends the same way: find the id in `objective+0x18`, find its identity ref in
`scoreboard+0x150`, call `this->vtable[9]` (`onPlayerScoreRemoved`), then **40 `0x135e30` / 51 `0x266d600`**
`(identityRef, scoreboard, objective)`. That callee erases the score from the objective, notifies the event
coordinator (`scoreboard+0x258`) and clears the identity — 2024's inlined `resetPlayerScore` tail
(`Objective::_resetPlayer`, `sendOnScoreboardIdentityRemoved`, `clearIdentity`) — and is what Endstone declares as
`bool ScoreboardIdentityRef::removeFromObjective(Scoreboard&, Objective&)`, so it ships under that decoration and
bdsx's `scoreReset` hooks it. The identity ref reads its `ScoreboardId` at +8, bdsx's existing layout.

**A bdsx bug on the cancel path**: upstream decayed `idRef` before `scoreboard.sync(idRef.scoreboardId, …)`; the
read threw `This object is decayed`, and the removal went ahead. Now the re-send comes first.

**Execution** (`score40`/`score51`; tsc 0, exit 0, `Quit correctly`; 4/4 PASS each, with the `objprobe` pair):
the bot's `probe_reset` score set to 7; `scoreboard players reset` with the listener cancelling → the console's own
`scoreboard players test @a probe_reset 7 7` answers "Score 7 is in range"; allowed → "Player bdsxprobe has no
scores recorded".

**Found on the way**: `bedrockServer.executeCommand` throws on 1.26 — `??0CommandContext@@QEAA@…` is in neither
table. It is the API plugins use to run commands and read results; queued.

## 5. `bedrockServer.executeCommand` on 1.26 — the engine runs the command (done on both builds)

bdsx's `executeCommandWithOutput` drove `CommandRegistry::Parser` itself (constructor, `parseCommand`,
`createCommand`, error getters, destructor) and built its own `CommandOutput`. None of that was in the 1.26 tables
(section 12 ships the parser, 2026-09-28), and it is not a naming gap: in Endstone's `MinecraftCommands::compileCommand` (40 `0x39afd0`) the parser runs
inline — `0x33e390(&parser, registry, version)` (11 KB, the constructor with its initialisation),
`0x341280(&parser, string)` (`parseCommand`), then `CommandRegistry::createCommand` directly (`0x33c3b0`,
`Parser::createCommand`'s 89-byte 2024 wrapper is gone), `0x341590` (an error getter), `0x3416d0` (`~Parser`).
`MinecraftCommands::executeCommand` (40 `0x38b570`) does the same and then picks `MCRESULT_Success` or
`MCRESULT_ExecutionFail` by the output's success count (`output+0x28`).

So on a table without `Parser`, bdsx now lets the engine do it: `CommandContext`'s constructor is a `derived()`
(1.26 builds it inline too; the layout is unchanged — string +0, `unique_ptr<CommandOrigin>` +32, version +40,
Endstone `command_context.h`), and `MinecraftCommands::executeCommand(ctx, suppressOutput)` is called through
bdsx's own wrapper, so `events.command` fires once. `MCRESULT::isSuccess`/`getFullCode` are `derived()` (layout
unchanged: success, category, u16 code; 1.26 inlines both). **Gap**: `CommandResultType.Data` gets `statusCode`
but an empty `statusMessage` and no property-bag fields — the messages live in the engine's own `CommandOutput`.

**Execution** (`exec40`/`exec51`, `tools/block-probe.ts` `execprobe`; tsc 0, exit 0, `Quit correctly`; 4/4 PASS
each): `setblock … gold_block` muted → success, the block reads back gold; `testfor` on a mob that does not exist
→ failure (`0x80020000`, ExecutionFail); `setblock … stone` with output → success, stone; `events.command` saw all
four. One false alarm on the way: `setblock` onto the block already there is a real engine failure (the blk
probes leave gold at that spot), so the probe clears it first.

## 6. The read API and the two mutations — `derived()` over layouts, done on both builds

The members Endstone's headers declare, with offsets the 1.26 bodies read identically on both builds
(`layouts.Scoreboard`/`Objective`/`IdentityDefinition`, `bds/engine/scoreboard.ts`):

| container / field | offset | read by 1.26 code |
|---|---|---|
| `Scoreboard::display_objectives_` | +0x10 | (Endstone count: vptr + registry = 16 bytes) |
| `IdentityDictionary` players_ / entities_ / fakes_ / identity_defs_ | +0x50 / +0x90 / +0xd0 / +0x110 | `removeFromObjective`'s `clearIdentity` at +0x50 |
| `identity_refs_` (ScoreboardId → ScoreboardIdentityRef) | +0x150 | every reset copy, `+0x158` = its list head |
| `should_update_ui_` | +0x190 | the bulk removal writes it |
| `objectives_` (string → unique_ptr<Objective>) | +0x198 | the all-objectives reset walks `+0x1a0` |
| `criteria_` | +0x218 | |
| event coordinator | +0x258 | `removeFromObjective` |
| `Objective::scores_` / name / display name / criteria | +0x18 / +0x58 / +0x78 / +0x98 | the last three are bdsx's 2024 fields, unchanged |
| `IdentityDefinition` player_id_ / entity_id_ / identity_type_ | +24 / +32 / +72 | |

Every container is an MSVC `std::unordered_map`, walked from its list head (+8), node value at +16. On that,
bdsx now carries as `derived()`: `getCriteria`, `getDisplayObjective`, `getObjectiveNames`, `getObjectives`, the three
`getScoreboardId` overloads, `getScoreboardIdentityRef(s)`, `getTrackedIds`, `Objective::getPlayers`/
`getPlayerScore`/`getName`/`getDisplayName`, the four `ScoreboardIdentityRef` getters, and `resetPlayerScore(id,
objective)` written as the inlined 1.26 sequence (score exists → identity ref → `vtable[9]` notification →
`removeFromObjective`). **`removeObjective` does exist**: 40 `0x1348e0` / 51 `0x266c3c0` (1806 B on both), called
from the `objectives remove` branch with the objective just looked up; null check, the name at +0x58, the map, then
`vtable[7]` — Endstone's order. Shipped.

**Execution** (`score40`/`score51`, `sbprobe`, `SCORE_PROBE=1`; tsc 0, exit 0, `Quit correctly`; 23/23 PASS each with
the earlier checks): the bot's score 42 set by the console read back through `getPlayerScore`, an objective without
its score reads `valid=false`, `getPlayers`/`getTrackedIds` contain the bot, its identity ref has type Player and
`getPlayerId` = the bot's unique id, `getCriteria("dummy")` found and an unknown one null, `getDisplayObjective`
returns what `setdisplay sidebar` set and nothing for `list`; a pig given a score: its identity ref (type Entity) →
`getEntityId` → `Level::fetchEntity` is the pig → `getScoreboardId(pig)` returns the same id with score 5; the fake
player `probe_fake` → score 3, type 3; `resetPlayerScore` through bdsx removes the score (the console then finds
none) and `removeObjective` through bdsx removes the objective.

## 7. `modifyScoreInObjective` — found, prototype changed, done on both builds

**40 `0x131370` / 51 `0x2667dc0`**, 296 bytes, instruction-identical apart from addresses. It is 2024's
`ScoreboardIdentityRef::modifyScoreInObjective` with `Objective::_modifyPlayerScore` inlined: look `this+8` up in
`objective+0x18`; if `objective+0x98 → criteria+0x20` (read-only) return 2; else insert the id if absent, apply
Set/Add/Subtract (the 5th argument; Add/Subtract return 1 on int overflow), write the score and `*result`, bump
`objective_references_` for a new entry, return 0. **The return type changed**: 2024 `bool` (true = success), 1.26
`ScoreboardOperationResult` (0 = Success) — Endstone declares exactly this, so it ships under Endstone's decoration.
On 40 it is the only callee of the `players` handler with the read-only check; on 51 it was found by that shape
(the only one in the scoreboard code region). The lead in the previous version of this section (`0x136080`) was
`applyPlayerOperation`-shaped and not it; the tell was the `incl (%rdi)` reference-count bump.

**bdsx change**: `_modifyScoreInObjective` binds the new name and reads a `uint8_t`; the `scoreSet`/`scoreAdd`/
`scoreRemove` hook returns the enum, and a cancelled change writes 0 to `result` and answers **ReadOnlyCriteria (2)**,
the engine's own "this score cannot change" (2024 returned `false`; returning 0 would now mean Success). The
console prints nothing for a cancelled `players add`.

**Execution** (`mod40`/`mod51`, `modprobe`; tsc 0, exit 0, `Quit correctly`; 4/4 PASS each): `players set … 10`
fires `scoreSet`; `players add … 5` with the listener cancelling fires `scoreAdd` and the console's
`scoreboard players test` still finds 10; `players remove … 3` fires `scoreRemove` and leaves 7; bdsx's
`setPlayerScore`/`addPlayerScore` give 100 then 105, read back by bdsx and by the console.

With this, every scoreboard name bdsx requires resolves on both builds (by address or `derived()`).

## 8. Command soft enums — `addSoftEnum` shipped, `updateSoftEnum` `derived()`, done on both builds

The objective list `/scoreboard` completes from is the `ScoreboardObjectives` soft enum, so soft enums live here.
Soft enums work on both builds through bdsx's own code; a plugin command that *uses* one cannot be registered yet,
for reasons that have nothing to do with soft enums (8.4).

**8.1 The registry's soft-enum members did not move.** `CommandRegistry::soft_enums_` (`std::vector<SoftEnum>`,
`{ std::string name; std::vector<std::string> values; }`, 0x38 bytes) is at +0x230 and `soft_enum_lookup_`
(`std::map<std::string, uint32_t>`, name -> index) at +0x248 on both builds, the 2024 offsets bdsx already had.
Endstone's `command_registry.h` (+560/+584 in 0.11.7 and HEAD), every 1.26 body below, and execution agree: the probe
walked the vector and every name mapped back to its own entry (12/12 on 40, 14/14 on 51). At boot 40 has
`ScoreboardObjectives TagValues UnlockableRecipeValues FunctionName ItemTag StructureFeature JigsawStructure
EntityEvents CameraPresets GameTestName GameTestTag Tool`; 51 adds `poi_type_tag` and `poi_type`.

**8.2 Addresses.** `addSoftEnum` (40 `0x365b30` 1429 B, 51 `0x1242eb0` 1275 B): the 2024 body (1.21.3.01 `0xd44590`)
is one of only six functions there combining the Symbol bits `0x4100000` with the +0x248/+0x230 displacements (the
six soft-enum members); scanning every `.pdata` function for the three immediates (`00001004`, `48020000`,
`30020000`) gives exactly one ordinary-sized function per 1.26 build (other hits: 80-90 KB command setups and a
1.7 MB blob). Read in full: rcx `this`, rdx `const std::string&`, r8 the by-value `std::vector<std::string>` (moved
from, destroyed on exit, as 2024). A known name goes to `addSoftEnumValues` and returns the stored index
`& 0xe00fffff`; a new one emplaces the entry, inserts name -> index, registers the `Id` (0x100038) rule and returns
`index | 0x4100000`. The decoration is unchanged (Endstone declares the same signature).
`addSoftEnumValues` / `removeSoftEnumValues` / `setSoftEnumValues` (40 `0x376d60` / `0x3773d0` / `0x376fc0`, 51
`0x1252ba0` / `0x12531d0` / `0x1252e00`; 476 / 515 / 334 B on both, 2024 512 / 582 / 332 B): the packet's constructor
is inlined into its senders, so the seven functions per build that `lea ??_7UpdateSoftEnumPacket@@6B@` are the
candidates. Three look the name up in +0x248 (absent: return), index +0x230 by 0x38, and send the packet with type
0 (append each value not already there -- 1.26 de-duplicates), 1 (erase every entry equal to a value) or 2
(move-assign the vector) through the `std::function` at +0 (impl +0x38, skipped when empty). Same arguments as
`addSoftEnum`.

**8.3 `CommandSoftEnumRegistry::updateSoftEnum` is inlined, so it is `derived()`.** 2024's (`0xd55ec0`, 475 B) is a
switch on the type into the three members (Replace inlined); its only callers were `onObjectiveAdded`/
`onObjectiveRemoved`. In 1.26 `onObjectiveAdded` (40 `0x13c0f0`, slot 6) calls `addSoftEnumValues` itself; the only
callers of that are `addSoftEnum`, `onObjectiveAdded`, the loot command's setup and one tag-cache function. bdsx
carries the switch: `derived()` in `bds/command.ts` over `engine/softenum.ts` (`engineSymbol` on the three).
Execution, 2026-09-27 (`tools/softenum-probe.ts`, drivers `se40`/`se51`, `verify-pair`, 14 PASS / 0 FAIL each, tsc 0,
exit 0 + `Quit correctly`; `work/host-runs/se40-20260927-173011.txt`, `se51-20260927-173011.txt`):
- The engine's writes, both sides: `seprobeobj` is in no soft enum before `scoreboard objectives add seprobeobj
  dummy`, in exactly `ScoreboardObjectives` after, and in none after `scoreboard objectives remove`.
- bdsx's path: `command.softEnum("seprobe_enum", "alpha", "beta")` (`addSoftEnum(name, [])` + `updateSoftEnum(Add)`)
  made entry 12 (40) / 14 (51) holding `[alpha,beta]`; Add `[gamma,alpha]` -> `[alpha,beta,gamma]`; Remove `[beta]` ->
  `[alpha,gamma]`; Replace `[x,y]` -> `[x,y]`; `CommandSoftEnum.getValues()`/`getValueCount()` agree.
- `addSoftEnum`'s two paths: a new name returned `0x410000d` (40) / `0x410000f` (51), its index `| 0x4100000`, and grew
  the vector by one; the same name again returned the bare index and appended. An Add for an unknown name changed nothing.
- The `UpdateSoftEnumPacket`s went to no client (console-only session): a client's autocomplete is not checked.

**8.4 Registering a plugin command that uses one** was blocked on `findCommand` and the 1.26 `Overload`/
`CommandParameterData` shapes; done 2026-09-27, section 9.

## 9. Plugin command registration -- `command.register` works again, done on both builds

`command.register(name, ...).overload(cb, params)` runs 2024 bdsx's own sequence (`registerCommand`, `findCommand`, push
an `Overload` onto the signature, `registerOverloadInternal`); what changed is two structures and three things the
structures point at. All static facts are the same on both builds; addresses 40 / 51.

**9.1 `findCommand` has an address** (40 `0x341a80`, 51 `0x1222700`), so it is not `derived()`. Found as the first call of
the engine's no-parameter registerOverload helper (40 `0x1157d0`, 51 `0x115530`, carried in the tables under a wrong
`_Emplace_reallocate` name): body read on both, rcx `this`, rdx `const std::string&`, the name lower-cased, looked up in
`signatures_` (+0x1b0), else in `aliases_` (+0x1d0) and then `signatures_[target]`; returns `&node->value` or null --
Endstone's re-implementation plus the lower-casing. Shipped under the 2024 decoration (Endstone declares it `const`; the
calling convention is the same).

**9.2 `CommandParameterData` is 0x78 bytes** (the engine's inlined int-parameter constructor, 40 `0x3fb230`, and 51's
out-of-line one, `0x1213d60`, both read): +0 type id, **+8 `const ParamParseRule*`**, +0x10 `parse_override`, +0x18 name,
+0x38 enum name/postfix, +0x40 its symbol (-1), +0x48 chained subcommand, +0x50 its symbol (-1), +0x54 type, +0x58
offset, +0x5c set offset, +0x60 optional, +0x61 options, +0x68/+0x70 custom-storage functions. `registerOverloadInternal`
(40 `0x36c4b0`, 51 `0x1248da0`) walks the parameters at stride 0x78 from `Overload+0x48`; the rule builder (40
`0x36de50`) takes a parameter's grammar symbol from +0x40, else +0x50, else **`parse_rule->symbol`** (else 0). That is why
+8 can no longer be the bare parse function.

**9.3 The parse rules.** `ParseRuleFor<T>::instance` statics live in `.data` bss and are filled by one dynamic initializer
(`lea rax,parse<T>; mov [inst],rax; mov dword [inst+8],sym`): 21 rules on 40, 23 on 51, same order. Shipped as
`bdsx:CommandRegistry::ParseRuleFor<int>::instance` (40 `0xc8c4988`, 51 `0xcc89d78`, symbol 0x100001 Int) and
`<std::string>` (40 `0xc8c4998`, 51 `0xcc89d48`, 0x100038 Id), and their parse functions under the 2024 names
`??$parse@H@CommandRegistry@@...` (40 `0x330d70`, 51 `0x1215220`; digits and `-`, "commands.generic.num.invalid") and
`??$parse@V?$basic_string...` (40 `0x3312b0`, 51 `0x1215700`; `ParseToken::toString` moved into the storage, 2024's
shape). `engine/command.ts` picks the rule whose first word equals the type's parse function. Other types (float,
selectors, positions, message, json...) have rules in the same initializer (symbols Val 0x100003, Selection 0x100008 x2,
WildcardSelection, Position, PositionFloat, MessageRoot, RawText, JsonObject, ...) but not identified by body: a
parameter of such a type throws "no command parse rule" at registration. Enum parameters get no rule: the engine gives
them the enum's symbol and parse override. Untested.

**9.4 `Overload` is 0x80 bytes**: +0 version, **+8 a 64-byte `brstd::copyable_function<unique_ptr<Command>() const>`**
(`{ vfptr; target... }`), +0x48 parameters, +0x60 version offset, +0x64 is_chaining, +0x68 symbol vector (the engine's
emplace, 40 `0x1157d0`). The list command's setup builds its allocator as vfptr `0xa52d510` (51 `0xa64c4b0`) + target
`allocateCommand<ListCommand>`; that vtable's slots read: move/copy copy the qword at +8, destroy is `ret`, invoke calls
`[storage+8]` with the caller's rcx (the unique_ptr return slot). That is 2024's allocator convention, so bdsx's allocator
goes in the target slot unchanged (`bdsx:CommandRegistry::Overload::AllocFunction::fnptr_vftable`). bdsx relocates
overloads bytewise (a generated move would copy only the declared words).

**9.5 Also needed:** the `typeid_t<CommandRegistry>` counter (40 `0xc8b8330`, 51 `0xcc1ed80`; the `lock xadd` behind the
type-id statics compared in `registerOverloadInternal` and the int constructor's `type_id<CommandRegistry,int>`), so
bdsx's `type_id()` draws fresh ids the engine's `type_lookup_` does not map to an enum; and
`Command::collectOptionalArguments` on 40 (`0xa2650`, slot 1 of `ListCommand`'s table `0xa6fb080`, `mov al,1; ret`; 51's
`0xa2880` was already shipped and is the same slot of `0xa8126b0`).

**9.6 A wrong address found on the way.** On 51 the first run died with 0xC0000005 right after the command's callback,
which called `output.success()`. 51's `?success@CommandOutput@@...` came from call-edge propagation (`0xed3a0`) and is a
`std::vector` destructor (frees 0x28-byte string elements from `[rcx]..[rcx+8]`, zeroes the vector): retracted in
`candidates-instances-1.26.51.1.json`. 40's (`0x12f19e0`, also propagation) was not read against a real success; the probe
no longer calls it. CommandOutput's API is its own item.

**9.7 Execution, 2026-09-27** (`tools/softenum-probe.ts`, drivers `se40`/`se51`, `verify-pair`, 12 PASS / 0 FAIL each on
the second run, tsc 0, exit 0 + `Quit correctly`; `work/host-runs/se40-20260927-175700.txt`, `se51-20260927-175700.txt`):
- The rule's parse word equals the table's `parse<int>` / `parse<std::string>` and its symbol is 0x100001 / 0x100038.
- `findCommand("list")` non-null and `findCommand("seprobecmd")` null before; after `command.register` + `overload({ n:
  int32_t, v: softEnum("seprobe_cmdenum") })` one overload with two parameters. After `registerOverloadInternal` the int
  parameter is still basic (type 0, symbol -1, the int rule) and the soft-enum one has type 2 and symbol `index |
  0x4100000` (40 `0x410000e`, 51 `0x4100010`) -- the engine read bdsx's layout.
- From the console: `seprobecmd 42 red` ran the callback with n=42 v=red (origin `Server`); `seprobecmd abc red` did not run
  it (parse<int> refused); `bedrockServer.executeCommand("seprobecmd 5 green")` ran it with 5/green.
- `seprobecmd 7 blue` also ran, with v=blue: **a soft enum does not restrict what the server accepts** (addSoftEnum gives its
  symbol an `Id` rule, section 8.2); its values are what clients are offered. Autocomplete in a client is not checked.
- Regression: `layout` 27/27 and `sig` (events fired) clean on both builds after the change.
- `example_and_test/customcommand.ts` now stops at its first `CommandRawText` parameter with the "no command parse rule"
  error (it stopped at `findCommand` before).

## 10. Plugin command output and parameter types -- done on both builds

A registered command can now report success or failure, and nine more parameter types parse. Static facts are the same
on both builds unless noted; addresses 40 / 51.

**10.1 `CommandOutput` keeps 2024's layout, and only `addMessage` is out of line.** The layout is type +0, property bag
+8, messages +0x10 (0x40-byte `CommandOutputMessage`: type +0, id +8, params +0x28), success count +0x28 (Endstone
`command_output.h`, and every body below). `ListCommand::execute` (vftable slot 2, 40 `0x3d10080`, 51 `0x3aa42d0`) does
`cmp [output],0; je`, then calls 40 `0x12f19e0` / 51 `0x1211560` with r9d=0. That is 2024's `forceOutput`, inlined. It
then does `inc dword [output+0x28]`, which is `success()`, inlined. Both builds have that callee's body instruction for
instruction; it is 2024's `addMessage` (`0xcc1ba0`). It clears the messages when the type is LastOutput. It copies each
0x28-byte parameter whose count (+0x20) is not -1 and appends one message typed by r9d. **The id is now a
`std::string_view`**: rdx is read as {data +0, size +8}, and every caller builds that pair on the stack. So it ships as
`bdsx:CommandOutput::addMessage`. The 2024 decoration takes `const std::string&`.

`success(id, params)` and `error(id, params)` have no out-of-line copy. Among addMessage's 792 call sites the smallest
caller is 122 bytes. Both are inlined next to each other in a kill-style execute (40 `0x3ba340..0x3ba3ec`, with the
`.success` and `.failed` ids). success sums the parameters' counts; unless the sum is -1 it adds max(1, sum) to the
count; then, if `(type & ~2) != 0` and the id is not empty, it adds a Success message. error adds an Error message
unless the type is None. That is 2024's `0xcd8270` / `0xcc4d50` exactly. So `success()`, `success(id, params)`,
`error(id, params)`, `getSuccessCount`, `getType` and the 2024-named `addMessage` are `derived()` in
`engine/command.ts` / `bds/command.ts`.

Two propagated addresses were wrong. 40's `?success@CommandOutput@@...` (`0x12f19e0`) is addMessage. 51's
`?addMessage@CommandOutput@@...` (`0xed490`) is a `std::vector<CommandOutputParameter>` constructor (count in rdx,
0x28-byte elements). Both are retracted in `candidates-instances-<v>.json`. 51's `?success` (`0xed3a0`, section 9.6)
was already retracted.

**10.2 The parse rules, named by body.** The initializer is a run of 32-byte functions (40 `0x3417e0..0x341a60`, 51
`0x1222420..0x12226e0`). Each is `lea rax,parse; mov [inst],rax; mov dword [inst+8],symbol; ret`.
A scan for that byte pattern finds 21 rules on 40 and 23 on 51. The first twenty have the same symbols in the same
order. 40's 21st is 0x100058; 51 has 0x10005a there and adds 0x100057 and 0x100058 at the end. Named and shipped
(`bdsx:CommandRegistry::ParseRuleFor<T>::instance`, instance 40 / 51):

| T | symbol | instance | parse (40 / 51) | body, against 2024's `parse<T>` |
|---|---|---|---|---|
| `float` | Val 0x100003 | `0xc8c4a20` / `0xcc89d98` | `0x3310c0` / `0x1215510` | token to string, then `Util::toNumber<float>(string_view, float& storage)`; `commands.generic.num.invalid` on failure (2024 `0xd2fc20`) |
| `RelativeFloat` | RVal 0x100004 | `0xc8c4a08` / `0xcc89b40` | `0x33c220` / `0x121d140` | `readRelativeCoordinate(&storage+4 relative, &storage value, token, false, ...)`, 2024 `0xd311e0` |
| `CommandWildcardInt` | WildcardInt 0x100005 | `0xc8c4940` / `0xcc89b50` | `0x3314d0` / `0x1215920` | token type 0xd gives {1, -1}; otherwise bool +0 = 0 and an int at +4 (2024 `0xd31040`) |
| `CommandPosition` | Position 0x100040 | `0xc8c49a8` / `0xcc89d88` | `0x33c260` / `0x121d180` | three `readRelativeCoordinate` into +0/+4/+8 with the flags at +0xc/+0xd/+0xe, centred for x and z; `local` +0xf when the token is `^` (2024 `0xd30d40`) |
| `CommandPositionFloat` | PositionFloat 0x100041 | `0xc8c49d8` / `0xcc89b90` | the same function | 2024's `0xd30e00` was a `jmp` to the `CommandPosition` parse |
| `CommandRawText` | RawText 0x100046 | `0xc8c4890` / `0xcc89db8` | `0x33c740` / `0x121d660` | the span from the token to the end of the line becomes a `std::string` moved into +0 (2024 `0xd30f70`) |
| `CommandSelector<Actor>` | Selection 0x100008 | `0xc8c4a38` / `0xcc89da8` | `0x33c1f0` / `0x121d110` | forwards to `parseSelector` (40 `0x33a9c0`, 51 `0x121cd20`) with the flag byte 0, as 2024's `0xd2fde0` |
| `CommandSelector<Player>` | Selection 0x100008 | `0xc8c49f0` / `0xcc89d68` | the same function | 2024 folded Actor and Player into one parse too |
| `WildcardCommandSelector<Actor>` | WildcardSelection 0x10000a | `0xc8c4a68` / `0xcc89ba0` | the same function, flag 0 | 2024's wildcard parse passed 1. **Not run through a command**: only the rule's words are checked |

Which Selection rule is Actor and which is Player comes from the commands that use them. `testfor`'s setup (40
`0x3c98ae0`, 51 `0x3a263b0`) registers its victim with the first rule; its `type_id` static sits next to it (40
`0xc8c4a48`). `getspawnpoint`'s setup (40 `0x10c8780`, 51 `0xfb0db0`) registers its `player` with the third.
MessageRoot 0x100044 (`CommandMessage`, a vector of 0x28-byte components as 2024) and JsonObject 0x10004a are not
shipped. bdsx reads a message through `CommandMessage::generateMessage`, which has no 40 address. The Json parse calls
1.26's JSON library, which bdsx's `JsonValue` has not been checked against. `bds/command.ts` now looks a parameter's
rule up by its bdsx type (`PARSE_RULE_LABELS`). The old match of the parse function is only a fallback, because three
rules share one function. `PlayerWildcardCommandSelector` uses the Actor wildcard rule, as 2024 used its parser.

**10.3 `CommandSelectorBase`.** It is still 0xc8 bytes: `allocateCommand<TestForCommand>` / `<GetSpawnPointCommand>`
allocate 0xe8 (40 `0x3cba320` / `0x11107a0`, 51 `0x3a54ff0` / `0xffe700`), which is `Command` 0x20 plus the selector. Its
constructor is inlined there and matches 2024's `0xcea5c0` field for field: zero, the position's relative flags
+0x94..+0x96 = 1, radius max FLT_MAX +0xa8, count 0xffffffff +0xb0, forcePlayer +0xbe (1 in the Player command only).
**40 also sets +0xc2 = 1; 51 writes nothing past +0xc1.** bdsx's constructor is `derived()`, with that byte as
`layouts.CommandSelectorBase.defaultTrueFlag` (40 0xc2, 51 -1). Two members ship by address. The destructor is what
both commands' deleting destructors call on this+0x20 (40 `0x3fc670`, 51 `0x435180`); it destroys the vectors at
+0x70/+0x58/+0x40/+0x28/+0x10, as 2024's `0x148f30`. `newResults` (40 `0x382f30`, 51 `0x3d21c0`) is the first call of
both commands' `execute` on (this+0x20, sret, origin), with 81 / 82 call sites. It first allocates the 0x28-byte
`make_shared<vector<Actor*>>` block, as 2024's `0xd0ea20` does, and reads the same flag bytes on both builds.

**10.4 Execution, 2026-09-27** (`tools/softenum-probe.ts`, bot drivers `cmdo40`/`cmdo51`, `verify-pair`, fourth run: 38
PASS / 0 FAIL each, tsc 0, exit 0 + `Quit correctly`; `work/host-runs/cmdo40-20260927-193738.txt`,
`cmdo51-20260927-193738.txt`). Earlier runs: the first had a wrong probe expectation, the second and third had a type
error each (the last bullet).
- `seprobecmd 42 red` from the console: `output.success("commands.seprobe.ok", [42])` took the output from {type 3,
  count 0, 0 messages} to {count 1, 1 Success message `commands.seprobe.ok` [42]}.
- Through `bedrockServer.executeCommand` (type None): count 0 -> 1 and no message. **The MCRESULT is a success**
  (before this change it was a failure: the callback wrote nothing).
- `seprobeerr` through `executeCommand` (Output): one Error message `commands.seprobe.err` [x,7], count still 0,
  MCRESULT 0x80020000 (failure).
- `seprobetypes <f: float> <who: PlayerCommandSelector> <at: CommandPositionFloat> <rest: CommandRawText>`: after
  `registerOverloadInternal` each parameter holds the rule it was given.
- `seprobetypes 1.5 @a 1 2.5 -3 hello raw world` gave f=1.5, who=[bdsxprobe] (every player in the level), at =
  (1.5, 2.5, -2.5) absolute, rest `hello raw world`. The engine centres whole-number x and z, as `tp` does. The first
  run's probe expected (1, 2.5, -3) and failed there.
- `seprobetypes 2 @a ~ ~1 ~ rel` gave (0, 1, 0), all relative. `seprobetypes x @a 0 0 0 no` did not run.
- `executeCommand('seprobetypes -0.25 "bdsxprobe" 3 4 5 by name')` gave f=-0.25 and who=[bdsxprobe]: the selector took
  a player's name. MCRESULT success.
- `output.success()` with no message added one to the count and no message.
- Regressions, the same day: `se40`/`se51` 37/37 each (the soft-enum steps, and `seprobe exec` now expects a successful
  MCRESULT), `layout40`/`layout51` 27/27 each, all tsc 0.
- Runs 2 and 3 passed every check but had tsc exit 2. Run 2 was a `CxxVector` passed where `StaticPointer` was typed.
  Run 3 was `derived()`'s inferred type for the selector constructor. The JavaScript was emitted both times, but those
  runs are not counted.

Not done: `CommandMessage`, `Json::Value`, `CommandFilePath`, `CommandIntegerRange`, the `bool`/`CommandItem`/
`ActorDefinitionIdentifier` rules (typeid-pointer types), and `example_and_test/customcommand.ts` end to end. The
wildcard selector rule is shipped but no command has parsed through it.
(Section 11 closes all of these but `Command.Block`.)

## 11. Plugin command parameters, the rest -- every type registers and parses, on both builds; `Command.Block` too since 2026-09-27

`example_and_test/customcommand.ts` now registers all its commands and every one runs with its parameters read back,
except `jjj` (`Command.Block`): it parses, but turning the parsed name into a `Block` needs
`BlockTypeRegistry::lookupByName`, which has no address (11.6). Addresses 40 / 51; every body was read on both builds.

**11.1 Three more rules from the initializer** (the scan of 10.2), each parse read against 2024's `parse<T>`:

| T | symbol | instance | parse | body |
|---|---|---|---|---|
| `CommandIntegerRange` | FullIntegerRange 0x100017 | `0xc8c48f8` / `0xcc89b60` | `0x331660` / `0x1215ab0` | 2024's `0xd307e0` step for step: a token of type 0xc sets `inverted` (+8), `parse<int>` into `min` (+0), no `..` copies it to `max` (+4), else a 0x100014 token is skipped and `parse<int>` fills `max` |
| `CommandFilePath` | FilePath 0x100011 | `0xc8c4920` / `0xcc89bd0` | `0x33dd50` / `0x121ec60` | 2024's `0xd30700`: `ParseToken::toString`, `_removeStringQuotes` (strips a `"` at both ends), moved into the `std::string` at +0 |
| `Json::Value` | JsonObject 0x10004a | `0xc8c4a98` / `0xcc89bc0` | `0x33d840` / `0x121e7a0` | 2024's `0xd31220`: `Json::Features` and `Reader`, then `Reader::parse(text, *(Value*)storage, false)`; the formatted errors on failure |

`CommandIntegerRange`'s constructor is inlined in 1.26. `ExecuteCommand`'s `allocateCommand` (40 `0x3d963b0`, 51
`0x3b3a560`, the range at +0x2a8) writes 2024's three stores (`0xcba3b0`): `INT_MIN`, `INT_MAX`, and the word 0x0100 at
+8 (inverted false, inclusive true). It is `derived()`. The grammar takes a JSON **object** only (`seprobejson [3,...]`:
`Syntax error: Unexpected "["`), and a JSON `null` is refused too.

**11.2 `bool`, `CommandItem` and entity types go through the engine's enums.** Nothing fills
`ParseRuleFor<bool>::instance` (40 `0xc8b8320`): a static initializer zeroes it (40 `0xba1d0`). alwaysday's `lock`
(40 `0x3ccf4d0`) hands `CommandParameterData` that zero rule anyway, with type Basic and `type_id<CommandRegistry,bool>`.
`registerOverloadInternal` (40 `0x36c4b0`, 51 `0x1248da0`) looks every Basic parameter's type id up in `type_lookup_`
(+0x1c0). When the id maps to an enum, it sets type 1 (Enum), the enum's name and its `idx | 0x300000` symbol. The parse
override becomes `enums_[idx].parse` (+0x28 of the 0x48-byte `Enum`), unless the id is `type_id<std::string>`, the
id every `addEnumValues` enum carries. So bdsx gives such a parameter the id the engine gave the enum (`Enum::type`,
read from `enums_` by name: no per-build static) and a zeroed rule of its own (`engine/command.ts`
`commandEnumTypeId`, `commandEnumBackedRule`). Enums used: `Boolean` (`parseEnum<bool>`, 40 `0x3d2ed0` / 51
`0x126bd00`: one byte, `getEnumData(token) != 0`, as 2024's `0xd31db0`), `Item` for `CommandItem` and `EntityType` for
`Command.ActorDefinitionIdentifier`. Those two share one parse (40 `0x3d2f60`, 51 `0x430950`) that stores the value's
8-byte enum data. Plugin enums (`command.enum`) are type Enum already; bdsx now sets their parse override itself,
from the enum's (hooked) parse, so it does not depend on bdsx's id missing `type_id<std::string>`.

**11.3 `Json::Value` is read by layout** (`engine/json.ts`). The value is at +0 and the type byte at +8. An array
holds a `std::vector<Value*>*` and an object a `std::map<CZString, Value>*`, whose 0x38-byte nodes keep the key's
`const char*` at +0x20 and the value at +0x28 (`operator[](const char*) const`, 40 `0x9fdb1e0`, 51 `0xa0fb7a0`, walks
that map with `strcmp`). `size`, `get(int)`, `get(string)`, `getMemberNames` and `isMember` are `derived()` and
read-only: a missing member is an error, not an insertion (until 2026-09-29: `get` inserts again, section 17). Three
propagated addresses were wrong and are retracted.
`getMemberNames` 40 `0x9b8990` moves an unordered_map-like object. 51 `0x75b20` is a hash rehash. `isMember` 51
`0xa0fb6f0` tests for an array and allocates. (40's `isMember` `0x9fdb560` is right and still ships.)

**11.4 `CommandPosition::getPosition(int, const CommandOrigin&, const Vec3&)`** ships (40 `0x12decf0`, 51
`0x1201300`). It was found as the call `CommandSelectorBase::newResults` makes on selector+0x88, which 2024's newResults
makes to `getPosition` too (`0xd0eb38`). The body has 2024's shape: the entity, the rotation, the local branch, the
per-axis relative adds. `getBlockPos` is inlined everywhere (no small caller). It is `derived()`: getPosition, +0.001
per axis, then floor, as 2024's `0xcc71d0`.

**11.5 `CommandMessage`.** The rule is MessageRoot 0x100044 (`0xc8c4a88` / `0xcc89d58`, parse `0x33c950` / `0x121d820`,
2024's `0xd308e0`). It holds a vector of 0x28-byte `MessageComponent { std::string; unique_ptr<CommandSelector<Actor>> }`.
A selector token allocates a 0xc8-byte selector and calls `parseSelector`. 1.26 adds a bool after the vector.
Every message command's `allocateCommand` zeroes 0x19 bytes at the message (40 `0x3d92450`, 51 `0x3aa34d0`, +0xe8 of
0x108), and `generateMessage` returns the empty result at once when the vector is empty and that bool is clear. So
`layouts.CommandMessage.size` = 0x20 on both, and bdsx's constructor zeroes the byte. `generateMessage` is 40
`0x12dd210` (new) and 51 `0x11ff9f0` (shipped by propagation, now read). Each build's message commands call it first thing
as `(this+0xe8, sret, origin, 0x200)`, and the result is 2024's { string, bool +0x20 }. Not fixed: bdsx's
`MessageComponent` models the selector as a plain pointer, so a parsed message's selectors are not freed with it (a leak,
as upstream).

**11.6 `Command.Block`: the parameter parses, the lookup is missing.** The `Block` enum (typeid 26, hooked by bdsx's
`CommandRawEnum` for the token) stores 2024's `CommandBlockName`: `HashedString::computeHash` of the full name
(`seprobeblockraw stone` stored `0x2727739c84aa7913`, the enum's data for `stone` and the hash of `minecraft:stone`).
Turning it into a `Block` is `Block.create` → `BlockTypeRegistry::lookupByName`. The shipped address (cross-build,
40 `0x3ebf690`, 51 `0x55e6a0`) is not that function: it returns an int ORed over a vector of 0x30-byte entries and
writes no `WeakPtr` through a return slot. It is retracted on both builds (a call would have crashed). The
`HashedString(const std::string&)` constructor and `BlockLegacy::getBlockItemId` have no address either. So `jjj` logs
`Symbol not found: ?lookupByName@BlockTypeRegistry...` from its callback, and nothing else fails.
**Solved 2026-09-27:** the registry is a global object in 1.26 and `_lookupByNameImpl` a member, whose result is a
`WeakPtr` on 40 and a plain pointer on 51. `jjj stone` prints `minecraft:stone` on both builds, and `seprobeblock` passes
(`params40/51` 49/49). `findings-blocks.md` "The block type registry on 1.26".

**11.7 Execution, 2026-09-27** (`tools/softenum-probe.ts` `seprobe enums` / `params` / `got`, drivers `params40`/`params51`
with the bot, `verify-pair`, third run: **37 PASS / 0 FAIL each, tsc 0, exit 0 + `Quit correctly`**;
`work/host-runs/params40-20260927-215514.txt`, `params51-20260927-215514.txt`):
- `bool`: after `registerOverloadInternal` the parameter is type 1 `Boolean`, tid 2 (the enum's), symbol 0x300005,
  override = the enum's parse. `true`/`false` read back as such, and `maybe` is a syntax error.
- Range `3..7` → {3, 7, not inverted}, `isWithinRange(5)` true and `(8)` false. `!5` → {5, 5, inverted}. `..4` →
  {INT_MIN, 4}.
- File path `some/dir/file.mcfunction` read back. Enums: `beta nether` → `Beta` and `DimensionId` 1, and `gamma` is
  refused.
- JSON `{"b":[true,"x",2.5],"a":1,"c":{"d":"e"}}` → type 7, size 3, `value()` = the same object with the keys sorted.
- `ActorWildcardCommandSelector`: `@a` → [bdsxprobe], and `*` parses and runs, with no results from the console.
- An optional string reads back absent, then `hi`.
- `CommandPosition` `1 2 3` from the console → (1.5, 2, 3.5), block (1, 2, 3). `execute as @a at @s ... ~ ~1 ~` →
  the player's (29.5, 68, 14.5) + (0, 1, 0), and the block with a (0, 4, 0) offset is (29, 73, 14).
- `seprobemsg hello @a world` → `getMessage` "hello bdsxprobe world" (4 components).
- `CommandItem` `diamond` → {version 1, id 306}, the `Item` enum's data. The entity type `zombie` → a pointer equal to
  the `EntityType` enum's data, whose `fullName` reads `minecraft:zombie<>`. `Block` as 11.6.
- `customcommand.ts`, from the console: `aaa` text, `bbb` first/second, `ccc`, `ddd 1 ~2 3` (1 false / 2 true / 3
  false), `eee @a @a` (Entity and Player lines, `minecraft:player`), `fff true`, `ggg enum2 nether` (Enum2 / 1),
  `hhh {"k":[1,2]}`, `iii 1 2 3` (Pos 1.50/2.00/3.50, BlockPos 1/2/3), `kkk add foo` / `kkk remove 3`, `lll add val` /
  `lll list hello` (hello, world, val), `nnn 1..5` (1 / 5 / false) and `/whoami` (`You are the server console`) all print
  their values. `jjj stone` fails as 11.6.
- Regressions, the same session set: `cmdo40/51` 42/42 (the rule check now includes the four new rules), `layout40/51`
  27/27, all tsc 0.
- Runs 1 and 2 had tsc exit 2 (probe type errors) and are not counted. Run 1 also showed that JSON `null` is refused and
  that `Block.create` throws. Run 2 showed that a top-level array is refused and that a message has 4 components.

## 12. `CommandRegistry::Parser` and `getCommandName` -- shipped, done on both builds (2026-09-28)

Section 5 found the parser inline in `compileCommand`; it is not gone, only its two thinnest members are. Both
`MinecraftCommands::compileCommand` (40 `0x39afd0`, 51 `0x3e8c60`, Endstone `windows.h`) and `executeCommand` (40
`0x38b570`, 51 `0x3da4e0`) keep a `Parser` on the stack and make 2024's calls, in 2024's order, with 2024's frame:

| 2024 name | 2024 | 40 | 51 | 1.26 |
|---|---|---|---|---|
| `??0Parser@CommandRegistry@@QEAA@AEBV1@H@Z` | `0xd3d400` | `0x33e390` | `0x121f2a0` | out of line, ~11 KB (`buildParseTable` inlined) |
| `?parseCommand@Parser@...` | `0xd4ce40` | `0x341280` | `0x1222040` | out of line, tail-jumps to `_parse` |
| `?getErrorParams@Parser@...` | `0xd4c0a0` | `0x341590` | `0x12222e0` | out of line (sret vector) |
| `??1Parser@CommandRegistry@@QEAA@XZ` | `0xcebaf0` | `0x3416d0` | `0x3e8a80` | out of line |
| `?createCommand@Parser@...` | `0xd484a0` | -- | -- | inlined: the call below |
| `?createCommand@CommandRegistry@@AEBA...` | `0xd48190` | `0x33c3b0` | `0x121d2d0` | out of line, same frame |
| `?getErrorMessage@Parser@...` | `0x4daef0` | -- | -- | inlined (2024: `lea rax,[rcx+0x80]`) |
| `?getCommandName@CommandRegistry@@...` | `0xd4bc80` | `0x36dc70` | `0x124a3e0` | out of line; 40 dropped `this` |

**The layout is 2024's, 0xc0 bytes.** Each constructor writes registry +0, the deque +0x10..+0x30 with its 16-byte proxy,
input +0x38/+0x48, the registry again +0x50, SSO strings +0x58 and +0x80, root token +0x78, vector +0xa0, the version
(r8d) +0xb8, a zero word at +0xbc, then finds or builds the version's parse table in `registry+0xa0` and stores it at +8,
field for field 2024's. The callers pass root +0x78, version +0xb8, &error message +0x80 and &error params +0xa0 to
`CommandRegistry::createCommand`, and keep their next local at parser+0xc0. `getErrorParams` tests +0xbc and copies
+0xa0, or builds three strings around the error from +0x38/+0x40/+0x58; the destructor frees +0xa0, +0x80, +0x78, +0x58
and the deque. In the table as `layouts["CommandRegistry::Parser"]` (size, root, errorMessage, errorParams, version).

**`createCommand` and `getErrorMessage` are `derived()`** (`engine/command.ts`): 2024's `Parser::createCommand` is 89
bytes that return null without a root token and otherwise call `CommandRegistry::createCommand(root, origin, version,
error&, params&)`. That call is in both 1.26 callers, and its frame is 2024's: rcx registry, rdx sret, r8 the token, r9
the origin, then the int, the string& and the vector& at +0x28/+0x30/+0x38 (40 reads them at rbp+0x70/0x78/0x80). The
registry's `createCommand` ships under its 2024 name.

**`getCommandName` ships as `bdsx:CommandRegistry::getCommandName`.** On both builds it is the only function besides
`Parser::_parse` that calls the lexer's step: it steps past type-5 (whitespace) tokens and returns the first token's
text, or an empty string. 2024's is a const member that never reads `this`. 51 keeps that prototype: `executeCommand`
passes the registry in rcx, and `getCommandStatus`/`isCommandOfType` (`0x124a560`/`0x124a640`) forward rcx. 40 dropped
the dead argument: all four call sites (`executeCommand`, `requestCommandExecution` ×3) pass the sret in rcx and the
string in rdx, and the two forwarders are inlined. One key covers both, and `layouts["CommandRegistry::getCommandName"].thisArgs`
(40: 0, 51: 1) says which prototype to build.

**`bedrockServer.executeCommand` does not change.** bdsx's own copy of `executeCommand` (Parser, its own `CommandOutput`,
`events.command` fired by hand) had been gated on the Parser constructor's name. Shipping the constructor would have
switched that dead path on, and it needs `CommandOutput`'s constructor and `error()`, which bdsx has no address for.
The copy is deleted. `executeCommand` is always the engine's (section 5), and `CommandRegistry.Parser` stays as a plugin
API.

**Execution** (`parser40`/`parser51`, `run-full`, `tools/softenum-probe.ts` `seprobe parser` after `seprobe register`;
tsc 0, exit 0, `Quit correctly`; **14/14 PASS each**, `work/host-runs/parser40-20260928-034254.txt`, `parser51-...`):
- `getCommandName`: `seprobecmd 42 red` → `seprobecmd`, `   tp @a 1 2 3` → `tp`, the empty line → `""`.
- `Parser(registry, 42)`: `parseCommand("seprobecmd 9 green")` is true with no error, and `createCommand` from a
  `ServerCommandOrigin` is non-null. `Command.run` on it runs the plugin's callback with n=9 v=green, and its
  `output.success` lands (success count 1, one Success message). The output was built by the probe as the engine's
  constructor leaves every type except DataSet: the type, then zeros.
- `seprobecmd abc red` → false, `commands.generic.syntax`, params `[eprobecmd |abc| red]` (the engine's ten-character
  window before the error). `seprobe_nosuch 1` → false, also `commands.generic.syntax`, `[|seprobe_nosuch| 1]`. The
  parser has no "unknown command" error: `executeCommand` checks `findCommand` before it parses.
- 200 rounds of construct / parse / create + destroy / destruct, alternating good and bad lines: 100 commands, 100
  errors.
- `seprobe exec` and a console `seprobecmd 7 red` still pass. Regressions the same day: `cmdo40/51` 43/43,
  `params40/51` 49/49, `layout40/51` 27/27, all tsc 0, exit 0.

`CommandVersion.CurrentVersion` has no address or constant on either build, so bdsx's fallback 42 is in use. It parses
the plugin's command, but it is not known to be the engine's own version.

**Candidate, not executed: `CommandOutput`'s constructor is out of line.** `executeCommand` constructs its output with
one call before `getCommandName`: 40 `0x12df330`, 51 `0x1201940`. Each stores the type (edx) at +0, zeroes +8..+0x2d,
and builds the property bag only for type 4 (DataSet), which is 2024's `??0CommandOutput@@QEAA@W4CommandOutputType@@@Z`
(`0xcba690`). Shipping it would let `CommandOutput.constructWith` work. It is queued, not shipped.
**Shipped and executed 2026-09-28: section 13.**

## 13. `CommandOutput`'s constructor, `set<int>` and destructor -- done on both builds (2026-09-28)

`CommandOutput.constructWith(type)` threw (no constructor address), and nothing bdsx built could be destructed (no
destructor address). Addresses 40 / 51; every body read in full with `disas-exact` on both builds.

| 2024 name | 2024 | 40 | 51 | 1.26 |
|---|---|---|---|---|
| `??0CommandOutput@@QEAA@W4CommandOutputType@@@Z` | `0xcba690` | `0x12df330` | `0x1201940` | out of line, shipped |
| `??$set@H@CommandOutput@@QEAAXPEBDH@Z` | `0xce8c60` | `0xb8ca0` | `0xb9520` | out of line, shipped |
| `??1CommandOutput@@QEAA@XZ` | `0xcbd0e0` | -- | -- | inlined: `derived()` |

**The constructor** (rcx this, edx type) stores the type at +0 and zeroes +8..+0x2c. Only for DataSet (4) does it
allocate 0x20 bytes through the engine allocator (the object `std::string` uses, 40 `0xc76f5f0`, 51 `0xcabdab8`),
put a `Json::Value(nullValue)` at +8 of it, zero +0x18, store the `CommandPropertyBag` vftable (40 `0xa5de568`, 51
`0xa7460b8`) and move it into the `unique_ptr` at +8. That is 2024's body with `operator new` and
`CommandPropertyBag()` inlined. The bag's vftable has one slot, its deleting destructor (40 `0x3c2390`, 51
`0x125a8c0`): `~Json::Value` on +8, then a 0x20-byte free when the flag is set. Five callers on each build:
`executeCommand` (on its own output, before `getCommandName`), `requestCommandExecution` twice, a run-and-count
helper (40 `0x10d6420`, 51 `0xfbe4c0`: construct, `Command::run`, read +0x28, destroy) and one more.

**`set<int>`** (rcx this, rdx `const char*`, r8d value) returns unless the type is DataSet. Otherwise it builds a
`std::string` from the key and does `bag->json[key] = Json::Value(int)` (`operator[](const std::string&)` 40
`0x9fdb2b0` / 51 `0xa0fb870`, the int constructor 40 `0x9fd9940` / 51 `0xa0f9f00`: `movslq`, type byte 1). That is
2024's call sequence. 36 call sites per build; `executeCommand`'s `"statusCode"` is one of them, as it was in 2024.
The other `set<T>` (string, bool, float, `BlockPos`) were not looked for.

**The destructor is inlined everywhere.** `executeCommand`'s epilogue (40 `0x38bc60`, 51 `0x3dabe0`) and the
run-and-count helper destroy the message vector at +0x10 (40 `0x3cf900`, 51 `0x413150`: 0x40-byte messages, the
params vector at +0x28 and the id string at +8), then call slot 0 of the bag at +8 with 1 when it is set. That is 2024's
`0xcbd0e0` member for member. Every caller of that vector destructor under 100 bytes is an unwind funclet
(`mov [rsp+0x10],rdx` prologue) or a variant destructor, so there is no out-of-line copy. bdsx's
`[NativeType.dtor]` is `derived()`: bdsx destroys the messages as a `CxxVector<CommandOutputMessage>`, then calls the
bag's slot 0 (`engine/command.ts` `commandOutputDeleteBag`).

**Execution** (`parser40`/`parser51`, `run-full`, `tools/softenum-probe.ts` `seprobe parser` after `seprobe register`;
tsc 0, exit 0, `Quit correctly`; **42 PASS / 0 FAIL each**, `work/host-runs/parser40-20260928-042417.txt`,
`parser51-...`). The probe's hand-built output is gone; it now uses `CommandOutput.constructWith`.
- `constructWith(AllOutput)`: {type 3, count 0, no messages, +0x2c 0}, property bag null. `set_int("seprobe_k", 42)`
  leaves the bag null.
- `constructWith(DataSet)`: {type 4, count 0, no messages}, a bag with the vftable above (runtime address = base +
  that RVA on both builds), Json type 0 and 0 at +0x18. `set_int("seprobe_k", 42)` reads back through
  `propertyBag.json.value()` as `{"seprobe_k":42}`.
- `Command.run` of a `Parser`-created plugin command into each output runs the callback (n=9 v=green). Its
  `output.success` lands in both: count 1 and one Success message `commands.seprobe.ok` [9]. The DataSet json is
  unchanged.
- Both outputs destructed. Then 200 rounds, alternating AllOutput and DataSet: construct, `set_int`, `success` with a
  parameter, read back, destruct. All 200 were as expected, with no fault.
- Regressions after it, same day: `cmdo40/51` 43/43, `layout40/51` 27/27, all tsc 0 and `Quit correctly`.

`MinecraftCommands::handleOutput` and `getOutputType` are the next names in this area. **Done: section 14.**

## 14. `MinecraftCommands::handleOutput` shipped, `getOutputType` derived -- done on both builds (2026-09-28)

A plugin can now hand a `CommandOutput` it built (section 13) to an origin. Addresses 40 / 51; every body read in full
with `disas-exact` on both builds.

| 2024 name | 2024 | 40 | 51 | 1.26 |
|---|---|---|---|---|
| `?handleOutput@MinecraftCommands@@QEBAXAEBVCommandOrigin@@AEBVCommandOutput@@@Z` | `0xd0a6b0` | `0x399e60` | `0x3e7dd0` | out of line, shipped |
| `?getOutputType@MinecraftCommands@@SA?AW4CommandOutputType@@AEBVCommandOrigin@@@Z` | `0xd0a020` | -- | -- | inlined: `derived()` |

**`handleOutput`** is the call `executeCommand` makes four times after running (rcx `this`, rdx `ctx+0x20` the origin,
r8 the output); two more callers per build (40 `0x38ab00` x2 and `0x299a7e0`, 51 `0x3d9af0` x2 and `0x1f11390`). The
body has 2024's shape. It reads the origin's source id (40 vftable +0xa0, 51 +0xa8) and the local id from the context
provider at `this+8` (slot 2, sret). 2024 asked `Minecraft`'s network systems for the local id instead. If the two ids
are equal, or the source id is unassigned, it calls `send(origin.getOutputReceiver(), output)` on the
`CommandOutputSender` at `this+0x18` (slot 1). Otherwise it takes the provider's level (slot 1) and that level's packet
sender (level vftable +0xa40). It builds a `CommandOutputPacket` (vftable 40 `0xa5df850`, 51 `0xa6fe7a0`) from the
receiver's `CommandOriginData` and a copy of the output. It sends that through slot 5 with the source id and
`getSourceSubId`. Either way it ends with `sendToAdmins(sender, receiver, output, this+0x20)` (40 `0x12f2ac0`, 51
`0x1212670`, not shipped: not read past its entry). The arguments are 2024's three, so bdsx's binding is unchanged.
`MinecraftCommands`' layout matches Endstone's `minecraft_commands.h`: +8 provider, +0x10 registry, +0x18 sender,
+0x20 the operator permission level.

**`getOutputType` is inlined** into `executeCommand` just before the `CommandOutput` constructor (40
`0x38b5cb..0x38b6f9`, 51 `0x3da53b..0x3da669`). Endstone re-implements it too (`minecraft_commands.cpp`). The
origin type comes from 40 vftable +0xc0 / 51 +0xc8. Types 4..14 under the mask 0x40f index a table (40 `0xa5dfaf0`, 51
`0xa6fe9f0`, both `{4,4,4,3,0,0,0,0,0,0,4}`): Test, AutomationPlayer, ClientAutomation and Scripting are DataSet, and
DedicatedServer is AllOutput. Every other type reads the level's `GameRules` (level vftable +0xab0), whose rule vector is
at +0x18 with stride 0x118. Command blocks (1, 2) use rule 0, `commandblockoutput`: AllOutput when on, LastOutput when off.
The rest use rule 0x16, `sendcommandfeedback`: AllOutput when on, Silent when off. A vector too short counts as off.
With no level the type is AllOutput. The value is `std::get<bool>` of the rule's variant: +4 holds the value and +8
the index, which must be 1 (else `bad_variant_access`). 2024's body is the same with the rule at 0x14; 1.26 inserted
rules before it (`gamerules.ts`). bdsx's `getOutputType` is `derived()`: `engine/command.ts`
`commandOutputTypeFor` + `gameRuleBoolValue`, over bdsx's derived `GameRules.getRule`. `GameRule.getBool` itself still
has no address. It is not used here.

**A player origin for the probe.** `PlayerCommandOrigin`'s constructor is inlined, but the class has
`ActorCommandOrigin`'s 0x28-byte layout. `getSourceId`/`getSourceSubId` (40 `0x12e72d0`/`0x12e7780`, 51
`0x12096d0`/`0x1209b80`) fetch the entity by the `ActorUniqueID` at +0x18 through the `Level*` at +0x20. Both classes
share one deleting destructor (40 `0xba750`, 51 `0xbbbe0`, a 0x28-byte free). Its `getOriginType` returns 0 and
`getOutputReceiver` returns `this`. So `tools/softenum-probe.ts` builds bdsx's `ActorCommandOrigin.constructWith(player)`
and stores `??_7PlayerCommandOrigin@@6B@` over its vftable. bdsx still has no `PlayerCommandOrigin` constructor of its own.

**Execution** (`hout40`/`hout51`, `run-client-probe` with the bot, `verify-pair`; second run: **13 PASS / 0 FAIL each,
tsc 0, exit 0 + `Quit correctly`**; `work/host-runs/hout40-20260928-045027.txt`, `hout51-...`, and the bot logs
`hout40/51-20260928-045027.bot.log`). The first run also passed 13/13, but tsc exited 2 (the type of the derived
fallback), so it is not counted.
- `getOutputType(ServerCommandOrigin)` = 3 (origin type 7). For the bot's `PlayerCommandOrigin` (origin type 0) it was
  3 with `sendcommandfeedback` true (variant index 1, value 1). After `gamerule sendcommandfeedback false` it was 2
  (value 0), and 3 again after `true`.
- The engine's own choice, each time: `executeCommand` through a `CommandContext` holding that player origin ran the
  probe's `seprobeho` (Normal permission). The output its callback received had the same type (3 / 2 / 3), with
  MCRESULT success. With 3 the engine then sent the callback's message to the bot itself (`command_output` in the bot
  log). With 2 it sent nothing.
- `handleOutput(server origin, constructWith(AllOutput) + success("seprobe handleOutput server <nonce>"))` printed
  `[... INFO] seprobe handleOutput server <nonce>`. `events.serverLog` saw it during the call. The output was
  unchanged (count 1, one message).
- `handleOutput(the bot's PlayerCommandOrigin, the same kind of output)` sent exactly one `CommandOutput` packet, to
  the bot's `NetworkIdentifier` (`events.packetSend`). The bot logged `command_output {origin: {type: "player"},
  output_type: "alloutput", success_count: 1, output: [{message_id: "seprobe handleOutput player <nonce>", success:
  true}]}` on both builds.
- Regressions after it, same day: `parser40/51` 42/42, `layout40/51` 27/27, all tsc 0 and `Quit correctly`.

Not executed: the DataSet and command-block branches of `getOutputType` (no such origin in the probe; static only).
Next in this area: `CommandOutputSender` itself. `send` is slot 1 of the object at `MinecraftCommands+0x18`, and bdsx's
`hook-command-output` patch (`launcher.ts`, `events.commandOutput`) needs it. `sendToAdmins` is the call above.
**Done: section 15.**

## 15. `CommandOutputSender`: `send`, the `hook-command-output` patch and `sendToAdmins` -- done on both builds (2026-09-28)

`events.commandOutput` never fired: `?send@CommandOutputSender@@` had no address, so bdsx's `hook-command-output` patch
(`launcher.ts`) never installed. `CommandOutputSender.sendToAdmins` threw. `bedrockServer.commandOutputSender` was also
the wrong object. Addresses 40 / 51; every body read in full with `disas-exact` on both builds.

| name | 2024 | 40 | 51 |
|---|---|---|---|
| `?send@CommandOutputSender@@UEAAXAEBVCommandOrigin@@AEBVCommandOutput@@@Z` | `0xcd16b0` | `0x12f23f0` | `0x1211fa0` |
| `?sendToAdmins@CommandOutputSender@@QEAAXAEBVCommandOrigin@@AEBVCommandOutput@@W4CommandPermissionLevel@@@Z` | `0xcd2880` | `0x12f2ac0` | `0x1212670` |
| `??_7CommandOutputSender@@6B@` | `0x2c94b20` | `0xa626de0` | `0xa7460a0` |

**`send` was found by its log call's function name.** 2024 passes the literal `CommandOutputSender::send` to
`BedrockLog::log`. 1.26 passes `virtual CommandOutputSender::send` (40 `0xa8ef6cd`, 51 `0xaa29372`), and exactly one
function references it, twice. `string-users.mjs` missed it: the short name is a suffix of the 1.26 literal, and a `lea`
points at the literal's start. The body is 2024's. rcx is `this`, rdx the origin, r8 the output. It switches on
`getOriginType` (40 +0xc0, 51 +0xc8). Type 14 (Scripting) hands the joined text to the origin (40 +0xd8, 51 +0xe0).
Type 7 joins the messages with 2024's lambda into a `std::string` at rbp+0x18. It logs that string at priority 2, or
8 if a message is an Error. Both paths meet at **send+0x147**, the `BedrockLog::log` call (40 `0x1d8d30`, 51
`0x278370`, format `"%.*s"`). Afterwards `send` notifies the observers at this+0x48 and frees the string. This is
send's slot 1 in the vftable. The deleting destructor (40 `0x12f4860`, 51 `0x125a790`) stores that vftable. It has
three slots, like 2024's: the destructor, `send`, and a bare `ret` (2024's `registerOutputCallback`).

**The patch.** 2024 overwrote the 20 bytes at send+0xb8 with a call to a hook that passed `[rbp+7]` (the joined
string) to a JS callback. The callback fires `events.commandOutput` per line and prints each line not CANCELed. In
1.26 the call site sits at +0x147 and the string at rbp+0x18. The same log arguments are set in a different order, in
21 bytes: `31 c9 / ba 01 00 00 00 / 45 31 c0 / 41 b9 0c 00 00 00 / e8 rel32`. `launcher.ts` now takes all three facts
from `layouts["CommandOutputSender::send"]` {`logCall` 0x147, `logCallForm` 1, `text` 0x18}. It builds the hook with
`asm()` (sub rsp 0x28, lea rcx [rbp+text], call the callback, add, ret) and keeps `procHacker.patching`'s byte check.
A table without the entry gets 2024's values: {0xb8, form 0, 7}. Nothing is patched unless the bytes at that offset
equal the form. The call is the only jump target in those 21 bytes, and the continuation reads only callee-saved
registers, so the nop fill after the 12-byte `mov rdx, imm64; call rdx` is safe.

**`MinecraftCommands` holds the sender at +0x18, not +8.** In 1.26, +8 is the context provider and +0x10 the registry
(`handleOutput`, Endstone `minecraft_commands.h`). `launcher.ts` hard-coded 8, so `bedrockServer.commandOutputSender`
was the provider. The table's `layouts.MinecraftCommands.commandOutputSender` said 8 as well, and nothing read it. It is
now 0x18, and the launcher reads it through `engineLayout`.

**`sendToAdmins`** is 2024's body, and it never reads rcx: rdx is the origin, r8 the output, r9b the level. It jumps
on the origin type (jump table 40 `0xa62760c`, 51 `0xa74730c`):
- 0 (player): the origin's entity is skipped.
- 1 and 2 (command blocks): require rule 0 `commandblockoutput`.
- 9 and 11: require rule 0x16 `sendcommandfeedback`.
- Every other type returns, the server (7) included.

For each Success message it builds a gray italic text object, `"[" name ": " message "]"`. The name is filled only
when output+0x2c is set. It then runs the level's `forEachPlayer` (+0x6f8). The lambda (40 `0x12fc470`, 51
`0x126b7b0`) skips the origin's actor. It sends the text (player +0x638 / +0x630, `displayTextObjectMessage`) when the
player's command permission level (+0x330 / +0x328) is at least r9b. So it sends a `text` packet of type json, **not**
a `command_output` (the queue row's guess). bdsx's binding now has `this: CommandOutputSender` (it said
`MinecraftCommands`, harmless because the body ignores rcx).

**Execution** (`cmdout40`/`cmdout51`, `run-client-probe` with the bot, `verify-pair`, `tools/softenum-probe.ts`
`seprobe sender | cmdout arm/list/handle/disarm | admins deop/op`, and `seprobe handle`). The run of 08:36 gave **18 PASS /
0 FAIL each, with tsc 0, exit 0 and `Quit correctly`**. Transcripts: `work/host-runs/cmdout40-20260928-083606.txt`,
`cmdout51-...`, bot logs `cmdout40/51-20260928-083606.bot.log`.
- `bedrockServer.commandOutputSender` equals `*(MinecraftCommands+0x18)`. Its vftable is the table's
  `??_7CommandOutputSender@@6B@`, and slot 1 is the table's `send`. The bytes at send+0x147 are
  `48 ba <imm64> ff d2` followed by nine `90`: the patch is installed.
- The console's `list` gave `events.commandOutput` its lines: `There are 1/10 players online:` and `bdsxprobe`, plus the
  `Unknown command: seprobe` line of the probe's own console step. The console line has no `[... INFO]` prefix, because
  bdsx printed it.
- `handleOutput(server origin, two Success messages)` fired two events, one per line, in order. `events.serverLog` saw
  neither, so the log call is gone. The host's `.out` shows each text once, printed by bdsx.
- The same with a text the listener CANCELs: the event fired, and the marker text appears **0 times** in either
  build's `.out`.
- `sendToAdmins` gave the bot at level 0, then at level 1 after `op @a`. `MinecraftCommands+0x20` (the operator
  level `handleOutput` passes) is 1.
  - From a server origin: 0 packets.
  - From the bot's own `PlayerCommandOrigin`: 0 packets, since the source is skipped.
  - From a `PlayerCommandOrigin` whose `ActorUniqueID` names no entity: 0 packets at level 1 and 1 at level 0 before
    `op`, and 1 at level 1 after it. `deop @a` restored the bot.
  - Each packet was the bot's only `Text`: type 10. The bot logged
    `text {type: "json", message: {"rawtext":[{"text":"§7§o["},{"translate":""},{"text":": "},{"translate":"seprobe admins
    another player's origin <nonce>"...},{"text":"]"}]}}`.
- The skip path ran for real. A first run (05:13, 13 PASS / 5 FAIL each, tsc 0, `Quit correctly`) had a typo in
  form 1: `45 33 c0`, where the build has `45 31 c0`; `llvm-objdump` prints both as `xorl %r8d,%r8d`. On both builds
  bdsx printed `hook-command-output: ... + 0x147: code does not match` and `skip`. The server ran the whole session.
  Console output kept going through `BedrockLog` (`events.serverLog` saw `handleOutput`'s text), and every
  `sendToAdmins` check passed. This first run is not counted for the patch. Take the bytes from the file, not from the
  disassembly. A second run (05:16) was cut by a network outage before it reported, so it is not a result.
- Regressions after it, same day: `layout40/51` 36/36 and `sig40/51` (events fired), all tsc 0 and `Quit correctly`.

Not executed: the command-block and entity-server branches of `sendToAdmins`, and the Scripting (14) branch of `send`
(static only). `seprobe handle`'s server check now accepts either route (commandOutput with the patch, serverLog
without).

## 16. `translateText` and `CommandOutputSender._toJson` -- done on both builds (2026-09-28)

bdsx's `_toJson` turns an output's messages into text through `translateText`, which builds a
`TextObjectLocalizedTextWithParams` and asks it for `asString`. Neither name had an address, so `_toJson` threw.
Addresses 40 / 51; every body read in full with `disas-exact` on both builds.

| name | 2024 | 40 | 51 |
|---|---|---|---|
| `??0TextObjectLocalizedTextWithParams@@QEAA@V?$basic_string@...@AEBV?$vector@...@Z` | `0x108d1f0` | `0x2c4ad70` | `0x2ec8d30` |
| `?asString@TextObjectLocalizedTextWithParams@@UEBA?AV?$basic_string@...@XZ` | `0x1091b40` | `0x2c4b210` | `0x2ec9140` |
| `?_resolveReference@Value@Json@@AEAAAEAV12@PEBD@Z` | `0x27a2480` | `0x9fdb970` | `0xa0fbf30` |

**The constructor was reached from `sendToAdmins`' direct calls.** Of the two candidates the queue named, 40
`0x3fa9e0` / 51 `0x433360` is a `make_unique` of a 0x28-byte text object (one string; vftable 40 `0xa6b2e60`). 40
`0x3f00f0` / 51 `0x429120` is `make_unique<TextObjectLocalizedTextWithParams>(const std::string&, const
std::vector<std::string>&)`. It allocates 0x30 bytes, copies the id into a local and calls the real constructor with it
by value. The constructor is 2024's body: it stores the vftable (40 `0xa6b2e80`, 51 `0xa7de7b0`) and moves the id to +8.
It puts a new 0x20-byte `TextObjectRoot` (vftable 40 `0xa55da10`, 51 `0xa67d160`) at +0x28. For each parameter it adds
a child (40 `0x2c4af60`, 51 `0x2ec8f00`, 2024's `addChild` of a `TextObjectText`) and then resets the moved-from id.
The 40 and 51 bodies differ only in the out-of-memory path. The parameters and return are 2024's, so both ship under
2024's decorated names.

**`asString` is slot 1 of that vftable**, as in 2024's `0x2ccd9a0`. The table has four slots: the deleting
destructor (40 `0x2c65980`), `asString`, `asJsonValue` and `resolve`. `asString` is 2024's body with
`asStringVector` inlined. It collects slot 1 of each child of the root, then calls the engine's `I18n` (a static,
40 `0xc8de950`, behind a thread-safe init guard) at vftable +0x88 with (sret, id, strings, empty
`shared_ptr<Localization>`). With no root it uses +0x80. rcx is `this` and rdx the returned string. 40 and 51 are
identical after normalising addresses. The deleting destructor deletes the root (and so the children) and frees the
id. With bit 0 of edx set it also frees the 0x30 bytes.

**bdsx side.** `engine/textobject.ts` `translateText(id, params)` takes a `CxxVector<CxxString>` or a JS array. It
allocates the 0x30 bytes itself, runs the constructor and `asString`, then calls slot 0 with 0 to destroy the object
without freeing it. `implements.ts` now uses it in place of its own binding, which had no destructor and leaked the root.
`_toJson` puts `statusMessage` beside `statusCode`, as upstream's `executeCommand` did. Upstream's `_toJson` built
the text and then dropped it. It reads the property bag only when +8 is set (only DataSet has one, section 13). The
`{ error: "REMOVED FUNCTION" }` stub in `command.ts` is gone.

**`JsonValue.constructWith` of an object needed `_resolveReference(const char*)`.** The first run showed this
(below). In 2024, `operator[](const std::string&)` (`0x27a1d70`) is a tail jump to it. On 1.26 the same four-instruction
tail jump sits at 40 `0x9fdb2b0` / 51 `0xa0fb870` (section 13's `set<int>` calls it), and its target is the function
above. That function makes the value an object when it is not one (`Value(objectValue)` and a swap). It then finds the
key in the map by `strcmp`, inserting a null value when the key is absent. 40 and 51 are identical after normalising.

**Execution** (`text40`/`text51`, `run-full`, `verify-pair`, `tools/softenum-probe.ts` `seprobe text` twice per
session). The run of 22:01 had tsc 0, exit 0 and `Quit correctly` on both builds, and gave **7 PASS / 1 FAIL per round**
on each. Transcripts: `work/host-runs/text40-20260928-220147.txt`, `text51-...`.
- `translateText("commands.players.list", ["1","10"])` = `There are 1/10 players online:`. The server's `en_US.lang`
  has `There are %1$d/%2$d players online:` on both builds.
- `commands.tag.add.success.single` with a 32-character tag (past SSO) = `Added tag '<tag>' to bdsxprobe`.
- `commands.kill.successful` from a `CxxVector<CxxString>` = `Killed Zombie`, and the vector is left intact.
- An id the language lacks comes back unchanged (INFO).
- 300 rounds of construct, `asString` and destroy were all right.
- `_toJson` of an AllOutput output with two Success messages = `{"statusCode":0,"statusMessage":"There are 1/10 players
  online:\nKilled Zombie"}`. The output was unchanged afterwards (count 2, two messages). An empty output gave
  `{"statusCode":-1,"statusMessage":""}`.
- The FAIL: a DataSet output with `set_int("seprobe_k", 7)` and `commands.time.set` [6000] returned
  `{"seprobe_k":7,"statusCode":0,"statusMessage":"Set the time to 6000"}`. The members are the expected ones, but the
  check compared against `statusCode` first. `Json::Value`'s object is a `std::map`, so members come back in key order.
  The check now expects that order. **It was not rerun.**
- An earlier run (20:35) passed every `translateText` check. `_toJson` then threw `unresolved symbol` from
  `JsonValue.constructWith` (`_resolveReference`, added above). Both sessions also lost the driver's exit code, so that
  run is not counted.

Not done: `executeCommand` with `CommandResultType.Data` still returns `statusMessage: ""`. The engine runs the command
and builds its output itself (section 5), so bdsx never holds that output to translate.

## 17. `JsonValue` inserts again -- done on both builds (2026-09-29)

`getByInt`/`getByString` (and `get`, and the proxies' `set`) were `derived()` readers that threw "inserting is not
available on BDS 1.26" on a missing member (11.3), so `json.get("k").setValue(v)` on a new key failed, and with it bdsx's
own `CommandOutput.set_Vec3`. In 2024 both non-const overloads were bare jumps:

| 2024 name | 2024 | jumps to | 1.26 target (40 / 51) |
|---|---|---|---|
| `??AValue@Json@@QEAAAEAV01@H@Z` (int) | `0x27a1d80` | `??AValue@Json@@QEAAAEAV01@I@Z` `0x27a1d90` | `0x9fdae00` / `0xa0fb3c0` |
| `??AValue@Json@@QEAAAEAV01@PEBD@Z` (const char*) | `0x27a1f20` | `?_resolveReference@Value@Json@@AEAAAEAV12@PEBD@Z` `0x27a2480` | `0x9fdb970` / `0xa0fbf30` |

1.26 keeps no copy of either jump, but ships both targets. `_resolveReference` shipped in section 16. The unsigned
`operator[]` was already in both tables (the gaps-agree route), and section 11.3 cites it only for its `sar 3`. Read in full,
it is 2024's `0x27a1d90` instruction for instruction, **the inserting non-const one**, not the const reader:
`cmpb $0x6, 0x8(%rcx)`, and if it is not an array, `Value(arrayValue)` plus assign plus destroy of the temporary. Then
`end - begin >> 3`. Past the end it resizes the `vector<Value*>` to index + 1 and allocates a 0x10-byte null `Value`
for each new slot. `_resolveReference` has the same shape for objects: `cmpb $0x7`, convert if needed, walk the map
with `strcmp`, and when the key is absent insert a null value under a `malloc`'d copy of the key. Both return the
element in place. 51 is the same code (`0xa0f9df0` for the constructor, `0xa0fa500` for the assign).

`engine/json.ts` binds both through `engineSymbol` (`jsonObjectMemberInsert`, `jsonArrayElementInsert`, the latter
refusing a negative index, which 2024 would have turned into a 4-billion-element resize). `connreq.ts`'s two
`derived()` call them. The proxies' `get` still checks `isMember` / `size` first, so reading a missing key inserts
nothing. A returned element stays valid after later inserts: array elements are separate heap `Value`s behind the
vector, and object members are `std::map` nodes.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/json40.ps1 tools/host/drivers/json51.ps1`, run-full,
`tools/softenum-probe.ts` `seprobe json` twice per session, **24 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit
correctly`; `work/host-runs/json40-20260929-124406.txt`, `json51-...`):

- `get("a").setValue(5)` on `{x:1}` gives `{"a":5,"x":1}`. `get("a")` a second time leaves the size at 2.
- `get("o").get("b").setValue("s")`: the new null member becomes an object (type 7) holding `{"b":"s"}`.
- `get("arr").get(2).setValue(true)` gives `[null,null,true]` (type 6, size 3). `get(0)` then replaces in place.
- The object proxy's `p = 7` inserts. The array proxy's `[4] = "z"` grows the array to 5. Reading `proxy.missing`
  gives `undefined` and inserts nothing. `get(-1)` throws.
- The whole value reads back `{"a":5,"arr":["first",null,true,null,"z"],"o":{"b":"s"},"p":7,"x":1}`.
- 200 rounds of null -> nested member and array element, read back and destroyed, all right.
- `CommandOutput.set_Vec3("pos", 1 2.5 -3)` after `set_int("i", 1)` on a DataSet output gives
  `{"i":1,"pos":{"x":1,"y":2.5,"z":-3}}`. On an AllOutput output it leaves the property bag null.

The first pair (`json40/51-20260929-123846`, without the `set_Vec3` lines) gave 20 / 0 each. Regression after:
`text40/text51` 16 / 0 each (`_toJson`, `constructWith` of an object), and `params40/params51` 49 / 0 each (a parsed
`JsonValue` parameter read back through `get`, `{"a":1,"b":[true,"x",2.5],"c":{"d":"e"}}`; `params40/51-20260929-124620`).

## 18. The rest of `CommandOutput::set<T>` -- done on both builds (2026-09-29)

`set_bool`, `set_float`, `set_string` and `set_BlockPos` threw on both builds. Only `set<int>` had shipped (section 13).

**Found as a family.** Every 2024 `set<T>` checks for DataSet (`cmpl $0x4,(%rcx)`), builds a `std::string` from the
key, calls `Json::Value::operator[](const std::string&)` on the property bag, then constructs, assigns and destroys one
`Json::Value`. Among the callers of that operator (40 `0x9fdb2b0`, 964 sites; 51 `0xa0fb870`), the functions under 1200
bytes that open with the DataSet compare are exactly five on each build. They differ only in the `Value` constructor
they call, which the constructor's type byte identifies:

| constructor (type byte) | 40 | 51 | call sites (both builds) | 2024 name |
|---|---|---|---|---|
| `Value(int)` (1) | `0xb8ca0` | `0xb9520` | 36 | `??$set@H@` (section 13) |
| `Value(unsigned)` (2) | `0xb6fe0` | `0xb77d0` | 2 | (not bound by bdsx) |
| `Value(double)` (3), after `cvtss2sd` of xmm2 | `0x3bb210` | `0x407dc0` | 5 | `??$set@M@` (2024 `0x10a81a0`) |
| `Value(const char*)` (4) | `0xb5c40` | `0xb6360` | 11 | `??$set@PEBD@` (2024 `0xfb600`) |
| `Value(bool)` (5) | `0x3af3b0` | `0x3fcb30` | 16 | `??$set@_N@` (2024 `0xce8d30`) |

The three bdsx needs ship by address under 2024's names. No `set<std::string>` exists on either build (2024 `0xfb6d0`
copied its by-value argument, then did the same), so `set_string` is a `derived()` over `set<const char*>`
(`engine/command.ts` `commandOutputSetString`). `set<BlockPos>` (2024 `0x10a8270`) called
`CommandPropertyBag::set(key, BlockPos)`, which wrote `json[key]["x"|"y"|"z"] = Value(int)`. Nothing like it is left, so
bdsx writes the three members itself through the inserting `JsonValue.get` (section 17).

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/json40.ps1 tools/host/drivers/json51.ps1`, `seprobe json`
twice per session, **30 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/json40-20260929-142456.txt`, `json51-...`). The writes to one DataSet output were:

- `set_bool` of `b` true and `f` false
- `set_float` of `x` 1.5 and `w` 2
- `set_string` of `s` "hi" and `l`, 38 characters (past SSO)
- `set("g", "generic")`
- `set_BlockPos` of `p` (1, -2, 300)

They read back as `{"b":true,"f":false,"g":"generic","l":"...","p":{"x":1,"y":-2,"z":300},"s":"hi","w":2,"x":1.5}`.
The type bytes were b 5, w 3 (the engine's `set<float>` stores a double even for 2), x 3, s 4 and p 7. The same calls
on an AllOutput output leave its property bag null, as `set<int>` does. 200 rounds of
`set_string`/`set_float`/`set_bool` were read back and destroyed without error.

## 19. `CommandSelectorBase` `getName`, `hasName`, `setType`, `setIncludeDeadPlayers` -- done on both builds (2026-09-29)

These four threw on both builds. In 2024 each was a short body over the selector's fields: `getName` (`0xd09fb0`) and
`hasName` (`0xd0a9e0`) walk the name filters at +0x10..+0x18, whose entries are `InvertableFilter<std::string>` (0x28
bytes, the inverted flag at +0x20), for the first entry that is not inverted. `setType` (`0xd11e40`) writes +4, and
`setIncludeDeadPlayers` (`0xd11aa0`) writes +0xb8. Both setters clear `isExplicitIdSelector` (+0xc0). Section 10.3
showed the selector keeps 2024's layout on both builds, so bdsx runs the same bodies over its own fields as
`derived()`.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/sel40.ps1 tools/host/drivers/sel51.ps1`, a plugin command
`seprobesel <who: ActorCommandSelector>` run from the console with the bot and two pigs present, **11 PASS / 0 FAIL on
each build**, tsc 0, exit 0, `Quit correctly`; `work/host-runs/sel40-20260929-144451.txt`, `sel51-...`):

- `getName` / `hasName` give 'bdsxprobe' / true for `@a[name=bdsxprobe]` and for the bare name `bdsxprobe`. They give
  '' / false for `@a[name=!foo]`, `@e[type=pig]` and `@e`.
- The engine's `newResults` follows `setType(Players)`. For `@e` it went from fifteen entities (pigs, items, parrots, a
  creeper, the player, ...) to the player alone, and for `@e[type=pig]` from the pigs to none.
- `setIncludeDeadPlayers(true)` leaves the byte set and `isExplicitIdSelector` clear. Its engine effect, selecting a
  dead player, was not exercised.

The first run used `@e[r=40]`, which from the console's origin is a sphere around the world origin and selected
nothing. That was the driver's mistake, and it now uses `@e`.
