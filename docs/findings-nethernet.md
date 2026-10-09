# NetherNet: bdsx with clients that connect over WebRTC

Started 2026-10-03 at the user's request: Mojang says RakNet goes away after 1.26.51, and NetherNet replaces it.
NetherNet is Minecraft's WebRTC transport: DTLS/SCTP data channels, with signalling over LAN UDP, Xbox services, or
(the partner guide, https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/) HTTP
`POST /v1/join/{networkId}`. On 2026-10-03 the protocol docs list 1.26.60-preview.29 (protocol 2223) as the latest;
no stable 1.26.60 BDS exists yet. Before this, `findings-survey.md` "NetherNet: 1.26.51.1's default transport" had
covered only boot: bdsx refused NetherNet's connector, and no NetherNet client had been tested.

## 1. The transport on the two builds

- **Both builds have NetherNet.** 1.26.51.1's stock `server.properties` has `transport=nethernet`, and 1.26.40.8's
  has `raknet`. Both binaries contain `NetherNetConnector`, `SimpleNetworkInterfaceImpl`, LAN signalling ("Enabling LAN
  signaling") and an `HttpSignalingServer` (`/v1/join`, "Expected /v1/join/{networkId}"). Only 1.26.51.1 prints "In
  this release, NetherNet is the only supported transport type".
- **LAN signalling** answers discovery on UDP 7551. It needs `enable-lan-visibility=true`, which also opens
  19132/19133 for RakNet discovery, so a NetherNet session runs with the other instance idle (the drivers hold the
  other instance's lock in `work/locks/`).
- The server's ICE host candidate is on **`server-port`** (UDP 19134 on inst51, in the server's answer).
- **Discovery advertisement:** version 7 on 1.26.51.1 and version 6 on 1.26.40.8. bedrock-protocol 3.60.1 has no v6
  schema, so its ping dropped 40's replies and never learned the server's network id (`Invalid nethernet.networkId`).
  `tools/livebot.cjs` now turns an unreadable advertisement into an empty one, because only the sender id is needed.
- **NetworkID** is `std::variant<std::monostate, P2P::NetworkID (u64), Realms::NetworkID (UUID)>`: 16 bytes of
  storage, the index byte at +16, 24 in all, on both builds. `ReceiveFromSignalingChannel` switches on
  `movzbl 0x10(%rdx)`. A live P2P id had **other bytes** in the unused half of the storage and in the padding after
  the index, for example `bf6010716ddce924 78590e0012020000 01 55f214f67f0000`.

## 2. The test client

`tools/livebot.cjs` with `BP_TRANSPORT=nethernet`. This is bedrock-protocol 3.60.1's own NetherNet client: the
`nethernet` 1.1.2 package, werift (pure JS WebRTC), LAN signalling to `<host>:7551`. It was already in
`C:\bdsx-again\bot-360`. Both packages declare Node >= 24, but the host's Node 20.20.2 ran it without trouble.
Encryption is off and there is no batch header over NetherNet (bedrock-protocol's client sets both). Drivers:
`nn40`/`nn51`. Each sets `transport=nethernet` and `enable-lan-visibility=true` for the session and restores
`server.properties` in a `finally` block (checked after the runs). The probe is `tools/nethernet-probe.ts`
(`nnprobe report|chat|kick`).

## 3. What worked before any change (nn51, first run)

With the unmodified bdsx, a NetherNet client on 1.26.51.1:
- joined;
- fired `packetRaw/Before/After` for Login, Text and PlayerAuthInput, and `playerJoin`/`playerLeft`;
- received `Player.sendChat`;
- was kicked by `disconnectClient` with its message;
- was handed over as one `NetworkIdentifier` object (type 3) across about 1,000 events.

So everything above the transport (the dispatcher, `NetworkSystem`, `BatchedNetworkPeer`, the identifier map) is
transport-agnostic, as expected.

Two things did not work:
- `getAddress()` returned `""`.
- bdsx's NetherNet `equals`/`hash` compared all 24 bytes. Only one object came out because every copy came from the
  same storage, so that was luck.

## 4. Identifier equality

`bds/engine/nethernetid.ts`: the key is `<index>:<active bytes>`, which is 8 bytes for P2P, 16 for Realms and none
for monostate. `equalsTypeDataByLayout` and `hashByLayout` use it. The layout is `NetherNetNetworkID.index` (16) on
both builds. A table without it (2024) keys the bare u64.

## 5. The address: Endstone's route, as native hooks

Endstone HEAD (0c7cf5e, Apache-2.0) `NetherNetAddressCache` joins two layers on the client's ICE username fragment:
- **`NetherNet::SimpleNetworkInterfaceImpl::ReceiveFromSignalingChannel(NetworkID, string_view, SignalingChannelId)`**
  - 51 `0x112d1c0` (Endstone windows.h); 40 `0x120ad50`, the only `lea` user of its log string.
  - Body: rdx is the NetworkID (by reference), r8 the string_view, r9d the channel. It logs
    `"received signal from [%s]: %.*s"`.
  - The client's `CONNECTREQUEST <conn> <sdp>` carries `a=ice-ufrag:`. `CANDIDATEADD` arrives through the same function.
- **`webrtc::P2PTransportChannel::SwitchSelectedConnectionInternal(Connection*, IceSwitchReason)`**
  - 51 `0xa35b610` (Endstone). On 40 it is at `0xa23c6f0`: the byte run `mov r15,[rcx+0x528]; mov [rcx+0x528],rdx`
    occurs once per image, at function+0x4f on both.
  - Body: it stores the new selected connection at this+0x528, then calls `[vftable+0x10]` on it, which is
    `remote_candidate()` (slot 2), and hands the result to `SignalRouteChange` as a `Candidate&`.
- **`webrtc::Candidate` (MSVC)** follows Endstone's `candidate.h`: `address_` at +104, IPAddress family +144, the
  address bytes +148, port +168, `username_` +192.
  - Shipped as `layouts.WebRtcCandidate` and `layouts.WebRtcConnection.remoteCandidateSlot`.
  - The live reads match: family 2, the bot's host candidate and port, and a 4-character ufrag equal to the one in
    the client's offer.

**Both functions run on NetherNet threads**, where V8 cannot be entered. So `bds/engine/nethernet.ts` installs native
hooks (`procHacker.hookingRaw` plus asm) that write into fixed rings of 64 slots:
- The slot is chosen by `lock xadd`. The slot's sequence word is cleared first and written last.
- A signal slot holds the NetworkID and the message's first 4,056 bytes.
- A candidate slot holds the candidate's first 256 bytes, plus the username's characters when they are on the heap.
- Then the hook jumps to the original.

JS reads the rings on the node thread when an address is asked for, and once a second (`setInterval(...).unref()`).
It parses the ufrag and joins it to the address in bounded maps of 256, so a flood of signals cannot grow them.
`getAddress()` returns `"ip|port"`, the same form as RakNet's.

**An assembler bug found on the way.** bdsx's `_shift_r_c` wrote the register number unmasked into the ModRM byte.
For r8 to r15, the fourth bit landed in the `/digit` field, so `shl r10, 12` assembled as `shr r10, 12`, and every
signal went to slot 0. The second run showed this: slot 0 had sequence 2 and slot 1 was empty. Fixed with `dest & 7`
(bdsx `4d08cf1b`). The only other user, `crashcapture.ts`, shifts rdx, which was unaffected.

**Rule earned:** before running hand-built asm on the host, assemble it locally and disassemble it. Bundle
`bdsx/assembler.ts` with esbuild (stub `colors`/`source-map`), then `llvm-mc --disassemble`.

## 6. Execution (2026-10-03)

| run | build | result |
|---|---|---|
| nn51 #1 | 1.26.51.1, bdsx before the change | join, events, chat both ways, kick: all fine; `getAddress()` `""` |
| nn51 #2-3 | 51, hooks in | hooks installed and fired, no crash, `Quit correctly`; signals recorded but not joined (the shl bug) |
| nn51 #4, final | 51 | `getAddress()` = `"<host-ip>\|63959"` (then `\|64086`), recorder 2 signals / 1 candidate / 1 address; 10 PASS 0 FAIL |
| nn40 #1 | 40 | bot never joined: advertisement v6 (section 1) |
| nn40 #2, final | 40 | `"<host-ip>\|64025"` (then `\|64147`); 10 PASS 0 FAIL; chat both ways and the kick message in the bot log |
| addr40/51 | both, RakNet | 12 PASS / 0 FAIL each, the same as before (RakNet getAddress and ping unchanged) |
| pk40/51 | both, RakNet | 16 PASS / 2 FAIL each, the known baseline |

The address is the client's ICE host candidate. The bot runs on the host, so this is the host's public interface,
not 127.0.0.1. For a client behind NAT it is whatever candidate ICE selects (srflx or prflx), which is the same
answer Endstone gives.

## 7. Not done

- **Ping over NetherNet.** RakPeer's ping has no NetherNet counterpart in bdsx. The route would be the selected
  connection's RTT (webrtc `Connection::rtt()`), which is new work.
- **HTTP signalling**: done 2026-10-03, section 8.
- **A real Minecraft client, more than one client, IPv6.** IPv6 is formatted without `::` compression.
- `bedrockServer.connector`/`rakPeer` stay unavailable under NetherNet. `net-ping.ts` still fails to load.

## 8. HTTP signalling (2026-10-03)

This is the partner guide's route, and presumably the one left once RakNet is gone.

**Where it listens.** `nnlisten51` ran inst51 with `transport=nethernet` and no client, and a background job listed
the server's sockets. The server listens on **TCP `server-port`** (`:::19134`), and UDP 7551 is open even with
`enable-lan-visibility=false`. Endstone's `getSignalingPort` reads the same port from `HttpServer.port_`.
- `GET /v1/join` answers 200 with an empty body: `application/json` on 51, `text/plain` on 40.
- `GET /v1/join/` answers 404.
- The console printed "Signed in to signaling service successfully" at boot, in offline mode.

**The client.** `tools/livebot.cjs` with `BP_SIGNALLING=http`:
- bedrock-protocol's NetherNet client gets an external `signalHandler`.
- The `CONNECTREQUEST` offer is POSTed as `application/sdp` to `http://<host>:<server-port>/v1/join/<client network id>`.
- The answer goes back in as a `CONNECTRESPONSE`.
- `CANDIDATEADD` is dropped: there is no trickle ICE, and the offer already carries its candidates.
- There is no discovery. A placeholder server id passes bedrock-protocol's options check. If `connect()` already
  parked itself waiting for a LAN reply, the handler starts the offer itself.

**Identity.** Without an `a=identity` attribute, the POST answers **200 with the body `37`**, which is
`ErrorCodeIdentityNotAllowed` (nethernet's `identity.js`). A real client signs the offer's DTLS fingerprints, as a
detached ES384 JWS, with the key that its Minecraft-services multiplayer token names in the `cpk` claim. The bot has
no such token. It builds a **self-signed** ES384 JWT whose `cpk` and `x5u` are its own login key, signs the
fingerprints with that key, and attaches the result through nethernet's `attachIdentity` (`BP_NN_IDENTITY=self`, the
default). The offline server (`online-mode=false`) accepted it on both builds. The answer carries the server's own
`a=identity`. It is not known whether an online-mode server would refuse it; presumably it would.

**Execution.** `nnh51` and `nnh40` run with LAN visibility off and `transport=nethernet`. Each passed 10 PASS /
0 FAIL. `getAddress()` returned `<host-ip>|64209` (51) and `|64269` (40), so the signal hook sees HTTP offers as
it sees LAN ones. Chat went both ways, and the kick message reached the bot. The exit was clean, with
`Quit correctly`.
