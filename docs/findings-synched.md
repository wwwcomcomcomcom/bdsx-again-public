# The SynchedActorData seam (2026-09-19)

Actor's network-synchronised fields -- name tag, variant, flags, the several
timestamps -- are not members. They are `DataItem`s in a container the Actor
embeds, reached through `SynchedActorDataEntityWrapper`. bdsx has always
gone through that wrapper, so the wrapper is a *seam*: getting it right
resolves a handful of names at once and opens more.

It also had to be got right for a worse reason. **Two of the addresses the
table was shipping for it were wrong**, and both would have been called the
moment the seam opened.

## What was wrong

| name | shipped | what it actually is |
|---|---|---|
| `??$set@H@SynchedActorDataEntityWrapper@@QEAAXGAEBH@Z` | `0x2497790` / `0x1bac070` | a 768-byte trade function |
| `?getInt@SynchedActorDataEntityWrapper@@QEBAHG@Z` | `0x23f4ca0` / `0x29e04b0` | a 673-byte EnTT sparse-set lookup |

Both came from call-edge propagation, and both are refuted by their first ten
instructions rather than by anything subtle:

- The `set<int>` candidate takes **rcx alone**, calls a helper and keeps the
  result in edi, and only then reaches a wrapper the long way round through
  `this+24 -> +0x128`. A real `set<int>(unsigned short, int const&)` takes the
  id in dx and a pointer in r8 and touches nothing else. The body is a trade
  routine that inlined a `getInt` of its own.
- The `getInt` candidate loads `movl $0x966A4DD4, %edx` -- a component type
  hash -- passes it to the storage helper and then does `andl $0x3FFFF` /
  `shrl $11` page indexing. It also tests `dl` as a bool, where
  `getInt(unsigned short)` would zero-extend dx as an id.

Both are now in `retracted` in `data/candidates-instances-<v>.json` with that
reasoning. `set<int>` has no replacement: 1.26 keeps no out-of-line copy, so it
has to become `derived()` (`next-steps.md`).

## What the wrapper's getters actually look like

Nine of them survive out of line, and they are the same 83--100 byte body
nine times over. Each names its own type by the constant it compares:

```
        movq   (%rcx), %rax          ; the DataItem vector through wrapper+0
        movzwl %dx, %ecx             ; the id, zero-extended
        movl   8(%rax), %r8d
        movq   (%rax), %rdx
        subl   %edx, %r8d
        shrl   $3, %r8d              ; how many pointers the vector holds
        cmpl   %ecx, %r8d
        jbe    <miss>                ; ids index the vector directly, as in 2024
        movq   (%rdx,%rcx,8), %rsi
        movq   (%rsi), %rax
        movq   16(%rax), %rax
        callq  *...                  ; the item's type: virtual slot 2
        cmpb   $2, %cl               ; 2 Int / 3 Float / 4 String
        movl   12(%rsi), %eax        ; the payload
```

The payload offset is the one thing that moved: **`+0x0c` for anything four
bytes or smaller, `+0x10` for int64 and string** (2024 kept everything at
`+0x10`). `getString` returns `rsi+0x10`, or a static empty string through a
`cmove`, so it never returns null.

The addresses, identical in shape on both builds:

| name | 1.26.40.8 | 1.26.51.1 | size | type |
|---|---|---|---|---|
| `getInt` | `0x2403fb0` | `0x2cb5810` | 90B | 2 |
| `getFloat` | `0x2404fb0` | `0x2cb58d0` | 86B | 3 |
| `getString` | `0x2420490` | `0x2cb5930` | 100B | 4 |

The second route is position, for once legitimately: on 1.26.51.1 the nine
getters sit in one contiguous block, `0x2cb5750..0x2cb5aa0`, and their order
there is Endstone's declaration order in `synched_actor_data.h` (`getInt8`,
`getShort`, `getInt`, `getInt64`, `getFloat`, `getString`, `getPosition`,
`getVec3`, `hasData`).

## `Actor::entity_data` is at `+0x128`, and it is an accessor

2024 had it at `+400`. Two members pin the new offset independently, because
1.26 inlined the wrapper getter into each of them:

- `Actor::getNameTag` (`0xe080a0` / `0xd47ff0`): `movq 296(%rcx),%rax`, bounds
  check `cmpl $33` (five pointers), `movq 32(%rcx),%rsi` -- **index 4**, NAME --
  virtual slot 2 for the type, then the string payload at `+0x10`.
- `Actor::getLeashHolder` (`0xdddab0` / `0xd1dc70`): the same through **index
  37**, returning -1 when absent.
- `Actor::getVariant` (`0xde85b0` / `0xd28560`) is the same body again at
  **index 2** with `cmpb $2` and `movl 12(%rsi),%eax`; its sibling
  `getMarkVariant` (`0xde8610` / `0xd285c0`) is index 43.

The wrapper is *embedded*, not pointed to -- those inlined copies read
`296(%rcx)` exactly where the wrapper's own getters read `(%rcx)`. So
`getEntityData` is not an address at all: it ships as an `accessors` entry of
kind `lea`, width 8, off 296, and bdsx emits `lea rax, [rcx+0x128]`.

## Executed (both builds, `sadprobe`)

```
PASS sadprobe entityData: getEntityData() -> 0x... (lea Actor+0x128)
PASS sadprobe name: getString(4) "bdsxprobe" getNameTag() "bdsxprobe"
PASS sadprobe variant: getInt(2) 0 getVariant() 0 (want equal)
INFO sadprobe ints:   1=1 27=1 55=-1 78=-1 106=3 125=20 126=614 136=-1 137=-1 138=-1
INFO sadprobe floats: 108=8 109=16 111=1 124=1 140=64
PASS sadprobe types: 10 int ids and 5 float ids, overlap [] 
```

The name check is the decisive one: a five-step chain (accessor at `+0x128` →
vector → index 4 → type check → payload at `+0x10`) lands on the string BDS
itself put there, through two separately compiled paths that agree.

The variant check passes but is weak -- a player's variant is 0, so `0 == 0`.
What carries `getInt` and `getFloat` instead is the **disjointness** of their
sweeps: over ids 0..140 they return non-zero at completely separate id sets,
identical on both builds. Only a working type check produces that; a getter
that ignored the item type, or a different function entirely, could not
separate them. No console command moves a float data item on a player or a
bot-reachable mob, so no single float is checked against a known quantity.

## What this opens

`getScoreTag` was already written against `getString(0x54)` and needs no
further change. Still ahead (`next-steps.md`): `set<int>` / `set<float>` as
`derived()`, `setNameTag` and `getBlockTarget` (no out-of-line copy;
`getBlockTarget` can be `getPosition(47)`), and the status-flag family, which
needs `flag_data_` inside this same container.

`DataItem` itself changed more than the container did: the container is still
a vector indexed directly by id with a dirty bitset at `+24`, and
`ActorDataIDs` values are unchanged where they could be checked (8 of 8), but
`ActorDataIDs::Count` went 132 → 141 and `type_` / `id_` are reachable only
through virtual slots 2 and 1.

## `set<int>` and `set<float>`: written by bdsx, checked against BDS's own read

Neither survives out of line -- every caller inlined it, and what propagation
offered for `set<int>` was the trade function above. They go to `derived()`
instead, and they qualify under `findings-utils.md`'s rule: what carries is a
body whose memory accesses are into a layout bdsx defines, and the container
here is unchanged since 2024.

The two bodies agree step for step, which is the second route:

| | 2024 `0x1417f0` (143B) | 1.26 inlined, `0x23990b0` (137B) |
|---|---|---|
| container | `_get()` → `SynchedActorData*` | `movq 296(%rsi),%rdi` |
| type | `cmpb $2, 8(%rax)` (field) | vftable slot 2, then `cmpb $2, %al` |
| no-op | `cmpl %ecx, 16(%rax); je` | `cmpl %ebx, 12(%rsi); je` |
| payload | `movl %ecx, 16(%rax)` | `movl %ebx, 12(%rsi)` |
| id | `movzwl 10(%rax), %edx` (field) | vftable slot 1 |
| bound | `cmpq $132` | `cmpl $141` |
| dirty | `leaq 24(%rbx)`, `shrq $6`, `andb $63`, `orq` | `orq %rdx, 24(%rdi,%rax,8)` |

So: look the item up by id, refuse it when `getType()` is not this setter's,
**do nothing at all when the value is already there**, write the payload, then
set the id's bit in the bitset at `SynchedActorData+24` unless the id is past
`ActorDataIDs::Count`. The no-op is not an optimisation to skip -- it is what
keeps an unchanged field out of the next `SetActorData` packet.

`layouts.SynchedActorData` ships `dirtyFlags: 24`, `idCount: 141`,
`payload4: 12`, `payload8: 16`; the bdsx fallbacks are the 2024 values, so a
build whose table carries no layout still gets 2024's behaviour rather than
1.26's offsets. The bitset is 64-bit words, so reading it as uint32 halves in
order is the same bits.

**Executed on both builds** (`setprobe`), four checks, because three separate
things have to be right:

```
PASS setprobe int:    variant 0 -> getInt 7 / Actor::getVariant 7
PASS setprobe dirty:  bit for id 2 is 1, word 0x4
PASS setprobe refuse: setInt on float id 108 left 8 as 8, getInt reads 0
PASS setprobe float:  setFloat(108) -> 3.5, setFloat on int id 2 left 7
```

The first is the one that matters most: bdsx writes, and **BDS's own
separately compiled `Actor::getVariant` reads back what bdsx wrote**. The
third and fourth are the type refusal in both directions, which is what stops
a setter from corrupting an item of another type -- the failure a payload-only
implementation would not catch.

## The string setter, and where the seam stops

`set<std::string>` has no out-of-line copy either, and bdsx never names it --
it is only reached through `Actor::setScoreTag`, whose 2024 body is a tail
call and nothing else (`0x19c6fb0`: `movq %rdx,%r8; addq $400,%rcx;
movl $84,%edx; jmp`). So the string setter is an internal helper of the same
shape as `set<int>`, with the string compare and assignment in place of the
int one; 2024's own `set<string>` (`0x573da0`) confirms the shape, including
the compare that returns without writing when the strings are already equal
and the identical dirty-bit tail.

`Actor::getBlockTarget` is the same kind of one-liner the other way round
(`0x19b0d90`: `movl $47,%r8d; addq $400,%rcx; jmp getPosition`), so it goes
through the wrapper's `getPosition`, which 1.26 does keep out of line:

| name | 1.26.40.8 | 1.26.51.1 | size | type |
|---|---|---|---|---|
| `getPosition` | `0x2420500` | `0x2cb59a0` | 121B | 6 (BlockPos, 12 bytes at `+0x0c`) |

Both builds keep the tail of the getter block in declaration order, which is
how the 1.26.40.8 address was found without the contiguity 51 has: `getShort`
`0x2420430`, `getString` `0x2420490`, `getPosition` `0x2420500`, `getVec3`
`0x2420580`, `hasData` `0x2420600`.

**Executed on both builds** (`strprobe`):

```
PASS strprobe scoreTag: "" -> "bdsxscore" -> "bdsx-score-tag-well-past-fifteen-bytes" dirty 1
PASS strprobe restore: back to ""
INFO strprobe blockTarget: 0,0,0 (a player has none)
```

The score tag is the strong check, and deliberately includes a 38-character
value: it cannot fit `std::string`'s small-string buffer, so the assignment
allocates, and BDS frees it. That is the allocator work of
`findings-utils.md` and this seam meeting -- bdsx's memory, BDS's heap, BDS's
`getString` reading it back. `strprobe` only checks `getBlockTarget` weakly, because
a player has no block target and `0,0,0` is also the not-found answer. The strong check is below.

**Strongly confirmed on both builds (2026-09-24, `nbt40`/`nbt51`, `tools/block-probe.ts btprobe`).**
The engine can set a block target without a client: `EnderCrystal::readAdditionalSaveData` (40 `0x2d44000`, 51
`0x5992a40`, both shipped) reads `BlockTargetX/Y/Z` (its only three string references), and `addAdditionalSaveData`
writes them back. The probe summons a crystal and reads `getBlockTarget` (`0,0,0`), hands the engine
`{BlockTargetX/Y/Z: 5, 71, -9}`, then reads `5,71,-9` through `getBlockTarget`, and the engine's own `Actor::save`
writes `5,71,-9` back. That needed bdsx's NBT layer working on 1.26 first (the tag vftables, `put`/`get`,
`Actor::save`, `DefaultDataLoadHelper`'s vftable): `docs/findings-nbt.md`.

### Where it stops: `Actor::setNameTag`

`setNameTag` looks like a third one-liner and is not. Its 2024 body
(`0x19c6ac0`) does the `set<string>(entity_data, 4, v)` and then two more
things: it looks a component up through `Actor+16` / `Actor+24` and writes the
name into whatever comes back, and it clears a cached `std::string` at
`Actor+880`. Deriving it from the first third would leave the other two
undone, and both offsets are 2024's. So it stays missing, with the reason
recorded here rather than guessed at.

## The status flags: bdsx's enum was wrong before anything else was

The flag family (`isSneaking` and the twenty-three others) could not be opened
until `ActorFlags` itself was right, and it was not. bdsx's enum lacked
`CAN_DASH` (46, added in 1.19) and carried a `FallThroughScaffolding` (70) the
engine has dropped, so every flag from 46 to 70 was one too low -- and the two
errors cancel at 71, which is why nothing downstream ever looked wrong.

Two independent sources say so, and bdsx is alone:

- Endstone's `src/bedrock/world/actor/actor_flags.h` (Apache-2.0), identical in
  v0.11.7 (1.26.40.8) and HEAD (1.26.51.1) over 0..121 and 123..129.
- **the 2024 build itself.** 44 `?isX@Actor|Mob|Player@@QEBA_NXZ` bodies are the
  one-liner `movq (%rcx),%rax; movl $<flag>,%edx; movq (%rax),%rax; jmp [guard]`,
  so the flag number is an immediate sitting in the image. All 44 agree with
  Endstone, and 14 of them fall inside the disputed window:

  | flag | getter | | flag | getter |
  |---|---|---|---|---|
  | 51 | `isDancing` | | 62 | `isTransitioningSitting` |
  | 56 | `getDamageNearbyMobs` | | 63 | `isEating` |
  | 57 | `isSwimming` | | 64 | `isLayingDown` |
  | 58 | `isBribed` | | 66 | `isTrusting` |
  | 59 | `isPregnant` | | 69 | `isInScaffolding` |
  | 60 | `isLayingEgg` | | 70 | `isOverScaffolding` |

  The last row is the decisive one: 70 is `OVER_SCAFFOLDING`, so bdsx's
  `FallThroughScaffolding = 70` names a flag that is not there.

`Sneezing`'s explicit `= 0x40` was the pre-`CanDash` value and had to become
`0x41`, or the deprecated alias would have quietly started naming `LayingDown`.
101..129 were appended from Endstone; they do not exist in the 2024 build at
all, and 118 `BodyRotationBlocked` is confirmed by 2024's own
`?isBodyRotationBlocked@Actor@@`.

## Where the flags actually live

They are not in `SynchedActorData` any more. `ActorDataFlagComponent` is an ECS
component holding nothing but a bitset of 64-bit words, and
`SynchedActorDataEntityWrapper` caches a pointer to it.

The wrapper's constructor settles the layout in the binary rather than only in
Endstone's header. It is the one function in each build that carries all three
of the wrapper's component hashes exactly once (1.26.40.8 `0x2420140`,
1.26.51.1 `0x2cb5460`, 671B), and the order of its stores is unambiguous:

| offset | `getOrAddComponent<...>` | fnv1a-32 |
|---|---|---|
| `+0` | `SynchedActorDataComponent` | `0xE642016B` |
| `+8` | `ActorDataFlagComponent` | `0xC67426F3` |
| `+16` | `ActorDataDirtyFlagsComponent` | `0xC131F6A8` |
| `+24`, `+32` | `WeakRef<EntityContext>` | |

which is Endstone's declaration order in `synched_actor_data.h`. `+0` was
already execution-confirmed (`sadprobe`), so the second route here is the
binary and the first is the header.

**There is no out-of-line reader.** Scanning every function that carries
`fnv1a("ActorDataFlagComponent")` -- 394 on one build, 395 on the other -- for a
`bt` on what the lookup returns finds exactly one function per build, and it is
the *setter*: `SynchedActorDataAccess::setActorFlag`, 1.26.40.8 `0x2e7c7e0` /
1.26.51.1 `0x2535f40`, 391 bytes, byte-identical in shape. Its tail is what
names it:

```
        movslq %esi, %rcx             ; the flag
        shrq   $6, %rdx               ; the 64-bit word
        movq   (%rax,%rdx,8), %r9     ; value_ is at the component's +0
        btq    %rcx, %r9
        sbbb   $0, %cl                ; ... and returns without writing when it already matches
        cmpl   $63, %esi
        jg     ...
        orb    $1, (%rdi)             ; flags <= 63  -> ActorDataIDs::RESERVED_0 (0)
        orb    $16, 11(%rdi)          ; 64..127      -> RESERVED_092 (92)
        orb    $8, 17(%rdi)           ; above that   -> 139
```

The first two dirty cases are exactly what Endstone's
`synched_actor_data_access.cpp` reconstructs; the third is new in 1.26 and is
the reason the write side calls the engine's function instead of being derived.

So bdsx reads through the cached pointer (`layouts.SynchedActorDataEntityWrapper`
`flagData: 8`, `dirtyFlags: 16`) and writes through `setActorFlag`, passing
`Actor.ctxbase` the way it already passes it to `ActorAttribute::getHealth`.

## `Actor::setNameTag` is in 1.26 after all

The earlier conclusion here -- that it stays missing because its 2024 body does
three things and only one of them could be derived -- was answering the wrong
question. It was looked for as the wrapper's `set<string>`, which really is
inlined everywhere; `setNameTag` itself survives. Intersecting the
`ContainerComponent` type hash (`0x1779E2C7`) with a read of `Actor+0x128`
leaves 19 functions on 1.26.40.8 and 20 on 1.26.51.1, and the smallest is a
410-byte pair, **`0xe0e800` / `0xd4e6f0`**, which is the 2024 body
(`0x19c6ac0`) step for step:

| | 2024 | 1.26 |
|---|---|---|
| the NAME item | `set<string>(this+400, 4, v)` | `items_array_[4]` through `296(%rcx)`, same setter |
| the container | `try_get<ContainerComponent>` → `setCustomName` | the same, by hash |
| the cache | clear the `std::string` at `Actor+880` | at **`Actor+736`** (size `+752`, capacity `+760`) |
| the hash | `HashedString(v)`, `getHash()` → `Actor+480` | `HashedString(v)`, its first qword → **`Actor+392`** |

A near-twin sits beside it (`0xe0d7b0` / `0xd4d5d0`, 592B) and is not it: that
one takes a struct rather than a string -- it tests a bool at the argument's
`+64`, writes a second data item (`items_array_[132]`) and copies a string
*into* `Actor+736` instead of emptying it -- while `0xe0e800` hands its `rdx`
unchanged to all three of the string setter, `setCustomName` and the
`HashedString` constructor, which is `(Actor*, std::string const&)`.

The prototype did not change, so bdsx's existing call site needed nothing. The
fourth step is what makes the execution check decisive: bdsx can compute that
hash itself (`HashedString::computeHash` is one of the `derived()` names), so
`Actor+392` is checkable against a value bdsx produced without the binary.

## Executed (both builds)

`flagprobe` / `flagwrite` / `nameprobe` / `miscprobe` in
`tools/actor-layout-probe.ts`, driven by `tools/host/drivers/flag40.ps1` and
`flag51.ps1` (`work/host-runs/flag40-20260919-212630.txt`,
`flag51-20260919-213451.txt`):

```
PASS nameprobe item:  getNameTag "bdsxnametag" getString(4) "bdsxnametag"
PASS nameprobe cache: the std::string at Actor+736 is "" size 0 (after an "x" sentinel)
PASS nameprobe hash:  Actor+392 0x4ACBBBB7FF556FC5 = computeHash("bdsxnametag")
PASS nameprobe restore
PASS nameprobe floats: FALL_DAMAGE_MULTIPLIER 1, NAMEPLATE_RENDER_DISTANCE_MAX 64, AMBIENT_SOUND_INTERVAL 8
INFO flagprobe base   set: CanClimb HasCollision HasGravity HiddenWhenInvisible PushTowardsClosestSpace
INFO flagprobe inv-on set: Invisible CanClimb HasCollision HasGravity HiddenWhenInvisible PushTowardsClosestSpace
INFO flagprobe inv-off invisible: false
PASS flagwrite low:   Invisible false -> true, dirty id 0 = 1
PASS flagwrite high:  InScaffolding(69) false -> true, dirty id 92 = 1
PASS flagwrite restore
PASS miscprobe hungry: isHungry false at 20/20 on 1.26.40.8, true at 5/20 on 1.26.51.1
```

The name-tag hash is the decisive one for `setNameTag`: bdsx computes FNV-1
over the new name with its own `derived()` code and finds exactly that value at
`Actor+392`, so the fourth step of the body really ran -- the step a
one-liner derivation would have dropped. The sentinel makes the third step
checkable too: an `"x"` written into `Actor+736` before the call is gone after
it.

For the flags, the read side is settled by `effect @a invisibility 60 1 true`
turning flag 5 on and `effect @a clear` turning it off, through a pointer chain
(`Actor+0x128` → `+8` → word → bit) that nothing in the command path knows
about. The write side is settled by the dirty ids: a flag below 64 marks
`ActorDataIDs` 0 and a flag above it marks 92, which is the range split in the
engine's own function and is also what makes flag 69 -- `InScaffolding` under
the *corrected* enum -- land in the second 64-bit word.

Two things the run reported rather than proved. `Breathing` (35) is not set on
a live player, so the sanity check is `HasCollision` and `HasGravity` only. And
`isHungry` was never watched across a transition: 1.26.40.8's world had the bot
at 20/20 and answered false, 1.26.51.1's had it at 5/20 and answered true, and
`effect @a hunger 60 255 true` did not move the attribute within the eight
seconds between console commands.

### What the totem found

`hasTotemEquipped` is `!getEquippedTotem().isNull()`, and on 1.26.40.8 it went
false → true across `replaceitem entity @a slot.weapon.offhand 0
totem_of_undying`. On 1.26.51.1 the same command succeeded and the answer
stayed false -- which was not the derivation's fault. 1.26.51.1 was shipping
`0x235050` for `?isNull@ItemStackBase@@QEBA_NXZ`, from propagation, and that
function takes a second argument in `rdx` and dereferences `(%rcx)` twice.

The real one comes from the 2024 body's shape (`0x1b64fe0`: `cmpb $?, 35(%rcx)`
then `movq 8(%rcx),%rax`). Exactly seven `.pdata` functions per build begin with
that pair and their sizes correspond one to one across the builds (55, 299,
308, 325, 325, 1287), so 1.26.40.8's `0x1bc2260` -- the address that build was
already shipping and that the totem check confirms -- pairs with 1.26.51.1's
**`0x1a549d0`**, and the two bodies are identical instruction for instruction.
With that address and nothing else changed, 1.26.51.1 reads the totem.

This is the rule from `docs/HANDOFF.md` §7.4 arriving from the other side: a
later route disagreed with a shipped name, and the shipped name was the one at
fault.

## `setNameTagVisible`: one flag, and BDS's own reader for it (2026-09-22)

`?setNameTagVisible@Actor@@QEAAX_N@Z` is the last flag writer bdsx asks for, and it needs no
address. The 2024 body (`0x19c6ba0`) is the whole function:

```
movq  (%rcx),%rax        ; vftable
movzbl %dl,%r8d          ; value
movl  $14,%edx           ; ActorFlags::CanShowName
movq  8(%rax),%rax       ; slot 1 = ?setStatusFlag@Actor@@UEAAXW4ActorFlags@@_N@Z
jmpq  *...
```

bdsx already carries `setStatusFlag` as `derived()` (above: `SynchedActorDataAccess::setActorFlag`
on the entity context), and bdsx's `ActorFlags.CanShowName` is 14 after the enum correction. So
`setNameTagVisible(v)` is `setStatusFlag(CanShowName, v)`.

**1.26 has no copy.** `setActorFlag` has 402 direct call sites on 40 and 400 on 51; six on each
build load `edx = 14` first, and none of them is in a function of 2024's shape. The smallest
(40 `0xe1b160` / 51 `0xd5b450`, 223 bytes) is an invisibility setter: it compares with a virtual
getter, plays a sound, then writes flag 14 = `!v` and flag 5 (`Invisible`) = `v`. The rest are
20 KB, 1 KB and 900-byte functions.

**The reader is BDS's own.** Endstone's `actor.h` declares `canShowNameTag()` immediately before
`getNameTagTextColor()`, and slot 33 of both builds' `??_7ServerPlayer@@6B@` is the
`?getNameTagTextColor@Player@@` our table already names. Slot 32 (40 `0xe0e710` / 51 `0xd4e600`,
the same body on both builds) is 2024's one-line `getStatusFlag(14)` (`0x19ac940`) with the read
inlined: the Actor+16/+24 registry and entity words, an inline pool and sparse-set walk for
`0xc67426f3` -- which `tools/entt-typenames.mjs` names `ActorDataFlagComponent` -- and then
`movzbl 1(elem,idx*24); andb $64; shrb $6`, bit 6 of byte 1 = flag 14. It goes into
`resolved` as `?canShowNameTag@Actor@@UEBA_NXZ` (bdsx does not require it) because it is the
thing that says the write reached the component BDS reads.

**Executed** on both builds (`fieldprobe nametag`, drivers `nametag40/51.ps1`,
`work/host-runs/nametag40-20260922-085634.txt`, `nametag51-...`): 10/10 PASS, tsc 0, exit 0,
`Quit correctly`. The address is at slot 32 of the joined player's own vftable. bdsx writes
false / true / false / the original through `setNameTagVisible`, and **BDS's `canShowNameTag()`**
answers the same each time. The step runs twice, once starting from `false` (a fresh bot has
flag 14 clear) and once from `true`. The other direction came for free: after the console
applies and then clears an invisibility effect, BDS's own invisibility setter leaves flag 14
`true`, and both bdsx's `getStatusFlag(14)` and `canShowNameTag()` read `true`.
