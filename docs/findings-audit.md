# Q3 audit: names a low-trust route filled that nobody has read (2026-09-22)

`node tools/size-audit.mjs <v>` lists required names whose current address comes from a
route other than `resolved`/`instances`/`packets` and whose `.pdata` size is more than 3x
off the 2024 namesake's. It is not a veto by itself (EnTT turned many 50-byte getters into
250-byte component lookups, and a leaf with no `.pdata` entry reads as size 0 even when it
is exactly right) -- every row still had to be read. This is a static audit only: no host
session, no execution. Four names were wrong and are now in `retracted`
(`data/candidates-instances-<v>.json`); the rest were read and left as they were, because
the shape survived the read.

## Retracted

**`?attack@Player@@UEAA_NAEAVActor@@AEBW4ActorDamageCause@@@Z`, both builds.** This is the
address bdsx *hooks* for `events.playerAttack` (`bdsx/bdsx/event_impl/entityevent.ts`), so a
wrong address here is not a cosmetic miss -- it is a hook installed on someone else's
function, which BDS calls on every normal play-attack. The candidate (40 `0x2295e0`, 51
`0x2b8480`, both "endstone-slots", "AGREE with vftable-walk") is 34 bytes; the 2024
namesake is 1,984. `shape()` shows why: 2024 reads `r8,rdx` (three-argument member call,
`this=rcx`, `Actor& victim=rdx`, `ActorDamageCause& cause=r8`); both 1.26 candidates read
only `rdx`. The body is a five-instruction stub -- load a constant into a stack slot, call a
neighbour, return the untouched second argument -- nothing like combat resolution.

Endstone's header explains it: 1.26 declared `attack` **virtual** on `Actor`
(`virtual ActorHurtResult attack(Actor &, ActorDamageCause const &) = 0;`, slot 52), where
2024's was a non-virtual `bool`-returning `Player::attack`. `ActorHurtResult` is a struct,
so the new calling convention has a hidden return pointer as the first argument -- every
downstream register shifts by one, which is exactly the `r8` that stopped being read. This
is the same trap already recorded for `Actor::hurt` / `Mob::_hurt`
(`data/candidates-instances-<v>.json` `retracted`, `docs/HANDOFF.md` rule 3): two routes
agreeing on a vftable slot proves the *slot*, not the *prototype*, and vftable-walk /
endstone-slots is exactly the route that finds slots. Unlike `hurt`/`_hurt`, this one was
never promoted past propagation, so nothing currently hooks it -- but `events.playerAttack`
is one of the Q7 events waiting on a real client, and whoever wires it up next should not
assume the address is safe just because it is in the table. Next step: same fix as `hurt`
-- read the new `attack` body (40/51 `0x2295e0`/`0x2b8480` themselves are not it; the real
override is one of vftable slot 52's targets, still unidentified), work out the
`ActorHurtResult` layout, and ship it `bdsx:Actor::attack` the way `bdsx:Actor::hurt` and
`bdsx:Mob::_hurt` are shipped, with the prototype read from the body, not assumed from 2024.

**Resolved (2026-09-22, Q3-1).** The correction above was itself half wrong: `0x2295e0` /
`0x2b8480` *are* the right addresses -- the "unidentified real override" is exactly this
34-byte function, not a different one. Reading it further shows it is not combat logic; it
is a compiler-generated ABI shim for the virtual signature, byte-identical on both builds:

```
pushq %rsi; subq $0x30,%rsp; movq %rdx,%rsi        ; save the hidden result pointer
leaq <const>(%rip),%rax; movq %rax,0x20(%rsp)      ; a 5th, unnamed stack argument
callq <body>                                       ; this/result/victim/cause pass straight through
movq %rsi,%rax; addq $0x30,%rsp; popq %rsi; retq    ; echo the result pointer in rax
```

`rcx`/`rdx`/`r8`/`r9` are never touched between entry and the `call`, so they reach the
callee unchanged: `this`, the hidden `ActorHurtResult*`, `Actor& victim`,
`ActorDamageCause const& cause` -- exactly the shift the paragraph above predicted, with the
`r8` shape() flagged as unread simply passed through rather than moved into a named
register. The callee (40 `0x229610`/3490B, 51 `0x2b84b0`/3429B, both `.pdata` starts) is the
real ~3.4KB combat body: its prologue reads `r9,r8,rdx,rcx` into `r15,r14,rsi,rdi` in that
order (cause, victim, result, this), it does EnTT component lookups (including
`WasInWaterFlagComponent` = `0x78e89f39`, matching `docs/findings-weather.md`) and an
`AbilitiesComponent` lookup (`0x68b75d48`) through a `canUseAbility(Player*, AbilitiesIndex)`
helper at `0x21f0a0`, and its early-exit branches write the sret struct as
`{value@+0=0, tag@+4=0, allowKnockback@+8=1}` -- the same `variant<bool,float>` + trailing
`bool` layout `Mob::_hurt` already established. 2024's baseline `Player::attack`
(`0x19d8220`) confirms the shift is exactly the hidden-sret insertion: non-virtual `bool`,
reads `rcx=this, rdx=victim, r8=cause` directly, no shim.

Hooking the shim needs no knowledge of the 5th argument -- `original()` replays the shim's
own untouched bytes, which still supply it. Shipped as `bdsx:Actor::attack`
(`bdsx/bdsx/event_impl/entityevent.ts`, `events.playerAttack.setInstaller`), prototype
`(this: Player, result: StaticPointer, victim: Actor, cause: Wrapper<int32>) -> StaticPointer`.
Executed on both builds (`q2at40`/`q2at51`, `tools/entity-sig-probe.ts` `sigprobe attack`):
the hook fires exactly once, the returned pointer echoes the result pointer passed in, and
the struct comes back well-formed and byte-identical on both builds -- `{0, 0, 1}`, i.e.
"not hurt". The golem's health does not move, and this is not a wrong address or
prototype: `attackPlayer.getAbilities().getBool(AbilitiesIndex.AttackPlayers)` and
`.getBool(AbilitiesIndex.AttackMobs)` both read `false` on both builds at the moment of the
call, which is exactly what the callee's own gate at `0x229649`/`0x21f0a0` checks before it
will touch the victim at all -- the same loading-screen-invulnerable state already on record
for other abilities (`docs/findings-abilities.md`, "One rule learned: a probe's PASS condition
must not depend on BDS's own internal judgment" and the `Invulnerable` note). A console-only bot never leaves that
layer, so an attack that actually lands still needs a real client (Q7). Evidence:
`work/host-runs/q2at40-20260922-*.txt`, `q2at51-20260922-*.txt`; `data/events-fired.json`
`playerAttack`; `data/resolved-<v>.json` `bdsx:Actor::attack`.

**`?getIdentifier@FuelItemComponent@@SAAEBVHashedString@@XZ`, both builds.** 2024's body
(`0x1e01d80`) is the standard magic-statics pattern: thread-safe once-init of a function-
local `HashedString` built from the literal `"minecraft:fuel"`
(`??_C@_0P@OGGEMAPP@minecraft?3fuel@`), no arguments read, ~60 bytes. The candidate (40
`0x7795a40`, 51 `0x2037e10`, both "propagation") is a multi-hundred-byte function that reads
`rcx`, `rdx`, `r8` **and** `r9`, and constructs/compares strings -- nothing a zero-argument
static accessor would do. `shape()` catches the same thing mechanically: 2024 reads no
registers, both candidates read three or four.

The string `"minecraft:fuel"` still exists once in each 1.26 binary (file offset
`0xa8c8d0a` on 1.26.40.8) and is `lea`'d directly from inside the `CoalItem` constructor
(1.26.40.8 `0x7791a70`, which the wrong candidate `0x7795a40` sits right next to in the same
translation unit) -- the getter looks to have been inlined at every call site (constructing
`CoalItem` and presumably every other `Fuel*Item`) rather than kept as a standalone
function, the same fate as `isHumanoidWearableItem` below.

**This whole family is a `derived()` opportunity bigger than one name.** bdsx declares
`getIdentifier` for at least sixteen `*ItemComponent` classes (`bdsx/bdsx/bds/implements.ts`
~5555-5580: Cooldown, Armor, Durability, Digger, DisplayName, EntityPlacer, Food, Fuel, Icon,
OnUse, Planter, Projectile, Record, RenderOffsets, Repairable -- `Dye` and
`KnockbackResistance` are already commented out as removed). Every one of them is a
zero-argument static returning a compile-time-fixed `HashedString` of the component's own
name. Only `Fuel`'s currently has an address in the table (the wrong one just retracted);
the other fifteen have never resolved at all. None of them need the binary -- `HashedString`
only depends on the input string, so all sixteen are candidates for `derived()` computing
the hash of the literal name directly, the same move `findings-utils.md` documents for other
addressless names. This was not attempted here (out of this audit's scope) but is the
cheapest next step for this whole name family; left as a note rather than a queue item since
it is not what Q3 asked for.

**`?getComponentItem@ItemStackBase@@QEBAPEBVComponentItem@@XZ`, 1.26.51.1 only** (1.26.40.8
carried no candidate for this name at all -- still fully unresolved there). 2024's body
(`0x1b5f670`, 70 bytes) is item_-pointer-chases: `item_+8`, deref, a vtable virtual call at
`+0x40` as a gate, then return a field of `item_` -- the same "item_+8, deref, vtable check"
family as `isHumanoidArmorItem` below. The 51 candidate (`0x27db90`, "propagation", 371
bytes) does none of that: it zero-initializes a 24-byte object at `[rcx]` with `movups`,
sets a 0xf/0 SSO-string pattern, and calls into what looks like string construction/copy
machinery (`0xa5bccf0`, `0xbc5a0`) -- building a `std::string`, not chasing an `item_`
pointer to return a `ComponentItem*`. Not read further given time; the correct 1.26 body
should resemble the `item_+8 -> deref -> vtable+0x48/+0x50` shape used by
`isHumanoidWearableBlockItem`/`isHumanoidArmorItem` below, which is the cheapest place to
look next (same translation unit, same `item_` chase, same vtable region).

**`?getDefaultBiome@NetherDimension@@UEBA?AVHashedString@@XZ`, both builds** (byte-identical
candidate on both: 40 `0x8111670`, 51 `0x880e5e0`, both "endstone-slots"). 2024's body
(`0x2883f0`) copy-constructs a `HashedString` from the global `VanillaBiomeNames::Hell` into
the caller's sret buffer via `HashedString::HashedString(HashedString const&)` -- it touches
the whole struct through a real constructor call. The 1.26 candidate is eight bytes:
`movq %rdx,%rax; movw $0x8,(%rdx); retq` -- it writes a single 16-bit immediate (`8`) into
the first two bytes of the sret buffer and returns, never reading any biome name, hash, or
global constant. A `HashedString` copy cannot be two instructions with no source operand;
this is some unrelated tiny setter that the vftable-slot walk lined up by position, not by
content (the same "position fills an equal-length gap with the wrong content" failure mode
`next-steps.md` documents for the nine new Level slots). Not required by bdsx to be right
for boot -- `NetherDimension` biome default is a narrow path -- but wrong as it stood.

## Read and left as-is (static confidence, no execution)

**Confirmed by a second, independent route already in the docs**, so no action needed:
`?hasType@Actor@@`, `?isType@Actor@@`, `?isSpectator@Actor@@`, `?getDimensionId@Actor@@`,
`?getAbilities@Player@@`, `?getArmor@Actor@@`, `?getHandContainer@ActorEquipment@@` all
carry the EnTT component-hash their name predicts on both builds
(`docs/findings-components.md`, "route 10" / "the second batch") -- the size growth
`size-audit.mjs` flags for them (a 50-300 byte field read turning into a 200-450 byte
sparse-set lookup) is exactly the transformation that route documents, not a sign of a
wrong address.

**`?isHumanoidWearableItem@ItemStackBase@@QEBA_NXZ` -- split by build (Q1-B 4).** 2024's
body is `isHumanoidArmorItem() [inlined vtable+0x48 call] || isHumanoidWearableBlockItem()
[out-of-line call]`. **1.26.51.1's candidate (`0x1a59d80`, 194B) is correct**: it performs
the same two checks in the same order (vtable `+0x50` virtual call, then an inlined
tag-membership walk over a global vector at `item+0x178` in place of the out-of-line call),
and its caller count (3) is close to 2024's (2) -- both plausible after the second check got
inlined into it. **1.26.40.8's candidate (`0x1bc3ad0`, 272B) is wrong**: its body is *only*
the tag-walk half (`item_+8`, deref, `+0x178`, walk the vector, compare against a global
constant) with no vtable call at all, and it has 11 callers -- far more than 2024's 4 callers
of `isHumanoidWearableBlockItem` (the function this half actually matches) or 2 of
`isHumanoidWearableItem` itself. Two of those 11 callers (`0x8f66a50`, `0x1bc7a90`) inline
the missing vtable-`+0x50` check themselves and then call `0x1bc3ad0` as a plain fallback --
i.e. **1.26.40.8 has no standalone `isHumanoidWearableItem`; it is inlined at every call
site**, and `0x1bc3ad0` is actually **`isHumanoidWearableBlockItem`**, a name bdsx also
declares (`ItemStackBase.prototype.isHumanoidWearableBlockItem`,
`bdsx/bdsx/bds/implements.ts:3734`) and has never resolved on either build.
`tools/byte-find.mjs` confirms 0x1bc3ad0's first 24 bytes have no twin anywhere in 1.26.51.1
-- the two builds genuinely diverged on which half got kept out-of-line, they are not the
same function at different addresses.

Action taken: `?isHumanoidWearableItem@ItemStackBase@@QEBA_NXZ` is retracted for
**1.26.40.8 only** (kept as-is on 1.26.51.1). No replacement address is shipped for
1.26.40.8 -- the real function is inlined everywhere it's used, so the eventual fix is
`derived()`: `vtableCall(item, +0x50) || isHumanoidWearableBlockItem(item)`, and
`isHumanoidWearableBlockItem` itself *does* have a real 1.26.40.8 address now
(`0x1bc3ad0`, static confidence only -- one route, no execution, so it is **not** added to
the table; a second route or an execution check is needed before it ships). 1.26.51.1's
`isHumanoidWearableBlockItem` was not searched for (fully inlined into `0x1a59d80` there,
same as 1.26.40.8's `isHumanoidWearableItem` is inlined into its callers -- no standalone
copy expected).

**Everything else on the size-audit list was read at least once and the shape held up**:
argument registers the baseline reads are still read (or the divergence is explained, e.g.
`?setSneaking@Actor@@`'s bool argument shows up 200 instructions into an EnTT-flag gate that
`shape()`'s scan window doesn't reach, not because it's unread), sizes that grew did so into
the same two shapes documented elsewhere (EnTT sparse-set lookup: `mov` a base pointer,
`sub`/`shr` a begin/end pair, `and` with a hash constant, walk a 32-byte-stride bucket list
-- confirmed present with a real hash in `?getCommandPermissionLevel@Player@@`,
`?isImmobile@Actor@@` among others; or a leaf with a real, sensible field access and no
`.pdata` entry, confirmed for `?fetchEntity@Level@@`, `?getUsers@Level@@`,
`?getEntities@Level@@`, `?getActiveUsers@Level@@`, `?getNextRuntimeID@Level@@`,
`?getNewUniqueID@Level@@`, `?sendAllPlayerAbilities@Level@@` -- all six read a plausible
member offset and either tail-jump to a differently-named 2024-shaped handler or increment
a counter in place, matching their 2024 namesakes' own leaf/thunk shape one for one).
`?initializeFromNetwork@ComponentItem@@` grew from 87 to 8,035 bytes (the largest ratio on
either list) but the size is explained by its job: deserializing every possible item
component's fields out of a `CompoundTag` from the network is inherently a big dispatch, and
the body does read the `CompoundTag&` argument as its first move. `?destroyBlock@Level@@`'s
"0 -> 515" entry is a metric artifact, not a finding: the baseline was *also* 0 (no `.pdata`
entry in 2024 either -- both ends are leaves), so the ratio's denominator is `8` (the
formula's floor) rather than a real 2024 size; the body reads all three declared arguments
plus a fourth stack argument that matches the `BlockChangeContext const&` `setBlock`
already established for the same class (`docs/findings-blocks.md` section 7).

**One flagged and left open, not retracted:** `?sendArmorSlot@Mob@@QEAAXW4ArmorSlot@@@Z`
(40 `0x23eb40`). The body opens with a jump table indexed directly by `%rcx`
(`movslq (%rax,%rcx,4),%rcx; jmpq *%rcx`) -- but `rcx` is the `this` pointer under the
declared calling convention (`this=rcx`, `ArmorSlot slot=rdx`), and the case bodies read
`%r8`, not `%rdx`, as the per-slot data. Either the compiler produced an unusual register
assignment this reading doesn't explain, or `0x23eb40` is not `Mob::sendArmorSlot`. Not
enough evidence either way to retract (the alternative reading -- that the function is a
static/free dispatcher with a different implicit-argument order -- isn't ruled out), and
`sendArmorSlot` is called by bdsx (`Mob.prototype.sendArmorSlot`, `bds/implements.ts:1891`)
but only from user code sending an equipment-visual update, not hooked, so a wrong address
here would surface as "nothing visibly happens" rather than a crash. Left as a flagged
unknown for the next static or execution pass, not touched.

## Q3 follow-up: the three names next-steps left open (2026-09-22, static only, no execution)

next-steps.md's Q3 "Next steps" left three items after the audit above. All three are
resolved by static reading alone -- no host session was used.

**(3) `?isHumanoidWearableBlockItem@ItemStackBase@@QEBA_NXZ` -- promoted on 1.26.40.8,
`0x1bc3ad0`.** The section above already had one route (caller-count proximity: 11 callers
vs 2024's 4). A second, independent route closes it. Route 1, reread: 0x1bc3ad0's body walks
a vector of pointers, comparing each element's `+0xe0` field against a small membership set
-- `+0xe0` is the offset this table already carries as `BlockLegacy::name` (`docs/findings-blocks.md`),
so the elements are `BlockLegacy*` and the function is a data-driven "is this block one of a
known set" test. That is the natural 1.26 successor of 2024's `isHumanoidWearableBlockItem`
(`0x1b64ba0`, 142B), which chases `item_+8 -> Item::getLegacyBlock -> BlockLegacy` and then
does the same kind of comparison, just hardcoded to two globals
(`VanillaItemNames::Skull`, `VanillaBlockTypeIds::CarvedPumpkin`) read off `BlockLegacy+0x98`
(2024's `name` offset, moved to `+0xe0` in 1.26). Route 2, new: 2024's
`isHumanoidWearableBlockItem` has exactly 4 direct callers (`tools/callgraph.mjs`) --
`canBeSeenOnMap@Player`, `getArmorSlot@ItemStackBase`, `isHumanoidWearableItem@ItemStackBase`
(the wrapper `vtable_slot10() || isHumanoidWearableBlockItem()`),
`matchesEitherWearableCase@ItemStackBase`. Two of 2024's callers of that *wrapper* --
`ArmorStand::getInteraction` and `ArmorContainerValidation::isItemAllowedInSlot` -- have
independently resolved 1.26.40.8 addresses from unrelated routes (vftable-walk /
endstone-slots: `0x23b8330`, `0x8f66a50`), and reading both bodies shows each one hand-rolling
2024's exact OR: an inlined `Item` vtable `+0x50` virtual call (bool), and only when that is
false, a direct call to `0x1bc3ad0`. That is the same OR 1.26.51.1's confirmed
`isHumanoidWearableItem` (`0x1a59d80`) performs in one function without an out-of-line second
half -- 1.26.51.1 inlined all of it, 1.26.40.8 kept this half as a function both re-derived
callers fall back to. Two independent routes agree, so it ships:
`data/resolved-1.26.40.8.json`. No 1.26.51.1 address -- none expected (fully inlined into
`0x1a59d80` there, `docs/findings-containers.md` section 10). Not a hook target
(`procHacker.js` only, `bdsx/bdsx/bds/implements.ts:3762`).

**(4) `?getComponentItem@ItemStackBase@@QEBAPEBVComponentItem@@XZ` -- confirmed inlined on
both builds, no address exists.** 2024's body (`0x1b5f670`, 70B) is
`A = *(this+8); B = *A; if (B && vtable(B)[8]()) return B; else return null;` (item_ at `+8`,
double deref, an `Item` vtable slot-8 boolean gate, return the same pointer on true). Its 4
known-name 2024 callers narrow to `Mob::doHurtTarget`, `Mob::getArmorMaterialTypeInSlot`,
`Mob::getArmorTextureIndexInSlot`, `Mob::setItemSlot`. `Mob::getArmorMaterialTypeInSlot`'s
1.26.51.1 body (`0x29ee760`) is byte-identical to 1.26.40.8's (`0x2406d20`) at the relevant
span, and both inline getComponentItem's exact shape verbatim -- same `this_item+8` entry,
same double deref, same null gates -- with the vtable slot moved from `0x40` (slot 8) to
`0x48` (slot 9), a +1 shift matching the +1 shift already on record for
`isHumanoidWearableItem`'s vtable-slot-10 check (2024 slot 9). Endstone's HEAD `item.h`
independently names slot 9 `virtual bool isComponentBased() const = 0` (counting from the
destructor at slot 0) -- exactly the boolean gate this body performs, a third, independent
confirmation of both the slot number and its meaning. A generic-shape scan of both builds'
`.pdata` for standalone functions matching "`this+8` deref pattern, a vtable call through a
slot in `0x38..0x60`, a null-return path", sized 45-100B (wide enough to catch 2024's real
70B function), finds **zero** out-of-line candidates on either build -- this is not a search
failure, it is a fact about the binary: 1.26 inlines this getter at every call site on both
builds, no exceptions found. Not shipped as an address (there is none to ship). The fix is
`derived()`: `item_+8` (the offset is unchanged from 2024, already used throughout the
table) then an `Item` vtable slot-9 (`0x48`) virtual call (`isComponentBased`); not attempted
here, since it means editing `bdsx/bds/inventory.ts` or `implements.ts`, out of a static-only
pass's scope.

**(5) `?sendArmorSlot@Mob@@QEAAXW4ArmorSlot@@@Z` -- retracted on both builds, wrong
function.** The section above flagged this and left it open (jump table on `rcx`, case
bodies reading `r8` not `rdx`). Reading the only caller settles it. 2024's `sendArmorSlot`
(`0x191a360`, `this=rcx`, `ArmorSlot slot=rdx`) range-checks `slot<4`, builds a one-bit
`std::bitset<32>` on the stack, and tail-jumps to a *virtual* call at
`this->vftable[0x560/8=172]` with `(this, bitmask)` -- there is no jump table anywhere in it.
Of `sendArmorSlot`'s 5 direct 2024 callers, only `ServerPlayer::setArmor` has a resolved
1.26 counterpart (2024 `0xcd3c30` calls `sendArmorSlot` with `rcx=this, edx=slot` straight
from its own argument; 1.26.40.8's counterpart is `0x695620`, 1.26.51.1's is `0x758d10`).
Both 1.26 bodies call the candidate (`0x23eb40` / `0x2d7470`) at the equivalent point, but
with **three** arguments, byte-identical register setup on both builds:
`movsbq 0x118(%rbp),%rcx; incq %rcx` (a slot-derived index, incremented by one, never read as
`this` afterward -- it is purely the jump-table selector, which is why the case bodies never
touch `rcx` again), `leaq 0x120(%rbp),%rdx` (a pointer into the player object, likely
`&armor_container[slot]`), `leaq -0x60(%rbp),%r8` (the address of a ~0x180-byte **local
variable on `setArmor`'s own stack frame**, not `this` -- and this is the `r8` the case
bodies read at `+0x18/+0x20/+0x30/+0x38/+0xb8/+0x150/+0x160/+0x170`, one branch writing
`??_7ItemStack@@6B@` into `+0x20`, consistent with constructing/copying a local `ItemStack`
rather than reading `Mob` state). This is a 3-argument helper taking a jump index, an item
pointer and a local buffer -- not `void Mob::sendArmorSlot(ArmorSlot)`, and it cannot be
called through that 2-argument prototype at all (there is no `this` in the call under this
reading). Retracted on both builds (`data/candidates-instances-1.26.40.8.json`,
`data/candidates-instances-1.26.51.1.json`); `sendArmorSlot` goes back to fully unresolved.
Not a hook target (`procHacker.js` only, `bdsx/bdsx/bds/implements.ts:1891`), so this was
never live-dangerous, just wrong. Next step, not attempted here: read the ~140 bytes of
1.26.40.8's restructured `setArmor@ServerPlayer` body *before* this call -- it no longer
calls a resolved `Player::setArmor` the way 2024 does, and the call right before this one
(`0x1284d70` / `0x11a85c0`) is a `std::_Visit` over a `PlayerSkinLoadedClientEvent` variant,
suggesting 1.26 restructured the whole function -- to see whether `sendArmorSlot`'s
bitset-and-virtual-call got inlined rather than staying out-of-line, the same way
`getComponentItem` did in (4).

## Q3 "Next steps" (1): `getIdentifier@*ItemComponent`, nineteen names, `derived()`, executed

The section above ("This whole family is a `derived()` opportunity bigger than one name")
named the shape and listed fifteen of the names; the actual count in
`bdsx/bdsx/bds/implements.ts` (`Cooldown, Armor, Durability, Digger, DisplayName,
EntityPlacer, Food, Fuel, Icon, OnUse, Planter, Projectile, Record, RenderOffsets,
Repairable, Shooter, Throwable, Weapon, Wearable` -- `Dye` and `KnockbackResistance` stay
commented out as removed) is **nineteen**. All nineteen 2024 bodies were reread with
`disas-exact` against `1.21.3.01` (not just the `Fuel` one already on record), confirming
the shared magic-statics shape and reading the exact literal each one returns:

| class | literal | 2024 RVA |
|---|---|---|
| Cooldown | `minecraft:cooldown` | `0x1e01750` |
| Armor | `minecraft:armor` | `0x1e96160` |
| Durability | `minecraft:durability` | `0x1e01ab0` |
| Digger | `minecraft:digger` | `0x1e01990` |
| DisplayName | `minecraft:display_name` | `0x1e01a20` |
| EntityPlacer | `minecraft:entity_placer` | `0x1e01c60` |
| Food | `minecraft:food` | `0x1e01cf0` |
| Fuel | `minecraft:fuel` | `0x1e01d80` |
| Icon | `minecraft:icon` | `0x1e01fc0` |
| OnUse | `minecraft:on_use` | `0x1e02a40` |
| Planter | **`minecraft:block_placer`** | `0x1e02c00` |
| Projectile | `minecraft:projectile` | `0x1e02c90` |
| Record | `minecraft:record` | `0x1e02d20` |
| RenderOffsets | `minecraft:render_offsets` | `0x1e02db0` |
| Repairable | `minecraft:repairable` | `0x1e02e40` |
| Shooter | `minecraft:shooter` | `0x1e02ed0` |
| Throwable | `minecraft:throwable` | `0x1c86e80` |
| Weapon | `minecraft:weapon` | `0x1e032d0` |
| Wearable | `minecraft:wearable` | `0x1c87030` |

`Planter` reads differently from its class name -- would have been a guess if not read.
Every one of the nineteen literals was then searched byte-for-byte in both
`work/bin/1.26.40.8/bedrock_server.exe` and `work/bin/1.26.51.1/bedrock_server.exe`
(NUL-terminated, `count=1` for all 19 x 2 builds) -- the second, independent route: the 2024
body says what string a class returns, the 1.26 binary says that exact string is still
there, even though no 1.26 build keeps an out-of-line copy of any of the nineteen functions
(every call site inlines the literal, e.g. `"minecraft:fuel"` `lea`'d straight into
`CoalItem`'s constructor -- the same fate already on record for the retracted `Fuel`
address).

Shipped as `derived()`: `itemComponentIdentifier(sym, literal)` in
`bdsx/bdsx/bds/implements.ts` builds a `HashedString` once (`HashedString.construct()` +
`.set(literal)`, the same two calls `ComponentItem.getComponent()` already makes at every
call site) and returns the same reference forever after, matching the 2024 magic-statics
shape. `HashedString.set()` -> `computeHash()` is itself already `derived()` (FNV-1 in JS,
checked 6/6 against Endstone's published test vectors on both builds,
`tools/derived-probe.ts`) since `?computeHash@HashedString@@...` has no address on either
1.26 build either -- no address is needed anywhere in this family, only the literal text.
The two commented-out names (`DyePowderItemComponent`, `KnockbackResistanceItemComponent`)
were left untouched, matching the existing `// XXX: removed` state.

**Executed, route a, both builds (2026-09-22).** `tools/item-probe.ts`'s new `itemprobe
compid` step, drivers `tools/host/drivers/compid40.ps1` / `compid51.ps1`: all nineteen
statics return exactly the literal `disas-exact` read out of their 2024 body -- 19/19 PASS
on 1.26.40.8 and 1.26.51.1, `tsc exit: 0`, `exit code: 0`, `Quit correctly`
(`work/host-runs/compid40-20260922-205608.txt`, `compid51-20260922-205608.txt`).

**Route b, written but not executable yet.** The step also tries a second, BDS-side check:
`give`'d slot 0 is a diamond_pickaxe (has `DiggerItemComponent`, not `FoodItemComponent`)
and slot 1 an apple (the reverse), and `ItemStackBase.getComponentItem() ->
ComponentItem.getComponent(literal)` is BDS's own component map lookup, keyed by BDS's own
hash of the component's real registered name -- if this project's FNV-1 of `"minecraft:
digger"`/`"minecraft:food"` did not match what BDS actually stored the component under,
the lookup would come back null even on an item that truly has it. This would have been a
witness independent of everything else in this family (it does not touch
`itemComponentIdentifier()` at all). It cannot run: `ItemStackBase.getComponentItem()` has
no address on either 1.26 build (`Q3 follow-up` (4) above -- confirmed inlined everywhere,
a separate, already-documented gap, not this family's to fix). The probe step catches this
specifically and reports `SKIP`, not `FAIL`, so it is not mistaken for a wrong hash:
`[item] INFO compid-b SKIP: Symbol not found: ?getComponentItem@ItemStackBase@@... (... a
separate gap)` on both builds. Whoever ships `getComponentItem` as `derived()` next (the
`item_+8` -> `Item` vtable slot 9 move already scoped in `Q3 follow-up` (4)) gets this
second route for free -- `itemprobe compid` already exercises it, no probe change needed.

`data/derived.json`: 19 new entries, 109 -> **128**. `symbols.json`/`data/merged-<v>.json`
unchanged (no address family, nothing to merge) -- address coverage stays **347 / 344**,
covered-to-execution **424 / 418**, resolvable with `derived()` **552 / 546**.

## Q3 "Next steps" (2)(3): `getComponentItem` shipped, `sendArmorSlot` crashed and was reverted (2026-09-23)

**(2) `getComponentItem@ItemStackBase` -- `derived()`, executed, no address needed.** The
two static routes were already on record (Q3 follow-up (4) above): 2024's body is
`item_+8` double-dereferenced, gated by an `Item` vtable call at slot 9 (`+0x48`,
`isComponentBased` -- both the slot number and its name independently confirmed by
Endstone's HEAD `item.h`, counting from the destructor at slot 0), and both 1.26 builds
inline this exact shape verbatim inside `Mob::getArmorMaterialTypeInSlot` (40 `0x2406d20` /
51 `0x29ee760`, byte-identical at the relevant span, reread with `disas-exact` this time
rather than taken on trust). Shipped as `derived()`: the `item_` chase duplicated (not
calling the protected `_getItem`) plus a raw asm tail-jump through the vtable slot, the same
`mov_r_rp`+`jmp_rp`+`.alloc()` trick `Packet::getId` already uses for `vft[1]`, here for
`vft[9]`. **Executed, both builds, twice each (2026-09-23)**: `itemprobe compid` route b
(agent-h2's existing check, previously `SKIP`ped for exactly this missing address) now runs
-- `tsc exit: 0`, `exit code: 0`, `Quit correctly`, no crash on either build, either run
(`work/host-runs/compid40-20260923-011947.txt`, `compid40-20260923-012252.txt`,
`compid51-20260923-012247.txt`). **What it returns did not match compid-b's expectation**,
though, consistently on both builds and both runs: `getComponentItem(diamond_pickaxe)` is
null, `getComponentItem(apple)` is a live pointer. compid-b assumed the pickaxe carries a
`DiggerItemComponent` too; the more likely reading is that 1.26 still keeps vanilla tools as
native `DiggerItem`/`ToolItem` subclasses rather than `ComponentItem`-derived, while `Food`
genuinely is component-based -- but this was **not independently confirmed** (no second
route on the boolean itself, only on the slot number and the chase), so it is left as an
open question in `data/derived.json`'s entry rather than asserted. `data/derived.json`:
128 -> **129**.

**(3) `sendArmorSlot@Mob` -- attempted as `derived()`, crashed on both builds, reverted.**
The retraction of the wrong candidate (Q3 follow-up (5) above) still stands. Reading
`ServerPlayer::setArmor`'s body directly (40 `0x695620`, 51 `0x758d10`, both 835B,
byte-identical up to this point) right after its call to `Player::setArmor` finds a block
that structurally matches 2024's real `sendArmorSlot` (`0x191a360`) one instruction for
one: range-check `slot<5` (2024: `<4`, the already-confirmed five-slot armor container),
build a one-bit bitmask with a single `shl` (2024 builds a general `std::bitset<32>` since
it does not know the index is compile-time-bounded here), then one virtual call through
`this`'s own vtable, single `uint32_t` argument. The vtable slot is not the same number on
the two builds -- 40 `+0x4f0` (158), 51 `+0x4e8` (157), read directly, the same one-slot
drift this project has on record elsewhere (`_hurt`: 134 -> 133) -- so it was staged as
per-build table data (`data/candidates-instances-<v>.json` `offsets.Mob`
`sendArmorSlotVftableOffset`: 40 1264 / 51 1256) rather than a literal, and `derived()`
built the identical raw-asm-stub dispatch `getComponentItem` above uses, just with an
extra `uint32_t` parameter and a build-read offset instead of a literal one.

**It crashed the server on both builds**, `0xC0000005`, within roughly two seconds of a
player joining -- specifically, on the very first `itemprobe sendarmor <slot>` console
command after several unrelated commands (`tp`, `clear`, `replaceitem`) had already
succeeded, confirmed by reading the full unfiltered `.out` transcript rather than the
`--grep`-filtered one, which had hidden that detail and made the crash initially look like
it was happening at player-join time itself with no command run at all. **No
`[ Fault Capture ]` block appeared in either `.err`** (`peek.ps1
-Pattern "Fault|#[0-9]|bedrock_server.exe\+0x"` against both, and a direct `Select-String`
over the whole file, both came back empty) -- the "no report at all" failure mode
`docs/lab-runbook.md` section 5 documents for a crash under a stub with no unwind
information, reached from JS via `makefunc`, outside bdsx-core's own `__except`. Isolating
ruled out two things: the offset value (fixing it from a stale fallback to the correct
per-build number, confirmed present in `data/symbols-<v>.json`'s `layouts.Mob` after
`merge-symbols.mjs`/`make-table.mjs`, crashed again in exactly the same place) and the
raw-asm-stub technique in general (`getComponentItem`'s `vft[9]` dispatch, built the
identical way, survives cleanly on both builds -- see (2) above). The remaining
difference is either the extra `uint32_t` bitmask argument threaded through
`makefunc.js(asmStub, void_t, {this:Mob}, uint32_t)`, or something specific to the actual
vtable slot/object this reaches at that point that a static read of one caller's body
cannot distinguish from a wrong one. Per this project's own rule ("a counter probe proves
an address, never a prototype, and not always the address" -- read the body, then fire the
hook itself before calling it done), a body match that cannot be executed cleanly does not
ship. **Reverted**: `Mob.prototype.sendArmorSlot` is back to the original
`procHacker.js("?sendArmorSlot@Mob@@...", ...)`, which just throws "Symbol not found" at
call time on both 1.26 builds -- never crashes, matching its state before this session.
The read body, both builds' vtable offsets, and the reasoning above stay in
`data/candidates-instances-<v>.json`'s `offsets.Mob` (`sendArmorSlotVftableNote`,
`sendArmorSlotVftableOffset`) for whoever next debugs the dispatch; `tools/item-probe.ts`'s
`sendarmor` step and `tools/host/drivers/armorslot40/51.ps1` are left in place (they throw
and get caught by the outer `try`/`catch`, reported as a graceful `FAIL`, not a crash --
safe to leave, useful once the dispatch is fixed) along with the `mob_armor_equipment`
logger added to `tools/probe-client.cjs`.

**A note on the diagnostic path, since it cost most of this session's budget.** The first
sign of trouble (`--grep='\[item\]'` showing only "Player connected" then a crash, with no
`[item]` lines at all) was misread as "crashes before any command runs" and, briefly, as
possibly the same unexplained crash class `next-steps.md` Q8 already has on record
(`gameThreadEntry +0x17`, `0x3f800000`) -- reading the *unfiltered* `.out` transcript showed
several console commands had actually already run successfully, and the crash was tied to
the very first command that would have produced `[item]` output. The general lesson: **a
`--grep` filter that shows too little is not evidence of an early crash, only of a crash
before the first matching line** -- the unfiltered transcript is what actually orders events.

## Q3 follow-up: `sendArmorSlot@Mob` root-caused and shipped (2026-09-23, agent-p)

Picking up where the section above left off (reverted, crashed, root cause unresolved). Two
things closed this: an independent third route confirming the vtable slot number, and isolating
the crash to the *calling context*, not the dispatch.

**The vtable offset (40 `+0x4f0`, 51 `+0x4e8`) is now confirmed three ways, not one.** The
section above had only the `ServerPlayer::setArmor` call site. Reading `??_7Mob@@6B@` -- the
*base* class's own vtable, not `ServerPlayer`'s override -- at the same offset on both builds
lands on 40 `0x2406ab0` / 51 `0x29ee4f0`, which is the exact address `merge-symbols.mjs` already
carries via an unrelated propagation route for `?sendArmor@Mob@@UEAAXV?$bitset@$03@std@@@Z`. That
symbol is itself independently confirmed against 2024's PDB: 2024's own `Mob` vtable at `+0x560`
(slot 172 -- the slot 2024's decorated `sendArmorSlot` body calls with a `std::bitset` argument)
is exactly that name. Three routes -- the 1.26 call site, the 1.26 base-class vtable slot, and
2024's PDB name for that same slot -- now agree on both the slot number and the signature (`this`,
one scalar bitmask by value).

**The earlier crash was not the bitmask.** Rebuilding `derived()` with the bitmask computed
correctly (`1 << slot` in JS, matching 2024's body instruction for instruction, rather than
whatever the earlier reverted attempt did) still crashed identically on both builds -- `0xC0000005`
right after the `head`/slot=0 command (`replaceitem ... diamond_helmet` succeeds, the very next
`itemprobe sendarmor head` never logs a single `[item]` line), no `[ Fault Capture ]` block in
either `.err` (confirmed by reading the full, unfiltered 156KB `.err`, not a `--grep` slice).
Reading the callee itself this time (40 `0x68de60`, `ServerPlayer`'s own override at this vtable
offset -- distinct from the base `Mob::sendArmor` above, which 1.26 keeps as a separate, simpler
implementation) rules out the leading suspects: it is a real `.pdata`-backed function with a
standard prologue, it treats `bitmask==0` as a safe no-op early return (so a slot/bitmask
mix-up cannot explain a crash on the very first call, which was slot=0), and everything past that
gate is a `weak_ptr<T>::lock()`-style CAS refcount loop on a member at `this+0x1d0`/`this+0x1c8`
(null-gated at every step) feeding a per-bit loop over up to 5 armor slots that builds an
`InventorySlotPacket` per changed slot and a final `MobArmorEquipmentPacket` -- a full
network-broadcast routine, not a plain setter.

**Isolating the calling context found it.** The same call -- same offset, same bitmask, same
object -- made once from inside `events.levelTick` (`tools/item-probe.ts`'s new `sendarmortick`
case, armed by console command but firing from the tick callback) returns cleanly on both builds:
`work/host-runs/armortick40-20260923-021454.txt` / `armortick51-...`, both
`[item] PASS sendarmortick: sendArmorSlot(0) returned from inside levelTick without crashing`,
`Quit correctly`, exit 0, tsc 0. The console-command call (`sendarmor`) still crashes the same way
(`work/host-runs/armorslot40-20260923-020434.txt` / `armorslot51-...`) -- confirmed once more with
the corrected bitmask, so this is not a cross-thread bug (console commands and level ticks are the
same OS thread here, `docs/findings-gamethread.md`) but a precondition specific to this vtable
override, plausibly the `this+0x1d0`/`this+0x1c8` weak-ref member, that BDS's own tick-driven
callers satisfy and the synchronous console-command dispatch path does not. Not root-caused
further -- the next step, if this ever needs to be console-safe too, is naming that member live
(`instance-probe-launcher.js` member scan on a connected `ServerPlayer`, comparing its value
between a console-command tick and an ordinary tick).

**Shipped**: `Mob.prototype.sendArmorSlot` is `derived()` on both builds (`bdsx/bds/implements.ts`),
address- and prototype-confirmed, executed clean from `events.levelTick` on both 1.26.40.8 and
1.26.51.1. The console-command landmine is documented in `tools/item-probe.ts`'s `sendarmor` case
(left in place on purpose -- the crash itself is data) and does not affect ordinary plugin code,
which calls into bdsx APIs from event handlers already running in tick-driven context, the same
context `sendarmortick` proved safe. `data/derived.json`: 129 -> **130**.

> **Superseded 2026-09-27:** there is no console-context precondition. The console step crashed in `getArmor`,
> whose shipped address was `ActorEquipment::getArmorContainer` ("sendArmor: the crash was getArmor", below).

## `Attribute::getByName` (2026-09-24, both builds, executed)

bdsx calls `?getByName@Attribute@@SAAEAV1@AEBVHashedString@@@Z` only from `example_and_test/test.ts`, so it had
waited for a firing route; the route turned out to be bdsx's own test, run as a console probe.

- **Route 1, string.** `"Cannot find attribute %s"` is referenced once in the image: from 40 `0x235d840` / 51
  `0x1eb5eb0` (369 B each), the AttributeCollection hash lookup. Each has one caller: 40 `0x235d760` / 51
  `0x1eb5dd0` (162 B).
- **Route 2, body.** The 162-byte function guards the static `AttributeCollection` instance (the
  thread-safe-static pattern: TLS epoch compare, `_Init_thread_header`, an atexit destructor) and passes it with the
  `HashedString` to the lookup. The lookup walks the bucket comparing the hash, then the string. On a miss it logs the
  message and falls back to the list head's first node. It returns `node+0x40`. 2024's body (`0x1a5b5a0`) is the same
  sequence: instance → find → log → `node+0x40`.
- **Execution** (`gbn40`/`gbn51`, `tools/block-probe.ts` `gbnprobe`):
  - Every `AttributeName` (except the deleted zombie one and `JumpStrength`, which a player lacks) returns an
    `Attribute` whose id (+4, Endstone `attribute.h`) equals `BaseAttributeMap::nativeIdOf` for that name.
  - Its name (+8, a `HashedString`) reads back.
  - `minecraft:health` returns the very pointer the player's health `AttributeInstance` holds at +8.
  - On 51 this also confirms, keyed by name this time, the renumbering `layouts.AttributeId` carries (the five
    player attributes one lower).
  - The lookup never returns null for an unknown name (it returns the first node), so the probe does not test one.

## `isHumanoidWearableBlockItem`: 51 through `derived()`, both builds executed (2026-09-24)

This closes the Q3 follow-up (3) above. 1.26.40.8 kept this half of the wearable test out of line (`0x1bc3ad0`).
1.26.51.1 inlined it into `isHumanoidWearableItem` (`0x1a59d80`). Both bodies run the same test:

- `item_` → `Item+0x178` → the `BlockType`. On 40 that step is one dereference deeper: Endstone 0.11.7's
  `item.h` has `WeakPtr<BlockType> block_type_` there, HEAD has `const BlockType *`.
- The name hash at `BlockType+0xe0` is looked up in a seven-element static vector (40 `0xc970bc0`, 51 `0xccda7d0`),
  then compared with one more global (40 `0xc973378`, 51 `0xccdc670`).

**What the globals are.** Each vector is filled from an initializer list in `.rdata` (40 `0xa6a5c58`, 51 `0xa7a6ac8`)
of seven `HashedString*`. Each global is built in the big static initializer (40 `0x29ae4b0`, 51 `0x25f41e0`) as
`movabs hash → [g]; lea r9, literal; mov edx, length`. That names them, the same on both builds:
`skeleton_skull`, `wither_skeleton_skull`, `zombie_head`, `player_head`, `creeper_head`, `dragon_head`,
`piglin_head`, and `carved_pumpkin` for the single global. 2024 compared against two constants (skull, carved pumpkin);
1.26 split the skull into seven head blocks.

**Shipped.**
- `bdsx/bds/engine/item.ts` runs that membership test by name, with `layouts.Item.blockType`/`blockTypeWeak`
  (40: 1, 51: 0).
- `ItemStackBase.isHumanoidWearableBlockItem` is a `derived()`, so 40 keeps the binary.

**Execution** (`wb40`/`wb51`, `tools/block-probe.ts` `wbprobe`, items placed with `replaceitem`):
- The seven heads and `carved_pumpkin` return true. `pumpkin`, `stone`, `apple`, `diamond_helmet` and an empty slot
  return false.
- On 40 the binary gives the same 13 answers.
- On 51 the native `isHumanoidWearableItem` agrees on every non-armor item (the helmet is true there, as armor).

## `getComponentItem`: the boolean is the binary's (2026-09-24, both builds)

The open question from "Q3 Next steps (2)(3)" was whether "pickaxe null, apple non-null" is right. It is, and compid-b's
expectation was wrong.

**Live read** (`tools/block-probe.ts` `cbprobe`, `cb40`/`cb51`): the probe prints each hotbar item's vftable and slot 9
(`isComponentBased`) as RVAs.
- The pickaxe's vftable is `??_7PickaxeItem@@6B@` on both builds (40 `0xa653a40`, 51 `0xa76b6e0`). 1.26 still has a
  native `PickaxeItem`.
- Its slot 9 is the shared `xor eax,eax; ret` (40 `0x76150`, 51 `0x76010`), and stone's is the same.
- The apple's `Item` (vftable 40 `0xa6dae40`, 51 `0xa78b6f0`) has `mov al,1; ret` at slot 9 (40 `0xa2650`, 51 `0xa2880`).

**compid-b** (`tools/item-probe.ts`) now expects exactly that: null for the pickaxe, and for the apple the very `Item`
its `item_` points at. `compid40`/`compid51` PASS. bdsx's `ComponentItem` has no `getComponent` method any more, so
the old digger/food half is only printed as INFO.

## sendArmor: the crash was getArmor (Q8, 2026-09-27, both builds executed)

**What Q8 had on record.** `itemprobe sendarmor` crashed both builds with `0xC0000005` and no `[ Fault Capture ]`,
while `itemprobe sendarmortick` (the same `sendArmorSlot` from `events.levelTick`) passed. The section above read that
as a console-context precondition of `ServerPlayer::sendArmor` and shipped `sendArmorSlot` with a "console landmine".

**The difference between the two steps was not the context.** `sendarmor` called `p.getArmor(slot)` first and
`sendarmortick` never did. `?getArmor@Actor@@` came from the propagation route with 40 `0x1acb8e0` / 51 `0x1cd2170`, which
is the address the table also carries for `?getArmorContainer@ActorEquipment@@YAAEBVSimpleContainer@@AEBVEntityContext@@@Z`.
- The body (`disas-exact`, both builds, byte-for-byte the same shape) is an EnTT get of `ActorEquipmentComponent`
  (hash `0xb06141a9`): registry at `rcx+8`, entity id at `rcx+0x10`, pool walk, return the armor container, else call the
  fail path (40 `0xbb1d0`, 51 `0xbc590`). It takes an `EntityContext&`, not `(Actor*, ArmorSlot)`.
- 2024's `Actor::getArmor` (`0x19b0680`) is the whole wrapper: `addq $8,%rcx; call getArmorContainer; jmp [vft+0x38]`
  with the slot. 1.26 inlines it: `ServerPlayer::sendArmor` (40 `0x68de60`, 51 `0x7514f0`) does
  `leaq 0x8(%rsi),%rcx; call <getArmorContainer>`, then `vft+0x38` with the slot.
- Called as `getArmor(this=Actor, slot)`, it reads `Actor+8` as the registry and walks garbage.

**Fault capture.** bdsx prints no report for a crash raised from a `makefunc` call (`findings-gamethread.md`, "Why the
report is empty", case 1), so the capture came from procdump. `itemprobe getarmorold` replays the old binding on purpose:
the getArmorContainer address with `{ this: Actor }, int32_t`. Drivers `armorq8r40/51` (no dump), `armorq8d40/51`
(procdump `-e`), `armorq8f40/51` (procdump `-e 1 -f C0000005`, the first first-chance AV), with the new
`tools/host/pd-watch.ps1`. All six died with `-1073741819` right after
`[item] INFO getarmorold: calling getArmorContainer's address as getArmor(...)`. The unhandled-exception dumps (`-e`) are
a stack overflow inside exception dispatch (40 `ntdll+0xfbc4`, 51 `ChakraCore+0x2bb4db`, `write of rsp-8`): the original
fault is not in them. The first-chance dumps name it (`tools/minidump.mjs` with the merged table;
`work/host-runs/q8/armor/armorq8f-minidump.txt`):

```
1.26.40.8  exception 0xc0000005 read of 0x80593 at bedrock_server.exe+0x1acb910
             nearest: +0x30 0x1acb8e0 ?getArmorContainer@ActorEquipment@@...   r9=0x80593
1.26.51.1  exception 0xc0000005 read of 0xffffffffffffffff at bedrock_server.exe+0x1cd21a0
             nearest: +0x30 0x1cd2170 ?getArmorContainer@ActorEquipment@@...   r9=0x6974697678287aa5
stack (both): ChakraCore frames only -- the call came straight from JS
```

Both RIPs are the same instruction, `movq (%r9),%r8` in the pool-index loop, with `r9` computed from `Actor+8`'s garbage
(on 51, `rcx` holds the ASCII bytes `"ream.wri"`).

**Fix.** `?getArmor@Actor@@` is retracted on both builds (`data/candidates-instances-<v>.json`) and `Actor.getArmor` is a
`derived()`: `getArmorContainer().getItem(slot)`, 2024's body (bdsx `12ade65e`). `sendArmorSlot` itself is unchanged:
its dispatch was right all along.

**Execution** (`armorq8c40/51`, `verify-pair`, 18:35, tsc 0 on both, exit 0 + `Quit correctly`, 9 PASS / 0 FAIL each).
The driver runs `clear`, then `replaceitem` for head, chest, legs, feet, each followed by `itemprobe sendarmor <slot>`.
It ends with `sendarmortick head`, `gamemode survival @a`, `clear @a`.
- `sendarmor-get`: `getArmor(0..3)` is the same pointer as `getArmorContainer().getItem(i)`. It is worn exactly for
  `0..s` and empty after `s`, so both sides of getArmor are seen.
- `sendarmor`: `sendArmorSlot(s)` from the **console** returns. bdsx's `packetSend` sees exactly one
  `InventorySlotPacket` (`container=120 slot=s`) during the call.
- The bot receives it: in `.bot.log`, an armor `inventory_slot` comes 8 s after each `replaceitem`'s own packet, the one
  `sendarmor` sent (`work/host-runs/q8/armor/armorq8c*.bot.log`, logger added to `tools/probe-client.cjs`).
  `MobArmorEquipmentPacket` goes to the dimension's other players, so a lone bot never gets it.
- Reruns on the final tree, one session at a time: 40 at 18:49 and 51 at 19:06, tsc 0, 9 / 0, exit 0 + `Quit correctly`.
  51's rerun at 18:52 was `SESSION FAILED` (the ssh connection dropped after `Quit correctly`), so it is not counted.
  Two paired reruns (18:45, 18:47) skipped tsc: both sessions uploaded `deploy-bdsx.ps1` at once ("cannot access the
  file ... being used by another process"). They ran the 18:35 build, and their only difference from the final tree is
  comments.

**Rule.** When two names share an address in the merged table, check that their argument lists agree before trusting
either one. The table has hundreds of shared addresses (identical-code folding), and this one was a free function over
an `EntityContext&` sharing its address with a member function over `(Actor*, slot)`.

## Shared addresses: the getArmor audit, and jsv's first-match slot (2026-09-27, agent-j)

**The tool.** `node tools/shared-addr-audit.mjs <v>` groups `data/merged-<v>.json` by address and lists every required
name whose address it shares with a name of a different ABI shape: free/static vs instance member (`YA`/`SA` vs
`QEAA`/`UEAA`), a different parameter count, or a hidden sret on one side only (decorations through `llvm-undname`).
It prints each name's route and flags routes that never read a body. Replayed on the tables of `94d1142` (before the
getArmor fix) it lists `?getArmor@Actor@@` against `getArmorContainer` ("kind member vs free"), so it would have
caught that one. `--unread` lists every required name in the table whose route never read the body, and `--jsv`
checks bdsx's virtual-slot lookups (below).

**The list** (current tables). 40: 338 shared addresses, 22 of them hold a required name, and 5 required names share
with a different shape. 51: 370 shared, 21 hold a required name, 7 differ. That is 8 distinct names. Each body was read
with `disas-exact` on both builds and compared with 2024's. A body that reads only registers its own prototype defines
is safe under its name, whatever else shares it.

| name | 40 / 51 | shared with | body (both builds) | verdict |
|---|---|---|---|---|
| `?getBlockPosition@ServerCommandOrigin@@` | `0xa10c60` / `0x906d00` | `Actor::getInterpolatedRidingOffset(float,int)` (sret Vec3) | `mov rax,rdx; movl $0,8(rdx); movq $0,(rdx); ret`: twelve zero bytes into the sret | right: 2024 `0x7e7570` copied `BlockPos::ZERO`, the same result. The partner also takes this, sret, so it folds legitimately |
| `?getWorldPosition@ServerCommandOrigin@@` | same | same | same | right as an address (2024 `0x7e9890` copied `Vec3::ZERO`). **Wrong as a jsv slot**, see below |
| `?getSpawnPos@Dimension@@` | same | same | same | right: 2024's base `Dimension::getSpawnPos` was already folded with `ServerCommandOrigin::getBlockPosition` (`0x7e7570`). bdsx calls it through `??_7OverworldDimension@@6BIDimension@@@`, where the address is in one slot only |
| `?getLastDeathPos@Actor@@` | `0xe21cf0` / `0xd61f60` | `NullSoundPlayer::tryGetLoopingSoundAttributes(uint64)` (sret optional) | `mov rax,rdx; movb $0,0xc(rdx); ret`: an empty `optional<BlockPos>` | right: 2024 `0xbd4af0` is the same three instructions. jsv on `??_7Actor@@6B@` finds exactly one slot |
| `?getChunkSource@BlockSource@@` (40 only) | `0x14f3b50` / (51 `0x15f3b10`, unshared) | two `websocketpp ... hybi13::prepare_pong(...)` (vftable-walk) | `mov rax,[rcx+0x28]; ret` on both builds | right: 2024 `0x8d5f70` is the same two instructions. The partners are **misnamed**: that body cannot return an `error_code` through a hidden pointer |
| `?collectOptionalArguments@Command@@` (51 only) | (40 `0xa2650`, unshared) / `0xa2880` | 1,454 names: the image's `return true` | `mov al,1; ret` on both builds | right: 2024 `0xcbd10` is the same. bdsx compares it with a vftable slot and installs it in its own |
| `?isHumanoidArmor@HumanoidArmorItem@@` (51 only; not in 40's table) | `0xa2880` | same | same | right as an address, and as a jsv slot: the first match is slot 10, Endstone HEAD `item.h`'s `isHumanoidArmor` |
| `?setCustomName@Container@@` (51 only) | (40 `0x2dde50`, unshared) / `0x3722c0` | `DcSctpTransport::ReadyToSendData`, `ShapedRecipe::assumeSymmetry`, `PropertiesSettings::enableItemStackNetManager` (carry / vftable-walk) | `movb $1,0x170(rcx); add rcx,0x128; jmp <string assign>` on both builds | right: the resolved container-slot anchor (`findings-containers.md`). 2024 `0x185a3f0` is the same shape at +0x158/+0x138. The three partners are **misnamed** |

No required name was retracted or rebound for sharing an address. The five misnamed partners (`prepare_pong` x2 on
40; `ReadyToSendData`, `assumeSymmetry`, `enableItemStackNetManager` on 51) are not required by bdsx and were left in
the table. They are recorded here in case something ever asks for them.

**Hook targets.** None of the 58 required hook/patch names in either table shares its address with another name. A hook
on a folded body would fire for every function folded into it.

### The case the list could not see: `procHacker.jsv` takes the first matching slot

`jsv(vftable, name)` resolves its slot in `bds/symbols.ts` `getVftableOffset`: it scans up to 4096 bytes of the table
and takes the **first** slot whose pointer equals the name's address. With identical-code folding, one address can
fill several slots of the same table, and then the first one wins whether or not it is that name's slot. The table's
names do not show this, because the other slot's function often has no name in the table.
`node tools/shared-addr-audit.mjs <v> --jsv` replays that search for all 84 `jsv` sites in `bdsx/` (18-19 per build have
a side missing from the table) and prints every site whose address is in more than one slot, next to 2024's answer:

| site | slots holding the address (40 / 51) | 1.26 slot of the name | verdict |
|---|---|---|---|
| `CommandOrigin.getBlockPosition` | 3,4 (+107,108 past the table) / 3,4 | 3 (Endstone `command_origin.h`) | right: the first match is its own slot |
| **`CommandOrigin.getWorldPosition`** | same | **4** | **wrong on both builds**: the first match is 3, `getBlockPosition`. A player origin returned its BlockPos's ints read as floats. New in 1.26: 2024's two bodies copied different constants, so they did not fold. **Fixed** |
| `CommandOrigin.getLevel` | 6,74 / 6 | 6 | right |
| `CommandOrigin.getEntity` | 8,21,... / 8,22 | 8 | right: `xor eax,eax; ret`, first match 8 |
| `ActorDamageSource.getDamagingEntityUniqueID` | 12,17 / 12,17 | 17 | the first match is 12, BDS's `getEntityUniqueID`. 2024 bdsx did the same (slots 13,18, first 13). Left unchanged, see below |
| `Item.isArmor` (`HumanoidArmorItem::isHumanoidArmor`, 51) | 10,48,67,... | 10 (Endstone HEAD `item.h`) | right |
| `TickingArea.getView` | 10,11 / 10,11 | 10 and 11 are the const and non-const overloads, one body | right: either slot is the same function (2024: 10,11) |
| `ChunkSource.isWithinWorldLimit` | none / none | - | the table's `?isWithinWorldLimit@WorldLimitChunkSource@@` (40 `0x1773ac0` vftable-walk, 51 `0x1866ef0` carry) is not in its own class's vftable (40 `0xa789a90`, 51 `0xa8a4ed0`, whose slots sit in `0x15a8xxx` / `0x9e6xxx`). jsv reports it missing, so nothing is called. One of the two names is wrong. Queued |

**`getDamagingEntityUniqueID`.** In the base class, slots 12 (`getEntityUniqueID`) and 17 (`getDamagingEntityUniqueID`) are
the same `return INVALID` body (40 `0xe0ebd0`: `movq $-1,(rdx)`). In `ActorDamageByActorSource` (40 `0xa55d690`) they are
again one function (`0xe5b130`: `mov rcx,[rcx+0x40]`). They differ only in `ActorDamageByChildActorSource` (40
`0xa5ee430`, 51 `0xa710040`, found by scanning `.rdata` for tables that share the base's slots 4-9): slot 12 reads
`+0x40` and slot 17 reads `+0x78`. 2024's child table did the same with `+0x20` and `+0x58`, and upstream bdsx's slot 13 was
the `+0x20` one. So bdsx's `getDamagingEntity()` has always returned BDS's `getEntityUniqueID` (the id at `+0x40`, 2024
`+0x20`), and `ActorDamageByChildActorSource.getChildEntityUniqueId()` returned the other id, at 2024's `+0x58`, which
is BDS's `getDamagingEntityUniqueID`. Which of the two is the shooter and which the projectile was not checked by
execution: Endstone's `damage_source.h` calls `getDamagingEntityUniqueID` the direct one (the projectile). Upstream behaviour is kept,
so nothing changes here. **But `getChildEntityUniqueId()` reads `+0x58` on 1.26, where the child id is now `+0x78`
on both builds.** Queued, with no execution yet: neither child-source vftable nor constructor is in the table.

**Fix.** `CommandOrigin.getWorldPosition` now calls slot `layouts.CommandOrigin.getWorldPositionSlot` (4, both builds) through
the origin's own vftable (`bdsx/bdsx/bds/engine/commandorigin.ts`, bdsx `1ec60102`). `engine-deps --missing` is empty.

**Execution** (2026-09-27, `verify-pair`, drivers `wpos40`/`wpos51`, `tools/softenum-probe.ts` `seprobe origin`/`originran`):
tsc 0 on both, exit 0 + `Quit correctly`, **11 PASS / 0 FAIL on each build**
(`work/host-runs/wpos40-20260927-200805.txt`, `wpos51-...`). The probe registers `seprobeorigin` (permission Normal:
under `execute as`, the command runs with the bot's permissions). Its callback reads `getWorldPosition` (bdsx's new
binding), `getBlockPosition`, and the old binding, rebuilt with `procHacker.jsv`.
- Console (`ServerCommandOrigin`, origin type 7): both (0, 0, 0).
- `execute as @a at @s run seprobeorigin` after `tp @a 29.5 68 14.5` (origin type 9): `getWorldPosition` (29.5, 68, 14.5),
  which is the bot's `getPosition` (29.5, 69.62, 14.5) with y at the feet. `getBlockPosition` is (29, 68, 14). The old
  binding returned (4.06e-44, 9.53e-44, 1.96e-44), which is 29, 68, 14 as float bits. Again at (12.25, 70, -7.75):
  (12.25, 70, -7.75), (12, 70, -8), and a NaN from the old binding (-8's bits).
- BDS logs "Failed to execute 'seprobeorigin' as bdsxprobe" because the callback writes no output (success count 0).
  That is expected.
- Two earlier runs did not test the fix. In the first, the command was registered at Operator level, so `execute as`
  refused it. In the second, the probe called `getFeetPos`, which needs `CommandUtils::getFeetPos`, and the table
  does not have it.
- Regression, same tree: `cmdo40/51` 38 / 0 each, `layout40/51` 27 / 0 each, tsc 0, exit 0 + `Quit correctly`.

**Rule.** When two virtual functions fold into one body, `jsv`'s address-to-slot search returns the first slot, and that
may belong to the other function. For a virtual that returns a constant or a default, call it by slot (an
`engineLayout(..., "<name>Slot", ...)` counted from Endstone's header) rather than by address. `shared-addr-audit.mjs
--jsv` has to be rerun whenever a table or a `jsv` site changes.

## Audit follow-ups: the damage sources, `WorldLimitChunkSource`, and the propagation reading list (2026-09-27, agent-m)

The three follow-ups the "Shared addresses" section queued. Executed on both builds with `verify-pair` (drivers
`child40`/`child51`, `tools/entity-sig-probe.ts` `SIG_EVENTS=child`, bdsx `178bc810`).

### (a) The damage sources: the resolver can tell the classes apart, and the child id is at `+0x78`

None of the three subclass tables was in either symbol table. bdsx's `ActorDamageSource` resolver (`bds/implements.ts`)
compared every source's vptr against null and returned the base class, so `isEntitySource()`, `isChildEntitySource()`
and `isBlockSource()` were false for every hit. Found statically on both builds, by scanning `.text` for RIP-relative
`lea`s of the tables the previous section had found in `.rdata` (four tables share the base's slots 4-9; slots 1/2/3
are `isEntitySource`/`isChildEntitySource`/`isBlockSource`, the image's `return true` where they apply):

| name | 1.26.40.8 | 1.26.51.1 | body |
|---|---|---|---|
| `??_7ActorDamageByActorSource@@6B@` | `0xa55d690` | `0xa67cce0` | stored by the table's `??0ActorDamageByActorSource` (propagation; read: base constructor, then `lea <table>; mov %rax,(%rdi)`) and by its destructor |
| `??_7ActorDamageByChildActorSource@@6B@` | `0xa5ee430` | `0xa710040` | stored by the child constructor and destructor below |
| `??_7ActorDamageByBlockSource@@6B@` | `0xa60d5c0` | `0xa72c530` | built inline: base constructor, the vptr, the `Block*` at `+0x30` |
| `??0ActorDamageByChildActorSource@@QEAA@AEBVActor@@0W4ActorDamageCause@@@Z` | `0xe5b3b0` | `0xd90c80` | rcx this, rdx child, r8 damaging, r9d cause: `ActorDamageByActorSource(this, r8, r9d)`, then the child vptr, then the **first** actor's `getOrCreateUniqueID()` at `+0x78` |
| `??1ActorDamageByChildActorSource@@UEAA@XZ` | `0x6de9d0` | `0x7991d0` | frees the string at `+0x88`, tail-jumps to the by-actor destructor |
| `??1ActorDamageByActorSource@@UEAA@XZ` | `0x22a780` | `0x2b95e0` | frees the string at `+0x50` |

Sizes come from the scalar deleting destructors (slot 0): by-actor **0x70**, child **0xa8** (both builds), block
**0x38** (40) / **0x48** (51). bdsx declared 2024's 0x50 and 0x80. `ActorDamageByActorSource.constructWith` already
called the shipped constructor on a 0x50-byte buffer, and the constructor wrote up to `+0x70`. All three sizes, the
child id (`childId` `0x78`, 2024 `0x58`) and the block field (`block` `0x30`) now come from `engineLayout` over
`layouts.ActorDamageBy*`.

The constructor settles the question the previous section left open. The id at `+0x40` (BDS's `getEntityUniqueID`,
slot 12, which `getDamagingEntity()` has always reached through `jsv`'s first match) is the constructor's **second**
actor, the shooter. `+0x78` (slot 17, BDS's `getDamagingEntityUniqueID`) is the **first**, the projectile.

**Executed** (`child40`/`child51`, tsc 0, exit 0 + `Quit correctly`, **14 PASS / 0 FAIL on each build**;
`work/host-runs/child40-20260927-222405.txt`, `child51-...`). Two skeletons and an iron golem are set on the
`BP_LIVE=1` bot, with resistance and regeneration so that it survives, and then it stands on magma:
- Arrow hits (on the bot, the golem, and on 51 another skeleton): the source's vptr is the child table's. On each
  build `getDamagingEntity()` is the skeleton, `getChildEntityUniqueId()` names an arrow, and that arrow's `getOwner()`
  is the same skeleton, id for id (e.g. 40: skeleton `0xfffffebd00000014`, arrows `...16`, `...17`, `...1a`).
- Melee (iron golem on 40, zombies on 51): the by-actor vptr, and `getDamagingEntity()` is the attacker.
- Magma: the block vptr, and `block` reads `minecraft:magma`.
- `ActorDamageByChildActorSource.constructWith(arrow, skeleton)` and `ActorDamageByActorSource.constructWith(attacker)`:
  the table's vptr, and both ids read back; then `destruct()`.

Regression on the same tree: `layout40/51` 27/0 each, and `sig40/51` clean (hurt, knockback and dimension events fire,
exit 0 + `Quit correctly`). The first `child` pair ran with a probe type error (tsc 2) and was not counted, although it
printed the same results.

### (b) `isWithinWorldLimit`: the function was right, the table's name was wrong

`?isWithinWorldLimit@WorldLimitChunkSource@@` (40 `0x1773ac0`, 51 `0x1866ef0`) matches 2024's slot 23 instruction for
instruction: `cmpl $0,0x94(%rcx)`, then the x and z bounds at `+0x70`/`+0x7c` and `+0x78`/`+0x84`, with
`+0x74`/`+0x80` checked against 0. A pointer scan of `.rdata` finds each address in exactly one table. There it sits at
slot 29, with `getChunkMap` (the `+0x30` forwarder) at slot 30: 40 **`0xa6380a0`**, 51 **`0xa75ab70`**. That table
overrides slots 0, 3, 7, 29 and 30, the same shape as 2024's (0, 3, 7, 23, 24). The vftable walk (40) and the carry
(51) had given the name `??_7WorldLimitChunkSource@@6B@` to 40 `0xa789a90` / 51 `0xa8a4ed0`. That table overrides
slots 5 and 8 as well and keeps the base `return true` at slot 29, so it is a sibling ChunkSource subclass. `resolved`
now ships the right table, and nothing was retracted. `shared-addr-audit --jsv` no longer reports the site as NOT
FOUND on either build.

Run (`sigprobe audit`, same sessions): `ChunkSource.isWithinWorldLimit` resolves its slot and returns true for the
overworld. The overworld's chunk source (40 vft `0xa6f6fe0`, 51 `0xa80d090`) is another class, so the call reaches
the base `return true`. That is one side only: the `WorldLimitChunkSource` body has not run, because no world here has
a limit. The decision rests on the static reading.

### (c) The propagation reading list: 36 names, 9 wrong

`node tools/shared-addr-audit.mjs <v> --unread` lists 30 required names per build whose only route is call-edge
propagation. Taken over both builds, that is 36 names, because a name propagated on one build is often cross-build or
carried on the other. Every body was read with `disas-exact` on both 1.26 builds and compared with 2024's.

| name | 40 / 51 | 1.26 body | verdict |
|---|---|---|---|
| `??0ActorDamageByActorSource@@` | `0xe15020` / `0xd55310` | base constructor, the by-actor vptr, rdx actor, r8d cause | right (executed above) |
| `??0Value@Json@@` (string) | `0x9fd9a70` / `0xa0fa030` | type byte 4, allocates the CZString | right |
| `??0Value@Json@@` (ValueType) | `0x9fd9830` / `0xa0f9df0` | 2024's jump table over the type | right |
| `??1Value@Json@@` | `0x9fd9d60` / `0xa0fa320` | 2024's switch on the type byte | right |
| **`??1NetworkItemStackDescriptor@@`** | `0x263d6c0` / `0x2af5aa0` | stores `??_7InventorySlotPacket@@6B@`: the packet's **constructor** | **wrong, retracted** |
| `?canAddPassenger@RideableComponent@@` | `0x1b00220` / `0x241fcc0` | the `VehicleStateProvider` on the stack and the passenger lookup, with 2024's rdx/r8 | right |
| `?createInstance@CommandItem@@` | `0x12df4a0` / `0x1201a80` | rdx sret optional, r8d count, r9d data, a 5th arg: 2024's registers | right (shape; never executed) |
| `?fromTag@ItemStack@@` | `0x1bbef90` / (51 cross-build) | builds an ItemStack, loads it, applies the item's fixup | right; executed (`findings-nbt.md`) |
| `?generateMessage@CommandMessage@@` | (40 resolved) / `0x11ff9f0` | rdx sret, r8 origin, `cmpl $3,%r9d`, as 2024 | right (shape) |
| `?getAbilities@Player@@` | `0x2036e0` / `0x290f60` | read and executed before (`findings-abilities.md`) | right |
| `?getDimensionId@Actor@@` | `0xdca160` / `0xd10bf0` | EnTT `DimensionTypeComponent` (`0xaf993816`), an int into the sret | right |
| `?getEnchantLevel@EnchantUtils@@` | `0x1c75410` / `0x1b63ee0` | the user tag's `"ench"` list (type 9), indexed by the enchant type (`<= 0x29`) | right |
| `?getHandContainer@ActorEquipment@@` | `0x1acb800` / `0x1cd2090` | read and executed before (`findings-armor.md`, `findings-containers.md`) | right |
| **`?getMemberNames@Value@Json@@`** | `0x9b8990` / `0x75b20` | a container move / a hash rehash | **wrong** (retracted by agent-k the same day, `findings-scoreboard.md` 11) |
| `?getObjective@Scoreboard@@` | (40 cross-build) / `0x2666c30` | executed (`findings-scoreboard.md`) | right |
| `?getOrCreateUniqueID@Actor@@` | `0xde6760` / `0xd26790` | EnTT `ActorUniqueIDComponent` (`0x18f957af`); the child constructor calls it | right |
| **`?getOwner@Actor@@`** | `0xde9c30` / `0xd29ba0` | 2024's **`getOwnerId`**: SynchedActorData item 5 (int64) into the rdx return slot, `ProjectileComponent+8` fallback, returns rdx | **wrong; shipped as `getOwnerId`, `getOwner` is `derived()` over it** |
| `?getViewVector@Actor@@` | `0xdebe10` / `0xd2bdb0` | EnTT `ActorRotationComponent` (`0x75df36b7`), float in xmm2, Vec3 sret | right |
| `?hasFamily@Actor@@` | `0xde4b80` / `0xd25920` | the definition list at `+0x98` (2024 `+0xf8`), `FamilyTypeDefinition`'s type id through FNV-1a 64 | right |
| `?hasType@Actor@@` | `0xde56e0` / (51 resolved) | `ActorTypeComponent`, `testb %dl` then mask or equality, as 2024; runs in every hook's `Actor` conversion | right |
| `?isFullFlowingLiquid@BlockUtils@@` | `0x2c58910` / `0x2ed62e0` | the block's LiquidDepth, `depth == 0 \|\| depth >= 8` | right |
| **`?isHiddenFrom@Player@@`** | `0x2a02680` / (none) | compares edx with five mob **type ids** (2024 called `getEntityTypeId(mob)` first), then reads the head armor: it takes an `ActorType`, not a `Mob&` | **wrong prototype, retracted (40)** |
| `?isHumanoidWearableItem@ItemStackBase@@` | (none) / `0x1a59d80` | item vftable slot 10 (`isHumanoidArmor`), then the inlined block-item check at `+0x178` | right |
| `?isInContactWithWater@Actor@@` | `0xdea2a0` / `0xd2a130` | read before: folded with `isInWaterOrRain` (`findings-weather.md`) | right (as folded) |
| **`?isMember@Value@Json@@`** | (40 `0x9fdb560` right) / `0xa0fb6f0` | 51: checks for an array and allocates | **wrong on 51** (retracted by agent-k; 51's real one is `0xa0fbb20`, the 40 bytes with the rel32s masked) |
| `?isSpectator@Actor@@` | `0xdcd990` / `0xd140d0` | `ActorGameTypeComponent`: game type 6, or 5 (default) with the level's default 6 | right |
| `?isType@Actor@@` | `0xde58a0` / `0xd25750` | `ActorTypeComponent`, `cmpl (...),%edx; sete` | right |
| **`?isValidAuxValue@ItemStackBase@@`** | `0x1bba0d0` / (51 cross-build `0x1a54cf0`) | never reads edx: default 0xff, `getDescriptor`, Item vftable `+0x320`, the descriptor's destructor. It is **`getMaxStackSize`** out of line, the body bdsx's `derived()` rebuilds | **wrong, retracted (both)** |
| `?load@BlockActor@@` | `0x460eef0` / (51 carry) | slot 1 of `??_7BlockActor@@6B@`, executed (`findings-nbt.md` 10-11) | right |
| `?load@StructureTemplateData@@` | `0x3bc5400` / `0x1f620e0` | four `_parse*` calls chained on a zero result, as 2024 | right (executed with the structure NBT) |
| **`?lookupByName@BlockTypeRegistry@@`** | (40 cross-build `0x3ebf690`) / `0x55e6a0` | rcx read as an input string, split into 0x30-byte pieces, the pieces' results ORed into an int | **wrong** (retracted by agent-k the same day) |
| **`?resetPlayerLevel@Player@@`** | `0xdf4e30` / (none) | EnTT get of `0xce6b34f6`, then `movss %xmm1,(...)`: a float setter | **wrong, retracted (40)** |
| `?sameItem@ItemStackBase@@` | `0x1bbe970` / `0x1a512a0` | item pointers, then the two ComparisonOptions bytes gating aux and user data | right |
| `?sameItemAndAux@ItemStackBase@@` | (40 cross-build) / `0x27d8f0` | executed (`findings-nbt.md` 18) | right |
| **`?setVariant@Actor@@`** | `0x2493810` / `0x1ba8200` | reads rdx as an Actor (`+0x98`), copies a HashedString into rcx+8, calls through r8 | **wrong; `derived()` over `SynchedActorData::set<int>(2)`** |
| `?stop@DedicatedServer@@` | (40 resolved) / `0x7a410` | the `"DedicatedServer::stop"` / `"Server stop requested."` log, `xchgb` at `+0x48`: 40's confirmed body | right |

**27 right, 9 wrong** (seven of the nine wrong on both builds). Two of the wrong names now have a working bdsx
implementation, executed on both builds in the same sessions:
- **`getOwner`**: the arrows' owners are the skeletons, and the player's owner is null.
- **`setVariant`**: `getVariant` 0 → `setVariant(3)` → 3 → `setVariant(0)` → 0, read back through BDS's own
  `getVariant`.

Three were retracted by agent-k's Json and command work. The other four are only retracted: a call now fails as "no
address" instead of running the wrong function (the regression pairs above ran with them retracted). What the wrong
bindings did:
- `getOwner` wrote 8 bytes through an uninitialised rdx and read the id back as a `Mob*`.
- `setVariant(v)` dereferenced `v + 0x98`.
- `resetExperienceLevels()` wrote xmm1 into a component.
- Destructing a `NetworkItemStackDescriptor` re-initialised it as an `InventorySlotPacket` header.
- `isHiddenFrom(mob)` compared a pointer with type ids.
- `isValidAuxValue(aux)` returned `getMaxStackSize() != 0`.

**Rule.** A propagation-only name is a lead, not an address. 9 of the 36 were wrong, and 7 of those were wrong on both
builds, so two builds agreeing only shows that the call edge carried over. The quickest check is the registers. Does
the body read the arguments the decorated name says it takes (an `int` in edx, a `Mob&` in rdx)? Does it write the
return slot the name implies (rdx for an sret)?

**Read next**, in "The next audit batch" below: 40's 40 `vftable-walk` names, 51's 31 `carry` and 8 `vftable-walk`
names, and the few `cross-build` ones.

## The next audit batch: the vftable-walk and carry names (2026-09-27, agent-p)

The input the previous section left: `node tools/shared-addr-audit.mjs <v> --unread` less its propagation rows (read
there): 40's 40 `vftable-walk` names, 51's 31 `carry` and 8 `vftable-walk` names, and `cross-build` 2 / 1 (`getObjective`,
`sameItemAndAux`, `fromTag`, read and right in (c)). That is **42 distinct function names**. `--unread` skips `??_7`
names, so the tables were added: every required vftable whose route never read a body, 6 on 40 (`vftable-walk`) and 16
on 51 (`carry`), **22 tables**. Each body was read with `disas-exact` on both builds next to 2024's. A virtual was also
placed by counting its class's declarations in Endstone's header (0.11.7 for 40, HEAD for 51; commented-out
declarations not counted) and by its neighbours' bodies. A table was checked by who stores it: a scan of `.text` for
RIP-relative `lea`s of the table finds its constructor, destructor or `clone`.

**Verdicts: 34 right, 8 wrong (6 of them on both builds), 22 tables right or inert.**

**Rule.** The walk aligns 2024's slot sequence against 1.26's. Where it is wrong it is wrong **by a slot**, not by a
class: `HumanoidArmorItem` had six slots in a row named one late on both builds, because the carry copied 40's mistake
to 51. **Two builds agreeing is no evidence when one was carried from the other.** A slot name needs its body read
against its neighbours. A leaf the walk named through a fold (`lea 0x28(%rcx); ret` serves a dozen classes) names
nothing until its offset is shown to fit the class.

### Wrong: 8 names

| name | 40 / 51 (old) | what the address is | fix |
|---|---|---|---|
| `?getArmorValue@HumanoidArmorItem@@` | `0x24dbd50` / `0x1a80fb0` | slot 59, `mov rax,[rcx+0x220]; mov eax,[rax+0x14]`: 2024's `getToughnessValue` | **rebound** to slot 58, 40 `0x24dbd40` / 51 `0x1a80fa0`: `mov eax,[rcx+0x214]` (51 `+0x21c`), 2024's `mov eax,[rcx+0x25c]` |
| `?getToughnessValue@HumanoidArmorItem@@` | `0x24dbd60` / `0x1a80fc0` | slot 60, `movss 0x1c(%rax),%xmm0`: `getKnockbackResistanceValue`, a float | **rebound** to slot 59, 40 `0x24dbd50` / 51 `0x1a80fb0` |
| `?getFakePlayerName@IdentityDefinition@@` | `0xbcaf30` / `0x1165480` | 40: `lea 0x100(%rcx)`, another class's leaf. 51: `lea 0x28(%rcx)`, right as folded | 40 retracted. Both ship the accessor `lea +0x28` (Endstone `identity_type_ // +72` after the string); 51's address wins there and is the same |
| `?getParams@CommandOutputMessage@@` | same | same | same, accessor `lea +0x28` (Endstone `params_ // +40`) |
| `?getTagRegistry@Level@@` | same | in neither build's Level table: the walk found 2024's fold in other classes' tables | retracted on both. Candidate: `ILevel` slot 303, 40 `0x743cd0` / 51 `0x7da850`, `mov rax,[rcx+0x48]`, between `getCapabilities` and `get/setPlayerMovementSettings` as in 2024. Not shipped: bdsx's `TagRegistry` is empty and nothing checks it |
| `?canAlwaysEat@FoodItemComponent@@` | `0x176570` / `0x219970` | 40 `movzbl 0x28(%rcx)`, 51 `mov rax,[rcx+0x20]; movzbl 3(%rax)`: two shapes, both only in `AppPlatform`/`ServerScoreboard` tables | retracted on both. The component's own table is in neither symbol table |
| `?setIgnoreEntities@StructureSettings@@` (40) | `0x176580` | `movb %dl,0x28(%rcx)`, named through 2024's fold with an `AppPlatform` virtual | retracted. No route to 1.26's `StructureSettings` layout, and `??0StructureSettings` has no address, so bdsx cannot make one |
| `?setRotation@StructureSettings@@` (40) | `0x1bb86d0` | `movb %dl,0x56(%rcx)`, a `PistonConsumer`-family fold. 40's `getRotation@StructureSettings` (also the walk) reads `+0x32`, so both cannot be right | retracted |

The four other `HumanoidArmorItem` names placed one slot late (`appendFormattedHovertext`, `isValidRepairItem`,
`getEnchantSlot`, `getEnchantValue`; not required) are retracted too. Endstone `item.h` counts them 54-57 on both
releases. The bodies agree: 56 reads the armour-slot field (`+0x210`) the defense sits after, and 57 the material's
`+0x18`, as 2024's `getEnchantValue` did.

What the wrong ones did. `Item.getArmorValue()` returned the toughness. `getToughnessValue()`, and bdsx's own
`Mob.getToughnessValue()` on top of it, read `eax` after a function that returns in `xmm0`. On 40, a fake player's name
and a command message's parameters were read from `+0x100` of an object smaller than that.

### Right: 34 names

| name | evidence |
|---|---|
| `Container::` `hasRoomForItem` 8, `addItem` 9, `addItemToFirstEmptySlot` 11, `removeItem` 14, `removeAllItems` 15, `setCustomName` 36, `isEmpty` 42/41 | Endstone `container.h` counts each at the slot the table has it (51 lost `createTransactionContext`, `findings-containers.md` 3); 2024's slots; the bodies take 2024's registers (`rdx` the stack, `edx`/`r8d` slot and count) |
| `FillingContainer::` `add`, `canAdd`, `clearSlot`, `getContainerSize`, `setItem`, `setItemWithForceBalance`; `Inventory::getFirstEmptySlot` | counted against Endstone in `findings-containers.md` "PlayerInventory"; `add`, `clearSlot`, `setItem`, `getContainerSize`, `getFirstEmptySlot` executed there. The stack stride is now 0x98 (`shr 3; imul $0x286bca1b`) |
| `ComponentItem::` `getComponent` 24, `buildNetworkTag` 28, `initializeFromNetwork` 29, `canDestroyInCreative` 48 | Endstone `item.h`'s slots in the resolved `??_7ComponentItem@@6B@`; `buildNetworkTag` writes the sret `rdx`; executed in `findings-nbt.md` 16 and (by slot) `findings-slots.md` |
| `Item::isDamageable` 14, `isFood` 19 | Endstone's slots; 2024's bodies through the item's own slot |
| `ChunkSource::` `isShutdownDone` 2, `isChunkKnown` 5, `isChunkSaved` 6 | forward to the parent source at `+0x30` through its own slot 2/5/6, 2024's three bodies; Endstone `chunk_source.h` |
| `WorldLimitChunkSource::isWithinWorldLimit` | "Audit follow-ups" (b) |
| `Actor::changeDimension(DimensionType)`, 40 `0xe17920` / 51 `0xd57af0` | slot 89/88, between an empty `ret` (the packet overload, MSVC's reverse order) and `getSourceUniqueID`, 2024's #95-97; `edx` is the dimension passed on as `r8d`, after the vehicle check, as 2024 |
| `Actor::setVelocity`, 40 `0xdfec00` / 51 `0xd3ecd0` | folded with `lerpMotion` (slot 22) and `setPosDelta`: the Vec3 at `rdx` into `StateVectorComponent+0x18` through `Actor+0x218` (`layouts.Actor.stateVector`), 2024's shape at `+0x290` |
| `Player::getSelectedItem` | executed (`findings-containers.md` `pinv`) |
| `ActorDamageSource::getDamagingEntityUniqueID` | "Shared addresses", "Audit follow-ups" (a) |
| `BlockLegacy::getDefaultState`, `getRenderBlock` (slot 104), 40 `0x7448e0` / 51 `0x7db240` | `mov rax,[rcx+0x240]` on both builds (2024 `+0x318`), the offset the reach watch found (`findings-layouts.md`); Endstone `block_type.h` slot 104; `getDefaultState` executed (`findings-blocks.md`) |
| `LevelChunk::getLevel`, 40 `0x741e40` / 51 `0x7d9700` | `mov rax,[rcx+0x50]` in all three builds; Endstone `level_chunk.h`, `level_` after the 80-byte mutex |
| `HumanoidArmorItem::isHumanoidArmor` (51) | "Shared addresses" (its own slot 10) |
| `ScriptCommandOrigin::handleCommandOutputCallback`, 40 `0xa11060` / 51 `0x906f50` | 2024's body (`edx` stored, the callback at `+0x50`, its slot 2). Inert: `jsv` needs `??_7ScriptCommandOrigin@@6B@`, which neither table has |
| `BlockActor::load` (51), `Container::setCustomName` (51), cross-build `getObjective`/`sameItemAndAux`/`fromTag` | read in (c) / "Shared addresses" |

### The tables: 22

| table | 40 / 51 | stored by |
|---|---|---|
| `Actor` (51) | `0xa72c0d0` | the resolved `??1Actor` |
| `ServerCommandOrigin` (51) | `0xa745540` | the resolved `??0ServerCommandOrigin`, its `clone`, its deleting destructor |
| `ServerNetworkHandler` `NetEventCallback` (51) | `0xa715340` | the resolved `??0ServerNetworkHandler` |
| `ActorCommandOrigin` | `0xa626aa0` / `0xa745d30` | `ActorCommandOrigin::clone` and `??0VirtualCommandOrigin` (ctor-store) |
| `Nether`/`Overworld`/`TheEndDimension` `IDimension` (51) | `0xa92db10` / `0xa92dd90` / `0xa924620` | each by the constructor that names it (`"Nether"`, `"minecraft:overworld"`, `"TheEnd"`) |
| `Mob`, `SimulatedPlayer`, `ItemActor` | walk / carry | their deleting destructors (`??_G`) and one constructor each |
| `ChunkSource` | `0xa62fd20` / `0xa7192a0` | 9 / 20 functions: the base constructor inlined into every source |
| `HumanoidArmorItem` | `0xa68b3d0` / `0xa76f8c0` | one constructor; the only table with the `+0x210/+0x214/+0x220` armour bodies |
| `BlockSource`, `Inventory`, `ServerPlayer`, `Player` (51) | carry | unnamed constructors; each is exercised on 51 through `jsv` or the class resolver (block probes, `pinv`, every player event) |
| `JukeboxBlock` | `0xa6c34c0` / `0xa7ecb50` | one function each; not decided, and inert: bdsx's only use is `jsv(..., "?use@JukeboxBlock@@")`, which has no address (`findings-blocks.md` 6) |

### The four binding candidates

| name | result |
|---|---|
| `isHiddenFrom` | **shipped as `bdsx:Player::isHiddenFrom`**, 40 `0x2a02680`, 51 `0x1c64330`: the only two functions holding `cmp edx,0x30b1f` outside a 29 KB one, the same instructions but for the `Item::block_type_` WeakPtr. `(Player const*, ActorType) -> bool`: zombie, skeleton, wither skeleton, creeper and piglin, each against its head. bdsx passes `mob.getEntityTypeId()` |
| `isValidAuxValue` | **`derived()`** over the item's own slot 67 (`layouts.Item.isValidAuxValueSlot`, `engine/item.ts`): 2024's `item_ ? item->isValidAuxValue(aux) : false`. Slot 67 holds the image's `return true` in the plain Item tables and walk-named `isValidAuxValue` overrides (BlockItem, BoatItem, PotionItem, ...) in the rest. 2024 bdsx bound it without its `int` argument; it now takes one |
| `getMaxStackSize` (the address `isValidAuxValue` had) | **shipped**, 40 `0x1bba0d0`, 51 `0x1a54cf0`, in place of its `derived()` (the binary wins) |
| `resetPlayerLevel` | not done. 2024's body (`0x19e6df0`) resets LEVEL and EXPERIENCE to their minimum **and** writes three `Player` fields (`+0x19c0` = 0, `+0x19c4` = 0, `+0x19c8` = 7) that have no 1.26 route. Queued |
| `~NetworkItemStackDescriptor` | not done. Neither the class's vftable nor any of its constructors has a 1.26 address, so bdsx cannot make one to destroy. Queued with the constructor |

### Execution (both builds, `verify-pair`, drivers `audit40`/`audit51`)

`tools/item-probe.ts` `itemprobe audit <armor|aux|stack|fake|hidden|unhidden>` and `tools/softenum-probe.ts`
`seprobe ran` (new: `getParams()` on the message `output.success` added). tsc 0, exit 0 + `Quit correctly`, **20 PASS /
0 FAIL on each build** (`work/host-runs/audit40-20260927-235201.txt`, `audit51-...`):
- **armour**: iron helmet 2/0, diamond chestplate 8/2, netherite leggings 6/3, leather boots 1/0 (armour/toughness,
  vanilla). Their armour sum, 17, equals BDS's own `Mob::getArmorValue()`. bdsx's `Mob.getToughnessValue()` is 5, and a
  diamond sword (the base Item's slots) is 0/0.
- **isValidAuxValue**: a potion is valid for 5 and not for 1000 (PotionItem's override bounds the id at 0x3f). A
  diamond is valid for 1000 (the base returns true). The null stack is false.
- **getMaxStackSize**: the name has an address in the table; diamond 64, ender pearl 16, diamond sword 1.
- **getFakePlayerName**: `audit_fake`'s identity reads `"audit_fake"`, the player's identity `""`.
- **getParams**: `["42"]`, the parameter `output.success` was given, equal to the message's `params` field.
- **isHiddenFrom**: with a zombie head on, true for a zombie (`0x30b20`) and false for a skeleton (`0x110b22`); with an
  iron helmet on, false for both.

The first pair (same tree) failed 3 / 1 checks on probe bugs, not on bdsx. The armour names were matched with `_`
against the item's printed name, which uses spaces; the values printed were already the ones above. On 40, the
`entityCreated` event's `Mob` wrapper had decayed by the time `hidden` ran. Regression on the final tree: `layout40/51`
27 / 0 each, tsc 0, exit 0 + `Quit correctly`. `shared-addr-audit --jsv` lists the same five sites as before, and
`engine-deps --missing` is empty.

## Audit leftovers: `resetPlayerLevel`, `getTagRegistry`, `canAlwaysEat`, `~NetworkItemStackDescriptor` (2026-09-28, agent-s)

The four names "The next audit batch" left open. **All four ship and were executed on both builds**:
`verify-pair`, drivers `auditleft40`/`auditleft51`, `tools/actor-layout-probe.ts` `auditleft <step>`, **23 PASS / 0 FAIL
on each build**, tsc 0, exit 0 + `Quit correctly` (`work/host-runs/auditleft40-20260928-003145.txt`, `auditleft51-...`).
`layout40/51` 27 / 0 each afterwards; `engine-deps --missing` empty.

| name | 40 / 51 | how it was found | checked by |
|---|---|---|---|
| `?resetPlayerLevel@Player@@` | `0x2124b0` / `0x29fba0` | a byte scan for `movq $7,0xb24(reg)`: four functions per build, and this 197-byte one is 2024's body (LEVEL then EXPERIENCE: current := minimum, the delegate's notify slot; then the stores). The known `addLevels` inlines the same sequence on its negative branch, as 2024's `_addLevels` did | `xp 5L` + `xp 3` reads 5 / 0.1765; after the call 0 / 0, `+0xb24` 7, `+0xb23` 0 |
| `?getTagRegistry@Level@@` | `0x743cd0` / `0x7da850` | the candidate, ILevel slot 303 (`mov rax,[rcx+0x48]`), confirmed by a second route: the resolved `Actor::addTag`/`getTags` call `[vptr+0x978]` on `Actor+0x1d8` and walk the result's `+0x58` vector of 0x30-byte IndexSets, Endstone `tag_registry.h`'s `sets_ // +88` | the tag-name vector (`tags_ // +64`) lacks `bdsxauditreg` and `hasTag` is false before `tag @a add`; after, it is at index 0 and `hasTag`/`getTags` agree |
| `?canAlwaysEat@FoodItemComponent@@` | `0x3f7e480` / `0x30311f0` | a `.rdata` scan for a table whose slots 1-3 are `mov eax,[rcx+8]`, `movss xmm0,[rcx+0xc]`, `movzbl X(%rcx)` leaves finds 2024's `IFoodItemComponent` table and one other in 1.21.3.01, and the same two per 1.26 build; the component's destructor stores it at `+0x10`. Slot 3 is `movzbl 0x20(%rcx)`, 2024's body | the apple: `false`, equal to its own network tag; `initializeFromNetwork` with `can_always_eat` 1 makes it `true` (tag 1); restored from its own tag, `false` again |
| `??_7FoodItemComponent@@6B?$NetworkedItemComponent...` | `0xa6fe240` / `0xa7ef7b0` | the table the same destructor stores at `+0`; 2024's slot shape (1 = 3 = `isNetworkComponent`, 51 already named it) | `getComponent("minecraft:food")` resolves as `FoodItemComponent` |
| `??0NetworkItemStackDescriptor@@QEAA@AEBVItemStack@@@Z` | `0x1bdb680` / `0x1a6cb20` | the three `ItemDescriptor`-derived tables share its slot 2 (`getDescriptor` stores `??_7ItemDescriptor`); the one whose deleting destructor frees a string at `+0x40` and 0x60 bytes is this class's (40 `0xa55dbb0` / 51 `0xa67d120`). Of the ~80 functions storing it, one calls `getDescriptor` once: 2024's constructor instruction for instruction | apple ×3: count 3, block id 0; stone ×7: 7, nonzero block id; a sword with `can_destroy` NBT: 1, 188-byte user data |
| `??1NetworkItemStackDescriptor@@` | `derived()` | 1.26 has no out-of-line copy; the deleting destructor (slot 0, 40 `0x23e230` / 51 `0x2d6bc0`, shipped as `??_G`) with flag 0 is the same body without the free | 200 construct/destruct rounds for each of the three, the 188-byte heap string included, and a clean quit |

**What changed in bdsx** (`0ece5d10`). `canAlwaysEat` is an `IFoodItemComponent` virtual: its `this` is the interface
subobject, `component + 0x10` (`layouts.FoodItemComponent.foodInterface`; `ComponentItem::getFood` returns the same
`lea 0x10(%rax)` on both builds). 2024 bdsx passed the component itself, which read a byte of the `ItemDescriptor` vptr
there. The destructor is `derived()` over `??_G...(this, 0)`.

**Also found.** `??_7ScriptActorCommandOrigin@@6B@` (40 walk `0xa6fe280`, 51 carry `0xa7ef7f0`) is the
`IFoodItemComponent` table above, not a command origin. bdsx never used the name; it is retracted on both builds.

**Rules.**
- **A virtual declared on a secondary base takes the base subobject as `this`.** Check the constructor's vptr stores
  before binding a `U` method with `{ this: Class }` on an object reached through the primary vptr.
- **A vanilla item can still be native.** On 1.26 `golden_apple`, `chorus_fruit`, `suspicious_stew`, `honey_bottle`
  and `dried_kelp` have no component map (`getComponentItem()` null); only the apple of those tried had one. When a
  component's other value has no vanilla holder, set it through the engine's own `initializeFromNetwork` and restore
  it from the untouched tag.

**Follow-up, 2026-09-29: the humanoid-armor checks through slot 10.** The slot the two audits above read
(`isHumanoidArmor`, vftable +0x50) now ships as `layouts.Item.isHumanoidArmorSlot` (10). bdsx derives three checks from
it:
- `Item.isArmor` is a `derived()` through the item's own table. On 51 the table still names HumanoidArmorItem's
  override, so 51 keeps the old lookup.
- `ItemStackBase::isHumanoidArmorItem` (bdsx's `isHumanoidWearableArmorItem`) calls the same slot.
- `isHumanoidWearableItem` is that check or the wearable-block walk. 1.26.40 has no standalone copy of it, and 51 keeps
  its own address.

`armor40/51` (`itemprobe armor2`, items from `give`) gave 5 PASS / 0 FAIL on each build: the diamond helmet and iron
chestplate are armor and wearable, the carved pumpkin is wearable only, and the sword and stone are neither
(`work/host-runs/armor40-20260929-160713.txt`).
