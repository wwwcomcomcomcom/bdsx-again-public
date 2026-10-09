# Receive-side packet events: `packetRaw` / `packetBefore` / `packetAfter` (Q5, route B)

2026-09-22. Bottom line first: **all three of bdsx's receive-side packet events work again on 1.26.** Rather than hooking each packet type separately, it covers every packet id at once. Not a single byte of the binary's code was patched, and there is no per-build patch offset to re-derive. Confirmed by execution on both builds (`tools/packet-probe.ts`, driver `pk40/51.ps1`).

## 1. What 2024 did, and what vanished in 1.26

2024 bdsx patched **the middle** of `NetworkSystem::_sortAndPacketizeEvents` (`0x813ad0`, 4369B) in three places (`hook2024Receive` in `bdsx/event_impl/packetevent.ts`): the `createPacket` call site at `+0x2f5` (raw), the read-lambda call site at `+0x3a4` (before), the handler indirect-call site at `+0x7df` (after), and `+0x839` to skip on cancellation.
1.26 has no function of that name, and even if a successor were found, the four offsets and byte-sequence checks would have to be re-derived per build.

To look for a successor, I searched 1.26 for the anchors from the 2024 body. Here is what came back.

- The string `disconnectionScreen.badPacket` is absent from 1.26 (only the `BadPacket` enum name survives).
- There is exactly one 1.26 function per build that references `disconnectionScreen.connectionLost` (40 `0x14bf560`), and it is the function that builds the enum-name table.
- `createPacket` (which is in the table) has four callers per build. Of these, the one near NetworkSystem, 40 `0xbf9f40` (8303B), handles JSON, and shares nothing with the other anchors of the 2024 loop (`receivePacket`, `getUnsignedVarInt`, `_handleViolation`).

**There was no need to find the loop itself.** 2024's `Packet::handle` (`0x8205e0`) is one line.

```
movq 0x20(%rcx), %rcx        ; handler_
movq (%rcx), %rax
movq 0x8(%rax), %rax         ; vft[1]
callq *__guard_dispatch_icall_fptr   ; (handler_, ni, callback, shared_ptr<Packet>&) -- rdx/r8/r9 unchanged
```

1.26 merely inlined this one line into the receive loop; the dispatch structure is unchanged. Every packet carries a `handler_`
(`IPacketHandlerDispatcher*`, Packet+0x20 — the offset already confirmed by the `AttributeData` section of `findings-layouts.md`), which points to **a static object, one per packet type** (`.data`), and slot 1 of that table's vtable is where the parsed packet is handed to `ServerNetworkHandler`. Endstone (Apache-2.0) uses the same pointer too
(`src/endstone/runtime/bedrock_hooks/packet.cpp`: the `createPacket` hook wraps `packet->handler_`).

## 2. before / after — swapping the dispatcher's vptr

What `installPacketDispatchers()` does is three steps.

1. At load time, call `createPacket(id)` once for every id 0..351 and read `handler_`. 1.26.40.8 yields **228** dispatchers, 1.26.51.1 yields
   **229**, and it's always one dispatcher per id (none are shared).
2. Build a new two-slot table for each dispatcher. Slot 0 is the original destructor, slot 1 is a six-instruction stub.
   The stub looks at the before/after bits in that id's `enabledPacket` byte, and if both are off, jumps straight to the original `handle`.
   If either is on, it goes to JS (`onPacketDispatch`).
3. Swap the dispatcher object's vptr to the new table. A single `.data` write.

The semantics on the JS side match 2024: before listener → if `CANCEL`, don't call the original `handle` → original `handle` → after listener.
A `CANCEL` in after only stops the remaining after listeners. The NetworkIdentifier a listener receives is the shared instance normalized through `NetworkIdentifier.from()`. This matters because `form.ts` compares **object identity** with `sent.networkIdentifier !== ni`.

**CFG was not an issue.** The loop calls this slot through `__guard_dispatch_icall_fptr`, and executable memory obtained via `VirtualAlloc`
is by default a valid call target. After installation, every received packet on both builds passes through this table (pk, layout, sig, q2ev sessions — all of them), and no session hit a CFG failure. Counts were not tallied.

### What the first attempt taught -- always call the original even when an exception occurs

The first attempt didn't complete player join on either build (`playerJoin` never fired). bdsx installs a
`packetBefore(SetLocalPlayerAsInitialized)` listener internally from load time (`entityevent.ts`, a defense against actorless clients).
So this id went to JS from the start, and there `Packet.getId()` threw. The code at the time skipped the original call on any exception, so
BDS never got to process that packet. Now the original is always called no matter what fails on the JS side; only `CANCEL` skips it.

`Packet.getId()` used to be implemented by looking up the slot by name via
`procHacker.jsv("??_7SetTitlePacket@@6B@", "?getId@SetTitlePacket@@...")`, but that name isn't in the 1.26 table. It is now `derived()`:
two instructions, `mov rax,[rcx]; jmp [rax+8]`, and slot 1 = `getId` -- Endstone's `packet.h` (`~Packet, getId, getName, ...`) and the
2024 table agree on this.

## 3. raw — `BatchedNetworkPeer::_receivePacket`

Receiving on 1.26 is a chain of peers. Each call to `BatchedNetworkPeer::_receivePacket` hands one decoded packet
(header varint + payload) up the connection. This is exactly the bytes the 2024 patch used to read from the `_sortAndPacketizeEvents` stream.
Endstone hooks this same function to fire its `PacketReceiveEvent`.

- **Address**: 40 `0xfe01d0` (769B) / 51 `0xa8f7b0` (921B). Two routes:
  - Endstone's per-release table (v0.11.7 for 40, HEAD for 51) -- the same table that matched ours 16/16, 18/18.
  - The body. On both builds it checks the `this+0xc0/+0xc8` queue, and if empty, calls `+0x40` on the vft of `this->peer_` (this+8).
    `+0x40` is `NetworkPeer` slot 8, which is `_receivePacket` itself -- the batching peer pulling from the peer underneath it.
- **Thread**: 1.26's `NetworkSystem` has a `receive_task_`/`IncomingPacketQueue`, so on the assumption this function might run on a worker
  thread, the stub checks first. It only goes to JS when `GetCurrentThreadId() == capi.nodeThreadId`; otherwise it jumps to the original and
  counts `packetRawOffThread`. Measured **0** on both builds. Receiving runs on the game thread.
- **Cancellation**: if a raw listener returns `CANCEL`, the original is called again to receive the next packet (same as Endstone). A
  cancelled packet is neither parsed nor dispatched.
- **NetworkIdentifier**: the connection has to be located from the peer. The binary gave the layout.
  - `NetworkSystem::connections_` is at **+0xa0** (`vector<unique_ptr<NetworkConnection>>`). The inlined `getPeerForUser`
    (40 `0xbfd6f0` / 51 `0x93bfa0`, 163B) reads begin/end from `+0xa0/+0xa8`, first compares each connection's NetworkIdentifier type
    (+0xa8), then calls the equality comparison. It then checks `should_close_connection_` (+0x199) and returns `peer` (+0x118).
    2024's `_getConnectionFromId` (`0x810b60`) placed the same vector at +0x40.
  - `NetworkConnection` is Endstone's `network_connection.h` order with 1.26's 176-byte NetworkIdentifier slotted in: id +0, type +176,
    six weak_ptrs starting at +184 (recorder, encrypted, compressed, **batched +232**, latency, trace), peer +280.
    The binary confirms this arithmetic twice. peer +0x118 and should_close +0x199 come from the function above; `batched_peer` +0xe8
    comes from 40 `0xbfe5f0` locking the `+0xe8/+0xf0` weak_ptr and setting the bytes for that batched peer.
    Endstone's `// +377` comment is stale (the real value is +409).
  - Shipped as `layouts.NetworkSystem.connections` and `layouts.NetworkConnection.{id,batchedPeer,peer,shouldClose}`.

## 4. A side effect revived along the way — `ServerPlayer.getNetworkIdentifier()`

The first thing the probe ran into wasn't a packet. `player.getNetworkIdentifier()` threw because
`??$tryGetComponent@VUserEntityIdentifierComponent@@@Actor@@` was missing. A large chunk of bdsx's public API (forms, packet sending,
certificates) goes through this. It is now `derived()`.

- Implementation: `enttComponent(actor, fnv1a("UserEntityIdentifierComponent") = 0xb845379, 592)`. The hash has 185 users on 40, 187 on 51.
- Size and offset: `?getSourceId@PlayerCommandOrigin@@` (returns `NetworkIdentifier const&`, 40 `0x12e72d0` / 51 `0x12096d0`) returns the
  component itself after a packed lookup `imulq $0x250`. So the size is 592 and `network_id_` is at +0 (also matches Endstone's header order).
- `uuid`/`certificate` were still the 2024 offsets. Not re-derived at the time. → **Finished 2026-09-23, section 11.**

## 5. Confirmed by execution

Both builds: **12/12 PASS (0 FAIL) + tsc 0 + exit 0 + `Quit correctly`** (`work/host-runs/pk40-20260922-131055.txt`, `pk51-...`).
With `PK_ARM=1`, the probe hooks before/after on all ids at load time, plus raw on Text. The bot (`tools/probe-client.cjs`'s new options
`BP_CHAT`/`BP_FORM_REPLY`) sends four chats and responds to a form.

| Check | Both-build result |
|---|---|
| coverage | 10 types arrive at before: Login, RequestNetworkSettings, ClientToServerHandshake, ResourcePackClientResponse, ClientCacheStatus, RequestChunkRadius, SetLocalPlayerAsInitialized, Respawn(3), Text, ModalFormResponse |
| pairs | for ids that were not cancelled, before count = after count |
| raw-order / text-order | a passed-through chat arrives in raw → before → after order |
| text-cancel | `bdsxcancel2`, cancelled in before, never reaches after |
| raw-cancel | `bdsxrawcut4`, cancelled in raw, never reaches before/after |
| identity / raw-identity | the NetworkIdentifier the listener receives is the same instance as the player's (6/6, 3/3) |
| form-resolved | bdsx's public `Form.sendTo` resolves to `true` from the bot's reply (`form.ts`'s packetAfter). Working for the first time on 1.26 |
| ni-roundtrip | passing the NetworkIdentifier read from the component to `getActor()` returns that same player |
| disarm-quiet | with all listeners removed, 0 listener calls (the stub's fast path runs) |
| raw-thread | 0 receives off the game thread |

**BDS itself is the witness.** BDS echoes processed chat back to the bot. In the bot logs (`pk40.bot.log`, `pk51.bot.log`),
`bdsxpass1` and `bdsxafter3` (sent after listeners were removed) come back, while `bdsxcancel2` (cancelled in before) and `bdsxrawcut4`
(cancelled in raw) never do. True on both builds.

**Regression**: the dispatcher and the raw hook are now installed in every session. `layout40/51` is 23/23, 0 FAIL, and `sig40/51`
fires the hurt/knockback/dimension-change events and exits normally. In `q2ev40/51`, `playerPickupItem` fired 0 times on both builds --
**unrelated to this change**. With the dispatcher turned off (`BDSX_NO_PACKET_DISPATCH=1`, confirmed the install line doesn't print), 40
is still 0. It fired 3 times at 09-21 15:04, so this is a regression from a later commit. Filed separately under next-steps.

**Recording three wrong attempts as they happened.**
1. Wrote it to skip the original on any exception, which blocked join (section 2).
2. The probe almost read the bdsx field (`message`) of TextPacket. 1.26's TextPacket is 248 bytes and its body changed to a
   `std::variant` (Endstone `text_packet.h`). But the bdsx declaration is still the 2024 one. So the probe instead exploits the fact
   that a marker string of 15 characters or fewer is SSO-inlined inside the object, and searches for the marker in the object's raw bytes.
3. `player.getNetworkIdentifier()` inside a listener threw, ending the call before `CANCEL` could be returned. This is why that attempt
   looked like "cancellation doesn't take effect" (fixed in section 4).

## 6. Tool: `tools/disas.mjs`'s addresses drift

While reading a 1.26 body, I found a branch target landing in the middle of an instruction. `tools/disas.mjs` counts addresses by the
instruction length that llvm-mc **re-encodes**, so it counts the redundant-prefix instruction MSVC uses for padding
(`66 2e 0f 1f 84 00 …`, 10 bytes) as 6 bytes, and every address after that is off. This was no problem for short stretches like the CRT
chain, but long functions can't be trusted.
`tools/disas-exact.mjs` wraps the original bytes as `.byte` in an object file and reads it back with `llvm-objdump --adjust-vma`.
It attaches names from our table to call targets and rip-relative addresses.

```sh
node tools/disas-exact.mjs 1.26.40.8 0xbfd6f0          # whole .pdata function
node tools/disas-exact.mjs 1.21.3.01 0x8205e0 64       # baseline build, given length
```

## 8. `TextPacket` layout (Q5-3)

As section 7 noted, bdsx's `TextPacket` declaration was still 2024's flat struct. 1.26's payload
(Endstone `text_packet.h`, `TextPacketPayload` -- byte-identical between 0.11.7 and HEAD) collapsed the three fields
`name`/`message`/`params` into a single `std::variant<MessageOnly, AuthorAndMessage, MessageAndParams>`.
`sizeof(TextPacket)` is still **0xf8 (248)** (`movl $0xf8,%edx` in the deleting destructor,
40 `0x6a49d0` / 51 `0x2e3370`, instruction-for-instruction identical between builds; Endstone
`BEDROCK_STATIC_ASSERT_SIZE(TextPacket, 248, 208)` is also identical across both releases).

**The offsets were read from the payload destructor** (40 `0x6a4890` / 51 `0x2e3230`, identical down to instruction offsets between
the two builds) **and from the jump-table helper it calls, which branches on the index byte** (40 `0x6a4a10` /
51 `0x2e33b0`, also identical). Destruction order is the reverse of declaration order (body → filtered_message → platform_id →
xuid → localize needs no destruction), which is itself a second piece of evidence for field order.

| Field | Offset | Notes |
|---|---|---|
| `localize` | +0x30 | bool, untouched by the destructor (default-initialized, needs no destruction) |
| `xuid` | +0x38 | `std::string` |
| `platform_id` | +0x58 | `std::string` |
| `filtered_message` | +0x78 (string), +0x98 (has_value bool) | `optional<string>`. **Present in both builds' headers** -- not HEAD-only (see "wrong attempt" below) |
| `body`(variant) | +0xa0 (type byte, common to all alternatives), +0xa8 (first string), +0xc8 (second field), +0xe8 (index byte) | see table below |
| `serialization_mode` | +0xf0 | untouched (value not confirmed) |

The three alternatives of the `body` variant (Endstone `TextPacketPayload::{MessageOnly,AuthorAndMessage,MessageAndParams}`):

| Index | Alternative | +0xa8 | +0xc8 |
|---|---|---|---|
| 0 | MessageOnly | `message` | (unused -- spare space in the union storage, no lifetime) |
| 1 | AuthorAndMessage | `author` | `message` |
| 2 | MessageAndParams | `message` | `params` (`std::vector<std::string>`) |
| -1 | valueless | — | — |

The jump-table helper clearly distinguishes the two cases: the index-1 branch destroys +0xc8 with a plain
`std::string` destruction (calls the string dtor), while the index-2 branch destroys the same +0xc8 with
`leaq +0x28(%rsi); callq <vector dtor>` -- confirming in code that **the same offset is a string or a
vector depending on the alternative**. Both branches converge by destroying +0xa8 last, in common.

### On the bdsx side

Rewrote `TextPacket` in `bdsx/bdsx/bds/packets.ts`: `name`/`message`/`params` are no longer fields but getters/setters that check
`_bodyIndex` (+0xe8, `int8_t`) and read whichever of +0xa8/+0xc8 is correct.

- `get name()` / `get message()`: pure reads, branch only on the index.
- `set message()`: writes in place at the current index's location (does not change the alternative -- MessageOnly/
  MessageAndParams use +0xa8, AuthorAndMessage uses +0xc8, so it just overwrites a location that already holds a valid string).
- `set name()`: **switches the alternative** (`TextPacket$ensureIndex01`) to MessageOnly (0) for an empty string, or
  AuthorAndMessage (1) otherwise -- while preserving `message`, it destroys the current alternative's string(s) with the real
  C++ destructor, constructs the target alternative's string(s) fresh with the real C++ constructor, then writes the index byte.
  The string ctor/dtor re-resolve the same symbols `nativetype.ts` uses internally
  (`??0?$basic_string@...@@QEAA@XZ` / `??1...`) in this file --
  the same pattern as `PlayerListEntry`'s `ConstructPlayerListEntryByUUID`.
- `get params()`: **even reading it switches the alternative to MessageAndParams (2)** (`TextPacket$ensureParams`).
  The first draft made `params` give a vector only when `_bodyIndex===2` and `null` otherwise, but **the four existing public
  APIs in `bds/player.ts`** (`sendJukeboxPopup`, `sendPopup`, `sendTip`,
  `sendTranslatedMessage`) all assumed, in the form `pk.message = message; pk.params.push(...)`, that they could **unconditionally
  use `.params` on a freshly `allocate()`d packet** -- with `null` it would throw right there. Fixed it so `params` stays non-null
  and switches the alternative automatically on access, preserving the 2024 flat-struct API's contract ("just write to it and it
  works"). When moving off MessageOnly (0), `message` is already at +0xa8 so nothing needs to move (the two alternatives share
  that location); when moving off AuthorAndMessage (1), `message` moves from +0xc8 to +0xa8 (author is discarded). `_params` is
  a real nativeField of type `CxxVector.make(CxxString)`, so construction reuses `CxxVector`'s existing `[NativeType.ctor]`
  (a 24-byte memset), and destruction when index01 moves off index 2 reuses `[NativeType.dtor]` (per-element destruction +
  `msAlloc.deallocate`, the exact code `cxxvector.ts` uses to destroy any `CxxVector` field) -- no pointer-walking code was
  written from scratch.
- `get filteredMessage()`: pure read (if `+0x98` is 1, the string at `+0x78`, else null). The offset is confirmed on both
  builds, but the probe never triggers it (no message that trips the profanity filter has been sent).

### Checks

Added three checks to `pkprobe report` in `tools/packet-probe.ts`: `field-message`/`field-name`/`field-type` (when the bot's
`BP_CHAT` chat arrives at packetBefore/After, whether `pk.message` exactly matches the sent string, whether `pk.name` matches
the bot's `source_name` ("bdsxprobe"), and whether `pk.type` is Chat). `pkprobe sendtext` doesn't add new functionality --
it **uses the existing public API as-is** -- `player.sendChat(
"bdsxsenttext5", "bdsx")` internally does `TextPacket.allocate()` → set `type`/`name`/`message` →
`sendNetworkPacket` → `dispose()`, so this checks that entire path unmodified (especially `name`'s switch to
AuthorAndMessage). `tools/probe-client.cjs`'s `text` logger (carried in
`637b81a`, a different batch's commit made after section 2) now also prints `source_name`, so the name/message of packets
the bot receives can be seen in `.bot.log`. No new driver -- just one line, `pkprobe sendtext`, inserted into the existing
`pk40/51.ps1` command list.

### Confirmed by execution

Both builds: **15/15 PASS (0 FAIL) + tsc 0 + exit 0 + `Quit correctly`**
(`work/host-runs/pk40-20260923-013818.txt`, `pk51-20260923-013818.txt`). Three checks (`field-message`/`field-name`/`field-type`)
were added to section 5's 12, and all pass. The `sendtext` side was confirmed directly in both builds'
`.bot.log` (`pk40.bot.log:62`, `pk51.bot.log:57`) --
`{"source_name":"bdsx","message":"bdsxsenttext5"}`. Exactly what `player.sendChat("bdsxsenttext5","bdsx")`
passed in: the name arriving as "bdsx" is evidence that `name`'s switch to AuthorAndMessage (1) actually
runs, and the message arriving intact is evidence that the switch preserves `message`.

### `PlayerAuthInputPacket` got as far as the layout in the next round (section 10 below)

This was the second item of next-steps Q5-3. The successor to `?getInput@PlayerAuthInputPacket@@`,
which `entitySneak` calls, was resolved without an address (`derived()`) in section 10 below -- the two Endstone headers and
minecraft-data's protocol definition agree, as a third independent route, on matching offsets and enums. **However, triggering
it with the bot failed** -- sending a synthesized packet disconnects both builds within 0.5 seconds. The static evidence is
strong but there is no execution confirmation.

### Recording the wrong attempt as it happened

The first static read noted `filtered_message` as "1.26.51.1/HEAD-only, absent from 0.11.7." Reading the two
Endstone headers (`work/endstone-0.11.7` and `work/endstone`) side by side shows **both have
`std::optional<std::string> filtered_message;`** in the same place -- not a release difference, but a header
misread. The real offsets were re-confirmed from both builds' destructor disassembly (table above); both destroy the
same field at the same bytes.

The design that made `params` read-only (a vector only when `_bodyIndex===2`, else null) was also wrong --
had grepping not confirmed that four public APIs in `bds/player.ts` already used `.params` unconditionally, this
round could have silently broken those four while reporting "TextPacket done."

Also ran into the fact that `verify-pair.mjs` **dies with exit 1 and no output if the first session
fails** (under `set -eu`, if `wait $P40` fails, neither `E40=$?` nor the reporting loop that follows runs). To see the
failure cause, `node tools/host/session.mjs <40|51> <driver>` has to be run standalone. Two false alarms:
(1) a type error another agent (`gamerules-probe.ts`, Q4) left behind without holding the lock -- not my change.
(2) using `void_t` without importing it from `bdsx/nativetype` -- this one was my mistake.

## 9. The sending side -- `packetSendRaw` is done with a new hook, `packetSendAll` has no place to attach (Q5-2, 2026-09-23)

Of the two items section 7 left open, one closed with a new hook, the other with the conclusion "there's no place to attach
it." No new address was added -- `?sendPacket@BatchedNetworkPeer@@...` (40 `0xfdfff0` / 51 `0xa8f5d0`) was already in the table
(promoted via an Endstone signature, but nobody was using it). This function is the point where a serialized header+payload
(`std::string const&`) is handed to a connection; its body (rcx=this, rdx=data, r8d=Reliability,
r9d=Compressibility) appends that data to the peer's internal buffer and returns -- the send-side mirror of
`_receivePacket`.

**`packetSendRaw`**: `installSendRaw()` in `bdsx/bdsx/event_impl/packetevent.ts` hooks it the same way as
`installRawReceive()`. At function entry: if not on the game thread, don't call JS, just bump a counter
(`packetSendRawOffThread`) and jump straight to the original (touching nothing). On the game thread, read the
header varint to get the packetId, check the `enabledPacket` bit, and if the listener returns CANCEL, **return
without calling the original at all** -- nothing goes out on the wire. The NetworkIdentifier reuses
`connectionIdOfPeer(peer)` directly (since `sendPacket`'s `this` is the same `BatchedNetworkPeer*` as
`_receivePacket`'s `this`). The one implementation detail: `sendPacket` takes four arguments
(this/data/reliability/compressibility), so the register pushes come out to an **even count**. `_receivePacket`'s
three arguments naturally landed on 16-byte alignment (`installRawReceive`'s comment "three pushes make it
16-aligned"), but four doesn't, so an unused fifth push (r10) was added to fix the alignment.

**`packetSendAll` has no place to attach at all -- that is the conclusion confirmed this time.** Even in 2024
there was no separate `events.packetSendAll` event -- `packetSendAll` was just a mechanism that hooked
`LoopbackPacketSender::sendToClients` (the broadcast entry point) **at one more spot** to fire the already-existing
`events.packetSend` (in `packetevent.ts`, `packetSendAllHook` calls `onPacketSend` exactly like
`packetSendHook`, quoted above). The reason it existed was that 2024's broadcast bypassed
`NetworkSystem::send` and went straight to `_sendInternal`, missing `packetSend`. On 1.26 neither `sendToClients`
nor `_sendInternal` has an out-of-line copy -- meaning the inliner left no such separation -- so the only remaining
question was "does 1.26's broadcast still skip the already-hooked `NetworkSystem::send`
(`packetSend`)?" Confirmed by execution on both builds via the console `say` (BDS's own broadcast path): `say
bdsxbroadcast3` was caught by both the newly-hooked `packetSendRaw` and the existing `packetSend`. That is, on 1.26
broadcast also passes through the two already-existing hooks -- **there is nothing separate to hook, and nothing
needs to be.** The limitation remains that a single bot can't distinguish "once per broadcast" from "once per
recipient" (both builds only confirmed that `packetSend(Text)` was called twice around `say`).

> **Corrected 2026-09-24** (section "packetSend for recipient-list broadcasts" below): `say` broadcasts through
> `sendToClient` per player, which does call `NetworkSystem::send`. A broadcast to a recipient **list**
> (`LoopbackPacketSender::sendToClients`) does not: both names do have out-of-line copies on 1.26, and that path
> needed its own hook, as in 2024.

### Confirmed by execution

Both builds: **6/6 PASS + tsc 0 + exit 0 + `Quit correctly`** (`work/host-runs/pks40-20260923-022145.txt`,
`pks51-20260923-022145.txt`, new probe `tools/packet-send-probe.ts` = `zz-pksprobe`, driver
`pks40/51.ps1`). The decisive evidence is not a counter inside a listener but **the bot's receive log**
(`pks40.bot.log`/`pks51.bot.log`, `probe-client.cjs`'s existing `text` logger -- untouched):

| Check | Result |
|---|---|
| `player.sendChat("bdsxsendrawpass1", ...)` (not cancelled) | arrives in the bot log on both builds |
| `player.sendChat("bdsxsendrawcut2", ...)` (`packetSendRaw` returns CANCEL) | **absent** from the bot log on both builds -- never went out on the wire |
| `say bdsxbroadcast3` (BDS's own broadcast) | reaches both `packetSendRaw` and `packetSend` on both builds, bot receives it too |
| `raw-identity` | the NetworkIdentifier `packetSendRaw` receives is the same instance as the bot's own, 6/6 |
| `raw-off-thread` | 0 on both builds -- never called off the game thread |
| Dispatcher regression | `[bdsx] packet dispatch: 228/229 dispatchers for 228/229 packet ids` -- unchanged from Q5 route B |

This is a case of confirming cancellation from **what BDS/the bot actually exchanged**, rather than trusting a
listener's own verdict -- `pass1` arriving while `cut2` is entirely absent from the log is stronger evidence than
"the listener returned CANCEL."

## 10. Successor to `PlayerAuthInputPacket::getInput` -- `input_data` moved to packet+0x88 (rest of Q5-3, 2026-09-23)

`?getInput@PlayerAuthInputPacket@@QEBA_NW4InputData@1@@Z` has no out-of-line copy on 1.26, for the same reason as
`TextPacket` in section 8 -- but a different underlying cause. **Endstone's `player_auth_input_packet.h`
(both v0.11.7 and HEAD) writes this class's `write()`/`_read()` as `throw std::logic_error("Not
implemented")`**: this packet is serialized through the cereal reflection path rather than the manual write/_read
the other packets use, so searching both 1.26 builds' `.text` for 2024's
`shrq $6/andb $0x3f/btq` bit-test shape -- both an exact byte search and a mask search with just the last byte
cleared -- turns up **zero hits** (this isn't 1.26 inlining and scattering the code somewhere; there simply is no
code of that shape to begin with).

**The field is still there, though.** Both Endstone headers write byte-identically that
`std::bitset<INPUT_NUM> input_data` sits at `PlayerAuthInputPacketPayload+88`, and the payload
starts at `Packet+48` (`BEDROCK_STATIC_ASSERT_SIZE(Packet, 48, 48)`) -- so the field is
**`packet+0x88`**. `INPUT_NUM` grew from 2024's 49 to **66** on 1.26 (new entries from `HorizontalCollision`
through `InternalUpdate` were appended after `BlockBreakingDelayEnabled`). The bitset needs two words
(16 bytes) for 66 bits, but the `InputData` enum values (0..48) bdsx already declares all fall **within the first
word, at the same bit positions as 2024** -- `StartSneaking=27`/`StopSneaking=28` are
unchanged in both Endstone headers.

**Third independent route**: while building a bot packet to trigger `entitySneak`, opening minecraft-data's bedrock
`1.26.40`/`1.26.45` `protocol.json` (read from the host's `bot`/`bot-pr804` node_modules) showed that the
`InputData` mapper **matches the Endstone headers exactly, down to names and numbers** (`start_sneaking=27`,
`stop_sneaking=28`, every entry 0..65 agrees). Three sources -- two Endstone headers standing in for what the 2024
PDB can no longer give, and minecraft-data's community reverse-engineering -- give the same answer by different
methods.

### On the bdsx side

`bdsx/bdsx/bds/implements.ts`: changed `PlayerAuthInputPacket.prototype.getInput` to `derived()`
(since this function can never have an address, `key in proc` is always false and only the `own` side runs).

```ts
const PLAYER_AUTH_INPUT_DATA_OFFSET = 0x88;
PlayerAuthInputPacket.prototype.getInput = derived(
    "?getInput@PlayerAuthInputPacket@@QEBA_NW4InputData@1@@Z",
    function getInput(this: PlayerAuthInputPacket, inputData: PlayerAuthInputPacket.InputData): boolean {
        const dword = this.getUint32(PLAYER_AUTH_INPUT_DATA_OFFSET + (inputData >>> 5) * 4);
        return ((dword >>> (inputData & 31)) & 1) !== 0;
    },
    () => procHacker.js("?getInput@PlayerAuthInputPacket@@QEBA_NW4InputData@1@@Z", bool_t, { this: PlayerAuthInputPacket }, int32_t),
);
```

The `inputFlags` nativeField (`0x70`) in `bdsx/bdsx/bds/packets.ts` was **left untouched** -- it's a dead field
(confirmed via `grep`: nothing in bdsx anywhere reads `.inputFlags`; `getInput()` now has its own separate offset).
Left a comment noting something found along the way: this `0x70` was already wrong even in 2024 --
the real location, measured from 2024's `write()` (where `BinaryStream::writeUnsignedVarInt64`
reads that value alongside the "Input Data" debug label), is **0x78**. Fixing this field would also require
re-deriving the following `inputMode`/`playMode`/
`tick` (all auto-layout, all unused), so it was left alone this time.

### Confirmed by execution -- static only, dynamic failed

**Code loading and harmlessness were confirmed on both builds.** `pk40/51.ps1` (without BP_AUTH_INPUT): **15/15 PASS +
tsc 0 + exit 0 + `Quit correctly`** (`work/host-runs/pk40-20260923-023532.txt`,
`pk51-20260923-023532.txt`) -- all of the `TextPacket`/`Form`/raw checks confirmed in section 8 still pass
unchanged, evidence that turning `getInput` into `derived()` broke nothing else. The boot log has only the one line
`[bdsx] ?getInput@PlayerAuthInputPacket@@...: no address in this build, using bdsx's own
implementation`, with no exception or crash marker.

**Triggering `entitySneak` via the bot failed.** With `BP_AUTH_INPUT=1`
set in `tools/probe-client.cjs`, 20/22 seconds after spawn it sends a synthesized packet via
`client.queue("player_auth_input", ...)` (only the
`input_data: ["start_sneaking"]` field is set; everything else uses minecraft-data's schema defaults/absences).
**Both builds disconnected 0.5-0.6 seconds after that packet was sent** (`pk40.bot.log`: `24.8s sent
player_auth_input start_sneaking` → `25.4s closed`; `pk51.bot.log`: `24.7s` → `25.2s closed`).
There is no crash, no `packet_violation_warning`, and no notable cause logged in the server's `.out`/`.err` --
just an ordinary `Player disconnected`. `PlayerAuthInput` is also absent from the "ids:"
list in `pkprobe report`: there's no evidence it even reached our `packetBefore` listener, so **not even
check (a) was confirmed by execution.**

Other causes were ruled out first: (1) the disconnect timing (~24-25s after connecting) is much earlier than when the
driver sends `kill @a` (13 commands × 8s + AfterJoin 8s ≈ 112s) -- not a script-termination artifact.
(2) both builds reproduce at the same timing, which is hard to explain as random network noise. (3) the
`Unknown command: pkprobe` line in the server log was unrelated noise -- **re-reading the same command
sequence that previously passed 15/15, from the raw `.out` without `--grep='\[pktprobe\]'`, showed the same line
was there in that session too** (the grep filter had simply hidden it). Also unrelated to Q5-2
(agent-s)'s `packetSendRaw` hook -- even after that hook was merged in
(including `e3708fa4`), a re-run without BP_AUTH_INPUT came back clean 15/15.

**Not attempted**: cross-checking the minecraft-data schema field by field against BDS
1.26.40.8/1.26.51.1's exact wire format (the schema targets the nearby versions 1.26.40/1.26.45 and may have
drifted between point releases); sending `input_data` as an empty array only (a test to separate "any synthesized
packet is rejected" from "the content `start_sneaking` itself is the problem"); sending a plausible non-zero tick.
The next person can start with one of these three, or it may be cheaper to skip straight
to Q7 (a real client) -- there's no reason a real client's packets should differ from this schema in the first
place.

### Confirmed by execution after all (2026-09-24)

The dynamic half now passes on both builds: `getInput()` read `start+sneaking`, then `sneaking` on each held
tick, then `stop`, on the bot's own packets, and `entitySneak` fired `true,false` (`live40`/`live51`, pktprobe
18/18). The failure above was the bot's packet. On 1.26.40 each optional field is a double bool that the server
reads with a short-circuit, and the bot wrote `presence=false` plus an empty option: one byte too many, five
times. On 51 it was fed the 1.26.45 schema. `docs/findings-bot.md` sections 2-4 have the byte-level comparison
against Cloudburst Protocol (Geyser's codec).

## 11. `UserEntityIdentifierComponent`'s `uuid`/`certificate` (Q5-5, 2026-09-23)

What section 4 left open: only `networkIdentifier` had been re-derived; `uuid` (2024 +0xa8) and `certificate` (2024 +0xd8) were
still the 2024 offsets. Both are done now -- `uuid` was a matter of moving the offset, and `certificate` was a matter of **there
being nowhere to move it to**.

**Layout.** Endstone's `user_entity_identifier_component.h` (0.11.7 and HEAD, byte-identical) gives the
member order: `NetworkIdentifier network_id_` (176B, align 8) / `SubClientId client_sub_id_`
(uint8_t, 1B) / `mce::UUID client_uuid_` (16B, align 8 → **+184**) / `PlayerAuthenticationType
authentication_type_` (int, 4B → +200) / `PlayerAuthenticationInfo trusted_player_info_` (held by value,
align 8 → +208). This arithmetic independently fits the component's already-confirmed stride (592B, section 4's
`?getSourceId@PlayerCommandOrigin@@`
`imulq $0x250`): 208 + `sizeof(PlayerAuthenticationInfo)` 384 (ten 32-byte
`std::string`s + an 8-byte int64 `permissions` + one more string + one UUID + two bools, padded to a multiple of 8)
= 592. **+184 isn't a newly-found value -- it's one already confirmed by execution.** It's the exact offset
`??0PlayerListEntry@@QEAA@AEBVPlayer@@@Z`
reads the uuid from (`docs/findings-containers.md` section 14,
`offsets.PlayerListEntry.uuid` in `candidates-instances`), and that section already confirmed the bot
decodes the result correctly off the wire -- but that confirmation went through the
`PlayerListEntry` constructor (BDS native code), not through the
`UserEntityIdentifierComponent` class itself. This time the class itself was fixed.

**`certificate` is nowhere in the struct.** 2024's +0xd8 falls inside `network_id_`'s own bytes on 1.26
(since that's less than 176 bytes). 1.26 replaced the indirect reference to a certificate object with
**`trusted_player_info_`, held by value** -- whose first field is the XUID string. Since neither build has any
`Certificate*` that would point there, the field was removed.
`Player.getCertificate()` now returns `null` on 1.26 (instead of dereferencing the garbage pointer the 2024 offset
used to point at). `Player.getXuid()` is unaffected -- it already reaches the same XUID string through an
address-shipped native call (`?getXuid@Player@@`).

**Confirmed by execution.** Added a step to `check()` in `tools/origin-probe.ts` that prints `getUuid`/`getXuid`/
`getCertificate` when `actor.isPlayer()` (not opt-in -- this probe already runs in every session). New driver
`origin40/51.ps1` (bot connects → `originprobe` → `kill @a`, two samples). Both builds: **PASS 21/21, 0 FAIL,
tsc 0, exit 0, `Quit correctly`** (`work/host-runs/origin40-20260923-025054.txt`, `origin51-...`).

`getCertificate()` returns `null` on both builds without crashing. `getUuid()` **matches exactly the value
BDS's own sent `player_list` packet, independently decoded by the bot** -- reversing `mce.UUID.toString`'s
byte order (byte reversal + a 16-character rotation) makes every one of the 32 hex characters agree across three
separate sessions (two on 40, one on 51, with a different bot uuid each time):

| Build | `getUuid()` (bdsx) | wire (bot-decoded) | matches after conversion |
|---|---|---|---|
| 40 (1st) | `93f5eb4b-b7f8-364e-bf7d-397c55a206ef` | `4e36f8b7-4beb-f593-ef06-a2557c397dbf` | match |
| 51 | `270449cb-42cb-3b3b-87dc-81dc672d487b` | `3b3bcb42-cb49-0427-7b48-2d67dc81dc87` | match |
| 40 (2nd) | `9745e1c3-d5ae-3b00-b19a-6ef875f8c0eb` | `003baed5-c3e1-4597-ebc0-f875f86e9ab1` | match |

(Conversion: reversing `getUuid()`'s 32 hex characters byte-by-byte and then swapping the front and back 16-character
halves gives a byte-for-byte match with the wire value.) Since `player_list` is a packet BDS fills via
`??0PlayerListEntry@@QEAA@AEBVPlayer@@@Z` and sends via the
`emplace`/broadcast path, this is the first confirmation, going through the class, that
`UserEntityIdentifierComponent.uuid` now reads the same bytes BDS actually uses
(section 4's confirmation didn't go through the class).

**One more spot touched**: `example_and_test/test.ts` called `actor.getCertificate().getXuid()` without a null
check, and once `getCertificate()`'s return type became `Certificate | null`, tsc flagged it (TS2531). Changed that
call site to `actor.getXuid()` -- the same intent as the original comparison (whether it matches
the xuid received at connection), now using an already-working path instead of a blocked one.

**A native constant; Certificate itself is still a separate matter.** `ConnectionRequest.getCertificate()`
(the JSON-based Certificate from the login handshake) and the three names
`ExtendedCertificate::getXuid/getIdentityName/getIdentity`
remain unresolved on both builds -- a different object/different problem from
`UserEntityIdentifierComponent`, and out of scope for this item (untouched, no regression).

## 12. `Packet.getName()` and `InventoryTransactionPacket.transaction` (Q5-4, rest of Q5-3, 2026-09-23)

The last two items section 7 left open. `getName()` was the same slot problem as `getId()`, and the trampoline was
miswritten once, killing the server, before being fixed. `InventoryTransactionPacket.transaction` wasn't an address
problem but a case where **the offset was pointing at an entirely different field**, and it could not be confirmed by
execution (there's no way to trigger it).

### `getName()` -- the same slot as getId, the trampoline was miswritten once

`Packet` vftable slot 2 (Endstone `packet.h`: `~Packet, getId, getName, ...`) has no out-of-line copy on
1.26, just like getId (no `?getName@*@@` decorated name appears anywhere in either build -- the entire packet
family inlined the getId/getName pair the same way). What's different is the **return type**: 2024 had `std::string`
(sret), while 1.26 has `std::string_view` (pointer+length, 16 bytes, likewise over 8 bytes so it's sret under the
MSVC x64 ABI rules). `CxxStringView` (`bdsx/nativetype.ts`, already used by
`CompoundTag::get/remove/contains`) reads the sret buffer as `{data@0, size@8}`, so there's no need to worry about
string copies or destructors.

**The first attempt got the trampoline's registers wrong.** Working from getId's asm
(`mov rax,[rcx]; jmp [rax+8]`), it assumed "with `structureReturn`, the sret pointer is rcx and `this` gets pushed to
rdx" and wrote `mov rax,[rdx]; jmp [rax+16]` -- **backwards.** Looking at how
`bdsx/bdsx/makefunc.ts` generates JS→native code (`paramPairs`), `options.this` is pushed
first and `structureReturn`'s `retVar` comes after: `this` gets the **rcx** slot, the sret pointer gets **rdx**
(even for a member function with no arguments that returns via sret, `this` still occupies the first slot and sret
is inserted after it -- unlike the free-function rule of "sret is rcx"). The wrong version misread the sret buffer
(stack scratch memory the caller hadn't written anything to yet) as a vtable pointer and jumped to `[garbage+16]`.

**Reproduced immediately on both builds**: both the `pk40`/`pk51` sessions got as far as `form-resolved: PASS` but
then died with `exit code: -1073741819` (0xC0000005) right after -- specifically, the instant the bot's
`BP_CHAT`-sent `bdsxpass1` chat (auto-sent at t+30s) went through `checkFields` and called `pk.getName()` for the
first time -- with no crash report block (outside `bdsx-core`'s `__except`, the last row of
`docs/lab-runbook.md` section 5). This died before `pkprobe sendtext` (the command
that explicitly calls `getName()`) even ran, so what helped narrow down the cause was **the bot's
independently-sent automatic chat**.

The fixed trampoline has exactly the same shape as getId's (only the offset changes, 8→16), and since `this` is
still rcx there's no register to change: `mov rax,[rcx]; jmp [rax+16]`. Re-run on both builds: **PASS** (see
"Execution" below).

### `InventoryTransactionPacket.transaction` -- 0x58 wasn't relocated, it was a different field all along

`playerDropItem`'s `packetBefore(InventoryTransaction)` path (`bdsx/bdsx/event_impl/entityevent.ts:525`)
reads `pk.transaction`. bdsx, still following 2024's flat struct, was reading `+0x58` as
`unique_ptr<ComplexInventoryTransaction>` -- but **1.26 put an entirely different field there.**

Endstone's `inventory_transaction_packet.h` (v0.11.7=1.26.40.8, HEAD=1.26.51.1, with offset comments on
every member) gives the order of `InventoryTransactionPacketPayload` (a value member embedded at packet+0x30):
`legacy_request_id` (+0, packet+0x30 -- unchanged), `legacy_set_item_slots` (vector, +16=packet+0x40), a **newly
added**
`std::variant<NormalTransactionData, InventoryMismatchData, ItemUseInventoryTransaction,
ItemUseOnActorInventoryTransaction, ItemReleaseInventoryTransaction> variant_transaction` (+40=**packet+0x58**
-- the exact spot bdsx has been reading as the unique_ptr), and a **relocated**
`unique_ptr<ComplexInventoryTransaction>
transaction` (0.11.7 +312=packet+0x168, HEAD +320=packet+0x170 -- HEAD is 8 bytes larger because
the `ItemUseInventoryTransaction` alternative has one more field, `HandSlot hand_`, see "left for later" below).

**In other words, bdsx has been misreading `variant_transaction`'s tag+union bytes as
`ComplexInventoryTransaction*`.** The null check (`if (transaction === null) return`) means it
wouldn't always crash, but whenever the bytes there are non-zero (which is common for a variant's tag/first-alternative
data), it amounts to dereferencing an invalid pointer -- **it simply was never observed because it has never actually
been triggered by a real InventoryTransaction packet.**

**Confirmed by two static routes** (not confirmed by execution, see "not confirmed by execution" below):

1. **Header**: exactly the offsets above.
2. **Binary**: `InventoryTransactionPacketPayload`'s real destructor (the call target the packet's own destructor
   invokes, 40 `0x241a80` / 51 `0x2da460`) does exactly the standard `unique_ptr` null-check + `vft[0](1)` delete
   pattern after `movq 0x138(%rcx),%rcx` / `0x140(%rcx),%rcx` -- the offsets match the header's +312/+320 byte for
   byte. The same function also reads the variant's index byte via `movzbl 0x130(%rsi)`/`0x138(%rsi)`
   (packet+0x160/+0x168, the end of variant_transaction). The packet's own scalar deleting
   destructor (40 `0x241af0` / 51 `0x2da4d0`) does sized delete via `movl $0x180,%edx` /
   `$0x188,%edx`, which matches Endstone's `BEDROCK_STATIC_ASSERT_SIZE(InventoryTransactionPacket, 384, ...)` /
   `(392, ...)` exactly -- including that the payload starts at packet+0x30 (`addq $0x30,%rcx`), every offset in
   this section has been verified in both actual binaries.

Shipped as `offsets.InventoryTransactionPacket.transaction` in `data/candidates-instances-<v>.json` (40: 360=0x168,
51: 368=0x170), merged into `layouts.InventoryTransactionPacket`,
and read by `bdsx/bdsx/bds/packets.ts` as `pdbcache.layouts.InventoryTransactionPacket?.transaction ?? 0x58`.

### What the scope narrowed to -- `ComplexInventoryTransaction`/`InventoryTransaction`/`InventoryAction`/`InventorySource`

Endstone's `complex_inventory_transaction.h`/`inventory_transaction.h`/`inventory_action.h`/
`inventory_source.h` are **byte-identical** between v0.11.7 and HEAD (per `diff`, except for one
documentation bug where two getter-name lines in `inventory_action.h` are swapped -- the fields themselves are
unchanged). `ComplexInventoryTransaction` keeps the order
`vftable` (+0) / `type_` (uint32_t, +8) / `transaction_` (InventoryTransaction, by value, +16), so
bdsx's current declaration (same order) already places fields at the right offsets -- the only fix was the declared
width of `type` (`uint8_t` → `uint32_t`; with all five enum values under 255 this had no real
effect on offset or value, but it now matches the field's actual width. `data` (InventoryTransaction)'s
auto-computed offset stays at +0x10 either way, due to 8-byte alignment).

`InventoryTransaction` (a 64-byte `actions_` unordered_map + `content` vector at +0x40) /
`InventoryAction` (source/slot/fromDesc/toDesc/from/to order) /
`InventorySource` (3×int32, `static_assert
sizeof==12`) all matched bdsx's current declaration in both field order and type, so they were **left untouched** --
and as a side effect, this destructor disassembly re-confirmed `InventoryTransaction`'s internals once more
(the +0x40 vector, the +0x8/+0x18/+0x28 unordered_map bucket structure)
(the destructor shared by the NormalTransactionData/InventoryMismatchData alternatives, 40 `0x241b30` /
51 `0x2da510` -- a function shared by variant indices 0/1, where `this` is `InventoryTransaction*` itself, not
the packet).

**`ItemUseInventoryTransaction` was left alone -- there's a known difference.** Endstone HEAD added a new
`HandSlot hand_` (uint8_t) field between `slot_` and `item_` (absent in 0.11.7; the header itself says
`// TODO(fixme): check the name`, so even Endstone isn't sure of the name). Whether that
field eats into the following `NetworkItemStackDescriptor item_`'s 8-byte alignment padding (whether the offset
actually shifts, or is absorbed by existing padding) was not confirmed against the binary. Since the path
`playerDropItem` uses, `ComplexInventoryTransaction.Type.NormalTransaction`, never touches
`ItemUseInventoryTransaction` at all (that alternative exists only in `variant_transaction`, and bdsx doesn't
read `variant_transaction`), this doesn't affect the correctness of this fix -- but **bdsx has no code yet that
actually reads `ItemUseInventoryTransaction`/`ItemUseOnActorInventoryTransaction`/
`ItemReleaseInventoryTransaction`** (per `grep`: nothing uses them outside the
declaration file) -- whenever that path is needed next, `hand_`'s exact offset needs to be confirmed against the
binary first.

### Not confirmed by execution -- `InventoryTransactionPacket` has no trigger path

The only natural way BDS produces a real `InventoryTransaction` packet is a human client moving or dropping an
item, and the bot cannot synthesize that packet (as section 10 already saw with a different packet, a synthesized
packet disconnects the server -- this time it wasn't even attempted: `InventoryTransactionPacket` was judged a
bigger synthesis risk than `TextPacket` or `PlayerAuthInputPacket`, being much larger and more tangled). Only a
regression check was done: both builds' `pkprobe report` still PASS (see "Execution" below), and the session
ran from start to finish without crash or exception with the `packetBefore` listener on the `InventoryTransaction`
id (including bdsx's internally-installed `playerDropItem` listener) present among the 705 listeners per session --
though that listener was **never actually invoked** (`InventoryTransaction` isn't among the 10 login-phase ids).

### Execution

Both builds: **16 PASS / 2 FAIL (pre-existing, `authinput-bits`/`entitySneak` -- this is expected on this driver
run without `BP_AUTH_INPUT=1`, section 10 above) + tsc 0 + exit 0 + `Quit correctly`**
(`work/host-runs/pk40-20260923-083049.txt`, `pk51-20260923-083051.txt`). New check: `field-classname` in
`pkprobe report` (`pk.getName() === "TextPacket"` via TextPacket). Regression: all 15 existing
`pkprobe` checks retained. The first attempt (`work/host-runs/pk40-20260923-082601.txt`,
`pk51-20260923-082605.txt`) crashed with 0xC0000005 on both builds due to the trampoline bug noted above.

**Left for later**: `ItemUseInventoryTransaction`'s `hand_` (HEAD-only) exact offset (whenever code that
actually reads that alternative is needed), execution confirmation of `InventoryTransactionPacket.transaction`, and
triggering `entitySneak`/`playerDropItem` (Q7, a human client).

## 7. What's left (next-steps Q5)

- ~~The two send-side items.~~ **Done (section 9, 2026-09-23).** `packetSendRaw` via a
  `BatchedNetworkPeer::sendPacket` hook; `packetSendAll` has no separate place to attach (1.26's broadcast passes
  through the already-existing `packetSend`/`packetSendRaw` as-is).
- ~~Packet class layouts.~~ **All four done**: `TextPacket` (section 8),
  `PlayerAuthInputPacket::getInput` (section 10),
  `Packet.getName()` and `InventoryTransactionPacket.transaction` (section 12, 2026-09-23). `getName()` was
  confirmed by execution as well; `InventoryTransactionPacket.transaction` has only static evidence (header +
  binary destructor) -- execution confirmation is Q7.
- ~~Confirming `entitySneak` by execution.~~ **Done 2026-09-24 with the bot, no human needed**
  (`docs/findings-bot.md`). The 0.5 s disconnect came from the packet's shape, not from the server refusing a
  synthesized packet. The bot now sends a real client's per-tick `player_auth_input` stream (`BP_LIVE=1
  BP_SNEAK=…`). `getInput()` read the sneak bits and `entitySneak` fired `true,false` on both builds
  (`live40`/`live51`, pktprobe 18/18).
- **`playerDropItem`'s `packetBefore(InventoryTransaction)` path is also Q7.** The layout was fixed in section
  12, but it only triggers when a person actually drops an item.

## Certificate: 1.26 moved the login identity into the game server token (2026-09-24)

bdsx's `ConnectionRequest.getCertificate()` and `Certificate.getXuid/getIdentityName/getIdentity` read 2024's
identity chain (`ExtendedCertificate` over its `extraData`). 1.26 has no `Certificate`. Endstone's
`base_connection_request.h` shows the replacement: an optional client-data `WebToken` (skin, device, language), a
`RawGameServerToken`, and the `PlayerAuthenticationType`. By plan-architecture section 4 (c) that makes it `moved`,
not `gone`.

**Read live** (`loginprobe`, `login40`/`login51`): the request's game server token sits at `+0x90` on both builds. Its
JWT payload carries `xid`, `xname`, `identity`, `cpk` (plus `leguuid`/`mid` on 51). The authentication type at `+0xb0`
is 2 (self-signed) for the offline bot.

**Rebound** (`engine/identity.ts`, `layouts.ConnectionRequest`):
- `getCertificate` returns a `Certificate` view of the request.
- The three `ExtendedCertificate` functions are `derived()` readers of the token's claims.
- `getXuid` returns "" for a self-signed login unless the caller trusts it, as 2024's did.
- `getIdentity` packs the uuid string the engine's way (each 64-bit half little-endian).

**Executed** (`certprobe`): the login certificate's name is the player's name, and its xuid equals
`Player.getXuid()` ("") on both builds. On 51 the identity equals the player's own uuid (`PlayerListEntry`). 40 ignores
the token's identity for an offline player and makes up a new uuid every session, so there the claim and the player's
uuid differ. An online login's real xuid was not tested (online-mode is off).

## packetSend for recipient-list broadcasts (2026-09-24)

A simulated player's `PlayerListPacket` add never reached `packetSend` (`findings-containers.md` 14), which
contradicted section 9's "broadcasts pass the existing hooks". The two are different broadcasts.

**Static, both builds.** The table that had shipped as `??_7LoopbackPacketSender@@6B@` (40 `0xa534480` / 51
`0xa6553a0`, a shape match, `findings-slots.md` 3) is not that class's: its slots are not packet senders. It is
retracted in `data/candidates-instances-<v>.json`. The real table was found from the other end. `NetworkSystem::send`
(40 `0xbfe8a0` / 51 `0x93d0d0`) has four callers, and three of them sit in one 11-slot table: **40 `0xa62c2e0` / 51
`0xa71ab10`**. Its slot-0 destructor stores that address into `this`, and the slots line up with Endstone
`packet_sender.h` (dtor, isInitialized, send, sendTo, sendToServer, the two `sendToClient`s in MSVC's reversed order,
`sendToClients`, the two `sendBroadcast`s, flush):

| name | 1.26.40.8 | 1.26.51.1 | body |
|---|---|---|---|
| `?sendToClients@LoopbackPacketSender@@...` (slot 7) | `0x14bdf30` | `0xa43170` | 2024's `ServerNetworkSystem` assert, then a tail jump to `sendToMultiple` |
| `?sendToMultiple@NetworkSystem@@...` (Endstone `network_system.h`) | `0xbfef80` | `0x93d790` | serializes into `this+0x1b0` per sub-client, calls `_sendInternal` per recipient (stride 0xb8); **never calls `send`** |
| `?_sendInternal@NetworkSystem@@...` | `0xbfecf0` | `0x93d500` | callers are exactly `send` and `sendToMultiple` (2024's two); finds the connection for the NI, tail-calls its peer's `sendPacket(data, packet+0xc, packet+0x28)` |

**The hook** (`installSendAll` in `bdsx/bdsx/event_impl/packetevent.ts`) is 2024's `packetSendAllHook`, moved to where
1.26 keeps the loop. `sendToMultiple+0x1c2` is 21 bytes, identical on both builds: the argument setup
`mov r9,[rdi+0x1b0]; mov rcx,rdi; mov rdx,rbx; mov r8,rsi` and `call _sendInternal`. The code checks that the rel32
lands on `_sendInternal` before patching. That span becomes a call to a stub that:
1. passes straight through when off the node thread, or when the packet's `enabledPacket` Send bit is clear;
2. otherwise calls `onPacketSend(id, recipient, packet)`;
3. on CANCEL, skips that one recipient's `_sendInternal`;
4. otherwise redoes the argument setup and calls it.

The 2024 `sendToClients` patch and the `_sendInternal` raw hook now run only on the 2024 path. On 1.26, raw sends
stay at `BatchedNetworkPeer::sendPacket`, so shipping `_sendInternal` does not double `packetSendRaw`. It does give
`RawPacket.sendTo` (`bdsx/rawpacket.ts`) a target again, unchanged: 1.26 builds the header the same way,
`id | subId<<10 | packet[+0x10]<<12` (`sendToMultiple`'s shifts). **Executed on both builds** (`raw40`/`raw51`,
`rawprobe <n>`): a hand-built `SetHealth(n)` sent through `RawPacket.sendTo`. The bot's log reads `health 7` and
`health 13` at those two commands, between the server's own `health 20`s.

**Executed, both builds** (`plsa40`/`plsa51`, `PLIST_PROBE=1 PLIST_CANCEL=simcut`, `plprobe spawn <name>` in
`tools/block-probe.ts`): two simulated players were created, `simbot` and `simcut`. `packetSend(PlayerList)` saw
each add once per recipient (two recipients), and the listener cancelled `simcut`'s. **The bot's own `player_list`
log** holds `bdsxprobe`'s and `simbot`'s adds and no mention of `simcut` at all: the allowed side and the cancelled
side, both in the receiver's log. 5/5 PASS, tsc 0, exit 0, `Quit correctly`. `pks40/51` stayed 6/6
(`work/host-runs/plsa*-20260924-082555.txt`, `pks*-20260924-082742.txt`).

## Kick: `disconnectClient` rebound onto 1.26's `disconnectClientWithMessage` (2026-09-27)

`ServerNetworkHandler.disconnectClient` / `ServerInstance.disconnectClient` (every plugin's kick) called 2024's
`?disconnectClient@ServerNetworkHandler@@...AEBV?$basic_string...@_N@Z`, which has no address on either build.
1.26 renamed it `disconnectClientWithMessage(const NetworkIdentifier&, SubClientId, Connection::DisconnectFailReason,
const std::string&, std::optional<std::string>)`. Endstone's exact `windows.h` gives 40 `0xa5fa60` (v0.11.7,
10877536) and 51 `0x972f40` (HEAD, 9908032); Endstone's own `EndstonePlayer::kick` calls it with
`DisconnectFailReason::Kicked` and `std::nullopt`.

**The bodies (`disas-exact`, both builds, same shape).** rcx `this`; rdx the `NetworkIdentifier` (kept, compared
with each player's by the +0xa8 field); r8b `SubClientId`; r9d the reason, handed to the `DisconnectPacket` payload
builder (40 `0x25eca40`, 51 `0x2aa7330`); the 5th argument (entry+0x28) is the `const std::string&` message, copied
into a local; the 6th (entry+0x30) is a **pointer** to the by-value `std::optional<std::string>` -- string at +0,
engaged byte at +0x20. If engaged the body moves the string out; on exit it destroys the caller's copy (MSVC
callee-destroys; it resets the string to empty SSO but leaves the engaged byte). The payload builder always gets the
message wrapped as an engaged optional, so **no skip-message path is reachable from this entry**: 2024's
`bool skipMessage` is gone, not moved.

**bdsx side.** The binding is `procHacker.js(<the 1.26 decorated name>, void_t, null, ServerNetworkHandler,
NetworkIdentifier, uint8_t, int32_t, CxxString, CxxOptionalToUndefUnion.make(CxxString))`, called with sub-client 0,
reason 0 (`Unknown`, what bdsx passed in 2024) and `undefined` (nullopt). makefunc constructs the optional in stack
space, passes its address, and runs its destructor after the call; with nullopt neither side touches the string, and
even if engaged the second destructor would see the empty SSO string the callee left. `skipMessage` left the TS API of
both `disconnectClient`s (the direction: a concept gone in 1.26 is dropped). bdsx commit `80813af6`.

**Execution (2026-09-27, `kick40`/`kick51` pair, `verify-pair.mjs`, both clean).** `tools/packet-send-probe.ts`
`pksprobe kick` calls `bedrockServer.serverInstance.disconnectClient(bot, "bdsxkick5")`. On both builds: the bot
logged `disconnected {"reason":"unknown","hide_disconnect_reason":false,"message":"bdsxkick5","filtered_message":""}`
and `Server requested disconnect: bdsxkick5`; BDS logged `Player disconnected: bdsxprobe`; `[pksprobe] PASS
left-after-kick: playerLeft fired for bdsxprobe after the kick of bdsxprobe`; tsc 0, exit 0, `Quit correctly`.
Drivers `tools/host/drivers/kick40.ps1`/`kick51.ps1` (bot-360). Not tried: a non-zero sub-client (split screen) and
a filtered message -- the binding always passes 0 and nullopt.

## IP and ping: `getAddress` through `GetSystemAddressFromGuid`, three pings by slot (2026-09-27)

`NetworkIdentifier.getAddress()` called `RakPeer::GetSystemAddressFromIndex` + `SystemAddress::ToString`, and
`RakPeer.GetAveragePing`/`GetLastPing`/`GetLowestPing` had no address on either build.

**RakPeer's table.** `??_7RakPeer@RakNet@@6BRakPeerInterface@1@@` (40 `0xa6dff10`, 51 `0xa7fca30`) has 92 slots on
both builds (88 for `RakPeerInterface` plus a 4-slot tail), against 2024's 97 (93 + 4); upstream RakNet 4.081's
`RakPeerInterface.h` declares 88. 2024 (PDB names) had Mojang extras (`InitializeConfiguration` at 1,
`SetApplicationHandshakeCompleted`, `SendNatTraversalMessage`, `resetMyGUID`, `GetNumberOfAdapters`/`GetLocalAdapter`),
so upstream's count proves nothing by itself; the slots below are each pinned by a body read on both builds
(`disas-exact`), with 1.26 remote systems at `this+0x248`, stride `0x2698`, as in 2024:

| slot | 1.26 body | 2024 |
|---|---|---|
| 30 | copies the 0x88-byte `SystemAddress`, calls the internal lookup with `calledFromNetworkThread=false` | `GetIndexFromSystemAddress` (31), same shape |
| 31 | the 16 bytes at `remote+0x2668` when active and connected (`== 7`) | `GetGUIDFromIndex` (33) |
| 32 | fills two lists from every remote | `GetSystemList` (34) |
| 39 / 40 / 41 | `AddressOrGUID` lookup, then the mean of the five-entry ping history (`+0x25f0`, stride 0x10, `0xffff` = empty) / the entry before the write index `+0x2640` / `lowestPing` `+0x2648`; -1 when no connection | `GetAveragePing`/`GetLastPing`/`GetLowestPing` (43-45) |
| 52 / 53 / 54 | `GetGuidFromSystemAddress` / `GetSystemAddressFromGuid` (below) / `SetTimeoutTime` | 56 / 57 / 59 |

**`GetSystemAddressFromIndex` is gone from the interface**: 2024 had it between `GetIndexFromSystemAddress` and
`GetGUIDFromIndex`, and 1.26 has nothing between slots 30 and 31. Its role moved to `GetSystemAddressFromGuid`
(slot 53; 40 `0x3440370`, 51 `0x343a640`): rcx `this`, rdx the returned `SystemAddress`, r8 a pointer to the GUID;
UNASSIGNED GUID -> `UNASSIGNED_SYSTEM_ADDRESS`; own GUID (`this+0x618`) -> virtual `+0x178`; else the `systemIndex`
hint at guid+8, then a linear search over `+0x2668`, copying `remote+8`. Endstone's
`EndstoneSocketAddress::fromNetworkIdentifier` makes the same call for a RakNet identifier.

**`SystemAddress::ToString(bool writePort, char* dest, char portDelineator)`** is non-virtual: the only user of the
`"%c%d"` literal on each build (`tools/string-users.mjs`; 40 `0x342bbb0`, 51 `0x3426220`, 338 bytes), 2024's
`0x2302ca0` line for line (UNASSIGNED check, `inet_ntop(family, +4|+8, dest, 0x2e)`, then `ntohs(+2)` and
`snprintf(dest+len, 7, "%c%d", delim, port)`). The 2024 hint of a `"%s|%d"` string was wrong: the `|` is the caller's
delimiter argument. `SystemAddress` is still 0x88 (sockaddr union, `debugPort` +0x80, `systemIndex` +0x82).

**bdsx side** (bdsx commit `beac3a12`). `NetworkIdentifier.address` (the `AddressOrGUID` view: GUID then sockaddr) moved
from the 2024 +8 to `layouts.NetworkIdentifier.guid` (+0x18 on 1.26, so the sockaddr lands on `layout.sock` +0x28);
its tail overlaps `type` on 1.26, which only matters to a caller reading `debugPort`/`systemIndex`. `getAddress()` is
`rakPeer.GetSystemAddressFromGuid(address.rakNetGuid).toString()` for a RakNet identifier, the sockaddr's own
`toString()` for Address/Address6, `""` for NetherNet/Invalid. `RakPeer.GetSystemAddressFromIndex` left the TS API
(`data/arch-classes.json`: `moved`, `notRequired`); `GetSystemAddressFromGuid(guid)` replaces it (`jsv`, slot found
at run time). The three ping bindings keep their decorated names.

**Execution (2026-09-27, `addr40`/`addr51` pair, `verify-pair.mjs`, both clean).** `tools/packet-send-probe.ts`
`pksprobe addr`, twice per session with the bot-360 client connected: identifier type 0 (RakNet); `getAddress()` =
`127.0.0.1|64965` (40) / `127.0.0.1|64964` (51); `ToString(false)` = `127.0.0.1`; average/last/lowest ping 0/0/0 ms
(loopback; `lowestPing` starts at 65535 and history entries at `0xffff`, so 0 is a recorded ping, not an empty
slot); the other side: an unknown GUID gives `UNASSIGNED_SYSTEM_ADDRESS` and `GetAveragePing` -1. 12 PASS / 0 FAIL on
each, tsc 0, exit 0, `Quit correctly`. Not checked: the port against the bot's own socket (the two concurrent
sessions got different ephemeral ports, as two clients would), a non-zero ping (needs a remote client), and the
Address/Address6/NetherNet branches (the bot is RakNet).

## setMaxNumPlayers: carried by bdsx where 1.26 inlined it (2026-09-27)

Queue row "Single missing addresses" (A1). `ServerNetworkHandler.setMaxNumPlayers`, `setMaxPlayers` and
`ServerInstance.setMaxPlayers` called `?setMaxNumPlayers@ServerNetworkHandler@@QEAAHH@Z`, which has no address on either
build. `maxPlayers` read the 2024 offset +0x320.

**2024** (1.21.3.01 `0x8976b0`, one caller, `SetMaxPlayersCommand::execute`):
- `count = _getActiveAndInProgressPlayerCount(UUID::EMPTY)`.
- If `n > SharedConstants::NetworkDefaultMaxConnections` (40), the maximum is 40 and it returns 1. If `n < count`, the
  maximum is `count` and it returns -1. Otherwise it is `n` and it returns 0.
- It stores the maximum at `+0x320`. If the value changed, it calls `updateServerAnnouncement()` and slot 5 of the
  object at `+0x1c0`.
- `+0x1c0` is `app_` (`IMinecraftApp&`). The constructor stores it after `my_id_` (+0x110, a `NetworkIdentifier`
  constructor call), `max_chunk_radius_` (+0x1b0) and `minecraft_commands_` (+0x1b8), which is Endstone's member
  order. Slot 5 of DedicatedServer's `IMinecraftApp` table is `onNetworkMaxPlayersChanged`, and its body is empty.

**1.26.** Endstone's `updateServerAnnouncement` (in both tables) has six callers on each build. The one that also calls
`CommandOutput::success` is `SetMaxPlayersCommand::execute` (40 `0x3c646f0` / 51 `0x3b43640`). It inlines the 2024
function step for step:

| | 40 | 51 |
|---|---|---|
| `_getActiveAndInProgressPlayerCount` (called with a copy of `mce::UUID::EMPTY`) | `0xa9bbe0` | `0x9ae640` |
| `max_num_players_` | `+0x3b8` | `+0x3c0` |
| `app_` | `+0x288` | `+0x290` |

- The count function walks the clients map and compares identities with the UUID and with EMPTY, as 2024's
  `0x870660` does. It has three callers on each build.
- The cap is the literal 40 (`cmp $0x29; mov $0x28`). The slot called on `app_` is vtable `+0x28`.
- `mce::UUID::EMPTY` is zero-initialised `.data` on every build, so bdsx passes 16 zero bytes.
- `ListCommand::execute` reads `+0x3b8` on 40. That reader is the witness: the console `list` prints "N/max".

Shipped:
- `?_getActiveAndInProgressPlayerCount@...` as an address.
- `layouts.ServerNetworkHandler.{maxNumPlayers,app}`, `layouts.SharedConstants.networkDefaultMaxConnections` (40) and
  `layouts.IMinecraftApp.onNetworkMaxPlayersChangedSlot` (5).
- `setMaxNumPlayers` as `derived()` over them (`bdsx/bds/engine/networkhandler.ts`, bdsx `514dee64`). It returns 2024's
  1/-1/0, where bdsx's TS had declared `void`.
- `maxPlayers` is now a getter over the same field.

**Executed, both builds** (`maxp40`/`maxp51`, `verify-pair.mjs`, `tools/actor-layout-probe.ts` `maxprobe`, 7 PASS / 0
FAIL each, tsc 0 on the second run (the first had `TS2378` in the new getter and is not counted), exit 0 + `Quit
correctly`; `work/host-runs/maxp40-20260927-191327.txt`, `maxp51-...`):
- The engine's own `setmaxplayers 12` and `10` read back through bdsx's `maxPlayers` as 12 and 10.
- The bot was the one connected player, and `list` answered after each bdsx call:

| bdsx call | return | new maximum | BDS's `list` |
|---|---:|---:|---|
| `setMaxNumPlayers(7)` | 0 | 7 | 1/7 |
| `setMaxNumPlayers(0)` | -1 | 1 | 1/1 |
| `setMaxNumPlayers(100)` | 1 | 40 | 1/40 |

- `app_` holds the pointer to DedicatedServer's table (`??_7DedicatedServer@@6BAppIsland@Bedrock@@@`, which is really
  its `IMinecraftApp` table). Slot 5 of that table starts with `0xc3` on both builds.
- Not checked: the unconnected-ping MOTD. `enable-lan-visibility=false` leaves pings unanswered on the host
  (`findings-host-parallel.md`).

**Seen on the way:** `ServerNetworkHandler.motd` read 2024's `+0x2c8`. Fixed in "getMotd" below, which also found that
`allowIncomingConnections` (so `setMotd`) had no address either.

## getMotd: `serverName` moved, `allowIncomingConnections` found by body (2026-09-27)

Queue row "`ServerInstance.getMotd()`" (A1). `getMotd()` read `ServerNetworkHandler.motd` at 2024's `+0x2c8`. `setMotd`
calls `?allowIncomingConnections@ServerNetworkHandler@@QEAAXAEBV?$basic_string@...@_N@Z`, which had no address on either
build, so both were broken (the row assumed `setMotd` worked).

**2024** (1.21.3.01 `0x883a30`, read in full; callers `Minecraft::hostMultiplayer` and the `MultiplayerSettingsPacket`
handler): set the byte at `+0x2b8` to 1; copy the name, or `""` when the bool is false, into `+0x2c8`; tail-call
`updateServerAnnouncement`. `updateServerAnnouncement` (`0x897d60`) returns unless `+0x2b8` is set and passes `+0x2c8` to
the locator.

**1.26.** Of the six callers of Endstone's `updateServerAnnouncement`, one is a 588-byte function that does the same thing
step for step (`movb $1`, `test r8b`, the copy or an empty string, the assignment, the call). It has two callers, as in
2024. `updateServerAnnouncement` now also returns early while the name is empty:

| | 40 | 51 |
|---|---|---|
| `allowIncomingConnections` | `0xa62e60` | `0x9761b0` |
| incoming flag (2024 `+0x2b8`) | `+0x388` | `+0x390` |
| `serverName` (2024 `+0x2c8`; size at `+0x10`) | `+0x398` | `+0x3a0` |
| `updateServerAnnouncement`: gate, then the name to the locator's slot `+0x18` | `0xa70740` | `0x984130` |

Shipped: the address, and `layouts.ServerNetworkHandler.serverName`. `motd` is a getter over
`engineLayout("ServerNetworkHandler", "serverName", 0x2c8)` (`engine/networkhandler.ts`, bdsx `515ca232`).

**Executed, both builds** (`tools/actor-layout-probe.ts` `motdprobe`, tsc 0, exit 0 + `Quit correctly` in every run).

LAN visibility on, one build at a time (`motdlan40`/`motdlan51` via `session.mjs`, 7 PASS / 0 FAIL each;
`work/host-runs/motdlan40-20260927-212023.txt`, `motdlan51-20260927-212138.txt`). Each driver turns
`enable-lan-visibility` on and restores it in `finally`, so run them alone, as `qrlan40/51`. The probe pings its own
server with `tools/ping-protocol.cjs` as a child process:

| step | `getMotd()` | the engine's ping reply |
|---|---|---|
| boot | `bdsx-again-inst40` / `-inst51` (= `server-name`) | `MCPE;bdsx-again-inst40;2168;1.26.40;0;10;...` / `MCPE;bdsx-again-inst51;2193;1.26.51;...` |
| `setMotd("x")` | `x` | `MCPE;x;...` |
| `setMotd(server-name)` | the name again | the name again |

So the address and its prototype are right: after bdsx's call, BDS itself advertises the new name.

LAN visibility off (`motd40`/`motd51` via `verify-pair.mjs`; `motd40-20260927-211647.txt`, `motd51-...`), 5 PASS / 1 FAIL
each:
- The one FAIL is the boot check. With LAN visibility off, the engine had stored `""` at boot, not `server-name`. That is
  the not-announcing branch, and it is the other side of the boot check above. The drivers say so in a comment.
- `setMotd("x")` and a 49-byte name (the heap path) read back.
- `allowIncomingConnections("unannounced", false)` stored `""`, as 2024 does.
- The flag byte stayed 1.

**Seen on the way:** in the full launcher, a probe's in-process `dgram` socket and its `setTimeout` did not run until
`Server stop requested`: all three pings reported their timeouts at stop (the first `motdlan40`, not counted). A
blocking child process works. Only this one run was looked at, so the cause was not narrowed.

## disconnectAll: 2024's loop over the connections, through the shipped kick (2026-09-27)

Queue row "Single missing addresses" (A1). `ServerInstance.disconnectAllClients(message)` called
`?disconnectAllClientsWithMessage@ServerInstance@@`. Endstone's tables do not list it, and it has no address on
either build.

**2024** (1.21.3.01 `0xc92790`, read in full): for every `unique_ptr<NetworkConnection>` in
`NetworkSystem::getConnections()`, it calls `Minecraft::disconnectClient(connection->id, 3, message)`. Its callers are
`ServerInstance::onLevelCorrupt`, `onCriticalScriptError` and four `std::function` lambdas (disk errors).

**1.26.** Endstone's `disconnectClientWithMessage` (the kick above) has 49 direct call sites on 40. None of them is a
loop over the connections. Mostly they are `ServerNetworkHandler` packet handlers and three small forwarders. The
2024 callers have no table names in 1.26. The corruption strings are there only as a localisation table's SSO
immediates (`disconnectionScreen.worldCorruption`, one 6.9KB initialiser). So no copy was found. The row's fallback
was taken instead: `derived()` does the 2024 loop.
- It walks `layouts.NetworkSystem.connections` (+0xa0) and `layouts.NetworkConnection.id` (+0), both from section 3.
- It copies every id first (`NetworkIdentifier.from` copies into bdsx memory), because a disconnect can change the
  vector.
- It calls the shipped `disconnectClientWithMessage` with sub-client 0, reason 3 as 2024 did, the message, and
  nullopt.

bdsx `0f9de24d` (`engine/networkhandler.ts` `networkConnectionIds`).

**Executed, both builds** (`disc40`/`disc51`, `verify-pair.mjs`, `tools/actor-layout-probe.ts` `discprobe`, 3 PASS / 0
FAIL each, tsc 0, exit 0 + `Quit correctly`; `work/host-runs/disc40-20260927-191838.txt`, `disc51-...`, and the
`.bot.log` next to each). With one connection and the bot in, `disconnectAllClients("bdsxkickall7")` gave:
- the bot logged `disconnected {"reason":"unrecoverable_error","hide_disconnect_reason":false,"message":"bdsxkickall7",...}`
  and `Server requested disconnect: bdsxkickall7`. The reason name confirms that 3 is `UnrecoverableError` on 1.26;
- BDS logged `Player disconnected: bdsxprobe`;
- `playerLeft` fired for the bot;
- 8 s later there were no players and no connections, and `list` said 0/10.

Not checked: more than one client at once (the runner has one bot). The loop does not depend on the count.

## networkDisconnected: `onConnectionClosed` is ConnectionCallbacks slot 3, two arguments longer (2026-10-02)

`events.networkDisconnected` never fired on 1.26, and `NetworkIdentifier`'s `identifiers` set was never pruned:
bdsx hooks `?onConnectionClosed@NetworkSystem@@EEAAX...` (`bds/networkidentifier.ts`), which neither table had.
`tools/event-coverage.mjs` scans `event_impl/` only, so it never listed this event.

**Where it is.** 2024's `ServerNetworkSystem` ConnectionCallbacks vftable (`0x2c60e38`) holds `0x821780` in slot 3,
which is the 2024 name. Endstone's `connector.h` declares `onConnectionClosed` as the fourth `ConnectionCallbacks`
virtual (destructor, two `onNew*Connection`, then this one). Slot 3 of `??_7ServerNetworkSystem@@6BConnectionCallbacks@RakNetConnector@@@`
is 40 `0xbfc8c0` and 51 `0x93b1a0`. Both are `.pdata` starts and 947 bytes long.

**The body is 2024's, and the signature grew.** Both builds do the same steps as 2024:
- lock the recursive mutex at `+0x50`;
- walk `connections_` (`+0xa0`/`+0xa8`), comparing the NetworkIdentifier type at `+0xa8` and then `equalsTypeData`;
- flag the found connection at `+0x198`;
- unlock, then call the four callbacks at `+0x1b8..+0x1d8`, through slot 8 when the connection was found and slot 3 when it was not.

The stack arguments match Endstone's six-argument signature: `(NetworkIdentifier const&, DisconnectFailReason,
string const& message, string const& bodyOverride [rsp+0x28], bool skip [rsp+0x30], Json::Value const& summary
[rsp+0x38])`. 2024 had five. Because the decoration is unknowable, the table ships the function as
`bdsx:NetworkSystem::onConnectionClosed`. The four register arguments are unchanged, so bdsx's raw hook reads only
those and leaves the stack to the original (bdsx `7911f87b`).

**Executed** (`tools/console-probe.ts`, which listens to `networkDisconnected` and `playerLeft`; `conprobe ndc` prints
the totals):

| driver | trigger | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `ndcl40/51` | the bot leaves on its own (`-BotSecs 14`) | 1 event, 1 `playerLeft`, identifier gone from `NetworkIdentifier.all()` 4 s later | same |
| `ndck40/51` | console `kick @a ndc` | same | same |
| `kick40/51` | bdsx's `disconnectClient` (`pksprobe kick`) | 1 event, identifier dropped, `left-after-kick` PASS | same |
| `jlmig40/51` | three fresh boots, each with one join and one leave | 3/3 joins, every stop exits 0 | same |

The event fires inside the callback loop, before BDS logs `Player disconnected`. By that point RakNet has already
forgotten the peer, so `ni.getAddress()` returns `UNASSIGNED_SYSTEM_ADDRESS`. A plugin that wants the address has to
read it at join. Regressions on both builds after the change: `layout` 41/0, `pk` 16/2, `lb` 36/0, the same as before.
