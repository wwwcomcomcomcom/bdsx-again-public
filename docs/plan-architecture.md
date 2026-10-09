# Plan: realign bdsx to the 1.26 engine

Decided 2026-09-23 with the user. This is the active plan behind queue section **A** in
`docs/next-steps.md`; the queue holds the open steps, this document holds the reasoning and the rules.

## 1. The decision

The goal was never compatibility with 2024-era bdsx plugins. It is **a plugin loader that works and
behaves like bdsx** (TypeScript plugins, events, Actor/Player/Level wrappers, commands, packets, forms)
on current BDS. So, decided by the user:

- **A concept that no longer exists in 1.26 is dropped from the API, not emulated.** (The hurt-time field
  was first cited here as the example; it is not one. The `getInt` sweep showed the synched data item is
  gone, but the hurt time lives on in `MobHurtTimeComponent`, so it is `absorbed`. See
  `findings-inventory.md` section 5.)
- **Compatibility with old plugins is not a goal.** An API may change shape to fit what 1.26 has.
- **Diverging from upstream bdsx is fine.** Upstream has been archived since 2024-11-14; the `revival`
  branch is now a fork, `github.com/wwwcomcomcomcom/bdsx`, and the `bdsx/` submodule here (`HANDOFF.md` section 4).

Unchanged: the done bar (execution with bdsx's own code on both builds), the measurement rules
(`HANDOFF.md` section 7), and licence discipline.

## 2. Why the current shape does not last

The table is keyed on bdsx's **2024 decorated names**, and every missing name is chased as "where did
this 2024 function go". That works while the function still exists. When it does not:

- `derived()` fills the gap per name. Its entries (see `data/derived.json`; the biggest groups are
  `Actor`, `Player`, `PlayerInventory`) are keyed on a 2024 name but implemented against the 1.26
  structure — EnTT components, layout offsets, slot calls. The key and the implementation describe
  different engines.
- Those implementations depend on per-build facts (offsets, slot numbers, component hashes — none of
  which carry between builds: `_hurt` went 134 → 133, hashes never carry). Scattered one per name in
  `bds/implements.ts`, nothing lists **what has to be re-checked when a new build ships**.
- Names whose concept is gone are searched for anyway, and cost a session each before anyone concludes
  "not there".

Snapshot when this plan was written (2026-09-23, not maintained here): 533 required names missing on
both builds, 20 more missing on one; 388 of the 533 are referenced from `bds/implements.ts`, 42 from
`bds/command.ts`, then `event_impl/entityevent.ts`, `launcher.ts`, `event_impl/blockevent.ts`. By class,
the largest groups are `ItemStackBase`, `Block`, `SimulatedPlayer`, `StructureSettings`,
`NavigationComponent`, `Scoreboard`, `Dimension`. Regenerate with the command in section 5 (A1).

## 3. Target shape: three layers

```
[1] bdsx public API (TypeScript)      what plugins call. Kept close to bdsx's shape, free to change.
[2] engine layer                       1.26 concepts: EnTT component access, 1.26 functions under their
                                       1.26 identity, layout reads, allocator-based construction.
                                       [1] is written on top of [2].
[3] per-build table (symbols.json)     addresses, layouts, accessors, constants for exactly what [2] uses.
```

Today's `derived()` is an implicit, per-name version of [2]. The work is to make [2] explicit, so that
the list of per-build dependencies is a thing a tool can print (`HANDOFF.md` section 6, the Q6 procedure,
then starts from that list).

**Keys in [3]** keep the existing convention: the decorated name when the 1.26 signature is known
(unchanged, or given by Endstone's `windows.h`), otherwise a `bdsx:Class::method` key with the prototype
in `provenance`. No new key scheme.

**Reference for [2]'s shape:** Endstone's headers (Apache-2.0, `work/endstone/src/bedrock/`), which track
each release's layouts, vtable order and component names. Its `windows.h` is small (about 60 names), so
it is a source of *structure*, not a symbol table to import.

## 4. The five classes

Every required name — and every `data/derived.json` entry — gets exactly one:

| class | meaning | what happens |
|---|---|---|
| `live` | the function still exists in 1.26 with the same role | an address in [3], as today |
| `moved` | the role exists but under another function, signature or owner | bind the 1.26 function in [2], [1] calls it |
| `absorbed` | the data or behaviour now lives in an EnTT component or another object | implement in [2] on the component or layout |
| `gone` | the concept does not exist in 1.26 | drop from [1]; record in `data/dropped.json` |
| `unknown` | not yet settled | stays in the queue as a search |

**Evidence standard for `gone`** — this is the class that deletes API, so it needs the most:
one of (a) a runtime sweep showing the state is absent from **every** place it could live (the
hurt-time `getInt` sweep only showed one storage gone, and the state was behind `Mob+0x428`), (b) the 2024 body
read and every thing it touches shown missing in 1.26 (component hash with 0 users on both builds, string
absent from the image, owning class absent from Endstone's 1.26 headers **and** from the vftable scan),
or (c) an Endstone 1.26 header that shows the replacement (then it is `moved`/`absorbed`, not `gone`).
"We searched and did not find it" is `unknown`, never `gone`.

**Precision before yield** (rule 1): any automatic signal used to pre-sort — e.g. "method absent from
the class's Endstone header" as a `gone` hint — is first scored against the names already resolved
(which are known `live`). Report its false-`gone` rate before using it on the unresolved set.

## 5. Phases

**A1 — inventory (static, no host, no bdsx edits).** Write `tools/arch-inventory.mjs` →
`data/arch-inventory.json`: for every required name missing on at least one build, and every derived
entry, `{ class, evidence, target?, api: [bdsx sites] }`. Pre-sort signals: presence in either merged
table, signature change (`findings-signatures.md`), `derived.json` entry text, Endstone header presence
of class/method, component-hash user counts, the per-name notes already in `findings-components.md`
("The 39 that are left") and the other findings docs. Group the output by bdsx API area (file and
class), since that is the unit of later work. **Done when** every such name has a class, each `gone`
meets section 4's standard, the signal's false-`gone` rate on resolved names is reported, and the
`unknown` count is in `docs/status.md`.

**A1 result (2026-09-23)**: `tools/arch-inventory.mjs`, `data/arch-inventory.json`, hand verdicts in
`data/arch-classes.json`, findings in `findings-inventory.md`. No name met the `gone` bar; the
Endstone-absence signal calls 52% of known-live names gone and is a hint only. **A1-b** (same day):
seven classes settled; the first `gone` are two item-component classes, gone before 1.21.3.01 already
(`findings-inventory.md` sections 7-8). **A2** first drop done the same day: those two classes, `data/dropped.json`,
`layout`/`sig`/`pk` clean on both builds (section 10).

**A2 — drop what is gone.** Remove the dropped API from `bdsx/` (delete the method/event, or make it
throw a clear "not available on BDS 1.26" error where removing it would break bdsx's own code), record
each in `data/dropped.json` with its evidence, re-run `node tools/scrape-symbols.mjs` (dropped names leave
the required set by themselves), and have `tools/status-summary.mjs` print the dropped count next to the
required total. **Done when** the full launcher plus the `layout`, `sig` and `pk` drivers pass on both
builds, and the dropped names' `Symbol not found` lines are gone from boot.

**A3 — make the engine layer explicit.** A module under `bdsx/bdsx/bds/engine/` holding what
the `derived()` implementations share (A1 lists it: component lookup, allocator construction, layout
reads, slot calls), and `tools/engine-deps.mjs` printing every per-build fact [2] depends on (offset,
slot, hash, address) — the checklist for Q6. **Done when** at least one area (the abilities block,
`findings-abilities.md`, is the natural first) is moved onto it and passes `abil40`/`abil51`.

**A3 result (2026-09-23)**: `bdsx/bdsx/bds/engine/` reads the build only through `engineLayout`,
`engineSymbol` and `componentHash`, always with literal arguments. `node tools/engine-deps.mjs` lists
those facts per build: 43 so far, none missing on either build. `engine/entt.ts` is the EnTT lookup,
moved out of `implements.ts`. `engine/abilities.ts` is the ability-block walk plus the
`UpdateAbilitiesPacket` payload writer (Q1-2). Confirmed on both builds: `abil` 54/54, with the bot
decoding what bdsx sent; `layout` 23/23, `ride` 21/21 and `sig` still pass on top of the moved EnTT
code (`findings-abilities.md`, last section).

**A4 — migrate as you go, no big-bang rewrite.** Most of what resolves today was confirmed by execution
on both builds; a rewrite would reset that. New queue items are implemented in [2]'s form; an existing `derived()` moves
into [2] when its area is next touched. The existing queue items are re-read through A1's classes:
`unknown` names stay searches, `gone` ones leave the queue.

## 6. Effect on the existing queue

- **Q1-2 `UpdateAbilitiesPacket`**: 1.26 has no out-of-line constructor, so it is `absorbed` — the first
  engine-layer packet builder, on the layout already measured.
- **Q1-3 / Q1-A / Q1-B**: each name is re-read against its A1 class before any search starts.
- **Q1-A `lightningHitBlock`/`projectileHitBlock`**: option (a), hooking the callers and rebuilding the
  event in bdsx, is the engine-layer-shaped answer; still the user's decision.
- **Q2, Q5, Q7**: unchanged — they are firing/confirmation work, not naming work.
