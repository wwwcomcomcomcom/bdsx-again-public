# The util classes: names that need no address

Done 2026-09-18, on both builds. `Vec3`'s constants showed the shape of the
question (`findings-layouts.md`, "Constants"): a name bdsx needs, that the
compiler left nothing in the binary for, and that no route can therefore find
-- but whose *value* is known. This is the same question asked of every
value-like helper class bdsx uses, and the answer for seven functions and six
more constants.

## The inventory

`tools/util-classes.mjs` reads the 2024 baseline body of every required name
this build's table still misses and measures whether it is **self-contained**:
no `call`, and no rip-relative reference outside `.rdata`. A self-contained
body is arithmetic on its arguments.

On 1.26.40.8, of 771 missing names: 131 self-contained, 67 accessors already
described by `leaf-accessors.mjs`, 24 read a global, 480 call out, 51
vftables, the rest data or unreadable.

**Self-contained is not the same as portable**, and that is the trap this tool
sets. `ItemStackBase::getAuxValue` calls nothing, but it reads `[rcx+X]` where
X is a field offset that moves between builds: it is an accessor, and the
offset has to be measured per build (`findings-layouts.md`). The names that
can be *carried* are the ones whose memory accesses are into a layout **bdsx
itself defines** -- `Vec3`, `BlockPos`, `ScoreboardId`, `CommandIntegerRange`
-- because then the offsets are bdsx's own, not this build's.

Filtering the inventory that way leaves a short list. It is short because the
rest of what looks like a utility class is not one: `BlockUtils` (8 names),
`EnchantUtils` (3), `CommandUtils` (3), `ExtendedCertificate` (3),
`TeleportCommand` (2), `OnFireSystem` (2) and the twelve
`*ItemComponent::getIdentifier` statics all reach into engine state or return
engine-owned objects. They need addresses, and this route says nothing about
them.

| class | required | still missing | what happened |
|---|---|---|---|
| `Vec3` | 14 | 0 | 12 constants, 2 functions carried |
| `BlockPos` | 5 | 0 | 4 constants, `relative` carried |
| `HashedString` | 1 | 0 | `computeHash` carried |
| `Facing` | 1 | 0 | `convertYRotationToFacingDirection` carried |
| `ScoreboardId` | 2 | 0 | `INVALID` as a constant, `isValid` carried |
| `CommandIntegerRange` | 1 | 0 | `isWithinRange` carried |
| `ActorUniqueID` | 1 | 0 | `INVALID_ID` as a constant |
| `SharedConstants` | 6 | 1 | five per-build constants; `CurrentGameSemVersion` is an object, not a value |
| `CommandPosition` | 2 | 2 | both take a `CommandOrigin`: engine state |
| `NetworkIdentifier` | 2 | 2 | its layout is the engine's, not bdsx's |
| `IdentityDefinition` | 5 | 1 | `Invalid` has no width: bdsx declares the class abstract |

## What bdsx now carries itself

`data/derived.json` is the list, `derived()` in `bdsx/bds/symbols.ts` installs
them, and the binary still wins: `derived` only uses bdsx's implementation when
the table cannot resolve the name, so a build that gains the symbol goes back
to the real function with no code change.

Every one was read out of the 2024 body first and then **written from the
semantics of the type**, never lifted from the bytes.

| name | what it is | second route |
|---|---|---|
| `HashedString::computeHash` | FNV-1 64-bit over the bytes, stopping at the first NUL, empty string = 0 | Endstone's published test vectors for a 1.26 build: **6 of 6** |
| `BlockPos::relative` | one axis moved by `steps`, chosen by the facing | bdsx's own `getSide`, which spells out the same six directions |
| `Facing::convertYRotationToFacingDirection` | `floor(yaw/90 + 0.5) & 3` into `[South, West, North, East]` | Minecraft's quadrant convention, which bdsx's `Facing` enum already encodes |
| `Vec3::directionFromRotation` | the view vector, through the build's own quantisation | the six cardinal answers, which that quantisation makes exact |
| `Vec3::rotationFromDirection` | `atan2` both ways with the build's two float32 constants | the round trip against `directionFromRotation` |
| `CommandIntegerRange::isWithinRange` | min/max, inclusive or exclusive by the byte after `inverted`, then flipped when inverted | — |
| `ScoreboardId::isValid` | `id != ScoreboardId::INVALID.id` | the constant itself, whose id half is `0xffffffffffffffff` |

Two details worth keeping:

- **The sine table.** `directionFromRotation` takes every sine from a
  65,536-entry table indexed by `degrees * -182.04443359375`, so the angle is
  quantised to 360/65536 of a degree *before* the sine. Reproducing the
  quantisation is what makes `directionFromRotation(0, 0)` exactly `(0, 0, 1)`.
  The table is built at startup, so it is not in the file to compare against;
  it is reconstructed as `sin(i * 2pi / 65536)`, which the cardinal answers
  corroborate but which could differ from the engine's in the last ulp.
- **FNV-1, not FNV-1a.** The body multiplies first and xors after. Endstone's
  vectors, from a 1.26 build rather than from 1.21.3.01, are what say the
  algorithm did not change under us.

## The constants that came with them

`ScoreboardId::INVALID` (16 bytes, `{0xffffffffffffffff, null}`) joins the
build-independent set now that bdsx's own `@nativeClass` establishes its width.

`SharedConstants`' version integers are **per-build**, so they live in
`data/constants-<v>.json` (`tools/version-constants.mjs`), merged after the
shared file:

- `Major/Minor/Patch/RevisionVersion` are the build number the table is already
  keyed to. No search, no measurement: `1.26.40.8` *is* the four integers.
- `NetworkProtocolVersion` cannot be read off the version string, so it is
  measured: the server publishes it in the MOTD it answers unconnected RakNet
  pings with (`tools/ping-protocol.cjs`). **2168** on 1.26.40.8, **2193** on
  1.26.51.1.

One bdsx change came with them. Shipping the version integers made
`check.ts`'s BDS-version check *fire* for the first time -- and it compared
them against `version-bds.json`, the version bdsx was released against
(1.21.3.01), so it killed the server with "Required version: 1.21.3.01". The
check now compares against the version the table was built for, which is the
thing those integers can actually contradict.

## Measured

`tools/derived-probe.ts` (`derivedprobe` and `versionprobe` on the console),
run under the full launcher on both builds: **45 of 45 pass on 1.26.40.8 and
45 of 45 on 1.26.51.1**, lifecycle clean on each -- `Server started.`,
`Quit correctly`.

That includes the six Endstone hash vectors through bdsx's own `HashedString`,
six cardinal directions, four inverse rotations, a 117-angle round trip (worst
error 0.005 degrees), ten yaw quadrants, six facings of `relative`, both bound
modes and the inverted flag of `isWithinRange`, `ScoreboardId::isValid` either
way, the four version integers against the table's own version, and
`NetworkProtocolVersion` against the number the running server answers its own
ping with.

Names bdsx can resolve: **314 in the table plus 7 carried = 321** on
1.26.40.8, **270 plus 7 = 277** on 1.26.51.1. Coverage by address is
unchanged at 255 and 247 -- none of these ever had an address.

## Rules this added

- **Self-contained is not portable.** A body that calls nothing can still read
  a field offset that moves between builds. What makes a name carryable is that
  the layout it touches is one bdsx defines.
- **Re-derive from the type, never from the bytes.** The 2024 body says what
  the function *means*; the implementation is written from that meaning. It is
  also the only version of this that is licence-clean.
- **A carried name is a fallback, not a replacement.** `derived()` prefers the
  binary whenever the table has an address, so this route can never mask a
  symbol a later build resolves.
- **Shipping a constant can switch on code that was dormant.** The version
  integers had been missing since the start, and the check that reads them had
  never run. Anything promoted from "missing" to "present" needs the lifecycle
  run, not just a unit check.

## Added since (the list `data/derived.json` is authoritative for)

The table above is the first batch. Ten more were added by later work and
are recorded where they were found, not here: `GameRules::getRule` /
`hasRule` / `nameToGameRuleIndex` and `Level::updateWeather`
(`findings-slots.md`), `ActorCommandOrigin`'s constructor,
`Random::Crypto::generateUUID`, `NetworkIdentifier::equalsTypeData` /
`getHash` (`findings-instances.md`), `Actor::isSurvival`
(`findings-components.md`), and:

| name | what it is | why it is carried |
|---|---|---|
| `Actor::hasEffect` | `getEffect(mobEffect) != null` | 1.26 keeps no out-of-line copy: 2024's was a 20-byte thunk (`call getEffect; test; setne`) and the inliner removed it. Checked by `tools/actor-layout-probe.ts` `effprobe` on both builds |

`hasEffect` is also the first name to reach `derived()` by being **taken
away** from the table rather than by never having an address: propagation
had shipped it at the `getEffect(unsigned int)` overload
(`findings-components.md`, "What the second route caught"). That is a case
the rules did not cover before -- a carried name can be the *repair* for a
wrong one, and the repair is only safe because `derived()` steps aside the
moment a build resolves the name for real.

## `std::_Allocate` and the heap underneath BDS (2026-09-19)

`??$_Allocate@$0BA@U_Default_allocate_traits@std@@$0A@@std@@YAPEAX_K@Z`
(`bdsx/msalloc.ts`) is the one name that blocks **every JS-side
allocation**: `CxxVector`'s growth, `CxxString`'s resize, and therefore
`Packet.allocate` and anything that builds a packet. `ServerPlayer::
setAttribute` is where it surfaced -- it sends an `UpdateAttributesPacket`
and threw `Symbol not found` on the way.

It cannot be found as an address:

- the 2024 body (0x1099510, 0x54 bytes, `sub rsp,0x28; cmp rcx,0x1000; jb`)
  **starts no function in either 1.26 build**. The alignment idiom it ends
  with (`add rax,39; and rax,-32; mov [rax-8],rcx`) is in hundreds of
  places; all of them are inlined copies.
- `??2@YAPEAX_K@Z` (`operator new`), which 2024's tail-jumps to, is not
  resolved either, and the strings that would anchor it exactly --
  `"void *__cdecl operator new(unsigned __int64)"` and
  `"...\Core\src\Memory\MemoryOperators.cpp"`, both referenced by the 2024
  body's failure path -- are **absent from both 1.26 builds**. The
  assertion text was stripped.

It does not need one. What `_Allocate` is *for* is a heap, and the heap is
knowable exactly, because imports are exact:

```
??2@YAPEAX_K@Z                          2024 0x272e510
  -> Bedrock::Memory::getDefaultAllocator()          0x27300b0
  -> InternalHeapAllocator::allocate(size)           0x272f5d0
       mov eax,1; cmp rdx,rax; cmovb rdx,rax; mov rcx,rdx
       jmp [api-ms-win-crt-heap-l1-1-0.dll!malloc]
     InternalHeapAllocator::release(ptr)             0x2730e80
       mov rcx,rdx; jmp [api-ms-win-crt-heap-l1-1-0.dll!free]
```

and the same wrapper survives in 1.26 under the new compiler --
`mov rcx,rdx; cmp rdx,1; adc rcx,0; jmp [malloc]` at **0x13bb671** on
1.26.40.8 and **0x12c1171** on 1.26.51.1, with `mov rcx,rdx; jmp [free]`
immediately after it in both. So **BDS's `operator new` bottoms out in the
ucrt `malloc` that `dll.ucrtbase` already binds**, which is also why
upstream bdsx's `msAlloc.deallocate` -- `capi.free`, i.e. `ucrtbase.free`,
on memory BDS allocated -- was correct all along.

So the route is `derived()`: bdsx writes the 2024 body with `capi.malloc`
in place of `operator new` (below 4096 return it; at or above, allocate
`n + 39`, round up to a 32-byte boundary and keep the original pointer at
`[-8]`, which is exactly what the existing `deallocate` undoes), and throws
where `operator new` would have called the new-handler.

Its rule, added to this file's: **a body is portable when what it touches
is a layout bdsx defines _or an interface both sides import_.** The ucrt
heap is the second kind. What must be re-checked per build is the one
assumption -- that `getDefaultAllocator` still hands back a wrapper over
the imported `malloc` -- and that is a two-minute scan for the tail-jump,
so it belongs in the new-build procedure (`next-steps.md`, Q6).

### What it checks out as (2026-09-19)

`tools/alloc-probe.ts`, on both builds, `Quit correctly` and exit 0:

| step | what it exercises | result |
|---|---|---|
| `allocprobe` heap | `CxxStringWrapper.reserve` 100 -> 6000 -> 9000: the small path, the >= 4096 path, and freeing a big block back through `[-8]` | **PASS**, and the big pointer is 32-byte aligned |
| `allocprobe` vector | 3000 `int32` pushed into a `CxxVector`, growing through 4096 several times, then destructed | **PASS** |
| `allocprobe pk0` | `UpdateAttributesPacket.allocate()` then `dispose()`, nothing of bdsx's inside: BDS creates and BDS destroys | **PASS** |

The name that used to throw `Symbol not found` now resolves to bdsx's own
body, and every allocation bdsx makes for itself round-trips.

### Where it still stops: filling a packet

`ServerPlayer::setAttribute` still kills the server, and the probe was split
until the step was named. It is **not** the allocator:

```
[alloc] INFO pk allocated ...            <- BDS created the packet
[alloc] INFO pk data constructed
[alloc] INFO pk name set "minecraft:health"
[alloc] INFO pk pushed, size 1           <- bdsx's vector and string are in it
[alloc] INFO pk local AttributeData destructed
                                          <- pk.dispose() never returns
```

`pk0` proves BDS can create and destroy an untouched packet of the same
class. `pk2` -- the same thing with an element carrying **no heap string** --
dies in the same place, so it is not the strings either. What is left is the
1.26 layout of `UpdateAttributesPacket` / `AttributeData`: bdsx writes its
`attributes` vector at the 2024 offset, and the packet's own destructor then
runs over whatever it actually corrupted. bdsx's `sizeof(AttributeData)` is
88. The first 0x60 bytes of a freshly created packet, which BDS laid out
(`allocprobe pk0`), are:

```
          +0x00 vftable   +0x08              +0x10        +0x20
1.26.40.8 0x7ff6eafcdf10  0x0000000100000002 <a pointer>  0x7ff6ed127e28
1.26.51.1 0x7ff6f41d87c0  0x0000000100000002 0            0x7ff6f655e600
```

-- a second image pointer at `+0x20` that bdsx's declaration does not
account for, and `+0x30`..`+0x50` all zero on both. That is the next thing
to work out (`next-steps.md`), and it is the same family of problem as
`MobEffectInstance` and `AttributeInstance`, not an allocator problem.

### Where it stopped, resolved (2026-09-19)

It was the layout, and the answer is in `findings-layouts.md`,
"`AttributeData`: a struct that grew in the middle". Two corrections to the
section above:

- The second image pointer at `+0x20` is **not** an unaccounted vftable. It is
  `Packet::handler_`, an `IPacketHandlerDispatcher*` into `.data`.
  `sizeof(Packet)` is still 0x30, so no other packet class shifted and this
  never touched Q5.
- The element size was the whole of it: `AttributeData` is 96 bytes in 1.26,
  not 88, because the protocol added `"Default Min Value"` and
  `"Default Max Value"` at `+0x10` and `+0x14`. bdsx pushed at 88-byte stride
  into storage BDS's destructor then walked at 96.

With `bdsx/bds/packets.ts` corrected, `pk2`, `pk` and `packet` all PASS on
both builds and the session exits 0. The allocator work above was never
implicated, and stands.

## `SharedConstants::CurrentGameSemVersion`: a constant-initialized 24-byte SemVersion (2026-10-02)

`ServerInstance.getGameVersion()` returned null on 1.26 because neither table had the name.

- **2024** constructed it at load time: `SharedConstants::dynamic initializer for 'CurrentGameSemVersion'` (`0xbd50`) calls
  `SemVersion(1, 21, 3, "", "")` into `0x33d2a00`, and bdsx's `SemVersion` was that build's 0x70 bytes of
  `std::string`.
- **1.26's `SemVersion`** is Endstone's `sem_version.h`, the same in 0.11.7 and HEAD. It is 24 bytes: `u16`
  major/minor/patch, `bool` valid and `bool` any, then pre-release and build-meta as `Bedrock::StaticOptimizedString`.
  A `StaticOptimizedString` is a packed pointer whose bits 48..55 hold the length, or 128 when the string is heap data
  with its length in the 8 bytes before it.
- **1.26 has no dynamic initializer.** The value is constant-initialized in `.rdata`. There are 14 copies of
  `{1,26,40,valid}` on 40 and 17 copies of `{1,26,51,valid}` on 51. The pre-release pointer aims at an empty literal
  and build-meta is null.
- The `(1, 26, 40)` constructor calls found by immediate scan go to `0x5b3640`. That is a different class (five ints
  and a `-beta` suffix), not SemVersion.

**Which copy.** 2024's `Vex::initializeComponents` reads `CurrentGameSemVersion` exactly four times. On both 1.26 builds,
the same function (by its table name) reads one copy four times:

| build | copy | its readers | Vex reads at |
|---|---|---|---|
| 40 | `0xa5f6480` | 40 | `0x2397c63`/`c89`/`0x23980fa`/`120` |
| 51 | `0xa710e90` | 42 | `0x299b153`/`179`/`5ea`/`610` |

Every other copy has one to three readers. So two routes agree: the value, and the 2024 reader. The table ships that
copy under the 2024 decoration.

bdsx's `SemVersion` now has the 1.26 layout (bdsx `3d286763`). `preRelease`, `buildMeta` and `fullVersionString` are
read-only getters, and `fullVersionString` is built the way `asString` builds it.

**Executed** (`conprobe version`, drivers `conx40/51`): `1.26.40` and `1.26.51` against the table's version, valid true,
any false, empty strings, `fullVersionString` `"1.26.40"` / `"1.26.51"`. 3/3 PASS on each build.
