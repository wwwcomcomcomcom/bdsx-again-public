# Instances, and the constructors behind them

Done 2026-09-17, on 1.26.40.8. The 29 symbols the full `launcher.ts` needs
are constructors and non-virtual getters, which no vftable holds and
call-edge propagation never reached (1 of 29 after the vftable work). This
is the route that reaches them, and it is exact at every step but one.

## Read, do not infer

Every resolved method that takes `this` hands over an instance when it runs.
`tools/instance-probe-launcher.js` hooks the resolved ones with twelve bytes
of native code that store `rcx` (or `rdx`) and jump on, so nothing
non-native runs on the game thread, and reads back after 200 ticks and
again after a driven `stop`:

| hook | hands over | when |
|---|---|---|
| `CommandRegistry::registerCommand` | `CommandRegistry*` | startup |
| `ServerNetworkHandler::updateServerAnnouncement` | `ServerNetworkHandler*` | periodic |
| `Level::tick` | `Level*` | every tick |
| `MinecraftCommands::executeCommand` | `MinecraftCommands*` | the stop command |
| `Command::run` | `CommandOrigin*` (rdx) | the stop command |
| `DedicatedServer::stop` | `DedicatedServer*` | stop |

`*(void**)instance` is the class's vftable, exactly. The first sixteen
qwords give the tables of every base subobject with its offset, and a scan of
the object's first 0x300 bytes for pointers to other vftable-carrying objects
gives its members. That member scan is what reached the classes no resolved
method touches: **ServerNetworkHandler holds the `GameCallbacks&` it was
constructed with at +0xe0**, and **DedicatedServer holds a 7-slot object at
+0x18**, Minecraft's size.

Names come from slot counts against the baseline, which is the one inferential
step; it is unambiguous where the count is distinctive (Minecraft 7,
ServerCommandOrigin 32→34, DedicatedServer's AppIsland 8→10) and checked
below by the constructor's behaviour where it is not.

The layout has moved since 1.21.3.01, which `launcher.ts` did not expect:
the 253-slot `NetEventCallback` table sits at +0x10 in ServerNetworkHandler
where the 3-slot `EnableQueueForMainThread` used to, and ServerInstance no
longer derives `GameCallbacks` -- it holds an 11-slot GameCallbacks object at
+0xd0 that Minecraft and ServerNetworkHandler reference. `data/candidates-
instances-1.26.40.8.json` records the layouts.

## From a vftable to its constructor

Every polymorphic constructor does `lea rax,[rip+vftable]` / `mov [this],rax`,
and so does the destructor. `tools/ctor-from-vftable.mjs` lists the functions
that reference a table and marks a destructor structurally (slot 0 of the
table, or called by slot 0). Validated on 1.21.3.01: 8 of 8 classes give the
`??0` constructor, one destructor mislabelled because its deleting destructor
inlines the body. The decisive tell is not structural but temporal: **a
constructor fires once by tick 200 and its neighbour zero; after `stop` the
neighbour fires.** Counter probes measure exactly that.

| class | table from | constructor | probe at tick 200 / after stop |
|---|---|---|---|
| DedicatedServer | `this` of `stop` | 0x78800 | 1 / dtor 0 → (after main) |
| MinecraftCommands | `this` of `executeCommand` | 0x38e700 | 1 / deleting dtor 0 → 1 |
| ServerNetworkHandler | `this` of `updateServerAnnouncement` | 0xa58530 | 1 / dtor 0 → 1 |
| ServerLevel | `this` of `tick` | 0x6a8ee0 | 1 / dtor 0 → 1 |
| Minecraft | 7-slot member of DedicatedServer | 0x2e3170 | 1 |
| ServerInstance | holder of the GameCallbacks object at +0xd0 | 0x66e6a0 | 1 |

Two of them have a second, independent confirmation from the call graph
(`tools/spine.mjs`): the DedicatedServer constructor is called from `main`
between `AppPlatform::initialize` and `DedicatedServer::start`, in the same
position as `??0DedicatedServer` in the baseline -- and the propagation pair
that had named it `??0AppConfigs` was wrong. The captured Minecraft instance
owns the MinecraftCommands object (+0xb8) and references the GameCallbacks
object (+0xf8), which is what a Minecraft is.

The other four are reached only through indirect calls in this build (no
`E8` caller anywhere), which is why the spine walk and propagation could not
place them, and why the runtime tell was needed.

## Carried to 1.26.51.1

Two builds a few weeks apart pair far better than either pairs with
1.21.3.01: string anchoring plus propagation from 1.26.40.8 to 1.26.51.1
gives **19,203 pairs**, and on the 11 names both resolved tables hold it is
**11 of 11**. That placed six of the seven constructors and
`updateServerAnnouncement` directly. Minecraft and MinecraftCommands are
called only indirectly and stayed unpaired, and came from the member scan of
the captured ServerInstance as before.

| class | 1.26.51.1 constructor | evidence |
|---|---|---|
| DedicatedServer | 0x78890 | pair; live vptr; fired once |
| ServerNetworkHandler | 0x96b9b0 | pair; same object `updateServerAnnouncement` hands over; fired once |
| ServerLevel | 0x76ab70 | pair, and the vftable-store tool independently; fired once |
| ServerInstance | 0x72e7a0 | pair; same four base tables (1, 20, 10, 5); fired once |
| ServerNetworkSystem | 0x13e21b0 | pair; same four base tables (1, 8, 5, 3); fired once |
| Minecraft | 0x3779f0 | 7-slot member at ServerInstance +0xb8; fired once |
| MinecraftCommands | 0x3dd4b0 | 1-slot member at Minecraft +0xc0, same adjacency as 1.26.40.8; not probed |

One layout moved: MinecraftCommands sits at Minecraft +0xc0 on 1.26.51.1
against +0xb8 on 1.26.40.8, which is why the offset travels in
`symbols.json` as `layouts` rather than in code.

The driven `stop` does not take on 1.26.51.1 under the probe launcher (the
game loop never returns), so the stop-time captures are empty there and
`DedicatedServer::stop` (paired at 0x7a410) is unconfirmed.

## Constructors from held tables (2026-09-18)

`docs/next-steps.md` step 4: of the 32 required constructors still missing,
five classes' tables were held (`ActorCommandOrigin`, `ServerCommandOrigin`,
`VirtualCommandOrigin`, `UpdateAbilitiesPacket`, `CompoundTag`), so
`tools/ctor-from-vftable.mjs` was run on them. On the PDB build the tool's
"referencing functions" are the constructors, the destructors and every
caller that inlined one (`clone`, `load`, `make_unique`, `putCompound`), so
the candidate is picked by its body against the PDB-named baseline body --
same field offsets, same constants, same callee shape -- and then executed.

| name | 1.26.40.8 | 1.26.51.1 | how it was told apart | executed |
|---|---|---|---|---|
| `??0ServerCommandOrigin` | 0x12e5a60 | 0x1208410 | level at +24, request id at +32, permission at +64, dimension at +68, as in 0xcbb760 | **once at level start, then exactly once per console command: 12 for 1 + 11, on both builds** |
| `??0VirtualCommandOrigin(CommandOrigin const&, Actor&, ...)` | 0x12eb9b0 | 0x120ce80 | +24/+32/+40 zeroed, origin slot 10 into +48, the position into +56, the stack int into +72, `getEntityTypeId == 319` picks a 40-byte inner origin, as in 0xcbc740 | no: its one caller did not run; `execute as` goes through the `unique_ptr` overload in 1.26 (fired 1 and 2 there) |
| `??0VirtualCommandOrigin(CommandOrigin const&, CommandOrigin const&, ...)` | 0x12eb700 | 0x120ccc0 | called by the named `?clone@VirtualCommandOrigin@@`, as in the baseline | fired under `execute as` (1, then 2) |
| `??0CompoundTag()` | 0x1bec220 | 0x284d030 | zero +8..+24, allocate and self-link the 112-byte head, word 257 at +24, as in 0x82f220; 5 callers because it is inlined into 622 functions; cross-build pair | no (its 5 callers did not run; `save hold` did not reach it) |
| `??0CompoundTag(CompoundTag&&)` | 0x1bec2c0 | 0x284d0a0 | adjacent to the default constructor as in the baseline; a fresh head for the source, then +8/+16 swapped | once at startup |
| `??1CompoundTag` | 0x1bec3b0 | 0x284d160 | store the table, erase the tree, free the head; 347 / 346 callers | twice |

The counter probes gave the same counts on both builds for every one of the
eleven functions probed, which is the cross-build consistency the rest of
this project has leaned on. `ServerCommandOrigin`'s constructor is in
`data/resolved-<v>.json` with its execution; the others ship from
`data/candidates-ctors-<v>.json`, a source `tools/merge-symbols.mjs` never
trusts for hooks (none of these is a hook target: they are all `js` calls).

Two things the tables held turned out not to exist as functions:

- **`??0ActorCommandOrigin(Actor&)` is inlined into all three of its 1.26
  callers** (the `VirtualCommandOrigin(Actor&)` constructor, the origin
  loader, and a 3.9 KB command body) on both builds. What every copy does is
  four stores into a 40-byte object: the table, a fresh UUID at +8, the
  actor's `getOrCreateUniqueID()` at +24 and its `getLevel()` at +32 --
  exactly the 2024 body at 0xcb9d20. That is a body whose memory accesses
  are into a layout bdsx declares (`findings-utils.md`'s rule), so bdsx now
  carries it (`derived()` in `bds/commandorigin.ts`), together with
  `Crypto::Random::generateUUID`, which the same builds inline into every
  `CommandOrigin` constructor (`mce.ts` draws the 128 bits itself).
  `data/derived.json` records both; `tools/origin-probe.ts` checks them from
  a client's `/originprobe`, whose own origin hands over a live actor. The
  UUID draw passed on both builds (two draws differ, 16 bytes; and it exposed
  that bdsx's `bin.fromBuffer` drops every odd byte, so the words are packed
  by hand). **The constructor is executed:** once a client could join (below),
  the probe took the `ServerPlayer` from bdsx's own `playerRespawn` hook
  (`Player::respawn` is execution-confirmed) and called the real vftable on
  the object bdsx built -- `getEntity()` is the actor, `getLevel()` is the
  level, `getOriginType()` is 8 (Entity), `getName()` is the player's name,
  the UUID is nonzero and the id at +24 is the actor's. (`getDimension()`'s
  check could not compare: `?getDimension@Actor@@` has no address.) A
  client-sent `/originprobe` is still open: the bot's `command_request` is
  rejected by the server, and the 1.26 protocol data types its fields as
  strings.
- **`??0UpdateAbilitiesPacket(ActorUniqueID, LayeredAbilities const&)` no
  longer exists with that prototype.** The 1.26 packet holds a
  `SerializedAbilitiesData` (Endstone's header: id, two permission bytes, a
  vector of layers) and its constructor takes that by rvalue: 0x31ab8c0 /
  0x12eeba0 (packet header, table, the data moved in, serialization mode 1)
  fired once when the client joined. Endstone builds the packet from
  `createPacket` and assigns `data = {id, abilities}` from a constructor it
  writes itself over `LayeredAbilities::forEachLayer`; bdsx's
  `Player.syncAbilities` needs the same rewrite, which is engine layout, not
  ours, and is left open. The two 75-byte 2024 constructors are gone; what
  stores the table at 125 bytes with 16 callers is the destructor.

Byproducts: the default constructor's cross-build pair placed the
**`CompoundTag` table on 1.26.51.1** (0xa7b0e30, 11 slots), which the carry
had not aligned, and Endstone's `Tag` header order then named `equals`,
`getId` and `toString` on both builds (`tools/endstone-slots.mjs`, family
`tag`). The inlined `getLevel()` read (`actor+0x1d8` into the origin's +32,
on both builds) is a second static route for `?getLevel@Actor@@` at 472 on
1.26.51.1, beside Endstone's field order, so that accessor ships there now.

## The full launcher and a client (2026-09-18, late)

Every client run before this one used a probe launcher; bdsx's own
`launcher.ts` had only ever been driven from the console. With a client it
died at `Player connected` on both builds, with the examples loaded or not:

```
[ Native Crash ]
Last packet from IP: 127.0.0.1
[ JS Stack ]
Error: Symbol not found: ?getHash@NetworkIdentifier@@QEBA_KXZ
   at NetworkIdentifier.prototype.hash (bds/implements.ts:2006)
   at HashSet.prototype.get (hashset.ts:65)
   at NetworkIdentifier.setResolver (bds/networkidentifier.ts:160)
   at resolverGetFromParam (nativeclass.ts:691)
   at onPacketSend
```

Three things stacked up, none of them the raw packet hook the previous note
suspected:

1. **The `NetworkSystem::send` hook reads a flag table sized by 2024's packet
   id range.** `PACKET_ID_COUNT` is 0x140; 1.26.40's ids run to 350
   (Endstone's `packet.h`, `EndId = 351`). A new packet at join indexed past
   `enabledPacket`, hit a stray nonzero byte, and the hook called
   `onPacketSend` with no listener registered.
2. **Marshalling the `NetworkIdentifier` parameter needs its hash.** The
   resolver keeps one JavaScript object per identifier through a `HashSet`,
   whose `hash()` called `?getHash@NetworkIdentifier@@` -- no address on
   these builds. The throw happened while the native call was still building
   its arguments, so no `try` on the JavaScript side could catch it, and the
   process went down.
3. **The identifier's layout moved.** Endstone's header (v0.11.7 for 1.26.40,
   HEAD for 1.26.51): `NetherNet::NetworkID` became a 24-byte variant, so the
   RakNet GUID is at +24, the socket address at +40 and `Type` at +168, 176
   bytes in all, against 2024's +8/+24/+152 and 160. Read live from the
   object `send` receives with the bot joined (`IP_DUMP` in
   `tools/instance-probe-launcher.js`): a GUID at +24, zeros through the
   socket union, `0` (RakNet) at +168.

The fix follows the rules the rest of the project runs on. `symbols.json`
ships the layout (`layouts.NetworkIdentifier`, both builds); `hash()` and
`equals()` are `derived()` -- Endstone spells `equalsTypeData` out from the
type in its own code (Apache-2.0), and a hash only has to agree with it, so
`bds/networkidentifier.ts` folds exactly what the comparison reads; the
resolver no longer throws (a failure logs once and hands back an unshared
copy); and the packet callbacks drop an id past `PACKET_ID_COUNT` before
touching the event tables. With that, a client joins, plays and is killed and
respawned under the full launcher on 1.26.40.8, and a driven `stop` reaches
`Quit correctly`.

The same run on 1.26.51.1 went the same way (join, `kill @a`, respawn,
`Quit correctly`), the identifier dumped there has its GUID at +24 and type
0 at +168 too, and the derived `ActorCommandOrigin` passed its checks from
the respawn hook's player on both builds (on 1.26.51.1 `getName` and
`getDimension` could not be *compared*: `?getName@Player@@` and
`?getDimension@Actor@@` have no address there).

`PACKET_ID_COUNT` then grew from 0x140 to 0x160 and `MinecraftPacketIds`
took the 53 ids it lacked from Endstone's `packet.h` (ids only; an id with
no class in `PacketIdToType` is typed as `Packet`). The flag table lives in
generated assembly, and the generator needs `bdsx-core`, so it is rebuilt by
touching `asmcode.asm`: `asm/checkasm.ts` compares the two files' times at
startup and ran the compiler inside BDS on the next launch (`[bdsx-asm]
done. no errors`, 3388 -> 3420 bytes), after which the client run was clean
again on both builds. The regenerated `asmcode.js` is committed.

Still open on this path: a command sent by the bot. The 1.26 protocol data
in bedrock-protocol types `command_request`'s `version` and the origin
`type` as strings, and the server drops the connection when the bot sends
one, so `/originprobe` from a client is untested; the respawn hook covers
what it was for.

## playerJoin: the packet handler is the seam (2026-09-18, late)

bdsx's `events.playerJoin` hooks `ServerPlayer::setLocalPlayerAsInitialized`,
a leaf with no `.pdata` entry in 2024 that the 1.26 builds inline into its
one caller, the `SetLocalPlayerAsInitializedPacket` handler. That handler is
a virtual of `NetEventCallback`, and the 253/255-slot table is held on both
builds but the walk had named none of its slots: the baseline's 216-slot
table is mostly one folded default handler with about 70 overrides scattered
in declaration order, and new packets' handlers go in at the front. What
does carry is the **local pattern of overrides**: the baseline's run around
its slot 55 -- ScriptMessage, SetLocalPlayerAsInitialized, `.`,
NetworkStackLatency, `.`, LabTable, `.`, NpcRequest, `..`, BookEdit,
LecternUpdate, `...`, PlayerToggleCrafterSlotRequest, `.`, PlayerSkin,
ShowCredits, Respawn -- occurs exactly once in each 1.26 table, at slot 82
on 1.26.40.8 and 84 on 1.26.51.1, and the function there is the baseline's
49-byte handler with the leaf folded in: `this-16`, the packet's sub id from
+0x10, a call through the primary table's slot 5, then `mov byte
[player+0xdb6], 1` (0xdb7 on 1.26.51.1), the flag the leaf used to set. In
the baseline the same handler dispatched to slot 2, which the PDB names
`_getServerPlayer`; slot 5 of the 1.26 primary table (6 slots, 48 bytes
before the NetEventCallback one) is a 719-byte function on both builds with
the same body (this, identifier, sub id; asserts on the user list, then the
lookup), so it is `ServerNetworkHandler::_getServerPlayer` -- which is also
what bdsx's `NetworkIdentifier.getActor()` calls.

So the table now carries the handler under its real name and
`_getServerPlayer`, and bdsx's `playerJoin` installer hooks the handler
when the leaf has no address -- the seam Endstone uses for its own join
event -- taking the player from `_getServerPlayer(identifier, sub id)`.
Executed on both builds: the event fired once when the bot joined, and the
player it carried is the object `Player::respawn` had handed over moments
before; the lifecycle stayed clean.

The same table gave `playerLeft` its hook. `ServerNetworkHandler::
_onPlayerLeft` has exactly two callers in the baseline, `onDisconnect` and
the `DisconnectPacket` handler; on both 1.26 builds one callee of slot 8
(`onDisconnect` by Endstone's `net_event_callback.h` order, 2.9 KB) is
called from exactly slot 8 and the last handler slot (251 of 253, 253 of
255 -- the baseline's Disconnect handler was its slot 214), is 1,706 /
1,788 bytes against the baseline's 1,754 with `getOrCreateUniqueID` among
its callees and the same callee sizes on both builds. Hooked by bdsx's own
installer it fired once when the bot disconnected, with the player the join
had carried, on both builds. It is a mid-session event only: a client still
connected when the server is stopped gets `host_disconnected` and the
function never runs (1.26.51.1, the bot outliving the stop), so a plugin
that needs every departure also has to listen for the server closing.

## Cost of a wrong address, again

Two runs were lost to probe addresses typed by hand in decimal: one hooked a
function shorter than twelve bytes (the neighbour is overwritten and the
server hangs after the handoff with nothing on stderr), one hooked the middle
of a function and the process died at shutdown with exit code -1. Probe
files are now written by code from hex, and only functions with a `.pdata`
entry of 32 bytes or more are probed.

## Files

| file | what |
|---|---|
| `tools/instance-probe-launcher.js` | captures, member scan, counter probes (`IP_CONFIG`, `IP_CAPTURES`, `IP_PROBES`) |
| `tools/ctor-from-vftable.mjs` | referencing functions of a vftable, destructor marking, `--check` on the PDB build |
| `tools/spine.mjs` | a function's callees on both builds, baseline named, target annotated |
| `data/candidates-instances-1.26.40.8.json` | live vftables, object layouts, constructors |
| `data/resolved-1.26.40.8.json` | the six constructors with provenance, and `??0ServerCommandOrigin` |
| `data/candidates-ctors-<v>.json` | constructors and destructors told apart by body, not executed (source `ctor-store`) |
| `tools/origin-probe.ts` | execution check of the derived `ActorCommandOrigin` constructor and UUID generator, from a client's `/originprobe` |
