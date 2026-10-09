# The ability block (route: one layout, fifteen names)

2026-09-21. The next batch after Q1-0 in `docs/next-steps.md`. **Only one address
(`INVALID_ABILITY`), and the other fourteen are bodies bdsx writes itself on top
of a layout.** Both builds `abilprobe` **25/25 PASS + exit 0 +
`Quit correctly`** (`work/host-runs/abil40-20260921-013024.txt`, `abil51-...`).

## Why this batch

The nineteen required names from `?getBool@LayeredAbilities@@` through
`?setBool@Ability@@` are **arithmetic over one object**. None of them survives
out of line in 1.26 -- the inliner took all of them. But
`?getAbilities@Player@@` was already shipped as an address on both builds. So
the entry existed and everything behind it was gone; what was needed was not
an address but the object's shape.

## Shape

| | 2024 (1.21.3.01) | 1.26.40.8 / 1.26.51.1 |
|---|---|---|
| `Ability` | 12B: type +0, value +4, options +8 | same |
| `AbilityCount` | **19** | **20** (`VerticalFlySpeed` added) |
| `Abilities` | 19 × 12 = 228B | **20 × 12 = 240B** |
| `AbilitiesLayer` count | **5** | **6** (`Editor` added) |
| `LayeredAbilities` layer start | +4 | **+24** (`PermissionsHandler` became 24B) |
| layer bases | 4 / 232 / 460 / 688 / 916 | **24 / 264 / 504 / 744 / 984 / 1224** |
| `sizeof(LayeredAbilities)` | 1144 | **1464** |

**Three routes say the same thing.**

1. **Dynamic index lookup** (40 `0x1324570` / 51 `0x12b3e20`, both builds 141B,
   identical): `cmpb $19, %bl; ja` -> valid index 0..19 = **20 entries**. Then
   `leaq (%rdx,%rdx,2); leaq (%rax,%rdx,4)` = index × 12. And it walks the
   layer bases in order **1224 -> 984 -> 744 -> 504 -> 264 -> 24**, stopping at
   `cmpb $1, <base>(%rax)` (type != Unset). 2024's `?getBool@LayeredAbilities@@`
   (`0x17943b0`) does the same thing with `cmpb $18` and a 228 stride.
2. **Component stride.** Two functions that use `AbilitiesComponent`
   (40 `0x220120` = `getPlayerPermissionLevel`, 40 `0x220200` = the permission
   setter) index an element with `imulq $1464`. **1464 = 24 + 6 × 240.**
3. **Endstone** (Apache-2.0) `layered_abilities.h` / `abilities.h`:
   `PermissionsHandler permissions_` (command 0, player 1, `shared_ptr` 8 ->
   24B), then `array<Abilities, LayerCount=6>`,
   `static_assert(sizeof(Abilities) == 240)`, `static_assert(sizeof(Ability) == 12)`.

Reading a value is `cmpb $1,(%rax); setne %cl; andb 4(%rax),%cl`
(40 `0x2df7fc0` / 51 `0x2fb68c0`) -- **false if Unset, otherwise the byte at
+4**. 2024 is the same (`cmpb $1,(%rcx); jne; xorb %al,%al; movzbl 4(%rcx)`).

## `Abilities::INVALID_ABILITY` -- the one address in this batch

2024's `getBool` walks every layer and, if all are Unset, uses one global. The
target of that `lea` is `?INVALID_ABILITY@Abilities@@2VAbility@@A`
(`0x33c8308`) -- that's what the baseline symbol table says. The function that
inlines the same walk on 1.26 (40 `0x2202f0` / 51 `0x2af090`, both 398B, both
users of `AbilitiesComponent`) has a `lea` at the **same spot (+323)** pointing at:

* **1.26.40.8 `0xc8b8784`**, **1.26.51.1 `0xcc1f510`**.

Both builds independently back this up: there are **73** `lea`s referencing
that address on each, and the referencing functions correspond one-to-one by
size (474 / 448 / 353 / 370 / 398 / 1122x2 / 140 / 141 / 732 / 2201 / 627 /
746x2 / 340 / 574 / 1407 / 179 / 131 / 442 / 1199x7).

**Shipped as an address, not as a constant.** This storage is filled by a
dynamic initializer (the 2024 table has
`` `dynamic initializer for 'Abilities::INVALID_ABILITY'' ``) -- the bytes in
the file image are garbage, so the `constants` route would be wrong. Reading
that address at runtime gives type 0 (Invalid), and the probe confirms it.

## The fourteen bdsx carries itself

`data/derived.json`, code is the `// abilties.ts` section of
`bdsx/bds/implements.ts`. Whenever the table resolves a name, the binary wins
(`derived()`).

`Ability`: `getBool` · `getFloat` · `setBool`
`Abilities`: `getBool` · `getFloat` · `setAbility(_N)`
`LayeredAbilities`: `getLayer` · `getAbility` (index only) · `getAbility`
(layer+index) · `getBool` · `getFloatWithLayer` · `setAbility(_N)` ·
`setAbility(M)`
`Player`: `isFlying` (= `getAbilities().getBool(Flying=9)`; the 2024 body is
exactly those two steps)

And `?setPlayerPermissions@LayeredAbilities@@` is shipped as an **accessor**
(set, 1 byte, +1) -- right next to the already-shipped `getPlayerPermissions`
(+1) · `getCommandPermissions` (+0) · `setCommandPermissions` (+0). The 2024
body writes the byte and then makes a tail call to notify the client; that
call is not reproduced (`setCommandPermissions` is already in the same
situation).

**`setAbility` only writes to the Base layer** -- the 2024 body pins it as
`this + 232 + index*12` (= layer 1), and Endstone also has
`layers_.at(AbilitiesLayer::Base)`. The probe confirms this.

**bdsx's `AbilitiesIndex` enum keeps the 2024 numbering** (public API). 0..18
are the same across both eras and 1.26 just adds 19, so no translation is
needed -- only the **bound** is, and that comes from
`layouts.Abilities.abilityCount` (the same rule as `AttributeId`). The
`AbilitiesLayer` enum was empty, so it was filled with Endstone's six values.

## Execution confirmation (both builds 25/25)

`tools/abilities-probe.ts` (`abilprobe base|survival|creative|abilities|write|perms op|perms member`),
drivers `tools/host/drivers/abil40.ps1` / `abil51.ps1`.

A wrong stride would still "run," so only checks that **could only pass with
the correct layout** were counted:

* **`FlySpeed`(13) = 0.05, `WalkSpeed`(14) = 0.1** -- vanilla defaults read as
  floats. Off by even one slot and these numbers cannot come out.
  `getFloatWithLayer(FlySpeed)` is `{0.05, layer 1}`.
* **index 19 = `VerticalFlySpeed` = 1.000** -- the twentieth slot, which did
  not exist in 2024, actually holds a value. This is the execution evidence
  for `abilityCount = 20`.
* **`getLayer(0..5)` lands exactly at `+24 + n*240`**, `getLayer(6)` reads as
  an empty `Abilities`.
* **BDS writes, bdsx reads**: after `gamemode creative @a`, `MayFly` ·
  `Instabuild` are true; after `gamemode survival @a`, false; and **both come
  from the Base layer (1).**
* **The layer walk actually runs**: at the same moment, `Invulnerable`(8)
  comes from **layer 5** (`LoadingScreen`) -- a layer that did not exist in
  2024. (The first pass asserted that `Invulnerable` would also follow game
  mode, and FAILed on both builds. It was not the layout but **the check**
  that was wrong: a connecting bot is invulnerable during the loading screen,
  a fact already written in the runbook.)
* **bdsx writes**: `setAbility(Muted, true)` -> reads back true, recorded
  **only in the Base layer** (`Muted is set in layers [1]`), type Bool(2),
  reverts to false.
* **The first 24 bytes of the same object**: after `op @a`,
  `getPlayerPermissions()` is 2 (Operator); after `deop @a`, 1 (Member) --
  meaning the pointer that carries the layers is indeed the real
  `LayeredAbilities`. The new accessor `setPlayerPermissions(1)` was also
  confirmed by reading it back.

## The name table -- the function is gone, the table survives

2026-09-21. The string anchor noted under "What remains" above worked exactly
as expected. Both builds **45/45 PASS + tsc 0 + exit 0 + `Quit correctly`**
(`work/host-runs/abil40-20260921-124855.txt`, `abil51-...`).

The two 2024 functions are arithmetic over one table:

* `?getAbilityName@Abilities@@SAPEBDW4AbilitiesIndex@@@Z`(`0x17941f0`) =
  `movsbq %cl,%rax; leaq <table>(%rip),%rcx; movq (%rcx,%rax,8),%rax; retq`,
  four lines.
* `?nameToAbilityIndex@Abilities@@SA...`(`0x1797820`, 159B) = walks the same
  table up to `cmpl $19`, comparing length and bytes, and returns
  `movb $-1,%al` if not found.

The table is
`?ABILITY_NAMES@Abilities@@0V?$array@PEBD$0BD@@std@@A` (2024 `0x33393f0`) --
nineteen `const char*` entries in AbilitiesIndex order (build, mine,
doorsandswitches ... privilegedBuilder).

**Found by one string.** Looking for the NUL-wrapped `"doorsandswitches"` in
the target build gives **exactly one spot** (40 `0xa8a3cd4` / 51
`0xa9db4b5`), and there is **exactly one** qword in the whole image pointing
at that string's VA (40 `0xc741f38` / 51 `0xca8b388`, both in `.data`).
Reading around it gives the same nineteen entries in the same order as 2024,
followed by **a twentieth, `"verticalFlySpeed"`**, and a null qword.

* **Table: 40 `0xc741f28` / 51 `0xca8b378`.** Shipped under the key
  `bdsx:Abilities::ABILITY_NAMES` -- since the array length changed from 19
  to 20, the 2024 decoration (`$0BD@` = 19) is not this build's name, and the
  real name is a guess.

**The length was not assumed, it was read.** Collecting every
`lea r64,[rip+disp32]` across `.text` that resolves to that address gives
**5 sites** on both builds (2024 has 6, two of which are the two functions
above). One of them (40 `0x208900` / 51 `0x296200`, both builds 474B)
actually walks the table: `movq (%r15,%r13),%rax` (r13 = table),
`addq $8,%r15`, **`cmpq $160,%r15`** = **20 entries**. The same function uses
`addq $12,%rdi` and the layer bases 24/264/504/744/984/1224 -- the exact
numbers pinned in the section above. 2024's counterpart (`0x178fdd0`, 473B)
does the same walk with `cmpl $19,%ebx` and
`leaq 29(%rax),%rdx; leaq (%rax,%rdx,2),%rdx; leaq (%rdi,%rdx,4),%rdx`
(= 12×index + 232, 2024's Base layer). **It's the same function, grown by one slot.**

**1.26 has no out-of-line copy of either function.** Those 5 sites are all of
`.text` (the scan does not go through `.pdata`, so leaves are included too),
and none of them is a four-line function. The `lea` right next to it is
`Abilities::INVALID_ABILITY` (40 `0xc8b8784` / 51 `0xcc1f510`), already in the
table -- the same two instructions confirm both addresses at once.

So **both ship as `derived()`** (`bdsx/bds/implements.ts`). The count uses
`layouts.Abilities.abilityCount` (the same bound the binary checks before
indexing), and the table is read once and cached. `nameToAbilityIndex`
**compares bytes exactly** -- as 2024 did, so the `toLowerCase()` the bdsx
call sites apply means `flySpeed`/`walkSpeed`/`verticalFlySpeed`/
`privilegedBuilder` still never match, forever. That is 2024's behavior, and
it was left as is.

### Execution confirmation (both builds 45/45)

`abilprobe names [survival|creative]`, two lines added to drivers
`abil40/51.ps1`.

* **All twenty entries are non-empty and distinct**, `names[0..1]` = build, mine.
* **`getAbilityName(13)` = `"flySpeed"`** -- the capital S is the table's own.
  A guessed lowercase array cannot produce this value, nor can `walkSpeed` /
  `privilegedBuilder`.
* **`getAbilityName(19)` = `"verticalFlySpeed"`** -- the twentieth slot, which
  did not exist in 2024, actually carries a name.
* `nameToAbilityIndex` maps all **16 lowercase names** back to their own
  index, and non-ability names to -1.
* **The table is tied to a live object**: the index that `"mayfly"`/
  `"instabuild"` point to is exactly the index that
  `gamemode creative|survival` moves (confirmed in both directions).

## What remains

* `??0UpdateAbilitiesPacket@@QEAA@UActorUniqueID@@AEBVLayeredAbilities@@@Z`: **done 2026-09-23 in the
  engine layer** (next section). What follows is the static record that led there.
  **1.26 has no out-of-line copy** (confirmed statically, 2026-09-21). The
  2024 constructor (`0x9e6380`, 75B) fills the Packet header, stores the
  vftable, then passes rdx·r8 straight through to a member constructor via
  `addq $48,%rcx`; among the 23 functions in 1.26 that store
  `??_7UpdateAbilitiesPacket@@6B@` (40 `0xa5dfa10` / 51 `0xa64c4e0`), none has
  that shape (only two build `this+48`, and both do something else), and
  none has the caller count (10 in 2024) that would match. What's left is
  only the **move constructor** (40 `0x31ab8c0`, 216B: header
  `movabsq $0x100000002` -> +8/+12, `movw $0,16`, +24 0, vftable, then steals
  +48/+56 and vector 64/72/80 from rdx, `movl $1,88`) and the destructor
  (40 `0x3af610`, 125B).
  -> The next route is not an address but the **body**: Endstone's
  `update_abilities_packet.h` (Apache-2.0) gives
  `sizeof(UpdateAbilitiesPacket)` = 96, payload `SerializedAbilitiesData` at
  +48, `SerializationMode` at +88, and `serialized_abilities_data.h` gives
  the layout inside it (`ActorUniqueID` +0, command/player permission +8/+9,
  `vector<SerializedLayer 24B>` +16). The move constructor confirms all of
  those offsets. Since bdsx only uses this in `Player::syncAbilities`, it can
  become a `derived()` that builds and fills that vector directly.
* `?getAbilityName@Abilities@@` / `?nameToAbilityIndex@Abilities@@`: **done** (above).

## `UpdateAbilitiesPacket` in the engine layer (2026-09-23, A3 / Q1-2)

`Player.syncAbilities` no longer needs the constructor. It takes a packet from
`MinecraftPackets::createPacket(0xbb)`, which supplies the engine's vftable, header and default payload
(`SerializationMode` 1 at +88). Then `bds/engine/abilities.ts` `writeUpdateAbilitiesPayload` fills
`SerializedAbilitiesData` at +48, following Endstone's constructor (`serialized_abilities_data.cpp`,
Apache-2.0):

- the target `ActorUniqueID` at +0, and the command/player permission bytes at +8/+9, copied from the
  `PermissionsHandler` (+0/+1)
- `vector<SerializedLayer>` at +16, allocated with `msAlloc` so the packet's own destructor frees it:
  - one 24-byte entry per layer that has anything set, top layer first
  - `abilities_set` has a bit per non-Unset record, and `ability_values` a bit per true Bool
  - then FlySpeed, VerticalFlySpeed and WalkSpeed

The offsets are the layouts `UpdateAbilitiesPacket` and `SerializedAbilitiesData`. The 1.26 move
constructor reads and writes exactly them on both builds (40 `0x31ab8c0` / 51 `0x12eeba0`, 216B, the
same instruction sequence).

**Execution, both builds** (`abilprobe sync`, `sync on`, `sync off`; drivers `abil40/51`): 54/54 PASS,
exit 0, `Quit correctly`.

- The payload read back from the packet's own memory holds the player's unique id and the
  `serializeLayers` layer count.
- The bot (`tools/probe-client.cjs` now logs `update_abilities`) decodes what bdsx sent:
  - base: allowed `0xfffff`, enabled `0xd3f` → `0x8d3f` → `0xd3f`. Bit 15 is Muted, which only bdsx
    changes, so these are bdsx's packets.
  - loading_screen: `0x13f`/`0x100`.
  - speeds: fly 0.05, vertical 1.0, walk 0.1.

  These are the values bdsx reads from the layers. Two sessions died before any `abilprobe` ran
  (51 0xC0000005 at 20:41, 40 0xC0000409 at 20:59, about 15 s after the bot joined, no fault capture).
  The same code then ran clean on both builds, and `layout`, `ride` and `sig` passed with it (queue Q8).

