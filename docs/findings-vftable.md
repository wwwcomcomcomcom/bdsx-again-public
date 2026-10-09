# vftables: reaching the kind of function bdsx hooks

Done 2026-09-17. `next-steps.md` item 1 (runtime vftable reading), item 7
(vftables via the constructor store) and the runtime half of item 2 (registry
tables), all on 1.26.40.8 and carried to 1.26.51.1.

## The premise held

27% of bdsx's names are slots in some vftable, and nothing had reached them.
A vftable is a vector of function pointers in declaration order, and both
halves of the problem turned out to be readable without inference:

- **Baseline.** `tools/vftable-slots.mjs` reads every `??_7` symbol in the
  1.21.3.01 PDB table: 23,496 vftables, 231,514 slots, 32,521 distinct
  functions, each nameable. RTTI is off in this build too: the qword before
  `??_7ServerLevel@@6BILevel@@@` is the previous table's last slot, not a
  locator.
- **Target.** Code never takes the address of the middle of a vftable, and a
  constructor always takes the address of its start (`lea rax,[rip+X]` /
  `mov [rcx],rax`). `tools/vftable-scan.mjs` collects every `.rdata` address
  that a `lea` in `.text` points at and that holds a `.text` pointer, and
  reads each table to the next such start or the first non-code qword.

The scanner is graded on the baseline, where the PDB knows the answer:

| | |
|---|---|
| PDB vftables | 23,496 |
| start found by the scanner | 23,283 |
| length exactly right | 23,271 |
| scanner longer | 12 |
| scanner shorter | 0 |

The 213 misses are tables whose only references are not `lea` (static
objects with a vptr in `.data`, `PacketHandlerDispatcherInstance<...>`).
The first version of the PDB-side reader over-read 1,581 identical-COMDAT-
folded `_Ref_count_obj2<T>` tables by 12 slots because their neighbours are
unnamed; the scanner's referenced starts are now boundaries on that side too.

On 1.26.40.8 the scanner finds 30,101 tables and 269,890 slots; on 1.26.51.1,
31,835 and 278,505.

## Slot indices move; the shape does not

The obvious rule -- same slot index -- finds nothing. Virtuals are added and
removed between builds:

| function | baseline tables / slot / length | 1.26.40.8 tables / slot / length |
|---|---|---|
| `Actor::teleportTo` | 38 / #23 / 154 | 38 / #21 / 137 |
| `Player::drop` | 3 / #123 / 255 | 3 / #116 / 245 |
| `Level::tick` | 2 / #99 / 342 | 2 / #119 / 409 |
| `BatchedNetworkPeer::sendPacket` | 1 / #1 / 8 | 1 / #1 / 9 |

What is identical is the number of tables each function appears in -- the
class hierarchy, projected onto one slot. `Actor::foo` unoverridden sits in
every Actor subclass table; `Mob::foo` in the Mob subtree; a destructor in one.
`tools/vftable-match.mjs` aligns a target table against a baseline table as
two integer sequences of table counts, by dynamic programming, with already
known functions pinned as anchors (+6 for the same function, -8 for a known
mismatch).

Pairing: a target table containing a known function is aligned against every
baseline table containing it, and all pairings within a margin of the best
score vote. A name transfers only when the votes are unanimous both ways and
the two functions' table counts agree within 25%. Ambiguous slots stay open
until a later round pins more anchors; the walk runs to a fixed point.

### Precision, measured

Leave-one-out on the resolved table's virtuals: `Actor::teleportTo` re-found
from `Player::drop` alone, and vice versa, both exactly right; `Level::tick`
and `sendPacket` unreachable when held out because each is its family's only
seed. 2 of 2, 0 wrong.

That sample is too small. The 426 string-anchored pairs that are virtual
functions give a larger one: seed the walk with a random half and score the
other half.

| mode | held out | reached | correct | wrong | precision |
|---|---|---|---|---|---|
| plain, split 1 | 202 | 123 | 97 | 26 | 78.9% |
| plain, split 2 | 199 | 102 | 83 | 19 | 81.4% |
| plain, split 3 | 218 | 126 | 90 | 36 | 71.4% |

**~80% single-walk precision is not acceptable**, and the errors are not
spread evenly: 29 of 36 in split 3 are `MinecraftEventing::fireEvent*`, a
table of several hundred slots that all look alike (one table each, same
size class) where the DP places an insertion among indistinguishable
neighbours. The same shape produced a concrete wrong answer,
`Level::getSavedData`, placed one slot off at a one-instruction setter
(`mov [rcx+570],dl; ret`).

### What fixed it, and what did not

| variant | split 1 precision (reached) | split 3 precision (reached) |
|---|---|---|
| plain | 78.9% (123) | 71.4% (126) |
| `--size` (function size from `.pdata`) | 78.9% (123) | — |
| `--callees` (callee overlap through independent pairs) | 80.8% (125) | — |
| `--strictAbove=128` (strict for long tables) | 89.3% (75) | 87.3% (79) |
| `--strictUniform=0.6` | 97.9% (48) | 88.5% (52) |
| **`--strictUniform=0.7`** | **94.6% (56)** | **89.7% (58)** |
| `--strict` (everywhere) | 97.1% (34) | 92.5% (40) |

*Strict* accepts a slot only when it lies between two anchors inside one
gap-free diagonal run, so its shift is pinned on both sides; everything
beyond the outermost anchors, or in a run the DP split among look-alikes,
waits for a later round. `--strictUniform=F` applies that only to baseline
tables where a share >= F of the slots have the same table count -- the
single-implementer interfaces where the count feature is blind -- and leaves
rich tables (Actor, Player, Level families) on the plain rule, which is ~98%
right outside those interfaces. Function size and callee overlap, the two
per-slot features tried, moved nothing: sizes are not stable across the
compiler change and the independent pair set covers too few callees.

The walk runs with `--strictUniform=0.7`. Two lessons from measuring it:
a combined-flag sweep was silently void because zsh does not word-split an
unquoted variable and node saw one argument; and the alignment cache had to
hold flat typed arrays, not per-pair objects, or a 30-round walk exhausts a
4 GB heap.

A second, live demonstration of the failure mode: on 1.26.51.1 the walk
named slot 328 of `ServerLevel`'s table `Level::getPlayerPlatformOnlineId`
and slot 330 `Level::getRuntimeActorList`; the counter probes showed slot
328 firing once per tick on both builds, exactly as `getRuntimeActorList`
does on 1.26.40.8 where the walk had it at slot 328. The 1.26.51.1 names in
that region were shifted by two. Runtime call counts are a cross-version
consistency check that catches what the alignment cannot.

## Corroboration

Two walks are run with disjoint seeds: **A** from the resolved table
(Endstone-derived, execution-confirmed) and **B** from the string-anchor /
call-propagation pairs, which share nothing with A but the baseline. The two
share the alignment algorithm, so a third, independently derived check is
applied on top: any entry the propagation pairs contradict is removed
(`tools/vftable-corroborate.mjs`). `data/candidates-vftable-<version>.json`
holds only what survives all three.

`tools/vftable-pipeline.mjs <version> <pairs.json>` runs the whole thing:
walk A, walk B, corroborate, propagate call edges with the corroborated
virtuals as extra seeds, walk B2 from the enlarged pairs, corroborate A and
B2. Final figures:

| | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| walk A (resolved seeds) | 2,288 functions | 2,494 |
| walk B2 (pair seeds) | 3,707 | 3,694 |
| **agree, after veto and packet override** | **4,113 names, 534 vftables** | **5,880 names, 555 vftables** |
| disagree (excluded) | 42 | 42 |
| independent pairs: agree / vetoed | 14 / 1 | 24 / 2 |
| bdsx required names covered | 115 (17 vftables) | 108 (16 vftables) |

The corroborated virtuals then feed call-edge propagation, which had stalled
at 31 of bdsx's 1,065 names from string seeds alone: with 2,054 virtuals as
extra seeds it reaches **151**, 6 of 6 agreeing with the resolved table
(`data/candidates-propagation-<version>.json`). Together with the resolved
table the three sources cover **194 of 1,080** required names on 1.26.40.8
and 185 on 1.26.51.1, against 21 before.

The 29 symbols `launcher.ts` needs are still 1 of 29: they are constructors
and non-virtual getters, which no vftable holds and propagation does not
reach. See `next-steps.md`.

## Confirmed by execution

`tools/vftable-probe-launcher.js` on the Windows host, 1.26.40.8:

```
[vp] live Level vptr = 0xa5e9ee0; static ??_7ServerLevel@@6BILevel@@@ = 0xa5e9ee0
[vp] VPTR MATCHES ServerLevel
[vp] live slots equal to static scan: 409/409; Level::tick is slot #119 of the static table
```

`*(void**)this` inside the `Level::tick` hook is exactly the table the walk
paired with `??_7ServerLevel@@6BILevel@@@`, and the walk's slot for
`Level::tick` is the slot the live object calls through. The check
`next-steps.md` asked for ("#99 means aligned; a different index is the
offset; scattered means rejected") resolves as: #119, aligned by sequence
rather than by index.

Forty walk-named `Level` virtuals were then hooked with counter probes.
Thirteen fired in a plain 200-tick run with no client, each when its name
says it should:

| function | calls |
|---|---|
| `Level::getRuntimeActorList` | 203 |
| `Level::getGameRules`, `removeBlockSourceFromValidityTracking`, `sendAllPlayerAbilities`, `initializeBlockDefinitionGroup` | 2 |
| `loadBlockDefinitionGroup`, `flushRunTimeLighting`, `getSimPaused`, `setHasLockedResourcePack`, `setHasLockedBehaviorPack`, `getLANBroadcast`, `getLANBroadcastIntent`, `setMultiplayerGame` | 1 |

Firing is evidence for; not firing is not evidence against.

One lesson cost two runs: a 12-byte jump written over a function shorter than
12 bytes spills into its neighbour, and the server hangs after the game-thread
handoff with nothing on stderr. Probes are now chosen from `.pdata` entries of
32 bytes or more; tiny getters have no `.pdata` entry at all.

## Packets: the registry route, exact

`MinecraftPackets::createPacket` is Endstone-resolved. The launcher calls it
for every id from 1 to 0x13f, and records `*(void**)packet` for the 198 that
come back. bdsx's own `MinecraftPacketIds` names each id, so
`tools/packet-vftables.mjs` writes `??_7<Name>Packet@@6B@` for every id whose
symbol the baseline has: **177 packet vftables** in
`data/candidates-packets-1.26.40.8.json`, with no inference in the address.

This also grades the walk on look-alike tables: of the 9 packet vftables
both had, the walk was wrong on **3**. Packet tables are ~10 slots each and
structurally identical, which is the `MinecraftEventing` failure again. The
runtime table overrides the walk for packets, and the walk's output on any
family of look-alike tables is not to be trusted on its own.

## Files

| file | what |
|---|---|
| `tools/pe.mjs` | PE reader shared by the tools; `referencedPointerTables` |
| `tools/vftable-slots.mjs` | baseline: every vftable and its named slots |
| `tools/vftable-scan.mjs` | target: referenced pointer tables, graded with `--check` |
| `tools/vftable-match.mjs` | the walk; `--holdoutFrac` for precision, `--strict`, `--size` |
| `tools/vftable-corroborate.mjs` | A ∩ B minus independent-pair vetoes |
| `tools/vftable-probe-launcher.js`, `tools/run-launcher.ps1` | runtime confirmation and packet dump |
| `tools/packet-vftables.mjs` | (id -> vptr) dump to named packet vftables |
| `work/vft/` | scans, walks, seeds, run outputs (gitignored, reproducible) |
