# Containers: the table a concrete subclass holds, and two alignment errors it exposed

`Container.prototype.getItem` threw on both 1.26 builds until 2026-09-19, so a plugin had no way
to read an item. Opening it needed one address -- `??_7SimpleContainer@@6B@` -- and finding it
showed that five Container names were shipping the wrong function on both builds, and five more on
1.26.51.1 only.

Read with `docs/findings-slots.md` (route 8, Endstone's header order) and
`docs/findings-instances.md` (the live-read `??_7Inventory@@6B@`).

## 1. An abstract base's table names its subclass's table

`??_7Container@@6B@` was already in both tables (40 `0xa560b90`, 51 `0xa680170`), from the walk.
Container is abstract: its own table holds a stub at each of its six pure virtuals
(2 `serverInitItemStackIds`, 7 `getItem`, 12 `setItem`, 20 `getContainerSize`,
21 `getMaxStackSize`, 22 `startOpen`) and the real body everywhere else. A concrete subclass's
table is therefore the same table with exactly those six slots filled -- which is a signature you
can search for.

On 1.26.40.8 the table at `0xa55d800` differs from `??_7Container@@6B@` in those six slots and
nowhere else. Two of the six were already named: slot 2 is
`?serverInitItemStackIds@SimpleContainer@@` (`0xdcc850`) and slot 21 is
`?getMaxStackSize@SimpleContainer@@` (`0xbe3540`). The other four bodies are one address cluster
with them (`0xdcc5a0`, `0xdcc5e0`, `0xdcc840`, `0xdcc850`) -- one translation unit. Same on
1.26.51.1 at `0xa67cf60` (`0xd130a0`, `0x373b50`, cluster `0xd12e00`/`0xd12e40`/`0xd13090`).

```
??_7SimpleContainer@@6B@   40 0xa55d800 (44 slots)   51 0xa67cf60 (43 slots)
??_7PlayerUIContainer@@6B@ the same address on both
?getItem@SimpleContainer@@ 40 0xdcc5a0              51 0xd12e00   (slot 7)
```

`PlayerUIContainer` derives from `SimpleContainer` and overrides none of its virtuals, so the two
vftables are identical and the linker folds them. That is not a guess: 1.21.3.01 does the same
thing -- `data/baseline-symbols.json` gives `??_7SimpleContainer@@6B@` and
`??_7PlayerUIContainer@@6B@` the one RVA `0x2d52980`, whose slot 0 is `??_GPlayerUIContainer`. A
scan of .rdata for a table with SimpleContainer's slot 2 and slot 7 finds exactly one on each
1.26 build.

`?getItem@SimpleContainer@@` is byte-identical on the two 1.26 builds and the same shape as
2024's (`0x17f8350`): a negative index or an index past the end returns `ItemStack::EMPTY_ITEM`
by `lea`, otherwise `items` (begin `+416`, end `+424`) indexed with

```
imulq $152, %rax, %rax          # 1.26:  sizeof(ItemStack) == 152
leaq (%r8,%r8,4), %rax; shlq $5 # 2024:  sizeof(ItemStack) == 160
```

**`sizeof(ItemStack)` is 152 in 1.26 and was 160 in 2024.** Endstone's HEAD says the same thing
independently -- `BEDROCK_STATIC_ASSERT_SIZE(ItemStack, 152, 152)` in `item_stack.h`,
`(ItemStackBase, 128, 128)` in `item_stack_base.h` -- and those eight bytes are what moved
PlayerInventory's members (section 7). They also move three fields bdsx declares, which is where
the `ItemStackBase` layout work (next-steps Q1-B) starts:

| `bds/inventory.ts` | bdsx says | Endstone's 1.26 header says |
|---|---|---|
| `item` / `userData` / `block` / `aux` / `amount` / `valid` | 8 / 16 / 24 / 32 / 34 / 35 | the same |
| `showPickup` | 48 | **36** (`show_pick_up_`, with `was_picked_up_` at 37) |
| `pickupTime` | 40 | 40 |
| `canPlaceOn` | 0x38 (56) | **48** (with `can_place_on_hash_` at 72) |
| `canDestroy` | 0x58 (88) | **80** (with `can_destroy_hash_` at 104) |

The three that differ are the ones bdsx has never read on 1.26; `isNull`, `getId` and `getAuxValue`
only touch +8, +32 and +35, which is why nothing has faulted yet. **Confirmed and shipped on
2026-09-20 — section 10.** It took no live read: the constructors and the destructor spell the
whole class out, and the v0.11.7 header does not disagree with HEAD (only its stale comments do).

## 2. What the walk got wrong: 2024's Container has 40 slots, 1.26's has 44

The three virtuals 1.26 added to `Container` -- `firstEmptySlot`, `firstItem`,
`reverseFindFirstSlotForItem` -- go at 28, 29 and 31. The vftable walk's alignment put the gap at
24, 25, 26 instead. The total is the same, so everything from slot 34 on lines up again and
nothing looked wrong; only slots 24-31 carry the wrong names, and two of those are names bdsx
requires (`getSlots`, `getItemCount`).

The bodies settle it, and they say the same thing on both builds:

| slot | name | how the body says so | 40 | 51 |
|---|---|---|---|---|
| 24 | `getSlotCopies` | sret; `addq $152, 8(%rax)` -- it appends ItemStack **values** | `0x2dd190` | `0x371660` |
| 25 | `getSlots` | sret; appends 8-byte **pointers** | `0x2dd2d0` | `0x3717a0` |
| 26 | `getEmptySlotsCount` | reads no argument register | `0x2066d0` | `0x294440` |
| 27 | `getItemCount` | reads `rdx`, counts from 0 | `0x2dd720` | `0x371b90` |
| 28 | `firstEmptySlot` | no `rdx`, defaults to -1 | `0x2dd7d0` | `0x371c40` |
| 29 | `firstItem` | no `rdx`, defaults to -1 | `0x2dd860` | `0x371cd0` |
| 30 | `findFirstSlotForItem` | reads `rdx`, defaults to -1 | `0x2dd8f0` | `0x371d60` |
| 31 | `reverseFindFirstSlotForItem` | reads `rdx`, counts **down** (`decl`) | `0x2dd9a0` | `0x371e10` |

Shipped before this: `getSlotCopies` `0x2dd720`, `getSlots` `0x2dd7d0`, `getEmptySlotsCount`
`0x2dd860`, `getItemCount` `0x2dd8f0`, `findFirstSlotForItem` `0x2dd9a0` -- every one of them three
slots late. `?getSlots@Container@@` was `firstEmptySlot`, which takes no argument and returns an
int, so bdsx's `structureReturn` vector came back uninitialised; `?getItemCount@Container@@` was
`findFirstSlotForItem`, which returns a slot index rather than a count.

The two routes that agree here are Endstone's header order (`--families=container`, once the tool
could read SimpleContainer's table) and the argument/return shape of the bodies. `canPushInItem`
and `canPullOutItem` at 32/33 were right all along, because the walk's misplaced gap ends before
them.

## 3. 1.26.51.1 has 43 Container slots: `createTransactionContext` is gone

Endstone's HEAD header (which targets 1.26.51) declares `Container` without
`createTransactionContext`; v0.11.7 (1.26.40) declares it. The table lengths agree: 44 on
1.26.40.8, 43 on 1.26.51.1, and the same one-slot difference runs down the family
(FillingContainer 53 -> 52, Inventory 55 -> 54). So the carry from 40 to 51 shipped slots 35-39 one
slot late there too.

Three byte-identical pairs anchor it -- 51's `0x372140` is 40's `setContainerMoved` (`0x2ddcd0`),
`0x3722c0` is 40's `setCustomName` thunk (`movb $1,368(%rcx); addq $296,%rcx; jmp`), `0x3722e0` is
`hasCustomName` (`movzbl 368(%rcx); ret`) -- as do the two empty stubs that bracket `isEmpty` in
both builds (`initializeContainerContents` before it, `isSlotDisabled` after).

```
51: 34 setContainerChanged 0x3720f0   35 setContainerMoved 0x372140   36 setCustomName 0x3722c0
    37 hasCustomName 0x3722e0         38 readAdditionalSaveData 0x3722f0
    39 addAdditionalSaveData 0x372800 40 initializeContainerContents (stub)
    41 isEmpty 0x373810               42 isSlotDisabled (stub)
```

`?setCustomName@Container@@` is a required name and was shipping `setContainerMoved` on 1.26.51.1.
`?createTransactionContext@Container@@` is retracted there: the build has no such function.

## 4. `??_7FillingContainer@@6B@` was the wrong table (next-steps Q1 4)

The audit line was: the table said `?getItem@FillingContainer@@` is `0x1f40120` while slot 7 of
`??_7FillingContainer@@6B@` (`0xa667750`) is `0x1f419b0`. The vftable is the wrong one. A class's
own table cannot override its own method, and `0xa667750` differs from FillingContainer's bodies
at **both** slot 2 and slot 7, so it belongs to a subclass.

The real one is the table whose slot 2 is `?serverInitItemStackIds@FillingContainer@@`, slot 7
`?getItem@FillingContainer@@` -- the same address the live-read `??_7Inventory@@6B@` holds at slot
7, and Inventory does not override `getItem`, in 2024 or now -- whose add/canAdd are
FillingContainer's own, and whose every Container slot is unmodified:

```
??_7FillingContainer@@6B@  40 0xa667500 (53 = 44 + 9)   51 0xa7745c0 (52 = 43 + 9)
```

`?getItem@FillingContainer@@` (40 `0x1f40120`, 51 `0x253c850`) was right and stays. Both tables
keep `?canAdd@FillingContainer@@` at the same address the walk gave it, so
`FillingContainer.prototype.canAdd` is unaffected.

## 5. `getOffhandSlot` needs no address

2024's `?getOffhandSlot@Actor@@` (`0x19b4260`) is three instructions of work:

```
addq $8, %rcx            # Actor::ctxbase
callq ActorEquipment::getHandContainer
movl $1, %edx
jmpq *[vftable + 56]     # slot 7 = Container::getItem
```

Slot 7 is `getItem` in 2024, 1.26.40.8 and 1.26.51.1 alike, so the body carries: bdsx ships it
through `derived()` as `this.getHandContainer().getItem(1)`.

`?getHandContainer@ActorEquipment@@` had only a call-edge propagation address (40 `0x1acb800`,
51 `0x1cd2090`). Route 10 confirms it independently: the body looks up
FNV-1a-32(`"ActorEquipmentComponent"`) = `0xB06141A9` and returns the component's first qword,
which is what 2024's does after its out-of-line `tryGetComponent` call (`movq (%rax),%rax; ret`).
Both 1.26 bodies are 217 bytes and identical.

## 6. The tool fix

`tools/endstone-slots.mjs` computed a table's expected length from its class's position in the
family's inheritance `chain`, and fell back to the whole chain's length for a class that is not in
it. `SimpleContainer` is not in the chain -- it declares no virtuals of its own, it only implements
Container's pure ones -- so its 44-slot table was gated against Inventory's 55 and every Container
name was dropped. A `bases` map per family now names the chain class such a table belongs to
(`SimpleContainer` -> `Container`), and `FillingContainer` was added to `tables` now that its
address is known. Families whose chain is a single class need no entry.

Measured against the committed `data/candidates-endstone-slots-<v>.json`: 103 names unchanged on
both builds, no name changed value, `?getItem@SimpleContainer@@` and `?canAdd@FillingContainer@@`
added. The container family scores **8 agree / 2 disagree / 1 new** on 1.26.40.8 and
**7 / 3 / 1** on 1.26.51.1 -- the disagreements are exactly the wrong names in sections 2 and 3.

51's scan cutting `??_7Container@@6B@` at 43 slots where 40 has 44 is not a scan boundary problem:
the build really has one slot fewer (section 3).

The candidates file itself was **not** regenerated with this fix: the committed one is older than
the tables and a rerun would also add `?knockback@Mob@@...KnockbackParameters@@@Z`,
`?startSleepInBed@Player@@` and `?changeDimension@ServerPlayer@@`, three names whose prototype
changed (next-steps Q2). The two names the fix adds were promoted through `data/resolved-<v>.json`
instead.

## 7. PlayerInventory moved by the eight bytes ItemStack lost

`?getSupplies@Player@@` had no address. In 2024 it is the whole function:

```
movq 1888(%rcx), %rax ; retq          ?getSupplies@Player@@ 0x19dfba0
```

1.26's `?getSelectedItem@Player@@` (40 `0x2329a0`, 51 `0x2bdb30`, byte-identical) opens
`movq 1464(%rcx), %rax` and then inlines what 2024 kept out of line as
`?getSelectedItem@PlayerInventory@@` (`0x186c1d0`), which reads the same member. So
`Player::inventory_` is at **+1464** on both 1.26 builds, and `getSupplies` ships as an
`accessors` entry (`get`, 8 bytes) rather than an address.

The inlined tail also gives PlayerInventory's layout, and Endstone's `player_inventory.h` explains
it exactly:

| member | 2024 | 1.26 |
|---|---|---|
| `int selected_` | +16 | +16 |
| `ItemStack infinite_item_` | +24 (160 bytes) | +24 (**152** bytes) |
| `ContainerID selected_container_id_` | +184 | **+176** |
| `unique_ptr<Inventory> inventory_` | +192 | **+184** |

and the two bodies say the same:

```
2024  cmpb $0, 184(%rcx) ; movq 192(%rcx), %rcx ; movl 16(%rdx), %edx ; jmp *[vft+56]
1.26  cmpb $0, 176(%rax) ; movq 184(%rax), %rcx ; movl 16(%rax), %edx ; ...
```

The whole shift is one `ItemStack` by value. `layouts.PlayerInventory.container = 184` ships it and
`bds/inventory.ts` reads the offset from the table, falling back to 2024's `0xc0`.

## 8. `?isNull@ItemStackBase@@` on 1.26.51.1, and what byte matching can still do

Every step of the probe below reads `isNull`, and 1.26.51.1 was shipping the wrong function for it
(`0x235050`: 244 bytes, reads `rdx`, dereferences `(rcx)` twice -- not a const predicate on an
ItemStackBase). The correction to `0x1a549d0` was found and shipped the same day from the
`hasTotemEquipped` side; see its provenance in `data/resolved-1.26.51.1.json`.

What is worth recording here is that this family is reachable by **byte matching**, which the
closed-methods table rules out for Mojang's code in general (1 of 736 whole functions). It works
here: 1.26.40.8's `0x1bc2260` and 1.26.51.1's `0x1a549d0` share their first 24 bytes and their
308-byte `.pdata` extent, and that 24-byte pattern occurs **exactly once** in 51's `.text`. The
same search confirmed three more addresses the table already carried on 51 --
`?sameItemAndAux@` `0x27d8f0`, `?_setItem@` `0x1a546f0`, `?isValidAuxValue@` `0x1a54cf0`, each a
unique hit. It does not always answer, and it answers nothing at all for a function that opens by pushing
eight registers: `?isDamageableItem@`'s 24 bytes hit **634** times in 51's `.text` (section 10
corrects an earlier note that said two), and `?isHumanoidWearableItem@` gets none. Between two 1.26 builds, and only for a family compiled without
much inlining, the bytes did not move.

## 9. What execution showed

`tools/item-probe.ts` (console `itemprobe base|shield|count|slots|give|inv|clear|invclear`, drivers
`tools/host/drivers/item40.ps1` and `item51.ps1`). It reads through the seam in the direction that
cannot be faked -- BDS writes with `replaceitem` and `clear`, bdsx reads -- and uses the offhand,
which lives in the two-slot ActorEquipment hand container rather than in `PlayerInventory`.

**Both builds, 12 of 12 PASS, `exit code: 0` and `Quit correctly`** -- but not in one sitting, and
the record first said otherwise. 1.26.51.1 passed on 2026-09-19 21:55
(`work/host-runs/item51-20260919-215510.txt`). The two `item40` runs that night both died in the
upload phase (`scp: Connection closed`) and produced **no `[item]` line at all**, yet the commit
claimed both builds. A dropped session leaves an empty transcript, which looks exactly like a
`--grep` that matched nothing -- that is the trap, and `next-steps.md` Q0 now carries it. 1.26.40.8
was run separately and passed on 2026-09-20 00:58
(`work/host-runs/item40-20260920-005844.txt`).

| step | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `base` two distinct slots; `getOffhandSlot()` is the very same pointer as `getItem(1)` | PASS | PASS |
| `shield` after `replaceitem entity @a slot.weapon.offhand 0 shield 1`: non-null, `isEmpty()` false | PASS | PASS |
| `count` `getItemCount(offhand) == 1` | PASS | PASS |
| `slots` `getSlots()` is 2 pointers, equal to `getItem(0)` and `getItem(1)` | PASS | PASS |
| `inv` after `give @a diamond_sword 1`: the selected inventory slot is non-null, `isEmpty()` false | PASS | PASS |
| `clear` / `invclear` after `clear @a`: both read null and both containers report empty | PASS | PASS |

On 1.26.51.1 the probe printed what BDS had just been told to put there:
`1 x Shield(358)@0` in the offhand and `1 x Diamond Sword(318)@0` in the selected slot, through
`ItemStackBase::toString`. The cross-check that ties the whole chain together is in the `give`
line: bdsx's route (the `getSupplies` accessor at Player+1464, `container` at +184, virtual slot 7)
returns the identical address to BDS's own `Player::getSelectedItem` and to `Actor::getCarriedItem`
-- `0x1e65d4a4c60` on 40, `0x1a3-22ff6f00` on 51.

Not measured: whether the equipment container's slot 0 mirrors the inventory's selected slot in
general. On both runs it did (`sameAsSlot0=true`), but only for the slot the player had selected.

## 10. `ItemStackBase`: the eight bytes, and where they came out (next-steps Q1-B-1)

Section 1 left three of bdsx's `ItemStackBase` fields open with a header table and a note that
confirming them "wants a live `RP_WATCH` on a bot's held ItemStack, not another header". It wanted
neither: the class is written down twice inside the binary, in its own constructors and its own
destructor, and both 1.26 builds say the same thing.

**What moved.** 2024 laid the tail out as `valid_` +35, pad, `pick_up_time_` +40, `show_pick_up_`
+48, `was_picked_up_` +49, pad, `can_place_on_` +56, its hash +80, `can_destroy_` +88, its hash
+112, `blocking_tick_` +120, `charged_item_` +128 — 136 bytes. 1.26 put the two bools in the
padding that already existed at +36/+37, ahead of `pick_up_time_` instead of behind it, and
everything after closed up by eight: `can_place_on_` **+48** (hash +72), `can_destroy_` **+80**
(hash +104), `blocking_tick_` +112, `charged_item_` +120 — **128**. Every `ItemStack` held by value
lost the same eight: **152** where 2024 had 160.

**Route 1, the constructors.** `??_7ItemStackBase@@6B@` is in both tables (40 `0xa651840`,
51 `0xa7690e0`; its slots 4/5/6 are the `setNull` / `toString` / `toDebugString` the tables already
name). Fourteen functions on 1.26.40.8 and eight on 1.26.51.1 store that vftable; one is the
destructor and the rest are constructors, and they all open the same way on both builds:

```
movups %xmm0, 8(%rcx)      # item_, user_data_
movups %xmm0, 19(%rcx)     # block_, aux_, count_   (an overlapping store)
movw   $257, 35(%rcx)      # 0x0101: valid_ = 1 at +35, show_pick_up_ = 1 at +36
movb   $0, 37(%rcx)        # was_picked_up_
leaq   48(%rcx), %rax      # can_place_on_, handed to the unwind frame
leaq   80(%rcx), %rax      # can_destroy_
movups %xmm0, 40(%rcx)     # pick_up_time_, and can_place_on_.begin right behind it
```

2024's `??0ItemStackBase@@IEAA@XZ` (`0x1b493c0`) writes `movl $0x01000000, 32(%rcx)` and then
`movw $1, 48(%rcx)`. The two bools are the whole difference, and this one function fixes every
offset bdsx declares, not only the three that moved.

**Route 2, the destructor.** vftable slot 0 is the deleting destructor and its sized delete names
the class: `movl $128, %edx` on both 1.26 builds (40 `0x1bdf000`, 51 `0x1a726b0`) where 2024's
(`0x1b4e340`) is `$136`, and `??_7ItemStack@@6B@` slot 0 (40 `0x15b010`, 51 `0x1ceb80`) is
`movl $152, %edx` where 2024's is `$160`. The real destructor behind it (40 `0x1bba1b0`,
51 `0x1a50dd0`, byte-for-byte the same shape on the two builds) frees `charged_item_` at +120 and
then walks `80/88/96` and `48/56/64`; 2024's (`0x1b4d2ac`) frees +128 and walks `88/96/104` and
`56/64/72`.

**Route 3** is Endstone's HEAD `item_stack_base.h`, which declares the members in that order and
asserts `sizeof == 128`. Its v0.11.7 copy declares **the same members in the same order** but
carries 2024's numbers in the trailing comments, which sum to 136 and contradict its own assert —
the comments are stale, the declarations are not. Section 1's table read the v0.11.7 comment for
`can_place_on_` (+56) as if the two releases disagreed about the build. They do not; no Endstone
release does.

`layouts.ItemStackBase` (`size` 128, `showPickup` 36, `pickupTime` 40, `canPlaceOn` 48,
`canDestroy` 80) and `layouts.ItemStack` (`size` 152) ship it, from the `offsets` block of
`data/candidates-instances-<v>.json`; `bds/inventory.ts` reads each as
`pdbcache.layouts.X?.y ?? <2024 literal>`, including the two `@nativeClass()` sizes.

### What execution showed, and why the first run's numbers were right

`tools/item-probe.ts` grew three steps (`can`, `cantagged`, `size`); drivers `item40.ps1` /
`item51.ps1`. **Both builds, 17 of 17 PASS, `exit code: 0` and `Quit correctly`**
(`work/host-runs/item40-20260920-144800.txt`, `item51-20260920-144800.txt`).

| step | what it does | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `can` | a `stone` BDS put in the offhand with no components: both vectors empty | PASS | PASS |
| `cantagged` | after a `replaceitem` carrying `can_destroy` `["minecraft:dirt"]` and `can_place_on` `["minecraft:dirt","minecraft:stone"]` | PASS | PASS |
| `size` | the inventory container's own element stride vs bdsx's `sizeof(ItemStack)` | PASS (152) | PASS (152) |

The first run of `cantagged` asserted counts — one block in `can_destroy_`, two in `can_place_on_` —
and came back `canDestroy.size=2, canPlaceOn.size=9` on **both** builds. That is not a layout error
and the check was the wrong one: `_loadBlocksForCanPlaceOnCanDestroy` resolves a command name to
every legacy block that answers to it, and `dirt` is two of them while `stone` is seven. Printing
the names through `BlockLegacy + layouts.BlockLegacy.name` settles it:

```
canDestroy(2)=[minecraft:dirt, minecraft:coarse_dirt]
canPlaceOn(9)=[minecraft:dirt, minecraft:andesite, minecraft:polished_diorite, minecraft:stone,
               minecraft:diorite, minecraft:granite, minecraft:coarse_dirt,
               minecraft:polished_andesite, minecraft:polished_granite]
```

identical on both builds. The check is now on content rather than count: `can_destroy_` holds only
blocks whose name contains `dirt`, and `can_place_on_` holds **every pointer `can_destroy_` holds**
plus the stone ones. Reading either vector at 2024's offset would put `begin` on what is really
`end` and `end` on `capacity`, which cannot yield a set of live `BlockLegacy` pointers whose names
are the ones typed at the console, let alone that containment relation.

`size` needed a correction of its own: its first version measured the gap between the hand
container's slot 0 and slot 1 and got 191,151,880. Those two are not one array — slot 0 of the
equipment container mirrors the selected **inventory** item (section 9's `sameAsSlot0`), so the
addresses come from different allocations. The player's inventory is contiguous:
`FillingContainer::getItem` is `items.begin() + index * 152` (40 `0x1f40120`, the `imulq $152` is
right there), and slot 1 minus slot 0 measures **152** on both builds — BDS's own compiled stride,
equal to what bdsx now declares.

### Q1-B-4: two addresses the audit disproved

The same pass read the three `ItemStackBase` names next-steps Q1-B-4 listed. Two were wrong on
1.26.40.8 and are now in `retracted` (they had no 1.26.51.1 address either, so both names go back
to unresolved on both builds):

- `?isDamageableItem@ItemStackBase@@QEBA_NXZ` `0xed330` — 432 bytes, reads `rdx`/`r8`/`r9`, and
  carries `movabsq $0x666666666666667`, `std::vector`'s `max_size` guard for a 40-byte element. It
  is a vector growth helper, not a const no-argument predicate. 2024's (`0x1b64780`) is 52 bytes:
  `item_` at +8, deref the `WeakPtr`, call Item's vtable slot 13.
- `?getMaxStackSize@ItemStackBase@@QEBAEXZ` `0x1bc1d60` — it *is* an `ItemStackBase` member (it
  reads `block_` at +24 and compares `aux_` at +32 against the `0x7FFF` sentinel) but it takes a
  second pointer in `rdx` and calls through it, so it is not `uint8 getMaxStackSize() const`.

Neither has a 1.26 successor of the 2024 shape: scanning both builds for the
`sub rsp,40; mov rax,[rcx+8]; test rax,rax` prologue finds 2024's cluster of ~52-byte
`ItemStackBase` predicates (`0x1b64740`, `0x1b64780`, `0x1b64b60`, `0x1b64ea0`, `0x1b656b0`, …) and
nothing of that size in 1.26 — the inliner took them, the same way it took the health pair
(`findings-components.md`).

`?isHumanoidWearableItem@ItemStackBase@@QEBA_NXZ` is **left as it is and flagged**: the two builds
carry structurally different bodies for it and at most one can be right. 51's `0x1a59d80` (194
bytes) has the 2024 shape — `item_`, deref, call an `Item` virtual (slot 10 where 2024 used slot 9),
return true on it, otherwise a second check on `item_`. 40's `0x1bc3ad0` (272 bytes) instead takes
`item + 376` (or a lazily-initialised function-local static) and walks a global pointer array — a
tag-membership test. Neither build holds a function matching the other's bytes or size, so this is
not a carry problem; one of the two addresses is a different function. Both came from call-edge
propagation and neither has been executed.

Also corrected here: next-steps recorded "`?isDamageableItem@` gives two hits" for the 24-byte
search of section 8. Re-run, `0xed330`'s first 24 bytes are a bare register-save prologue and hit
**634** times in 51's `.text`. The byte route works on this family only for the small
position-independent bodies; it says nothing about a function that starts by pushing eight
registers.

### Q1-B-4 closed: the Item vtable slots, not the addresses

Both names ship as `derived()` dispatching through `Item`'s own vtable. Neither
`?isDamageableItem@ItemStackBase@@` nor `?getMaxStackSize@ItemStackBase@@` has a 1.26 address on
either build -- the inliner took both out-of-line wrappers, the same fate as `getComponentItem`
(`docs/findings-audit.md`) -- but the slot each one dispatches through is now known on both builds,
by the same two-independent-routes standard this project always requires.

2024's `?isDamageable@Item@@UEBA_NXZ` sits at `??_7Item@@6B@` slot **13** (`0x1cb1a80`, read with
`tools/vftable-slots.mjs` against the baseline), and
`?getMaxStackSize@Item@@UEBAEAEBVItemDescriptor@@@Z` at slot **87** (`0x1cadab0`). Endstone's HEAD
`item.h` (targets 1.26.51.1) and its v0.11.7 copy (targets 1.26.40.8) count the same two virtuals
identically on both releases, from the destructor at slot 0: slot **14** `isDamageable`, slot
**100** `getMaxStackSize(ItemDescriptor const &)`. The first is a plain +1 (the same shift already
on record for `isComponentBased` 8->9 and `isHumanoidArmor` 9->10 above); the second is +13, from
all the rarity/sound/hover-text virtuals 1.26 inserted between them -- not a uniform shift, so the
header has to be counted for this class, not extrapolated from the earlier +1.

A second, independent route confirms both slot numbers directly from bodies, without trusting the
header alone. `?getAvailableSetCount@ContainerValidationBase@@UEBAHHAEBVItemStackBase@@@Z` (already
resolved on both builds, 40 `0x8f47020` / 51 `0x8b82e90`) inlines 2024's whole
`getMaxStackSize@ItemStackBase` body verbatim: an `isNull` check, a call into
`?getDescriptor@ItemStackBase@@QEBA?AVItemDescriptor@@XZ` to build a local 16-byte `ItemDescriptor`,
then `movq (%rsi),%rax ; movq 0x320(%rax),%rax` (0x320 = 100*8) before the virtual dispatch --
byte-identical on both builds (`disas-exact`). `?dropEquipmentOnDeath@Mob@@UEAAXAEBVActorDamageSource@@@Z`
(also already resolved, 40 `0x2408a20` / 51 `0x29f0460`) inlines 2024's `isDamageableItem` check the
same way: `item_+8`, double deref, `movq (%rcx),%rax ; movq 0x70(%rax),%rax` (0x70 = 14*8), a bool
virtual call -- also byte-identical on both builds.

A bonus confirms slot 14 a third time. `getDescriptor@ItemStackBase` itself (the function
`getAvailableSetCount` calls to build the descriptor) is the exact address this section recorded
above as a mislabelled candidate for `getMaxStackSize` (40 `0x1bc1d60` / 51 `0x1a544e0` -- "it *is*
an `ItemStackBase` member... but it takes a second pointer in `rdx`"). Reading further: that second
pointer is the sret buffer for the `ItemDescriptor` it constructs (MSVC's member-function ABI puts
`this` in rcx and the hidden return pointer in rdx -- confirmed against 2024's own `getDescriptor`,
`0x1b5fc40`, the exact decorated name in `data/baseline-symbols.json`, same complexity, same
block_/aux_ gate), and partway through its own ~120-byte body it dispatches `Item` vtable slot 14
(`movq (%rcx),%rax ; movq 0x70(%rax),%rax`) to decide which kind of descriptor to build -- exactly
the isDamageable check, called from inside the very function that was retracted under the wrong
name. It ships here, correctly named, as a small new resolved address (`data/resolved-<v>.json`,
not required by bdsx before this change) purely to support `getMaxStackSize`'s `derived()`
implementation -- reimplementing its own ~120-byte body (item registry lookups, block-item
resolution) in JS would not be safe or correct, so the real function is called the same way every
other `derived()` helper in this file calls an already-resolved neighbour (e.g. `resendAllChunks`
calling `clearRegion@NetworkChunkPublisher`, added the same day).

`tools/item-probe.ts` gained two steps, `stacksize <n>` and `damageable <true|false>`, reading
`inv.container.getItem(inv.getSelectedSlot())` the same way `aux` does, after a `clear`+`give`
cycle through six items with known values (apple 64/false, diamond_pickaxe 1/true, stone 64/false,
ender_pearl 16/false, bow 1/true, diamond_sword 1/true). **Both builds, 12 of 12 PASS**, `exit code:
0` and `Quit correctly` (`work/host-runs/stackdmg40-20260923-024139.txt`,
`stackdmg51-20260923-024139.txt`): the console's own item table gives every pair, and bdsx's read
matches it every time, on both builds, through the same two vtable slots.

## 11. The ItemStackBase readers and the PlayerInventory forwarders (next-steps Q1-B-2 and Q1-B-3)

Section 10 fixed the class layout. What was still missing above it was the reading end --
`ItemStackBase::getItem` / `getId` / `getAuxValue` -- and the whole of `PlayerInventory`, thirteen
names none of which 1.26 keeps out of line. **None of the thirteen needed an address.** One address
came out of the work anyway, and two offsets had to be found first.

### `?EMPTY_ITEM@ItemStack@@2V1@B` -- 40 `0xc93ba48`, 51 `0xccb2ee0`

`PlayerInventory::getItem` and `getSelectedItem` return it for any ContainerID that is not
`Inventory`, so bdsx cannot carry them without it. Two independent functions take its address on
each build with the same `lea rax, [rip+..]` -- `?getItem@SimpleContainer@@` (40 `0xdcc5a0` / 51
`0xd12e00`) and `?getItem@FillingContainer@@` (40 `0x1f40120` / 51 `0x253c850`), both returning it
for a negative index or one past the end, which is exactly what 2024's `?getItem@SimpleContainer@@`
(`0x17f8350`) does with `0x333d130`. It lands in `.data` **past the section's raw size**, i.e. in
the zero-initialised tail a dynamic initialiser fills -- the same shape as
`?INVALID_ABILITY@Abilities@@` (`docs/findings-abilities.md`), so it ships as an address and not as
a `constants` entry.

### `Item::id_` 162 -> 170, read off an inlined copy of the function that wanted it

2024's `?getId@ItemStackBase@@` (`0x1b61150`) is `!valid_ ? -1 : (item_ && *item_ ?
Item::getId(*item_) : 0)`, and `?getId@Item@@` (`0x1cad2e0`) is the two-instruction leaf
`movzwl 162(%rcx); retq`. Neither survives in 1.26 -- a 13/28/30/25-byte search for any of the four
2024 bodies hits **0** times in either build's `.text`, and `Item::getId` was a leaf `.pdata` never
described anyway. But the whole of `getId` is **inlined into `ItemStackBase::toString`** (40
`0x1bbfb40` / 51 `0x1a52430`), and the two builds are byte for byte the same there:

```
mov    dx, 0xffff                 # the -1 default
cmpb   $1, 35(%rsi)  ; jne ->     # valid_
mov    rcx, [rsi+8]  ; test ; je -> 0    # item_, the WeakPtr slot
mov    rcx, [rcx]    ; test ; je -> 0    # the Item*
movzwl 170(%rcx), %edx                   # Item::id_
```

That is also the id BDS prints, because the next instruction is `movswl 32(%rsi), %edx` -- the `@N`
in `"1 x Diamond Sword(318)@0"` is `aux_` read straight out of the ItemStackBase, **not**
`getAuxValue()`. So `toString` is an independent compiled read of both fields and is what the probe
checks bdsx against.

### `Block::data_` 40 -> 288

`getAuxValue` (2024 `0x1b5f320`) is ten instructions: `block_ && aux_ != 0x7FFF ?
*(uint16*)(block_+40) : aux_`. The sentinel survives in 1.26 (the retracted
`?getMaxStackSize@ItemStackBase@@` at 40 `0x1bc1d60` still does `cmpw $32767, 32(%rsi)` after
reading `block_` at +24, which is what confirms those two offsets), but nothing in either build
reads a block's data with it: a search for `cmp word [reg+0x20], 0x7fff` finds **two** sites per
build and neither is the block branch.

Endstone's 1.26 `block.h` answers it. It takes `DataID data_` out of its old place right behind
`components_` -- its `// DataID data_;` comment is still sitting there, which is where 2024's +40
came from -- and declares it in the tail after `client_data_`, asserting `sizeof(Block) == 296`.
`??_GBlock` (40 `0x1bb6360` / 51 `0x2cfae90`, identical openings) frees the `client_data_`
`unique_ptr` at **+280** and unwinds `serialization_id_` at +240, so 280 `client_data_` / 288
`data_` / 290 `has_runtime_id_` / 296 is the only packing that fits.

That is a header plus an arithmetic argument, so it was checked live rather than shipped on it --
see "blkdata" below.

### PlayerInventory: ten forwarders and three tables read by name

Every 2024 body is three to six instructions -- bail out unless the ContainerID is `Inventory`(0),
then `container->vft[n](...)`:

| name | 2024 | what it forwards to |
|---|---|---|
| `getItem` | `0x186b450` | `&EMPTY_ITEM`, else Container slot 7 `getItem` |
| `getSelectedItem` | `0x186c1d0` | `&EMPTY_ITEM`, else slot 7 with `selected_` (+16) |
| `setItem` | `0x1879a90` | slot 13 `setItemWithForceBalance(slot, item, linkEmptySlot)` |
| `setSelectedItem` | `0x187a320` | slot 12 `setItem(selected_, item)` |
| `clearSlot` | `0x1869830` | `FillingContainer::clearSlot` |
| `add` | `0x1868540` | `FillingContainer::add` -- the `bool` is passed on and never read |
| `canAdd` | `0x1869340` | `FillingContainer::canAdd` |
| `getContainerSize` | `0x186a900` | 0, else slot 20 `getContainerSize` |
| `getFirstEmptySlot` | `0x186ae40` | `Inventory::getFirstEmptySlot` |
| `getHotbarSize` | `0x186b1c0` | `FillingContainer::getHotbarSize` |

**None of those slot numbers is carried.** bdsx binds each callee by name through
`procHacker.jsv("??_7FillingContainer@@6B@", ...)` and `("??_7Inventory@@6B@", ...)`, which searches
the table in the running process, so a build that moves a slot moves with it. Both tables were read
here first and both line up with Endstone's `filling_container.h` / `inventory.h` declaration order
slot for slot, on top of the corrected Container length (44 on 1.26.40.8, 43 on 1.26.51.1 --
sections 2 and 3):

```
FillingContainer adds 9:  44 removeResource  45 swapSlots  46 add  47 canAdd  48 clearSlot
                          49 clearInventory  50 saveToTag  51 loadFromTag  52 _trySetInSlot   (1.26.40.8)
Inventory adds 2:         53 getFirstEmptySlot  54 setContainerSize
```

and one slot earlier throughout on 1.26.51.1 (53 and 52 total). `?setItem@Inventory@@` and
`?setItem@FillingContainer@@` carry the same address on both builds because ICF folded them; that
is not the walk misnaming anything, it is slot 12 of both tables.

`getHotbarSize` needs no call at all: `?getHotbarSize@FillingContainer@@` is `movl $9,%eax; retq`,
the same six bytes `b809000000c3` in all three builds (2024 `0xa27d60`, 40 `0x14842c0`,
51 `0x1286390`), and Endstone's header declares `HOTBAR_SIZE = 9`.

`selected_container_id_` is the one field the guards need: +184 in 2024, **+176** in 1.26, which
section 7 already read out of `Player::getSelectedItem`'s inlined tail.

### What execution showed

`tools/item-probe.ts` grew four steps (`aux`, `blockaux`, `pinv`, `pinvwrite`) and
`tools/block-probe.ts` one (`blkdata`); drivers `item40.ps1` / `item51.ps1`.
**Both builds, 44 of 44 PASS, `exit code: 0` and `Quit correctly`**
(`work/host-runs/item40-20260921-130508.txt`, `item51-20260921-130508.txt`).

| step | what it does | both builds |
|---|---|---|
| `aux` | `getAuxValue()` and `getId()` against the `Name(id)@aux` BDS's own `toString` prints | PASS for Diamond Sword(318)@0 and **Potion of Healing(430)@22** |
| `blockaux` | the same for a block item, where `block_` is not null so the read goes through `Block::data_` | PASS, Granite(-590)@0 |
| `blkdata` | `Block::data_` read off blocks the console places: `minecraft:stone` and the three `pillar_axis` states of `minecraft:oak_log` | PASS, **0 / 0, 1, 2** |
| `pinv` | `getSelectedItem`/`getItem`/`getContainerSize`/`getFirstEmptySlot`/`getHotbarSize` | PASS; the selected slot is the address BDS's own `Player::getSelectedItem` returns, 36 / 0 / 9, firstEmpty 2 |
| `pinvwrite` | `setItem` into slot 9, `add` the copy, `clearSlot` it, `setSelectedItem` | PASS; BDS's `Player::getSelectedItem` reads the apple back |

The `blkdata` numbers are the discriminating ones for `Block::data_`: a neighbouring field is either
the same for all three log states (the padding, `has_runtime_id_`, the high half of `client_data_`)
or is neither 0 for stone nor small (`network_id_`, `serialization_id_hash_for_network_`). 0/1/2 for
three states of one block and 0 for a default state is what the DataID is and nothing else there is.

**Two wrong checks, recorded as they were.** The first run came back 33 PASS / 2 FAIL on both
builds and both failures were the probe's expectations, not the code: `give @a diamond_sword 1 5`
prints `@0`, and `give @a stone 1 1` gives `Granite(-590)@0`. 1.26's `give` resolves a legacy data
value into a block or item of its own and leaves `aux_` at 0, so "the aux I asked for" is not a
thing the console can assert. The check is now "`getAuxValue()` is the aux BDS itself prints", and a
**potion** is the item that still carries a non-zero one (`give @a potion 1 22` -> `@22`). The same
run is why `blkdata` exists: `blockaux` passing with 0 == 0 does not distinguish +288 from any other
zero word in a Block.

### Still open in this family

`?getDamageValue@ItemStackBase@@QEBAFXZ` is done -- see section 16.

- `swapSlots`, `getSlotWithItem`, `selectSlot`, `dropAllOnDeath` and
  `?removeResource@FillingContainer@@`. 2024's `swapSlots` and `getSlotWithItem` tail-jump
  FillingContainer members that are **not named in either 1.26 table** (slots 44 and 45 on
  1.26.40.8 are `0x1f3e5d0` and `0x1f3e8e0` and nothing names them); Endstone's header order says
  they are `removeResource` and `swapSlots`, but that is filling a slot by position, which this
  project does not do. `selectSlot` and `dropAllOnDeath` have bodies of their own.

## 12. The last four PlayerInventory names, and the two 1.26 turned into virtuals (next-steps Q1-B-3)

Section 11 left five: `swapSlots`, `getSlotWithItem`, `selectSlot`, `dropAllOnDeath` and
`?removeResource@FillingContainer@@`. Four of them are done; the fifth has no address on
1.26.51.1 and the reason is worth writing down.

### `removeResource` and `swapSlots` became virtual

The queue's note was that "1.26's two tables have no name at slot 44/45 (40: `0x1f3e5d0`,
`0x1f3e8e0`), and Endstone's header order says `removeResource`/`swapSlots`, but that is filling a
slot by position". It is, so the bodies decided it instead, and they are unambiguous.

2024's `??_7FillingContainer@@6B@` (`0x2c34448`) is **46 slots**: 40 of Container plus six of its
own (41 `add`, 42 `canAdd`, 43 `clearSlot`, 44 `clearInventory`, 45 `load`). 1.26's is 53 on
1.26.40.8 and 52 on 1.26.51.1 -- 44/43 of Container (sections 2 and 3) plus **nine** of its own,
exactly the nine Endstone's `filling_container.h` declares: `removeResource`, `swapSlots`, `add`,
`canAdd`, `clearSlot`, `clearInventory`, `saveToTag`, `loadFromTag`, `_trySetInSlot`. Four of those
nine were already named in our tables at the right places (`add`, `canAdd`, `clearSlot`,
`clearInventory` at 46/47/48/49 on 40 and 45/46/47/48 on 51), which anchors the two in front of
them -- but the anchors are not the argument.

**`removeResource`, 40 `0x1f3e5d0` (610 B) / 51 `0x253ad50`.** 2024's
`?removeResource@FillingContainer@@QEAAHAEBVItemStack@@_N1H@Z` (`0x19485c0`) takes
`(const ItemStack&, bool, bool, int)`, and so does this: `r8b` and `r9b` are stored as bytes and
the fifth argument comes off the stack as an int -- 1.26 `movl 192(%rbp),%eax` with
`rbp = rsp+128` after eight pushes and `sub $216`, which is `[entry rsp + 40]`, the same slot
2024 reads as `movl 352(%rsp),%r15d`. Then both do the same thing with it:

```
2024   cmpl $1, %r15d ; jge ; movzbl 34(%rdx), %r15d          # maxCount < 1 -> item.count_
1.26   movl 192(%rbp), %eax ; testl %eax, %eax
       movzbl 34(%rdx), %esi ; cmovgl %eax, %esi
```

No other member of this family reads two bools and a stack int.

**`swapSlots`, 40 `0x1f3e8e0` (293 B) / 51 `0x253b060`.** `(int, int)` in `edx` and `r8d`, and the
first thing it does is index `items_` twice:

```
1.26   movq 408(%rcx), %r12 ; movslq %r8d, %rax ; imulq $152, %rax, %rdi ; addq %r12, %rdi
                              movslq %edx, %rax ; imulq $152, %rax, %r13
2024   movq 352(%rcx), %rax ; movslq %r8d, %rcx ; leaq (%rcx,%rcx,4), %rdi ; shlq $5, %rdi
```

`items_` at +352 -> **+408** and the element stride 160 -> **152** are the two numbers sections 1
and 2 already established for this class, so the body confirms the name and the name confirms the
body. The two 1.26 builds open identically.

Both ship under a `U` decoration -- `?removeResource@FillingContainer@@UEAAHAEBVItemStack@@_N1H@Z`,
`?swapSlots@FillingContainer@@UEAAXHH@Z` -- because that is what the 1.26 declaration mangles to,
and bdsx reaches them with `procHacker.jsv("??_7FillingContainer@@6B@", ...)`: by name out of the
table, never by slot number.

### `getSlotWithItem` is still out of line, and its first twenty instructions name five offsets

`?getSlotWithItem@FillingContainer@@QEBAHAEBVItemStack@@_N1@Z` is non-virtual in 2024
(`0x1944f80`, 452 B) and Endstone does not declare it, so it is non-virtual in 1.26 too. It was
found by scanning `.pdata` for a function that reads `FillingContainer::player_` -- +376 in 2024,
**+432** in 1.26 (`items_` 408 plus the 24-byte vector) -- and calls through Container vftable
slots 7 and 20. Three functions on each build read +432; only one has 2024's shape:

```
40 0x1f3de20 / 51 0x253a5a0   (1436 B, first 40 bytes identical on the two builds)
  movl %r9d,%r14d ; movl %r8d,%ebp ; movq %rdx,%rdi        # checkData, checkAux, the item
  movq 432(%rcx), %rax          # FillingContainer::player_
  movq 1464(%rax), %rax         # Player::inventory_          (section 7)
  movl 16(%rax), %esi           # PlayerInventory::selected_  (= Player::getSelectedItemSlot, inlined)
  movq (%rbx),%rax ; movq 56(%rax),%rax ; callq *           # Container vft[7] getItem(selected)
  cmpb $1, 35(%rax)             # valid_
  movq 8(%rax), %rcx ; cmpq $0,(%rcx)                       # item_ and the WeakPtr behind it
  callq 0x1bc2260               # ?isNull@ItemStackBase@@ -- the address the table already carries
  cmpb $0, 34(%r15)             # count_
  movzwl 170(%rdx), %edx        # Item::id_  (+162 -> +170, confirmed by execution 2026-09-21)
```

Every offset in that listing is one this project confirmed separately and for another reason,
which is what makes the identification cheap. Two more routes agree: `work/derived40to51/pairs.json`
pairs `0x1f3de20` with `0x253a5a0` on its own, and the **call edge carries** -- in 2024 the only
caller of `getSlotWithItem` is `removeResource`, and on both 1.26 builds the removeResource slot
above calls exactly this function (alongside `?releaseUsing@RangedWeaponItem@@` and
`?releaseUsing@CrossbowItem@@`, the two that look up which arrow to fire).

### `selectSlot` is a bound check and two stores

2024's `?selectSlot@PlayerInventory@@QEAA_NHW4ContainerID@@@Z` (`0x1878380`) calls
`?getHotbarSize@FillingContainer@@` (`0xa27d60`, `movl $9,%eax; retq`) on `inventory_`, returns
false on `slot >= 9` and on `slot < 0`, and otherwise writes `selected_` (+16) and
`selected_container_id_` (2024 +184, 1.26 +176) and returns true. That is the whole function, and
1.26 keeps no out-of-line copy, so it ships as `derived()` over `layouts.PlayerInventory`.
Endstone's `player_inventory.h` declares the same thing, including the private
`static bool isHotbarSlot(int)`.

bdsx's declared return type stays `void`; the mangled name says `_N` and the 2024 body does return
a bool, but no call site in bdsx reads it.

### `dropAllOnDeath`: done as `derived()`, and the item-loss trap it walked into (2026-09-23)

The two addresses recorded below are exactly what the earlier pass here found and are **not
shipped** -- 1.26.40.8 has both out of line, 1.26.51.1 has neither (inlined into `Player::die`),
and a name resolved on one build and never executed is the `Mob::_hurt` shape this project does not
ship. Instead all three names -- `?dropAllOnDeath@PlayerInventory@@`, `?dropSlot@Inventory@@` and
`ItemLockHelper::shouldKeepOnDeath` (not a required symbol, needed only as this file's own gate) --
are `derived()`, built from the two out-of-line 1.26.40.8 bodies and the 1.26.51.1 inlined copy
read to the end, and confirmed against both.

On 1.26.40.8, `dropAllOnDeath` (`0x1247850`, 320 B) is the body 2024 has (`0x186a0b0`): read
`inventory_` at **+184**, `vft[20]` for the size, loop `vft[7]` for each slot, skip on `valid_`,
`item_`, the WeakPtr, `?isNull@ItemStackBase@@` and `count_`, then -- inlined directly into this
function rather than calling out to a `shouldKeepOnDeath` of its own -- skip anything whose
userData (`+0x10`) contains a `"minecraft:keep_on_death"` tag (23 bytes, NUL-padded, found once in
the image at `0xa650b20`) with a non-zero byte value. What survives that goes to
`?dropSlot@Inventory@@QEAAXH_N00@Z` (`0x207ba0`, 546 B), its only caller being this function, same
as in 2024. On 1.26.51.1 neither function exists out of line; `Player::die` (`0x2adbb0`, 2454 B
against 40's 1743) writes the identical loop, the identical two-call `"minecraft:keep_on_death"`
lookup (`?contains@CompoundTag@@`, a second call whose result's `+8` -- `ByteTag::data`, the same
field `getDamageValue` above reads -- is tested for non-zero) and the identical drop out in full.

**The item-entity spawn is not `FillingContainer::_doDrop` any more -- it is a direct call through
the item's owner's own `Player::drop`.** 2024's `dropSlot` builds a temporary `ItemStack` and hands
it to `?_doDrop@FillingContainer@@IEAAXAEAVItemStack@@_N@Z` (`0x19351d0`, `void`, cannot report
failure). Neither 1.26 build calls anything named `_doDrop`; both read `FillingContainer::player_`
(`+432` on both builds -- confirmed by re-reading it directly out of two independent, executed
bodies: 40's own `dropSlot` at `0x207ba0` and 51's inlined copy inside `Player::die`, which reads it
**twice**, once for the held UI item and once inside the per-slot loop) and call straight through
that `Player*`'s own vftable at the slot holding `?drop@Player@@UEAA_NAEBVItemStack@@_N@Z` -- slot
**116** on 1.26.40.8, slot **115** on 1.26.51.1 (confirmed by reading the pointer directly out of
each build's `??_7Player@@6B@` table and comparing to the resolved `?drop@Player@@` address; the
index moves, which is why this is read by name and not by slot, same as
`FillingContainer::removeResource`/`swapSlots` in section 12 above). `?drop@Player@@` is already a
required symbol with an unchanged prototype (`docs/findings-slots.md`, "Changed signatures" end,
2026-09-22) and is already hooked lazily for `events.playerDropItem`
(`bdsx/event_impl/entityevent.ts`); calling it again here from `implements.ts` resolves the same
address, not a second hook, and goes through whatever that lazy hook may have installed.

**`Player::drop` can refuse, and neither binary checks that before destroying the item -- bdsx does.**
Both builds' native bodies call the vftable slot and then fall straight into the temporary item's
destructor without ever testing `AL` (2024's `_doDrop` cannot even report failure, being `void`);
whatever `Player::drop` decided, the slot gets cleared or reduced regardless. Reading its own body
(2024's `0x19dc9f0`, unchanged on both 1.26 builds by the "Changed signatures" entry above) shows
why that is normally safe to ignore: it opens `if (!hasDimension()) return false;`, and unless the
caller is already dead (`getHealth() <= 0`), it also requires
`LayeredAbilities::getBool(AbilitiesIndex 2)` to be true. For a real, fully-joined client that bit
is true and the death path always has `health <= 0`, so the native "don't bother checking" is almost
always correct -- almost, because this project's own headless probe bot is neither: it never sends
whatever marks a client fully loaded, and **every** Abilities bit reads false for it before its
first respawn (the exact loading-screen-layer state already blocking `playerAttack`/`attackMobs`,
`docs/findings-slots.md`). The first version of this `derived()` matched the binaries exactly --
call `Player::drop`, then unconditionally clear the slot -- and on this bot it silently destroyed
the apples and the sword it was given, with `Player::drop` returning `false` on both builds and
nothing landing on the ground (`work/host-runs/q2dropall40-20260923-030537.txt`, `q2dropall51-...`,
`[bdsx] Inventory::dropSlot: Player::drop returned false for slot 0/1 (item lost, not dropped)`).
`doDropSlot` (the function shared by `dropSlot` and `dropAllOnDeath`) now checks the return value
and leaves a refused slot untouched instead -- a place this project's own `derived()` is safer than
either binary, not a mistranslation of one.

### What execution showed for `dropAllOnDeath`

New `tools/entity-sig-probe.ts` steps (`SIG_EVENTS=dropall`, console `sigprobe dropall`) and drivers
`tools/host/drivers/q2dropall40/51.ps1`. Both builds **`tsc exit: 0`, `exit code: 0`, `Quit
correctly`, no crash, no `Symbol not found` for either new name**
(`work/host-runs/q2dropall40-20260923-031820.txt`, `q2dropall51-20260923-031820.txt`).

| what | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| `dropAllOnDeath` runs without throwing, on `give @a apple 5` + `diamond_sword 1` | yes | yes |
| the ability diagnostic (`getAbilities().getBool(...)`) | `health=20 ability[Build]=false ability[DoorsAndSwitches]=false ability[OpenContainers]=false` | identical |
| `Player::drop` on this bot | refused both slots (logged) | refused both slots (logged) |
| after the refused call, the inventory | **unchanged** -- apples and sword still there | **unchanged** |
| BDS's own `testfor @e[type=item]` near the player, right after | `No targets matched selector` | `No targets matched selector` |
| a real `kill @a` on the same, still-full inventory (BDS's own `Player::die`, completely unaffected by this change) | `Found Apple, Diamond Sword` | `Found Apple, Diamond Sword` |

The last row is the corroborating route this project's own rule asks for before calling a gated
call "done": it is not a test of this `derived()` (BDS's native death path calls its own,
unmodified code), but it independently exercises the exact same `Player::drop` / ability-or-dead
gate this section's reading found, on the exact same bot, and gets the exact items back as
entities -- which is what "the gate is real and the reading of it is right" looks like from the
outside, without needing a bot that can satisfy it itself.

**What was not achieved, and why it is not this session's bug**: bdsx's own `dropAllOnDeath` call
succeeding on a live player and BDS's `testfor` confirming the resulting entity. That needs either a
real client (Q7 -- a joined, fully-initialized player has the ability bit) or a way to call this
project's own code at the point in `Player::die` where `health` is already `0` but the native drop
has not yet run (which would require hooking into the middle of that function, not attempted here).
Both are next steps, not defects in what shipped: the implementation is byte-for-byte what both
binaries do for the parts that do not depend on the caller's own state, and is strictly safer than
either binary for the one part that does.

### What execution showed

`tools/item-probe.ts` grew `pinvslots`, `pinvsel` and `pinvremove`; the drivers are
`tools/host/drivers/item40.ps1` and `item51.ps1` (`-BotSecs 510`). The setup is BDS's:
`clear @a`, `give @a diamond_sword 1` (slot 0, the selected one), `give @a apple 3` (slot 1), and
an item in the offhand that the inventory container does **not** hold.

| step | what it shows | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `pinvslots-selected` | `getSlotWithItem(sword)` answers 0 through the selected-slot fast path | PASS | PASS |
| `pinvslots-scan` | `getSlotWithItem(apple)` answers 1 through the scan | PASS | PASS |
| `pinvslots-absent` | an emerald held in the offhand answers **-1** | PASS | PASS |
| `pinvslots-swap` | `swapSlots(0,1)` exchanges the sword and the three apples | PASS | PASS |
| `pinvslots-follow` | `getSlotWithItem` follows the swap (0 and 1 exchange) | PASS | PASS |
| `pinvslots-swapback` | swapping back restores both slots and the count | PASS | PASS |
| `pinvsel` | `selectSlot(1)` moves `selected_` from 0 to 1 | PASS | PASS |
| `pinvsel-bds` | **BDS's own `Player::getSelectedItem` returns the apples** | PASS | PASS |
| `pinvsel-bounds` | `selectSlot(9)` and `selectSlot(-1)` are refused | PASS | PASS |
| `pinvsel-back` | `selectSlot(0)` and BDS reads the sword again | PASS | PASS |
| `pinvremove` | `removeResource(template, true, false, 2)` takes exactly two of three | PASS | PASS |

**Both builds, 51 of 51 PASS, `tsc exit: 0`, `exit code: 0` and `Quit correctly`**
(`work/host-runs/item40-20260921-161304.txt`, `item51-20260921-161304.txt`).

The check that cannot be faked is `pinvsel-bds`: bdsx writes one int at `PlayerInventory+16` and
BDS's own `Player::getSelectedItem` -- a different function, resolved by a different route -- reads
the other item back. The `-1` in `pinvslots-absent` matters for the opposite reason: a wrong
address that merely returns something would have to return -1 for an item the container does not
hold and the right slot for two that it does, in the same session.

## 13. The player UI container, the ender chest and the device id (next-steps Q1-0 B-next)

2026-09-22. Three required names -- `?getPlayerUIItem@Player@@`, `?setPlayerUIItem@Player@@`,
`?setCursorSelectedItem@Player@@` -- and the three members bdsx declares on `Player`
(`Player.abstract({ enderChestContainer: 0xc60, playerUIContainer: 0xd18, deviceId: 0x1d80 })`),
which were still the 2024 offsets. **All six run on both builds.**

### The 2024 bodies

| name | 2024 | what it is |
|---|---|---|
| `getPlayerUIItem` | `0x19df800` | `addq $0xd18,%rcx; movq (%rcx),%rax; movq 56(%rax),%rax; jmp` -- the container at +3352, vft slot 7 (`getItem`) |
| `setCursorSelectedItem` | `0x19e86a0` | `movq %rdx,%r8; xorl %edx,%edx; jmp setPlayerUIItem` |
| `setPlayerUIItem` | `0x19e8dd0` | read the old item (slot 7), compare with the new one; if they differ build an `InventoryAction` with source `{0, ContainerID 124, 0}` and the slot, `InventoryTransactionManager::addAction(action, false)` on +3736; then the container's vft slot 12 (`setItem`) |

1.26 kept **no copy of the first two**. The third survives -- see below.

### The members: three routes each

**`playerUIContainer` +2232** (2024 +3352 = 0xd18), the embedded `PlayerUIContainer`:

1. `?readAdditionalSaveData@Player@@` (40 `0x220480` / 51 `0x2af220`) looks up `"PlayerUIItems"`
   (the only reference to that string in either image) and calls `PlayerUIContainer::load` with
   `addq $2232,%rcx` where 2024 has `leaq 3352(%r14)`; it then reads **+2648 / +2656** -- the
   container's `items_` begin/end, 2232 + the +416 that `?getItem@SimpleContainer@@` itself uses
   -- and the item count by `imull $0x286BCA1B` (divide by 152).
2. A function that switches on `ContainerID` (40 `0x263c140` / 51 `0x2af43e0`, 1619B both) takes
   `leaq 2232(%rsi)` for **124 (PlayerUIItems)** and walks +2648 for `cmpl $54` slots.
3. Endstone `player.h`, counted between confirmed neighbours: `ender_chest_inventory_` (below) +
   `tracked_boss_ids_` (24) puts `cursor_selected_item_group_` at +2096 (an `ItemInstance` of 128 and
   a count; 2024's `setCursorSelectedItem` path wrote +3208 / +3344, the same 136-byte gap);
   `player_ui_container_` follows at **+2232**, 440 bytes, then `transaction_manager_` at **+2672**
   -- which is where 1.26's `setPlayerUIItem` hands its `InventoryAction` and what the Player
   constructor takes `leaq 2672` of. (Endstone's `// +2648` comment on `transaction_manager_` is
   stale: 2648 is the UI container's `items_`.)

**`enderChestContainer` +2064** (2024 +3168 = 0xc60), a `unique_ptr<EnderChestContainer>`: the same
`readAdditionalSaveData` loads `movq 2064(%rcx)` right after looking up `"EnderChestInventory"`
where 2024 loads `movq 3168(%r14)`, and `?addAdditionalSaveData@Player@@` (40 `0x2239d0` / 51
`0x2b2d30`) reads the same member. Endstone's order puts it 8 + 24 bytes below +2096.

**`deviceId` +3208** (2024 +7552 = 0x1d80), a `std::string`: the Player constructor
(40 `0x20be00` / 51 `0x299800`) initialises, in 2024's order, `name_` +3008, the three
`optional<string>` (their engaged bytes `movb $0` at +3072 / +3112 / +3152), `last_emote_played_`
+3160, a `time_t` +3192 (`movq $0`), an int +3200 (`movl $0`), then clears **+3208** and reads the
device-id argument string (`movq 16(%r15)` / `cmpq $16, 24(%r15)`). 2024's constructor does
+7472 ... +7536 / +7544 / +7552 the same way, and Endstone declares `device_id_` right there.
The two 1.26 builds are identical here.

All three ship as `layouts.Player.{enderChestContainer, playerUIContainer, deviceId}`
(`data/candidates-instances-<v>.json` `offsets`) and `Player.abstract` reads them, the 2024 literals
as fallbacks.

### `setPlayerUIItem` kept its body and gained an argument

2024's `Player::die` (`0x19dc490`) reads the cursor slot, drops it unless `ItemLockHelper` keeps it
(Player vft +984) and calls `setPlayerUIItem(this, 0, ItemStack::EMPTY_ITEM)`. 1.26's
`Player::die` (40 `0x21f220` / 51 `0x2adbb0`) inlines the read (`movq 2648(%rsi)`), makes the same
keep test and the drop (vft +928), and then calls **40 `0x223850` / 51 `0x2b2bb0`** (320B both)
with `edx 0`, `r8 = EMPTY_ITEM` -- and **`r9d 0`**. That function is 2024's body step for step:
the inlined `getItem` (+2648, stride 152, `EMPTY_ITEM` out of range), the inlined `ItemStack ==`,
the `InventoryAction` with `movb $124`, the manager at `leaq 2672`, and last a **direct** call to
the container's setItem -- **40 `0xdcc5e0` / 51 `0xd12e40`**, which is exactly what slot 12 of
`??_7SimpleContainer@@6B@` holds on each build. Two routes to that address, then: the table slot
and the devirtualised call. Its callers include `?_onItemChanged@PlayerUIContainerModelBase@@` and
`?clearVanishEnchantedItemsOnDeath@ServerPlayer@@`.

The new fourth argument (kept in `r14d`) goes straight on as the third argument of the `addAction`
call, where 2024 passed a constant `xorl %r8d,%r8d`. So the address ships under
**`bdsx:Player::setPlayerUIItem`** -- the argument's name, and so the decoration, is not knowable
-- and bdsx passes 0, as 2024 and `Player::die` do. `?setItem@SimpleContainer@@UEAAXHAEBVItemStack@@@Z`
ships as well: without the `bdsx:` address, bdsx's `setPlayerUIItem` falls back to calling it
through `procHacker.jsv` by name, which does the write and skips the recorded action. That fallback
has not been executed -- both builds resolve the `bdsx:` key.

### What execution showed

`tools/item-probe.ts`, new steps `ui|uiender|uiset|uidead|device <id>`; drivers `ui40/51.ps1`; the bot
learned `BP_DEVICE_ID` (bedrock-protocol spreads `skinData` over the chain after writing its own
random `DeviceId`, so the override rides there).

| step | what it checks | 40 | 51 |
|---|---|---|---|
| `ui-vft` | `Player+2232`'s vptr is `??_7SimpleContainer@@6B@` | PASS | PASS |
| `ui-ender-vft` | `*(Player+2064)`'s vptr is `??_7EnderChestContainer@@6B@` | PASS | PASS |
| `ui-empty` | the cursor slot is empty at join and is the container's slot 0 | PASS | PASS |
| `uiender` | after `replaceitem ... slot.enderchest 0 diamond 5`, **BDS wrote, bdsx reads** `5 x Diamond` in slot 0, slot 1 empty | PASS | PASS |
| `device` | `deviceId` is `"bdsx-probe-device-7f3a"`, the string the bot's login chain carried | PASS | PASS |
| `uiset-setup` | the console's three apples are in inventory slot 0 | PASS | PASS |
| `uiset` | `setCursorSelectedItem(apples)` through **BDS's `setPlayerUIItem`**; the cursor holds `3 x Apple` read by `getPlayerUIItem` and the container's own `getItem` at the same address | PASS | PASS |
| `uiset-inv` | the inventory slot is emptied (`clearSlot`), so the cursor is the only apple on the player | PASS | PASS |
| `uiset-other` | slot 1 (`AnvilInput`) untouched | PASS | PASS |
| (console) | `kill @e[type=item]`, `testfor @e[type=item]` -> `No targets matched selector` | yes | yes |
| (console) | `kill @a`, `testfor @e[type=item]` -> **`Found Apple`** | yes | yes |
| `uidead` | after the death the cursor slot is empty | PASS | PASS |

**Both builds 10/10 probe PASS plus the two console checks, `tsc exit: 0`, `exit code: 0`, `Quit correctly`**
(`work/host-runs/ui40-20260922-011529.txt`, `ui51-20260922-011821.txt`).

The check that cannot be faked is the last three rows: the apple exists nowhere on the player but in
the slot bdsx wrote, and **BDS's own `Player::die`** -- which reaches the slot through `+2648`, not
through anything bdsx computed -- found it, dropped it into the world and cleared the slot.

**One failed session, not explained:** the first 1.26.51.1 run (`ui51-20260922-011528`) died
`0xC0000005` at `gameThreadEntry +0x17` reading address `0x3f800000` (a float 1.0 as a pointer),
right after the bot connected and **before any probe line** -- nothing this change adds runs there.
The rerun with the same code (`--no-sync`) was clean. The `.err` is kept as
`work/host-runs/ui51-20260922-011528.err` (next-steps Q8).

Not checked: `InventoryTransactionManager::addAction`'s effect (whether a transaction was open and
recorded the action) -- the address is confirmed by two routes and by execution, the argument by
what 2024 and `Player::die` pass.

## 14. The player list: an entry that moved its skin out, and a packet whose element became a variant (next-steps Q1-0 B-follow)

bdsx's public `Player.setName()` renamed the player and then threw, because `updatePlayerList` needs
`??0PlayerListEntry@@QEAA@AEBVPlayer@@@Z`, `?emplace@PlayerListPacket@@` and `??1PlayerListEntry@@`,
none of which either table had. It turned out to need a fourth thing first: `serverInstance.getPlayers()`,
which `updatePlayerList` loops over, was broken on both builds for a different missing name
(`ServerPlayer::tryGetFromEntity`; `docs/findings-components.md`, "`tryGetFromEntity`"). **Two
addresses, three layouts, four `derived()`**, and both builds are 20/20 with the bot decoding the result.

**The constructor is an address** (40 `0x1248e60` 1515B / 51 `0x2d3e30` 1327B). Of every function in
each image, it and the AddActor-packet builder are the only two that read both Player+3008 (`name_`) and
Player+1164 (the platform), and the other one is `tryCreateAddActorPacket`'s callee. The body is 2024's
(`0x1862ee0`) step for step, and its only caller (40 `0x2e27020` / 51 `0x8664c0`, 2250 bytes, identical
apart from rip-relative constants) does what 2024's only caller `?_onGameplayUserAdded@ServerLevel@@`
did: build the entry, put it in the player-list map, build a PlayerListPacket, broadcast it.

1.26's entry, the same on both builds, 168 bytes:

| field | 2024 | 1.26 | from |
|---|---|---|---|
| id | +0 | +0 | `getOrCreateUniqueID` |
| uuid | +8 | +8 | `UserEntityIdentifierComponent` (0x0b845379, element 592B, uuid +184) |
| name | +24 | +24 | Player+3008 |
| xuid | +56 | +56 | Player vft +1848 (sret) |
| platformOnlineId | +88 | +88 | Player+1560 |
| buildPlatform | +120 | +120 | Player+1164 |
| skin | +128, `SerializedSkin` by value | +128, **`shared_ptr`** (control +136) | the SerializedSkinRef at Player+2736 |
| color | -- | +144 (16B) | a table indexed by synched entry 27 |
| isTeacher / isHost / isSubClient | +736/737/738 | +160/161/162 | Player vft +1784 / Player+3242 / the uuid component |

The destructor (40 `0x12498c0` / 51 `0x2d4630`, 338B) is the other address: it releases +136 and frees
the strings at +88/+56/+24, and the add path calls it on its stack entry. bdsx's `PlayerListEntry.skin`
property now follows the pointer when `layouts.PlayerListEntry.skin` exists.

**`emplace` has nothing to call.** The packet is still 80 bytes with the vector at +48, but its elements
are no longer `PlayerListEntry`:

- the deleting destructor (40 `0xb04370` / 51 `0x86c920`) walks the vector with `addq $184` and skips
  an element when `movsbq 176; incq; cmpq $2; jb` -- a `std::variant` index of -1 or 0 -- otherwise
  calling 40 `0x1f53390` / 51 `0x332bd50`, which frees strings at +32/+64/+96 and a control block at +144;
- the remove path (40 `0x2e279f0` / 51 `0x866e90`) pushes `{byte 1 at +0, uuid at +8}` with index 0;
- the add path pushes, member by member from the entry, `{byte 0 at +0, uuid +8, id +24, name +32,
  xuid +64, platformOnlineId +96, buildPlatform +128, skin +136/+144, isTeacher/isHost/isSubClient
  +152/+153/+154, color +156}` with index 1.

2024's per-packet `action` byte at +72 moved into each element (byte +0: 0 add, 1 remove), and +72 now
holds a constant **5** that every constructor in both images writes -- the factory's `make_shared`
(40 `0xc053c0`) included, so `PlayerListPacket.allocate()` already has it. bdsx's `emplace` is a
`derived()` that grows the vector with `msAlloc` when full and writes alternative 1 with the same moves
the add path makes (`layouts.PlayerListEntry`, `PlayerListPacket`, `PlayerListPacketAddEntry`).

**Executed** (`fieldprobe entityctx|playerlist`, drivers `pl40/51.ps1`, `work/host-runs/pl40-20260922-091840.txt`,
`pl51-...`, bot logs `...bot.log`): **20/20 PASS on both builds, tsc 0, exit 0, `Quit correctly`.** BDS's
constructor leaves the bot's name, platform 12, ActorUniqueID and the very `getSkin()` pointer where the
table says; `updatePlayerList()` and public `setName()` return. The witness is the bot
(`tools/probe-client.cjs` now logs `player_list`): each packet bdsx sends decodes exactly like the one BDS
itself sends at join -- same uuid, entity id, platform, colour `-303174145`, flags -- and the one sent by
`setName("bdsxlisted")` carries `"username":"bdsxlisted"`.

What this does not cover: the default and UUID constructors (`??0PlayerListEntry@@QEAA@XZ`,
`??0PlayerListEntry@@QEAA@VUUID@mce@@@Z`, bdsx's `ctor` / `ctor_copy`) are still unresolved, and bdsx's
`PlayerListPacket` class still declares `entries: CxxVector<PlayerListEntry>` and `action` at +72, which is
wrong on 1.26 for anyone reading a packet's fields. `mce.UUID.toString` prints the uuid in a different byte
order from the client (`b4822426-d0cc-34e9-...` against `e934ccd0-2624-82b4-...`); that is bdsx's
formatting, unchanged from 2024, and the bytes on the wire match BDS's own packet.

### The two constructors (2026-09-24)

1.26 has neither the default nor the UUID constructor: every entry comes from the Player constructor or is assembled
member by member. Both are now `derived()` (`bdsx/bds/engine/playerlist.ts`). They write 2024's UUID-constructor
defaults into the 168-byte entry:
- id -1, the uuid, three empty SSO strings, platform -1
- a null skin `shared_ptr`, zero colour, false bools

The shipped 1.26 destructor frees exactly that. **Executed** (`ple40`/`ple51`, `pleprobe`, twice per session): a default
entry has those defaults and takes heap-sized strings. A copy of an entry built from the player carries the player's
uuid. The destructor runs on all three, and the second pass is clean. The `PlayerListPacket` field declarations
(`entries`, `action`) are still 2024's.

### `PlayerListPacket`'s fields (2026-09-24)

bdsx's `entries: CxxVector<PlayerListEntry>` and per-packet `action` are 2024's layout. On 1.26 they read garbage. They
are now getters that throw with guidance, so no 2024 layout is emulated. `getEntries()` decodes the 1.26 records
instead (`engine/playerlist.ts`, over `layouts.PlayerListPacket` / `PlayerListPacketAddEntry`): each add or remove,
with the uuid, and for an add the id, name, xuid, platform online id, build platform, flags and colour.

**Executed** (`plist40`/`plist51`, `plprobe`, a `packetSend` listener): the packet the server sends the joining bot
decodes to `add bdsxprobe <uuid> platform 12`, where the uuid is the player's own (its `PlayerListEntry`). `.entries`
throws. A simulated player's add is broadcast through `sendToClients`, which bdsx did not hook on 1.26, so it never
reached `packetSend`. Fixed 2026-09-24 (`findings-packets.md` "packetSend for recipient-list broadcasts"): the add is
now seen, and it can be cancelled.

## 15. `Player::setSelectedSlot`, and the `selectSlot` 1.26 kept after all (next-steps Q1-0 C-1)

`?setSelectedSlot@Player@@QEAAAEBVItemStack@@H@Z` is an address: **40 `0x2338d0` / 51 `0x2beae0`**, 566B on both
and the same instruction sequence modulo addresses. Found from the other end: it is one of the 27 functions on each
build that store `??_7MobEquipmentPacket@@6B@` (`tools/ctor-from-vftable.mjs`), and the only one of those with 2024's
caller count (five -- four `SimulatedPlayer::simulate*` functions and `ScriptPlayer::setSelectedSlot`).

The body is 2024's (`0x19e91f0`, 262B) step for step, with three things inlined or moved:

- `isClientSide` is inline: `Actor+0x1d8` (the Level) then its `vft+0x9e8`; on the client side, or when
  `selectSlot` refuses the slot, it returns `&EMPTY_ITEM` (40 `0xc93ba48` / 51 `0xccb2ee0`, the table's symbol).
- `PlayerInventory::selectSlot(slot, ContainerID 0)` on `Player+1464` (the confirmed `inventory_`) is a **direct
  call to an out-of-line copy**: 40 `0x1247bc0` / 51 `0x2b2770`, 795B. Section 12 said 1.26 had inlined it
  everywhere; it had not. The copy opens with 2024's whole body -- `cmpl $8,%edx; ja` (the hotbar bound), the two
  stores to `+16` and `+176`, `slot < 9` as the result -- and then does what 2024's did not: when the slot actually
  changed, containerId is 0 and the Level is not client-side, it copies the newly selected item, builds a gameplay
  event (variant index 0x23) and hands it to the Level's event coordinator (`Level vft+0x728`). Five callers on each
  build, as 2024 has five: `setSelectedSlot`, `Player::readAdditionalSaveData` (11849B / 11920B) and three unnamed.
  The name ships as an address now and the `derived()` body of section 12 is the fallback.
- The item is `[inventory_+184]->vft[7](slot)` (the confirmed container, `Container::getItem`), the runtime id is
  `?getRuntimeID@Actor@@` (in the table), and the packet is built in two calls where 2024 had one: a payload
  constructor (40 `0x2ac6350` / 51 `0x2d8b4e0`: `NetworkItemStackDescriptor(item)` copied to +8, then slot,
  selectedSlot, containerId at +0x68/+0x6c/+0x70) and a packet-from-payload constructor (40 `0x2ac1670` /
  51 `0x2d86b80`, 468B, 26 / 29 callers -- the function that stores the vftable). So 2024's
  `??0MobEquipmentPacket@@QEAA@VActorRuntimeID@@AEBVItemStack@@HHW4ContainerID@@@Z` has no 1.26 counterpart with
  that signature; bdsx does not require it. `sizeof` is still 0xa8 (2024's memset).
- `Dimension::sendPacketForEntity(actor, packet, nullptr)` became **virtual**: `Dimension vft[4]` on the
  `WeakRef<Dimension>` locked at `Actor+456/+464` (the same pair `isInWorld` reads). Not required by bdsx either.

The prototype is unchanged (rcx this, edx slot; returns `ItemStack const&`), so bdsx's declaration stands.

**Executed** (`fieldprobe selslot <n>`, drivers `eat40/51.ps1`, `work/host-runs/eat40-20260922-150221.txt`, `eat51-...`, bot logs
`...bot.log`): **16/16 PASS on both builds (with the six `eating` checks), tsc 0, exit 0, `Quit correctly`.**
The console puts an apple in hotbar 3 and an emerald in hotbar 5; after bdsx calls `setSelectedSlot(3)`,
`PlayerInventory+16` reads 3, the returned pointer is the container's own `getItem(3)` (the apple), and **BDS's own
`Player::getSelectedItem`** returns that same pointer; the same for 5 (emerald) and 0 (air); slot 20 is refused
(`selected_` unchanged, `EMPTY_ITEM` returned). The witness for the packet is the bot (`tools/probe-client.cjs` now
logs `mob_equipment`): at the moments of the three calls it decodes a `MobEquipmentPacket` for **its own runtime id
1** with `slot 3 / selected_slot 3` and item 878 (40) / 882 (51) = the apple, then `5 / 5` and 523 = the emerald, then
`0 / 0`. Regression for the address replacing the derived `selectSlot`: `item40/51` 51/51 PASS on both
(`work/host-runs/item40-20260922-150624.txt`, `item51-...`).

One probe round was lost to `ItemStack.getName()`, which calls the unresolved `?getCommandNames@Item@@` for any
non-air item; `toString()` is what the probes should print.

## 16. `ItemStackBase::getDamageValue` -- the last read in this family, and no address for it either (next-steps Q1-B-2)

`?getDamageValue@ItemStackBase@@QEBAFXZ` and the function it tail-called in 2024,
`?getDamageValue@Item@@QEBAFPEBVCompoundTag@@@Z` (`0x1cab820`), have no out-of-line copy on either
1.26 build -- neither `?contains@CompoundTag@@...` nor `?getInt@CompoundTag@@...` (the two functions
that inner call needed) is resolved either, and none of the three are required by bdsx directly.
None of the three need an address.

### The 2024 body

`ItemStackBase::getDamageValue` (`0x1b5fa50`, ten bytes plus the tail jump) is the same `item_` (+8,
the double pointer that `getAuxValue`/`getId` already carry) null-check as its siblings, then
`jmp` into `Item::getDamageValue(CompoundTag const* userData)` -- the argument is `this+0x10`,
`ItemStackBase::userData`. The inner function (`0x1cab820`) never reads its own `this` at all: it is
purely

```
!userData ? 0
: userData->contains("Damage") ? userData->getInt("Damage")
: 0
```

(`TAG_DAMAGE`, the static string `"Damage"`, `movq %rdx, %rbx; testq %rdx, %rdx; je -> 0`, then
`CompoundTag::contains` and, if true, `CompoundTag::getInt`). `CompoundTag::getInt` itself
(`0x840080`) is `_Find` the key in the map at `this+8`, and if the node's variant discriminant byte
is `3` (`Tag::Type::Int`) read the `int32` at the variant's own `+8`; anything else, including "not
found", is 0.

### Why none of that needs a 1.26 address

Every step above is something bdsx already carries for its own reasons, unconnected to this name:

- `userData` is `CompoundTag.ref()` at ItemStackBase `+0x10` (`bds/inventory.ts`), a plain pointer
  field, no procHacker call involved.
- `CompoundTag.data` is a `CxxMap<CxxString, CompoundTagVariant>` nativeField (`bds/nbt.ts`), and
  `CxxMap.get(key)` (`cxxmap.ts`) is bdsx's own reimplementation of the red-black-tree walk
  `std::map::find` does -- it is not calling into BDS, it is walking the exact same memory BDS's own
  `_Find` would walk.
- `CompoundTagVariant.get()` returns a typed `Tag` subclass via `Tag.setResolver`, which is already
  vtable-based (`Tag.prototype.getId` is `?getId@CompoundTag@@` called through *whichever* tag's own
  vtable, `procHacker.jsv`) -- so asking "is this an `IntTag`" is a JS `instanceof` check on an
  object bdsx already constructed correctly, not a second native call.

So the whole function reduces to `bdsx/bds/implements.ts`:

```ts
ItemStackBase.prototype.getDamageValue = derived(
    "?getDamageValue@ItemStackBase@@QEBAFXZ",
    function getDamageValue(this: ItemStackBase): number {
        const self = this as unknown as StaticPointer;
        const weak = self.getNullablePointer(8);
        if (weak === null) return 0;
        const item = weak.getNullablePointer(0);
        if (item === null) return 0;
        const userData = self.getNullablePointerAs(CompoundTag, 0x10);
        if (userData === null) return 0;
        const variant = userData.data.get("Damage");
        if (variant === null) return 0;
        const tag = variant.get();
        return tag instanceof IntTag ? tag.data : 0;
    },
    () => procHacker.js("?getDamageValue@ItemStackBase@@QEBAFXZ", int16_t, { this: ItemStackBase }),
);
```

matching the exact style already sitting two names above it in the same file --
`ItemStackBase.prototype._getItem` (already `derived()`, same `getNullablePointer(8)` ->
`getNullablePointerAs(Item, 0)` double-dereference) -- and `getAuxValue`/`getId` immediately above
that. No new offset, no new layout: it composes four things this project had already confirmed.

### Executed, and what it took to get there

Two builds, `itemprobe damage pre|hit` (`tools/item-probe.ts`), drivers `item40/51.ps1`:
**53/53 PASS on both, tsc 0, exit 0, `Quit correctly`**
(`work/host-runs/item40-20260922-163624.txt`, `item51-...`). The console equips one unenchanted
iron chestplate on a zombie and hits it four times with `/damage ... entity_attack`; bdsx reads
`getDamageValue()` before (0) and after (4, both builds -- the same durability-loss arithmetic on
both). This is **BDS's own damage pipeline writing the NBT**, not anything bdsx sent: nothing here
calls `setDamageValue` (also unresolved on both builds) or touches `userData` directly.

Getting a clean run took four failed sessions first, and none of them were this code -- they are
recorded here because the failure shapes looked alarming enough that a future reader should not
re-diagnose them:

1. **Two connection-shaped failures**, `item40/51` full driver, before any of the new commands: the
   session got most of the way through the pre-existing 46-command suite (through `blockaux`, then
   through a later `aux` check on a second run) and then `session.mjs` reported "the driver never
   reported an exit code" / "exit code 1 and no `Quit correctly`". No crash marker, no
   `[ Fault Capture ]` block. Both runs died at a *different* point, always before the new code had
   executed at all.
2. **Two `exit -1` deaths right after join**, on a short driver built to isolate just the new
   `itemprobe damage` step: both builds died within seconds of the bot connecting, before the first
   scripted command even landed, again with no crash marker in `.err` or `.out` and no Windows
   `Application Error` event for `bedrock_server.exe` in that window. This is what first looked like
   it might be the new, always-installed `events.entityHurt` listener this file's first draft added
   (every session compiles every probe, so an unconditional hook is exactly the kind of risk this
   project's `FARM_PROBE=1` / `PLACE_PROBE=1` / `SIG_EVENTS` convention exists to avoid,
   `docs/next-steps.md` Q1-A). **The listener was removed on suspicion, and a clean run followed** --
   but a later, calmer read of the actual host output (fetched directly over ssh, not through
   `session.mjs`'s grep-filtered summary) showed the real story: the sessions had *not* died at join.
   They ran well into the new commands (`summon`, `effect`, one `replaceitem`) before stopping, and
   when the `itemprobe damage` steps did run they read `[item] FAIL damage: the captured mob wears
   nothing in its armour container` -- the zombie the driver just equipped was gone. Two separate
   bugs were sitting on top of each other:
   - **The bare console commands used relative coordinates and distance selectors with no anchor.**
     `"summon zombie ~3 ~ ~3"` and `@e[type=zombie,c=1]` run from a plain console line, not from
     `execute as @a at @s run ...`, resolve `~` and "closest" against the world origin, not the
     player -- other drivers that summon combat mobs (`hurt40.ps1`, `farm40.ps1`) already knew this
     and either use absolute coordinates or wrap in `execute as @a at @s run`. This project's own
     rule 5 ("never fill a slot by position alone") has a console-command cousin: **a selector is not an
     identity**. Fixed by wrapping every zombie-targeting command in `execute as @a at @s run ...`
     and, more robustly, tagging the zombie once (`tag @e[type=zombie,c=1,r=6] add bdsxdmgtest`) and
     addressing it by that tag (`@e[type=zombie,tag=bdsxdmgtest]`) for every command after.
   - **The zombie was burning to death before the test reached it.** `bedrock_server.exe`'s own
     `[sigprobe] entityHurt: minecraft:zombie damage 1 cause 7 ...` lines (cause 7 =
     `ActorDamageCause.FireTick`) showed up seven times *before* the driver's own `effect
     health_boost` command had even run -- the smoketest world's clock was daytime at that point
     (left there by whichever earlier session last touched it; this driver, unlike `hurt40.ps1` /
     `farm40.ps1`, had not set the time itself), the zombie was exposed to sky, and it burned to
     death on its own well before any `/damage` command fired. Fixed with one command, `"time set
     midnight"`, added before the `summon` -- the same thing every other zombie-using driver in this
     project already does, and the omission is why this is the only one that needed to relearn it.

   Point 3 in `docs/HANDOFF.md` section 7 already names this class of thing: **a counter probe (or
   here, a captured-entity check) proves an address, never a scenario** -- a `FAIL` from "the mob
   wears nothing" or "the connection dropped" said nothing about `getDamageValue` at all; it said
   the test's own zombie had already died for reasons the test wasn't looking at. The `getEntities()`
   + tag lookup that replaced the `entityHurt` capture is the same small-world-only pattern
   `actor-layout-probe.ts`'s `entityctx` step already uses (`docs/findings-reach.md`'s rule against
   walking a world-sized container on the game thread does not apply to this test world's handful of
   entities).

`bdsx/bds/implements.ts` gained the `derived()` above (the only source change). `symbols.json`'s
address count is unchanged on both builds -- this name was never going to ship as an address.

## 17. `Item::getCreativeCategory`: a one-byte field at +0x180, and no function left (A1, 2026-09-28)

`Item.getCreativeCategory()` (and `ItemStack.getCategoryName()` on top of it) threw on both builds: bdsx bound
`?getCreativeCategory@Item@@QEBA?AW4CreativeItemCategory@@XZ`, which has no address in either 1.26 table.

**The 2024 body** (`1.21.3.01 0x1cab790`, `data/leaf-accessors.json`) is the leaf `movl 0x1d0(%rcx),%eax; ret`. Its
three 2024 callers and `Item::setCategory` (`0x1cb42a0`, which ends in `movl %ebp, 0x1d0(%rbx)`) all go through that
field; `Item::addCreativeItem` (`0x1ca14b0`) reads it inline, `cmpl $0x6, 0x1d0(%rcx)`, before calling `setCategory`.
The 2024 constructor (`0x1c98a60`) stores `movq %rsi,0x1c8` (the legacy block), `movl $0x4,0x1d0`, `movq %rsi,0x1d8`,
then builds the string at `0x1e0`.

**1.26, counted.** Endstone's `item.h` (0.11.7 and HEAD) declares `block_type_`, `creative_category_`,
`crafting_remaining_item_`, `creative_group_` (commented `+400`) in that order. `block_type_` is the confirmed
neighbour at +0x178 on both builds (`layouts.Item.blockType`; eight bytes, a `WeakPtr` on 40 and a raw pointer on 51),
so `creative_category_` is +0x180, and `SharedTypes::CreativeItemCategory` is `std::uint8_t` in 1.26 (Endstone
`item_category.h`: All 0, Construction 1, Nature 2, Equipment 3, Items 4, ItemCommandOnly 5, Undefined 6).

**1.26, read.** A byte scan of `.text` for the one-byte forms, then the bodies read with `disas-exact`:

- the **Item constructor**, 40 `0x24cb9c0` / 51 `0x1a790c0` (the only `movb $0x4, 0x180(reg)` in a function that also
  stores `Item::id_` at `0xaa`): `movq $0x0,0x178(%rcx)`, `movb $0x4,0x180(%rcx)`, `movups %xmm0,0x188(%rcx)`, the
  SSO capacity `$0xf` at `0x1a8` -- 2024's four stores, the category now a byte, the default still Items (4);
- the **inlined `addCreativeItem` tail**, 40 `0x37520c0` / 51 `0x36ea0c0` (one of the two `cmpb $0x6, 0x180(reg)`
  sites on each build): the ItemInstance's `item_` WeakPtr (+8) dereferenced twice, `cmpb $0x6,0x180(%rax); jne;
  movzbl 0x18(%rcx),%edx; movb %dl,0x180(%rax)` -- "if the category is Undefined, take the group's". The same function
  reads `Item+0x158` first (`min_required_base_game_version_`, which Endstone puts right after `max_use_duration_`
  at +0x154), the base-game-version test 2024's `addCreativeItem` opens with. The two builds' instructions are the same.
- the other `cmpb $0x6` site, a **command's item-name loop**, 51 `0x413fd0` (854 bytes, ends in
  `CommandOutput::success`) and the same code inlined into 40 `0x38eef0` (`0x392445`): for each item it takes the `Item*`
  from a WeakPtr, reads `movzbl 0x1b8` (Endstone's `is_hidden_in_command_`: `creative_group_` +0x190 is 0x20 bytes, then
  the two furnace floats), `0x178` (`block_type_`), and skips the item when `cmpb $0x6, 0x180` says Undefined. A third
  reader of the same byte, with its two Endstone neighbours where the count puts them.

No out-of-line reader exists (no table name, and the scans find only these writers and the one compare), so it ships as
`layouts.Item.creativeCategory` (384, both builds) and `derived()` in `engine/item.ts` (`itemCreativeCategory`, a
one-byte read; the fallback 0x1d0 is 2024's, where the low byte of the four-byte enum is the same value).

**What execution showed** (2026-09-28, `node tools/host/verify-pair.mjs tools/host/drivers/ccat40.ps1
tools/host/drivers/ccat51.ps1`, `tools/item-probe.ts` `itemprobe creative`, 8 PASS / 0 FAIL on each build, tsc 0,
exit 0, `Quit correctly`; `work/host-runs/ccat40-20260928-220913.txt`, `ccat51-20260928-220913.txt`). Items BDS's own
`give` put in the bot's inventory, found by `Item::full_name_`, no bdsx-built stack:

| item | `getCreativeCategory()` | `getCategoryName()` | the BlockType's own `creative_category_` (+352) |
|---|---|---|---|
| `diamond_sword` | 3 Equipment | equipment | (not a block) |
| `oak_planks` | 1 Construction | construction | 1 |
| `stone` | 2 Nature | nature | 2 |
| `dirt` | 2 Nature | nature | 2 |
| `diamond` | 4 Items | items | (not a block) |

The three bytes before +0x180 are the high half of `block_type_` (a heap pointer for the block items, zero for the
others) and the seven after it are zero, as the byte-sized field with padding up to `crafting_remaining_item_` should be.

**The first run failed on `stone`** (`ccat40/51-20260928-220550`, 3 PASS / 1 FAIL each): the probe (and the queue text)
expected Construction, and both builds read 2. Bedrock files plain stone under Nature (the `itemGroup.name.stone` group,
next to granite, diorite and andesite), and the rerun's second field -- the block type's own category, which 2024's
`Item::setCategory` checked the item's against -- agrees on 2 for stone and dirt and on 1 for the planks. So the
expectation was wrong, not the offset; `oak_planks` is the Construction case now. Regression after: `cis40/cis51`
16 / 0 each.

Rule from this one: **a category expectation written from memory is a guess** -- corroborate it from a second engine
field (here the block type's byte) before calling a mismatch a wrong offset.

## 18. `BlockLegacy::getCreativeCategory`: the block type's byte at +0x160 (A1, 2026-09-29)

`BlockLegacy.getCreativeCategory()` threw on both builds: bdsx bound
`?getCreativeCategory@BlockLegacy@@QEBA?AW4CreativeItemCategory@@XZ` through `procHacker.js`, and neither table has
an address for it. Section 17 had already read +352 of three block types as the items' categories, but only by
execution. This section adds the static reader for each build.

**The 2024 bodies.** `getCreativeCategory` (`1.21.3.01 0x1bee130`) is `movl 0x138(%rcx),%eax; ret`, and `setCategory`
(`0x1bf37d0`) is `movl %edx,0x138(%rcx); mov %rcx,%rax; ret`. The 2024 constructor (`0x1bdfe70`) leaves the field 0,
as the high half of `movq $0x3f800000, 0x134`. 2024's `Item::setCategory` (`0x1cb42a0`) called the block's
`getCreativeCategory` and logged `Item(%s) creative category "%s" will override "%s" specified on Block(%s)` when the
two differed. That string is gone from both 1.26 images.

**1.26, counted.** Endstone `block_type.h` (0.11.7 and HEAD) puts `creative_category_` at +352, after
`creative_group_` (+312, a `std::string`) and the `thickness_`/`translucency_` floats. The same count gives `full_name`
at 224, the bitfields at +357 and `id_` at +382 (0x17e), and all three are already confirmed on both builds
(`layouts.BlockLegacy`). There is no leaf in `.text` on either build: no `movzbl 0x160(%rcx),%eax; ret` and no
`movb %dl,0x160(%rcx); mov %rcx,%rax; ret`. `+0x160` byte accesses are far too common to scan on their own, so both
readers below were found by intersecting them with a neighbour.

- **The BlockType constructor**, 40 `0x1ee72c0` / 51 `0x1a1fef0`, is the one function that writes `id_` at 0x17e
  (`movw %r8w, 0x17e(%rcx)`). It stores `??_7BlockLegacy@@6B@` at +0, then `creative_group_`'s SSO stores at
  0x138..0x150 and `movq $0x0, 0x158` (the two floats). Next comes `movl $0x80050000, 0x160(%rcx)`: the category
  byte is 0 (All), 2024's default. Then friction `0x3f19999a` (0.6f) at 0x178 (Endstone's `friction_` +376) and
  `id_` at 0x17e. The `c7 81 60 01 00 00 00 00 05 80` store occurs exactly once in each image.
- **The block-item registration**, 40 `0x154a8d0` / 51 `0x1661130`, is the function whose inlined `getBlockItemId`
  the `id` layout already cites. It is one of the functions that touch both +0x160 and +0x180 by byte. It copies the
  block type's `creative_group_` (+0x138) into the new item's (+0x190), then does
  `movzbl 0x160(%rsi),%ecx; movb %cl,0x180(%rax)`: the block type's `creative_category_` into the item's, which
  section 17 confirmed. This is 2024's "the item takes the block's category" with the warning dropped. The two builds'
  instructions are the same.

It ships as `layouts.BlockLegacy.creativeCategory` (352, both builds), with `derived()` in `engine/blocktype.ts`
(`blockTypeCreativeCategory`, a one-byte read; the fallback 0x138 is 2024's).

**What execution showed** (2026-09-29, `node tools/host/verify-pair.mjs tools/host/drivers/ccat40.ps1
tools/host/drivers/ccat51.ps1`, `tools/item-probe.ts` `itemprobe creative`, **18 PASS / 0 FAIL on each build**, tsc 0,
exit 0, `Quit correctly`; `work/host-runs/ccat40-20260929-124030.txt`, `ccat51-...`). The driver gives the items and
places the same blocks with `setblock` at x 31..34, y 70, z 14, then clears them:

| block | `BlockLegacy.getCreativeCategory()` on the item's block type | on the placed block (`region.getBlock(pos).blockLegacy`) | the item's own `creative_category_` |
|---|---|---|---|
| `oak_planks` | 1 Construction | 1 | 1 |
| `stone` | 2 Nature | 2 | 2 |
| `dirt` | 2 Nature | 2 | 2 |
| `crafting_table` | 4 Items | 4 | 4 |

That makes three categories, each seen through bdsx's own `Block` API, and each equal to the item field that section
17 confirmed on its own. The first pair (`ccat40/51-20260929-123519`, without `crafting_table`) gave 14 / 0 each, but the
session grep used the wrong tag (`[itemprobe]`; the probe prints `[item]`). Its lines were read back from the host with
`peek.ps1` and are in `ccat40/51-20260929-123519.peek.txt`.

## 19. `ItemStackBase::getRawNameId`, `isExplodable`, `isFireResistant` (A1, 2026-09-29)

All three threw on both builds. In 2024, `getRawNameId` (`0x1b61f20`) returns the raw name of the item's legacy block
(`BlockLegacy::getRawNameId`, `add $0x48`) if the item has one, otherwise the item's own (`Item::getRawNameId`,
`add $0xc8`), otherwise "". `isExplodable` / `isFireResistant` tail-call `Item::isExplodable` / `isFireResistant`,
which read bits 4 and 5 of the byte at +0x14a.

**1.26, counted from confirmed fields.** Endstone `item.h` declares `description_id_, raw_name_id_, namespace_,
full_name_, max_damage_`, then eight one-bit fields: `is_glint_, hand_equipped_, is_stacked_by_data_,
requires_world_builder_, explodable_, fire_resistant_, should_despawn_, allow_offhand_`, then `max_use_duration_`.
Working back from `full_name_` (+0x120, confirmed) over `namespace_` (a `std::string`) puts `raw_name_id_` at +0xd0.
That is 2024's +0xc8 plus the same 8 bytes `full_name_` moved. Forward from `full_name_` (0x30 bytes), `max_damage_` is
at +0x150 and the flag byte at +0x152, just before `max_use_duration_` at +0x154 (section 17 met it there). The
BlockType's raw name is the first member of `name_info_` (+0x90), whose `full_name` at +224 is confirmed.

**1.26, read.** A scan for `testb $imm, 0x152(reg)` finds `$0x10` once and `$0x20` four times on each build. The `$0x10`
site and one `$0x20` site sit together in the item entity's hurt (40 `0x2d3b864`/`0x2d3b899`, 51
`0x5989c54`/`0x5989c89`). If the damage cause is an explosion (`and $-2; cmp $0xa`) and the item is not explodable,
the hit is ignored. If the cause is fire and the item is fire resistant, it is ignored too. That is 2024's
`ItemActor::_hurt`. The item comes through the ItemActor's stack at +0x3b8.

It ships as `layouts.Item.rawNameId/flags` (208/338) and `layouts.BlockLegacy.rawName` (144), read by
`engine/item.ts`, with `derived()` in `implements.ts`.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/flags40.ps1 tools/host/drivers/flags51.ps1`,
`itemprobe flags` on items from BDS's own `give`, **5 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/flags40-20260929-145045.txt`, `flags51-...`):

| item | `getRawNameId` | `isExplodable` | `isFireResistant` | flag byte |
|---|---|---|---|---|
| diamond | diamond (the item's) | true | false | 0x50 |
| netherite_ingot | netherite_ingot | true | true | 0x70 |
| nether_star | nether_star | **false** | false | 0x01 |
| oak_planks | oak_planks (the block type's) | true | false | 0x50 |
| stone | stone (the block type's) | true | false | 0x50 |

The bytes carry more evidence than the two bits asked for. 0x40 (`should_despawn_`) is set on everything except the
nether star, and 0x01 (`is_glint_`) is set only on the nether star, which glints. Each raw name equals the second half
of the item's confirmed full name.

`ItemStackBase::setAuxValue` (2024 `0x1b6c940`: `aux_ = value > 0 ? value : 0` at +0x20) is a `derived()` on the same
field. It ran in the same sessions (`effc40/51`, `itemprobe flags`). On a diamond from `give`, `setAuxValue(7)` made the
engine's own `toString` end in `@7`, and `setAuxValue(-3)` made it end in `@0`.

`isFullStack` (2024 `0x1b64a70`: count >= `getMaxStackSize`), `isDamaged` (`0x1b647c0`: damageable and
`getDamageValue` > 0) and `isPotionItem` (`0x1b653e0`: the full name is potion, splash_potion or lingering_potion) are
`derived()` over pieces that already work (`sutil40/51`, `itemprobe stackutil`, 6 PASS / 0 FAIL on each build;
`work/host-runs/sutil40-20260929-151349.txt`). 64 diamonds and each one-item stack are full, and 5 stone is not. A sword
that BDS's own `ItemStack::fromTag` built with tag `Damage` 10 is damaged, and the sword from `give` is not. The potion
and the splash potion are potions. `isHorseArmorItem` and `isArmorItem` are not done this way: 1.26 added copper and
netherite horse armor, so 2024's four-name list would be wrong, and the item tag route is still open.

## 20. Item custom names and lore (A1, 2026-09-29)

`ItemStackBase::getName` (bdsx's `getCustomName`), `hasCustomHoverName` (`hasCustomName`), `getCustomLore` and
`setCustomLore` threw on both builds. They are 2024 bodies over the item's user data (`display.Name`,
`display.Lore`). bdsx already had `setCustomName` as a `derived()` on the NBT layer (`findings-nbt.md`), and the other
three are now `derived()` the same way.

`getName` without a custom name calls the item's `buildDescriptionName(stack)` virtual (2024 vft +0x290). **In 1.26 it
is slot 93**: PickaxeItem's slot 93 (40 `0x24e8940`, 51 `0x1a8d530`) calls slot 94 (`buildDescriptionId`, +0x2f0) and
then the static I18n's +0x80, which is 2024's body. Slot 92 does neither. Endstone counts it 92, one short, as it is for
`getMaxStackSize` (99 → 100). It ships as `layouts.Item.buildDescriptionNameSlot`.

**Block items are the exception.** On 51, an unnamed oak_planks through slot 93 returned "Oak Planks", but the server
then asserted `SpinLock in use while destructing` (`SpinLockImpl::~SpinLockImpl`, a `movl $0xdeadc0de, 0`) at
`stop`. That happened in three sessions. The cause was narrowed by splitting the probe:
- the NBT writes alone were clean
- a diamond alone was clean
- stone and chest were clean
- oak_planks, whose BlockItem overrides slot 94 (51 `0x2a84940`), was not

So bdsx does not call slot 93 for a block item. It translates the block type's `description_id_` (+8, Endstone
`block_type.h`) plus ".name" through `translateText`, and throws when en_US has no such key. oak_planks'
`tile.oak_planks.name` has none, so it throws instead of guessing.

**Executed** (`names40/51`, `itemprobe names` on items from `give`, **2 PASS / 0 FAIL on each build**, clean shutdown;
`work/host-runs/names40-20260929-164722.txt`):
- **Unnamed**: diamond "Diamond", stone "Stone", chest "Chest"; oak_planks refuses; `hasCustomName` false; lore empty.
- **Named**: after `setCustomName("Probe Gem")` and `setCustomLore(["line one", "line two"])`, bdsx reads both back, and
  the engine's own `save()` writes `display.Name` "Probe Gem" and `display.Lore` ["line one", "line two"].

## 21. Seven Item virtuals behind ItemStackBase (A1, 2026-09-29)

`getMaxDamage`, `getAttackDamage`, `getEnchantValue`, `isGlint`, `isPattern`, `isLiquidClipItem` and `isStackedByData`
threw on both builds. In 2024 each is `item_ ? item->vft[n](...) : 0`, a tail call through the Item's table at slots
34, 35, 51, 38, 39, 45 and 33. 1.26 inlined all seven. Endstone `item.h` numbers them 36, 37, 57, 40, 41, 50 and 35,
and in this range its count is exact: it gives 10, 14, 48 and 67 for `isHumanoidArmor`, `isDamageable`,
`canDestroyInCreative` and `isValidAuxValue`, all confirmed on both builds. PickaxeItem's table shows the bodies, the
same on both builds:
- 35: `movzbl 0x152; and $4; shr $2`, the flag byte's `is_stacked_by_data_` (section 19)
- 36: `movzwl 0x150`, `max_damage_`
- 37: the digger's damage field
- 40: `isGlint(stack)`
- 41 and 50: `xor eax,eax`
- 57: the tier pointer's +0x10

They ship as `layouts.Item.*Slot` and are called through the item's own table (`engine/item.ts` `itemSlotCall`).

**Executed** (`virt40/51`, `itemprobe virt` on items from `give`, **one combined check, PASS on each build**;
`work/host-runs/virt40-20260929-171109.txt`). Both builds gave the same values:

| item | maxDamage | attack | enchantValue | notable |
|---|---|---|---|---|
| diamond_sword | 1561 | 7 | 10 | |
| golden_sword | 32 | 4 | 22 | |
| bucket | 0 | 0 | 0 | liquid-clip, stacked by data |
| creeper_banner_pattern | 0 | 0 | 0 | pattern |
| potion | 0 | 0 | 0 | stacked by data |
| nether_star | 0 | 0 | 0 | glint |
| diamond | 0 | 0 | 0 | none of the flags |

The first run read `false` for the int getters on items where the slot is the shared `return 0` body. The wrapper cache
was keyed by the function address alone, so a bool wrapper was reused for an int call. It is now keyed by the return
type as well.

**Three more on the same pattern.** They ran in `mine40/51` (`itemprobe mine`, **3 PASS / 0 FAIL on each build**;
`work/host-runs/mine40-20260929-171634.txt`):
- `ItemStack::getDestroySpeed(block)` calls the item's `getDestroySpeed(stack, block)` virtual, which is **slot 88** on
  both builds (2024: 77). A plain item's slot 88 is `movss 1.0f; ret` (MapItem), and a digger's reads its tag. A
  diamond pickaxe gives 8 on stone and 1 on dirt, a wooden pickaxe 2 on stone, a diamond 1.
- `canDestroySpecial(block)` calls slot 33, which the derived `Player::canDestroy` already uses. The diamond pickaxe
  on stone is true, and the diamond is false.
- `setDamageValue` is 2024's `Item::setDamageValue` through the NBT layer: `Damage` goes into the user data as a
  zero-extended short. An iron sword goes from 0 to 100, `isDamaged` becomes true, and the engine's own `save()` writes
  `tag.Damage` 100.

## 22. `ItemStackBase::matchesItem`, `matches`, `add`, `remove` (A1, 2026-09-30)

**`matchesItem` has an address on both builds** (40 `0x1bc5b80`, 51 `0x1a57fd0`, 1083 bytes each). The other three are
bdsx's own code. 2024 addresses (the queue had them 0x100 high): `matchesItem` `0x1b664b0`, `matches` `0x1b4d9b0`,
`add` `0x1b562c0`, `remove` `0x1b68590`.

- **Finding it.** `hasSameUserData` (40 `0x1bc2710`, 51 `0x1a54f60`) is the callee `isStackable(other)` uses, with ten
  callers on both builds. Exactly one of them is 1083 bytes on each build, and it has 203 (40) / 204 (51) direct
  callers, which is what `operator==`/`matchesItem` have. Its body is Endstone `item_stack_base.cpp:230` in order:
  both `item_` WeakPtrs null-checked, the two Items compared by the full-name hash at `Item+0x120` (then the string, on a
  hash tie), aux (`+0x20`, the `0x7fff` wildcard), `block_` (`+0x18`), `hasSameUserData`, the can-destroy/can-place
  hashes (`+0x68`/`+0x48`), `blocking_tick_` (`+0x70`), then the charged item (`+0x78`, its `isNull`, its own
  compare and its count byte). The other callers are `FillingContainer::getSlotWithItem`,
  `ShieldItem::getInHandUpdateType` and a recipe matcher (40 `0x1536b10`).
- **`matches`** is 2024's `matchesItem(other) && count_ == other.count_` (`0x1b4d9b0`, count byte at `+0x22`). 1.26
  keeps no copy: its 200 callers of `matchesItem` compare the count themselves.
- **`add`/`remove`** were `set(count_ +/- n)` tail calls, and `set` (2024 `0x1b6c8c0`) is gone. Its body: the low byte
  of the argument against `getMaxStackSize` (`cmpb %al,%dil; ja`, so a byte compare), `0` stays `0`, store at
  `+0x22`, then `setNull(nullopt)` unless `valid_ (+0x23) && item_ && *item_ && !isNull() && count_`. On 1.26 the
  count byte, the valid byte and `setNull` (vftable slot 4, an unengaged `optional<string>` whose flag is at `+0x20`)
  read the same on both builds (40 `0x1bbf770`, 51 `0x1a52060`: `movb $0,0x22(%rdi)`). bdsx's `itemStackSetCount`
  in `implements.ts` is that body over `amount`/`valid`/`getMaxStackSize`/`setNull`.
- **Executed on both builds** (`itemmatch40/51`, `itemprobe stackmatch` + `stackcount`, **22 PASS / 0 FAIL each**;
  `work/host-runs/itemmatch40-peek-20260930.txt`, `itemmatch51-peek-20260930.txt`; the session logs
  `itemmatch40/51-20260930-101552.txt` carry only the exit lines because the driver's `--grep` named the wrong tag).
  Every stack is one BDS (`give`) or its `fromTag` made, every pair is asked both ways round: diamond x3 vs x3 true,
  x3 vs x5 `matchesItem` true and `matches` false, diamond vs emerald false, potion aux 22 vs 5 false and 22 vs 22 true,
  custom name vs none false, same name true, other name false, null vs null true, null vs diamond false, BDS's own give
  x3 vs a constructed x3 true. `add`: 3+2 = 5, +100 clamps to 64, an unstackable sword 1+1 stays 1; `remove`: 64-4 = 60,
  60-60 nulls the stack (`isNull` true), the sword's -1 nulls it.
- **Not run**: `remove(n)` with `n` above the count. 2024's byte compare turns `-7` into 249 and clamps it to the maximum;
  the body is kept as 2024 wrote it, nothing on 1.26 shows whether the engine still does. A stack whose charged item is
  set (a loaded crossbow) is not compared either: the charged-item branch of `matchesItem` ran only on the null side.
- **`isArmorItem`/`isHorseArmorItem` left open.** 2024 `isHorseArmorItem` (`0x1b64ac0`) compares the full name against
  four `VanillaItemNames` globals and `isArmorItem` (`0x1b64560`) is `Item::isHumanoidArmor` or that. On 1.26 the FNV-1
  hash (`h = h*0x100000001b3 ^ c`; `minecraft:air` gives `0xbd584baf00003448`, the immediate the static initializers
  store) of six horse armors (leather, iron, golden, diamond, netherite, copper) appears once each, all in one 76 KB
  static initializer (40 `0x3407200`), and a scan of every `lea rip` in `.text` finds those six globals referenced by
  nothing else (one more leather hit, in `Horse::canFreeze`, which reads the armour slot; not the predicate). So the 1.26 test is not
  a name compare, and nothing was written for the two.


## 23. `ContainerComponent`: one EnTT element, a Container at +0x10, and five names (A1, 2026-09-30)

The component is an EnTT element of **0x200 bytes on both builds** (`shll $9` on the packed-page index in every user of hash
`0x1779e2c7` = fnv1a "ContainerComponent": `Actor::setNameTag` 40 `0xe0e800` / 51 `0xd4e6f0`, and the addItem caller
40 `0xdfe720` / 51 `0xd3e7f0`). Its `Container` is inline at **+0x10**, as in 2024: the caller passes `component+0x10` to
`Container::addItem` (40 `0x2db7d0` / 51 `0x36fc40`). The custom name string is at +0x138 (flag +0x180) and the item
vector the component's own addItem loop walks at +0x1a8/+0x1b0 (stride 0x98). Shipped as `layouts.ContainerComponent`
`size`/`container`, and `layouts.ItemActor.itemStack` = **0x3b0** (`ItemActor::_hurt` reads the stack's `item_` at
0x3b8; 2024 0x448).

| name | how |
|---|---|
| `Actor::tryGetComponent<ContainerComponent>` | `derived()`, `enttComponent(actor, hash, 0x200)` |
| `ContainerComponent::addItem(ItemStack&)` | `derived()`: `Container::addItem` on `component+0x10`, then `true` (2024: one virtual call, `mov al,1`) |
| `getEmptySlotsCount`, `getSlots` | `derived()`: the Container's base bodies (40 `0x2066d0`/`0x2dd2d0`, 51 `0x294440`/`0x3717a0`) on `component+0x10`. The old binding read `rax` as a float64 (`int64_as_float_t`) for an `int` |
| `addItem(ItemStack&, int, int)` | **address**: 40 `0x2483270`, 51 `0x1b988d0`, a 113-byte loop over the item vector calling the per-slot helper (40 `0x2482e60`, 814 B). Signature is `(stack, face, count)`: 2024's `canPushInItem(slot, face, item)` is gone, `face` is ignored; `count` moves, the rest stays |
| `addItem(ItemActor&)` | `derived()`, 2024's body: refuse a null stack, count 0 or a removed entity (byte `Actor+617`), `addItem(stack, -1, count)`, `remove()` when the count reached 0 |

bdsx's old `_addItem` was wrong on every build: it was installed as `function (component, item, ...)` but called as
`this._addItem(item, ...)`, so `component` was the item. It uses `this` now, and the public overload is
`addItem(item, face?, count?)` (was `count?, data?`, which landed in `face` and `count`).

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/cont40.ps1 tools/host/drivers/cont51.ps1`, `tools/container-probe.ts`,
world position x=2000, z=-2000, **19 PASS / 0 FAIL on 40, 20 PASS / 0 FAIL on 51**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/cont40-20260930-104222.txt`, `cont51-...`): chest minecart and hopper minecart give a component, minecart and
armor_stand give null; empty slots 27 / 5 and `getSlots` sizes 27 / 5; diamond x3 and apple x2 through `addItem` read back
(slots 0/1), an apple merges (empty stays 25, slot 1 x3), bread takes slot 2 (24); `addItem(gold x10, -1, 4)` puts four in
a fresh slot and leaves six, `(-1, 6)` merges the rest; the porkchop entity a dying pig dropped goes into the container
(`ItemActor.itemStack` name and amount are right, so +0x3b0 is), its removed byte goes 0 -> 1, and a second call gives
false with nothing changed.

Lessons: `replaceitem entity ... slot.container|slot.chest|slot.storage` fills nothing on a minecart, so the fill goes through
`addItem`, and BDS's own reading of the component is not part of this evidence (only the counts of the engine's own
`Container` virtuals, which bdsx calls). A selector with `dx/dz` and no `y/dy` from the console is a slab at y=0: the first
runs' `kill` never matched (`y=-64,dy=500` fixes it). The base `Container::getEmptySlotsCount`/`addItem` bodies are called,
not the instance's override; both worked on the minecarts' containers.

## 24. `ItemStackBase::isArmorItem`, `isHorseArmorItem` and `CreativeItemCategoryFromString` (A1, 2026-09-30)

All three are bdsx's own code now (`derived()`), and section 22's guess held: the 1.26 horse-armor test is not a name compare.

- **`isHorseArmorItem` is a tag test.** The static `HashedString` "minecraft:horse_armor" (40 global `0xc8ddea0`, initializer
  `0xdd1f10`; 51 `0xcc28c88`, `0x2cf7f0`) is read by the tag walk of two bodies in the ItemStackBase block: 40 `0x1bc79a0` (the
  predicate: `item_` WeakPtr null-checks, `Item+0x1f8`/`+0x200` begin/end of a vector of 0x30-byte `HashedString`s, hash then
  string compare, the hit cached in the element's last-match slot, `return found`) and `0x1bc7810` (below). Neither reads
  a `VanillaItemNames` global. Finding them: a `.text` scan for `rip` displacements landing on the tag global
  (`lea`/`mov` sites), then reading the two bodies. `layouts.Item.tags` = 504 (`0x1f8`) on both builds; 51 has the same walk.
- **`isArmorItem`** (40 `0x1bc7810`, 51 `0x1a59b00`; both called by `Mob::getArmorValue`) is four tests in order: the item's
  `isHumanoidArmor` virtual (vftable `+0x50`, slot 10), the horse-armor tag, a `HashedString` compare of `Item+0x120` with the
  global at 40 `0xc996628` (initializer `0x3412980` stores "minecraft:wolf_armor"), and a tail-called tag lookup of the global
  at 40 `0xc8de080` ("minecraft:nautilus_armor", `0xdd2b50`). 2024 (`0x1b64560`) was the first and the horse test.
  Elytra reads true (INFO): its `isHumanoidArmor` is true.
- **`CreativeItemCategoryFromString`**: 2024 (`0x1c9aa60`) lower-cased the name and looked it up in an unordered_map,
  returning 0 for empty/unknown. 1.26 keeps no function: the seven names are the enum list of the item schema's "category"
  (40 `0x24ec8c0`, 51 `0x1a93ab0`: all, construction, nature, equipment, items, commands, none, in the engine enum's order).
  bdsx carries the table (`implements.ts`); `example_and_test/test.ts` now imports it instead of binding the name itself.
- **Executed on both builds** (`armorit40/51`, `itemprobe armoritem` + `catstring`, **36 PASS / 0 FAIL each**;
  `work/host-runs/armorit40-20260930-132820.txt`, `armorit51-20260930-132820.txt`). Both answers: the six horse armors true/true
  (constructWith), diamond_chestplate, leather_boots, wolf_armor, iron/copper_nautilus_armor true/false, stone, apple,
  diamond_sword, diamond, saddle and the null stack false/false, and BDS's own `give` of iron_horse_armor (true/true),
  diamond_chestplate, wolf_armor (true/false) and stone (false/false). FromString: 0..6 for the seven names, mixed case,
  unknown and empty 0; diamond_sword 3, oak_planks 1, stone 2, diamond 4 equal the engine's `creative_category_`, and
  command_block, barrier, structure_block, jigsaw, allow, light_block_0 all read 5 (`commands`).
- **Not confirmed**: `"none"` = 6 and `"all"` = 0 rest on the schema enum order only (no item read 6); the wolf-name branch and
  the nautilus-tag branch are each seen only through their own items (a mob-side effect such as `getArmorValue` on a wolf
  was not run); the tag walk compares strings where the engine compares the hash first, which is the same answer.

## 25. `BlockActor::getContainer`, `getCustomName`, `setCustomName` and `ChestBlockActor::openBy` (A1, 2026-09-30)

**The three moved names.** 1.26 keeps all three on `VanillaBlockActor`'s first interface, `IVanillaMainBlockActorComponent`
(Endstone `vanilla_block_actor.h`), whose sub-object is at BlockActor+40 on 40 and +48 on 51 (`layouts.BlockActor.mainInterface`).
Its vftable has 27 slots on both builds in Endstone's order (the earlier `setChanged` scan already found slot 22 and 23 in
it). Read from the chest's table (40 `0xa6a07f0`, 51 `0xa7864f0`, the one right after the chest's primary table):

| slot | virtual | body on both builds |
|---|---|---|
| 2, 3 | `getContainer` (const, non-const) | the same function, `lea 0xe8(%rcx),%rax` for a chest (40 `0x12a67e0`, 51 `0xee2b10`); a sign's table has `xor eax,eax` (`0x76150` / `0x76010`) |
| 8 | `hasCustomName` | `cmpq $0,0x68(%rcx); setne al` -- the custom name's size |
| 9 | `getCustomName` | `lea 0x58(%rcx),%rax` -- the `RedactableString`, whose first member is the raw `std::string` (40 `0xce1610`, 51 `0xa7ca60`) |
| 10 | `setCustomName(RedactableString const&)` | `RedactableString::operator=(this+0x58, rdx)` (40 `0x970420`, 51 `0xc3f1c0`), then clears the filtered name at +0xa0 |

A `RedactableString` is 0x48 bytes: raw `std::string` at +0, `std::optional<std::string>` at +0x20, engaged byte +0x40 (the
assignment reads exactly those). `engine/blockactor.ts` calls the slots through the sub-object and builds the argument for
`setCustomName` as a zeroed 0x48-byte block holding a constructed `std::string` (no filtered part). The five layout entries
(`mainInterface`, `getContainerSlot` 3, `hasCustomNameSlot` 8, `getCustomNameSlot` 9, `setCustomNameSlot` 10) are in
`candidates-instances-<v>.json` under `BlockActor`; `engine-deps.mjs --missing` is empty on both builds.

**Executed** (`bact40`/`bact51` through `verify-pair.mjs` / `session.mjs`, `tools/container-probe.ts` `bactprobe`, **15 PASS / 0 FAIL
on each build**, tsc 0, exit 0, `Quit correctly`; `work/host-runs/bact40-20260930-141959.txt`, `bact51-20260930-142408.txt`).
The driver places two chests four blocks apart (adjacent chests pair), a hopper and a standing sign, and removes them:
- containers: chest 27 slots, hopper 5, sign `null`; three distinct containers; `replaceitem` diamond x3 into chest A and apple x5
  into the hopper's slot 2 read back through `getContainer().getSlots()`, chest B stays empty, and the engine's own `save()` NBT
  of A holds the diamond while B's does not;
- names: empty at the start (`hasCustomName` false, no `CustomName` in the saved NBT); `setCustomName("Probe Chest")` reads back and
  the saved `CustomName` is the same string, with the engine's `hasCustomName` true; a 51-byte heap string, "Short again" and `""`
  (`hasCustomName` false again) all round-trip; the other chest is untouched; setting B leaves A alone.

**`openBy`: PARTIAL.** 2024's `openBy` (`0x20f4de0`) is slot 45 of a 51-slot table. 1.26's chest table is 35 slots (40 `0xa6a06d0`,
51 `0xa7863d0`) because the name, container and loot-table virtuals moved to the main interface; the chest's own tail
(`loadItems`, `saveItems`, `openBy`, `playOpenSound`, `playCloseSound`, `_canOpenThis`, `getObstructionAABB`,
`_detectEntityObstruction`) is slots 27..34, so `openBy` is **slot 29**: 40 `0x2915f70`, 51 `0x1f33d00`. Both bodies are 2024's
step for step: the player-gameplay event (variant `0x10`, the block position), then, when `[player+0x5a0]` (an open container) is
set, `Container::startOpen` (vftable `+0xb0`) on the chest's container (`+0x110` / `+0x118`) or the paired partner's. It is shipped
as `layouts.ChestBlockActor.openBySlot` = 29 and `chestOpenBy` in `engine/chest.ts` (through the object's own vftable).
What ran: bdsx's `openBy(player)` on a placed chest for a connected player with no open container **returned without a crash on
both builds** (the same `bactprobe direct` step). What did not: a counter on the slot (`ProcHacker.hookingRawWithCallOriginal`
at the slot's address) fired once when simbot right-clicked a chest on 51 (`simact useon 31`, so the engine does call this
address) and when bdsx called it directly on both builds, and each time the server then died with 0xC0000005 and no crash report;
the same direct call **without** the hook returns. The hook on this 15-byte-prologue function is the suspect (not proven), so
the address rests on the body and the slot arithmetic plus one engine call seen, and the effect (a lid, `startOpen` on a container
the player really has open) is **not observed**: it stays a candidate, and `openBy` is not in `data/derived.json`. Next: an oracle
that needs no hook (a real client's chest UI, or `Container::startOpen`'s own observable in a held-open container), or a counter
by a different mechanism than a raw hook on this function.

## 26. `ChestBlockActor::openBy` executed: the call opens the container itself (A1, 2026-09-30)

Section 25 left `openBy` a candidate: a direct call returned, the effect was unobserved, and a raw hook counter on the slot killed the server. The
oracle that needs no hook is the state `Container::startOpen` writes on the chest's container (`chest.getContainer()`, 40 chest+0x110, 51
+0x118): read from 40 `0x2914700` / 51 `0x1f0f4d0` (`ChestBlockActor::startOpen`, identical offsets on both builds), it inserts the player's unique id
in a viewer set at container+0x200, whose size is the int at +0x210 and sets a byte at +0x1d0 (the chest's "opened" flag; `cmpl $1, 0x210` is
the first-viewer branch that sends the lid block event and the sound).

**The section 25 reading of the body was incomplete.** `openBy` is not "startOpen when the player already has a container": the player-gameplay
event it sends first is what makes the engine open a container for a player that holds none. `Player+0x5a0` of the connected bot goes from null
to a pointer **inside the call**, and only then does the second half run `startOpen` with that player (the mechanism is inferred: the body reads `+0x5a0` only after the event; what was observed is the null -> pointer change across the call). (Earlier runs printed "count 1" for a bot
that "held nothing": that was this, not a bug in the probe.)

**Executed** (`hopen40`/`hopen51`, `tools/container-probe.ts` `bactprobe open`, **8 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/hopen40-20260930-154958.txt`, `hopen51-20260930-154958.txt`; `bact40`/`bact51` still 15 PASS / 0 FAIL afterwards, `bact40-20260930-155430.txt`).
Chest C (31,68,18) is opened by simbot through the engine (`simulateUseItemOnBlock`), chest B (39,68,18) is never touched by the engine, so a
change on B is the call's own:
- before: simbot `+0x5a0` non-null, the bot's null; C `count 1 flag 1` (what a real open leaves), B `count 0 flag 0`;
- `B.openBy(bot)` (bdsx's shipped binding): the bot's `+0x5a0` null -> a pointer, B `count 0 flag 0 -> count 1 flag 1`, C unchanged;
- `B.openBy(simbot)`: B `count 2 flag 1`; the same call again: still `count 2` (a set keyed by player, not a counter);
- `Container::stopOpen(simbot)` (container vftable +0xb8, called by the probe only): B `count 1`; `stopOpen(bot)`: `count 0 flag 0`.

Identical on 40 and 51. Chests are destroyed with viewers still registered at the end of a run: both builds shut down cleanly.
`data/derived.json` has the `openBy` entry now. The 2024 body is confirmed line for line by these effects (the event, then `startOpen` on the chest's own container); the paired-chest branch (`+0x2f8`/`+0x300` partner) is still read only.

## 27. `Item::setAllowOffhand`, `Item::getSerializedName` and `ItemStackBase::hurtAndBreak` (A1, 2026-09-30, agent-b)

All three ran on both builds (`hbreak40/51`, `tools/item-probe.ts` `sername`/`offhand`/`hbreak`/`hbreakp`, **26 PASS / 0 FAIL each**;
`work/host-runs/hbreak40-20260930-184647.txt`, `hbreak51-20260930-184647.txt`). Two are `derived()` over `engine/item.ts`, one is a new address.

- **`hurtAndBreak` is out of line on both builds** (an address, not `derived()`): 40 `0x1bc47a0` (1101 bytes), 51 `0x1a56c80` (1255). Found as
  the ItemStackBase-block function that uses the `"Unbreakable"` string (`string-users.mjs`, two candidates per build) and calls
  `EnchantUtils::getEnchantLevel`; read whole against 2024 `0x1b63750`. The shape is the same: `count <= 0` returns false; an actor with
  byte `+0x269` clear and bit 1 of `+0x210` set is a player, whose `getAbilities` six-layer walk decides "creative" (early false); the item's
  `isDamageable` virtual (`+0x70`); the user data's `Unbreakable` boolean; `getEnchantLevel(Unbreaking = 0x11)`, then the item's chance slot
  (`+0x220`) against a roll of the thread-local Random; `Item::getDamageValue` + count into `setDamageValue`; the max-damage virtual (`+0x120`);
  on overshoot the break event through the actor's level slot `0x6a8` (and the wolf-armor compare), then `set(count - 1)`. Its prototype
  `(this, int count, Actor*) -> bool` is bdsx's, unchanged. Executed on stacks `ItemStack::fromTag` built: diamond_pickaxe (max 1561)
  `hurtAndBreak(1)` true, damage 0 -> 1, `(3)` true, 4; `Unbreakable` tag false and 0; a diamond (not damageable) false, count 1; damage max-1
  -> true and still there **at max** (the test is new damage > max, as in 2024), the next true and the stack gone; damage max-2 by 5 true and gone;
  Unbreaking III over 400 single hits left damage 97 (40) / 100 (51) (window 50..160: the 1-in-4 roll works); the bot as the actor: survival
  true/1 and true/4, creative false/0 and false/0. Not seen: a non-null actor *breaking* a tool (the break event spawn) and the wolf branch.
- **`getSerializedName`** (`derived()`): 2024 `0x1cae4b0` is `namespace_ + ":" + raw_name_id_` with everything up to the first `"tile."` dropped
  from the raw name (Item `+0xf8` and `+0xc8`). 1.26: `layouts.Item.namespace` = `+0x100` (a new entry, counted back from the confirmed
  `full_name_` `+0x120`; `rawNameId` `+0xd0` was already confirmed). Executed: for 14 items the result equals the engine's own full name (a
  separate field) and the name `constructWith` was given. Not seen: the `tile.` branch (no raw name carries it on either build; it is 2024's code)
  and a namespace other than `minecraft`.
- **`setAllowOffhand` moved on 51, which Endstone does not say.** Endstone `item.h` (0.11.7 and HEAD) keeps `allow_offhand_` as the eighth flag
  bit, which is right for 1.26.40: the engine's own reader is **`OffhandContainerValidation`'s vftable slot 2** (`??_7OffhandContainerValidation@@6B@`
  40 `0xa68d610`, 51 `0xa7714e0`; 40 `0x8f48ce0`: `movzbl 0x152(item); shrb $7`), and 40's network item writer stores `allow_off_hand` from the same
  bit (`0x33c6d6d`). On **51 nothing reads or writes bit 7 of `+0x152`** (a scan of every `.text` disp32 `0x152` load/test: bits 0 to 6 have setters
  and readers, bit 7 none); the validator (51 `0x2f48d80`) is `movzbl 0x210(item); andb $3; cmpb $1; sete`, the network writer (`0x20bb75d`) writes
  `allow_off_hand` from that state, and the reader stores 2 or 1 there (`0x20bd5a7`). So 51's Item has a two-bit state byte at `+0x210`
  (ComponentItem's own flags moved from `0x210` to `0x218`, which the layout notes already recorded): 1 allowed, 2 not, 0 unset; diamond starts at 2.
  `layouts.Item.allowOffhandState` = 0 on 40 (the flag bit is the storage) and `0x210` on 51. bdsx's old manual `allowOffhand()` read `0x13a`,
  stale on both builds; it now reads the same storage. **Executed against the engine's validator** (called through a fake object holding the
  table): the registry's diamond with `setAllowOffhand(false/true/false)` answers false/true/false from the engine and from bdsx on both builds
  (40 flag byte 0x50 -> 0xd0 -> 0x50; 51 state byte 2 -> 1 -> 2, flag byte untouched), other bits kept, and the real items agree on both: shield, totem,
  arrow true, diamond_sword, stone, apple, torch, diamond false (before the fix, 51's `allowOffhand()` said false for the shield). **BDS's
  `replaceitem` into `slot.weapon.offhand` does not gate on the rule** (a diamond went in with it false and true, on both builds), so it is not an oracle.
- Probe lessons: a bit Endstone lists can be stale for one build of the pair, and only a reader that *uses* it tells (find the engine function that
  consumes the value, not the one that stores it); `OffhandContainerValidation::valid` ignores `this`.
