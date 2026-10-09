# One hop down from a named caller, judged by the other build

Done 2026-09-17 (night). Step 2 of `next-steps.md`: the gap-anchored
call-edge propagation of `findings-slots.md` route 7 (96-97% on held-out
virtuals, never promoted because it was one route) gets its second route,
and the loosenings the plan listed are measured.

## The second route

`tools/propagate-gaps.mjs` proposes a target function for a baseline
function from equal-length gaps between known callee pairs. It runs on
both stripped builds against the same 2024 baseline. Whether two
proposals name the same function is decided by something neither used:
the 1.26.40.8 -> 1.26.51.1 pair set built by string anchoring and
propagation *between the two builds* (`work/derived40to51/pairs.json`,
19,203 pairs). `tools/gaps-agree.mjs` keeps a name when the 1.26.40.8
proposal, carried through that set, is the 1.26.51.1 proposal, and the
body-shape veto passes on both sides. A name proposed on one build only
is judged the same way against what the other build already knows from
any source but this one.

The measurement hides the same 20% of the baseline functions on both
builds (`--holdoutOut` / `--holdoutIn`) and scores each subset against
the hidden truth:

| held-out subset (1.26.40.8 side) | right | wrong | precision |
|---|---|---|---|
| proposed on both builds, **agree** through the pair set | 215 | 4 | **98.2%** |
| proposed on both, disagree | 4 | 0 | (too few to say) |
| proposed on both, no pair for the address | 14 | 0 | |
| proposed on 1.26.40.8 only | 27 | 4 | 87.1% |
| all proposals, no join (route 7 as it was) | 260 | 8 | 97.0% |

The 1.26.51.1 side of the agreeing set: 214 right, 4 wrong. The one
proposal known to be wrong from execution, `Minecraft::getServerNetworkHandler`
(0x23c450, `findings-slots.md`), lands in the disagreeing set: the join
catches it.

Two more signals were measured on the same hold-out and neither is a
second route:

| signal | classes | precision |
|---|---|---|
| callers voting for the proposal | 1 / 2 / 3+ | 97.0% / 98.6% / 93.2% |
| callee cohesion (the baseline callee's own known callees reappear under the target) | full / partial / blind / contradicted | 98.0% / 100% / 100% / 95.5% |

Votes are not monotone and cohesion barely separates, because the
hold-out population is the walk's virtuals, whose call structure is
regular either way.

## Loosenings, measured

| rule | held-out precision (1.26.40.8) | proposals |
|---|---|---|
| equal-length gaps only (route 7) | 260 / 268 = 97.0% | 779 |
| + set-difference uniqueness (one unknown callee left on each side) | 262 / 270 = 97.0% | 801 (+22) |
| + size match inside unequal gaps (unique within 15%, both ways) | 303 / 312 = 97.1%; agreeing subset 274 / 281 = **97.5%** | 870; 717 size votes |

The set-difference rule pays nothing and adds 3%: after the known callees
are removed, a caller rarely has exactly one unknown on each side.

## Rounds

Every accepted name is an anchor for the next round. The route was run to
saturation, merging the agreeing set (`data/candidates-gaps-agree-<v>.json`,
source `gaps-agree` in `tools/merge-symbols.mjs`, never hook-trusted)
between rounds:

| round | rule | proposals on both | agree (after veto) | disagree | new names, each build | required |
|---|---|---|---|---|---|---|
| 1 | equal gaps | 727 | 383 | 185 | 383 / 384 | 1 (`Actor::hasEffect`, 1.26.51.1, by the known-on-the-other-build check) |
| 2 | equal gaps, +383 anchors | 1,057 | 707 | 186 | 707 / 707 | 0 |
| 3 | + size match, +707 anchors | 6,516 | 6,212 | 74 | 6,212 / 6,212 (**211 functions**: the names are COMDAT-folded aliases sharing 211 addresses) | 1 (`BlockSource::mayPlace`, a hook target, so not installed) |

Coverage stays at 254 / 246. The tables grew to 12,118 and 14,217 names,
which are anchors for anything that runs next, and the lifecycle ran
clean on 1.26.40.8 with them.

## What it did and did not reach

The agreeing set is precise and it is not what bdsx asks for. Of the 16-17
required names each build's propagation proposes, all have a single
voting caller and, but for one, none is proposed on the other build or
known there, so the join has nothing to compare. They are an execution
queue, listed here so they are not re-derived:

`Actor::stopRiding`, `Actor::isRiding`*, `Actor::isCreative`*,
`PlayerInventory::selectSlot`, `PlayerInventory::dropAllOnDeath`,
`Player::setPlayerUIItem`, `ItemStackBase::isStackable`,
`ItemStackBase::getName`, `Block::getBlockEntityType`,
`CompoundTag::equals`, `CommandOutput::set<int>`,
`CommandPosition::getPosition`, `StructureManager::getOrCreate`,
`Scoreboard::getCriteria`, `CommandUtils::spawnEntityAt` on 1.26.40.8
(* shape-vetoed: the signature changed); `ActorEquipment::getArmorContainer`,
`ItemStackBase::isHumanoidArmorItem`, `Actor::getEntityTypeId`,
`Player::getPlayerGameType`, `ItemStackBase::constructItemEnchantsFromUserData`,
`CommandPosition::getBlockPos`, `CommandOutput::set<bool>`,
`Block::buildDescriptionId`, `CompoundTag::CompoundTag(&&)` on 1.26.51.1.

The reason is structural: the required non-virtuals sit in gaps whose
length differs between the builds (3,900 unequal gaps skipped against
1,300 equal on 1.26.40.8), which is exactly where a virtual was added or a
call inlined. The equal-gap rule cannot see into them, and the size rule
is the first attempt that can.

## Rules this added

- **The other build is a second route** for anything derived from the
  2024 baseline, as long as the judge between the builds is built from
  neither derivation (string anchors and propagation between the two
  builds, not the baseline).
- **Measure a loosening on the same hold-out before counting its yield**;
  votes and cohesion looked like signals and were not.
- **A held-out population must resemble the target population**: all of
  these figures are on virtuals, and the required names are non-virtuals.
  The execution queue above is how that gap gets closed.
