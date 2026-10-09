# Riding: one lookup bdsx does itself, and two prototypes that grew (2026-09-21)

Queue item Q1-0(a). Five names: `?isRiding@Actor@@QEBA_NXZ`,
`?isRiding@Actor@@QEBA_NPEAV1@@Z`, `?isPassenger@Actor@@QEBA_NAEBV1@@Z`,
`?stopRiding@Actor@@QEAAX_N00@Z`, and the entry the other four go through,
`?getVehicle@Actor@@QEBAPEAV1@XZ`. Two of them ship as addresses under names
bdsx did not have before; three ship as `derived()`; the entry is `derived()`
too, on top of a mechanism that is new here -- **bdsx now does the EnTT
component lookup itself.**

Both builds: `ride40` / `ride51`, **21/21 PASS, exit 0, `Quit correctly`**
(`work/host-runs/ride40-20260921-132937.txt`, `ride51-20260921-132937.txt`).

## What 1.26 kept, and what it did not

The queue expected route 10 to hand over an address: 2024's `Actor::getVehicle`
(`0x19b50e0`, 294 B) is already an EnTT lookup, so the hash just had to be
recomputed for the target build. It does not, and the reason is worth writing
down because it is the same reason the health pair went the way it did
(`findings-components.md`).

`fnv1a("PassengerComponent") = 0x98e40c0e` and
`fnv1a("VehicleComponent") = 0x161f61ea`, on both 1.26 builds, and each has
around 200 users. But **not one of them is in the Actor translation unit with
the right shape**: filtering the Passenger users to the Actor neighbourhood
(1.26.40.8 `0xde0000`-`0xe20000`, where `getEntityTypeId` `0xde5990`,
`startRiding` `0xdf3cc0` and `setNameTag` `0xe0e800` live) leaves exactly one
function, `0xdeb730`, and it is a riding-offset interpolation, not a getter.
The callee intersection says the same thing from the other side: of 2024's 61
callers of `getVehicle`, the six this table has 1.26 addresses for share **no
callee at all** (`canPickupItem@Zombie` has one callee in 1.26 and 116 bytes in
2024). Every caller inlined it.

The 2024 body shows why that was easy. `getVehicle` is a lookup and a fetch,
and the free functions around it are four-line wrappers over a leaf
`try_get<PassengerComponent>(EntityContext const&)`:

```
?getVehicleID@ActorRiding@@   0x186c4a0  57 B   comp = try_get(ctx); return comp ? *(comp+8) : INVALID
?isPassenger@ActorRiding@@    0x186fa70  54 B   comp = try_get(ctx); return comp && !isNull(comp->entity) && comp->actor_id != -1
```

`tools/leaf-funcs.mjs` has already established that 1.26 keeps almost none of
those leaves. Endstone agrees from a third direction: its `actor.cpp`
**reimplements** `getVehicle` and `isRiding` in its own source rather than
resolving them, and it has `Actor::stopRiding` and `Actor::hasPassenger`
commented out.

## The lookup, and where the offsets come from

What 1.26 does keep is the lookup itself, out of line in nothing and inline in
everything -- and it is the *same instructions* every time. `Actor::getEntityTypeId`
(both builds `0xde5990` / `0xd25840`, 213 B, byte-identical), `Actor::getRuntimeID`
(231 B) and `Player::getAbilities` differ only in the component's size: 4 bytes,
8 bytes and 1464 bytes come out of the same page arithmetic. All three are names
this table resolves by address on both builds, so the offsets are read off code
we have already confirmed:

```
registry = *(Actor + 16)                  layouts.Actor.enttRegistry
entity   = *(uint32*)(Actor + 24)         layouts.Actor.entityId

# the pool map: open-addressed on entt::type_hash
begin = *(registry + 72)   end = *(registry + 80)      poolsBegin / poolsEnd
mask  = ((end - begin) >> 3) - 1            (32-bit: `decl %r8d`)
i     = *(uint64*)(begin + (mask & hash) * 8)          -1 is empty
nodes = *(registry + 104)   nodesEnd = *(registry + 112)   nodes / nodesEnd
loop: node = nodes + i*32; if (*(uint32*)(node + 8) == hash) break; i = *(uint64*)node
if (node == nodesEnd) miss                              (the end sentinel)
storage = *(node + 16)                                  nodeStorage

# the storage: a sparse set of 2048-entry pages over 128-element pages
index = entity & 0x3ffff                                entityBits 18
page  = index >> 11                                     sparsePageBits 11
sparse = *(uint64*)(*(storage + 8) + page*8)            sparseBegin / sparseEnd bound it
entry  = *(uint32*)(sparse + (index & 0x7ff) * 4)
if (((entry ^ entity) & ~0x3ffff) != 0) miss            the version half must match
if ((entry & 0x3ffff) == 0x3ffff) miss                  entt::null
packed = *(uint64*)(*(storage + 80) + ((entry & 0x3ffff) >> 7) * 8)   packed, packedPageBits 7
component = packed + (entry & 0x7f) * sizeof(Component)
```

The asm folds the two miss conditions into one compare
(`xorl %edx,%eax; cmpl $0x3FFFE,%eax; ja`); bdsx writes them separately, which
is the same predicate.

This ships as `layouts.EnTTRegistry` (plus two keys on `layouts.Actor`) and
bdsx walks it in `bds/implements.ts`. The hash is computed on the bdsx side --
FNV-1a-32 of the bare component name is the documented scheme for these builds
(`findings-components.md`), and the component names are Endstone's headers.

> The scheme is the *build's*, not a universal: 2024 hashes
> `PassengerComponent` to `0x8CE8DDF7`. That costs nothing here because bdsx
> only runs against 1.26, and because `derived()` steps aside the moment a
> build resolves the name -- but a future build that changes the scheme has to
> change this, and the lookup will simply miss rather than read garbage.

## The two component layouts

Endstone's headers, and the 2024 bodies read them the same way:

| | |
|---|---|
| `PassengerComponent` | one `StrictActorIDEntityContextPair`, 16 B: `StrictEntityContext entity` (id at +0, registry id at +4) then `ActorUniqueID actor_id` at +8. 2024's `getVehicleID` returns `*(component + 8)`. |
| `VehicleComponent` | `std::vector<StrictActorIDEntityContextPair> passengers` at +0, `static_assert(sizeof == 24)`. |

So `getVehicle()` is the PassengerComponent's id through `Level::fetchEntity`
(`0x7390f0` / `0x7d14b0`, already in the table), `isRiding()` is that against
null, `isRiding(Actor*)` walks the chain, and `isPassenger(ride)` searches the
VehicleComponent's vector. 2024 compares the ids; bdsx resolves each id through
`fetchEntity` and compares the actor, which avoids leaning on
`getOrCreateUniqueID` (propagation) for an answer.

## `Actor::stopRiding` gained a fourth bool -- and it has an address

`?stopRiding@Actor@@QEAAX_N00@Z` (three bools) does not exist in 1.26. The
function does: **40 `0xdf48f0` / 51 `0xd34600`, 1087 B on both.** Three routes,
none of them a match count:

1. **Caller intersection.** Of 2024's seventeen callers of `0x19c9290`, two are
   in this table for 1.26 (`Player::die`, `Actor::startRiding`); besides
   `Actor::getOrCreateUniqueID` they share exactly one callee, and it is this
   one. The same intersection on the other build gives the other address, and
   `tools/byte-find.mjs` finds 40's first 48 bytes exactly once in 51's `.text`,
   at `0xd34600`.
2. **A string anchor, independent of (1).** 1.26 inlined all of `RideCommand`
   into one function -- 40 `0x3d685b0` (11,870 B) / 51 `0x3b010d0` (12,550 B),
   the only function in each image that `lea`s the `commands.ride.` literals
   (eighteen times) -- and it calls this address directly, exactly as 2024's
   `?stopRiding@RideCommand@@` calls `Actor::stopRiding`.
3. **The shape, and what the body does with it.** The prologue keeps `edx`,
   `r8d`, `r9d` and then reads a fourth bool off the stack
   (`movzbl 96(%rbp), %r15d`); Endstone's `actor.h` reconstructs the same 1.26
   signature independently --
   `stopRiding(bool exit_from_passenger, bool actor_is_being_destroyed, bool switching_vehicles, bool is_being_teleported)`,
   commented out because Endstone never resolved the symbol. And the body makes
   **five** `assure`-backed component adds where 2024 made four: one per bool
   plus the request flag.

It ships under the four-bool decoration `?stopRiding@Actor@@QEAAX_N000@Z`, and
bdsx's `events.entityStopRiding` hooks that with a four-bool prototype;
`EntityStopRidingEvent` gained `isBeingTeleported`.

## `Actor::startRiding` gained a third -- the address was right, the name was not

The table already carried `0xdf3cc0` / `0xd339d0` for
`?startRiding@Actor@@UEAA_NAEAV1@@Z` (Endstone's header order, anchored), and
bdsx both **called** it (`procHacker.jsv`) and **hooked** it
(`events.entityStartRiding`) with the 2024 two-argument prototype. Both builds'
bodies read a third:

```
cmpq %rcx, %rdx ; je fail          you cannot ride yourself
testb %r8b, %r8b ; jne skip        <- 2024's 0x19c8d00 reads no third register
movq (%rsi),%rax ; movq 744(%rax),%rax ; call *          ride->vftable[93], canAddPassenger
testb %al,%al ; je fail
```

So the bool skips the vehicle's `canAddPassenger` check, and 2024's behaviour is
that bool `false` -- which is what bdsx's one-argument `startRiding(ride)` now
passes. The address ships as `?startRiding@Actor@@UEAA_NAEAV1@_N@Z`; the 2024
name is in `candidates-instances-<v>.json` `retracted` so nothing can hook a
three-argument function with a two-argument prototype. This is the state
`Mob::_hurt` was in when it killed the server on the first hit
(`findings-slots.md`, "Changed signatures"); `entityStartRiding` had simply
never been fired, so nobody had paid for it yet.

## What was run

`tools/actor-layout-probe.ts` `rideprobe <before|arm|mob|gone|riding|after>`,
drivers `ride40.ps1` / `ride51.ps1`. The console does the moving:

```
summon minecart ~1 ~ ~1 ; summon chicken ~3 ~ ~3 ; rideprobe arm
ride @e[type=chicken,c=1] start_riding @e[type=minecart,c=1] ; rideprobe mob
kill @e[type=chicken,r=12] ; kill @e[type=minecart,r=12]
summon minecart ~1 ~ ~1 ; ride @s start_riding @e[type=minecart,c=1] ; rideprobe riding
ride @s stop_riding ; rideprobe after
```

Each pair is checked from both sides, which is what makes it more than a
smoke test: `rider.getVehicle()` is the **same pointer** as the vehicle
(PassengerComponent), `vehicle.isPassenger(rider)` is true (VehicleComponent),
`vehicle.isRiding()` and `rider.isPassenger(vehicle)` are false, and
`rider.isRiding(rider)` is false. After `stop_riding` the player rides nothing
**and** the minecart it left carries nobody. Both events fire through bdsx's own
hooks: `Chicken -> MinecartRideable` and `Player -> MinecartRideable`, and two
stops -- `exit=true destroyed=false` for the console's `stop_riding` and
`exit=true destroyed=true` for `kill` on a riding chicken. The second bool moves
while the other three stay, which is the four-bool prototype answering rather
than a coincidence of register contents.

`data/events-fired.json` gains `entityStartRiding` and `entityStopRiding`:
`event-coverage.mjs` goes UNFIRED 13 -> 12, NO TARGET 34 -> 33, FIRED 9 -> 11.

## Three wrong turns, written down

1. **A pig is not a vehicle you can order somebody into.** The first driver used
   `summon pig` and got
   `Riders that did not meet ride conditions: Chicken` / `: bdsxprobe` from BDS
   itself -- an unsaddled pig refuses. A minecart accepts anyone.
2. **The smoketest world rides by itself.** The first run's `rideprobe mob` went
   green on `Cow -> BoatRideable`: a pair the engine made before any command ran.
   That is evidence the read path works, but it is not the pair the driver was
   about, and the negative control then failed because that cow was still in its
   boat. Hence `rideprobe arm`, which forgets the captures immediately before
   the console makes the pair under test, and prints what it forgot.
3. **A chicken gets back in.** On 1.26.40.8 the chicken re-entered the minecart
   within the eight seconds between `stop_riding` and the next command (two
   `entityStartRiding` events for one command), which both failed the negative
   control and left the cart occupied when the player tried to board. 1.26.51.1
   did not do it. The fix is not a longer wait: the mob and its cart are killed
   before the player's half, and the negative control moved onto the player's
   own vehicle, which nothing else wants.

## What this opens

The lookup is general. `enttComponent(actor, hash, size)` is now a bdsx-side
primitive, so any Actor getter 1.26 inlined away can be derived from the
component it reads rather than hunted for as an address -- which is the other
half of route 10 (`findings-components.md` finds *which* component a function
touches; this reads it). The two things it needs are the component's name, for
the hash, and its layout, both of which are Endstone headers. It is also the
cheapest route to the Q1 names that are one field of one component.
