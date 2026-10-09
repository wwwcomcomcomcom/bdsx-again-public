# Reference: route guides and commands

> **Not auto-loaded.** Moved out of `CLAUDE.md` on 2026-09-23 so the documents every session loads stay
> small (`node tools/docs-check.mjs` checks the budget). Read the section you need: route guides say which
> findings doc owns a route and the one rule that doc earned; the commands section regenerates everything
> under `work/` and every candidate file. Environment, procedures and the rules that apply everywhere are in
> `docs/HANDOFF.md`; the do-not-retry table is at the end of `docs/next-steps.md`.

## Route guides: what each findings doc settled, and its rule

`docs/next-steps.md` has the table with measurements. The short list: byte
matching, wildcard signatures, sliding windows, mnemonic sequences, RTTI,
import anchoring as a bulk method, BinDiff, version chaining. **No newer
PDB-bearing BDS build exists** — Mojang removed it in 1.21.20.

`docs/findings-inventory.md` is A1 of the architecture plan: every missing or
derived name gets a class (`tools/arch-inventory.mjs`, hand verdicts in
`data/arch-classes.json`). Rule: **"Endstone does not declare it" is not
evidence of `gone`** (it calls 52% of known-live names gone); the EnTT
type-name list in the binary rules `gone` out for a class, and a sweep that
shows one storage gone does not show the concept gone. And the required set is what bdsx's **code**
names: `scrape-symbols.mjs` blanks comments and error-message strings before its catch-all regex (29 names were comment-only, 2 were `throw Error(...)` text).
A1-c added a second string signal (`tools/image-names.mjs`): a lambda's type descriptor carries its
enclosing function's **full decorated name**, so a 2024 decoration found there exists in 1.26 with that
exact signature (`live`, address still open); `pretty_function() [Type = X]` names types the type-info
scan misses. And 1.26 calls `BlockLegacy` **`BlockType`**: look it up under that name in Endstone.
Its section 29 is the release check of the stock examples: `tools/host/index-release.ts` (drivers `rel40/51`) loads
each example on its own and judges its red lines against a known list, and `rels40/51` run bdsx's own
`import "./example_and_test"`. Rule: **an example's import chain hides everything after its first throw**, so load
each example separately before trusting a quiet log.

`docs/findings-slots.md` is what happened when the walk's open slots were
filled by position (wrong), by execution (right), and by Endstone's header
order (right, and the cheapest route there is: route 8), and how names carry
between adjacent builds.

`docs/findings-vftable.md` is the route that works for virtual methods and
vftables; its single-walk precision is 90-95%, so its output is promoted only
where two seed-independent walks agree. Packet vftables come from live
objects, never from the walk.

`docs/findings-reach.md` is how vftables are read off live objects
(`tools/reach-probe-launcher.js`: member scan, getters called by Endstone
slot index, block names at `+0xe8`), and why a vector walk must never touch
a world-sized container on the game thread.

`docs/findings-synched.md` is the SynchedActorData seam: the nine surviving
wrapper getters and how each names its own type by the constant it compares,
`Actor::entity_data` at `+0x128` as a `lea` accessor rather than an address,
and the two propagation addresses that were shipping for it and were wrong
(a trade function and an EnTT sparse-set lookup). Its rule: a getter whose
body is one of N siblings is confirmed by what the siblings do *not* accept --
the int and float sweeps return values at disjoint ids.

`docs/findings-nbt.md` is bdsx's NBT layer on 1.26: the twelve tag vftables by
two routes (the `getId` constant, the variant move visitor), `put`/`get`, a
non-virtual `Actor::save` found by its SSO-immediate keys
(`tools/string-users.mjs`), `DefaultDataLoadHelper`'s table, what bdsx carries
as `derived()`, and three fixed `CxxMap`/`ListTag` bugs. Its rule: an address
that returns a pointer can hide under a `bool` name (`contains` was `get`),
so read one caller's use of `rax` before promoting a `bool` function.

`docs/findings-scoreboard.md` is the scoreboard on 1.26 (`ServerScoreboard`'s
vftable, `addObjective`, `derived()` readers over the containers) and, in
section 8, command soft enums: `addSoftEnum` and the three value members by
address, the inlined `updateSoftEnum` as `derived()`. Its rule: when a class's
constructor is inlined into its senders, the functions that `lea` its vftable
are the senders -- `UpdateSoftEnumPacket`'s named all three soft-enum members.

`docs/findings-utils.md` is the inventory of missing names that need no
address at all, and the ones bdsx now carries itself (`data/derived.json`,
installed by `derived()` in `bds/symbols.ts`, which still prefers the binary
when the table resolves a name). Its rule: self-contained is not portable --
what carries is a body whose memory accesses are into a layout bdsx defines.

`docs/findings-layouts.md` is why 112 required names are offsets rather
than functions and how `symbols.json` `accessors` become code in bdsx; its
second half is the same move for 17 static const data members, which ship as
`constants` (bytes) because 1.26 keeps no storage for them at all -- the route
Endstone takes for `Vec3`, which it never resolves as a symbol.

`docs/findings-components.md` is route 10, the one for the Actor getters ECS
made unrecognisable: EnTT's type hash is FNV-1a-32 of the bare component
name, so `node tools/component-hash.mjs <v> <ComponentName>` lists every
function that looks that component up. Pick by body, confirm by execution
(`tools/actor-layout-probe.ts`). **Do not guess the name** -- 2024 spells the
jump flag `FlagComponent<MobIsJumpingFlag>` and 1.26 spells it
`MobIsJumpingFlagComponent`, and a guess that misses looks exactly like a
component the build does not have. The build carries its own names:
`entt::type_info<T>` writes the hash, the name and the name's length in a fixed
25-byte sequence, and `tools/entt-typenames.mjs` reads all of them back (3,771
on 1.26.40.8, 3,990 on 1.26.51.1, half a second), keeping an entry only when
fnv1a-32 of the name equals the hash. It is 1.26-and-later only (the 2024
baseline emits no such descriptor) and it is not exhaustive, so a miss means
this scan did not find it, and the user count still decides.

```sh
node tools/entt-typenames.mjs work/bin/<v>/bedrock_server.exe --out=work/entt/typenames-<v>.json
node tools/entt-typenames.mjs work/bin/<v>/bedrock_server.exe --grep=jumping   # or --hash=89ABB47B
node tools/image-names.mjs <v>                   # -> work/entt/image-names-<v>.json (lambda scopes, pretty_function types)
node tools/image-names.mjs <v> --grep=CommandSelectorBase
node tools/engine-deps.mjs [--missing]          # every layout/symbol/component the engine layer (bdsx/bds/engine) reads, per build
node tools/arch-gone-sweep.mjs                   # existence signals per class with an unexplained unknown
```

The 39 Actor/Mob/Player names still missing are sorted by what each one needs
-- a component, one offset, another unresolved name, or an address -- in
`docs/findings-components.md`, "The 39 that are left".

`tools/field-offset.mjs` is how a one-byte field is followed across builds when the
getter was inlined away: `shared` intersects the byte displacements of two named
functions (a singleton in the baseline is the field), `users` lists every function
that touches one displacement so the access sets can be compared as wholes. This is
how `Player::isSpawned` moved 2904 -> 1801 (`docs/findings-layouts.md`, "isSpawned").

```sh
node tools/field-offset.mjs shared <exe> <rva-hex> <rva-hex> [...]
node tools/field-offset.mjs users  <exe> <disp-hex> [data/baseline-symbols.json]
```

`tools/leaf-funcs.mjs` is how code that `.pdata` does not describe is found:
x64 Windows files no `RUNTIME_FUNCTION` for a leaf, so thunks and register-only
lookups are invisible to every tool here that starts from `tools/pdata.mjs`.
Collecting direct `E8/E9` targets in `.text` that are not `.pdata` starts gives
the leaf entry points (61% are exactly a symbol on the baseline). 1.26 inlined
almost all of them away -- `docs/findings-components.md`, "The health pair".

```sh
node tools/leaf-funcs.mjs <exe> [--out=leaves.json] [--find=<hex>] [--at=0x<rva>] [--min-callers=N]
```

`docs/findings-binexport.md` is worth reading before touching Ghidra: one
BinExport run burned 4h45m and had to be killed, and the fix was patching a
pass out of the extension (`tools/PatchBinExport.java`).

## Commands: regenerating what is gitignored

```sh
# the 1.21.3.01 baseline: exe + PDB, bdsx's published pdbcache for it, and the full 713,055-symbol table
# (151MB; tools/host/setup-lab.mjs runs this; the second line is the last step on its own)
node tools/fetch-baseline.mjs
node tools/dump-pdbcache.mjs work/pdbcache-1.21.3.01.bin data/baseline-symbols.json 1.21.3.01

# a symbols.json + 28-byte stub for a build: merge every candidate file first
# (resolved > live instances > live packets > vftable walk > propagation; hook
# targets only from the first three, and only if 16+ bytes with a .pdata entry; a low-trust
# required name must pass the argument-shape check against its 2024 namesake, and names in
# candidates-instances `retracted` are removed)
node tools/merge-symbols.mjs <v> data/merged-<v>.json
node tools/make-table.mjs --exe=<exe> --bdsVersion=<v> --symbols=data/merged-<v>.json --out=data/symbols-<v>.json
node tools/make-pdbcache-stub.mjs --exe=<exe> --mainRva=0x... --out=work/pdbcache-<v>.bin

# the vftable candidates for a build (walk A, walk B, corroborate, propagate, walk B2)
node tools/vftable-pipeline.mjs 1.26.40.8 work/derived/pairs.json data/candidates-corroborated-1.26.40.8.json

# the functions that store a held vftable (constructors, destructors, and callers that
# inlined one); the pick is by body against the 2024 body, then execution (findings-instances.md)
node tools/ctor-from-vftable.mjs work/bin/<v>/bedrock_server.exe work/vft/scan-<v>.json 0x<vftableRva>...

# packet handlers (NetEventCallback slots) by the baseline's local override pattern, kept where
# the two builds agree two slots apart (findings-instances.md, "Packet handlers by override pattern")
node tools/netevent-align.mjs 1.26.51.1 0xa715340 --out=work/vft/netevent-1.26.51.1.json
node tools/netevent-align.mjs 1.26.40.8 0xa5f9940 --out=work/vft/netevent-1.26.40.8.json --pair=work/vft/netevent-1.26.51.1.json

# a lambda scope (image-names.mjs) -> the function that owns the lambda: TypeDescriptor -> _Target_type ->
# _Func_impl vftable -> who builds it (findings-slots.md "sendActorCreated")
node tools/lambda-owner.mjs 1.26.40.8 '??sendActorCreated@ActorEventCoordinator@@'
# Endstone's per-release symbol table (src/bedrock/symbols/windows.h) is a name -> RVA table for the
# exact binary: 16/16 and 18/18 against ours. Read it first for a new build (next-steps.md, Q6).

# required names one 1.26 build ships and the other lacks, carried where the pair map and the body agree
node tools/cross-build-fill.mjs 1.26.40.8 1.26.51.1 --out=data/candidates-crossbuild-1.26.51.1.json
node tools/cross-build-fill.mjs 1.26.51.1 1.26.40.8 --out=data/candidates-crossbuild-1.26.40.8.json

# Level virtuals from Endstone's header order, anchored on the confirmed slots (findings-slots.md, route 9)
node tools/endstone-slots.mjs work/endstone-0.11.7 1.26.40.8 work/vft/es-level-1.26.40.8.json --families=level
node tools/level-anchored.mjs 1.26.40.8 work/vft/es-level-1.26.40.8.json --pair=work/vft/level-anchored-1.26.51.1.json

# names carried from the previous build by vftable alignment (3,460/34 on 1.26.51.1)
node tools/carry-pipeline.mjs 1.26.40.8 1.26.51.1 work/derived40to51

# vftables read from live objects on the lab: a bot joins, console commands summon,
# damage, place and teleport, and the launcher scans what the captured objects hold
# (RP_CALL: getters by Endstone slot; docs/findings-reach.md; the annotator is reach-name.mjs)
#   run-client-probe.ps1 -Launcher reach-probe-launcher.js -Bot livebot.cjs -Env @{RP_CONFIG=..;RP_CAPTURES=..;RP_CALL=..}
node tools/reach-name.mjs 1.26.40.8 work/vft/rp5-1.26.40.8.txt --min-slots=9

# the constants shipped as bytes rather than addresses (docs/findings-layouts.md,
# "Constants"): static const data whose storage 1.26 no longer keeps. One file for
# every build -- Vec3::ONE is (1,1,1) in all of them -- gated on a known width and
# no relocation in the range; ships as symbols.json `constants`, allocated by proc
node tools/extract-constants.mjs

# the per-build constants: SharedConstants' version integers (the build number) and
# the protocol number, which is read from the MOTD the running server answers pings with
node tools/ping-protocol.cjs 127.0.0.1 19132        # on the lab machine, while BDS is up
node tools/version-constants.mjs 1.26.40.8 --protocol=2168

# which missing names could be carried by bdsx instead of resolved (docs/findings-utils.md)
node tools/util-classes.mjs 1.26.40.8 --out=data/util-classes.json

# the field accessors (docs/findings-layouts.md): the baseline definitions, then offsets go into
# data/candidates-instances-<v>.json `accessors` (read live with RP_WATCH / RP_CALL) and ship as
# symbols.json `accessors`, which bdsx's proc emits as code; check them with tools/accessor-probe.ts
node tools/leaf-accessors.mjs data/leaf-accessors.json

# gap propagation on both builds, judged by the cross-build pair set (docs/findings-gaps-agree.md);
# measure on the same hold-out first, then promote; rounds accumulate into data/candidates-gaps-agree-<v>.json
node tools/propagate-gaps.mjs 1.26.40.8 --holdout=0.2 --sizes --holdoutOut=work/derived/gaps/h.json --out=work/derived/gaps/ho40.json
node tools/propagate-gaps.mjs 1.26.51.1 --holdoutIn=work/derived/gaps/h.json --sizes --out=work/derived/gaps/ho51.json
node tools/gaps-agree.mjs measure work/derived/gaps/ho40.json work/derived/gaps/ho51.json
node tools/gaps-agree.mjs promote <real40.json> <real51.json> <agree40.json> <agree51.json>

# virtual slots from Endstone's headers (Apache-2.0; a shallow clone of the release that
# targets the build: 0c7cf5e for 1.26.51, v0.11.7 for 1.26.40) read from our own tables
node tools/endstone-slots.mjs work/endstone 1.26.51.1 data/candidates-endstone-slots-1.26.51.1.json
node tools/endstone-slots.mjs work/endstone-0.11.7 1.26.40.8 data/candidates-endstone-slots-1.26.40.8.json
```

**A counter probe proves an address, never a prototype, and not always the
address.** `Mob::_hurt` was execution-confirmed and still killed the server
under bdsx's 2024 prototype; `Actor::hurt` was promoted on a call count and
was a constructor (`docs/findings-slots.md`, "Changed signatures"). Read the
body before promoting, and fire the bdsx hook itself before calling an event
done (`tools/entity-sig-probe.ts`, `tools/gamerules-probe.ts`,
`tools/origin-probe.ts`). A name shown wrong goes into `retracted` in
`data/candidates-instances-<v>.json`; a function whose present signature has
no knowable decoration ships under a `bdsx:` key.

bdsx caches every name it resolves in `bedrock_server/pdbcache.l2`; since
2026-09-19 that cache is keyed on the exe **and** the MD5 of `symbols.json`.
Before that a corrected table never took effect for a name already looked
up (`docs/findings-slots.md`, "What the correction exposed") -- if a host
tree predates the fix, delete `pdbcache.l2` after replacing the table.

`data/candidates-pairs-in-tables-<v>.json` is a candidate list for execution
checks and is not merged: `docs/findings-slots.md` has the measurement (4 of 9
new Level slots wrong). Position cannot fill an equal-length gap whose content
changed; calling the slot on the live server against `level.dat` can
(`tools/level-getter-probe-launcher.js`).

`work/derived/` holds the intermediate correspondence maps the measurements in
`docs/` refer to (`pairs.json`, `prop.json`, `str2.json`, `corroborated.json`).
All are reproducible from `tools/`.
