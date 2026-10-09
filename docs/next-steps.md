# Task queue (next-steps)

> **Working method (fixed rule).** Work the top item of the queue below. When done, (1) record the result
> in the relevant `docs/findings-*.md`, (2) `node tools/status-summary.mjs --write` and update the relevant
> section of `docs/status.md`, (3) **move the finished item out of this file into the "Completion Log" of
> `docs/completed-task.md` (top of its list) and leave the next thing to do here, concretely**, (4)
> `node tools/docs-check.mjs` (must exit 0), (5) commit, (6) **report to the user.**
> Procedures and environment: `docs/HANDOFF.md`; running BDS: `docs/lab-runbook.md`.

**This file holds open items only.** An item is a goal, its candidates, the command to start with, the
done criterion, and a pointer to the findings doc that has the evidence — ten lines or so. The story of
how it got there belongs in the findings doc, and a finished item leaves this file entirely.
`tools/docs-check.mjs` enforces a size budget on it. Coverage numbers are **not** written here: they are
the generated block at the top of `docs/status.md`.

"Done" is always the same bar: **confirmed by execution with bdsx's own code on both builds
(1.26.40.8, 1.26.51.1)**, evidence in `data/resolved-<v>.json` provenance and the findings doc. One build
only, or static evidence only, stays in the queue with that written down. A check that has only ever seen
one side's answer (only `true`, only non-null) is a **candidate in the findings doc, not a table entry.**

Queue labels (`Q1-A`, `Q5-3`, "Q1-0 B-next", ...) cited in findings docs are the sections below, or
earlier versions of this queue.

---

## The queue, in order

| # | item | needs | section |
|---|---|---|---|
| 1 | **NetherNet ping** (needs the bdsx NetherNet commit -- `bds/engine/nethernet.ts`, `nethernet-probe.ts` -- which is not yet in the pinned submodule: when it is pushed, bump `bdsx/`, add the probe and its `nn`/`nnh` drivers; until then `node tools/ship-tables.mjs check` reports both tables differ, by that commit's two hook names, which `data/` already has; `bedrockServer.rakPeer`'s pings have no NetherNet counterpart; `findings-nethernet.md` sections 7-8). Candidate: libwebrtc `Connection::rtt()`/`rtt_` on the connection `SwitchSelectedConnectionInternal` installs. bds/engine/nethernet.ts already sees that pointer in its hook (rdx), so also record it, and the channel (rcx), per ufrag. Read `rtt_` on the node thread only while the identifier is connected and the channel's `+0x528` still equals that connection: a read of another thread's int, and nothing after a disconnect. First find `rtt_`'s offset: `tools/string-users.mjs 1.26.51.1 " rtt="` lists 51 `0xa441040` and `0xa446cd0` (unread; the former also logs " ms without a response, rtt="), candidates for libwebrtc's Connection code that prints rtt_. Done = a `getPing()`-style API returning a plausible RTT for a NetherNet client over HTTP signalling (loopback: 0..50 ms) and -1 for an unknown id, on both builds | bdsx + lab | NetherNet |
| 2 | `net-scorepacket.ts`'s `example_score`: `Access Violation: 0x0` in `CxxVector.push` of `SetScorePacket.entries` (2024 layouts of `SetScorePacket`/`ScorePacketInfo`, 29.5). Read 1.26's `SetScorePacket::write` (slot of its vftable) for the entry vector offset and entry size. Done = the command runs without the AV on both builds and the bot gets `set_score` | bdsx + lab | release |
| 3 | Open names, all low-value: `MapItemSavedData::_updateTrackedEntityDecoration` (example only; candidates and why it was left in `findings-inventory.md` section 28) and the `HelpCommand` trio (an assert only). The launcher's `sendEvent`/`gsl::terminate` have working fallbacks, and `transferEntityToUnloadedChunk` is inlined: leave all three. `node tools/arch-inventory.mjs --list=unknown` lists the rest, with notes | bdsx + lab | A1 |
| 4 | Drop each new `gone` as it turns up (none waiting; the last, `SerializedSkin`'s copy and move, dropped 2026-09-28) | bdsx + lab | A2 |

---

## A. Realign to the 1.26 engine (decided by the user 2026-09-23)

The goal is a plugin loader that works like bdsx on current BDS, not compatibility with 2024 plugins:
**a concept gone in 1.26 is dropped from the API, not emulated**; old-plugin compatibility is not a goal;
diverging from upstream is fine. Target: bdsx API → an explicit **engine layer** of 1.26 concepts → the
per-build table. Classes, the evidence bar for `gone`, and the phases: `docs/plan-architecture.md`.
**No big-bang rewrite** — confirmed names stay; new work is written in the engine-layer form.

- **A1 — done 2026-09-23**: `tools/arch-inventory.mjs` → `data/arch-inventory.json`,
  hand verdicts in `data/arch-classes.json`, counts in the `docs/status.md` block, `docs/findings-inventory.md`.
  **No name met the `gone` bar**, and "absent from Endstone" calls half of the known-live names gone.
- **A1-b — done 2026-09-23** (`findings-inventory.md` sections 7-8): scrape-symbols no
  longer counts names that only appear in comments (29 left the required set, shipped tables unchanged);
  `StructureSettings`, `SimulatedPlayer`, `NavigationComponent`, `ItemStackBase`, `Block`, `Scoreboard`,
  `Dimension` settled; the first `gone`: `DyePowderItemComponent`, `KnockbackResistanceItemComponent`.
- **A1-c — done 2026-09-23** (`findings-inventory.md` section 11): free functions and five
  classes; new signal `tools/image-names.mjs` (lambda scopes carry decorated names). No `gone`.
- **A1-d — done 2026-09-23** (`findings-inventory.md` section 12): eight more classes, and
  `tools/arch-gone-sweep.mjs` found **no `gone` candidate left**. The remaining `unknown`s are address
  searches (`--list=unknown`); take one up when an engine-layer area needs it, not as a batch.
- **A1-c-x — done 2026-09-23** (`findings-inventory.md` section 13): `bdsx:BedrockLogOut` and
  `tryGetStateFromLegacyData` shipped and confirmed on both builds. `ConsoleInputReader` is inlined into
  `DedicatedServer::start`, so stdin takeover needs Endstone's queue route: an A3 item, not a patch.
- **A2 — drop, as `gone` names turn up.** The procedure, done once 2026-09-23 (`findings-inventory.md`
  section 10): remove the TS surface from `bdsx/` (or throw "not available on BDS
  1.26" where bdsx's own code needs it), add each name to `data/dropped.json`, re-scrape, `status-summary
  --write`, then `layout`/`sig`/`pk` on both builds (`node tools/host/verify-pair.mjs`; pk's tag is `[pktprobe]`,
  expected 16 PASS / 2 FAIL). Nothing is waiting: the A1-d sweep found no `gone` candidate.
- **A3 — done 2026-09-23** (`plan-architecture.md` "A3 result", `findings-abilities.md` last section):
  `bdsx/bdsx/bds/engine/` (EnTT lookup, ability block, `UpdateAbilitiesPacket` builder) and
  `tools/engine-deps.mjs`; `abil`/`layout`/`ride`/`sig` pass on both builds.
- **A4 — migrate as you go.** New work is written in `engine/` form (`engineLayout`/`engineSymbol`/
  `componentHash` with literal arguments); an existing `derived()` moves there when its area is next
  touched. `node tools/engine-deps.mjs --missing` must stay empty on both builds.

---

## Q1. Actor-family names

Background: `docs/findings-components.md` (route 10, and "The 39 that are left" for per-name
classification). What is still missing on both builds right now:

```sh
node -e 'const r=require("./data/required-symbols.json").symbols,a=require("./data/merged-1.26.40.8.json"),b=require("./data/merged-1.26.51.1.json"),d=require("./data/derived.json").derived,h=(m,n)=>n in m.symbols||n in(m.accessors||{});for(const s of r)if(!h(a,s.name)&&!h(b,s.name)&&!(s.name in d)&&/^\?\w+@(Actor|Mob|Player|ServerPlayer)@@Q/.test(s.name))console.log(s.name)'
```

Procedure per name (details in `findings-components.md`): read the 2024 body
(`node tools/disas-exact.mjs 1.21.3.01 0x<rva>`) → **first check whether 1.26 still has the thing at all**
(the hurt-time `getInt` sweep showed one storage gone, not the concept: it was `absorbed`) → `node tools/component-hash.mjs <v> <Component>` on
both builds (0 users = wrong spelling; templates need the full name with no spaces; hashes never carry
across builds) → pick by body, **reading from the tail** (overloads share the inlined lookup) → address or
`derived()` into `data/resolved-<v>.json` → add a console-movable check to `tools/actor-layout-probe.ts` →
`layout40`/`layout51` in one paired session. Counting a layout from a **confirmed neighbour** in Endstone's
`player.h` is reliable (five of five); counting from the top is not.

### Q1-3. The rest of the missing names

From the list command above (2026-09-23: thirteen, two of which are served under `bdsx:` keys —
`?hurt@Actor@@`, `?setPlayerUIItem@Player@@` — so eleven were open; `inventoryChanged`, `isInClouds`, `startCooldown`, `fetchNearbyActorsSorted`, `canSee` ×2 closed 2026-09-24; `interact` also, as `bdsx:Player::interact`, four left):

- `?hasDimension@Actor@@`: done 2026-09-27, `derived()` (`findings-layouts.md` "hasDimension: both sides"). `isUsingItem`
  was promoted 2026-09-24 with a simulated player drawing a bow.
- **Blocked on another name or need an address** (C/D in `findings-components.md`): `handleJumpEffects`
  done 2026-10-02 (the `JumpExhaustion` system; a client's jump fires `playerJump`, `findings-bot.md` section 10; `interact` done as `bdsx:Player::interact`), `isInRaid` done 2026-09-24 (40 address, 51 `derived()`, a simulated player's raid).
- **Left behind by B-follow** (`docs/findings-containers.md` section 14; the two `PlayerListEntry` constructors and
  `tryGetFromEntity@SimulatedPlayer` were done 2026-09-24):
  (`PlayerListPacket`'s fields: done 2026-09-24, `getEntries()`.)

---

## Q1-A. Block events

Reading the world's blocks works (`docs/findings-blocks.md`). `node tools/event-coverage.mjs` lists the
events with no target; the ones below have evidence, the rest (`campfireLight`/`campfireDouse`,
`attackBlock`, `blockDestructionStart`, `blockInteractedWith`) are mostly static non-virtual free
functions — caller-intersection or string-anchor routes. Rules that hold for all of them:

- **`use`-family events need a different seam — do not search for a slot.** Endstone 0.11.7's
  `block_type.h` comments out `tick`/`randomTick`/`use`: `buttonPress`, `chestOpen`, `Block::use` have no
  slot route (`findings-blocks.md` section 6).
- A string that appears exactly once in the image is the cheapest anchor there is (`sculkShriek` was
  found by `"originX"`/`"originY"`/`"originZ"`).

1. **Console-triggerable events with no target (top of the queue)** (`node tools/event-coverage.mjs`, "NO TARGET").
   Done through 2026-09-24: the scoreboard ones, `entityHealthChange`, `entityCreated`, `splashPotionHit`, the campfire
   pair, `projectileHit`, `playerInventoryChange`, `projectileShoot`, `queryRegenerate`. Nothing console-reachable is
   left. Player-input events done with a simulated player (2026-09-24): `attackBlock`, `itemUse`, `itemUseOnBlock`,
   `playerInteract`, `buttonPress`, `chestOpen`. `projectileHitBlock`/`lightningHitBlock` done 2026-09-24 from their callers
   (`findings-blocks.md` section 21). `blockInteractedWith` ships and its hook installs, but only a client's
   item-use transaction sends it (`findings-slots.md` "blockInteractedWith: the listener found"); it and `playerJump` need a
   client (Q7; a simulated player reaches neither), `blockDestructionStart` fired 2026-10-02 from a simulated player's dig. Method from
   `findings-blocks.md` 16-19 and `findings-slots.md` (the last sections): 2024 callers/callees, a vftable through a
   constructor's vptr store or an ECS system's name, `tools/lambda-owner.mjs`, a sibling overload's callers.
   Done per event: fired via bdsx's hook on both builds, both sides of any cancel.

## Q1-B. Items

- Nothing open: `getByName`, `isHumanoidWearableBlockItem` and `getComponentItem` were closed 2026-09-24.

## Q9. NBT consumers

The NBT layer works on both builds (`docs/findings-nbt.md`); `ItemStackBase`, `MobEffectInstance` and `BlockActor` round-trip
(sections 8-11), `StructureTemplate` (13-14), `CommandBlockComponent` and the item components' network tags (15-16).
The `NonOwnerPointer` fix came out of it (section 17: bdsx's class now has 1.26's 24-byte shape). A networked item component needs the engine's `cereal::ReflectionCtx`
(section 15): bdsx has one only for a component reached through `ComponentItem.getComponent`. 1.26 builds short save keys as SSO immediates: `tools/string-users.mjs <v> <key>`
searches literals and immediates both, `tools/callers.mjs <v> 0x<rva>` lists direct callers. A propagation address can
belong to another class (`setCustomName` was an Actor getter): read the body before trusting the name. A class bdsx
allocates for the engine to fill must have that build's size (`MobEffectInstance`: 0x88 on 40, 0x90 on 51).
`ItemStack.constructWith` works on 1.26 through bdsx's own `createItemStack` over `ItemStack::fromTag` (section 18);
`getName()` and `isBlock()` through `derived()` over `Item::full_name_`/`block_type_` (section 19).

## Q2. Events never fired

`node tools/event-coverage.mjs` is the list (2026-09-23: `blockDestroy`, `entityStartSwimming`,
`levelExplode`, `playerCrit`, `playerDropItem`, `playerSleepInBed`, `playerUseItem`). All fired by 2026-10-02 (the
live-bot harness, `findings-bot.md` section 10), `entityStartSwimming` from a client included (bdsx `0f49dd03`). Already confirmed and not to redo: `playerDropItem`'s
prototype and hook installation, and `bdsx:Actor::attack`'s address/prototype
(`docs/findings-slots.md` "Changed signatures", `docs/findings-audit.md` "attack"). `blockPlace` fires from
a client's placement (the harness `place`). Probe notes: every Q2 hook in `tools/entity-sig-probe.ts` is a `SIG_EVENTS`
opt-in; drivers `q2ev`/`q2kb`/`q2hu` 40/51; **always follow `save hold` with `save resume`**, or `stop`
never finishes.

## Q5. Packets

What is left needs Q7 or is new work:
- `InventoryTransactionPacket.transaction`: fired by a client's hotbar drop 2026-10-02 (`findings-bot.md` section 10).
- Kick (`disconnectClient` on `disconnectClientWithMessage`, `skipMessage` dropped): done 2026-09-27 (`findings-packets.md` "Kick").
- Player IP and ping: done 2026-09-27 (`getAddress` through `GetSystemAddressFromGuid`; `findings-packets.md` "IP and ping").
- `ConnectionRequest.getCertificate()` / `ExtendedCertificate::*`: done 2026-09-24 (rebound onto the game server token;
  `findings-packets.md` "Certificate"). An online login's real xuid is untested (online-mode off).

Rules from this area: a driver that gives items or lets the bot pick them up **ends with
`gamemode survival @a` and `clear @a`** (the shared world carries the debt to the next session). A
`derived()` trampoline's registers are checked against `paramPairs` in `bdsx/makefunc.ts` — `this` is
rcx, the sret pointer rdx.

## Q6. A new BDS build

The procedure is `docs/HANDOFF.md` section 6. First read that build's Endstone release's
`src/bedrock/symbols/windows.h` (an exact name→RVA table for the binary; 16/16 and 18/18 against ours). Also
check every time that the default allocator is still a thin wrapper around the imported ucrt `malloc`: a tail
jump (`ff 25` / `48 ff 25`) to the `malloc` import slot preceded by `mov rcx,rdx; cmp rdx,1; adc rcx,0`
(1.26) — `msAlloc`'s only premise (`findings-utils.md`).

## Q7. Client-packet checks: the live-bot harness

Since 2026-10-02 (user: automate Q7) the client side is a harness: `tools/livebot.cjs` plays as a 1.26 client and
`tools/livebot-probe.ts` drives it over `LB_PORT` (`lb run <scenario...>`, drivers `lb40/51`, `findings-bot.md` sections 7-10).
A new client-driven check is a scenario in the probe; `node tools/livebot.cjs --selftest` checks the packets locally first.
Node's event loop runs again while the server runs (bdsx `d6a8de04`): `setTimeout`/`setInterval`/sockets work in probes and plugins.
Every item of the old human list fired through bdsx on both builds (attack + cancel, crit, jump, walk, break, right-click,
chest, place, hotbar drop + cancel, snowball, bow, eat, bed, swim + cancel, interact, sneak, chat, `/me`, a form). The simulated
player covers `dropAllOnDeath` and `checkBlockDestroyPermissions` (`findings-slots.md` "Q7 through a simulated player").
Arena rules: pigs leave by the void and drops are cleared before an item use (a picked-up stack makes the next transaction
SourceItemMismatch); bdsx's stock `event-playerdropitem.ts` cancels every other drop.

## Q8. Unexplained observations

**Since the this-getter fix (2026-09-27) none of the shapes below has recurred.** The counts are in
`findings-gamethread.md` "After the fix": 300 warm joins, 170 fresh 51 boots and 40 full sessions, all clean. The
fix was for freed hook buffers the engine kept writing into. The shapes are recorded as *not recurring*, not as
explained. If one comes back with the fix in, keep the dump or `.err`: it is then a different cause.
- -1 **after** `Quit correctly` (late GC, `StructurePointer::finalize`), was ~1 in 12 full sessions. 0 in 40 since.
- 0xC0000005 reading `0x3f800000` at the bot's join, 51 only, was 3 of 364 (`isChunkInTickRange` on a bad
  `LevelChunk`, `findings-gamethread.md` "The `0x3f800000` fault, named"). 0 in 170 fresh-boot joins since.
- 0xC0000374 at `stop`, once (51 `layout51stale` 2026-09-25, `EFF_STALE=1`). Execute faults ~15 s after a join,
  five times on 2026-09-23..25 (JIT'd code gone; logs in `work/host-runs/q8/`; turning the JIT off would need a
  bdsx-core rebuild with `JsRuntimeAttributeDisableNativeCodeGeneration`).
- ~~`getEffect(Speed)` null~~ **solved 2026-09-25**: the probe's `MobEffect` key was an `as()` view of an
  `AllocatedPointer` it dropped, so after a GC the id came from freed memory (`findings-components.md` "Q8").
- ~~`?sendArmor@Mob@@` crashes from a console command~~ **solved 2026-09-27**: the probe called `getArmor` first, whose
  address was `ActorEquipment::getArmorContainer` (`findings-audit.md` "sendArmor: the crash was getArmor").
- The 51 bot sometimes connects but never spawns (no `Player Spawned`; stays connected until the host closes it):
  twice in `score51` 2026-09-24, so `@a` was empty and every player check failed; a solo rerun spawned and passed
  8/8. A probe that prints "(no player)" is this, not the code — rerun before reading anything into it.
- Calling BlockItem's `buildDescriptionName` for oak_planks from JS on 1.26.51 leaves a SpinLock held: `stop` then asserts
  `SpinLock in use while destructing` (three sessions; stone, chest and non-block items do not). bdsx no longer makes that
  call (`findings-containers.md` section 20); why the lock stays held is not known.
- Red `Symbol not found` lines at boot are normal; only a new one is news.

---

## Closed — do not re-try

| method | result |
|---|---|
| whole-function byte matching | 1 of 736 |
| wildcard signatures, whole function | 2 of 696 |
| sliding-window signatures | 0 at >=24 bytes, 0–7% at 8 bytes |
| mnemonic sequences, operands ignored | 0 |
| RTTI / vftable via RTTI | premise false: BDS builds with RTTI off |
| import anchoring, as a bulk method | 11 of 1,065 call a rare import |
| BinDiff / call-graph diffing | 2 of 9, every game function wrong, 0 of 82 vftables |
| version chaining | 20 vs 31 direct; first hop loses 93% |
| seeding propagation with confirmed symbols | 0 new |
| positional vftable slot matching | 0 tables: indices shift between builds (`Level::tick` #99 -> #119) |
| per-slot features for alignment: function size, callee overlap | 0 gain on a 200-sample holdout |
| vftable walk output for look-alike tables (packets, MinecraftEventing) | 3 of 9 packet vftables wrong; strict-between-anchors only |
| LeviLamina PreLoader reversing | every route closed |

**A newer PDB-bearing build does not exist.** Mojang removed `bedrock_server.pdb` in **1.21.20** (August
2024), and the 1.21.10 preview already lacked it, so 1.21.3.01 is effectively the last build that has one.

**The Linux build stays excluded.** It has symbols, but Itanium-mangled against a different ABI, and the plan
forbids deriving Windows names from it. Using it as a structural oracle would need the user's decision.

Sources: [Did Mojang Just Remove Modding For Minecraft Bedrock?](https://apexminecrafthosting.com/blog/did-mojang-just-remove-modding-for-minecraft-bedrock/),
[Request to Continue Providing PDB Files](https://feedback.minecraft.net/hc/en-us/community/posts/27425253557389-Request-to-Continue-Providing-PDB-Files-in-Future-BDS-Versions).
