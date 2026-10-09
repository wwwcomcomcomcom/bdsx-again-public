# Slots the walk leaves open: what pairs, bodies and execution each settle

Done 2026-09-17, on 1.26.40.8 and 1.26.51.1. The job was to reach the 890
of bdsx's 1,080 names still missing after `findings-instances.md`, starting
from a measurement of what they are.

## The gap, measured

Of the 890 missing names (`data/required-symbols.json` against
`data/merged-1.26.40.8.json` before this work):

| shape | count | note |
|---|---|---|
| non-virtual member | 512 | 205 are leaves with no `.pdata` entry in the baseline (a getter of a few bytes); 32 are hook targets |
| virtual member, in a baseline vftable | 169 | **157 unnamed by the walk**, 33 of them `Level` virtuals inside the table the live vptr confirmed slot for slot |
| vftable | 63 | `Actor`, `ItemStack(Base)`, `Item`, `BlockSource`, `BlockLegacy`, `CompoundTag` and the tag family, the `*ItemComponent` family, three `Dimension` tables, `StructureManager`, `ServerScoreboard`, `TickingArea` |
| constructor / destructor | 32 / 16 | |
| static member | 61 | |
| data (`Vec3::ZERO`, `SharedConstants::*`) and `tryGetComponent<T>` templates | 44 | |

681 of the 890 are declared in `bds/implements.ts`: the JavaScript API
surface, called and never hooked. 71 are hook targets.

In the baseline call graph, 362 of the 890 are one hop (caller or callee)
from a function the target already names; 375 have no direct call edge at
all (leaves, or reached only through vtables); 15 have no baseline address.

Re-seeding call-edge propagation with everything now known (4,742 names on
1.26.40.8) grew the pair set by 208 in the first round and 2 in the second,
and named 0 new required symbols: **the positional rule is saturated**.

## Route 1: a pair that lands in the right table (`tools/pairs-in-tables.mjs`)

The walk leaves a slot open where the table-count sequence around it is
uniform. Propagation knows nothing about vftables. Where a propagation pair
`b -> t` puts `t` inside a target table already paired with a baseline
table that holds `b`, the two seem to agree independently.

| build | rule hits | agree with the walk / disagree | new names | new required |
|---|---|---|---|---|
| 1.26.40.8 | 2,239 | 2,023 / 3 | 231 | 18 |
| 1.26.51.1 | 2,236 | 2,189 / 0 | 44 | 4 |

The three disagreements are identical-code-folded trivial getters, where
both names are right. 99.9% agreement where the walk already had an answer.

**Where the walk had no answer, the rule was wrong half the time.** The new
`Level` names were checked by execution (`tools/level-getter-probe-launcher.js`:
call the function on the running server and compare with the world's own
`level.dat`, round-trip the setters, read the vftable of any object a getter
returns):

| pair said | slot | truth |
|---|---|---|
| `getDefaultSpawn` | #136 | **right**: (29,32767,14), equal to level.dat SpawnX/Y/Z; round-trips with `setDefaultSpawn` |
| `setDefaultSpawn` | #137 | **right** |
| `getActorFactory` | #288 | **right**: the object's vptr is a 1-slot table, as the baseline's `ActorFactory` |
| `getBlockPalette` | #86 | **right**: a 5-slot table, as the baseline's `BlockPalette` |
| `getTime` | #133 | **wrong**: the slot takes an int argument (`mov esi, edx`) |
| `setTime` | #134 | **wrong**: the slot is the 32-bit `getSeed` (returned 2696124083, the low word of level.dat RandomSeed) |
| `getSeed` | #135 | **shifted**: a new 64-bit seed getter returning through a hidden pointer (its high word equals RandomSeed's) |
| `getActiveUsers` | #325 | **wrong**: the returned "vector" is garbage |
| `getAdventureSettings` | #344 | **wrong**: the slot returns a byte |

The reason is visible in the disassembly. Between `getSleepStatus` and
`getDefaultSpawn` the baseline has three slots (`getTime`, `setTime`,
`getSeed`) and the target has three (an int-taking function, `getSeed`, a
64-bit `getSeed`). Same count, different content: `getTime` is gone from
this position and a variant was inserted. Table counts cannot see it, and
propagation, which matches call sequences positionally, shifted the whole
run by one and landed every pair inside the same table. The two routes are
not independent on exactly the slots where the walk needs help.

So `data/candidates-pairs-in-tables-<v>.json` is kept as a **candidate
generator for execution checks** and is deliberately not merged
(`tools/merge-symbols.mjs`).

## Route 2: the body (`tools/slot-shape.mjs`)

What told getTime apart was its body, so that check is now a tool: which
argument registers (`rdx`, `r8`, `r9`, `xmm1..3`) a function reads before
writing them, from a linear scan of its first instructions, with a call
clobbering all of them (`__chkstk` excepted) and a conditional branch ending
the scan as *incomplete*. A pairing is vetoed when the target reads a
register the baseline never reads, and only when the baseline's set is
complete. The other direction is not held against it: a read the baseline
makes early the target may make later or not at all, and ret versus tail
jump, or the width of the last write to rax, is codegen.

| applied to | vetoed | of which shown wrong by execution |
|---|---|---|
| the 41 execution-confirmed symbols of `resolved-1.26.40.8.json` | **0** | — |
| the 28 new required pair names above | 5 | `getTime`, `getSeed` (the shifted one), `getActiveUsers`; `_hurt` and `startSleepInBed` read an extra register, a signature change either way |
| the 4,113 walk names | 804 | unknown; three inspected: `BlockVolumeTarget::getMaxHeight` (a 3-instruction getter paired with a function that saves five registers) and a folded `mov rax,rcx; ret` thunk paired with a different thunk look like walk errors; `Mob::getArmorTextureIndexInSlot` is the artifact below |

It misses `setTime` (the target reads *fewer* registers) and it cannot
distinguish a wrong pairing from a changed signature; for bdsx both are a
call with the wrong arguments. Its blind spot is forwarding: a function that
passes `edx` untouched to its first call never "reads" it, so a baseline set
that is empty at a call is not really complete. 690 of the 804 walk vetoes
have that shape, and until the scan can tell forwarding from absence the
list is for review, not a veto: **not applied to the table**. Three earlier versions of the rule vetoed
8, then 1, then 661 confirmed or agreeing names: register names are not
word-bounded in AT&T syntax, `Level::getStructureManager` is a `ret` in
2024 and a tail jump in 2026, and `Player::_shouldProvideFeedbackOnArmorSet`
reads its arguments only after branching on a field of `this`.

## Route 3: execution, which settled it

`tools/level-getter-probe-launcher.js` runs on the Windows host under
`tools/run-launcher.ps1`, with `LG_CONFIG` naming the addresses to try.
Level::tick is the only hook; everything else is a call inside a try. Six
names and two vftables are now in `data/resolved-1.26.40.8.json` and
`data/candidates-instances-1.26.40.8.json` with their evidence:

| name | slot | evidence |
|---|---|---|
| `Level::getSeed` (uint32) | #134 | equals the low 32 bits of level.dat RandomSeed |
| `Level::getDefaultSpawn`, `getSharedSpawnPos` | #136, #138 | equals level.dat spawn; the baseline folds the two names onto one address and the live table holds that address at both slots |
| `Level::setDefaultSpawn` | #137 | round trip through getDefaultSpawn |
| `Level::getActorFactory`, `??_7ActorFactory@@6B@` | #288 | the returned object's vptr is a 1-slot code-referenced table |
| `Level::getBlockPalette`, `??_7BlockPalette@@6B@` | #86 | a 5-slot table |

bdsx's required coverage on 1.26.40.8: **190 -> 196**. The full lifecycle
(`tools/run-full.ps1`) ran on the rebuilt table: `Server started.` at 8 s,
`serverOpen` with 15 of 16 fields, the example plugin, `Quit correctly`,
exit code 0.

Three host lessons, each of which cost a run: bdsx-core embeds a node old
enough to lack `??`, `BigInt` and `readBigInt64LE`; a 64-bit seed does not
survive a JavaScript double (the first "mismatch" was the level.dat value
losing its low bits, not the function); and `run-launcher.ps1`'s printed
subset can miss the first lines of the output file, so the file itself
(`C:\bdsx-again\<tag>.out`, `findstr`) is what to read.

## Route 4: carry names between adjacent builds (`tools/carry-pipeline.mjs`)

Every walk so far aligned against 1.21.3.01, two years and a compiler away.
Two builds weeks apart share almost every slot, so 1.26.40.8's named tables
were written in the baseline-slots format (`tools/slots-from-named.mjs`,
all 30,110 scanned tables so the count feature is computed over the whole
set, names from the merged table only) and 1.26.51.1 was walked against
them twice with disjoint seeds, corroborated, and vetoed with the
1.26.40.8 -> 1.26.51.1 string/call-edge pairs.

| | |
|---|---|
| names the carry and 1.26.51.1's own routes both hold | 3,494 |
| agree / disagree | **3,460 / 34** (99.0%), disagreements excluded |
| names carried | 3,277, plus 516 vftables |
| new on 1.26.51.1 | 447 names; **11 required** |
| 1.26.51.1 coverage | 185 -> 192; merged table 6,855 names |

The first attempt, with only the 552 named tables on the 1.26.40.8 side,
agreed on 1,002 of 1,164: the count feature needs every table. The carry
ranks above the walk in `tools/merge-symbols.mjs` and below the live
sources, and hook targets are still taken only from execution-confirmed
sources. The eleven include the six execution-confirmed Level names, and
those were then executed on 1.26.51.1 with the same launcher: `getSeed`
returned the same low word of the same world's seed, `getDefaultSpawn` the
same spawn with the same round trip, and `getActorFactory` /
`getBlockPalette` objects whose vptrs are a 1-slot and a 5-slot table again
(`data/resolved-1.26.51.1.json`, `data/candidates-instances-1.26.51.1.json`).
The full lifecycle then ran clean on the carried table. A carried name that
was right on the previous build stayed right on the next: 5 of 5.

## Route 5: pure getters, called blind (`tools/pure-getters.mjs`, `tools/getter-fingerprint-launcher.js`)

A slot whose body only reads a field and returns (no argument register, no
store, no call beyond `getLevelData` and the property lookup) is safe to
call with nothing but `this`, so every such slot of the live Level table
was called at two ticks on both builds: 83 pure getters in 409/410 slots,
69 distinct functions.

- **No numeric getter advanced with the tick.** `Level::getTime` is not a
  pure slot of this table on either build; it moved or lost its purity.
  The bools and enums are constant and match the walk's names where it
  has them (`getXBLBroadcastMode` = 3 on both builds).
- **The pointer getters hand back objects, and `*(void**)object` is a
  vftable, exact.** 15 distinct live tables on each build. Small ones (1
  to 6 slots) cannot be told apart by shape -- 3,502 of the baseline's
  4,159 six-slot tables are compatible with one of them -- and a 383/385-
  slot table has no baseline table within 30 slots of it. Two are unique:

| live table | slots | baseline tables of that size | fully compatible (`tools/table-identify.mjs`) |
|---|---|---|---|
| `??_7ServerScoreboard@@6B@` (0xa52ebc0 / 0xa650ec0) | 16 | 14 | **1**, on both builds; plain `Scoreboard` fails 7 of 16 |
| `??_7LoopbackPacketSender@@6B@` (0xa534480 / 0xa6553a0) | 9 | 950 | **1**, on both builds |

> **Retracted 2026-09-24:** the unique shape match was the wrong table. `LoopbackPacketSender`'s own table is
> 40 `0xa62c2e0` / 51 `0xa71ab10` (11 slots, stored by its destructor, holds `sendToClient`/`sendToClients`;
> `findings-packets.md` "packetSend for recipient-list broadcasts"). A unique shape among 950 candidates still named
> the wrong class.

`ServerScoreboard` is a required vftable; both go into
`data/candidates-instances-<v>.json` as live-read tables. Neither table's
slots transfer by position: the Loopback table's slot 5, where the baseline
has `sendToClients` (a hook bdsx wants), is a two-instruction getter in
both builds, so a virtual was inserted and something dropped, at equal
length again. Coverage: **197** of 1,080 on 1.26.40.8, **194** on
1.26.51.1.

## Route 6: a client (`tools/run-client-probe.ps1`, `tools/probe-client.cjs`)

27 of the 71 missing hook targets are `Player`/`Mob` virtuals that only
fire with a player. A headless client (bedrock-protocol, MIT, run on the
Windows host itself against 127.0.0.1 because its native RakNet backend
has no macOS arm64 build and its JavaScript one never completed the
handshake, although raw RakNet pings from the analysis machine were
answered 6 of 6) joins once `Server started.` appears; the driver writes
`kill @a` to the server 20 s after the join and `stop` 25 s later. Counter
probes sit on the 13 candidate addresses (walk, pairs, resolved) that are
32+ bytes with a `.pdata` entry, and captures record `rcx`/`rdx` at
`die` and `respawn`.

On 1.26.40.8 the client joined at 9 s, spawned, died to the kill, and
left on `stop`:

| probe | fired | when |
|---|---|---|
| `Player::respawn` (pairs-in-tables) | 1 | at the client's spawn |
| `Mob::die` (pairs-in-tables) | 1 | at `kill @a` |
| `Player::drop` (resolved) | 1 | with the death |
| the other 10 (`attack`, `_hurt`, `useItem`, ...) | 0 | nothing the bot did calls them; `kill` bypasses `_hurt` |

Both firing probes had `rcx` = the same player object, whose vptr is
exactly the table the two-walk agreement had paired with
`??_7ServerPlayer@@6B@` (247 slots). `respawn` and `die` are now in
`data/resolved-1.26.40.8.json` and eligible as hook targets; the
ServerPlayer table is now live-read. The `rdx` captured at `die` carries a
5-slot vftable where `ActorDamageSource` has 22 in the baseline, so it is
not named. Coverage: **199** on 1.26.40.8.

A second and third run had the bot act and the driver issue console
commands before the kill (`xp 5L @a`, `damage @a 1 entity_attack`, a
zombie summoned and teleported onto the bot, which swings at every
hostile it sees, and a dimension change):

| probe | run 2 | run 3 | verdict |
|---|---|---|---|
| `Player::addLevels` (pairs) | 1 | 4 | **confirmed**: zero without `xp`, one and four with it |
| `Player::respawn` | 2 | 2 | confirmed again: spawn, then the completed respawn |
| `Mob::die`, `Player::drop` | 1, 1 | 1, 1 | as before |
| `Mob::_hurt` (pairs, shape-vetoed) | 0 | 0 | `damage @a 1` did not reach it: not `_hurt`, or `_hurt` with the changed signature the veto saw |
| `attack`, `changeDimension`, the rest | 0 | 0 | the bot spawned at y = 32769 (the world's spawn sentinel), so nothing was in reach and the dimension teleport did not take |

Coverage: **200** on 1.26.40.8, and the full lifecycle then ran clean
with `respawn`, `die` and `addLevels` installed as real bdsx hooks.

On 1.26.51.1 the server answers "outdated_client" to the library's newest
protocol (2169, for 1.26.45). With `BP_SPOOF=1` the bot reads the server's
number from a raw RakNet ping (2193) and sends that with the 1.26.45 packet
formats: it joined and spawned, `Player::respawn` (0x2bc2f0, carried)
fired once and is execution-confirmed there too, and 6 s later the
client died before the kill command.

What killed it (2026-09-18, traced with a packet-logging copy of the bot)
was not the read error but the bot's own attack: the first 1.26.45-format
`inventory_transaction` is answered 58 ms later with
`packet_violation_warning` and the server drops the connection. The read
error was `camera_presets` (0xC6), which bedrock-protocol PR 804
(`github:MooMoo2026-26/bedrock-protocol#26.51`, installed on the host as
`C:\bdsx-again\bot-pr804`) skips; the PR's other change, `CURRENT_VERSION
= 1.26.51`, does nothing because minecraft-data has no 1.26.51 data
(latest is 1.26.45, protocol 2169; PR 784, the 20k-line NetherNet fork,
also targets 2169). With the PR install, `BP_VERSION=1.26.45 BP_SPOOF=1`
and the new `BP_NO_ATTACK=1`, the bot ran the whole cycle on 1.26.51.1:
tp, xp, damage, the Nether teleport, `kill @a`, death, respawn, and the
driven stop (`host_disconnected` at 102 s, `Quit correctly`). Left for
1.26.51: `inventory_transaction` (attacks) and `update_attributes`, whose
entity health parses as undefined; both need the 2193 packet definitions.

Two things that looked like transport failures and were not: BDS 1.26.51
prints `NetherNet is the only supported transport type` and a RakNet
client still joins, spawns and plays with or without `transport=raknet`
in server.properties; and under `tools/minimal-launcher.js` (which exits
ten seconds after the first `Level::tick`) every bot lost inbound traffic
at ~8 s and timed out at 17.5 s with no `Player disconnected` on the
server. `tools/idle-launcher.js` is the same launcher without the exit.

With the bot surviving, the counter probes ran on 1.26.51.1 under
`tools/instance-probe-launcher.js` (`work/vft/probes-51c.json`,
`captures-51c.json`, output `cp-run7-1.26.51.1.txt`):

| probe (51 address, source) | calls | verdict |
|---|---|---|
| `Mob::die` 0x29b7770 (Endstone slot 122 = pair map) | 1 at `kill @a`, rdx an ActorDamageSource by its vftable | confirmed |
| `Player::addLevels` 0x2c5750 (Endstone slot) | 1 with `xp 5L` | confirmed |
| `Actor::hurt` 0xd37740 (propagation = pair map) | 162 (5 by tick 200) | confirmed |
| `Mob::_hurt` 0x29e5cb0 (Endstone slot = carry = propagation) | 0 by tick 200, 7 by the end | confirmed: nothing hurt before the commands, hurt mobs after |
| Mob slot 134, 0x29b4e60 (guessed as `_hurt` from 40's slot number) | 14 by tick 200, 28 by the end | not `_hurt`: fires with nothing hurt. It is `Mob::readAdditionalSaveData` (entity load): the slot after `_hurt`, pair of 40's Mob slot 135 at the same 3,431 bytes |
| `Player::attack`, `Mob::attack`, `doHurtTarget`, `Actor::_hurt` (carry) | 0 | nothing hit anything; undecided |
| `Player::respawn`, `Player::drop` (resolved, controls) | 2, 1 | as on 40 |

The four confirmed names are in `data/resolved-1.26.51.1.json` with their
provenance, plus `Mob::readAdditionalSaveData`; `Mob::_hurt` is new to the
1.26.51.1 table (three routes agreed on it before, but it had never made it
into `symbols.json`). Coverage: **247** on 1.26.51.1.

A slot number does not carry between builds: `_hurt` is slot 134 on
1.26.40.8 (Actor, Mob, Player/ServerPlayer, Zombie and ItemActor tables each
hold their own `_hurt` there; `Player` overrides it, so the ServerPlayer
table never holds `Mob::_hurt`) and slot 133 on 1.26.51.1, because
`Actor::shouldTryMakeStepSound` (40's slot 133) is gone. The first
promotion here read 40's slot number into 51's Mob table and named
`readAdditionalSaveData` as `_hurt`; the "14 calls before anything was
hurt" count is what refuted it. A counter that is nonzero before the
stimulus is a different function, whatever the ratio afterwards.

`Actor::_hurt` itself exists (1,139 bytes in the PDB build, 1,234 on both
1.26 builds, at the Actor table's `_hurt` slot) and is the fallback for
non-Mob actors: `ArmorStand`, `Boat`, `Minecart`, `ItemActor`,
`HangingActor`, `EnderCrystal` and the projectiles override it. Of the
`_hurt` family bdsx needs only `Mob::_hurt`; `Actor::hurt` (public,
non-virtual) is what its `implements.ts` calls.

Two more runs on 1.26.40.8 (`work/vft/probes-hurt40.json`, outputs
`cp-run8-hurt-1.26.40.8.txt` and `cp-run9-hurt-1.26.40.8.txt`) put counters
on every walk-named `_hurt` override and had the console summon and damage
actors of each kind:

| probe | calls | stimulus |
|---|---|---|
| `ArmorStand::_hurt` 0x23b88f0 | 2 | two `damage @e[type=armor_stand]` (both "could not apply"; rcx captured) |
| `Boat::_hurt` 0x2d2e820 | 2 | `damage @e[type=boat]` on two boats |
| `Minecart::_hurt` 0x2d3d6b0 | 3 | `damage @e[type=minecart]` on three minecarts |
| `ItemActor::_hurt` 0x2d3b940 | 1 | `damage @e[type=item]` on one dropped item |
| `Actor::_hurt` 0xdf9db0 | 1 | `damage @e[type=arrow]` on a summoned arrow, the one actor reached that has no override; 0 in the first run against 249 `Actor::hurt` calls |
| `ExperienceOrb::_hurt` 0x2d32930 (60 bytes) | 0 | two orbs "could not apply": `Actor::hurt` refuses before the virtual, or the walk name is wrong; left as is |

An arrow summoned next to the bot is picked up before the damage command
reaches it (`No targets matched selector`); summon it 16 blocks away.
`area_effect_cloud`, `snowball` and `painting` did not survive to the
command either. All five names are in `data/resolved-1.26.40.8.json` as
hook-eligible; none is bdsx-required, so coverage on 1.26.40.8 stays at
**255** (the number `docs/status.md` carried as 254 was stale: the
committed merged table already covered 255).
The 1.26.51.1 `Actor::_hurt` (0xd397e0, carry, slot 133 of the Actor
table, the same 1,234 bytes) has not been executed there.
A fourth run teleported the bot to the ground first (`tp @a 29 68 14`)
before the zombie was summoned onto it: the same four probes fired, and
`attack` and `_hurt` still did not. The attack transaction the bot sends
is not accepted as a hit, or the candidate addresses are wrong; telling
the two apart needs the server's reaction to a known-good client, which
is the next thing to instrument.

A fifth run added the walk's and propagation's hurt/attack functions as
probes and damaged the zombie by console. `Mob::_hurt` (the pairs
candidate the shape veto had flagged) fired **71** times and
`Actor::hurt` (propagation) **576** times -- natural zombies burning in
daylight and the console damage -- against zero in every run where no mob
was hurt, so both are execution-confirmed on the damage path. The veto
was right about the signature, not the address: `_hurt` now reads `xmm3`
where the 2024 prototype reads `xmm2`, so bdsx's hook prototype for it
needs a look; the full lifecycle nevertheless ran clean with `_hurt`
installed as a bdsx hook, since nothing was hurt during it. `Player::attack`,
`Mob::attack` and `doHurtTarget` stayed at zero: nothing hit anything. Coverage: **201** on 1.26.40.8 (`Actor::hurt` was already in the table from propagation; it is now confirmed).

Two more runs isolated the bot's own swings: difficulty set to peaceful,
every entity killed by console first, then a pig summoned and teleported
onto the bot, with the launcher printing every probe's count every 200
ticks (`IP_REPORT_EVERY`). `Mob::_hurt` rose to 61 in the window of the
console kill and did not move again while the bot swung at the pig for
15 s; `Player::attack` stayed at zero. **The bot's attack transaction is
not accepted as a hit**, so `attack`, and everything else that needs a
real hit or item use (`useItem`, `startSleepInBed`, `startSwimming`,
`_crit`), cannot be confirmed by this client. A person with a real client
on the test server, under the same counter probes, would settle all of
them in one session; the probes and driver are ready for that
(`tools/run-client-probe.ps1` without `-Bot`, join over the open UDP port).

The player object's own members were also read: 7 distinct vftables in
its first 0x300 bytes (the Level, a 43-slot table, a 10-slot one, four
tiny ones). None is identifiable by shape -- the 43-slot table matches
none of the 57 baseline tables of that size, so its class changed size --
and the 10-slot one has 694 compatible candidates.

## Route 7: call edges, gap by gap (`tools/propagate-gaps.mjs`)

The positional propagation rule needs whole callee lists of equal length.
With thousands of names known, most callee lists contain several
already-paired callees; between two consecutive such anchors, the unknown
callees are paired positionally when the gap has the same length on both
sides, and a gap that grew or shrank is skipped. Votes across callers,
mutual best, no double claims.

| held-out split (20% of known pairs) | reached | right | wrong | precision |
|---|---|---|---|---|
| 1 | 280 | 270 | 10 | 96.4% |
| 2 | 241 | 235 | 6 | 97.5% |
| 3 | 252 | 244 | 8 | 96.8% |

Run for real it proposes **5,971** new names on 1.26.40.8 and 2,710 on
1.26.51.1, 17 and 15 of them required (`Minecraft::getServerNetworkHandler`,
the last `serverOpen` field, on both). But the held-out population is the
walk's virtuals, and the proposals are mostly non-virtuals, so the figure
was checked another way: of 581 names proposed on both builds whose
1.26.40.8 address has an independent 1.26.40.8 -> 1.26.51.1 pair, the
pair agrees with the 1.26.51.1 proposal for **396** and not for 185. The
body-shape veto fires on 3.3% of the agreeing set and 0.5% of the
disagreeing one, so the disagreement is not a signature difference:
folding was the first suspect and is ruled out: all 185 disagreeing
pairs of 1.26.51.1 addresses have different bodies, mostly of very
different sizes (66 against 397 bytes), so one side is simply wrong and
which is not settled. Three of the 17 required names on
1.26.40.8 are shape-vetoed (`Actor::isRiding` and `Actor::isCreative`
read `rdx` where the baseline reads nothing). The candidate files
`data/candidates-gaps-<v>.json` are therefore, like pairs-in-tables, an
execution queue and not a source.

The first item of that queue was executed: the 1.26.40.8 proposal for
`Minecraft::getServerNetworkHandler` (0x23c450) is a hash-table lookup
where the baseline reads a member of `this` and builds a `NonOwnerPointer`
from it, and calling it on the live Minecraft object with a hidden return
buffer killed the process. Refuted. The probe launcher now also searches
every captured object for pointers to every other, one level of holder
block down (`crossRefs`, `work/vft/crossrefs-1.26.40.8.txt`): Minecraft
holds `DedicatedServer` at +0x138 and the command registry through a block
at +0xb8, but no pointer to the `ServerNetworkHandler` within its first
4 KB, so the last `serverOpen` field stays unavailable until that link is
found.

## Route 8: Endstone's headers as a slot table (`tools/endstone-slots.mjs`)

Endstone (Apache-2.0) does not name `Actor`/`Player` virtuals at all: its
headers declare them in vtable order and MSVC compiles the call into
`call [vft + 8*N]`. That order has to be layout-exact or every call after
a missing slot would go wrong, so it is a slot table maintained by people
and tested by their plugins, and it is independent of everything the walk
does. `tools/endstone-slots.mjs` parses the `Actor`, `Mob`, `Player` and
`ServerPlayer` class bodies (245 slots; a `virtual` declaration adds a
slot, an `override` does not, a run of consecutively declared overloads
is laid out in reverse as MSVC does), maps bdsx's names by method name,
and reads each name from **its own class's table** (a derived table holds
the override). Endstone HEAD targets BDS 1.26.51, our second build.

| build | agree with the table we had | disagree | new required |
|---|---|---|---|
| 1.26.51.1 | **27** (incl. the execution-confirmed `respawn` and `drop`) | **0** | **16** |
| 1.26.40.8, Endstone HEAD (1.26.51 layout) | 11 | 19 | -- (a slot moved near 216 and elsewhere: the release must match the build) |
| 1.26.40.8, Endstone v0.11.7 (its 1.26.40 release) | **30** (every execution-confirmed name among them) | **0** | **13** |

The 16 new on 1.26.51.1: `_crit`, `_hurt`, `addLevels`, `attack`, `die`,
`getSpeed`/`setSpeed`/`setSprinting`/`hurtEffects`/`knockback` (Mob),
`getXuid`, `sendInventory`, `sendNetworkPacket`, `startSleepInBed`,
`startSwimming`, `useItem`. Independent checks: **8 of 8** that the
pairs-in-tables route also names agree with it; `_hurt`, `die` and
`addLevels` are the counterparts of the execution-confirmed 1.26.40.8
functions; and the body-shape veto fires on exactly three -- `_hurt`,
`knockback`, `startSleepInBed` -- which are the three whose prototypes
Endstone's own signature table declares changed (`startSleepInBed` gained
a bool and a float, `knockback` a `KnockbackParameters`). So the addresses
are right and the prototypes are what moved.

The source is merged for 1.26.51.1 above the carry and, unlike every other
inferred route, trusted for hook targets, except the three whose prototype
changed: they keep their address and are dropped as hooks, since bdsx's
old prototype would read the wrong registers. Coverage: 1.26.51.1
**195 -> 208**, 1.26.40.8 **201 -> 212** (`attack`, `useItem`,
`startSwimming`, `_crit` and `startSleepInBed` land exactly on the
pairs-in-tables candidates there too). The full lifecycle ran clean on
1.26.51.1 with the 16 installed as bdsx hooks (ready in 5 s, `Quit
correctly`, exit 0), and on 1.26.40.8 with the 11 hookable new ones
(ready in 4 s, exit 0). Left open: `Actor`-declared names (no `Actor` table is
held yet; a plain actor's vptr, from the pig or an item entity, would give
it), the two `changeDimension` overloads, and 1.26.40.8, which needs the
Endstone release that targeted 1.26.40.

The same tool run on the `Level` family (`ILevel` 403/404 declared
virtuals, `Level` 7, against our 409/410-slot live tables) showed the
limit of the route: 28 to 29 new required names, but **5 disagreements
with execution-confirmed addresses on each build** -- `tick` and
`getSeed` one slot early, `getDefaultSpawn` and `setDefaultSpawn` swapped
-- and 10 shape flags on Level names that are not signature changes. A
header is layout-exact only where Endstone's own code calls through it;
`ILevel` is mostly not called, so its errors survive. The family is
therefore not merged (the Level output is kept in
`work/vft/endstone-level-<v>.json`), and the checks that caught it --
agreement with confirmed names and the shape veto -- are what any further
family has to pass first.

### More families: scoreboard, command origin, connector (2026-09-17)

Only classes whose table we hold exactly can be read, which after the
instance work means those read from live objects. Of the classes with
missing required virtuals, four have both a live table and an Endstone
header: `ServerScoreboard` (6 names), `ServerCommandOrigin` (5),
`RakNetConnector` (2) and `LoopbackPacketSender` (1). `Item` and
`Container`, which `next-steps.md` named as next, turned out not to pay:
no `Item` table is held and bdsx asks for no `Container` virtual.

Three changes to the tool came first, each checked against the old output
(the Actor family's 43 names came out identical on both builds):

- **Nested types are skipped.** `Connector` and `RakNetConnector` declare
  `ConnectionCallbacks` structs with virtuals of their own, which the
  line-joining parser would have counted as the class's slots.
- **Overloads are told apart by the decorated name**: constness, and the
  type names one declaration mentions and its siblings do not; one match,
  or the name stays ambiguous. The reverse-order rule it relies on is
  visible in the baseline's own tables: `Scoreboard` declares
  `createScoreboardId` for Player, Actor, string and 1.21.3.01 lays out
  string, Actor, Player; `PacketSender`'s two `sendToClient`s and two
  `sendBroadcast`s are reversed the same way.
- **The comparison excludes the tool's own output.** `merged-<v>.json`
  already holds the previous run's names, so a rerun counted them as
  agreeing with themselves; the sources are now read directly (which is
  why the Actor family now reads 35 agree / 8 new: 5 of the former "new"
  were walk names the merge had dropped as untrusted hook targets).

And one new check, the **length gate**: a table shorter than the slots the
headers lay out up to its class cannot be laid out as they say, so none of
its names are read. A longer one is allowed, since a derived class may add
virtuals its header omits (`ServerPlayer`: 247 against 245).

| family | header slots | live table, 1.26.40.8 / 1.26.51.1 | verdict |
|---|---|---|---|
| Actor, Mob, Player | Mob 175 / 174, Player 245 | Mob 175 / 174, Player 245 | exact on both |
| Scoreboard | 16 | 16 / 16 | pass |
| CommandOrigin (v0.11.7 / HEAD) | 34 / 35 | 34 / 35 | pass: the releases differ by one slot and so do the builds |
| Connector, RemoteConnector, RakNetConnector | 22 | 22 / 22 | pass |
| EnableNonOwnerReferences, PacketSender | 11 | **9** / **9** | **rejected**: `isInitialized` and `sendTo` are not in these builds |
| ILevel, Level | 410 / 411 | **409** / **410** | **rejected**: the verdict the confirmed addresses gave, from an independent check |

The bodies read like their baseline counterparts. `ServerCommandOrigin`'s
`getLevel` (`mov rax,[rcx+24]`), `getOriginType` (`mov al,7`) and
`getRequestId` (`lea rax,[rcx+32]`) are instruction-identical to
1.21.3.01; the three `createScoreboardId` overloads have the baseline's
shapes (a counter bump for the string, an actor-flag test, a call on the
player); `getPeer`'s two overloads are one folded function on both builds,
so their order cannot matter. The walk and the carry had named 4 of the
`ServerCommandOrigin` slots, and all 4 agree.

**Execution, both builds: 18 of 18.** `tools/endstone-slots-probe.ts` runs
inside the full `launcher.ts` lifecycle and is triggered from the server
console through `events.command` (bdsx's `command.register` needs
`findCommand`, which the table lacks; and the example plugins' imports
throw at `blockcustomname`, so a probe imported after them never loads):

- the console's origin is a `ServerCommandOrigin`; `getOriginType` is 7
  (DedicatedServer), `getName` is "Server", `getLevel` equals
  `bedrockServer.level`, `getEntity` is null, `getBlockPosition` is 0,0,0,
  `getDimension` is non-null, `getRequestId` returns a string;
- `RakNetConnector::getPort` returns 19132;
- on the `ServerScoreboard` at `CommandRegistry`+0x48, after a console
  `scoreboard objectives setdisplay sidebar`: `clearDisplayObjective`
  returns the displayed objective and then null, `setDisplayObjective` puts
  it back and a clear returns the same pointer, the string
  `createScoreboardId` hands out ids 1 and 2, and `onScoreChanged` returns.

**`getPeer` exposed a wrong field.** Its RakPeer was not the one
`launcher.ts` had been reading from `layouts` (the holder at
`ServerNetworkSystem`+0xf8). Both carry the RakPeer vftable; only
`getPeer`'s holds the port in network byte order (twice, at +0x6da and
+0x762: its bound addresses), the other not once in its first 16 KB. The
holder's peer is a second RakPeer, so `launcher.ts` now takes `rakPeer`
from `getPeer` when the symbol exists, and `getPeer == bedrockServer.rakPeer`
passes on both builds. Not executed: the `Actor` and `Player` overloads of
`createScoreboardId` (no actor in the run), which rest on the header, the
baseline's order and their bodies. Coverage: 1.26.40.8 **212 -> 225**,
1.26.51.1 **208 -> 221**; none of the 13 is a hook target. The full
lifecycle ran clean with the probe on both builds (`Quit correctly`,
exit 0).

## Files

| file | what |
|---|---|
| `tools/pairs-in-tables.mjs` | pair + table membership; precision printed before writing |
| `tools/slot-shape.mjs` | argument-register veto; `--verbose` lists every veto |
| `tools/level-getter-probe-launcher.js` | call named getters live and check against level.dat and round trips |
| `tools/seeds-from-known.mjs` | propagation seeds from everything a table knows |
| `tools/slots-from-named.mjs`, `tools/carry-candidates.mjs`, `tools/carry-pipeline.mjs` | the cross-build carry |
| `tools/pure-getters.mjs`, `tools/getter-fingerprint-launcher.js`, `tools/getter-fingerprint-match.mjs`, `tools/table-identify.mjs` | pure getters called blind; live tables identified by shape among all same-size baseline tables |
| `tools/run-client-probe.ps1`, `tools/probe-client.cjs` | a headless client on the host, joined, killed and stopped under counter probes |
| `tools/propagate-gaps.mjs`, `data/candidates-gaps-<v>.json` | gap-anchored call-edge propagation; a queue for execution checks |
| `tools/endstone-slots.mjs`, `data/candidates-endstone-slots-<v>.json` | Endstone's header order as a slot table, read from our own tables; merged |
| `tools/endstone-slots-probe.ts`, `tools/run-full.ps1 -Commands` | the execution check for the scoreboard, command origin and connector families, driven from the console |
| `data/candidates-pairs-in-tables-<v>.json` | candidates for execution checks, not merged |
| `data/candidates-carry-1.26.51.1.json` | merged, with its agreement figure inside |

## Route 9: Endstone's Level order, anchored (2026-09-18, late)

Endstone's `ILevel`/`Level` headers lay out one slot more than the live
table (410 against 409 on 1.26.40.8, 411 against 410 on 1.26.51.1), which
is why route 8's length gate refuses the family. The confirmed names show
where the header is right: between header slot 35 and 288 every anchor sits
exactly one slot above its header index (`getDifficulty` 36, `getBlockPalette`
86, `getStructureManager` 96, `tick` 119, `getSeed` 134, `setDefaultSpawn`
137, `getLevelData` 172, `getActorFactory` 288). It first looked as if the
header drifted past 288, `getGameRules` sitting at 348 against the header's
341; that anchor was the error, not the header (next section), and the
region now runs to header 380. `tools/level-anchored.mjs`
reads the names whose header slot falls in that region at header+1 and
nothing outside, skipping overloads. The second route is the other build:
its own header revision puts every one of them at the same live slot with
the same function size (14 of 14 sized functions identical to the byte,
the rest leaves with no `.pdata`). Two were executed on 1.26.40.8 in the
same session: `save` (slot 180) stayed at 0 through `save hold`/`save
resume` and fired exactly once at the driven stop, and `getDifficulty`
(slot 36) called on the live Level returned 1 where slot 35 returned
garbage -- which is also what settles the region's start below the first
static anchor. `explode` is the eight-argument overload at slot 121 (it
reads `Actor*`, `Vec3 const&` and a stack float); a summoned TNT went
through the `Explosion&` forwarder at 120 instead, so 121 is not executed.
The same four probes on 1.26.51.1 (slots 180 / 121 / 120 / 245 of its own
table) read the same way: `save` 1, the forwarder 1 under the TNT, `explode`
and `levelCleanupQueueEntityRemoval` 0, lifecycle clean.
`levelCleanupQueueEntityRemoval` (245) did not fire under a pig kill and
stays call-only. `getTime`/`setTime` are left out: an earlier execution found
`getTime` is not a pure slot of this table. Shipped as
`data/candidates-level-<v>.json` (source `level-anchored`, never hook-trusted):
17 names on 1.26.40.8 beside the two resolved, 19 on 1.26.51.1; the Level
class goes from 28 missing to 9.

### The anchor that was wrong: `getGameRules` (2026-09-19)

`Level::getGameRules` had been shipped since the first getter work as ILevel
slot 348, "the only slot whose body is `getLevelData(); add rax,416`, 416
being the baseline's GameRules offset inside LevelData". It was never
called. Route 9 put it seven slots off the header, and that disagreement
was read as header drift. Read the other way round, the twelve header names
339-350 fit the twelve live slots 340-351 shape for shape -- a pair of bare
tail jumps to `getLevelData` (`getAdventureSettings`: the settings are
LevelData's first member, as in the baseline, where
`LevelData::getAdventureSettings` is `mov rax,rcx`), a const-first pair at
`+152` (`getGameRules`, const-first in the header too), four bools, one
single at `+416` (`getDefaultAbilities`), a pair at `+656`
(`getDefaultPermissions`), `getTearingDown` -- and the arithmetic closes:
656 - 416 = 240 = 20 `Ability` records of 12 bytes, and GameRules +
ExperimentStorage is 264 bytes in both layouts (416..680 in 2024, 152..416
now). What shrank is `WorldTemplateLevelData` in front of them, so "the same
offset as the baseline" was a coincidence with a different member.

Execution settled it on both builds (`LG_RAW` with a dump, slots whose
bodies had been read): slot 348 (349 on 1.26.51.1) returns twenty 12-byte
`{type, value, options}` records; slots 342/343 return one object with a
one-slot vftable, the non-owner-reference block, and a vector of 39
elements of 280 bytes whose first name is 18 characters on the heap
(`commandBlockOutput`) and whose second is the inline string
`doDayLightCycle`. `bedrockServer.gameRules` had been an `Abilities` all
along; nothing had read through it yet. The lesson is rule 2 applied to an
old entry: one route (an offset that matched the baseline) is not
agreement, and a later route that disagrees with a shipped name is evidence
about the name before it is evidence about the route.

With the anchor corrected the same header+1 reading runs on: the
`getScoreboard` / const / `tryGetScoreboard` trio is one function in three
consecutive slots (361-363; 362-364 on 1.26.51.1, which inserted one slot
at 346 -- Endstone HEAD's `unknown347`), as it was in the baseline, and
called it returns an object whose first qword is `??_7ServerScoreboard@@6B@`
on both builds. `getActiveUsers` (324) returned a vector holding one 24-byte
element while the bot was joined and an empty one from the tick after it
left. `sendAllPlayerAbilities` (366) and `updateWeather` (359) are 12-byte
forwarders (`mov rcx,[rcx+member]; jmp`), so they can be called but never
hooked; the weather forwarder's target reads `xmm1, r8d, xmm3` and a stack
int, fired once per `weather` command (3 of 3), and is the address
Endstone's own symbol table gives for `WeatherManager::updateWeather` on
1.26.51.1. That function is the hook target for `levelWeatherChange`.

Endstone's table (`src/bedrock/symbols/windows.h`, one per release, for the
exact binary) is a route of its own and was measured before use: 16 of 64
names on 1.26.51.1 were already in our table and 16 agree; 18 of 18 for
v0.11.7 against 1.26.40.8. It supplied `registerAlias` and
`registerOverloadInternal` on 1.26.51.1, which had been the only names
recorded as unresolved there (second route: the same order and spacing
after `registerCommand` as on 1.26.40.8, sizes within 8%). Three names in
it answer to a required name whose signature has changed (`Mob::knockback`,
`Player::startSleepInBed`, `ServerPlayer::changeDimension`); they are not
shipped under the 2024 decoration.

### What the correction exposed: `pdbcache.l2`

The corrected table did nothing at first. Under the full launcher
`bedrockServer.gameRules` was still the `Abilities` object, while the const
twin -- never looked up before -- resolved to the new address. bdsx keeps a
second-level cache, `bedrock_server/pdbcache.l2`, of every name `proc` has
resolved, and upstream keyed it on the exe's MD5 alone: enough while names
came from that exe's PDB, wrong now that they come from a `symbols.json`
which is corrected between runs against the same exe. A name looked up once
kept its first address for ever. The cache is now keyed on the exe and the
MD5 of the table together (`pdbcache.digest()`), so a new table starts a new
cache. Nothing confirmed earlier is put in doubt by this -- a masked
correction shows up as a failure that persists, not as a false pass -- but
any earlier "the fix did not help" on the host deserves a second look.

### GameRules without addresses, and the weather event

With the right object in hand the rest of `GameRules` needs no symbol at
all. The 2024 `getRule` / `hasRule` are a bounds check and an index into a
`std::vector<GameRule>` at `+24`; on 1.26 the vector is at the same offset
with 280-byte elements (176 then), each rule's name a `std::string` at
element `+16`, and the front of an element unchanged (`shouldSave`, `type`,
the value at `+4`: 65535, 1, 10000, 10, 100 read for the five int rules of a
fresh world). Those three numbers ship as `layouts.GameRules`, the bodies
are bdsx code (`data/derived.json`), `GameRule::getBool/getInt/getFloat`
ship as accessors, and `GameRuleId` was re-listed: 1.26 has 39 rules in
Endstone's `GameRulesIndex` order, five of them inserted into the 2024
order, so every id from `DoMobLoot` on had been off. `tools/gamerules-probe.ts`
passes on both builds: `randomTickSpeed` 1 then 7 and `keepInventory` false
then true around the console's `gamerule` commands, `doDaylightCycle` = 1,
`randomtickspeed` = 26, an unknown name -1, id 39 refused.

`levelWeatherChange` now hooks `WeatherManager::updateWeather` where Level's
virtual is the forwarder, and `Level.updateWeather()` calls the same function
on `level + layouts.Level.weatherManager`. On both builds the event carried
(1, t, 0, t) for `weather rain`, (1, t, 1, t) for thunder and (0, t, 0, t)
for clear, a call from JavaScript raised exactly one event, and `weather
query` answers the same with and without the hook (it lags the command by
the fade either way). One trap on the way: the 2024 handler `decay()`s its
level argument, a wrapper made for the call; the new handler's level is
`bedrockServer.level` itself and must not be.

Calling slots blind is not free: the getter session that read slot 36 died
at its third call (an access violation on a slot that is not a getter), so
`LG_RAW` in `tools/level-getter-probe-launcher.js` is for slots whose body
has been read first.

### The region below 35, and a walk name retracted

The anchored region had started at header 35 only because nothing below it
had been confirmed. Read the same way it fits from slot 1: the header's
const / non-const pairs are the live table's same-function pairs
(`forEachDimension` 8/9, `getDimensionManager` 10/11, `getCameraPresets`
29/30), `get/setDisablePlayerInteractions` are a byte getter and the setter
of the same byte at 32/33, and the 2024 table has the same order with one
slot fewer in front. Executed: slot 6 called with dimension ids 0 / 2 / 1
returned live references for the two loaded dimensions and null for the
nether, twice, 100 ticks apart -- a lookup that does not create, so
`getDimension`, and `getOrCreateDimension` is its twin one slot below
(order in both the header and the 2024 table; not called, it would create a
dimension). Slot 21 (`getSpawner`) returned an object with a 21-slot
vftable, the 21 virtuals of Endstone's `Spawner` -- a class with no vftable
in 2024. The vftable walk had named that table
`??_7ResourcePackRepository@@6B@`; a wrong name from a regenerated route
cannot be edited by hand, so `data/candidates-instances-<v>.json` gained a
`retracted` map (name -> why) that `merge-symbols.mjs` applies to everything
below the trusted sources. `LG_RAW` grew a `"sret"` kind for slots that
return through a hidden pointer and take one int.

## Changed signatures (2026-09-19)

Four events hook functions whose prototype changed since 2024. An address
was never the problem; the prototype was, twice fatally.

**`Mob::_hurt` / `Actor::hurt`.** `_hurt` had been execution-confirmed by a
counter probe, with a recorded caution that the body reads `xmm3` where the
2024 signature reads `xmm2`. Nothing enforced the caution: the name shipped
from `resolved`, bdsx hooked it as `(source, float, bool, bool) -> bool`, and
the first mob hit under an `entityHurt` listener killed the server. The real
prototype, read from the body and then executed: an `ActorHurtResult`
returned through a hidden pointer (rdx; damage dealt as a float at +0 with
variant index 1 at +4, allow-knockback at +8), then the source, the damage,
and **one pointer** to a 24-byte struct -- knock at +0, ignite at +1, the
rest copied into a call through vtable +1136 -- where Endstone's header
still has the two bools (Endstone does not hook it). Declared with two
bools the hook died on its first `original(...)`; declared with the pointer
it passed eight hits through and quit cleanly. No decoration for that
signature can be known, so the two functions ship under bdsx's own keys,
`bdsx:Mob::_hurt` and `bdsx:Actor::hurt`, and the 2024 decorations are
retracted. `merge-symbols.mjs` now refuses a hook target whose signature
changed whatever source supplied it.

**`Actor::hurt` was also at the wrong address.** The shipped entry
(0xdf7c20 / 0xd37740) stores a vftable at `[rcx]`, `edx` at +8 and copies
the `std::string` in `r8` to +16: a constructor. It had been promoted on a
call count ("576 times in the same run, 0 without hurt mobs") -- and an
object built once per damage attempt counts exactly like the function that
attempts the damage. The real one is the 186-byte function beside it
(0xdf7ad0 / 0xd375f0): `isInvulnerableTo(source)` through the vtable, then
the `_hurt` slot with its arguments passed straight through, the 2024 shape
(177 bytes) with the hidden return added. bdsx's `Actor.hurt()` would have
written a vftable into the actor. **A count confirms that something on the
path runs, not which thing; promotion from a count needs a body read.**

**`Mob::knockback`** is `(Actor*, float damage, float xd, float zd,
KnockbackParameters const&)` (Endstone's header and table; our own slot
placement agrees on the address). The event keeps its 2024 fields, read
from the struct (power and height are the `Vec2` at +0, the cap at +8); a
listener that changes one gets a 28-byte copy. Executed on both builds with
an iron golem and two zombies: one knockback after each hurt, 0.52 / 0.39 /
0.8 for the golem's hits, 0.4 / 0.4 / 0.4 for the zombies', slowdown 0.5.
`Mob.knockback()` **now calls that prototype too** (2026-09-21). It was still
the 2024 one -- hooked correctly, called wrongly, so `mob.knockback(...)` from
a plugin put a float where the callee wants the struct pointer. It builds a
28-byte `KnockbackParameters` with power at +0, height at +4, the cap at +8 and
the slowdown 0.5 at +12, and the check is that the values come back: after
`knockback(null, 1, 0.6, 0.6, 0.55, 0.45, 0.35)` the `entityKnockback` hook
reads 0.55 / 0.45 / 0.35 / 0.5 out of the struct, twice in a row, on both
builds (`work/host-runs/q2kb40-20260921-151539.txt`, `q2kb51-...`).

**`ActorDamageSource` is 48 bytes on 1.26, not 16 -- and that, not the hurt
struct, is what killed `Actor.hurt()`.** The class gained a `std::string` at
+16 (data +16, size +32, capacity +40): the vftable's slot 0 frees it, resets
it to the empty small string (`movq $0, 32; movq $15, 40; movb $0, 16`) and
sized-deletes **48**, instruction for instruction on both builds, where 2024's
slot 0 sized-deleted 16 and freed nothing. The constructor is gone from both
builds, so `ActorDamageSource.create` is `derived()`: vftable, cause at +8, and
the empty small string. Handed a 16-byte one, `Mob::_hurt` reads that string
out of the next heap block -- **0xC0000005 on 1.26.40.8 and, on 1.26.51.1, the
int3 at `0x5211b0`, which is the `bad_variant_access` thrower `Actor::hurt`
calls when the `ActorHurtResult` index at +4 is neither 0 nor 1**
(`work/host-runs/q2hu40-20260921-151840.txt`). The vftable ships as
`??_7ActorDamageSource@@6B@` (40 `0xa55d740` / 51 `0xa67cd90`), read off the
object BDS hands `Mob::_hurt` for `damage @e[type=iron_golem] 1 magic` -- no
damager, so the plain base class -- and confirmed by that destructor body; the
probe asserts the table's pointer and the live vptr are the same pointer.
With it, `hurt(source, 3, true, false)` returns true, the golem loses 3 health
and the server lives, on both builds (`q2hu40-20260921-152409.txt`).

**The hurt struct is `HurtEffectsSettings`** (Endstone's header): knockback +0,
ignition +1, receive_damage +2, an `optional<Vec3>` aim direction at +4 whose
engaged flag is at +16, and an extra knockback power at +20. bdsx now sets
receive_damage, because the live struct carries a non-zero +2 on both builds --
but **it is not load-bearing, and saying it was would have been wrong**: called
directly with +2 = 0, `Mob::_hurt` still dealt the damage and wrote a valid
result (index 1, float 3.0). BDS's own caller (1.26.40.8 `0x82e6010`) writes
only `movw $1` over +0/+1, zero at +16 and zero at +20, and leaves +2..+15 as
whatever the stack held.

**`playerDimensionChange`.** `ServerPlayer::changeDimension(DimensionType)`
is at the address five routes agree on, and a counter on it stayed at 0
through a `tp` into the nether: on 1.26 it is the portal path only. Every
change is a `ChangeDimensionRequest` handed to
`PlayerDimensionTransferManager::requestPlayerChangeDimension`, which ILevel
slot 17 forwards to exactly as the 2024 virtual did (that build names the
target). The event hooks it: `to` = 1 for the teleport, 0 for the respawn
back, `use_portal` false, on both builds; a request that stays in its
dimension is passed through without an event.

**`Player::startSleepInBed`** gained `(bool, float)`; the hook passes them
through. Not executed -- it needs a client that can use a bed.

**`Player::drop` did not change (2026-09-22) -- `slot-shape.mjs` gave a false
positive.** The queue flagged it from `shape()`'s report: baseline reads
`r8,rdx`, both 1.26 bodies read neither. That reading is real but incomplete
-- `shape()` stops at the *first* conditional branch (`docs/findings-signatures.md`),
and both 1.26 bodies branch within their first 14 instructions, on a field of
`this` (an inlined `Actor::hasDimension`: `Player+0x1c8`/`+0x1d0`, the same
`WeakRef<Dimension>` lock pair this project already named in the B-2 batch),
long before they touch `rdx` or `r8`. Reading both bodies to the end past that
branch: `rdx` is saved to `rdi` at entry (`movq %rdx,%rdi`, 40 `0x2321fa` / 51
`0x2bd3c5`) and used as the `ItemStack&` argument to the inlined `_drop@Actor`
call near the end (`movq %rdi,%rdx` before `callq 0xe1dab0` on 40); `r8d` is
saved to `r15d` then `ebx` across the intervening calls (40 `0x232234`,
`0x23226c`; 51 the same instructions at `+0x19` offset) and used as the
`randomly` bool at the same call. Both bodies are structurally identical
instruction-for-instruction in the parts that touch the arguments, just
1207 bytes on 40 vs 1134 on 51 from different inlining elsewhere. Endstone's
header (`work/endstone-0.11.7/src/bedrock/world/actor/player/player.h:67`
and the same line in `work/endstone/...` at HEAD) declares the identical
`bool drop(const ItemStack &item, bool randomly) override` for both releases
this project targets -- a third, independent source for "unchanged". The
existing hook in `bdsx/bdsx/event_impl/entityevent.ts`
(`procHacker.hooking("?drop@Player@@UEAA_NAEBVItemStack@@_N@Z", bool_t, null,
Player, ItemStack, bool_t)`) already had the right prototype and needed no
change. Installing it (subscribing to `events.playerDropItem` to trigger its
lazy `setInstaller`) was run on both builds via a new `drop` opt-in in
`tools/entity-sig-probe.ts`'s `SIG_EVENTS` -- **exit 0, `Quit correctly`, no
FAIL, on both 1.26.40.8 and 1.26.51.1**
(`work/host-runs/q2drop40-20260922-155747.txt`,
`work/host-runs/q2drop51-20260922-155747.txt`). That is the only thing a
console session can check here -- the event itself only fires from an
`InventoryTransaction` packet a real client sends (Q7); `sigprobe` prints
`0 fires` as an `INFO` line, not a verdict, for exactly that reason. Lesson
for the tool: **`slot-shape.mjs`'s early-branch bailout is evidence of
nothing** when the baseline's own read is `complete: true` past a branch the
target takes earlier -- `compatible()` already treats an incomplete target as
no opinion, but reading its printed `args: ''` as "this build reads no
arguments" is the trap this entry fell into. The tool's behavior is correct
(`shape()`'s docstring says as much); the queue's inference from its printed
`args` field was the error.

**What made 1.26.51.1 die where 1.26.40.8 passed.** Every actor a hook
receives goes through bdsx's `Actor` resolver before the hook's own code,
and the resolver calls `Actor::hasType`, which 1.26.51.1 did not have: each
event carrying a mob threw during argument conversion, which is fatal. The
function was found by body from 1.26.40.8 (440 bytes, identical head, the
`ActorTypeComponent` hash three times, the same two neighbours), and the
resolver no longer throws when it is missing.

Two smaller things from the same sessions: a listener that throws inside a
hook whose caller reads a returned struct must not leave the hook without
one (the new hooks report the error and fall through to the original); and
one of roughly a dozen full-launcher sessions that day ended with exit code -1 *after*
`Quit correctly`, in `StructurePointer::finalize` during a late GC -- seen
once, not reproduced, not attributed.

### The audit that followed: shapes, sizes, and the other build

Three wrong names in one day, all from routes that place a name without
reading the function, made the check systematic. Of the ~210 required names
each build takes from a low-trust route (propagation, the walk, the carry,
gap agreement), `tools/slot-shape.mjs` -- written for the walk and never
applied to the merged table -- vetoes **8 on 1.26.40.8 and 9 on 1.26.51.1**:
the function reads an argument register its 2024 namesake never read
(`Actor::getRuntimeID` reads `r8d`; both `ActorDefinitionIdentifier`
constructors, `Dimension::getSunAngle`, `Actor::removeAllEffects`,
`ItemStackBase::save`, `LoginPacket::write`,
`GameplayUserManager::getActiveGameplayUsers`, and on 1.26.51.1
`BlockSource::getBlockEntity`). Wrong function or changed signature, bdsx
would call it with the 2024 prototype either way, so `merge-symbols.mjs` now
applies the veto itself (cached in `work/derived/shape-cache-<v>.json`) and
the name does not ship. Coverage by address goes *down* for it, 299 -> 291
and 297 -> 288, which is the honest direction. A size more than three times
off the 2024 function is a weaker sign -- ECS turned many 50-byte getters
into 250-byte component lookups, legitimately -- and is only used to decide
what to read next (`tools/size-audit.mjs`, `next-steps.md` Q3).

`tools/cross-build-fill.mjs` is the constructive half: a required name one
1.26 build ships and the other lacks (17 one way, 13 the other; it is how
`Actor::hasType` went missing) is carried when the cross-build pair map and
the body -- same size, same leading bytes with rel32 masked -- give the same
function, unless the source fails the size sanity above. 4 + 3 names
(`data/candidates-crossbuild-<v>.json`, merge source `cross-build`), one of
which the shape veto then refused.

## Firing the unfired events (2026-09-21)

Five events whose hook target shipped but whose 2024 prototype had never run
now have (`data/events-fired.json`, `tools/event-coverage.mjs`: UNFIRED 12 ->
7, FIRED 11 -> 16). The prototypes were read before anything was installed --
`shape()` on the three binaries agrees for all four functions, and the first
five instructions of each 1.26 body read the same argument registers 2024's
does: `?addLevels@Player@@UEAAXH@Z` rdx, `?die@Mob@@UEAAXAEBVActorDamageSource@@@Z`
rdx, `?take@Player@@QEAA_NAEAVActor@@HH@Z` r9 and rdx,
`?save@Level@@UEAAXXZ` none (232 bytes, byte-identical across the two builds).
The console fires them: `xp 5L @a` (and the XP orbs a dead bot walks back
over, which enter `addLevels` with 1), `kill @e[type=zombie]`,
`loot spawn 29 68 14 loot loot_tables/entities/zombie.json` plus the zombies'
own drops at the bot's feet, `save hold`, and a zombie holding a totem in its
offhand being killed (`?consumeTotem@Actor@@UEAA_NXZ`, no arguments;
`ev.totem.getId()` is 578 on both builds).

Two sessions were thrown away first, and both were the driver, not the table.
**`save hold` with no `save resume` stops BDS from finishing `stop`**: the
pair hung past the runner's 90-second wait and came back as
`!! SESSION FAILED: the driver never reported an exit code` on both builds,
with every probe line already printed. And `@e[type=zombie,c=1]` gives the
totem to one zombie, which is not necessarily the one the next command kills --
1.26.40.8 killed the other one and the event never fired, while 1.26.51.1
happened to pick right. Arm every candidate.

The hooks are opt-in. `tools/entity-sig-probe.ts` compiles into *every* session
on the host, so a hook still being proved must not install by default:
`SIG_EVENTS=levelup,entityDie,pickup,save,totem,calls` is the list, and with
the variable unset nothing in that half of the file is installed.

### The `playerPickupItem` regression was the world, not the table (2026-09-23)

`q2ev40`/`q2ev51` went from 3 fires (2026-09-21 15:04,
`work/host-runs/q2ev40-20260921-150403.txt`) to 0 on both builds by
2026-09-22 (`work/host-runs/q2ev40-20260922-125859.txt` and later reruns).
Neither the hook nor the address moved: `bdsx/bdsx/event_impl/entityevent.ts`'s
`events.playerPickupItem.setInstaller` (hooking
`?take@Player@@QEAA_NAEAVActor@@HH@Z`) and `tools/host/drivers/q2ev40.ps1`/
`q2ev51.ps1` were both untouched since before the 15:04 run, and
`data/resolved-<v>.json`'s address for the name (40 `0x225b20` / 51
`0x2b4b10`) matches the same bytes `disas-exact` showed on 2026-09-21 --
`rcx=this, rdx=Actor*, r9d=`4th int, matching the `bool_t(Player, Actor,
int32_t, int32_t)` hook prototype. The 0-fire logs from 09-22 look like they
are missing the `[sigprobe] table: has ...` / `loaded` lines that the 09-21
logs have, but that is a narrower `--grep` on that particular session (likely
someone else's regression pass), not a filtered-out result -- the `PASS`/
`FAIL`/`INFO` summary lines that carry the actual verdict are present in both
and are not affected by `--grep`.

What changed is the shared, persistent `worlds\smoketest` on both instances.
Between 09-21 15:04 and 09-22, dozens of unrelated driver sessions ran against
the same world and none of them reset player state at the end:
`place40.ps1`/`place51.ps1` end with `"gamemode creative @a"` and never switch
back, and `item40.ps1`/`item51.ps1` (and others) `give`/`replaceitem` several
items and never `clear @a`. `run-client-probe.ps1`'s own end-of-session
`kill @a` does not empty the inventory either (Bedrock does not drop a dead
player's items in creative, and no driver sets `keepInventory`). `q2ev40.ps1`/
`q2ev51.ps1` never cleared the bot's inventory before `loot spawn`, so by
09-22 the accumulated items (diamond swords, pickaxes, potions, oak logs,
emeralds, iron chestplates, ...) across many sessions left the bot's inventory
with no room, and BDS's own pickup logic never called `Player::take` at all
-- the hook was never given a chance to fire, so there was nothing wrong to
find in the table or the hook.

**Confirmed by a diagnostic pair, no table/bdsx code change**: a one-off driver
(`gamemode survival @a`, `clear @a` right after the `tp`, then the same `loot
spawn`, `SIG_EVENTS=pickup` only) fires `playerPickupItem` again on **both
builds, first try** -- `work/host-runs/q2evdiag40-20260923-014125.txt`,
`q2evdiag51-20260923-014125.txt`: `[sigprobe] PASS playerPickupItem: fire #1
bdsxprobe <- minecraft:item`, `exit code: 0`, `Quit correctly`. The
`testfor @e[type=item]` lines that follow report "No targets matched
selector" both times, which is consistent (the item was already picked up
before the console got to ask).

**Fix applied**: `tools/host/drivers/q2ev40.ps1`/`q2ev51.ps1` now run
`"gamemode survival @a"` and `"clear @a"` right after the `tp`, before
anything is given or spawned -- the same two commands the diagnostic pair
used. This is a driver/test-hygiene fix, not a bdsx or table change; no
`symbols.json`/`data/merged-*.json` entry moved. `data/events-fired.json`
still lists `playerPickupItem` as fired on both builds; the rule this leaves
behind for the next driver author: **a driver that gives, replaces, or
loots items into the bot's inventory and does not end in survival mode with
`clear @a` leaves that debt for the next session that shares the world.**

## Q4: `Level::getTime`/`setTime`/`explode` -- route 9 was right, route 1 was about a different slot (2026-09-23)

Three of the four Q4 names shipped: `?getTime@Level@@UEBAHXZ`, `?setTime@Level@@UEAAXH@Z`,
`?explode@Level@@UEAA_NAEAVBlockSource@@PEAVActor@@AEBVVec3@@M_N3M3@Z` (the 8-arg overload; TNT
already goes through the 1-arg `explode(Explosion&)` neighbour). All three by address, both builds,
via route 9 (header+1 on the Endstone `ILevel` header, anchored on confirmed slots), and all three
now execution-confirmed.

**The 2026-09-17 "getTime is gone from this position" finding (above, "Route 1") was never about this
address.** That finding is from *position-only propagation* pairing (`data/candidates-pairs-in-tables-<v>.json`),
an older, unanchored route that the project explicitly stopped trusting for exactly this reason (see
that file's own `_comment`: "getTime/setTime are left out: an earlier execution found getTime not a
pure slot of this table"). Route 9 (`work/vft/level-anchored-<v>.json`, `tools/level-anchored.mjs`)
is a different, later, cross-checked route -- and it puts `getTime`/`setTime` at live vtable slots
132/133 (header index 131/132, `+1`), which a *direct* dump of the `ServerLevel` vtable (reading
`table + slot*8` off the raw PE, not trusting the tool's own output) confirms exactly on both builds.
The two builds also agree with each other: same live slot, same function size (340 bytes, both
functions, both builds). `explode`'s 8-arg overload is header index 120 (MSVC lays same-named virtual
overloads out in *reverse* declaration order within a class -- the header text has the 8-arg one
declared first and the 1-arg one second, so the 1-arg one gets the earlier slot; this is the same rule
`docs/findings-blocks.md` already established for `BlockSource::getBlock`'s overloads) -> live slot 121,
also confirmed by direct vtable dump on both builds. Its body reads `rdx`/`r8`/`r9` before any call
(`BlockSource&`, `Actor*`, `Vec3 const&`) and the float/bool/bool/float/bool off the stack starting at
the 5th argument slot -- exactly the prototype `bdsx/bdsx/bds/implements.ts` already has wired
(`Level.prototype.explode = procHacker.js(..., BlockSource, VoidPointer, Vec3, float32_t, bool_t, bool_t, float32_t, bool_t)`),
which was only missing an address.

**Execution**, both builds, 2026-09-23, `tools/gamerules-probe.ts`'s new `levelprobe` command
(`tools/host/drivers/lp40.ps1` / `lp51.ps1`, `run-full.ps1`, no client): the candidate addresses were
called *raw* (env `LP_GETTIME`/`LP_SETTIME`/`LP_EXPLODE`, an RVA added to `dllraw.current`), before
either name was anywhere near `symbols.json` -- so a wrong address would have failed loudly in this
session alone, never reaching the shared table. `getTime` advances by exactly the tick count between
two calls (`run-full.ps1` sends console lines 2s apart; BDS ticks at 20/s, so +40 and +80 observed,
three samples each build) -- a wrong slot returning some other int getter, a constant, or a pointer
read as an int would not track wall-clock time this precisely. `setTime`/`getTime` round-trip exactly
(set current+4321, read it back, restore, read again) on every sample, both builds. `explode` returns
exactly `true` on both builds, no crash, across two reruns with different target coordinates.
`work/host-runs/lp40-20260923-010137.txt`, `lp51-20260923-010137.txt`: PASS 5/5, tsc exit 0, exit code
0, `Quit correctly`.

**What `explode` is *not* confirmed to do: actually destroy a block.** Every coordinate tried
(`(40,64,40)`, `(31,67,20)`, `(29,67,16)`) failed both `setblock` and `testforblock` with `Cannot
place/test for block outside of the world` under `run-full.ps1` (no client). Every other driver in
this project that successfully does `setblock`/`testforblock` uses `run-client-probe.ps1` (a bot
online) -- a console-only session appears not to keep any chunk loaded far enough from spawn (or
possibly at all) to satisfy that check, independent of which coordinate is picked. The function itself
ran and returned the right-typed value on both builds, which is real evidence (a wrong address or
prototype crashes on a call this non-trivial, it does not gracefully return a plausible bool), but the
stronger, independent confirmation -- a block actually gone -- needs a client-joined session and is
left for whoever next touches `explode`.

**`?levelCleanupQueueEntityRemoval@Level@@` (slot 245, same route 9, same two-route agreement, body
read and matches the baseline's `OwnerPtr<EntityContext>`-by-move-then-cleanup shape) was deliberately
*not* added this round.** Unlike `getTime`/`setTime`/`explode`, which bdsx only *calls*, this name is a
real *hook* in `bdsx/bdsx/bds/implements.ts` (`Level$levelCleanupQueueEntityRemoval`, wired to
`_removeActor`/`decay(actor)` -- bdsx's own `Actor` lifecycle bookkeeping). A past attempt
(`data/candidates-level-<v>.json`'s own comment) found it "did not fire under a pig kill", and a hook
that installs but never fires either means the address is wrong or the address is right and pig-kill
just isn't the removal path that goes through it -- either way that needs its own execution session
(summon+kill several entity kinds, watch for the hook firing) before it can ship, per the project rule
that a hook is never deployed on static agreement alone. Left in the queue.

**`?setShouldSendSleepMessage@ServerLevel@@` is partially placed.** The 2024 body
(`0xcaee80`) is a one-line-plus-assert wrapper: read `ServerLevel+0x22b0` (asserted non-null against
the string `"mServerPlayerSleepManager"`), write the bool to `[that pointer]+0x201`. 1.26 keeps no
out-of-line copy of the wrapper itself (a 2-instruction leaf if it exists at all, invisible to both
`tools/field-offset.mjs` -- which only sees `.pdata` functions -- and `tools/leaf-funcs.mjs`'s
`--find=` byte scan, and the assert string is stripped from both 1.26 builds so there is no anchor to
search for). What *is* now known, both builds: `ServerLevel::mServerPlayerSleepManager` moved from
`+0x22b0` to **`+0x880`**, found via the *virtual* `getPlayerSleepManager()`/`getPlayerSleepManager() const`
accessor pair instead of guessing the field offset directly (header index 404/405 in the `Level`-own
tail of the `ILevel` vtable, same header+1 rule; 40 folds both overloads to one 2-instruction body at
the ServerLevel vtable's slot 405/406 reading `[this+0x880]`, 51 keeps them distinct at slots 405/406
with 406 being the real one -- slot 405 there is an unrelated always-`xorl %eax,%eax` stub, likely a
sign the two builds' Endstone header revisions disagree by one slot somewhere earlier in the class and
`getArmorTrimUnloader`'s neighbour shifted; only the *offset the body reads*, `+0x880`, was trusted,
not the slot number itself). The `ServerLevel` constructor (`??0ServerLevel@@...`, already in the
table) stores the manager's raw pointer there at one instruction (`0x6aa92b` on 1.26.40.8) after
building its ref-counted control block at `+0x878` -- a second, independent confirmation of the offset,
though not of the class layout past it. **Still needed**: `PlayerSleepManager`'s own field offset for
the bool (2024's `+0x201`). Next step for whoever picks this up: trace the register that gets stored
to `[this+0x880]` in the `ServerLevel` constructor back to its own `operator new`/constructor call
(the constant-frame local slot it lands in, `0x2c0(%rbp)` on 1.26.40.8, is reused for many unrelated
temporaries through that 10KB function, so following it needs care) to get `sizeof(PlayerSleepManager)`
and read the field layout off that constructor's own stores, or find the read side
(`shouldSendSleepMessage`'s own baseline `+0x22b0` -> `+0x201` two-hop read) the same way once a
narrower search than "every function that touches displacement `0x880` anywhere in the image" (801 raw
hits on 1.26.40.8, almost all unrelated stack-frame accesses at the same numeric offset) is available.

### Q4 continued: `setShouldSendSleepMessage`'s last offset, and `levelCleanupQueueEntityRemoval`'s negative result (2026-09-23)

**`?setShouldSendSleepMessage@ServerLevel@@` is complete, static-confirmed, shipped.** The remaining
piece was `ServerPlayerSleepManager`'s own field offset for the bool (2024's `+0x201`, class name from
the baseline table -- `PlayerSleepManager` above was this document's shorthand, the real symbol is
`ServerPlayerSleepManager`). The register stored to `ServerLevel+0x880` in the constructor (see above,
`0x2c0(%rbp)` on 1.26.40.8) traces to a preceding call at `0x12cd920` whose argument shape (`this` in
`rcx`, a `not_null<StackRefResult<GameplayUserManager>>&` in `rdx`, a moved
`unique_ptr<IPlayerSleepPercentageGetter>` in `r8`/`r9`) matches
`??0ServerPlayerSleepManager@@QEAA@AEBV?$not_null@V?$StackRefResult@VGameplayUserManager@@@@@gsl@@V?$unique_ptr@VIPlayerSleepPercentageGetter@@U?$default_delete@VIPlayerSleepPercentageGetter@@@std@@@std@@@Z`
exactly -- it is the manager's own out-of-line constructor on 1.26.40.8 (2292 bytes, `.pdata`-bounded).
Its body zeroes four consecutive member slots (`movups %xmm6, 0x168(%rdi)` .. `0x198(%rdi)`) and
immediately follows with `movw $0x100, 0x1a8(%rdi)` -- the identical idiom, at the identical relative
position past the identical four-slot run, as the 2024 body's `movq %r15, 0x1f8(%rdi); movw $0x100,
0x200(%rdi)` (four zeroed 16-byte `std::function` slots then the same paired-byte word write). Low
byte (`+0x1a8`) is an unnamed sibling that inits to 0 in both years; high byte (`+0x1a9`, 2024's
`+0x201`) is `send_sleep_message_`, defaulting true, exactly as `?setShouldSendSleepMessage@ServerLevel@@`'s
own 2024 body (`0xcaee80`) writes it via `movb %dil, 0x201(%rax)`.

**1.26.51.1 gives an independently-shaped second confirmation, not a copy of the first.** It has no
separate out-of-line `ServerPlayerSleepManager` constructor at all -- the whole thing is inlined
directly into `ServerLevel::ServerLevel` (0x76ab70, 12074 bytes). Tracing the same scratch slot
(`0x2e0(%rbp)`, reused dozens of times through the function, so only the *last* write before the
`0x880(%rcx)` store at `0x76cc1c` is the right one) lands on `0x76c40b: movq %r14, 0x2e0(%rbp)`, where
`r14` is visibly a freshly-`new`'d object being constructed member-by-member from offset 0 upward
(vtable, then fields growing to the same `0x168`..`0x198` zeroed run via `movups %xmm6, ...`) --
i.e. the manager's constructor got inlined at this call site rather than kept as a separate function,
and it still lands on `movw $0x100, 0x1a8(%r14)` at exactly the same relative offset. Two different
compiler decisions (out-of-line vs. inlined) producing the same offset is a stronger check than the
same shape read twice.

Shipped as `layouts.ServerLevel.mServerPlayerSleepManager` (0x880) and
`layouts.ServerPlayerSleepManager.sendSleepMessage` (0x1a9), `data/candidates-instances-<v>.json`
`offsets` on both builds, consumed by `bds/implements.ts` via `derived()` (fallback constants match the
layout values, so the JS path works even before the table carries them). **This is static confirmation
of the offset's meaning; there is no execution route to it.** Sleeping needs a real client (Q7), and
1.26 keeps no callable wrapper to call as a witness even if one joined. A smoke test ran on both builds
2026-09-23 (`tools/gamerules-probe.ts` `levelprobe sleep 0|1`, driver `lp40/51.ps1`, `run-full.ps1`, no
client needed since it only pokes the pointer chase): the manager pointer is non-null on both builds
(`0x154C2BD3B30` on 40, `0x246449CC2A0` on 51), writing `true` then `false` moves exactly the `+0x1a9`
byte (the visible transition is on the second write: `[0,1,0] -> [0,0,0]` on 40, `[0,1,15] -> [0,0,15]`
on 51), and the neighbour bytes at `+0x1a8` and `+0x1aa` are untouched throughout -- proof the write is
precisely one byte wide and the code does not crash, not proof that byte is read anywhere as
`send_sleep_message_`. `work/host-runs/lp40-20260923-013031.txt`, `lp51-20260923-013031.txt`: tsc exit
0, exit code 0, `Quit correctly`, all `[grprobe]` lines PASS.

**`?levelCleanupQueueEntityRemoval@Level@@` (slot 245) is not promoted -- broader negative execution
result, still call-only, left in the queue.** The static case for the address itself did not weaken:
both builds carry a byte-for-byte-comparable 112-byte body (40 `0x739760`, 51 `0x7d1b20`, both exact
`.pdata` bounds) whose shape matches the baseline's move-then-cleanup pattern instruction for
instruction (`movq 0x418(%rcx),%rcx` -- the ActorManager pointer, shrunk from the baseline's `+0x1a00`
-- guarded by the same tagged-union move into a local `OwnerStorageEntity`-shaped buffer, the same
tag-byte re-check, the same `+0x30` `this`-adjustment into the cleanup call). What changed is the
execution side: the existing pig-kill-only negative (`data/candidates-level-<v>.json`'s own comment)
was retested with a method that cannot be confused with bdsx's own bookkeeping. bdsx's hook on this
name (`Level$levelCleanupQueueEntityRemoval` in `bds/implements.ts`, wired to `_removeActor`/`decay`)
never installs today -- `merge-symbols.mjs`'s `HOOK_TRUST` gate (`resolved,instances,packets,
endstone-slots`) drops hook targets sourced from `level-anchored`, so the name carries no address in
the deployed table and the hook silently no-ops at load (`docs/lab-runbook.md`'s normal red
"Symbol not found" line) -- so testing *through that hook* would only ever prove bdsx's own decay
logic, never whether the engine calls the address at all. Instead, `tools/gamerules-probe.ts`'s new
`levelprobe cleanup arm` installs a raw, unconditional, register-preserving counter directly on the
candidate RVA via a private `ProcHacker` over a one-entry map (`hookingRawWithCallOriginal`, empty
keep-register lists) -- the moved original runs completely unmodified and every register is restored
before it, so this cannot alter behaviour and a wrong address either crashes on install (bad
disassembly boundary within the required 12-byte window) or silently never increments; it does not
depend on `actorMaps`/`decay` being reachable at all. Driven with a joined bot
(`tools/host/drivers/lc40/51.ps1`, `run-client-probe.ps1`) through three different removal shapes --
`summon pig` + `kill @e[type=pig]` (a mob), `summon item` + `kill @e[type=item]` (a dropped-item
entity), `summon arrow` + `kill @e[type=arrow]` (a projectile) -- the hook installs cleanly on both
builds (`hooked 0x00007FF6E1109760` / `0x00007FF74AAA1B20`) and the counter reads **0** after every one
of the three kills, on both builds, session-clean (`tsc exit 0`, exit code 0, `Quit correctly`,
`work/host-runs/lc40-20260923-013141.txt`, `lc51-20260923-013141.txt`). This rules out the previous
finding's own caveat (that a pig-only test, checked only through `decay()`, might have missed calls
masked by the Actor destructor already having cleared `actorMaps`) without discovering a firing path.
**Reading for whoever picks this up next**: either the route-9 slot for 245 is not actually this
function (structural match this close on both builds after two size-checked confirmations would be an
unusual coincidence, but is not impossible -- the header could be off by one in this exact region the
way `getGameRules` was), or -- more likely given how closely the body matches the baseline's *queued*
cleanup shape (`OwnerPtr<EntityContext>` taken by value, not by reference, and the function's own name)
-- ordinary `kill`/despawn does not route through this path at all, and it fires only for a different
removal reason: a world-save/`stop`-time flush of queued removals (no console command exists after
`stop` to observe this), a chunk-unload eviction, or an EntityContext outliving its Actor for network
reasons (a spectating client, a still-pending transaction) so its final cleanup is deferred to a queue
this function drains. Next step: try the same raw-counter method around `stop` (a session that arms the
hook, does nothing else, and checks the counter is unreachable after `stop` is sent -- but a print
statement inside the counter itself, checked against the full unfiltered `.out` log rather than a
`[grprobe]`-only grep, would catch a call that happens during the shutdown sequence after the last
console command), or find what static callers exist for the queue this function presumably drains
(look for what pushes into whatever `Level+0x418`'s `ActorManager` calls a removal queue, rather than
starting from this function's own callers).

### Q4 continued II: a third negative round (disconnect + shutdown, unfiltered log), and why the static case is weaker than it looked (2026-09-23)

**Static: the baseline body was read directly, not just described as "matching."**
`node tools/disas-exact.mjs 1.21.3.01 0x1ac3fe0` gives the whole function, 12 instructions: it reads
`this+0x1a00` (the `ActorManager` pointer), constructs an `OwnerStorageEntity` on the stack from the
moved-in `OwnerPtr<EntityContext>` argument, calls
`?cleanupActorEntityReferencesGarbageCollect@ActorManager@@QEAAXV?$OwnerPtr@VEntityContext@@@@@Z`
(`0x1ade110`) with it, destructs the local, and returns -- a textbook stack-cookie-guarded wrapper, 77
bytes. This is the same shape the earlier round described from the 1.26 side; reading the baseline side
by hand confirms it rather than changing it.

**Caller search by direct call (E8/E9) is a dead end for every `ILevel` virtual, in both years, not
just this one.** `tools/callgraph.mjs` was run against the baseline for the target and its declared
neighbours in `level_interface.h` (`queueEntityDestruction`, `removeEntity(Actor&)`,
`forceRemoveEntity`, `forceRemoveEntityfromWorld`): **all of them have zero direct callers.** They are
pure-virtual `ILevel` members, so every real call site goes through a vtable load, which a scan for
`E8`/`E9` near-call opcodes cannot see. Two static caller-search methods were tried against the vtable
call itself and both came up empty even on **already-confirmed** slots (`getTime`/`setTime` at 132/133,
`explode` at 121), which is the useful result -- it says the methods don't work here, not that nothing
calls those functions:

- A scan for the single-instruction form `call qword ptr [reg+disp32]` with `disp32` equal to the
  slot's byte offset (`slot*8`) found **zero** hits for slot 245 (`0x7a8`) and zero for the confirmed
  slots 132/133/121 too, on both 1.26 builds. A histogram of every such call's displacement in the
  `0x700..0x820` window (slots ~224-260) turned up exactly one hit total (slot 247, once) -- this
  addressing form essentially does not occur for `Level`'s vtable in this binary.
- A two-instruction scan (`mov reg, [base+disp32]` followed within 40 bytes by `call reg` on the same
  register) was tried next and is too noisy to use as-is: 2,490 raw hits for slot 132's displacement
  alone, almost all of them unrelated reads of the same numeric stack-frame offset that happen to
  precede an unrelated register call nearby. Distinguishing a real vtable dispatch from this noise
  would need tracking dataflow (does the loaded register actually come from a vtable pointer, itself
  loaded from `[this+0]`), which is beyond what these opcode-level tools do. **Recorded here so the
  next person doesn't re-spend the time**: static caller-recovery for `ILevel` virtuals needs either a
  real disassembler with dataflow (out of scope, `docs/findings-binexport.md`) or is not worth
  attempting through this route.

**The route-9 anchor for this slot is isolated -- no second confirmation exists nearby.**
`work/vft/level-anchored-1.26.40.8.json`'s `candidates` map has exactly **one** entry with a header
slot in the entire range 150-350 (out of ~380 total `ILevel` slots): this one, at header slot 244 /
live slot 245. The cluster that anchors `getTime`/`setTime`/`explode` (slots 120-133) and the one that
anchors `setShouldSendSleepMessage` (404-406) both sit well outside this window. This means the
"header+1 holds locally" claim for slot 245 was never cross-checked against a neighbour the way those
two clusters were -- it rests entirely on this one candidate's own body matching the baseline
instruction-for-instruction, which is real evidence but is **the single-route case the project's own
rule (`docs/HANDOFF.md` §7.2) says is not enough to promote on its own**, restated here because the
earlier write-ups ("same two routes," "same route 9, same two-route agreement") overstated it as
two independent routes when it was one route (structural/positional) with strong internal support, not
two routes agreeing.

A direct PE dump of live slots 240-250 on 1.26.40.8 (table RVA `0xa5e9ee0`, confirmed by reading slot
245 back out as `0x739760` -- matches the candidate exactly, so the table address and slot arithmetic
are both right) shows the immediate neighbours are a mix: slots 241-244 are **not** `.pdata` function
starts (leaves with no unwind info -- consistent with trivial one-line `ILevel` forwarders, the same
blind spot `tools/leaf-funcs.mjs` exists for), while 240 (187B), 245 (112B, our candidate), 246 (74B),
247 (69B), 248 (193B) all have real `.pdata` entries. Slot 245 standing out with a real body while its
closest neighbours are leaves is consistent with what the baseline shape predicts (this function does
real work -- move, construct, call, destruct -- unlike a pure one-line passthrough), so this dump did
not turn up a reason to doubt the slot; it also did not add a second confirming anchor, since none of
240/245-248 has a name to check the body against except 245 itself.

**Execution, third round: the counter now prints on every fire (not just on `levelprobe cleanup`
readback), and the removal shape tested was widened to a natural client disconnect plus full shutdown,
checked against the complete unfiltered `.out` log, not a grep.** `tools/gamerules-probe.ts`'s counter
(`arg === "cleanup arm"`) now calls `console.log` inside the hook itself on every fire, so a call
during the post-command wait or the shutdown teardown -- after the last chance for a console command to
run a readback -- would still land in the raw output. New driver sequence
(`tools/host/drivers/lc40.ps1`/`lc51.ps1`, `run-client-probe.ps1`, `BotSecs 44` so the bot disconnects
on its own partway through the session while the server keeps running): arm the counter, `summon pig`
+ `kill @e[type=pig]` (repeats the prior round's shape as a sanity check), two `levelprobe cleanup`
readbacks straddling the bot's natural disconnect, then the driver's own unconditional `kill @a`
(a no-op, the bot is already gone) and a 30s wait before `stop`.

Both builds: session-clean (`tsc exit 0`, exit code 0, `Quit correctly`,
`work/host-runs/lc40-20260923-033553.txt`, `lc51-20260923-033553.txt`). `Player disconnected:
bdsxprobe` appears in the log (natural disconnect, not a kick), both readbacks after it still say
`calls=0`, and the counter's own `fired #N` line **never appears anywhere** -- confirmed against the
complete unfiltered `.out` on the host directly (`Get-Content lc40.out` / `lc51.out`, 121 and 120 total
lines respectively, grepped for `grprobe|fired|Quit correctly|stop requested`), from `[grprobe] loaded`
through `Server stop requested.` to `Quit correctly`. Zero fires across all three removal shapes tried
across two rounds (mob kill, dropped-item kill, projectile kill, natural player disconnect, full
shutdown), on both builds.

**Conclusion for whoever picks this up next.** Three real-world removal shapes and a full shutdown
sequence, checked without any filter that could hide a print, all come back at zero calls, on both
builds, while the static case for the address is one route (a very convincing body match, but
structurally unconfirmed by any neighbour in a 200-slot window). The balance now leans toward the
slot being wrong rather than the removal path being simply unreachable from a headless single-bot
session, but neither is proven and this round did not settle it. Concrete next steps, in order of
cost: (1) get a second anchor near slot 245 -- read the bodies of the 240-250 window's `.pdata`
functions (RVAs above) against the baseline's own neighbours in `level_interface.h`
(`onChunkDiscarded`, `getLevelChunkEventManager`, `destroyBlock`, `getLevelBlockDestroyer`, the
functions actually declared around `levelCleanupQueueEntityRemoval`) to see whether *any* of them
independently confirms header+1 holds this deep into the class, the way the getTime/explode cluster
did; (2) if a second anchor disagrees, header+1 has drifted somewhere between slot ~133 and ~245 and
the real slot needs to be found by walking outward from whichever anchor is closer; (3) if a second
anchor agrees, the remaining live hypothesis is the deferred-reason one from the prior round (a
world-save flush, a chunk-unload eviction, or a network-pending EntityContext) -- try `save hold` /
`save query` / `save resume` around a kill, or a two-bot session where one player leaves while the
other keeps a chunk loaded, before concluding this is genuinely unreachable outside real multiplayer
traffic bdsx has no way to reproduce.

**Also noted, out of this ticket's scope, left for whoever owns actor lifecycle bookkeeping next**:
bdsx's *other* cleanup hook, the `Actor` destructor (`??1Actor@@UEAA@XZ`, `bds/implements.ts`'s
`asmcode.actorDestructorHook` -> `_removeActor`/`decay`), is also unresolved in both merged tables
today (`data/merged-1.26.40.8.json` / `-1.26.51.1.json` have no entry for it; it exists only in
`data/candidates-propagation-<v>.json`, which `merge-symbols.mjs`'s `HOOK_TRUST` gate does not trust
for hook targets). If neither this ticket's name nor the destructor hook is wired, bdsx's `actorMaps`/
`decay()` bookkeeping currently has no live trigger at all on 1.26 -- independent of whether
`levelCleanupQueueEntityRemoval` itself ever ships, the destructor hook looks like the more general
and more likely-to-fire of the two (every `Actor` gets destructed; not every removal necessarily
routes through this ticket's queue) and is worth its own pass.

### Q4 continued III: the second anchor exists, the slot holds, the engine never calls it — and bdsx's actor bookkeeping now runs through `??1Actor` (2026-09-24)

**Second anchor, both builds.** The previous round's step (1) was done by reading all of live slots 236–255
(40 table `0xa5e9ee0`, 51 `0xa70ab00`) against 2024's `Level` table around slot 213. The run 238–247
reproduces 2024's 206–215 in order and shape on both builds:

| live | 1.26.40.8 | 1.26.51.1 | 2024 slot / name | shape |
|---|---|---|---|---|
| 238 | `0x739810` | `0x7d1bd0` | 206 `queueEntityDestruction` | the twin wrapper: ActorManager (`+0x418`), OwnerPtr moved, the same GC call as 245, destructor |
| 239 | `0x739670` | `0x7d1a30` | 207 `removeEntity(WeakEntityRef)` | ActorManager call |
| 240 | `0x7395b0` | `0x7d1970` | 208 `removeEntity(Actor&)` | 187 B, the weak-ref path inlined |
| 241/242 | `0x739730`/`0x739740` | `0x7d1af0`/`0x7d1b00` | 209/210 `forceRemoveEntity(fromWorld)` | `mov rcx,[rcx+0x418]; jmp` into ActorManager |
| 243 | `0x739750` | `0x7d1b10` | 211 `forceFlushRemovedPlayers` | `mov rcx,[rcx+0x458]; jmp` (GameplayUserManager) |
| 244 | `0x684a30` | `0x748130` | 212 `loadFunctionManager` | ICF'd leaf |
| **245** | **`0x739760`** | **`0x7d1b20`** | **213 `levelCleanupQueueEntityRemoval`** | the wrapper |
| 246/247 | `0x7398e0`/`0x739930` | `0x7d1ca0`/`0x7d1cf0` | 214/215 `register/unregisterTemporaryPointer` | both on `+0x288` (TempEPtrManager) |

1.26 routes both twins to one ActorManager function (`0x14de7f0` / `0x1652e50`) where 2024 had
`cleanupRemoved…` and `cleanup…GarbageCollect`; 238 alone returns early on an empty `OwnerPtr`. So the address
is two-route on both builds and ships (`data/resolved-<v>.json`), marked never-seen-firing.

**It does not fire.** The counter (`LP_CLEANUP`, `tools/gamerules-probe.ts`) saw 0 calls on both builds in two
new sessions (`lcu40/51`, `lcd40/51`): chunk unload (pigs summoned, bot teleported 5000 blocks away and back),
peaceful despawn of a zombie, a pig kill under `save hold`/`save resume`, and a pig and the player moved into the
nether — on top of the earlier rounds' kills, disconnect and shutdown. No shape a console or bot can make reaches
it. Its only role in bdsx is actor bookkeeping (`_removeActor`), which the destructor covers.

**`??1Actor@@UEAA@XZ` — the general hook, now shipped and executed.** Endstone's `actor.h` puts `~Actor` ninth,
and slot 8 of `??_7Actor@@6B@` is 2024's `??_GActor` shape (destructor call, then `operator delete(0x3b0)`;
`sizeof(Actor)` was 0x448). The destructor it calls — 40 `0xddaf60`, 51 `0xd1b1b0` — opens by storing
`??_7Actor@@6B@` into the object and has 71 direct callers on 40 (the derived destructors). bdsx's
`asmcode.actorDestructorHook` → `_removeActor` installs on it unchanged. **Execution** (`dtor40`/`dtor51`, a
`dtorprobe` in `tools/block-probe.ts` over the fall driver; tsc 0, exit 0, `Quit correctly`; 2/2 PASS each): the
pig wrappers bdsx resolved are live and in `Actor.all()` before a console `kill`, decayed and gone after it.
Until now `actorMaps` never dropped a dead actor on 1.26, so a reused address could hand back a stale wrapper.

### HealthAttributeDelegate: `entityHealthChange` — the prototype changed, done on both builds (2026-09-24)

`?change@HealthAttributeDelegate@@UEAAMMMAEBVAttributeBuff@@@Z` had no route: no symbol source names it, and Endstone
stopped hooking it. It was found live: `AttributeInstance` holds its delegate as a `shared_ptr` at +0x58 (Endstone
`attribute_instance.h`: vptr, `attribute_`, three vectors, then `delegate_`; the value arrays at +104/+116 confirm the
count), and `hdprobe` (`tools/block-probe.ts`, drivers `hd40/51`) read the bot's health delegate vftable — 40
`0xa6793c0`, 51 `0xa7e3d30` — through `ServerPlayer`'s known vftable address. Slot 4 is `change` (40 `0x2365fd0`, 51
`0x2f02670`) in Endstone's `attribute_instance_delegate.h` order (dtor, tick, notify — the empty ICF stub —,
willChange, change, getBuffValueWithModifiers). **Prototype changed**: 1.26 returns `std::optional<float>` through a
hidden pointer, old/new in xmm2/xmm3 and the buff on the stack (2024: `float`, xmm1/xmm2, r9), and the owning mob moved
from +0x20 to +0x18 (`layouts.HealthAttributeDelegate.mob`). Shipped as `bdsx:HealthAttributeDelegate::change`; bdsx's
hook takes the result pointer and passes the event's `newHealth` through.

**Execution** (`hc40`/`hc51`, `hcprobe`, `HEALTH_PROBE=1`; tsc 0, exit 0, `Quit correctly`; 2/2 PASS each):
`damage @e[type=pig] 2` → the event with the pig, old 10 / new 8; a listener setting `newHealth = oldHealth` keeps the
pig at 10 (health read back by bdsx), passing through `damage 3` leaves 7; the bot's `kill` fires it with 20 → 0.

### `sendActorCreated`: `entityCreated` — found through its own lambda, prototype changed, done on both builds (2026-09-24)

The lambda-scope list (`tools/image-names.mjs`, `findings-inventory.md` 11) shows
`?sendActorCreated@ActorEventCoordinator@@QEAAXAEAVActor@@W4ActorInitializationMethod@@@Z` still exists on both builds,
but nothing named its address. New tool **`tools/lambda-owner.mjs <v> <decoration substring>`** turns such a scope into
an address: the lambda's `TypeDescriptor` (the name sits 16 bytes in, in `.data`) is referenced only by its
`_Func_impl::_Target_type`, which is slot 3 of the `_Func_impl` vftable, and the functions that `lea` that vftable build
the `std::function` — the owner. Here: 40 `0x2c94f20` / 51 `0x2ec6750`, 54 bytes, identical — `this+8`, a lambda
`{Actor&, method}`, `processEvent`: 2024's 61-byte body. Two differences from 2024: it is reached through a vftable slot
(40 `0xa6b3bd0`; no direct caller), and the method comes **by reference** (`movzbl (%r8)`), so it ships as
`bdsx:ActorEventCoordinator::sendActorCreated` and bdsx's hook takes a pointer. The second builder of the same lambda
(40 `0x2c94e00`, 276 B, three slots earlier) resolves the actor from an entity first; a pass-through hook on it fired
once per session and is left alone.

**Execution** (`ec40`/`ec51`; tsc 0, exit 0, `Quit correctly`): a raw hook first showed one call per actor entering the
world (world-loaded actors with method 1, summoned ones with 2); through bdsx's own hook, `ecprobe check` 3/3 on each
build — pig and zombie with 2 (Spawned), no bogus method value.

### `splashPotionHit`: `SplashPotionEffectSubcomponent` is gone in 1.26; its work moved to `ThrownPotionEffectSubcomponent` (2026-09-24, open)

2024 had 19 projectile on-hit subcomponents. In 1.26 the JSON keys `potion_effect` (the splash one), `splash_potion`,
`mob_effect`, `spawn_chance` and `ignite` are gone from the image, and 51's type-name list names 17 subcomponents —
every sibling, including `ThrownPotionEffectSubcomponent` and a new `WindBurstOnHitSubcomponent` — but not
`SplashPotionEffectSubcomponent`; no symbol source names it either. Splash potions still work, and the successor is
plain: `ThrownPotionEffectSubcomponent` (key `thrown_potion_effect`, in both years; 2024 shared `readfromJSON` with the
splash one) has a `doOnHitEffect` of 5279 / 5094 bytes on 1.26 where 2024's was a potion-id check. Its vftable was found
from `getName`, the only reference to the `"thrown_potion_effect"` literal: 40 `0xa649680` → slot 3 **`0x1aef0b0`**, 51
`0xa79f750` → **`0x240ede0`**; the prototype `(this, Actor&, ProjectileComponent&)` still holds (rdx / r8 read in the
prologue). Not shipped: bdsx's `SplashPotionHitEvent` reads and writes `potionEffect`, a field of the vanished class;
in 1.26 the potion comes from the thrown-potion actor (2024 `ThrownPotion::getPotionId`), whose 1.26 accessor is the
missing piece.

**Done (same day)**: the 1.26 body inlines that accessor — `getEntityTypeId() == 0x400056`, then synched data item 36,
a Short (2024 `getPotionId` = `getShort(36)`), stored into `this+8` — so bdsx's hook now sits on
`ThrownPotionEffectSubcomponent::doOnHitEffect` (2024 decoration, prototype unchanged, shipped), reads item 36 at entry
(bdsx gained `SynchedActorDataEntityWrapper.getShort`/`setShort`, the same walk as `setInt`), and writes a listener's
change back to it before the original reads it. **Execution** (`sp40`/`sp51`, `spprobe`, `SPLASH_PROBE=1`; tsc 0, exit
0, `Quit correctly`; 2/2 PASS each): a summoned splash potion over a pig held in a two-deep pit fires the event with id
0 (water; the item read raw as a Short 0 too); a listener changing it to 23 takes the pig from 10 to 4 (Instant Damage I,
which water cannot do); the same change plus `CANCEL` leaves the second pig at 10. Pigs left free walk out of the
splash in the 8 seconds between console commands — hence the pits.

### `projectileHit`: `ProjectileComponent::onHit` is still out of line; `HitResult::getEntity` derived (2026-09-24)

The `"ProjectileSystem"` string names the system (40 vftable `0xa63b390`, tick at slot 2 = `0x3706bd0`), whose tick calls an
8 KB function three times; that one calls **`onHit`: 40 `0x1ae16e0` / 51 `0x23fe9f0`** three times (6912 / 7184 B; 2024
1366 B), with 2024's prototype. Its body copies the HitResult's `WeakEntityRef` (+0x38 registry, +0x40 count block,
+0x48 EntityId) and sends the `ProjectileHitEvent` through `EventCoordinatorPimpl<ActorEventListener>::_processEvent<
ActorGameplayHandler, ActorGameplayEvent<CoordinatorResult> const>` (40 `0x2c84380`, 51 `0x2eae400`, found from its lambda
scope with `tools/lambda-owner.mjs`; it reads the event variant's index at +0x98). `HitResult::getEntity` has no copy:
`derived()` over that `WeakEntityRef`, the entt registry at `EntityRegistry+0x30` (measured live on both builds:
every actor's +16 minus its +8) and the `ActorOwnerComponent` lookup (`engine/entt.ts` `enttActorFromWeakRef`).
**Execution** (`ph40`/`ph51`, `phprobe`; tsc 0, exit 0, `Quit correctly`; 2/2 PASS each): an arrow summoned over a pig
in a pit fires `projectileHit` with the pig as victim; one over stone with none.

### `playerInventoryChange`: `Player::inventoryChanged` found through its one caller, done on both builds (2026-09-24)

`?inventoryChanged@Player@@QEAAXAEAVContainer@@HAEBVItemStack@@1_N@Z` is 40 `0x236fa0` and 51 `0x2c6040`.

- **Route 1, caller.** 2024 has exactly one caller, `FillingContainer::setItemWithForceBalance`. It calls the function
  only when the container's `player_` is set and the stored item really changes. Each build's
  `setItemWithForceBalance` (40 `0x1f3f850`, 51 `0x253bfd0`, already in the table) does the same: `player_` at
  `+0x1b0` is tested, then the call gets rdx = the container, r8d = the slot, r9 = the old item (items at `+0x198`),
  and the new item and the bool on the stack. That is 2024's argument list exactly, and the callee has no other caller.
- **Route 2, body.** 2024 opens with `getILevel()` and a level virtual for the item registry, saving r8d/r9. 1.26 opens
  with `mov rcx,[rcx+0x1d8]` (the level) and the level virtual at `+0xc38` (40) / `+0xc40` (51), saving the same two
  registers.

bdsx's hook runs unchanged. **Execution** (`inv40`/`inv51`, `tools/block-probe.ts` `invprobe`, `INV_PROBE=1`):
- `replaceitem`, `give`, `clear <item>` and `clear` each fire once, with the right slot, old item and new item.
- The chain of old items shows the original still applies each change.
- `clear @a` on an empty inventory fires nothing.

### `projectileShoot`: `ProjectileComponent::shoot(Actor&, Actor&)` is still out of line, found through `Arrow::shoot` (2026-09-24)

The earlier search (through shared helpers) failed. What worked was starting from the other overload.

**Arrow's slots.** 2024's `Arrow::shoot` looks up `ProjectileComponent` and calls
`shoot(Actor&, Vec3 const&, float, float, Vec3 const&, Actor*)`. The shipped `?shoot@Arrow@@` (40 `0x1256b80`,
51 `0x24b1b20`) turned out to be `Arrow::addAdditionalSaveData`: it writes `"OwnerID"`, `"isCreative"`,
`"enchantPower"`, `"mobEffects"`, `"auxValue"`. The vftable route put three Arrow names one slot early:

| slot (40 / 51) | table label | what the body is |
|---|---|---|
| 135 / 134 | `addAdditionalSaveData` | `readAdditionalSaveData` (calls AbstractArrow's) |
| 136 / 135 | `shoot` | `addAdditionalSaveData` |
| 137 / 136 | `_getPickupItem` | `shoot` |

51 inherited the mistake through `carry`. None of the three is required by bdsx. All three are retracted on both builds
(`candidates-instances` `retracted`).

**The six-argument overload.** The real `Arrow::shoot` (40 `0x1255770`, 51 `0x24b06d0`) is 2024's: an EnTT lookup of
`ProjectileComponent` (`0x94488499`), then a call with `(comp, this, dir, power, uncertainty, baseSpeed, nullptr)`.
The callee is 40 `0x1ae45b0` / 51 `0x24020c0`, with nine callers (2024: ten).

**The two-argument overload.** One of those nine is the target: 40 `0x1ae4430` / 51 `0x2401f40` (375 B; 2024 227 B).
Its body follows 2024's step for step:
- level from the owner (`r8+0x1d8`), difficulty from a level virtual
- `power +0x100`, `uncertaintyBase +0x1a0 − difficulty × +0x1a4`, clamped at 0
- `getShooterAngle`, then the six-argument call with `Vec3::ZERO` and a null owner
- new in 1.26: it stores the owner's unique id into the component

It has two callers, as 2024's did. One is `Spawner::spawnProjectile`-sized (779 B vs 765 B). The prototype is unchanged,
so bdsx's hook takes the real decoration.

**Execution** (`shoot40`/`shoot51`, `tools/block-probe.ts` `shootprobe`, `SHOOT_PROBE=1`):
- A snow golem by two zombies at midnight: each snowball fires `projectileShoot` with the snowball as projectile and
  the golem as shooter.
- A powered dispenser's arrow (`testfor` finds it) fires nothing. It has no shooter, so `spawnProjectile` takes the
  six-argument path, as in 2024.

### `queryRegenerate`: `_announceServer` is inlined into `_startAnnouncingServer`; the hook moved there (2026-09-24)

`?_announceServer@RakNetServerLocator@@` has no out-of-line copy. In 2024 its only caller was
`_startAnnouncingServer`, with the same arguments.

**Finding `_startAnnouncingServer`.** The `"MCPE"` literal is referenced once per build, from the ping-reply builder
(`_setPingResponder`: 40 `0xc20df0`, 51 `0x95e5b0`). Its only caller is 40 `0xc258f0` / 51 `0x963930` (432 B), whose
only caller is a large update function. 2024's `_startAnnouncingServer` is called only by `RakNetServerLocator::update`.
The 432-byte function is 2024's `_startAnnouncingServer` with `_announceServer` inlined:
- the mutex at `+0x2a0` and the two virtual checks
- `AnnounceServerData::operator=` inlined, copying into the member at `+0x2f8`
- `_setPingResponder(this, member)`, then the announcing flag set to 1

**The struct.** `AnnounceServerData` keeps the offsets bdsx reads (current players `+0x44`, max `+0x48`, joinable
`+0x4c`), and the ping builder reads exactly those. 1.26 only appends bools up to `+0x50`. So bdsx's hook moved to
`?_startAnnouncingServer@RakNetServerLocator@@AEAAXAEBUAnnounceServerData@1@@Z` unchanged, and the required set
swapped that one name.

**It needs LAN visibility.** With `enable-lan-visibility=false` (both instances, host runbook section 2) the locator
never announces, and the event never fires (`qr40`/`qr51`: 0 events). `tools/host/drivers/qrlan40/51.ps1` turn it on
for their one run and restore it in `finally`, so **run them alone**: a LAN-visible instance binds 19132/19133.

**Execution** (`qrlan40`, then `qrlan51`):
- Two events at start with 0 players: the server's own announce, and bdsx's `afterOpen` `updateServerAnnouncement`.
- One event with 1 player after the bot joins.
- The listener's `maxPlayers = 77` comes back in an unconnected ping's MOTD (`tools/ping-protocol.cjs`):
  `MCPE;bdsx-again-inst40;2168;1.26.40;1;77;…` and `MCPE;bdsx-again-inst51;2193;1.26.51;1;77;…`.
- One 51 attempt died with Q8's "about 15 s after the join" crash. This time a fault capture exists: an execute
  fault at an address in no module, with only ChakraCore and the VCRUNTIME proxy on the stack
  (`work/host-runs/qrlan51-20260924-crash.err`). The rerun passed.

### `isInClouds`: `derived()` over Dimension's `getCloudHeight` slot, done on both builds (2026-09-24)

1.26 keeps no out-of-line `Actor::isInClouds`. 2024's body (`0x19b93b0`) locks the dimension `WeakRef` and calls
the dimension's `getCloudHeight` (vftable slot 21, returns a short). It returns `h < y < h + 4`, with `y` read from
the state vector's position.

**The 1.26 slot.** Endstone's `dimension.h` counts `getCloudHeight` as slot 24: IDimension's 15, then the tenth of
Dimension's own. `tools/block-probe.ts` `dimprobe` (`dim40`/`dim51`) read the player's dimension vftable live in all
three dimensions, and slot 24 holds:
- nether: `mov ax,0x80; ret`
- the End: `mov ax,8; ret`
- overworld: 192, or 128 behind an old-world version gate

Slot 23 copies its `Color` into the sret (`getBrightnessDependentFogColor`), Endstone's order.

**Shipped.** `engine/dimension.ts` calls the slot (`layouts.Dimension.getCloudHeightSlot` = 24), and
`Actor.isInClouds` is a `derived()`.

**Execution** (`cloud40`/`cloud51`, `cloudprobe`), 6/6 per build. The answer must equal `h < y < h + 4` with `h` the
constant read off the binary:
- overworld: y 69.62 false, y 192.62 true
- nether: y 130.62 true, y 141.62 false
- the End: y 8.62 true, y 31.62 false

A first `dim51` died before the bot spawned, with no report (the Q8 flake). The rerun was clean.

### `startCooldown` found; `getItemCooldownLeft` was wrong and is now a `bdsx:` key (2026-09-24)

**`startCooldown(HashedString const&, int, bool)`**, 40 `0x239360` / 51 `0x2c8500`:
- the same `(rdx, r8d, r9b)` saves as 2024's
- a lookup of the player's EnTT component `0xc099c998` (0x80 bytes)
- the only code in Player's cluster that stores `??_7PlayerStartItemCooldownPacket@@6B@`
- the store (`0x2c41050`) writes the duration into the entry's `+0x40`/`+0x44`

**`startCooldown(Item const*, bool)`**, the name bdsx needs, is its 344-byte caller (40 `0x21d850`, 51 `0x2ac040`).
It is 2024's body:
- Item virtual `+0x338` (`getCooldownType`), namespaced with the `"minecraft"` literal into a `HashedString`
- if that is non-empty, Item virtual `+0x340` (`getCooldownTime`), then the call with the bool
- 1.26 dropped 2024's leading null check on the item

It has 12 callers on each build, with pairwise-equal sizes: `Item::use`, `ComponentItem::use`/`releaseUsing`,
`Player::_hurt`, and a 99-byte `ItemStackBase::startCoolDown` that passes `true`. The bool means "send the packet".
bdsx had left it unset, and now passes `true` and skips a null item.

**`getItemCooldownLeft`** had shipped from the propagation route under 2024's `(HashedString const&)` decoration.
The 1.26 body compares the argument register itself with each node's stored hash, so it takes the hash by value. The
component holds two maps:
- `+0x08`: namespaced category → ticks left
- `+0x48`: item category → cooldown category, followed through a helper that namespaces it

Every bdsx call had passed a pointer and missed. The first `cd40`/`cd51` read 0 right after the start, while a dump of
the component showed `minecraft:goat_horn` stored. The name is retracted on both builds. The function ships as
`bdsx:Player::getItemCooldownLeft`, and bdsx namespaces the category as 2024 did, then passes its FNV-1-64 hash.

**Execution** (`cd40`/`cd51`, a goat horn: category `"goat_horn"`, 140 ticks, from the binary's own literal and
`mov eax,0x8c`):
- 0 before the start
- 140 right after, asked both as `minecraft:goat_horn` and as `goat_horn`
- 0 eight seconds later, once it has run out

### `fetchNearbyActorsSorted`: found through `GroupSizeSystem`, done on both builds (2026-09-24)

2024's `GroupSizeSystem::_tickComponent` calls `getEntityTypeId`, then `fetchNearbyActorsSorted(Vec3, ActorType)`,
then `ActorFilterGroup::evaluateActor`. 1.26 has the same chain:
- The `"GroupSizeSystem"` literal is registered with system vftable 40 `0xa63ba50` / 51 `0xa75e750`.
- Its tick (slot 2) calls a 641-byte `_tickComponent` three times.
- That function calls `getEntityTypeId`, then 40 `0xe20ee0` / 51 `0xd61100`, then a 983-byte evaluator.
- The call passes an sret vector, a `Vec3` of three equal floats (the radius) and the type. The body zeroes the vector
  and reads the three floats first.
- It has 12 callers (2024: 7 plus the 29-byte wrapper). The prototype is unchanged, so bdsx's binding works as is.

**Execution** (`near40`/`near51`, `nearprobe`): pigs penned 2, 5, 8 and 16 blocks from the player.
- `(Vec3(10,10,10), Pig)` returns the three inside, nearest first: `distanceSq` 10.86 / 31.86 / 70.86, each equal to
  the squared distance recomputed from the positions.
- The Cow filter returns none.

### `canSee`: the Vec3 overload grew a bool; the Actor overload is inlined (2026-09-24)

**`canSee(Vec3 const&)`.** 2024's `WitherBoss::newServerAiStep` calls `canSee`. This build's (in the table) calls
40 `0xe0fa90` / 51 `0xd4f980`, which has 14 callers, all AI code. It is 2024's `canSee(Vec3 const&)` step for step:
- lock the dimension, take its `BlockSource` (IDimension slot 12)
- `getAttachPos(this, 3 = head, 0.0f)` (40 `0xdeb730`, 51 `0xd2b6d0`)
- the `BlockSource` clip virtual to the argument, with `CHECK_ALL_PICKABLE_BLOCKS` and max distance 200
- return `(type & ~1) == 2`

The one difference is a new bool argument, which lands in the clip argument where 2024 passed a constant `true`. So it
ships as `bdsx:Actor::canSee`, and bdsx passes `true`.

**`canSee(Actor const&)`.** 2024 kept a separate ~400-byte body: a spectator check, then the same clip from this
actor's head to the other's head. 1.26 inlines it into every caller. It is a `derived()`: false for a spectator,
otherwise the Vec3 overload at the other actor's `getAttachPos(3)`.

**Execution** (`see40`/`see51`, `seeprobe`): an armor stand 6 blocks away is seen by both overloads, hidden by a stone
wall, then seen again once the wall is removed.

### `isInRaid`: out of line on 40, inlined on 51; only the false side seen (2026-09-24)

2024's only caller is `PlayerDeathManager::playerDied`, which builds a `DeathInfoPacket`. On 40, the only 1-2 KB
function that stores `??_7DeathInfoPacket@@6B@` (`0x12463b0`) calls `0x234b80`, which has no other caller. Its body is
2024's `isInRaid`:
- the locked dimension, and its `VillageManager` at `dimension+0x5e0`
- the floored `BlockPos`, then the manager's virtual 1 with `(sret weak_ptr<Village>, pos, 32, -1)`
- the lock, then `Village::hasRaid` inlined as 2024's own body, `cmpq $0, 0x348(village)`

It ships on 40 on those two routes. On 51 the same code is inlined into the `DeathInfoPacket` builder (`0x2cc0b0`), with
the manager at `dimension+0x3e0` and the same `0x348`. A 51 `derived()` would call the manager's virtual 1 and must
release the returned `weak_ptr`'s weak count itself.

**Execution, one side only** (`raid40` ×2, `raidprobe`): bdsx's `isInRaid` returns false outside a raid. A raid could not
be staged for the bot. I tried a bell, three beds and three villagers, then `raid_omen`, then `bad_omen` with a minute for
the village to form. No raid started, most likely because the bot never leaves the loading screen. So true has never
been seen, the 51 `derived()` is not written, and the rest is Q7: a human with Bad Omen walking into a village.

### `SimulatedPlayer`: `create` found on 40, its prototype changed; `tryGetFromEntity` stays a candidate (2026-09-24)

`?tryGetFromEntity@SimulatedPlayer@@` would be `Player::tryGetFromEntity` plus the flag component the binary spells
`SimulatedPlayerFlagComponent` (`0xa83d07f5`, 9 users on both builds). Only its null side can be executed (the bot is
not simulated), so it stays a candidate. The true side needs a simulated player in the world, which led to `create`.

**`create`.** On 40 the chain from `??_7SimulatedPlayer@@6B@` (`0xa625b10`) is:
- its only constructor store, `0x12d12a0` (843 B)
- that constructor's only caller, `0xa8ca30` (2989 B; 2024's `ServerNetworkHandler::createSimulatedPlayer` was 1241 B)
- that function's only caller, `0x12d17b0` (919 B), which also calls `getDimensionId` and
  `setSpawnBlockRespawnPosition`: 2024's `SimulatedPlayer::create`
- whose only caller is `0x12d1c60` (320 B), presumably the GameTest helper

The prototype changed. 2024's took `(name, BlockPos, dimension, not_null<NonOwnerPointer<ServerNetworkHandler>>,
xuid)` with the `not_null` in r9. 1.26's `gsl` `not_null` check reads the *seventh* argument (`0xd0(%rbp)`, entry+0x38).
So bdsx's `SimulatedPlayer.create` binding is wrong for 1.26 in any case, and it also needs a `ServerNetworkHandler`
pointer bdsx does not have on 51. Next step: read `0x12d1c60`'s call to learn the seven arguments. Only then can a
simulated player be made, giving `tryGetFromEntity@SimulatedPlayer` its true side, and bots that can attack and use items
(Q7's list).

**`create`'s caller** (`0x12d1c60`, 320 B) is a wrapper. It takes `(name, BlockPos, dimension in r8d,
NonOwnerPointer<ServerNetworkHandler> const* in r9, a fifth pointer, a sixth 16-byte object)`. It first checks the
handler through `not_null`, then calls `create` with nine arguments:
`(name, pos, &Vec3::ZERO, &Vec2::ZERO, false, dimension, &handler copy, arg5, &copy of arg6)`.

The wrapper's list is 2024's `create` plus the 16-byte sixth argument (2024's fifth was the xuid string). Before bdsx
can call it, two things are needed: what the fifth and sixth arguments are (read the wrapper's GameTest caller, and
51's twin), and a `ServerNetworkHandler` `NonOwnerPointer` on 51.

**Done** (2026-09-24). The wrapper ships on both builds as `bdsx:SimulatedPlayer::create` (40 `0x12d1c60`,
51 `0x11f3d20`). The handler pointer is built from `Level+0x220` (the `NonOwnerPointer` ILevel's virtual `+0xa48`
copies out, and the same getter on both builds), with the object moved back 0x10. bdsx adds the reference the wrapper
drops. The optional is passed disengaged and the xuid empty, as the GameTest callers do. `tryGetFromEntity@SimulatedPlayer`
is a `derived()` on `SimulatedPlayerFlagComponent`.

**Executed** (`sim40`/`sim51`, `simprobe`): `simbot` spawns (`Player Spawned: simbot`), is in the level's player list,
is a Player named `simbot` where it was put, and `tryGetFromEntity` finds it and not the bot. `kill @a` kills it, and the
server stops clean.

Every `simulate*` action bdsx declares (attack, useItem, destroyBlock, interact, jump, lookAt, move, disconnect, …) is
still unresolved on both builds. They are the next item: they would let a server-side bot do what Q7 needs a human for.

### SimulatedPlayer actions: `simulateAttack`, found through the GameTest bindings (2026-09-24)

The GameTest registration function (40 `0x568cda0`, 51 `0x90eef80`, ~55 KB) pairs each script method-name literal with
a `lea` of the method's implementation right before it. `"attackEntity"` → `ScriptSimulatedPlayer::attackEntity` (40
`0x56a5560`, 51 `0x9107d40`), which unwraps the script actor, checks its dimension and calls `simulateAttack(Actor*)`:
40 `0x12d5600`, 51 `0x11f76b0`. That is 2024's body:
- the alive virtual
- the level tick minus the last attack tick, compared with 10
- the swing (2024's `_trySwing`, now inlined), and the tick stored
- the actor's own `attack` virtual (`+0x1a0`, with the sret prototype `bdsx:Actor::attack` already uses), with the
  target and cause 2

Its own prototype is unchanged. **Executed** (`satk40`/`satk51`): simbot hits a pig summoned beside it in the same tick
(true, 10 → 9). A second call at once is refused by the cooldown (false, unchanged).

The same route should give the rest: `"useItem"`, `"useItemInSlot"`, `"breakBlock"`, `"interactWithBlock"`,
`"interactWithEntity"`, `"jump"`, `"disconnect"`, `"lookAtEntity"`, … each literal sits next to its binding.

**The rest of the actions** (2026-09-24). Each 2024 `ScriptSimulatedPlayer` method's `simulate*` callee maps to the
callee of the 1.26 binding with the same literal. Checked by reading each binding's call and the body:
- `simulateDestroyBlock` (40 `0x12d6660`, 51 `0x11f8700`) and `simulateJump` (40 `0x12d3e60`, 51 `0x11f6050`).
- `simulateUseItem` (40 `0x12d5850`, 51 `0x11f7900`). `simulateUseItemInSlot` (40 `0x12d5ba0`, 51 `0x11f7c50`) calls it
  after `setSelectedSlot`, as 2024's does.
- `simulateDisconnect` is **inlined** into the `"disconnect"` binding: a helper, the player's virtual `+0x58`, then a
  member reset through `0x12d7000`. That `0x12d7000` is a 24-byte member setter, not the disconnect. Not shipped.

**Events a simulated player now fires** (`sact40`/`sact51`, `simact`, `SIMACT_PROBE=1`), all through bdsx's own hooks:
- `blockDestroy`: creative simbot breaks stone. The event fires at that position, and `testforblock` finds air.
- `playerUseItem`: simbot throws a snowball from slot 0 (method 4, consume true).
- `playerCrit`: simbot jumps and hits a pig on the way down (8 ticks after the jump). This needed a fix first: 1.26's
  `Player::_crit` takes one more int, which it writes as a float into the `AnimatePacket`. The 2024 decoration is
  retracted, and the hook uses `bdsx:Player::_crit` and passes the int through.
- **Timers**: a `setTimeout` inside a console command ran only at shutdown, after the level was gone, so it faulted.
  Tick-driven probe steps must use `events.levelTick`.

**`blockDestroy`'s cancel**: on 51 a cancelled creative destroy leaves the block (the call returns false). On 40 the
same cancel still made `simulateDestroyBlock` return true, and a native crash (`JS Crash`, no fault capture) followed.
It reproduced twice. Open, in Q8. `SurvivalMode::destroyBlock` is a thunk that checks the trial flag and tail-jumps into
`GameMode::destroyBlock` on both builds, as in 2024. So the one `GameMode` hook covers survival breaking too, and the
survival name stays unresolved on purpose (hooking both would fire twice). A survival simbot's `simulateDestroyBlock`
on dirt returned false and broke nothing. Not investigated.

**`blockDestroy`'s cancel, resolved** (2026-09-24). The 40 crash was not in the cancel. It was in bdsx's creative
branch, which asks `item.canDestroyInCreative()` when the player holds an item (simbot held its leftover snowballs).
That was a `procHacker.jsv("??_7ComponentItem@@6B@", …)`, which finds the slot by looking the address up in the named
vftable. 1.26's tables don't name that vftable, so the call threw inside the hook: a native crash on 40, and a silent
false on 51. The same throw most likely explains the survival `false`.

The slot is 48 on both builds (2024: 43). The component item's live table (the apple's) holds the shipped
`?canDestroyInCreative@ComponentItem@@` there, and it is 2024's leaf (bit 1 of a flags byte, `+0x258` → 40 `+0x210` /
51 `+0x218`). bdsx now calls that slot through the item's own table (`engine/item.ts`,
`layouts.Item.canDestroyInCreativeSlot`).

**Executed** (`sact40`/`sact51`):
- A cancelled creative destroy leaves the stone, and the event is seen cancelled (it fires every tick, since the
  simulated player keeps trying).
- In survival, simbot breaks dirt with **exactly one** event.
- The earlier checks still pass (break, snowball, crit).

**`jsv` audit** (2026-09-24). Every `procHacker.jsv(vftable, function)` in bdsx was checked against both tables. Where
the function ships but the vftable isn't named, a call throws at runtime ("vftable offset not found"). That was the
`canDestroyInCreative` failure. `??_7ComponentItem@@6B@` now ships on both builds (40 `0xa6dae40`, 51 `0xa78b6f0`: the
apple's live table, which holds the three named ComponentItem virtuals at slots 28/29/48). That also covers
`buildNetworkTag` and `initializeFromNetwork`. What is left of that failure class is `?load@BlockActor@@` behind the
unnamed `??_7BlockActor@@6B@`. The other gaps the audit lists are ordinary missing functions, and those fail loudly.

### `levelExplode`: TNT goes through `Level::explode(Explosion&)` (2026-09-24)

bdsx hooked the nine-argument `Level::explode`. Its 1.26 prototype is 2024's (the stack arguments line up at
`+0x90..+0xb0`), but TNT never reaches it. With it hooked, a TNT exploded and nothing fired. The nine-argument overload
builds an `Explosion` on its stack and calls the explosion routine (40 `0x6dae50`, 51 `0x4e0540`). That routine's only
other caller is a 57-byte function (40 `0x73a170`, 51 `0x7d2920`, slot 120 of the live Level vftable): 2024's
`?explode@Level@@UEAA_NAEAVExplosion@@@Z`, with the same client-side check and random source and a tail jump. It ships
under that name.

bdsx now hooks it as well. It reads the event's fields from the `Explosion`, using the offsets the nine-argument overload
writes (`layouts.Explosion`, `engine/explosion.ts`): position `+0`, power `+0xc`, fire/breaking/underwater
`+0x50/51/52`, source id `+0x60`, `BlockSource*` `+0x68`, max resistance `+0x70`. What the listener changes is written
back.

**Executed** (`ex40`/`ex51`, `exprobe`): a summoned TNT fires `levelExplode` (power 4). Cancelled, the stone under it
stays. Allowed, the stone is gone.

**`playerSleepInBed` and `playerDropItem` with simbot** (2026-09-24):
- `simulateUseItemOnBlock` (40 `0x12d5950`, 51 `0x11f7a00`, from the `"useItemOnBlock"` binding) with a stick on a bed at
  midnight goes the engine's own way: `useItemOn`, the bed, `Player::startSleepInBed`. bdsx's `playerSleepInBed` fires.
  Cancelled, simbot stays awake (`isSleeping` false); allowed, it sleeps (`sbed40`/`sbed51`). An empty item makes the
  call return false before anything happens.
- `playerDropItem`: the `"dropSelectedItem"` binding calls the player's `drop` virtual (40 `+0x3a0`). On 40 that slot is
  the hooked `Player::drop`, and simbot's drop worked (a Dirt item entity appeared). But bdsx raises `playerDropItem`
  from that hook only while a container is open. The ordinary hotbar drop is taken from the client's
  `InventoryTransaction` packet, which a simulated player never sends. So this event stays with Q7. (51's binding
  reaches drop through a different slot. Calling 40's `+0x3a0` there crashed the server, a mistake of mine: rule
  "only call a slot whose body you've read".)
- **`playerDropItem` fired, both sides, both builds (2026-09-24, `sdropc40`/`sdropc51`).** 51's binding (`0x9108f20`)
  calls `getSelectedItem` at `+0x268`, `drop(item, false)` at **`+0x398`**, then `setSelectedItem(EMPTY)` at `+0x260`.
  40's (`0x56a67e0`) calls `drop` at `+0x3a0`. The probe calls whichever of the two slots holds the shipped
  `?drop@Player@@` and refuses otherwise. Simbot first opens a chest (`useon`), which sets bdsx's
  `hasOpenContainer` through the `ContainerOpen` packetSend. Then:
  - cancelled: `drop` returns false and no item entity appears;
  - allowed: it returns true and a Dirt item entity appears.

  That is the event's open-container path. The hotbar path (a client's `InventoryTransaction`, `packetBefore`) still
  needs Q7. A stray `drop simbot <empty>` seen once in `sbiw51` was the same path: the engine dropping an empty stack
  while simbot's chest was open.

**`entityStartSwimming` with simbot** (2026-09-24). The shipped `?startSwimming@Player@@` (40 `0x238470`, 51 `0x2c7590`)
is 2024's body: it sets actor flag 0x39 (`SWIMMING`) through `setActorFlag` and takes only `this`, so bdsx's hook
prototype holds. The GameTest `"swim"` binding just calls the player's `startSwimming` virtual: `+0x318` on 40, `+0x310`
on 51. `"stopSwimming"` calls the next slot. **Executed** (`sswim40`/`sswim51`): calling that slot on simbot fires
`entityStartSwimming`. Cancelled, `isSwimming` stays false; allowed, it is true. The probe finds the slot by the
table's address, which is how it found 99 on 40 and 98 on 51.

With that, every UNFIRED event in `node tools/event-coverage.mjs` has fired on both builds except `playerDropItem`.
bdsx raises it from the client's `InventoryTransaction` packet or with a container open, which needs Q7.

### `itemUse`: `ItemStack::use` is inlined into `GameMode::useItem`, and the hook moved there (2026-09-24)

`??_7GameMode@@6B@` keeps 2024's order for slots 0-11 and 14-15: `destroyBlock` at 2 (in the table), `useItem` at 11.
Slots 12 and 13 swapped: 12 is `interact` (111 lines), 13 is `useItemOn` (995 lines, the table's own label). In
2024, `ItemStack::use` (a cooldown check, then the item's `use` virtual) had exactly one caller, `GameMode::useItem`.
1.26's `useItem` (40 `0x1f39b40`, 51 `0x30b1720`) holds that code inlined: the cooldown-category virtual `+0x338`, the
cooldown test, the item's use. So `?use@ItemStack@@` has nothing to hook. When the table lacks it, bdsx's `itemUse`
now hooks `?useItem@GameMode@@UEAA_NAEAVItemStack@@@Z` with the same item and player, and a cancel returns false.

**Executed** (`suse40`/`suse51`): simbot's snowball fires `itemUse`. Cancelled, nothing is thrown: no `playerUseItem`,
and the stack stays at 4. Allowed, `playerUseItem` follows.

### `itemUseOnBlock`: from `GameMode::useItemOn`, which gained an eighth argument (2026-09-24)

**The target.** bdsx hooked `ItemStack::useOn`. 1.26's `useOn` (40 `0x1bb2b50`, 51 `0x2ceb030`) takes
`(ItemStack*, Actor&, BlockPos const&, face, [51: a byte,] std::optional<Vec3> const&)` and returns the result in eax,
where 2024's took ints and an sret. It ships as `bdsx:ItemStack::useOn`. But hooking it and returning failure did not
stop the placement: `GameMode::useItemOn` goes on and places the block itself. So bdsx raises the event from
`useItemOn`.

**The prototype.** `useItemOn` (slot 13, the address the table shipped under 2024's decoration) takes **one more
bool** than 2024's: `(…, click, Block*, bool)` on 40, `(…, click, bool, Block*)` on 51, read off the frame. The 2024
decoration is retracted. It ships as `bdsx:GameMode::useItemOn`, with `layouts.GameMode.useItemOnBoolFirst` choosing the
order. A first hook with 2024's seven arguments worked on 40 by luck and made 51 refuse every placement.

**Executed** (`suon40`/`suon51`): simbot uses dirt on the floor. Cancelled, nothing is placed (air, and the stack stays
at 4). Allowed, dirt is placed and `playerUseItem` (method 6) follows.

### `attackBlock` from `GameMode::startDestroyBlock`; `blockDestructionStart` and `playerJump` are client-driven (2026-09-24)

2024's `Block::attack` was a thunk into the block class's `attack` virtual (`BlockLegacy+0x328`). 1.26 keeps no
out-of-line copy, and a per-class virtual can't be hooked for every block. 2024's callers were
`GameMode::startDestroyBlock`, `continueDestroyBlock` and two network handlers. `startDestroyBlock` is slot 1 of the
GameMode table on both builds (40 `0x1f352a0`, 51 `0x30acc70`) with 2024's arguments (rdx position, r8b face,
r9 `bool&`). It ships under 2024's name.

When `Block::attack` is unresolved, bdsx's `attackBlock` now hooks it. The event is built from the block at the position,
and a cancel stops the breaking before it begins. Unlike 2024, it fires once per start, not on every
`continueDestroyBlock` tick. **Executed** (`satb40`/`satb51`): a survival simbot on dirt fires it. Cancelled, the dirt
stays; allowed, it breaks.

`blockDestructionStart` (`BlockEventCoordinator::sendBlockDestructionStarted`) and `playerJump`
(`Player::handleJumpEffects`) were called in 2024 only from the handlers of the client's `PlayerActionPacket`. A simulated
player never sends one, so both stay with Q7.

### `playerInteract`: `Player::interact` returns its result by sret now (2026-09-24)

The `"interactWithEntity"` binding (40 `0x56a5b50`, 51 `0x9108310`) calls 40 `0x228cd0` / 51 `0x2b7be0` with
`(rcx player, rdx a local result, r8 the actor, r9 &Vec3::ZERO)` and reads bit 0 of the result. That is 2024's
`Player::interact(Actor&, Vec3 const&)`, except that 2024's returned bool and 1.26's fills an `InteractionResult`
through an sret. Both have three callers, and the body hands the result to the interaction callback. It ships as
`bdsx:Player::interact`. bdsx's hook passes the sret through, and a cancel writes a failed result.

**Executed** (`sint40`/`sint51`): simbot with a bucket and a cow. Cancelled, the result is 0 and the bucket stays.
Allowed, the result is 1, it becomes a milk bucket, and `playerUseItem` (method 8) follows. A first 51 run failed only
because the probe killed and resummoned the cow in the same tick and got the dying one back. With the hook installed
and one live cow, 51 behaved like 40.

### `chestOpen`, `buttonPress`, `blockInteractedWith`: 1.26's block-use dispatch is not found yet (2026-09-24)

In 2024 all three hang off a player using a block: `ChestBlock::use`, `ButtonBlock::use` (`BlockLegacy` virtuals), and
`VanillaServerGameplayEventListener::onBlockInteractedWith`. They are reached from a non-virtual `Block::use(Player&,
BlockPos const&, uchar, optional<Vec3>)` (2024 `0x1bbc3d0`, a 0x698-byte frame; callers `useItemOn`,
`simulateInteract(BlockPos)`, `AgentInteractSystem::tick`). What 1.26 shows:
- **No out-of-line `Block::use`.** None of `useItemOn`'s callees (40) is near that size.
- **Endstone doesn't help.** 0.11.7's `block_type.h` comments `use` out, and Endstone's table hooks no block use.
- **The path exists.** Simbot's stick on a bed reached `Player::startSleepInBed` (`sbed40`/`sbed51`). But
  `startSleepInBed` is only called virtually (3 vtables hold 40 `0x214c20`), so a call-edge walk cannot climb from it.
- **Unmatched calls in `useItemOn`.** The `BlockLegacy` virtual calls there are `+0x20` (with an sret, most likely the
  collision shape) and `+0x3b8` (after `useOn` succeeds). Neither has been matched to 2024's `use`.

Next: find the bed's own `use`, the function that calls `startSleepInBed`'s slot (`+0x…` of the Player table: find the
index of `0x214c20` in `0xa5eb368`, then scan for `callq *<that>(%rax)` near bed code), and climb from there to the
dispatcher.

### `chestOpen`, `buttonPress`: the blocks' registered interact handlers (2026-09-24)

1.26 dispatches a player's use of a block to handlers the block's constructor registers, not to 2024's
`BlockLegacy::use` virtual. The block type holds them in a vector at `BlockType+0x340`, and the interact handler
answers type 4. The bed led here. Its `tile.bed.*` messages sit in `0x1b9f9f0`, called from `0x1b9f3c0`, which nothing
calls: it is only `lea`'d by the BedBlock constructor (`0x1b9e730`), which registers it through a template that replaces
the type-4 handler. Every such template instance (30+, one per block class) compares 4.

Finding a block's handler: find its constructor by where it stores the vftable, then take the function passed to its
type-4 registration.
- ChestBlock (`??_7ChestBlock@@6B@`): 40 `0x699e790`, 51 `0x8b25610`
- ButtonBlock: 40 `0x1ef90c0`, 51 `0x1a31b20`

They ship as `bdsx:ChestBlock::use` / `bdsx:ButtonBlock::use`. Each takes `(BlockType const*, the event&)` and reads the
event's position at `+0x8` and `Player*` at `+0x18` (`layouts.BlockPlayerInteractEvent`, `engine/blockinteract.ts`).
The event carries no face, so the events report 0 there. A cancel skips the handler.

**Executed** (`sblk40`/`sblk51`): simbot's stick on a chest fires `chestOpen`, and on a stone button fires `buttonPress`,
on both builds.
- On 51 a cancelled press leaves the button up, and an allowed one presses it at once.
- On 40 the button never read pressed, even with no hook installed (`sblknb40`). **Resolved 2026-09-24:** the readout
  was broken, not the press. On 40, `testforblock ... ["button_pressed_bit"=true]` and `...=false` are both false for a
  button `setblock` has just placed pressed. `btnprobe` compares `Block*` permutations instead (one interned `Block` per
  state). On both builds, simbot's allowed press leaves the pressed permutation and the cancelled one does not
  (`sbtn40`/`sbtn51`). The cancel is confirmed on both builds.
- What a cancelled `chestOpen` prevents can't be seen without a client's container UI.

`blockInteractedWith` (`VanillaServerGameplayEventListener::onBlockInteractedWith`) is not done. It is a
gameplay-event listener, not one of these handlers.

**`isInRaid`, both sides** (2026-09-24). A simulated player can do what the bot couldn't. Simbot with Bad Omen in the
staged village starts a raid on both builds (`sraid40`/`sraid51`: pillagers arrive, and eventually kill simbot).
- On 40, bdsx's `isInRaid` (the binary) reads false before and true during, for simbot and the bot. bdsx's own
  engine function (`engine/village.ts`) agrees with it every time.
- On 51, where it is inlined, that engine function is now the `derived()`, and it reads false before and true during.
- The derived releases the `weak_ptr`'s weak count itself, as the engine does.
- Layouts: `Dimension.villageManager` (40 `+0x5e0`, 51 `+0x3e0`), `VillageManager.getVillageSlot` 1, `Village.raid`
  `+0x348`.

A first 51 run showed only false. `effect simbot bad_omen` had found no simbot (it was gone by then), so no raid started.

**`blockInteractedWith`, where it stands** (2026-09-24). 2024's `VanillaServerGameplayEventListener::onBlockInteractedWith`
(`0x170b40`, reached only through the listener's vftable) takes the block at the position and compares its name hash
with fixed constants. The first is `0xD90A34053A7858E3`, `minecraft:chemistry_table`: an Education Edition check. In
1.26 that immediate appears only in the big static initializer (40 `0x29ae4b0`), where a `HashedString` of the name is
built. So 1.26's listener compares against a stored value, and it is not found yet.
Followed one step further: the initializer puts the name into a collection held by global `0xc96ae20`. That global's
readers are the initializer, `0x1eca460` (63 KB), `0x2984740` (6 KB, allocation code) and `0x2865e70` (332 B, a
membership test). The membership test is called from `0x8790ec0` (7.4 KB) and `0x32e18e0` (229 KB). None of these is
referenced by a vftable, so the listener has not surfaced. Next: find the `ServerGameplayEventListener` vftable
(a listener registered with the gameplay event coordinator) and walk its slots for the `(Player&, BlockPos const&)`
handler.

### `blockInteractedWith`: the listener found, the sender is a client packet (2026-09-24)

**Static, two routes, both builds.**
1. **The listener's table.** 2024's `VanillaGameModuleServer` constructor allocates the listener (0x20 bytes) and
   stores four sub-object vptrs at +0/+8/+0x10/+0x18: the Actor, Block, Player and Level event-listener dispatchers.
   A scan for that store shape with any registers (`lea reg,[rip+T]; mov [base+d],reg` four times) finds it at 2024
   `0x1469df`, and on 1.26 at 40 `0xb494e` / 51 `0xb4f66`. The second table there is 40 `0xa63a040` / 51 `0xa75cd50`.
   Its real slots are 1, 8 and 12, and every other slot is one shared stub. 2024's block table had 1, 7 and 11: one
   virtual was inserted after slot 1.
2. **The body.** Slot 8 (40 `0x17ea6d0` / 51 `0x18e3970`) takes the player's dimension (`+0x1c8`), then its
   `BlockSource`, `getBlock(r8)`, and the block's legacy name hash (`+0x68` → `+0xe0`). It binary-searches that hash
   over 47 64-bit constants, the same set on both builds. 25 of them are 25 of the 26 in 2024's
   `onBlockInteractedWith`; the missing one is `chemistry_table`, now a stored value (above). It returns 1 in `eax`.

2024's decorated name and prototype ship unchanged (`data/resolved-<v>.json`).

**Executed: the hook installs, and nothing fires it** (`sbiw40`/`sbiw51`, a `blockInteractedWith` listener added to
`simact`). Both sessions run clean, but simbot's chest and button uses never reach the listener. The reasons:
- In 2024 the only sender is a `std::function` lambda built by `ItemUseInventoryTransaction::handle`, which is a
  client's item-use packet.
- 1.26's handler is 40 `0x2591460` (it logs `"ItemUseInventoryTransaction::handle - InventoryTransactionEr..."`).
- The block dispatcher `onEvent(BlockNotificationEvent)` (slot 12) calls only slots 13-29.

A simulated player calls `GameMode` directly and never builds that transaction, so firing waits for a client (Q7).
The 2024 functor thunk (`mov r8,[rcx+0x10]; mov rdx,[rcx+8]; ... jmp [rax+0x38]`) has no `+0x40` twin on 1.26. The
1.26 sender was not located inside the handler's lambdas.

### SimulatedPlayer movement: nine more actions through the GameTest bindings (2026-09-29)

The route above gives the rest. Every GameTest method literal sits in the registration function (40 `0x568cda0`, 51
`0x90eef80`) right after a `lea` of its binding, and each binding makes one call into the SimulatedPlayer code (40
`0x12d....`, 51 `0x11f....`). A script did the mapping for the literals whose 2024 `ScriptSimulatedPlayer` method called
a `simulate*`. It found `attackEntity` → `0x12d5600` (40) / `0x11f76b0` (51), the known `simulateAttack`, which checks it:

| 2024 method → callee | 40 | 51 |
|---|---|---|
| `lookAtEntity` → `simulateLookAt(Actor&, LookDuration)` | `0x12d6ba0` | `0x11f8c40` |
| `lookAtBlock` → `simulateLookAt(BlockPos const&, …)` | `0x12d6c90` | `0x11f8d30` |
| `lookAtLocation` → `simulateLookAt(Vec3 const&, …)` | `0x12d6850` | `0x11f88f0` |
| `moveToLocation` → `simulateMoveToLocation` | `0x12d47a0` | `0x11f6990` |
| `navigateToLocations` → `simulateNavigateToLocations` | `0x12d4c30` | `0x11f6e20` |
| `moveRelative` → `simulateLocalMove` | `0x12d45f0` | `0x11f67e0` |
| `setBodyRotation` → `simulateSetBodyRotation` | `0x12d4ff0` | `0x11f7180` |
| `stopMoving` → `simulateStopMoving` | `0x12d5190` | `0x11f5c50` |
| `useItemInSlotOnBlock` → `simulateUseItemInSlotOnBlock` | `0x12d5cc0` | `0x11f7d60` |

Each pair is the same size on 40 and 51, and each reads its prototype's argument registers. `stopMoving` is 2024's
`MovementIntent::finalize` plus the variant reset, inlined: a switch on the intent index at +0xf30, then the reset.
Three are not done:
- `stopBreakingBlock` → `0x12d5ef0` / `0x11f7f90` is known, but nothing observable came out of calling it, so it is a
  candidate only and not shipped.
- `interactWithEntity`/`Block` and `setItem` have bindings that call elsewhere (`0x1bb2b50`, item helpers), so the
  `simulate*` bodies are inlined.
- `disconnect` stays inlined, as before.

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/smove40.ps1 tools/host/drivers/smove51.ps1`,
`block-probe.ts` `simmove` on a simbot that bdsx created, **10 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit
correctly`; `work/host-runs/smove40-20260929-154133.txt`, `smove51-...`):
- **Rotation**: `setBodyRotation(90)` / `(-45)` read back from `getRotation().y` at once. Looking at a point 5 blocks east
  gave yaw -90.00, at a block 5 blocks west 83.66, and at a pig the pig's direction to within 0.01°, each within 3 ticks.
- **Movement**: `simulateLocalMove(forward, 1)` moved 3.84 blocks in 20 ticks, and after `simulateStopMoving` the
  position did not change. `simulateMoveToLocation` ended 0.05 blocks from its target in 60 ticks, and
  `simulateNavigateToLocations` ended 0.31 blocks from its point in 140 ticks.
- **Placing**: `simulateUseItemInSlotOnBlock(0, floor, up)` with dirt in slot 0 returned true, and the dirt was there.

Two earlier runs failed on the driver, not on these functions. On 51 `tp simbot` found no target, so the driver now uses
`@a[name=simbot]`. On both builds zombies killed simbot partway through (the `sigprobe` knockback lines), so the driver
now runs in `difficulty peaceful` and resets to normal at the end.

### SimulatedPlayer: the five that were inlined (2026-09-30)

`simulateDisconnect`, both `simulateInteract` overloads, `simulateSetItem` and `simulateStopDestroyingBlock` have no out-of-line
function on 1.26 (2024 had all five). Each is now `derived()` over what the GameTest binding calls (`engine/simulatedplayer.ts`,
`implements.ts`). The bindings were found as in the two sections above: `tools/lea-sites.mjs <v> <literal>` gives the `lea` of a
method-name literal in the registration function (40 `0x568cda0`, 51 `0x90eef80`), and the `lea` just before it is the binding.

| name | binding 40 / 51 | what it is |
|---|---|---|
| `simulateInteract(Actor&)` | `0x56a5b50` / `0x9108310` | the alive virtual (slot 46 = `?isAlive@Mob@@`), then `bdsx:Player::interact` with `Vec3::ZERO`, bit 0 of the sret |
| `simulateInteract(BlockPos, facing)` | `0x56a8ff0` / `0x910b820` | alive, then `BlockSource::getBlock(pos)` (vftable +0x10) and `bdsx:Block::use(Block, player, &pos, face, [51: a zero byte,] &disengaged optional<Vec3>)`, the low byte of eax |
| `simulateSetItem` | `0x56a6650` / `0x9108d90` | the container's `setItem` (vftable +0x60), `getItem(slot).matches(item)` (2024's `matches`: count, then `matchesItem`), `setSelectedSlot` when asked |
| `simulateStopDestroyingBlock` | `0x56a60b0` / `0x9108830` | see below |
| `simulateDisconnect` | `0x56a68d0` / `0x9108fe0` | the helper 40 `0x6952f0` / 51 `0x7589e0` (`bdsx:ServerPlayer::disconnect`), `Player::remove` (vftable +0x58, slot 11), then a member reset |

**`0x1bb2b50` (51 `0x2ceb030`) is `Block::use`, not `ItemStack::useOn`.** `bdsx:ItemStack::useOn` was named after `useItemOn` calling it
(the "itemUseOnBlock" section). Two routes say otherwise: `GameMode::useItemOn` loads the `Block*` it compares by `+0x68`
(BlockLegacy) and `+0xe0` (hash) from its frame and passes it in rcx (`0x1f38d1f`, 40); and the interactWithBlock binding passes
`BlockSource::getBlock`'s result there, as 2024's `simulateInteract(BlockPos)` did around `Block::use` (`0xcd5b70` -> `0x1bbc3d0`).
The body's first reads are `Block+0x68` (`layouts.Block.blockLegacy`) and the block-component tables at `BlockLegacy+0x338`. It also
explains why a cancel through that hook never stopped a placement: it is the block-use step, and a `false` lets the item place. The key
is now `bdsx:Block::use`; `layouts.ItemStack.useOnExtraBool` moved to `layouts.Block.useExtraByte` (40: 0, 51: 1). The earlier
"no out-of-line `Block::use`" line in the `chestOpen` section was wrong. (1.26's own `ItemStack::useOn` is not located.)

**`simulateStopDestroyingBlock`** is inlined into its three users (the `stopBreakingBlock` binding, the 907-byte function that reads the same flags, 2024's `preAiStep`, 40 `0x12d25e0`,
`simulateDestroyBlock` 40 `0x12d6660`; 51 `0x11f4620` / `0x11f8700`), identical each time. The `0x12d5ef0` the movement section
took for it is the no-argument `simulateInteract()` (the binding of the `"interact"` literal calls it; it holds both a
`Block::use` and a `Player::interact`). 2024's body plus one addition, all on the SimulatedPlayer (40 / 51):
- a state object at `+0xcb0` (pointer): bytes `+1` and `+8` cleared, the int64 at `+0x10` set to `0xffffffff`, its owned member at
  `+0x20` released through vftable slot 16 / 17 (the deleting destructor, edx 1);
- the byte `+0xb22` cleared;
- when the byte `+0xf74` / `+0xf7c` is 1: if alive, `GameMode::stopDestroyBlock(&pos)` (GameMode vftable slot 4, `+0x20`) with
  the position at `+0xf68` / `+0xf70`, then that byte cleared; the byte `+0xf79` / `+0xf81` is cleared last.
These are `layouts.SimulatedPlayer` (`breakState`, `breakStateDtorSlot`, `blockTask`, `destroying`, `destroyPos`, `destroyActive`).

**`simulateDisconnect`**: 2024's body starts with a PlayerGameplayEvent (variant index 0xa, `PlayerDisconnectEvent`), `removeAllPassengers`
and the callback token's cancel, then `Player::remove` and a reset of a GameTest function pointer. 1.26 moved the first half into
the helper (five callers on each build, `ServerNetworkHandler::_onPlayerLeft` one of them). bdsx calls the helper and `remove`, and
does not carry the reset (a null `shared_ptr` assignment to a GameTest member a bdsx-made player never sets).

**Executed** (`node tools/host/verify-pair.mjs tools/host/drivers/simp40.ps1 tools/host/drivers/simp51.ps1`, `tools/simplayer-probe.ts`
`simp`, around x=-2000 z=2000 in a ticking area; **8 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`;
`work/host-runs/simp40-20260930-115612.txt`, `simp51-20260930-115612.txt`):
- `simulateInteractWithActor`: a simulated player with a bucket next to a cow -> true, the hand becomes a milk bucket.
- `simulateInteractWithBlock`: a lever's interned `Block` permutation goes off -> on -> off across two calls, each true.
- `simulateSetItem`: diamond x3 into slot 4 without selecting -> true, slot 4 holds 3 diamonds, selected slot stays 0; apple x2 into slot 6
  selecting -> true, selected slot 6, the hand is 2 apples.
- `simulateStopDestroyingBlock`: a survival simulated player breaks dirt after 17 ticks (control). Stopped on tick 3, the `destroying`
  byte reads 1 before and 0 after, and the dirt is still there after 120 ticks.
- `simulateDisconnect`: a second simulated player is in the level's players and matched by `@a` before; 20 ticks after it is in
  neither, and the level ticks on for 40 more ticks.

Two probe lessons. First, **`testforblock ... ["open_bit"=true]` is wrong on 40 for a lever, as it is for a button** ("buttonPress"
above): the first run of `simp iblock` failed on 40 only (both calls true, the state never read open) while 51 passed, and the fault
was the readout. The probe reads the interned `Block` permutation (`getBlock(pos).getAddressBin()`), which agrees on both builds.
Second, `bdsx:Player::interact`'s sret is an `InteractionResult` of unknown size, so the engine code hands it a zeroed 64 bytes.

### Q7 through a simulated player: what the engine itself fires (2026-10-02)

Plan B of the user's 2026-10-02 request to automate the "needs a real client" list (queue items 2 and 4, section Q7): how far a
simulated player (`SimulatedPlayer.create`, the `simulate*` functions above) makes the engine fire each leftover, by execution on
both builds, and the static addresses the main agent's live bot (plan A) needs for the rest. All runs: `node tools/host/verify-pair.mjs
tools/host/drivers/simq740.ps1 tools/host/drivers/simq751.ps1`, `tools/simplayer-probe.ts` `simp ...` with `SIMQ7_PROBE=1` (which
installs bdsx's own `playerJump`, `blockDestructionStart` and `blockPlace` listeners, and so their hooks), **13 PASS / 0 FAIL on each
build**, tsc 0, exit 0, `Quit correctly` (`work/host-runs/simq740-20261002-111814.txt`, `simq751-...`; the first pair, 11:09, had
the same results with the jump step written as a positive assertion, which failed on both builds and led to the split below).

| leftover | result | how |
|---|---|---|
| `blockDestructionStart` | **done, engine-driven, both builds** | survival simbot digs dirt: exactly one event, at the dirt, one tick after `simulateDestroyBlock`, 16 ticks before the break |
| `blockPlace` from the engine | **done, both sides** | `simulateUseItemInSlotOnBlock` with dirt: event for simbot at the new block and the dirt placed; cancelled, no dirt |
| successful `Player::drop` from `dropAllOnDeath` | **done, both sides** | bdsx's own `dropAllOnDeath` on simbot drops every slot (item entities appear); on the headless bot every drop is refused |
| `checkBlockDestroyPermissions` true | **done, both sides** | simbot in survival `true`, in adventure `false`; the headless bot `false` in every mode |
| `playerJump` | **hook ships and runs; a simulated jump cannot reach it** | `simulateJump` is a real jump but never makes the jump-effects system run; a direct call through bdsx's hook gives the right player and the right exhaustion |
| `blockInteractedWith` | **not reachable by a simulated player** | the 1.26 sender is located (below); only a client's item-use transaction builds it |
| `playerDropItem` hotbar path | **not reachable by a simulated player** | bdsx reads it from a received `InventoryTransactionPacket`; nothing server-side dispatches one |

**`blockDestructionStart`.** 2024's `BlockEventCoordinator::sendBlockDestructionStarted` (`0x18b6ca0`) had two callers:
`ServerNetworkHandler::handle(PlayerActionPacket)` and `ServerPlayerBlockUseHandler::onStartDestroyBlock` (`0x8d8030`), and the
latter's callers included `SimulatedPlayer::preAiStep` -- so the "only from the client's PlayerActionPacket" line in the
`attackBlock` section above was incomplete. On 1.26 the send's lambda scope reads
`?sendBlockDestructionStarted@BlockEventCoordinator@@QEAAXAEAVPlayer@@AEBVBlockPos@@AEBVBlock@@EH@Z` (one more int), and
`tools/lambda-owner.mjs` finds one builder: 40 `0xaa2ad0` / 51 `0x13e4ec0` (1049 B each, identical but for one vtable offset).
That is 2024's `onStartDestroyBlock` step for step (the dimension's `BlockSource`, a player flag byte, `getBlock`; with the flag
clear the level's `+0x3f0` and the block type's attack virtual `+0x288`; the coordinator send, `processEvent` 40 `0x1281fa0` / 51
`0x11ab220`, unconditional; unless creative `getDestroyRate` -> level event `0xe10`; the range check and `GameMode` slot 1), with
the send inlined. Its callers are 2024's minus the packet handler (1.26's `handle(PlayerActionPacket)` builds no such lambda):
`onBeforeMovementSimulation` (40 `0xaa3290` / 51 `0x13e5680`, the client's auth-input block actions) and SimulatedPlayer's
`preAiStep` (40 `0x12d25e0` / 51 `0x11f4620`), which calls it on the first tick of a dig (`+0xb22` 0 -> 1) and
`serverTickBlockBreaking` (40 `0xaa27c0` / 51 `0x13e4bb0`) after. It ships under 2024's decoration
`?onStartDestroyBlock@ServerPlayerBlockUseHandler@@YAXAEAVServerPlayer@@AEBVBlockPos@@H@Z` (the body reads rcx, rdx, r8d), and
bdsx's `blockDestructionStart` hooks it at entry when the 2024 send is absent. **Executed**: `simp bds` -- `simulateDestroyBlock ->
true`, one event `simbot@-2000,68,2001` the next tick, the dirt broken 17 ticks after the start, no second event on the 16
`serverTickBlockBreaking` ticks. For plan A: a real client's dig reaches the same function through `onBeforeMovementSimulation`.

**`blockPlace` from the engine** (`simp place`). simbot's engine placement goes through `?mayPlace@BlockSource@@` (40 `0x14f7e10` /
51 `0x15f8040`, the hook `place40/51` confirmed by a direct call in 2026-09). Allowed: `simulateUseItemInSlotOnBlock(0, floor, up)
-> true`, one event for simbot, `minecraft:dirt` at the placed position, and the dirt is there. Cancelled: one event, marked
cancelled, and no dirt (the engine honours `mayPlace`'s false; `simulateUseItemInSlotOnBlock` still returns true, its own bool
not the placement's).

**`Player::drop` from `dropAllOnDeath`** (`simp dropall`, `simp dropall bot`). bdsx's own `PlayerInventory::dropAllOnDeath` (a
`derived()`, `findings-containers.md` "dropAllOnDeath") clears a slot only when `Player::drop` returns true. On simbot (health 20,
ability 2 true) apples x5 and a diamond sword go to `(empty)` and item entities appear: every drop succeeded. On the headless bot
(ability 2 false, the loading-screen layer) the same call leaves both slots and no item entity: the refusing side. That is the
"successful `Player::drop` from `dropAllOnDeath`" `findings-containers.md` recorded as not achieved.

**`checkBlockDestroyPermissions` true** (`simp cbdp`). Reading 1.26's body (`findings-blocks.md` 11) to the end: outside adventure
the allow bit stays set, and the answer is `Actor::canUseAbility(Mine)` and not the block's unbreakable flag. In adventure it is
`PrivilegedBuilder`, then the item's `can_destroy` only with the world's adventure overrides on. So the true side needs a player
whose abilities are real, not the overrides. simbot on dirt, empty hand, flag false: survival `true`, adventure `false`, creative
`true` (info); the headless bot `false` in all three (its abilities are all false, which was the whole of section 10's "always
false").

**`playerJump`: 1.26 moved `handleJumpEffects` into an ECS system.** 2024's `Player::handleJumpEffects` (`0x19dfe10`) skips on the
client, looks up `ExhaustionComponent`, takes its sprint-jump value when status flag 3 (sprinting) is up and its jump value
otherwise, calls `causeFoodExhaustion`, and stores `MobJump`'s start position. Its only caller was the `PlayerActionPacket`
handler's StartJump case; 2024's `simulateJump` never called it. On 1.26:
- the `PlayerActionPacket` handler (40 `0xa90330` / 51 `0x9a2f20`) switches on the action at `+0x4c` through a 35-entry table,
  and case 8 (StartJump) goes to the exit on both builds;
- no function holds both the `ExhaustionComponent` and `MobJumpComponent` hashes; the exhaustion is a system registered next to
  the literal `"JumpExhaustion"` (lea 40 `0x8370cf5` / 51 `0x18f0635`; system vftable 40 `0xa7f3130` / 51 `0xa92a000`, slot 5 the
  tick 40 `0x838cdb0` / 51 `0x8425ea0`), whose view (40 `0x838c980` / 51 `0x8425ac0`) is over `ActorDataFlag`-, `ActorGameType`-,
  `Exhaustion`-, `TriggerJumpRequest`- and `PlayerComponent`;
- the tick hands each entity to one function, 40 `0x8370b30` / 51 `0x8407f40` (274 B, identical instruction for instruction, the
  tick's lea the only reference): `(EntityId const*, ActorDataFlagComponent const*, ActorGameTypeComponent const*,
  ExhaustionComponent const*, context*, int const* worldDefaultGameType)`. It returns for game type 1 (or 5 with a creative
  default), else pushes `ExhaustionComponent+4` (`+8` when flag bit 3 is up) as an add to the exhaustion attribute onto the
  entity's `AttributeRequestComponent` in `*(context)+0x30`. That is `handleJumpEffects`'s exhaustion half.

It ships as `bdsx:JumpExhaustionSystem::_tickEntity`. bdsx's `playerJump` hooks it when `handleJumpEffects` is absent and resolves
the player from the id through `ActorOwnerComponent` in the context's `EntityRegistry` (`engine/jump.ts`, `enttActorIn`).
**Executed**:
- `simp jump` / `simp jump sprint`: `simulateJump -> true` and simbot's feet go 68.00 -> 69.25, but no `playerJump` and the
  exhaustion stays 0.0000 (the component's jump value is 0.05, sprint jump 0.20), sprinting or not; 40 quiet ticks after, nothing
  either. The simulated jump never makes the system run: `simulateJump` (40 `0x12d3e60`) sets `JumpControlComponent`'s byte,
  emplaces `JumpFromGroundRequestComponent` (through 40 `0x2401fd0`) and sets the no-jump delay to 10, and never touches
  `TriggerJumpRequestComponent`, which `TriggerJumpSystem` (lea 40 `0x2788737` / 51 `0x18f23a6`; per-entity 40 `0x27a3dd0` / 51
  `0x5eef5b0`, 1407 B) emplaces from the input bit set the player's auth input fills.
- `simp jumpcall [sprint|creative]`: the function called through bdsx's hook with simbot's id, its own `ExhaustionComponent`, a
  context holding its `EntityRegistry` and the flag dword and game type chosen. The hook names simbot exactly once each time, and
  the exhaustion moves by 0.0500 (plain), 0.2000 (sprint bit) and 0.0000 (game type 1): the prototype, the stack arguments, the
  player lookup and the body's three branches all as read.

So `playerJump` is shipped and proven by a direct call (as `blockPlace` was in 2026-09), and what is left is a real jump reaching
it. For plan A: a client's StartJumping input should go `TriggerJumpSystem` -> `TriggerJumpRequestComponent` -> this function;
watch `[simp]`-style for `playerJump` naming the bot, or count calls at 40 `0x8370b30` / 51 `0x8407f40`
(`tools/host/make-probes.mjs`). If a real jump does not fire it, the next suspect is `JumpInputSystem` (lea 40 `0x8370f65` / 51
`0x18ecb27`), not the hook.

**`blockInteractedWith`: the 1.26 sender, and why a simulated player cannot reach it.** The listener (slot 8, 40 `0x17ea6d0` / 51
`0x18e3970`) is fed by `BlockEventCoordinator::sendBlockInteractedWith`, whose lambda (`<lambda_16>`, `_Func_impl` 40 `0xa6b3ee0` /
51 `0xa7ddcd0`) has one builder: 40 `0x25a9d10` / 51 `0x2a87fa0` (91 B) -- slot 23 of a 25-slot vftable (40 `0xa693a80` / 51
`0xa7cb5a0`) that only `ItemUseInventoryTransaction::handle` (40 `0x2591460` / 51 `0x2a6c4a0`, slot 4 of the transaction's own
vftable 40 `0xa667e80` / 51 `0xa7cfd30`) stores, into a local "item-use transaction subject" wrapping the player (`+8`). Slot 23
takes the level's block event coordinator (level `+0x620`) and runs `processEvent` with `(player, pos)`. It is called from the
transaction's use-on-block step: 40 `<lambda_41>`'s `_Do_call` `0x25ada00`, the call at `0x25adf62`; 51 `0x2a880f0` (a plain
function pointer now), the call at `0x2a883a0`. Both run, in order: subject slot 15 (`GameMode::useItemOn` through the player's
`+0xaa0`), and only if its result's bit 0 is set, the item-mismatch resend, subject slot 22 (a byte at player `+0xaa0` -> `+0x42`),
then slot 23. A simulated player calls `GameMode::useItemOn` and `Block::use` directly (`simulateUseItemOnBlock`,
`simulateInteract(BlockPos)`); nothing in the SimulatedPlayer code or the GameTest bindings constructs an
`ItemUseInventoryTransaction` (its vftable's 17 store sites on 40 are none of them), so the send never follows. One store site is
`GameMode` slot 6 (2024's `buildBlock`, 40 `0x1f36b50`), which GameTest's `startBuild` may reach: it builds the record a client
sends (sent only when the level is client-side), and neither it nor its lambda (40 `0x1f477b0`) calls through the transaction's
`handle` slot (`+0x20`). The 2026-09-24
`sbiw40/51` sessions saw exactly that. For plan A: the bot's item-use-on-block `InventoryTransaction` (or the auth-input
`_forwardTransaction` path) reaches `handle`; the shipped listener hook is the event, the call sites above are where to count.

**`playerDropItem`'s hotbar path** (static). bdsx raises it from `events.packetBefore(InventoryTransaction)`, which is the packet
dispatcher's `handle` slot (bdsx swaps the dispatcher vptr, `findings-packets.md` 2) and runs only for a packet received from a
connection. A simulated player has none: the GameTest `"dropSelectedItem"` binding calls the player's `drop` virtual directly
(above), and the twelve functions that store `??_7InventoryTransactionPacket@@6B@` on each build (40 `0xa55cf40`, 51 `0xa67c470`) are
outside the SimulatedPlayer and GameTest code. Emulating a client packet from the server side is out of scope (plan A's bot sends the
real one).
