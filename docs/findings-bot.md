# The headless bot as a real client (2026-09-24)

`tools/probe-client.cjs` is the headless Bedrock client every `run-client-probe.ps1` driver starts. Until this
day it was an idle protocol peer: it joined, chatted and answered forms, but on 1.26 the server never took
its attacks, it took no damage ("Could not apply damage"), and one synthetic `player_auth_input` dropped the
connection within 0.5 s on both builds (`findings-packets.md` section 10). Those were the reasons half of Q2
and Q7 waited for a human. The user pointed at Geyser (a Bedrock-to-Java proxy that works with 1.26.51
clients) as a reference for what bedrock-protocol gets wrong.

## 1. What Geyser gives, and what it does not

Geyser (MIT) and its packet library, CloudburstMC/Protocol (Apache-2.0, the same licence as Endstone), are
open source, so nothing needs to be reverse-engineered. Shallow clone: `work/cloudburst-protocol`
(HEAD `b15b7e0`, 2026-09-20). It already has a codec for each build: `Bedrock_v2168` (1.26.40.8) and
`Bedrock_v2193` (1.26.50/51).

Geyser is a **server** to Bedrock clients. Its codec therefore reads client packets exactly as a real client
writes them (the wire format). It says nothing about the client's **behaviour**: which packets a client
sends, in what order and how often. Geyser only receives those packets.

## 2. Wire format: two bugs, both on the bot's side

Compared field by field against minecraft-data (`work/mcdata`, sparse clone, HEAD `8ffb321`):

- **1.26.51, the old bot fed the 1.26.45 schema** (PR-804 install, `BP_VERSION=1.26.45`). `v2193` changed
  exactly the two packets the bot had trouble with. `PlayerAuthInput` lost one presence bool per optional
  field (`PlayerAuthInputSerializer_v2193`). `InventoryTransaction` lost the presence bools in front of
  `transaction_type` and `actions`, and its item-use data gained a `hand` byte after `hotbar_slot`
  (`InventoryTransactionSerializer_v2193`). The first change applies to every transaction, including the
  bot's `item_use_on_entity` attack. That explains the `packet_violation_warning` answer to the attack on 51.
- **1.26.40, the schema was right, and the bot filled it wrong.** minecraft-data's 1.26.40 layout matches
  `PlayerAuthInputSerializer_v2168`, and the `InputData` ids 0-65 are identical. But `_v2168` writes an extra
  presence bool before `input_data` and each of the five optional sub-structures, **always as true**, and its
  reader short-circuits: `if (buffer.readBoolean() && buffer.readBoolean())`. minecraft-data models this as an
  independent `*_presence: bool` followed by an `option`. The old bot sent `presence: false` plus an absent
  option (`00 00`), so the server read one byte too many for each of the five fields.

bedrock-protocol **3.60.1** (npm, 2026-09-22) has `CURRENT_VERSION = '1.26.51'`, with minecraft-data 3.117.0.
Its 1.26.51 `player_auth_input` and `Transaction` (no presence bools; `hand` in item-use) match `v2193`. Encoding checked
locally with that version's own serializer (scratchpad, not committed):

```
1.26.40 player_auth_input … 01 02 36 10 01 00 02 … d209 … 01 00 01 00 01 00 01 00 01 00 …   (presence true, option absent)
1.26.51 player_auth_input … 02 36 10 01 00 02 … d209 … 00 00 00 00 00 …
both    serverbound_loading_screen  b802 04 00   (id 312, type 2 = END_LOADING_SCREEN, no id)
```

Host install: `C:\bdsx-again\bot-360\node_modules` (bedrock-protocol 3.60.1 + minecraft-data 3.117.0). It serves
**both** builds (`BP_VERSION=1.26.40` / `1.26.51`) with no `BP_PROTOCOL` override. npm warns that one
dependency wants node >= 24 (the host has 20.20.2); nothing failed from it. Regression: `pkn40`/`pkn51`
(the `pk` driver on bot-360, no other change) gave the same 16 PASS / 2 FAIL as before, and on 51 the bot now
sends `inventory_transaction` attacks without being dropped (`work/host-runs/pkn51-20260924-155801.txt`).

## 3. Behaviour: `BP_LIVE=1`

bedrock-protocol never sends two things a real client sends after spawning. With `BP_LIVE=1`, `probe-client.cjs`
sends both:

1. `serverbound_loading_screen` type 1, then type 2 (Cloudburst `ServerboundLoadingScreenSerializer_v712`).
2. `player_auth_input` every 50 ms. The tick starts at `start_game.current_tick` and counts up. The position
   follows `move_player` and `correct_player_move_prediction` (both carry the eye position). After a
   `move_player` teleport or reset, the next packet carries `handled_teleport`. Every `*_presence` is true.

`BP_SNEAK=<ms>[,…]` presses sneak that many ms after spawning and releases it 2 s later. The press sends
`start_sneaking`, `sneak_pressed_raw` once and holds `sneaking`, `sneak_down`, `sneak_current_raw`. The
release sends `stop_sneaking`, `sneak_released_raw`. The old `BP_AUTH_INPUT=1` now means `BP_LIVE=1 BP_SNEAK=20000`.

The server answers the stream normally. `start_game` reports `rewind_history_size` 40 and server-authoritative
block breaking on both builds. `correct_player_move_prediction` arrives a few times per session (at spawn,
after `tp`, when pushed), and the connection stays up for the whole session.

## 4. Confirmed by execution (both builds, bdsx's own code)

Drivers `live40`/`live51` (the `pk` command list plus `damage` and a zombie, `BP_LIVE=1 BP_SNEAK=20000`):

| check | 1.26.40.8 | 1.26.51.1 |
|---|---|---|
| pktprobe (with `authinput-bits`, `entitySneak`) | 18/18 PASS | 18/18 PASS |
| `getInput()` on the bot's packets | `start+sneaking, sneaking ×30, stop` | same |
| `events.entitySneak` | `true,false` | `true,false` |
| `damage @a 2` | `Applied damage to bdsxprobe` | same |
| mobs damage the bot | killed by a zombie, knocked back by it | killed by a zombie |

Transcripts: `work/host-runs/live40-20260924-160735.txt`, `live51-20260924-160735.txt`, and the final code
`live40-20260924-162901.txt`, `live51-20260924-162901.txt`. Bot logs: `work/host-runs/bot360/`. This fits
the old guess that the loading screen was protecting the bot, but it does not prove it: `damage` was not run
on bot-360 with `BP_LIVE` off. That one-command A/B would show which of the two changes did it.

## 5. Attacks: not reliable yet

The bot still attacks with `inventory_transaction` / `item_use_on_entity` (fist, `held_item` air) every 1.5 s at
every zombie/pig/cow/sheep/chicken it is told about.

- **Landed** on 1.26.40.8 in two sessions (`live40-20260924-160735`, `atk40-20260924-161154`): the zombie
  took `damage 1 cause 2` (EntityAttack), and there was `entityKnockback target minecraft:zombie source
  minecraft:player`. In both sessions the zombie was at or next to the bot, and the rotation was 0/0.
- **Did not land** anywhere else. Pigs placed around the bot (±1.5 blocks) and on it, with and without aiming,
  took 0 hits on both builds (`atkp*`), and `events.playerAttack` (`SIG_EVENTS=attack`) never fired. The zombie
  took 0 hits in the final `live40/51`, and in `atk40` after aiming was added. On 51 a single
  `zombie damage 1 cause 2` appears in `atk51` at the same point twice, with no knockback from the player and no
  `playerAttack`. It is not counted as the bot's hit.
- Aiming (`BP_AIM=1`: face the target's centre for a tick, attack only within 3.5 blocks, `camera_orientation` =
  the look vector) did not help, so it is off by default.

In the sessions that had `SIG_EVENTS=attack` on, no attack landed and bdsx's `bdsx:Actor::attack` hook saw
nothing, so the server drops the attack before `Player::attack`. The two sessions where hits landed did not
have the hook on, so whether `playerAttack` fires on a landed hit is still open. Where the server drops the
attack is the next thing to find. Candidates: the attack path's validation of `player_pos`/`click_pos`
(Cloudburst's `InventoryTransactionSerializer_v2193.writeItemUseOnEntity` for the exact fields); a real
client's `missed_swing`/`PERFORM_ITEM_INTERACTION` in the auth-input stream around the swing; the server's
rewind check against the tick the attack names. Mob AI makes zombie runs noisy. A pig in a fenced cell, or an
armor stand, gives a still target.

## 6. What this opens

**Superseded (user, 2026-10-02):** the user reversed the 2026-09-24 deferral and asked for Q7 to be automated. The bot
is now a test harness the probe drives (sections 7-10). This section is kept as the plan it started from.

Events that only a client's packets drive can now be tried with the bot, with no human (the Q7 list):
`playerJump` (`start_jumping`/`jumping` in the auth-input stream), `blockDestructionStart` (`PERFORM_BLOCK_ACTIONS`
with `start_break`, since block breaking is server-authoritative), `blockInteractedWith` (item-use transaction
`click_block`), and `playerDropItem`'s hotbar path (`InventoryTransaction` drop). Attacks and critical hits come
after section 5 is solved. Field order for each: Cloudburst `v2168`/`v2193` serializers. Fill only the
minecraft-data fields that the Cloudburst writer also writes.

## 7. The harness: a client the probe drives (2026-10-02)

The user (2026-10-02) asked for the client-packet list (Q7) to be automated instead of played by hand. The bot became a test
harness in two files, `tools/livebot.cjs` (the client) and `tools/livebot-probe.ts` (deployed as `zz-lbprobe.ts`, console `lb`),
run by the drivers `lb40`/`lb51`. Since the same day every other driver runs it too (below); `tools/probe-client.cjs` stays
only until the re-run sample passes. A new client-driven check is a scenario in the probe, not a new environment variable.

**Wiring.**
- The probe listens on `127.0.0.1:$LB_PORT`. The driver's `-Env` reaches both the server and the bot (40 uses 19150, 51 uses 19152).
  The bot connects after it spawns. Messages are JSON lines: `{id, op, ...}` gets `{id, ok, ...}` back, and the bot also sends
  unsolicited `{ev, ...}` lines for what the client saw (correction, teleport, container_open/close, update_block, item_entity,
  form, text, stack_response).
- Ops: `state`, `ground`, `look`, `lookAt`, `walk`, `move`, `jump`, `sneak`, `sprint`, `flags`, `swing`, `attack` (also
  `action: "interact"`), `useItemOn`, `useItem`, `release`, `blockActions`, `breakBlock`, `select`, `drop`, `stackRequest`,
  `stackDrop`, `closeContainer`, `chat`, `command`, `form`, `block`, `raw`, `wait`.
- Until 2026-10-02 bdsx on 1.26 never pumped node's event loop while the server ran. The 2024 `update-hook` patches a
  call inside a lambda that 1.26 inlined into `_Invoke`, so sockets and timers only ran at shutdown (`findings-slots.md`
  "Timers", `findings-packets.md` "Seen on the way"). The probe therefore pumps the loop from `events.levelTick` with
  `cgate.nodeLoopOnce`, a non-blocking `uv_run` that bdsx itself calls at serverOpen. It still does this, so that the
  harness does not depend on the fix below.
- **The bdsx-wide fix** (bdsx `d6a8de04`, 2026-10-02). The sleep the 2024 hook replaced is inlined, and it sits at `_Invoke + 0xfd8`
  on **both** builds with identical bytes: `4c89f8 4829d0 4d89fc 483d88130000 0f8c46f4ffff` (40 `0x6af988`, 51
  `0x7720f8`). That is `mov rax,r15; sub rax,rdx; mov r12,r15; cmp rax,1388h; jl <loop top>`, with r15 = the next tick's
  deadline in the steady-clock nanoseconds `nodeLoop` takes. `launcher.ts` now patches a call to a thunk there
  (`mov rcx,r15; jmp updateWithSleep`). Node's loop runs until the deadline. The inlined QPC sleep loop after the patch
  then finds the deadline passed and leaves through the `mov r12,r15` in front of the loop top (40 `0x6aede0`, 51
  `0x771550`), as the `jl` would have. Checked with `lbtimers40/51` (`lbtimers start|check`, run-full, no bot), twice per
  build: a 1 s `setTimeout` fires at 1012-1014 ms, a 250 ms interval runs 7 times in 1.9 s, and the level keeps
  19.6-20.2 ticks a second.
- **What that woke up.** Three of bdsx's stock examples set module-level intervals that had never fired on 1.26.
  `attribute.ts` sets every player's health every 100 ms, which broke `layout`'s health checks (41/0 became 37/4).
  `actor-effects.ts` adds effects every second, and `custommotd.ts` sets the MOTD every 5 s. `tools/host/index-probes.ts`
  now imports the stock examples one by one instead of through `example_and_test/index.ts`. The list is the ones that
  ran before (that index stops at `lowlevel-asm`, which throws at load, so nothing after it ever ran: not `setblock`, not
  `test.ts`'s suite, which waits on a `setTimeout`), minus those three. With that, `layout` is back to 41/0.
- **Running it.** The driver's `-Env` names the scenarios as `LB_RUN = "all"`, or as a space-separated list (`lb40/51` use
  `all`; copy a driver and change only `LB_RUN` and the tag to run one). The probe starts them 3 s after the bot connects,
  with `lb diag` on, so a driver only has to stay up long enough. `lb run <...>` on the console does the same.
- The probe builds an arena at x -3000 z 3000: a stone floor at y 66, air above, and a ticking area. Scenarios are `async`
  steps over `events.levelTick` (`waitTicks`), and every bdsx event is recorded with the tick it fired on. `lb diag on`
  hooks the item-use transaction handlers by RVA and logs the engine's `InventoryTransactionError` for each one (1 = no error,
  2 = BalanceMismatch, 3 = SourceItemMismatch, 7 = StateMismatch). The handlers are `ItemUseOnActor` 40 `0x2596380` / 51
  `0x2a71b60`, `ItemUse` 40 `0x2591460` / 51 `0x2a6c4a0` and `ItemRelease` 40 `0x258e130` / 51 `0x2a69040`, each found
  through a log string it `lea`s. It also hooks any other transaction type's handle, which is slot 4 of the transaction's
  own vftable (40 `0xa667eb0` / `0xa667e80` / `0xa55d990` hold the three above there), from its first packet.
- `node tools/livebot.cjs --selftest`, run with NODE_PATH pointing at a bedrock-protocol 3.60.1 install, encodes and decodes
  every packet the ops build, against both builds' schemas.
- **One client for every driver.** `livebot.cjs` also reads `probe-client.cjs`'s environment: `BP_SNEAK`, `BP_CHAT`,
  `BP_COMMAND`, `BP_FORM_REPLY`, `BP_LEAVE_AFTER_START`, `BP_SPOOF`, `BP_PROTOCOL`, the login extras, and its packet logs.
  Two defaults differ. The client is live unless `BP_LIVE=0`, where the old one was idle unless `BP_LIVE=1`. The old
  default auto-attack is opt-in as `BP_AUTO_ATTACK=1`, and it now aims. `livel40/51` is `live40/51` with only the `-Bot`
  path and `BP_AUTO_ATTACK=1` changed. It gave the same 18/18 `pktprobe` (authinput bits, `entitySneak`, chat cancels,
  forms) on both builds, and `sigprobe`'s `playerAttack` now fires 4 times on the zombie, where the old bot's
  attacks did not land (section 5).
- **Every driver moved** (2026-10-02, queue 2). A one-shot rewrite of the 365 `-Bot ...probe-client.cjs` drivers and the
  23 join loops: `-Bot` to `livebot.cjs`, `-BotModules` to `bot-360` (297 were on the older `bot`/`bot-pr804` installs),
  `BP_VERSION` to the instance's build (171 inst51 drivers had `1.26.45` + `BP_PROTOCOL=2193`), `BP_LIVE = "0"` where the driver
  had no `BP_LIVE` (347: the idle peer they were written against), `BP_AUTO_ATTACK = "1"` where it had no `BP_NO_ATTACK`
  (10), `BP_NO_ATTACK`/`BP_PROTOCOL` dropped. The runners' defaults moved with them. `livebot.cjs` gained the old
  `chunk_count` line every 2 s (`actor-layout-probe.ts`'s `chunks` step reads its burst). `live40/51` became identical to
  `livel40/51`, which were deleted. Re-run on both builds after the move: `lb` 36/0, `layout` 41/0 (the same as before), `pktprobe` 16/2 (the same two idle-bot FAILs as before); `sig` ran clean, but the grep dropped its `[sigprobe]` event lines. **The sample, 2026-10-02 (done).** `tools/host/botmove-sample.sh` re-ran 14 driver pairs on both builds: `sig`, `abil`, `login`,
  `origin`, `atk`, `item`, `score`, `simq7`, `a1misc`, `kick`, `chestev`, `skin`, `q2drop` and `piston`. Counted from each session's full host
  output, every bdsx session had 0 FAIL and `Quit correctly`: 23/77/24/24/27/84/46/36/39/25/28/44/23 PASS on each build.
  `piston` runs the reach-probe launcher, which prints no PASS lines and never printed `Quit correctly`, before or after.
  The `jlmig40/51` join loops gave 3/3. Compared check by check (`botmove-compare.mjs`) with the newest run before the move,
  no check went from PASS to FAIL. The added lines come from the sample's wider grep. Three differences were looked into:
  - `atk`'s old `[layout] atkprobe` lines came from a different driver that once used the same tag.
  - `item40`'s `damage` FAIL (the summoned zombie had walked out of the `r=6` tag radius) did not recur: the rerun was 84/0.
  - The `item` transcripts had stopped at line 120, because `peek.ps1` capped its output with `-First 120`. The cap also
    hid that FAIL from `verify-pair.mjs`'s count. `peek.ps1` now prints every FAIL and marker line past the cap, after a
    note that counts the cut lines (`findings-host-parallel.md`).

  `probe-client.cjs` is deleted, along with its upload in `session.mjs`.

## 8. What a 1.26 client sends, and what the engine checks

Bytes come from the Cloudburst serializers, meaning from Geyser's translators, and the checks from the engine's own handlers.
The bot now does each of these the way a client does.

- **20 auth inputs a second.** On Windows' timer grid, `setInterval(50)` ran at about 16 Hz, so the old bot's client tick fell
  behind the server's. The loop now sends however many ticks are due on each wake-up.
- **Physics.** Gravity 0.08, drag 0.98, jump 0.42, ground friction 0.546 and walk speed 0.1 (the `minecraft:movement`
  attribute), applied in Java's order. The bot sets `vertical_collision` while standing, adopts every correction and
  `set_entity_motion`, and acknowledges teleports. The server simulates the same inputs and agrees with them: a 20-tick walk
  ends 0.01-0.03 blocks from the bot's own position, and a jump rises 1.25 blocks, with no correction either time.
- **`update_attributes` carries `current`, not `value`.** Reading `value` left the movement speed undefined, and every
  position after the first walk became NaN. The physics now resets to the last good state if it ever produces a non-number.
- **Attack.** The bot faces the target's middle for one tick and sends an `animate` swing. In 1.26 that packet has `data` and
  `swing_source: "attack"`. Then it sends `item_use_on_entity` `attack` with the held item, the hotbar slot and the eye position.
  `ItemUseOnActorInventoryTransaction::handle` (40 `0x2596380`) checks, in order:
  - the held item against the carried one, and the slot against the selected slot (SourceItemMismatch);
  - `player_pos` within 6.0 of the server's position;
  - the distance to the target within `GameMode::getMaxPickRange` (6.7 in survival, 12 in creative; `0x1f3a6b0`);
  - only when a movement setting byte (`+0x32`) is 1, a view ray. The ray runs from the eye along the rotation in
    `MoveInputComponent+0x34` for maxPickRange + 1 and must hit the target's AABB grown by 0.5, or else the dot product of
    view and target direction must clear `player-movement-action-direction-threshold`.

  Then the closure's switch (`0x25ae470`) calls GameMode vftable slot 15 (attack) or 14 (interact). `interact_rotation`
  held at zero still hit a pig standing to the side, so on these servers the view check is not what had stopped the old bot.
  The old bot's misses were never pinned to one field; the candidates are its 16 Hz tick, its missing `vertical_collision`,
  and the `data`-less `animate`.
- **Block break, server-authoritative.** The client sends `start_break`, then `continue_break` every tick, then on the tick
  it thinks the block is gone `continue_break` + `predict_break` together, with the `break_block` item-use transaction in the
  same auth input. Geyser's `BlockBreakHandler` reads exactly this. The auth input carries only `break_block` transactions,
  and Geyser disconnects on `stop_break`, so a client never sends one. Dirt by hand breaks in 17-18 ticks.
- **Right-click a block** is an `item_use` `click_block` in an InventoryTransaction, and it **needs the network id of the
  clicked block**. The item-use closure (40 `0x25ada00`) checks the block the packet's id names against the block at that
  position (`+0x108`, then the legacy at `+0x68`, then the extra layer). Only a matching block reaches
  `GameMode::useItemOn`. With id 0 the extra layer (air) matched, so `useItemOn` ran on air: bdsx's `itemUseOnBlock` fired,
  but no chest opened, nothing was placed and no bed was used. The bot now tracks `update_block`, `update_block_synced` and
  `update_subchunk_blocks`, and sends what the server last told it. With `block-network-ids-are-hashes=true` that is the
  hash at `Block+0x110`; the crafting table read 1752181952 on the server and in the bot.
- **Item use's predicted inventory action.** For a snowball the client sends the slot's old and new stack. Without it the
  engine still throws the snowball, but returns BalanceMismatch (2) and resends the inventory; with it, the same throw returns 1.
  A bow's `item_release` is the same: bare, the engine shoots and returns 2; with two predicted slot actions, the bow one
  durability down (its `Damage` NBT int + 1) and one arrow gone from the arrow's slot, the same shot returns 1 (both builds,
  `lb40-20261002-153957.txt`; the livebot `release` op's `ammoSlot`). bedrock-protocol's item NBT switch matches
  `has_nbt: true` (the boolean it decodes to), not the mapped `"true"`: with the string it writes no NBT and the item's
  length prefix is off by one.
- **Hotbar drop (Q)** is an InventoryTransaction `normal`: the slot action first and the world-interaction drop second
  (Geyser reads them as `actions[0]` and `[1]`), with the dropped stack carrying no net id. The engine's normal handle returns
  1 and an item entity appears. The inventory screen's `drop` is an ItemStackRequest; it also works (status ok), but bdsx does
  not raise `playerDropItem` for it.
- **Swimming.** The server sets SWIMMING itself, 3-4 ticks after the bot sprints in deep water and before any `start_swimming`
  is sent (section 9).
- A pig killed in the arena drops porkchops at the end of its death animation. The bot then picks them up, and its next attack
  names a held item the server no longer agrees with (SourceItemMismatch). Pigs therefore leave by the void, and drops from
  breaking are cleared before the next item use.

## 9. What it found in bdsx

- **`playerAttack` never fired for a client's attack.** The 34-byte shim bdsx hooked (`bdsx:Actor::attack`, Player vftable
  slot 52) is only the virtual's entry. GameMode::attack's closure (40 `0x1f462d0`) calls the 3.4 KB combat body directly at
  `0x1f464d5`, passing its own fifth argument, the attack direction. The body has three direct callers: the shim, that closure,
  and 40 `0x62d9c30` / 51 `0x71b3c80`. It now ships as `bdsx:Player::_attack` (40 `0x229610`, 51 `0x2b84b0`), and
  `playerAttack` hooks it, passing the fifth argument through (bdsx `dd3f7991`). Before the fix the event fired on 0 of 3
  landed hits. After it, it fires on every hit, a cancel leaves the pig at 10 health, and an allowed hit takes it to 9 or 7.
  `playerCrit` (`bdsx:Player::_crit`) still fires from inside the body.
- **`entityStartSwimming` never fired for a client** (fixed 2026-10-02, bdsx `0f49dd03`). bdsx hooked
  `Player::startSwimming`, but on 1.26 a client's swim sets the flag in an ECS system that turns the tick's player-action
  bits into actor flags. Its per-entity function is now `bdsx:PlayerActionFlagSystem::_tickEntity`: 40 `0x8333820`,
  51 `0x83d74d0`, 455 bytes, byte-identical on both builds, called from 40 `0x8333bc0` / 51 `0x83d7870`. It takes
  (EntityId, PlayerActionComponent, ActorDataFlagComponent, ActorDataDirtyFlagsComponent, EntityRegistry). Bit 21 sets flag
  57 (Swimming) and bit 22 clears it; bits 32/33 do the same for crawling and 11/12 for flag 1. Those are minecraft-data's
  Action numbers, and the PlayerActionPacket handler's jump table (40 `0xa5fe2d8`) has no case for any of them. Only
  `Player::startSwimming`/`stopSwimming` and `Actor::load` call `setActorFlag(…, 57, …)`. The event is now also raised
  from that function on the call that turns the flag on (`engine/playeraction.ts`); a cancel hides bit 21 from that one
  call. The server starts the swim on its own 3-4 ticks into a sprint in deep water, before any `start_swimming` is sent.
  Cancelled, the event fires on each of the 26 ticks the start is tried and the flag never goes on. Allowed, it fires once
  and the flag goes on. The simulated player's swim (`sswim40/51`, through the virtual) still fires once.
- **bdsx's stock example cancels every other drop.** `example_and_test/event-playerdropitem.ts` returns CANCEL on
  alternate events, and `index.ts` loads it in every session. That gave both sides of bdsx's cancel for free: the
  cancelled drop resends the inventory and never reaches the engine, and the next one becomes an item entity.

## 10. Confirmed by execution (2026-10-02, both builds, bdsx's own code)

`node tools/host/verify-pair.mjs tools/host/drivers/lb40.ps1 tools/host/drivers/lb51.ps1` (`lb run all`) came back with
**25 PASS / 0 FAIL on each build**, tsc 0, exit 0, `Quit correctly`. Transcripts: `work/host-runs/lb40-20261002-115002.txt`,
`lb51-...`. Bot logs: `work/host-runs/livebot/`. With the swim fix the run is 26 PASS / 0 FAIL on each build
(`lb40-20261002-115915.txt`, `lb51-...`). The regressions all came back unchanged: `layout` 41/0, `pk` 16/2, `sig`, `satk`, `sswim`.
With the loop pump in bdsx and the interact/sneak/talk scenarios, the run is 31 PASS / 0 FAIL on each build
(`lb40-20261002-130915.txt`, `lb51-...`), and 34 / 0 with the `stack` scenario (`lb40-20261002-131606.txt`), 36 / 0 with the Strength and predicted-bow checks
(`lb40-20261002-153957.txt`, `lb51-...`; the summary line is now lower case, because `verify-pair.mjs` counted its "0 FAIL"). With the pump, `layout` 41/0, `pk` 16/2, `sig`, `lbtimers` 6/0 and `simq7` 13/0 also
came back unchanged on both builds.
Two more client facts. A member's `/say` is answered with `commands.generic.error.permissions`, and `command_request` with
`version: "latest"` (Cloudburst writes that) no longer drops the bot. The control channel puts the request's own `id` last,
because an op argument named `id` (the form's) had replaced it.

| scenario | what was seen through bdsx (each on 1.26.40.8 and 1.26.51.1) |
|---|---|
| attack | a side target hit while aimed (handle 1, health falls); `playerAttack` fires; cancelled, the health stays; allowed, it falls; with Strength II `entityHurt` 3.99 |
| walk | the server moves the player 4.38 blocks in 20 ticks; it ends 0.01-0.03 blocks from the bot, with no correction |
| jump | the server's feet rise 1.25; `playerJump` fires once (`bdsx:JumpExhaustionSystem::_tickEntity`); exhaustion +0.05 |
| crit | jump, then attack on the way down: `playerCrit` fires and the pig is hurt |
| break | dirt by hand gone in 17-18 ticks; `attackBlock`, `blockDestructionStart` and `blockDestroy` fire once each |
| useon | crafting table opens a workbench; chest fires `blockInteractedWith` and `chestOpen`, opens and closes |
| place | dirt placed from the hotbar; `blockPlace` fires (the engine's own `mayPlace`) |
| drop | two hotbar drops: `playerDropItem` on both; one cancelled (stays in the hotbar), one dropped (item entity) |
| use | a snowball thrown: `playerUseItem` (method 4), `itemUse`, `projectileShoot` |
| bow, eat | `isUsingItem` true while drawing or eating; the arrow is shot (handle 1 with the arrow and wear predicted, 2 without); the beef eaten (`playerUseItem` method 1) |
| bed | `playerSleepInBed` at night |
| swim | cancelled through `entityStartSwimming`, the flag never goes on; allowed, one event and the flag goes on (section 9) |
| interact | `item_use_on_entity` interact with a bucket on a cow: `playerInteract` fires and the hand holds milk |
| sneak | `entitySneak` true then false; `isSneaking()` true while held |
| talk | chat read by `packetBefore(Text)` and echoed; `/me` run as the player (`events.command`; the bot hears it); a modal form answered by the client resolves bdsx's `Form.sendTo` with `true` |
| stack | chest → cursor → hotbar as two ItemStackRequests: both `ok`, the diamonds move, bdsx's reader gives the wire's actions, slots and stack ids (`findings-inventory.md` section 27) |

**The 3.99 hits were Strength II from a bdsx stock example.** Before 2026-10-02 13:00 `entityHurt` reported 1 or 3.99 for the
same bare-hand hit (crit 1.5 or 5.985), switching within one run. `example_and_test/actor-effects.ts`, which every probe session
loaded until the loop pump made its interval run (bdsx `d6a8de04` and the selective imports in `index-probes.ts`), gives every
player Strength II for 20 ticks every other second. Bedrock's Strength is damage × 1.3^n + (1.3^n − 1) / 0.3: for n = 2 and a
bare hand, 1.69 + 2.3 = 3.99, and a crit's ×1.5 makes 5.985. All 16 runs before the change saw 3.99 at least once, all 12 since only 1,
and the `attack` scenario now gives Strength II on purpose and reads 3.99 (health 10 → 7) on both builds.
`interact` (bucket on a cow) returns 2 with the milk in hand: the bot does not predict the bucket → milk change, the
same shape as the snowball and the bow.
A plain `summon cow` comes out a calf about one time in twenty, and a calf gives no milk: once on 51, `interact` passed
`playerInteract` with handle 1 and an empty bucket. The cow is now summoned with `minecraft:spawn_adult`, and three runs in a
row per build gave milk (`LB_RUN = "interact interact interact"`).
