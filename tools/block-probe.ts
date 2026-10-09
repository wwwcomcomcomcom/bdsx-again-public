// Execution check for the block read path (docs/next-steps.md Q1-A, docs/findings-blocks.md):
//   Actor::getDimensionBlockSource -> BlockSource::getBlock(BlockPos const&) -> Block::getName
// The console places a known block at a fixed coordinate and this reads the name back, so the
// answer is one BDS itself wrote. Deployed as zz-blkprobe.ts; console:
//   "tp @a 29.5 68 14.5", "setblock 29 67 14 diamond_block", "blkprobe diamond_block", ...
// The second half is the farmlandDecay hook target (Q1-A 2), behind FARM_PROBE=1 so that no other
// driver's session ever installs it; console: "farmprobe [cancel|allow] [expected count]".
// The third part is the two BlockSource permission functions (Q1-A 1): "bdprobe [hand]" reports the
// inputs, "bdprobe <x> <y> <z> [flag0|flag1]" calls checkBlockDestroyPermissions for the bot and
// "bdprobe mob <x> <y> <z> ..." calls it for a non-player actor caught on entityHurt; "placeprobe
// [call|cancel|allow|report]" drives mayPlace through the hook (PLACE_PROBE=1). The fourth part is
// Player::getDestroySpeed (Q1-0 C-2): "digprobe [reset|compare|<label>]" samples getDestroySpeed(block)
// at the probe coordinate. The fifth part is sculkShriek (Q1-A 4): "shriekprobe [cancel|allow|call|check]
// [n]" drives ?_shriek@SculkShriekerBlockActorInternal@@ through the hook (BLOCKEV2_PROBE=1).
import { Actor, ActorFlags, ActorType } from "bdsx/bds/actor";
import { AttributeId } from "bdsx/bds/attribute";
import { HashedString } from "bdsx/bds/hashedstring";
import { blockTypeName, componentItemReflectionCtx, isHumanoidWearableBlockItemOwn, itemBlockType } from "bdsx/bds/engine/item";
import { cereal, ItemComponent } from "bdsx/bds/item_component";
import { enttComponent } from "bdsx/bds/engine/entt";
import { componentHash } from "bdsx/bds/engine/deps";
import { playerIsInRaid } from "bdsx/bds/engine/village";
import { Block, BlockLegacy, BlockSource, BlockUtils, ChestBlockActor } from "bdsx/bds/block";
import { engineSymbol } from "bdsx/bds/engine/deps";
import { blockTypePermutations } from "bdsx/bds/engine/blocktype";
import { InventoryAction, InventorySource, InventoryTransaction, InventoryTransactionItemGroup, ItemStack } from "bdsx/bds/inventory";
import { BlockPos, Vec3 } from "bdsx/bds/blockpos";
import { ByteArrayTag, ByteTag, CompoundTag, DoubleTag, EndTag, FloatTag, Int64Tag, IntArrayTag, IntTag, ListTag, NBT, ShortTag, StringTag, Tag } from "bdsx/bds/nbt";
import { Player, SimulatedPlayer } from "bdsx/bds/player";
import { PlayerListEntry } from "bdsx/bds/packets";
import { proc } from "bdsx/bds/symbols";
import { DisplaySlot } from "bdsx/bds/scoreboard";
import { bin } from "bdsx/bin";
import { AttributeName, CANCEL } from "bdsx/common";
import { RawPacket } from "bdsx/rawpacket";
import { decay } from "bdsx/decay";
import { AllocatedPointer, NativePointer, StaticPointer, VoidPointer } from "bdsx/core";
import { events } from "bdsx/event";
import { mce } from "bdsx/mce";
import { MinecraftPacketIds } from "bdsx/bds/packetids";
import { CommandResultType } from "bdsx/commandresult";
import { bedrockServer } from "bdsx/launcher";
import { dllraw } from "bdsx/dllraw";
import { makefunc } from "bdsx/makefunc";
import { ProcHacker, procHacker } from "bdsx/prochacker";
import { bin64_t, bool_t, float32_t, int32_t, NativeType, void_t } from "bdsx/nativetype";
import { MobEffect, MobEffectIds, MobEffectInstance } from "bdsx/bds/effects";
import { pdbcache } from "bdsx/pdbcache";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[blkprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

// the coordinate every driver uses: the floor block under the bot's tp target
const X = 29,
    Y = 67,
    Z = 14;

// Block::data_ (next-steps Q1-B-2, docs/findings-containers.md 11). ItemStackBase::getAuxValue
// returns `block_->data_` for a block item, and 1.26 moved that field from +40 to +288 -- the
// only piece of the getAuxValue body with no out-of-line copy left to read. `blkdata <name>`
// reads the block the console just set at the usual coordinate and prints its DataID; `blkdata
// report` then checks what only the real field can do: the default state of a block is 0 and the
// three pillar_axis states of a log are three different small numbers. A neighbouring field is
// either the same for all three (padding, has_runtime_id_, the high half of client_data_) or is
// not 0 for stone and not small (network_id_, serialization_id_hash_for_network_).
const blockData: { name: string; data: number }[] = [];
events.command.on(cmd => {
    const m = /^\/?blkdata(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    const arg = m[1] ?? null;
    if (player === null) {
        say("blkdata", false, "no player has joined");
        return;
    }
    if (arg === "report") {
        const stone = blockData.filter(b => b.name.endsWith(":stone"));
        const logs = blockData.filter(b => b.name.includes("log"));
        const distinct = new Set(logs.map(b => b.data));
        say("blkdata", null, blockData.map(b => `${b.name}=${b.data}`).join(" "));
        say(
            "blkdata-default",
            stone.length > 0 && stone.every(b => b.data === 0),
            `the default state of minecraft:stone has DataID 0 (${stone.map(b => b.data).join(",") || "no sample"})`,
        );
        say(
            "blkdata-states",
            logs.length >= 3 && distinct.size === logs.length && logs.every(b => b.data < 64),
            `the ${logs.length} pillar_axis states of the log are ${distinct.size} different DataIDs below 64 (${logs.map(b => b.data).join(",")})`,
        );
        blockData.length = 0;
        return;
    }
    let region;
    try {
        region = player.getDimensionBlockSource();
    } catch (err) {
        say("blkdata", false, `getDimensionBlockSource threw ${(err as Error).message}`);
        return;
    }
    const block = region.getBlock(BlockPos.create(X, Y, Z));
    const bp = block as any as StaticPointer;
    if (bp.isNull()) {
        say("blkdata", false, "getBlock returned null");
        return;
    }
    const off = pdbcache.layouts.Block?.data ?? 40;
    const name = block.getName();
    const data = bp.getUint16(off);
    blockData.push({ name, data });
    say("blkdata", arg === null || name === arg || name === `minecraft:${arg}`, `${name} +0x${off.toString(16)} = ${data}${arg === null ? "" : ` (want ${arg})`}`);
});

events.command.on(cmd => {
    const m = /^\/?blkprobe(?:\s+(set))?(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    const write = m[1] === "set";
    const want = m[2] ?? null;
    if (player === null) {
        say("player", false, "no player has joined");
        return;
    }
    say("table", null, `getBlock ${"?getBlock@BlockSource@@UEBAAEBVBlock@@AEBVBlockPos@@@Z" in proc ? "in proc" : "MISSING"}; layouts.Block=${JSON.stringify(pdbcache.layouts.Block)} layouts.BlockLegacy=${JSON.stringify(pdbcache.layouts.BlockLegacy)}`);

    let region;
    try {
        region = player.getDimensionBlockSource();
    } catch (err) {
        say("getDimensionBlockSource", false, `threw ${(err as Error).message}`);
        return;
    }
    if (region === null || (region as any as StaticPointer).isNull()) {
        say("getDimensionBlockSource", false, "null");
        return;
    }
    // the BlockSource holds Level +0x20, ChunkSource +0x28, Dimension +0x30 (findings-reach.md):
    // a plausible vftable in slot 0 and a non-null Dimension is the cheap sanity check
    const rp = region as any as StaticPointer;
    say("getDimensionBlockSource", true, `${rp} vftable ${rp.getPointer(0)} dimension ${rp.getPointer(0x30)}`);

    const pos = BlockPos.create(X, Y, Z);
    let block;
    try {
        block = region.getBlock(pos);
    } catch (err) {
        say("getBlock", false, `threw ${(err as Error).message}`);
        return;
    }
    const bp = block as any as StaticPointer;
    if (bp.isNull()) {
        say("getBlock", false, "null");
        return;
    }
    const legacyOff = pdbcache.layouts.Block?.blockLegacy ?? 0x30;
    let legacyInfo = "unreadable";
    try {
        const legacy = bp.getPointer(legacyOff);
        legacyInfo = `BlockLegacy ${legacy} vftable ${legacy.getPointer(0)}`;
    } catch (err) {
        /* keep "unreadable" */
    }
    say("getBlock", null, `${X} ${Y} ${Z} -> ${bp} vftable ${bp.getPointer(0)} | +0x${legacyOff.toString(16)} ${legacyInfo}`);

    let name: string;
    try {
        name = block.getName();
    } catch (err) {
        say("Block::getName", false, `threw ${(err as Error).message}`);
        return;
    }
    if (!write && want === null) {
        say("Block::getName", null, `"${name}"`);
        return;
    }
    const full = want === null ? null : want.includes(":") ? want : `minecraft:${want}`;
    if (!write) {
        say(`getBlock+getName ${want}`, name === full || name === want, `"${name}" (want "${full}")`);
        return;
    }
    // BlockSource::setBlock, through the virtual slot with the 1.26 BlockChangeContext argument.
    // The Block to write is read off the neighbour the console just set, so no Block::create is needed:
    // whatever BDS put at (X, Y, Z+1) is copied onto (X, Y, Z), and the driver's `testforblock` is the
    // other half of the check -- BDS reads what bdsx wrote.
    let source;
    try {
        source = region.getBlock(BlockPos.create(X, Y, Z + 1));
    } catch (err) {
        say("setBlock source", false, `threw ${(err as Error).message}`);
        return;
    }
    const sourceName = source.getName();
    say("setBlock source", null, `${X} ${Y} ${Z + 1} is "${sourceName}" (the block about to be written over "${name}")`);
    let wrote: boolean;
    try {
        wrote = region.setBlock(BlockPos.create(X, Y, Z), source);
    } catch (err) {
        say("setBlock", false, `threw ${(err as Error).message}`);
        return;
    }
    let after: string;
    try {
        after = region.getBlock(BlockPos.create(X, Y, Z)).getName();
    } catch (err) {
        say("setBlock read-back", false, `threw ${(err as Error).message}`);
        return;
    }
    const ok = wrote && after === sourceName && (full === null || after === full);
    say(`setBlock ${want ?? ""}`.trim(), ok, `returned ${wrote}, ${X} ${Y} ${Z} now reads "${after}" (was "${name}", wanted "${full ?? sourceName}")`);
});

// --- farmlandDecay: ?transformOnFall@FarmBlock@@ (docs/next-steps.md Q1-A 2, findings-blocks.md 9) ---
// A hook target is never installed outside its own driver: every session compiles this file, so both
// the listener and therefore procHacker.hooking sit behind FARM_PROBE=1 (an Event installs on its
// first listener). The culprit is a cow the console summons high above farmland and lets fall.
const FARM_VFT = "??_7FarmBlock@@6B@";
const FARM_FN = "?transformOnFall@FarmBlock@@UEBAXAEAVBlockSource@@AEBVBlockPos@@PEAVActor@@M@Z";
let decays = 0;
let cancelNext = false;
const decayLog: string[] = [];
/** where the engine itself (not "farmprobe call") let a decay through, to be read back later */
const engineDecays: Array<{ x: number; y: number; z: number; culprit: string }> = [];
let inDirectCall = false;

function culpritName(a: Actor): string {
    try {
        const n = a.getName();
        if (n) return n;
    } catch (err) {
        /* fall through */
    }
    try {
        return String((a as any).getIdentifier?.());
    } catch (err) {
        return String(a);
    }
    return String(a);
}

if (process.env.FARM_PROBE === "1") {
    say("farm table", null, `${FARM_FN in proc ? "in proc" : "MISSING"} | ${FARM_VFT} ${FARM_VFT in proc ? "in proc" : "MISSING"}`);
    events.farmlandDecay.on(ev => {
        decays++;
        // ev.block is rcx -- the FarmBlock itself, a BlockLegacy and not a Block (bdsx's 2024
        // prototype names it Block). So never call getName() on it: read its vptr raw, which is
        // ??_7FarmBlock@@6B@ and therefore proves both the table and the function that was hooked.
        let detail: string;
        try {
            const self = ev.block as any as StaticPointer;
            const vft = self.getPointer(0);
            const expect = FARM_VFT in proc ? ((proc as any)[FARM_VFT] as StaticPointer) : null;
            const src = ev.blockSource as any as StaticPointer;
            detail =
                `this ${self} vftable ${vft}` +
                (expect === null ? " (no table entry)" : vft.equals(expect) ? ` == ${FARM_VFT}` : ` != ${FARM_VFT} (${expect})`) +
                ` | pos ${ev.blockPos.x} ${ev.blockPos.y} ${ev.blockPos.z}` +
                ` | blockSource ${src} vftable ${src.getPointer(0)}` +
                ` | culprit ${culpritName(ev.culprit)}`;
        } catch (err) {
            detail = `(reading the event threw ${(err as Error).message})`;
        }
        if (!cancelNext && !inDirectCall) {
            try {
                engineDecays.push({ x: ev.blockPos.x, y: ev.blockPos.y, z: ev.blockPos.z, culprit: culpritName(ev.culprit) });
            } catch (err) {
                /* the position is only used for the read-back */
            }
        }
        const line = `#${decays} ${detail}${cancelNext ? " -- CANCEL" : ""}`;
        decayLog.push(line);
        say("farmlandDecay", true, line);
        if (cancelNext) return CANCEL;
    });
    console.log("[blkprobe] farmlandDecay listener installed (FARM_PROBE=1)");
}

// "farmprobe call" is the deterministic half: rather than hope a falling mob trips the engine's own
// call, take the farmland's own BlockLegacy out of the block at (X, Y, Z) -- its vptr must be
// ??_7FarmBlock@@6B@ -- and call the address under test with the 2024 prototype and a fall distance
// that clears the function's own `random < fallDistance - 0.75` gate. The call goes in through the
// hook bdsx installed, so one command exercises the address, the prototype, the event and, with
// "farmprobe cancel", the cancel path; BDS's own testforblock reads the result.
events.command.on(cmd => {
    const m = /^\/?farmprobe(?:\s+(cancel|allow|call|check))?(?:\s+(\d+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (process.env.FARM_PROBE !== "1") {
        say("farmprobe", false, "FARM_PROBE is not 1 -- the hook was never installed");
        return;
    }
    if (m[1] === "cancel") cancelNext = true;
    else if (m[1] === "allow") cancelNext = false;
    else if (m[1] === "call") {
        farmCall();
        return;
    } else if (m[1] === "check") {
        farmCheck();
        return;
    }
    const want = m[2] === undefined ? null : parseInt(m[2], 10);
    const ok = want === null ? decays > 0 : decays === want;
    say(`farmprobe${want === null ? "" : " " + want}`, ok, `fired ${decays} time(s)${want === null ? "" : ` (wanted ${want})`}, cancelNext=${cancelNext}${decayLog.length === 0 ? "" : " | " + decayLog.join(" ;; ")}`);
});

function farmCall(): void {
    if (player === null) {
        say("farmprobe call", false, "no player has joined");
        return;
    }
    if (!(FARM_FN in proc)) {
        say("farmprobe call", false, "the table has no transformOnFall");
        return;
    }
    const region = player.getDimensionBlockSource();
    const pos = BlockPos.create(X, Y, Z);
    const before = region.getBlock(pos);
    const beforeName = before.getName();
    const legacyOff = pdbcache.layouts.Block?.blockLegacy ?? 0x30;
    const legacy = (before as any as StaticPointer).getPointer(legacyOff);
    const vft = legacy.getPointer(0);
    const expect = FARM_VFT in proc ? ((proc as any)[FARM_VFT] as StaticPointer) : null;
    const isFarm = expect !== null && vft.equals(expect);
    // Entities land on this patch all session, so the block may already have been decayed by the very
    // thing under test. That is a missing precondition, not a failed check: report it and skip.
    if (!isFarm && beforeName === "minecraft:dirt") {
        say("farmprobe call target", null, `skipped: ${X} ${Y} ${Z} already reads "minecraft:dirt" (something trampled it first), BlockLegacy vftable ${vft}`);
        return;
    }
    say("farmprobe call target", isFarm, `${X} ${Y} ${Z} is "${beforeName}", its BlockLegacy ${legacy} vftable ${vft} ${isFarm ? "== " + FARM_VFT : "!= " + FARM_VFT + " (" + expect + ")"}`);
    if (!isFarm) return;
    const beforeDecays = decays;
    inDirectCall = true;
    try {
        const fn = makefunc.js((proc as any)[FARM_FN], void_t, null, VoidPointer, VoidPointer, VoidPointer, VoidPointer, float32_t);
        fn(legacy, region as any as VoidPointer, pos as any as VoidPointer, player as any as VoidPointer, 5.0);
    } catch (err) {
        say("farmprobe call", false, `threw ${(err as Error).message}`);
        return;
    } finally {
        inDirectCall = false;
    }
    const afterName = region.getBlock(BlockPos.create(X, Y, Z)).getName();
    const fired = decays - beforeDecays;
    // What this call proves is the address, the prototype and the hook: one entry, one event, and a
    // server still standing. Whether the block changes is BDS's decision -- the body's own gates run
    // after the entry, and with a player as the culprit they were observed not to let the decay
    // through on either build. The engine-driven decays (farmprobe check) are what changes blocks.
    say(`farmprobe call${cancelNext ? " (cancelled)" : ""}`, fired === 1 && (!cancelNext || afterName === beforeName), `hook fired ${fired} time(s) (wanted 1); ${X} ${Y} ${Z} was "${beforeName}" and is now "${afterName}"`);
}

/**
 * What the engine's own calls did. The PASS is "BDS itself called the hooked function", which is the
 * claim this probe exists to make: an entity landing on the farmland we placed enters our hook with
 * the FarmBlock as `this` and that block's position as the argument. Whether the block then turns to
 * dirt is decided by gates further inside the body (an ActorType & 0x100 test, a Level virtual, and a
 * random against fallDistance - 0.75), and on the smoketest world it never completed for any culprit
 * -- minecart, boat, cow, parrot, zombie, iron_golem or the player. That is BDS's own behaviour, so
 * the read-back is reported and not asserted.
 */
function farmCheck(): void {
    if (player === null) {
        say("farmprobe check", false, "no player has joined");
        return;
    }
    const region = player.getDimensionBlockSource();
    const seen: string[] = [];
    for (const d of engineDecays) {
        let n: string;
        try {
            n = region.getBlock(BlockPos.create(d.x, d.y, d.z)).getName();
        } catch (err) {
            n = `(threw ${(err as Error).message})`;
        }
        seen.push(`${d.x} ${d.y} ${d.z} (${d.culprit}) -> "${n}"`);
    }
    say("farmprobe check", engineDecays.length > 0, `BDS itself entered the hook ${engineDecays.length} time(s) | block read-back now: ${seen.length === 0 ? "(none)" : seen.join(" ;; ")}`);
}

// ---------------------------------------------------------------------------------------------
// Q1-A 4: sculkShriek -- ?_shriek@SculkShriekerBlockActorInternal@@ (docs/next-steps.md Q1-A 4,
// docs/findings-blocks.md 14). Behind BLOCKEV2_PROBE=1 like FARM_PROBE, so no other driver's
// session installs the hook. "shriekprobe [cancel|allow|call|check] [n]" mirrors farmprobe:
// "call" invokes the hooked function through the address bdsx patched (proc[SHRIEK_FN]), so a
// console command exercises the address, the prototype, the event and, with "cancel" first, the
// cancel path -- with the native body never running while cancelNextShriek is true. "allow" lets
// the real body run (compound-tag broadcast, block state, and BDS's own warden-summon gate).
const SHRIEK_X = 60,
    SHRIEK_Y = 67,
    SHRIEK_Z = 14;
const SHRIEK_FN = "?_shriek@SculkShriekerBlockActorInternal@@YAXAEAVBlockSource@@VBlockPos@@AEAVPlayer@@@Z";
let shrieks = 0;
let cancelNextShriek = false;
const shriekLog: string[] = [];
if (process.env.BLOCKEV2_PROBE === "1") {
    say("shriek table", null, `${SHRIEK_FN in proc ? "in proc" : "MISSING"}`);
    events.sculkShriek.on(ev => {
        shrieks++;
        let detail: string;
        try {
            const src = ev.region as any as StaticPointer;
            detail =
                `pos ${ev.blockPos.x} ${ev.blockPos.y} ${ev.blockPos.z}` +
                ` | blockSource ${src} vftable ${src.getPointer(0)}` +
                ` | entity ${ev.entity === null ? "(null)" : culpritName(ev.entity)}`;
        } catch (err) {
            detail = `(reading the event threw ${(err as Error).message})`;
        }
        const line = `#${shrieks} ${detail}${cancelNextShriek ? " -- CANCEL" : ""}`;
        shriekLog.push(line);
        say("sculkShriek", true, line);
        if (cancelNextShriek) return CANCEL;
    });
    console.log("[blkprobe] sculkShriek listener installed (BLOCKEV2_PROBE=1)");
}
events.command.on(cmd => {
    const m = /^\/?shriekprobe(?:\s+(cancel|allow|call|check))?(?:\s+(\d+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (process.env.BLOCKEV2_PROBE !== "1") {
        say("shriekprobe", false, "BLOCKEV2_PROBE is not 1 -- the hook was never installed");
        return;
    }
    if (m[1] === "cancel") cancelNextShriek = true;
    else if (m[1] === "allow") cancelNextShriek = false;
    else if (m[1] === "call") {
        shriekCall();
        return;
    } else if (m[1] === "check") {
        say("shriekprobe check", shrieks > 0, `${shrieks} shriek(s) observed so far`);
        return;
    }
    const want = m[2] === undefined ? null : parseInt(m[2], 10);
    const ok = want === null ? shrieks > 0 : shrieks === want;
    say(
        `shriekprobe${want === null ? "" : " " + want}`,
        ok,
        `fired ${shrieks} time(s)${want === null ? "" : ` (wanted ${want})`}, cancelNext=${cancelNextShriek}${shriekLog.length === 0 ? "" : " | " + shriekLog.join(" ;; ")}`,
    );
});

function shriekCall(): void {
    if (player === null) {
        say("shriekprobe call", false, "no player has joined");
        return;
    }
    if (!(SHRIEK_FN in proc)) {
        say("shriekprobe call", false, "the table has no _shriek");
        return;
    }
    const region = player.getDimensionBlockSource();
    const pos = BlockPos.create(SHRIEK_X, SHRIEK_Y, SHRIEK_Z);
    const beforeShrieks = shrieks;
    try {
        const fn = makefunc.js((proc as any)[SHRIEK_FN], void_t, null, VoidPointer, VoidPointer, VoidPointer);
        fn(region as any as VoidPointer, pos as any as VoidPointer, player as any as VoidPointer);
    } catch (err) {
        say("shriekprobe call", false, `threw ${(err as Error).message}`);
        return;
    }
    const fired = shrieks - beforeShrieks;
    say(
        `shriekprobe call${cancelNextShriek ? " (cancelled)" : ""}`,
        fired === 1,
        `hook fired ${fired} time(s) (wanted 1) at ${SHRIEK_X} ${SHRIEK_Y} ${SHRIEK_Z}, cancelNext=${cancelNextShriek}`,
    );
}

// ---------------------------------------------------------------------------------------------
// Q1-A 1: the two BlockSource permission/placement functions (docs/findings-blocks.md 8 and 10).
//
// The two are checked differently because bdsx uses them differently. checkBlockDestroyPermissions
// is not a hook target at all -- bdsx's blockDestroy event hooks SurvivalMode::destroyBlock, and
// this name exists only as BlockSource.prototype.checkBlockDestroyPermission, a plain call. So it
// can be driven straight from the console and, better, it can be made to answer *differently* for
// inputs the console controls: in adventure mode the answer is the item's can_destroy list, which
// is the ItemStackBase vector at +80 that was confirmed the same day. mayPlace is a hook target
// (blockPlace), so it sits behind PLACE_PROBE=1 and is exercised the way transformOnFall was: a
// direct call that goes in through the hook bdsx installed.
const CBDP = "?checkBlockDestroyPermissions@BlockSource@@QEAA_NAEAVActor@@AEBVBlockPos@@AEBVItemStackBase@@_N@Z";
const MAY = "?mayPlace@BlockSource@@QEAA_NAEBVBlock@@AEBVBlockPos@@EPEAVActor@@_NVVec3@@@Z";

// the name member is a HashedString; the std::string inside it is at +8 (tools/item-probe.ts)
const BlockLegacy$name = (pdbcache.layouts.BlockLegacy?.name ?? 0x98) + 8;

function handItem(p: Player): { item: ItemStack; name: string; destroy: string[] } {
    // The offhand, not the mainhand. getMainhandSlot() is getCarriedItem(), an address from a
    // low-trust route that nothing has ever checked; with it the can_destroy vector reads a size of
    // 1 and then faults on the element, which is what a wrong ItemStackBase looks like -- and it
    // would also explain a constant `false` from the function under test, whose second step is
    // `cmpb $1, 35(%r15)` on exactly that object. getOffhandSlot() is the path that was confirmed
    // by execution on 2026-09-20 (docs/findings-containers.md), so the call gets that one.
    const item = p.getOffhandSlot();
    // ItemStackBase::getItem is not in the table on either build, so the item is described by what
    // the function under test itself reads: whether the stack is valid and what its can_destroy
    // list holds (the +80 vector confirmed on 2026-09-20).
    let name: string;
    try {
        name = item.isNull() ? "(null stack)" : "(non-null stack)";
    } catch (err) {
        name = `(isNull threw ${(err as Error).message})`;
    }
    const destroy: string[] = [];
    try {
        const v = item.canDestroy;
        for (let i = 0; i < v.size(); i++) {
            const b = v.get(i);
            destroy.push(b === null ? "<null>" : (b as any as StaticPointer).getCxxString(BlockLegacy$name));
        }
    } catch (err) {
        destroy.push(`(canDestroy threw ${(err as Error).message})`);
    }
    return { item, name, destroy };
}

// The non-player caller (docs/next-steps.md Q1-A 1). The body's very first branch is
// `isType(actor, 319 = Player)`, and only the true side looks at `actor+617`; a non-player skips
// that and reaches the rest of the body by a different edge, so a mob answering differently from
// the bot is what shows the first argument really arrives as an Actor. A mob cannot be addressed by
// a console selector from here, so it is captured the way hurtprobe captures one
// (tools/actor-layout-probe.ts): every entityHurt whose victim is not a Player. What is kept is the
// ActorUniqueID and not the pointer -- the call happens seconds later, by which time a zombie the
// golem was hitting may be dead, and calling into a freed Actor would look exactly like a wrong
// address. Level::fetchEntity turns the id back into a live Actor or into null.
const mobIds: { id: bin64_t; kind: string }[] = [];
let mobHurts = 0;
events.entityHurt.on(ev => {
    try {
        mobHurts++;
        if (ev.entity instanceof Player) return;
        const id = ev.entity.getUniqueIdBin();
        if (mobIds.some(m => m.id === id)) return;
        mobIds.push({ id, kind: ev.entity.getIdentifier() });
        // every candidate is kept, not just the newest: on 1.26.51.1 the one golem the fight produced
        // was already dead by the second call, and one dead id must not cost the whole reading
        if (mobIds.length > 12) mobIds.shift();
    } catch (err) {
        say("bdprobe capture", null, `entityHurt threw ${(err as Error).message}`);
    }
});

/**
 * The actor to pass: whichever captured non-player is still alive, newest first, and an iron golem
 * ahead of a zombie because it survives the fight. Level::fetchEntity is the liveness test -- a
 * freed Actor would crash in a way indistinguishable from a wrong address.
 */
function liveMob(): { actor: Actor; kind: string } | null {
    for (const tough of [true, false]) {
        for (let i = mobIds.length - 1; i >= 0; i--) {
            const m = mobIds[i];
            if (tough !== (m.kind === "minecraft:iron_golem")) continue;
            const live = bedrockServer.level.fetchEntity(m.id, false);
            if (live !== null) return { actor: live, kind: m.kind };
        }
    }
    return null;
}

/** the byte the body branches on for a Player, printed for whatever actor is about to be passed */
function byte617(a: Actor): string {
    try {
        const pp = a as any as StaticPointer;
        const around: string[] = [];
        for (let i = 612; i <= 622; i++) around.push(`${i}=${pp.getUint8(i)}`);
        return around.join(" ");
    } catch (err) {
        return `(threw ${(err as Error).message})`;
    }
}

events.command.on(cmd => {
    if (!/^\/?bdprobe(\s|$)/.test(cmd)) return;
    const argv = cmd
        .replace(/^\/?bdprobe/, "")
        .trim()
        .split(/\s+/)
        .filter(s => s.length > 0);
    if (player === null) {
        say("bdprobe", false, "no player has joined");
        return;
    }
    if (!(CBDP in proc)) {
        say("bdprobe", false, "the table has no checkBlockDestroyPermissions");
        return;
    }
    const region = player.getDimensionBlockSource();
    const hand = handItem(player);
    if (argv.length === 0 || argv[0] === "hand") {
        // the input side: what the function will read out of the ItemStackBase at +8/+35/+80.
        // The mainhand is printed beside it because the two disagree -- see handItem.
        let main = "(unread)";
        try {
            const v = player.getMainhandSlot().canDestroy;
            const names: string[] = [];
            for (let i = 0; i < v.size(); i++) {
                const b = v.get(i);
                names.push(b === null ? "<null>" : (b as any as StaticPointer).getCxxString(BlockLegacy$name));
            }
            main = `canDestroy(${v.size()})=[${names.join(", ")}]`;
        } catch (err) {
            main = `canDestroy threw ${(err as Error).message}`;
        }
        say("bdprobe hand", hand.destroy.length > 0, `offhand ${hand.name} canDestroy(${hand.destroy.length})=[${hand.destroy.join(", ")}] | getCarriedItem() ${main}`);
        // the byte the function branches on before it looks at anything else: for a Player,
        // `cmpb $0, 617(actor)` followed by a jump straight to `xor eax,eax; ret`
        say("bdprobe actor bytes", null, `Actor+612..622: ${byte617(player)}`);
        return;
    }
    const wantMob = argv[0] === "mob";
    const nums = wantMob ? argv.slice(1) : argv;
    if (nums.length < 3 || !/^-?\d+$/.test(nums[0]) || !/^-?\d+$/.test(nums[1]) || !/^-?\d+$/.test(nums[2])) {
        say("bdprobe", false, `cannot read a position out of "${cmd}" (usage: bdprobe [mob] <x> <y> <z> [flag0|flag1])`);
        return;
    }
    const x = parseInt(nums[0], 10),
        y = parseInt(nums[1], 10),
        z = parseInt(nums[2], 10);
    const flagWord = nums[3] === "flag1" ? "flag1" : "flag0";
    // the fifth parameter. BDS itself does not pass a constant here: GameMode::_canDestroy loads a
    // global byte into it (2024 0x1934ffa), and the body ORs it into the answer near the end
    // (`andb %al,%r15b` then `orb %r15b,%r13b`), so flipping it must flip the result. That is what
    // makes this a prototype check and not just an address check: the byte lives at 176(%rsp).
    const flag = flagWord === "flag1";
    // who the call is made for: the bot, or the mob the entityHurt hook caught
    let actor: Actor = player;
    let mobKind = "the bot";
    if (wantMob) {
        const live = liveMob();
        if (live === null) {
            say(
                "bdprobe mob",
                false,
                `no live non-player actor to call for: entityHurt fired ${mobHurts} time(s), ${mobIds.length} distinct non-player victim(s)` +
                    ` [${mobIds.map(m => m.kind).join(", ")}], none of which Level::fetchEntity still returns`,
            );
            return;
        }
        actor = live.actor;
        mobKind = live.kind;
    }
    const pos = BlockPos.create(x, y, z);
    let blockName: string;
    try {
        blockName = region.getBlock(pos).getName();
    } catch (err) {
        blockName = `(getBlock threw ${(err as Error).message})`;
    }
    let got: boolean;
    try {
        got = region.checkBlockDestroyPermission(actor, pos, hand.item, flag);
    } catch (err) {
        say(`bdprobe ${wantMob ? "mob " : ""}${x} ${y} ${z}`, false, `threw ${(err as Error).message}`);
        return;
    }
    // The pass condition is the one transformOnFall settled on (docs/findings-blocks.md 9): what a
    // call proves is the address, the prototype and that BDS came back -- never what BDS decided.
    // The decision is printed and not asserted, because on this world it is `false` for every input
    // the console can reach; docs/findings-blocks.md 10 has the configurations that were tried.
    say(
        `bdprobe ${wantMob ? "mob " : ""}${x} ${y} ${z} ${flagWord}`,
        true,
        `returned ${got} for block "${blockName}", actor ${mobKind} ${String(actor as any as StaticPointer)}` +
            `, offhand ${hand.name} canDestroy=[${hand.destroy.join(", ")}]` +
            (wantMob ? ` | Actor+612..622: ${byte617(actor)}` : ""),
    );
});

// mayPlace: the hook and therefore procHacker.hooking sit behind PLACE_PROBE=1, so no other
// driver's session installs them. bdsx's own onBlockPlace calls the original first and only fires
// the event when the actor is a ServerPlayer and the original said yes -- so a mob-driven place
// (a snow golem's trail, frost walk) would enter the hook but stay invisible here. That half needs
// a human client and stays in Q7; what this proves is the address, the prototype and the hook.
let places = 0;
const placeLog: string[] = [];
let cancelPlace = false;

if (process.env.PLACE_PROBE === "1") {
    say("place table", null, `${MAY in proc ? "mayPlace in proc" : "mayPlace MISSING"}`);
    events.blockPlace.on(ev => {
        places++;
        let detail: string;
        try {
            const src = ev.blockSource as any as StaticPointer;
            detail =
                `block "${ev.block.getName()}" | pos ${ev.blockPos.x} ${ev.blockPos.y} ${ev.blockPos.z}` +
                ` | blockSource ${src} vftable ${src.getPointer(0)}` +
                ` | player ${ev.player.getName()}`;
        } catch (err) {
            detail = `(reading the event threw ${(err as Error).message})`;
        }
        const line = `#${places} ${detail}${cancelPlace ? " -- CANCEL" : ""}`;
        placeLog.push(line);
        say("blockPlace", true, line);
        if (cancelPlace) return CANCEL;
    });
    console.log("[blkprobe] blockPlace listener installed (PLACE_PROBE=1)");
}

events.command.on(cmd => {
    const m = /^\/?placeprobe(?:\s+(call|cancel|allow|report))?\s*$/.exec(cmd);
    if (m === null) return;
    if (process.env.PLACE_PROBE !== "1") {
        say("placeprobe", false, "PLACE_PROBE is not 1 -- the hook was never installed");
        return;
    }
    if (m[1] === "cancel") {
        cancelPlace = true;
        say("placeprobe cancel", null, "the next blockPlace will be cancelled");
        return;
    }
    if (m[1] === "allow") {
        cancelPlace = false;
        say("placeprobe allow", null, "the next blockPlace will be allowed");
        return;
    }
    if (m[1] === "report" || m[1] === undefined) {
        say("placeprobe", places > 0, `blockPlace fired ${places} time(s)${placeLog.length === 0 ? "" : " | " + placeLog.join(" ;; ")}`);
        return;
    }
    placeCall();
});

/**
 * Take a real Block out of the world, a real air position above the floor, and call mayPlace with
 * bdsx's 2024 prototype. The call enters the function bdsx patched, so one command exercises the
 * address, the prototype, the hook and the event at once. The return value is reported either way:
 * a clean `false` still means the hooked function ran and returned, and only a matching `true` plus
 * exactly one event is scored as a pass.
 */
function placeCall(): void {
    if (player === null) {
        say("placeprobe call", false, "no player has joined");
        return;
    }
    if (!(MAY in proc)) {
        say("placeprobe call", false, "the table has no mayPlace");
        return;
    }
    const region = player.getDimensionBlockSource();
    const source = BlockPos.create(X, Y, Z);
    // well above the bot: mayPlace refuses a position an entity occupies, and the bot standing on
    // (X, Y, Z) fills Y+1 and Y+2. The driver clears the whole column to air.
    const target = BlockPos.create(X, Y + 5, Z);
    let block;
    let srcName: string, dstName: string;
    try {
        block = region.getBlock(source);
        srcName = block.getName();
        dstName = region.getBlock(target).getName();
    } catch (err) {
        say("placeprobe call", false, `reading the blocks threw ${(err as Error).message}`);
        return;
    }
    say("placeprobe call target", dstName === "minecraft:air", `placing "${srcName}" at ${target.x} ${target.y} ${target.z}, which currently reads "${dstName}"`);
    const before = places;
    let ret: boolean;
    try {
        const fn = makefunc.js((proc as any)[MAY], bool_t, null, BlockSource, Block, BlockPos, int32_t, Actor, bool_t, Vec3);
        ret = fn(region, block, target, 1 /* facing up */, player, false, Vec3.create(0.5, 0.5, 0.5));
    } catch (err) {
        say("placeprobe call", false, `threw ${(err as Error).message}`);
        return;
    }
    const fired = places - before;
    // with the listener cancelling, bdsx's wrapper returns false although the original said yes --
    // so the expected return is the cancel flag, not a constant
    const want = !cancelPlace;
    say(
        `placeprobe call${cancelPlace ? " (cancelled)" : ""}`,
        ret === want && fired === 1,
        `mayPlace returned ${ret} (wanted ${want}); blockPlace fired ${fired} time(s) (wanted 1)`,
    );
}

// Player::getDestroySpeed (Q1-0 C-2, docs/findings-blocks.md 12): the console changes what's in the
// player's hand and the effects on them, "digprobe [reset|compare|<label>]" reads the block at the
// probe coordinate and calls the public getDestroySpeed(block) the table now resolves. Every number
// printed is BDS's own computation -- bdsx does no arithmetic beyond the table lookup and the call.
// "digprobe reset" clears the history, "digprobe <label>" takes one sample (block name, held item,
// speed), "digprobe compare" checks the whole history is strictly increasing (hand < pickaxe < pickaxe
// with haste, for the same block).
const digHistory: { label: string; speed: number; item: string }[] = [];
events.command.on(cmd => {
    const m = /^\/?digprobe(?:\s+(reset|compare|\S+))?(?:\s+(true|false))?(?:\s+([\d.]+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (player === null) {
        say("digprobe", false, "no player has joined");
        return;
    }
    const arg = m[1];
    if (arg === "reset") {
        digHistory.length = 0;
        say("digprobe reset", null, "history cleared");
        return;
    }
    if (arg === "compare") {
        if (digHistory.length < 2) {
            say("digprobe compare", false, `need at least 2 samples, have ${digHistory.length}`);
            return;
        }
        const strictlyIncreasing = digHistory.every((h, i) => i === 0 || h.speed > digHistory[i - 1].speed);
        say(
            "digprobe compare",
            strictlyIncreasing,
            digHistory.map(h => `${h.label}=${h.speed.toFixed(4)}(${h.item})`).join(" < "),
        );
        return;
    }
    if (arg === "expect" && m[2] !== undefined) {
        // Q1-1 (docs/findings-blocks.md 12, 4th session): "digprobe expect <true|false> [speed]".
        // canDestroy is checked against the real Bedrock rule the driver states. The optional speed is
        // the second, engine-side check: getDestroyProgress is BDS's own function and already divided
        // by 30 or 100 on the engine's *own* canDestroy, and the derived getDestroySpeed multiplies back
        // by bdsx's -- so it lands on the tool's known speed only if the two canDestroy answers agree.
        try {
            const region = player.getDimensionBlockSource();
            const block = region.getBlock(BlockPos.create(X, Y, Z));
            const item = player.getSelectedItem();
            const itemDesc = item.isNull() ? "(empty)" : item.toString();
            const legacy = (block as unknown as StaticPointer).getPointer(0x68);
            const bit = legacy.getUint8(0x165) & 4;
            const table = (block as unknown as StaticPointer).getNullablePointer(0xd0);
            const perItem =
                table === null
                    ? `null(b4=${(block as unknown as StaticPointer).getFloat32(0xb4)})`
                    : `${table.getPointer(8).equalsptr(table.getPointer(16)) ? "empty" : "ENTRIES"}(d0=${table.getFloat32(0)} b4=${(block as unknown as StaticPointer).getFloat32(0xb4)})`;
            const cd = player.canDestroy(block);
            const progress = player.getDestroyProgress(block);
            const speed = player.getDestroySpeed(block);
            const want = m[2] === "true";
            let ok = cd === want;
            let speedNote = "";
            if (m[3] !== undefined) {
                const wantSpeed = Number(m[3]);
                const speedOk = Math.abs(speed - wantSpeed) < wantSpeed * 1e-3;
                ok = ok && speedOk;
                speedNote = ` speed=${speed} (want ${wantSpeed}${speedOk ? "" : " MISMATCH"})`;
            } else {
                speedNote = ` speed=${speed}`;
            }
            say(
                "digprobe expect",
                ok,
                `block=${block.getName()} item=${itemDesc} requiresCorrectTool=${bit !== 0} perItemTable=${perItem} canDestroy=${cd} (want ${want}) progress=${progress}${speedNote}`,
            );
        } catch (err) {
            say("digprobe expect", false, `threw ${(err as Error).message}`);
        }
        return;
    }
    if (arg === "progress") {
        // Q1-0 C-2 (docs/findings-blocks.md 12): canDestroy/getDestroyProgress, freshly derived()
        // this session as `item.canDestroySpecial(block)` alone (the Material::isAlwaysDestroyable
        // half was not found -- see the comment above Player.prototype.canDestroy in implements.ts).
        // Raw dump, no fixed pass/fail assumption: block name, held item, canDestroy, progress.
        try {
            const region = player.getDimensionBlockSource();
            const block = region.getBlock(BlockPos.create(X, Y, Z));
            const item = player.getSelectedItem();
            const itemDesc = item.isNull() ? "(empty)" : item.toString();
            const cd = player.canDestroy(block);
            const progress = player.getDestroyProgress(block);
            say(
                "digprobe progress",
                progress >= 0 && progress <= 1,
                `block=${block.getName()} item=${itemDesc} canDestroy=${cd} progress=${progress}`,
            );
        } catch (err) {
            say("digprobe progress", false, `threw ${(err as Error).message}`);
        }
        return;
    }
    const label = arg ?? `sample${digHistory.length}`;
    try {
        const region = player.getDimensionBlockSource();
        const block = region.getBlock(BlockPos.create(X, Y, Z));
        const item = player.getSelectedItem();
        const speed = player.getDestroySpeed(block);
        const itemDesc = item.isNull() ? "(empty)" : item.toString();
        digHistory.push({ label, speed, item: itemDesc });
        say(`digprobe ${label}`, speed > 0, `block=${block.getName()} item=${itemDesc} speed=${speed}`);
    } catch (err) {
        say(`digprobe ${label}`, false, `threw ${(err as Error).message}`);
    }
});

// BlockLegacy::tryGetStateFromLegacyData (A1-c-x, docs/findings-inventory.md section 11). 1.26 calls
// the class BlockType, so the decoration bdsx asks for is served with the address Endstone's windows.h
// gives for ?tryGetStateFromLegacyData@BlockType@@. No player needed: the overworld BlockSource.
// "legacyprobe" after `setblock 29 67 14 oak_log ["pillar_axis"="x"]` reads that block's DataID (+288,
// layouts.Block.data) and asks its BlockLegacy for the state with that DataID through bdsx's own
// BlockLegacy.tryGetStateFromLegacyData: it must be the very same Block. DataID 0 must be the
// default state, and an out-of-range DataID must come back null.
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "legacyprobe") return;
    const T = "?tryGetStateFromLegacyData@BlockLegacy@@QEBAPEBVBlock@@G@Z";
    say("legacy table", T in proc, T in proc ? `${T} = ${proc[T]}` : "missing");
    const dim = bedrockServer.level.getDimension(0);
    if (dim === null) return say("legacy dimension", false, "Level.getDimension(0) returned null");
    const block = dim.getBlockSource().getBlock(BlockPos.create(X, Y, Z));
    const bp = block as unknown as StaticPointer;
    const data = bp.getUint16(pdbcache.layouts.Block?.data ?? 288);
    const legacy = block.blockLegacy;
    say("legacy block", null, `${X} ${Y} ${Z} is "${block.getName()}", DataID ${data}, BlockLegacy ${legacy}`);
    const same = legacy.tryGetStateFromLegacyData(data);
    say("tryGetStateFromLegacyData(+288 value)", null, `${same} vs the block ${bp}${same !== null && (same as unknown as StaticPointer).equalsptr(bp) ? " (same)" : ""}`);
    // which legacy DataIDs give back exactly this Block, and which distinct Blocks 0..15 give at all
    const hits: number[] = [];
    const distinct = new Map<string, number[]>();
    for (let d = 0; d < 16; d++) {
        const r = legacy.tryGetStateFromLegacyData(d);
        const key = r === null ? "null" : String(r);
        if (!distinct.has(key)) distinct.set(key, []);
        distinct.get(key)!.push(d);
        if (r !== null && (r as unknown as StaticPointer).equalsptr(bp)) hits.push(d);
        const rn = r === null ? "" : (r as unknown as StaticPointer).getUint16(pdbcache.layouts.Block?.data ?? 288);
        if (r !== null && rn !== d && hits.length === 0 && d < 3) say(`tryGet(${d}) +288`, null, `${rn}`);
    }
    say("tryGetStateFromLegacyData(d) == this block", hits.length > 0, `for d in [${hits.join(",")}]; ${distinct.size} distinct answers over 0..15: ${[...distinct.values()].map(v => "[" + v.join(",") + "]").join(" ")}`);
    const def = legacy.tryGetStateFromLegacyData(0);
    const want = legacy.getDefaultState();
    say("tryGetStateFromLegacyData(0) == getDefaultState()", def !== null && (def as unknown as StaticPointer).equalsptr(want as unknown as StaticPointer), `${def} vs ${want}`);
    // an unknown DataID: 1.26 BlockType has return_default_block_on_unidentified_block_state_, so the
    // default state is as legitimate an answer as null here; reported, not judged
    const none = legacy.tryGetStateFromLegacyData(0x7fff);
    say("tryGetStateFromLegacyData(0x7fff)", null, none === null ? "null" : (none as unknown as StaticPointer).equalsptr(want as unknown as StaticPointer) ? "the default state" : `${none}`);
});

// ---------------------------------------------------------------------------------------------
// Q1-A-2: pistonCheck / pistonMove (docs/findings-blocks.md 16). The two hook targets are
// ?_attachedBlockWalker@PistonBlockActor@@ (called once per push by _checkAttachedBlocks) and
// ?_spawnMovingBlocks@PistonBlockActor@@; the event fields are PistonBlockActor.action (state_) and
// getAttachedBlocks (attached_blocks_), both read at the engine layer's offsets, getFacingDir (an
// address) and getPosition (an accessor). Behind PISTON_PROBE=1, so no other session installs them.
// The driver builds: floor stone at (PX,PY-1,PZ), a sticky piston facing up at (PX,PY,PZ), a stone
// on top of it, and powers it from the side with a redstone block. "pistonprobe" commands:
//   cancel | allow        the next pistonCheck events return CANCEL / pass through
//   at <dy> <name>        the block at (PX, PY+dy, PZ) is <name>
//   report <what>         the events at (PX, *, PZ) since the last report, judged for <what>:
//                         cancelled (checks fired, no move, stone did not move), extend, retract
const PX = 44,
    PY = 68,
    PZ = 20;
let cancelPiston = false;
interface PistonSeen {
    kind: "check" | "move";
    pos: string;
    action: number;
    attached: string[];
    facing: string;
    cancelled: boolean;
}
let pistonSeen: PistonSeen[] = [];
const posStr = (p: BlockPos) => `${p.x} ${p.y} ${p.z}`;
if (process.env.PISTON_PROBE === "1") {
    const describe = (kind: "check" | "move", ev: { blockPos: BlockPos; action: number; affectedBlocks: BlockPos[]; facingDirection: BlockPos }): PistonSeen => ({
        kind,
        pos: posStr(ev.blockPos),
        action: ev.action,
        attached: ev.affectedBlocks.map(posStr),
        facing: posStr(ev.facingDirection),
        cancelled: false,
    });
    events.pistonCheck.on(ev => {
        const seen = describe("check", ev);
        seen.cancelled = cancelPiston;
        pistonSeen.push(seen);
        if (ev.blockPos.x === PX && ev.blockPos.z === PZ && pistonSeen.length <= 40) say("pistonCheck", null, JSON.stringify(seen));
        if (cancelPiston) return CANCEL;
    });
    events.pistonMove.on(ev => {
        const seen = describe("move", ev);
        pistonSeen.push(seen);
        say("pistonMove", null, JSON.stringify(seen));
    });
    console.log("[blkprobe] piston listeners installed (PISTON_PROBE=1)");
}
// the Block* at a position: one interned permutation per state, so two positions with equal states hold the same pointer
function blockPtrAt(x: number, y: number, z: number): string {
    if (player === null) return "(no player)";
    try {
        return (player.getDimensionBlockSource().getBlock(BlockPos.create(x, y, z)) as any).toString();
    } catch (err) {
        return `(threw ${(err as Error).message})`;
    }
}
const buttonPtrs: { [key: string]: string } = {};
function blockNameAt(x: number, y: number, z: number): string {
    if (player === null) return "(no player)";
    try {
        return player.getDimensionBlockSource().getBlock(BlockPos.create(x, y, z)).getName();
    } catch (err) {
        return `(threw ${(err as Error).message})`;
    }
}
events.command.on(cmd => {
    const m = /^\/?pistonprobe\s+(cancel|allow|at|report)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (process.env.PISTON_PROBE !== "1") {
        say("pistonprobe", false, "PISTON_PROBE is not 1 -- the hooks were never installed");
        return;
    }
    const strip = (n: string) => n.replace(/^minecraft:/, "");
    if (m[1] === "cancel" || m[1] === "allow") {
        cancelPiston = m[1] === "cancel";
        say(`pistonprobe ${m[1]}`, null, `${pistonSeen.length} event(s) before this`);
        return;
    }
    if (m[1] === "at") {
        const dy = parseInt(m[2] ?? "0", 10);
        const name = blockNameAt(PX, PY + dy, PZ);
        say(`pistonprobe at +${dy}`, strip(name) === strip(m[3] ?? ""), `${name} (want ${m[3]})`);
        return;
    }
    const what = m[2] ?? "";
    // only the probe's own column: a piston left in the world elsewhere ticks too
    const seen = pistonSeen.filter(e => e.pos.startsWith(`${PX} `) && e.pos.endsWith(` ${PZ}`));
    pistonSeen = [];
    const here = `${PX} ${PY} ${PZ}`;
    const front = `${PX} ${PY + 1} ${PZ}`;
    // pistonCheck's blockPos is the walker's argument -- the block being examined, never the piston
    // itself -- while pistonMove's is the piston (getPosition). action is state_ at that moment:
    // still Retracted (0) while an extension is being checked, Expanding (1) / Retracting (3) by move.
    const checks = seen.filter(e => e.kind === "check");
    const moves = seen.filter(e => e.kind === "move");
    const summary = `${checks.length} check(s), ${moves.length} move(s)` + (seen.length === 0 ? "" : ` | first ${JSON.stringify(seen[0])} | last ${JSON.stringify(seen[seen.length - 1])}`);
    if (what === "cancelled") {
        const ok = checks.length > 0 && checks.every(c => c.cancelled && c.pos === front) && moves.length === 0 && strip(blockNameAt(PX, PY + 1, PZ)) === "stone";
        say("pistonprobe report cancelled", ok, `${summary} | above the piston: ${blockNameAt(PX, PY + 1, PZ)}`);
    } else if (what === "extend" || what === "retract") {
        const want = what === "extend" ? 1 : 3;
        const stoneAt = what === "extend" ? PY + 2 : PY + 1;
        const stoneFrom = what === "extend" ? PY + 1 : PY + 2;
        const move = moves.find(mv => mv.pos === here && mv.action === want);
        const ok =
            checks.some(c => !c.cancelled && c.pos === (what === "extend" ? front : `${PX} ${PY + 2} ${PZ}`)) &&
            move !== undefined &&
            move.facing === "0 1 0" &&
            move.attached.includes(`${PX} ${stoneFrom} ${PZ}`) &&
            strip(blockNameAt(PX, stoneAt, PZ)) === "stone";
        say(`pistonprobe report ${what}`, ok, `${summary} | stone wanted at y=${stoneAt}: ${blockNameAt(PX, stoneAt, PZ)}`);
    } else {
        say("pistonprobe report", null, summary);
    }
});

// ---------------------------------------------------------------------------------------------
// Q1-A-2: chestPair (docs/findings-blocks.md 17). The hook target is bdsx:ChestBlockActor::pairWith (1.26
// prototype: other, region, lead); the checks read the engine's own state back through
// BlockSource.getBlockEntity (IConstBlockSource slot 3), isLargeChest and getPairedChestPosition (the
// two fields pairWith writes, engine/chest.ts). Behind CHEST_PROBE=1. The driver places two chests side by
// side at z=CZ1 while cancelling (onPlace -> _tryToPairWith -> pairWith), then two more at z=CZ2 allowed.
//   chestprobe cancel | allow
//   chestprobe check cancelled | paired | nonchest
const CX = 50,
    CY = 68,
    CZ1 = 24,
    CZ2 = 27;
let cancelChest = false;
const chestSeen: { a: string; b: string; lead: boolean; cancelled: boolean }[] = [];
if (process.env.CHEST_PROBE === "1") {
    events.chestPair.on(ev => {
        let seen;
        try {
            seen = { a: posStr(ev.chest.getPosition()), b: posStr(ev.chest2.getPosition()), lead: ev.lead, cancelled: cancelChest };
        } catch (err) {
            say("chestPair", false, `reading the event threw ${(err as Error).message}`);
            return;
        }
        chestSeen.push(seen);
        say("chestPair", null, JSON.stringify(seen));
        if (cancelChest) return CANCEL;
    });
    console.log("[blkprobe] chestPair listener installed (CHEST_PROBE=1)");
}
function chestAt(x: number, y: number, z: number): ChestBlockActor | null | string {
    if (player === null) return "(no player)";
    try {
        const be = player.getDimensionBlockSource().getBlockEntity(BlockPos.create(x, y, z));
        return be === null ? null : be.as(ChestBlockActor);
    } catch (err) {
        return `(threw ${(err as Error).message})`;
    }
}
function chestState(z: number): { large: boolean[]; paired: string[]; text: string } {
    const large: boolean[] = [];
    const paired: string[] = [];
    const parts: string[] = [];
    for (const x of [CX, CX + 1]) {
        const c = chestAt(x, CY, z);
        if (typeof c === "string" || c === null) {
            parts.push(`${x} ${CY} ${z}: ${c ?? "no block actor"}`);
            large.push(false);
            paired.push("");
            continue;
        }
        const l = c.isLargeChest();
        const p = l ? posStr(c.getPairedChestPosition()) : "";
        large.push(l);
        paired.push(p);
        parts.push(`${x} ${CY} ${z}: large=${l}${l ? ` paired with ${p}` : ""}`);
    }
    return { large, paired, text: parts.join(" ; ") };
}
events.command.on(cmd => {
    const m = /^\/?chestprobe\s+(cancel|allow|check)(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (process.env.CHEST_PROBE !== "1") {
        say("chestprobe", false, "CHEST_PROBE is not 1 -- the hook was never installed");
        return;
    }
    if (m[1] !== "check") {
        cancelChest = m[1] === "cancel";
        // the checks count from here: a world saved with paired chests re-pairs them from the tick at load
        say(`chestprobe ${m[1]}`, null, `${chestSeen.length} event(s) before this: ${JSON.stringify(chestSeen)}`);
        chestSeen.length = 0;
        return;
    }
    const what = m[2] ?? "";
    if (what === "nonchest") {
        const c = chestAt(CX, CY - 1, CZ1);
        say("chestprobe check nonchest", c === null, `getBlockEntity at the stone floor: ${c === null ? "null" : typeof c === "string" ? c : "a block actor"}`);
        return;
    }
    const z = what === "cancelled" ? CZ1 : CZ2;
    const evs = chestSeen.filter(e => e.a.endsWith(` ${z}`) && e.b.endsWith(` ${z}`));
    const st = chestState(z);
    const a = `${CX} ${CY} ${z}`,
        b = `${CX + 1} ${CY} ${z}`;
    let ok: boolean;
    if (what === "cancelled") {
        ok = evs.length > 0 && evs.every(e => e.cancelled) && !st.large[0] && !st.large[1];
    } else {
        ok =
            evs.some(e => !e.cancelled && e.lead) &&
            evs.some(e => !e.cancelled && !e.lead) &&
            st.large[0] &&
            st.large[1] &&
            st.paired[0] === b &&
            st.paired[1] === a;
    }
    say(`chestprobe check ${what}`, ok, `${evs.length} event(s) ${JSON.stringify(evs)} | ${st.text}`);
});

// ---------------------------------------------------------------------------------------------
// Q1-A-2: sculkSensorActivate (docs/findings-blocks.md 18). The hook target is
// ?setActivePhase@SculkSensorBlock@@ (2024 prototype), reached from SculkSensorVibrationConfig::onSignalReceive.
// The engine's own answer is the sensor block's aux value (Block+288, layouts.Block.data): sculk_sensor_phase,
// 0 = inactive. Every event is sampled two and ten ticks later. Behind SCULK_PROBE=1. The driver sets a sensor
// at (SX,SY,SZ) and makes vibrations next to it (blocks placed and removed, a mob summoned).
//   sculkprobe cancel | allow
//   sculkprobe check cancelled | active
const SX = 56,
    SY = 68,
    SZ = 20;
let cancelSculk = false;
let sculkTick = 0;
const sculkSeen: { pos: string; entity: string; cancelled: boolean; at: number; phase2?: number; phase10?: number }[] = [];
function sensorData(): number {
    if (player === null) return -1;
    try {
        const block = player.getDimensionBlockSource().getBlock(BlockPos.create(SX, SY, SZ));
        return (block as any as StaticPointer).getUint16(pdbcache.layouts.Block?.data ?? 40);
    } catch {
        return -2;
    }
}
if (process.env.SCULK_PROBE === "1") {
    events.sculkSensorActivate.on(ev => {
        let seen;
        try {
            seen = { pos: posStr(ev.pos), entity: ev.entity === null ? "(null)" : culpritName(ev.entity), cancelled: cancelSculk, at: sculkTick };
        } catch (err) {
            say("sculkSensorActivate", false, `reading the event threw ${(err as Error).message}`);
            return;
        }
        sculkSeen.push(seen);
        if (sculkSeen.length <= 30) say("sculkSensorActivate", null, JSON.stringify(seen) + ` | phase now ${sensorData()}`);
        if (cancelSculk) return CANCEL;
    });
    events.levelTick.on(() => {
        sculkTick++;
        for (const s of sculkSeen) {
            if (s.phase2 === undefined && sculkTick - s.at >= 2) s.phase2 = sensorData();
            if (s.phase10 === undefined && sculkTick - s.at >= 10) s.phase10 = sensorData();
        }
    });
    console.log("[blkprobe] sculkSensorActivate listener installed (SCULK_PROBE=1)");
}
events.command.on(cmd => {
    const m = /^\/?sculkprobe\s+(cancel|allow|check)(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (process.env.SCULK_PROBE !== "1") {
        say("sculkprobe", false, "SCULK_PROBE is not 1 -- the hook was never installed");
        return;
    }
    if (m[1] !== "check") {
        cancelSculk = m[1] === "cancel";
        say(`sculkprobe ${m[1]}`, null, `${sculkSeen.length} event(s) before this, phase now ${sensorData()}`);
        sculkSeen.length = 0;
        return;
    }
    const here = `${SX} ${SY} ${SZ}`;
    const evs = sculkSeen.filter(s => s.pos === here);
    const summary = `${evs.length} event(s) at the sensor, phase now ${sensorData()} | ${JSON.stringify(evs.slice(0, 6))}`;
    if (m[2] === "cancelled") {
        say("sculkprobe check cancelled", evs.length > 0 && evs.every(s => s.cancelled && s.phase2 === 0 && s.phase10 === 0), summary);
    } else {
        say("sculkprobe check active", evs.some(s => !s.cancelled && s.phase2 !== undefined && s.phase2 !== 0), summary);
    }
});

// ---------------------------------------------------------------------------------------------
// Q1-A-2: fallOnBlock (docs/findings-blocks.md 19). The hook target is bdsx:BlockType::onFallOnBase; the event
// is read from the BlockEntityFallOnEvent Actor::checkFallDamage builds. Behind FALLON_PROBE=1. The driver
// drops pigs from ten blocks onto stone, a hay bale, slime and honey in a row at z=FZ.
//   fallprobe check <x> <block> <min> <max> | none   an event whose block is <block> at x=<x>, z=FZ, from a pig,
//                                                    height in [min, max] -- or, with "none", no event there.
// height is the distance onFallOnBase receives: the raw fall for a plain block, what a subscriber lets through
// otherwise (hay passes 20%, slime 0); honey does not reach onFallOnBase at all.
const FZ = 30;
const pigWrappers = new Set<Actor>();
const fallSeen: { block: string; pos: string; entity: string; height: number }[] = [];
if (process.env.FALLON_PROBE === "1") {
    events.fallOnBlock.on(ev => {
        try {
            const seen = { block: ev.block.getName(), pos: posStr(ev.blockPos), entity: culpritName(ev.entity), height: Math.round(ev.height * 100) / 100 };
            if (seen.entity === "minecraft:pig") pigWrappers.add(ev.entity);
            fallSeen.push(seen);
            if (ev.blockPos.z === FZ) say("fallOnBlock", null, JSON.stringify(seen));
        } catch (err) {
            say("fallOnBlock", false, `reading the event threw ${(err as Error).message}`);
        }
    });
    console.log("[blkprobe] fallOnBlock listener installed (FALLON_PROBE=1)");
}
events.command.on(cmd => {
    const m = /^\/?fallprobe\s+check\s+(-?\d+)\s+(\S+)\s+(?:(none)|([\d.]+)\s+([\d.]+))\s*$/.exec(cmd);
    if (m === null) return;
    if (process.env.FALLON_PROBE !== "1") {
        say("fallprobe", false, "FALLON_PROBE is not 1 -- the hook was never installed");
        return;
    }
    const x = parseInt(m[1], 10);
    const want = m[2].replace(/^minecraft:/, "");
    const evs = fallSeen.filter(s => s.pos.startsWith(`${x} `) && s.pos.endsWith(` ${FZ}`));
    const ok =
        m[3] === "none"
            ? evs.length === 0
            : evs.some(s => s.block.replace(/^minecraft:/, "") === want && s.entity === "minecraft:pig" && s.height >= parseFloat(m[4]) && s.height <= parseFloat(m[5]));
    say(`fallprobe check ${x} ${want}${m[3] === "none" ? " none" : ` ${m[4]}..${m[5]}`}`, ok, `${evs.length} event(s) ${JSON.stringify(evs.slice(0, 4))} | now at ${x} 67 ${FZ}: ${blockNameAt(x, 67, FZ)}`);
});

// ---------------------------------------------------------------------------------------------
// Q4 / actor bookkeeping (docs/findings-slots.md "Q4 continued III"): bdsx's hook on ??1Actor@@UEAA@XZ
// (asmcode.actorDestructorHook -> _removeActor) decays an Actor wrapper and drops it from Actor.all() when the
// engine destroys the actor. Needs FALLON_PROBE=1 too: the pigs the fall driver drops become wrappers through
// the fallOnBlock event. "dtorprobe check alive" (every pig seen so far is live and in Actor.all()), then a
// console kill, then "dtorprobe check dead" (every one is decayed and gone).
events.command.on(cmd => {
    const m = /^\/?dtorprobe\s+check\s+(alive|dead)\s*$/.exec(cmd);
    if (m === null) return;
    const all = new Set(Actor.all());
    const pigs = [...pigWrappers];
    const state = pigs.map(p => (decay.isDecayed(p) ? "decayed" : all.has(p) ? "live" : "missing"));
    const want = m[1] === "alive" ? "live" : "decayed";
    say(`dtorprobe check ${m[1]}`, pigs.length > 0 && state.every(s => s === want), `${pigs.length} pig wrapper(s): ${state.join(", ")} | Actor.all() size ${all.size}`);
});

// ---------------------------------------------------------------------------------------------
// Q1-C: objectiveCreate (docs/findings-scoreboard.md). The hook target is ?addObjective@Scoreboard@@ (2024
// prototype); the engine's own answer is Scoreboard::getObjective(name). Behind SCORE_PROBE=1.
//   objprobe cancel | allow
//   objprobe check <name> present|absent     the event fired for <name> and getObjective agrees
let cancelObjective = false;
const objectivesSeen: { name: string; displayName: string; cancelled: boolean }[] = [];
if (process.env.SCORE_PROBE === "1") {
    events.objectiveCreate.on(ev => {
        objectivesSeen.push({ name: ev.name, displayName: ev.displayName, cancelled: cancelObjective });
        say("objectiveCreate", null, JSON.stringify(objectivesSeen[objectivesSeen.length - 1]));
        if (cancelObjective) return CANCEL;
    });
    console.log("[blkprobe] objectiveCreate listener installed (SCORE_PROBE=1)");
}
events.command.on(cmd => {
    const m = /^\/?objprobe\s+(cancel|allow|check)(?:\s+(\S+)\s+(present|absent))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] !== "check") {
        cancelObjective = m[1] === "cancel";
        say(`objprobe ${m[1]}`, null, `${objectivesSeen.length} event(s) so far`);
        return;
    }
    const name = m[2];
    let objective: unknown;
    try {
        objective = bedrockServer.level.getScoreboard().getObjective(name);
    } catch (err) {
        say(`objprobe check ${name}`, false, `getObjective threw ${(err as Error).message}`);
        return;
    }
    const evs = objectivesSeen.filter(o => o.name === name);
    const present = objective !== null;
    const ok = evs.length > 0 && present === (m[3] === "present") && evs.every(o => o.cancelled === (m[3] === "absent"));
    say(`objprobe check ${name} ${m[3]}`, ok, `${evs.length} event(s) ${JSON.stringify(evs)} | getObjective: ${present ? "an Objective" : "null"}`);
});

// ---------------------------------------------------------------------------------------------
// Q1-C: scoreReset (docs/findings-scoreboard.md section 3). The hook target is
// ?removeFromObjective@ScoreboardIdentityRef@@; the engine's answer is `scoreboard players test`, run through
// the console's `scoreboard players test` line the driver runs just before each check. Behind SCORE_PROBE=1.
//   scoreprobe cancel | allow
//   scoreprobe test <objective> <value> present|absent   the bot's score and the reset events so far
let cancelReset = false;
const resetsSeen: { objective: string; cancelled: boolean }[] = [];
if (process.env.SCORE_PROBE === "1") {
    events.scoreReset.on(ev => {
        let name: string;
        try {
            name = ev.objective.getName();
        } catch (err) {
            name = `(getName threw ${(err as Error).message})`;
        }
        resetsSeen.push({ objective: name, cancelled: cancelReset });
        say("scoreReset", null, JSON.stringify(resetsSeen[resetsSeen.length - 1]));
        if (cancelReset) return CANCEL;
    });
}
events.command.on(cmd => {
    const m = /^\/?scoreprobe\s+(cancel|allow|test)(?:\s+(\S+)\s+(-?\d+)\s+(present|absent))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] !== "test") {
        cancelReset = m[1] === "cancel";
        say(`scoreprobe ${m[1]}`, null, `${resetsSeen.length} reset event(s) so far`);
        return;
    }
    // bedrockServer.executeCommand needs ??0CommandContext@@, not in the 1.26 tables: the engine's answer is
    // the console's own `scoreboard players test` line right before this command in the log
    const evs = resetsSeen.filter(r => r.objective === m[2]);
    const want = m[4] === "present";
    say(`scoreprobe test ${m[2]} ${m[3]} ${m[4]}`, evs.length > 0 && evs[evs.length - 1].cancelled === want, `reset events ${JSON.stringify(evs)}`);
});

// ---------------------------------------------------------------------------------------------
// bedrockServer.executeCommand on 1.26 (docs/findings-scoreboard.md section 5): no CommandRegistry::Parser in the
// table, so bdsx builds the CommandContext itself and lets MinecraftCommands::executeCommand run the command.
// "execprobe" runs three commands through it and checks each against the engine's own state.
events.command.on(cmd => {
    if (!/^\/?execprobe\s*$/.test(cmd)) return;
    const seen: string[] = [];
    const listener = (c: string) => {
        seen.push(c);
    };
    events.command.on(listener);
    const run = (c: string, type: CommandResultType = CommandResultType.Data) => {
        try {
            const r = bedrockServer.executeCommand(c, type);
            return { ok: r.isSuccess(), code: r.data.statusCode as number, err: null as string | null };
        } catch (err) {
            return { ok: false, code: -1, err: (err as Error).message };
        }
    };
    run(`setblock ${X} ${Y} ${Z} air`); // setblock onto the same block is a real failure: start from air
    const set = run(`setblock ${X} ${Y} ${Z} gold_block`);
    const block = blockNameAt(X, Y, Z);
    say("execprobe setblock", set.err === null && set.ok && block === "minecraft:gold_block", `success=${set.ok} code=0x${(set.code >>> 0).toString(16)} ${set.err ?? ""} | block now ${block}`);
    const bad = run("testfor @e[type=zombie,name=no_such_mob_zzz]");
    say("execprobe failing command", bad.err === null && !bad.ok, `success=${bad.ok} code=0x${(bad.code >>> 0).toString(16)} ${bad.err ?? ""}`);
    const back = run(`setblock ${X} ${Y} ${Z} stone`, CommandResultType.OutputAndData);
    say("execprobe setblock with output", back.err === null && back.ok && blockNameAt(X, Y, Z) === "minecraft:stone", `success=${back.ok} code=0x${(back.code >>> 0).toString(16)} ${back.err ?? ""} | block now ${blockNameAt(X, Y, Z)}`);
    events.command.remove(listener);
    say("execprobe events.command", seen.length === 4, `${seen.length} event(s): ${JSON.stringify(seen)}`);
});

// ---------------------------------------------------------------------------------------------
// Q1-C: the scoreboard readers (docs/findings-scoreboard.md section 6), all derived() over layouts on 1.26.
// "sbprobe <objective> <score> <displayName>" after the console set the bot's score, showed the objective in the
// sidebar and created an empty objective "probe_empty"; "sbprobe reset <objective>" resets through
// bdsx's resetPlayerScore; "sbprobe remove <objective>" removes through bdsx's removeObjective. Behind SCORE_PROBE=1.
events.command.on(cmd => {
    const m = /^\/?sbprobe\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    const check = (label: string, ok: boolean, detail: string) => say(`sbprobe ${label}`, ok, detail);
    try {
        const sb = bedrockServer.level.getScoreboard();
        if (player === null) {
            check(m[1], false, "no player");
            return;
        }
        const id = sb.getPlayerScoreboardId(player);
        if (m[1] === "others") {
            // the entity and fake-player branches: a pig and "probe_fake" were given scores 5 and 3 in <objective>
            const obj = sb.getObjective(m[2]!)!;
            const refs = sb.getTrackedIds().map(t => sb.getScoreboardIdentityRef(t)!).filter(r => r !== null && r.getIdentityType() === 2);
            let pigOk = false;
            let pigDetail = `${refs.length} entity identit(ies)`;
            for (const ref of refs) {
                const actor = bedrockServer.level.fetchEntity(ref.getEntityId(), true);
                if (actor === null || actor.getIdentifier() !== "minecraft:pig") continue;
                const back = sb.getActorScoreboardId(actor);
                const score = obj.getPlayerScore(back);
                pigOk = back.id === ref.getScoreboardId().id && score.valid && score.value === 5;
                pigDetail += ` | pig ${bin.toString(ref.getEntityId())}: id back ${back.idAsNumber} vs ${ref.getScoreboardId().idAsNumber}, score ${score.valid ? score.value : "none"}`;
            }
            check("entity branch", pigOk, pigDetail);
            const fake = sb.getFakePlayerScoreboardId("probe_fake");
            const fakeScore = obj.getPlayerScore(fake);
            const fakeRef = sb.getScoreboardIdentityRef(fake);
            check("fake branch", fake.isValid() && fakeScore.valid && fakeScore.value === 3 && fakeRef !== null && fakeRef.getIdentityType() === 3, `id ${fake.idAsNumber} score ${fakeScore.valid ? fakeScore.value : "none"} type ${fakeRef?.getIdentityType()}`);
            return;
        }
        if (m[1] === "reset" || m[1] === "remove") {
            const obj = sb.getObjective(m[2]!);
            if (obj === null) {
                check(m[1], false, `no objective ${m[2]}`);
                return;
            }
            if (m[1] === "reset") {
                const r = sb.resetPlayerScore(id, obj);
                const after = obj.getPlayerScore(id);
                check("reset", r && !after.valid, `resetPlayerScore returned ${r}, score valid after: ${after.valid}`);
            } else {
                const r = sb.removeObjective(obj);
                check("remove", r && sb.getObjective(m[2]!) === null, `removeObjective returned ${r}, getObjective after: ${sb.getObjective(m[2]!) === null ? "null" : "still there"}`);
            }
            return;
        }
        const name = m[1],
            want = parseInt(m[2] ?? "0", 10),
            display = m[3] ?? "";
        const names = sb.getObjectiveNames();
        check("getObjectiveNames", names.includes(name) && names.includes("probe_empty"), JSON.stringify(names));
        const obj = sb.getObjective(name)!;
        check("Objective names", obj.getName() === name && obj.getDisplayName() === display, `"${obj.getName()}" / "${obj.getDisplayName()}"`);
        check("getObjectives", sb.getObjectives().some(o => o.getName() === name), `${sb.getObjectives().length} objective(s)`);
        check("getPlayerScoreboardId", id.isValid(), `id ${id.idAsNumber}`);
        const score = obj.getPlayerScore(id);
        check("getPlayerScore", score.valid && score.value === want, `valid ${score.valid} value ${score.value} (want ${want})`);
        const empty = sb.getObjective("probe_empty")!.getPlayerScore(id);
        check("getPlayerScore (no score)", !empty.valid, `valid ${empty.valid}`);
        check("getPlayers", obj.getPlayers().some(p => p.id === id.id), `${obj.getPlayers().length} player(s)`);
        const ref = sb.getScoreboardIdentityRef(id);
        check(
            "getScoreboardIdentityRef",
            ref !== null && ref.getScoreboardId().id === id.id && ref.getIdentityType() === 1 && ref.getPlayerId() === player.getUniqueIdBin(),
            ref === null ? "null" : `id ${ref.getScoreboardId().idAsNumber} type ${ref.getIdentityType()} (1 = Player) playerId ${bin.toString(ref.getPlayerId())} (bot ${bin.toString(player.getUniqueIdBin())})`,
        );
        check("getTrackedIds", sb.getTrackedIds().some(t => t.id === id.id), `${sb.getTrackedIds().length} id(s)`);
        const crit = sb.getCriteria("dummy");
        check("getCriteria", crit !== null && crit.name === "dummy" && sb.getCriteria("no_such_criteria") === null, crit === null ? "null" : `"${crit.name}"`);
        const side = sb.getDisplayObjective(DisplaySlot.Sidebar);
        const list = sb.getDisplayObjective(DisplaySlot.List);
        check("getDisplayObjective", side !== null && side.objective !== null && side.objective.getName() === name && (list === null || list.objective === null), `sidebar ${side === null ? "null" : side.objective?.getName()} | list ${list === null ? "null" : "set"}`);
    } catch (err) {
        say(`sbprobe ${m[1]}`, false, `threw ${(err as Error).stack}`);
    }
});

// ---------------------------------------------------------------------------------------------
// Q1-C: modifyScoreInObjective (docs/findings-scoreboard.md section 7): the scoreSet/Add/Remove events and bdsx's
// setPlayerScore/addPlayerScore. Behind SCORE_PROBE=1.
//   modprobe cancel | allow | events <set|add|remove> <n> | api <objective>
let cancelModify = false;
const modifySeen: { kind: string; score: number; cancelled: boolean }[] = [];
if (process.env.SCORE_PROBE === "1") {
    const record = (kind: string) => (ev: { score: number }) => {
        modifySeen.push({ kind, score: ev.score, cancelled: cancelModify });
        say(`score${kind}`, null, JSON.stringify(modifySeen[modifySeen.length - 1]));
        if (cancelModify) return CANCEL;
    };
    events.scoreSet.on(record("Set"));
    events.scoreAdd.on(record("Add"));
    events.scoreRemove.on(record("Remove"));
}
events.command.on(cmd => {
    const m = /^\/?modprobe\s+(cancel|allow|events|api)(?:\s+(\S+))?(?:\s+(\d+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] === "cancel" || m[1] === "allow") {
        cancelModify = m[1] === "cancel";
        say(`modprobe ${m[1]}`, null, `${modifySeen.length} event(s) so far`);
        return;
    }
    if (m[1] === "events") {
        const kind = { set: "Set", add: "Add", remove: "Remove" }[m[2] ?? ""] ?? "";
        const n = parseInt(m[3] ?? "0", 10);
        const hit = modifySeen.filter(e => e.kind === kind && e.score === n);
        say(`modprobe events ${m[2]} ${n}`, hit.length > 0, JSON.stringify(modifySeen));
        return;
    }
    try {
        const sb = bedrockServer.level.getScoreboard();
        const obj = sb.getObjective(m[2]!)!;
        const id = sb.getPlayerScoreboardId(player!);
        const set = sb.setPlayerScore(id, obj, 100);
        const afterSet = obj.getPlayerScore(id).value;
        const add = sb.addPlayerScore(id, obj, 5);
        const afterAdd = obj.getPlayerScore(id).value;
        say("modprobe api", set === 100 && afterSet === 100 && add === 105 && afterAdd === 105, `setPlayerScore -> ${set} (read ${afterSet}), addPlayerScore 5 -> ${add} (read ${afterAdd})`);
    } catch (err) {
        say("modprobe api", false, `threw ${(err as Error).stack}`);
    }
});

// ---------------------------------------------------------------------------------------------
// entityHealthChange (next-steps Q1-A 2): the health AttributeInstance's delegate_ (a shared_ptr at +0x58,
// Endstone attribute_instance.h) is a HealthAttributeDelegate; "hdprobe" prints its vftable and first slots next to
// ServerPlayer's vftable, whose RVA the table gives, so the delegate's RVA can be computed offline.
events.command.on(cmd => {
    if (!/^\/?hdprobe\s*$/.test(cmd)) return;
    try {
        const inst = player!.getAttributes().getMutableInstance(AttributeId.Health) as any as StaticPointer;
        const delegate = inst.getPointer(0x58);
        const vft = delegate.getPointer(0);
        const slots = [0, 1, 2, 3, 4, 5, 6].map(i => vft.getPointer(i * 8).toString());
        say("hdprobe", !delegate.isNull(), `instance ${inst} delegate ${delegate} vftable ${vft} ServerPlayer vftable ${(proc as any)["??_7ServerPlayer@@6B@"]} | slots ${slots.join(" ")}`);
    } catch (err) {
        say("hdprobe", false, `threw ${(err as Error).message}`);
    }
});

// entityHealthChange through bdsx:HealthAttributeDelegate::change. "hcprobe keep" makes the next changes keep the old
// health (the listener sets newHealth = oldHealth); "hcprobe pass" lets them through; "hcprobe check <kept|passed>"
// judges the pig events since the last mode switch against the pig's health read back by bdsx.
let healthMode: "keep" | "pass" = "pass";
let healthSeen: { entity: string; old: number; now: number; mode: string }[] = [];
let healthPig: Actor | null = null;
if (process.env.HEALTH_PROBE === "1") {
    events.entityHealthChange.on(ev => {
        const entity = culpritName(ev.entity);
        healthSeen.push({ entity, old: ev.oldHealth, now: ev.newHealth, mode: healthMode });
        if (entity === "minecraft:pig") healthPig = ev.entity;
        say("entityHealthChange", null, JSON.stringify(healthSeen[healthSeen.length - 1]));
        if (healthMode === "keep") ev.newHealth = ev.oldHealth;
    });
}
events.command.on(cmd => {
    const m = /^\/?hcprobe\s+(keep|pass|check)(?:\s+(kept|passed))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] !== "check") {
        healthMode = m[1] as "keep" | "pass";
        healthSeen = [];
        say(`hcprobe ${m[1]}`, null, "");
        return;
    }
    const pigs = healthSeen.filter(e => e.entity === "minecraft:pig");
    const health = healthPig === null ? -1 : healthPig.getHealth();
    const first = pigs[0];
    const ok = first !== undefined && (m[2] === "kept" ? health === first.old : first.now < first.old && health === pigs[pigs.length - 1].now);
    say(`hcprobe check ${m[2]}`, ok, `${pigs.length} pig event(s) ${JSON.stringify(pigs.slice(0, 3))} | pig health now ${health}`);
});

// entityCreated (next-steps Q1-A 2): the two functions that build sendActorCreated's lambda sit in one vftable
// (docs/findings-slots.md "sendActorCreated"). EC_A / EC_B (hex RVAs) hook them with pass-through hooks that print
// what they get: A (this, Actor&, a pointer to the initialization method byte), B (this, an entity reference).
if (process.env.EC_A) {
    const a = dllraw.current.add(parseInt(process.env.EC_A, 16)) as NativePointer;
    const hookedA = new ProcHacker<{ a: NativePointer }>({ a }).hooking("a", void_t, null, VoidPointer, Actor, StaticPointer)((self, actor, method) => {
        say("ecprobe A", null, `actor ${actor === null ? "(null)" : culpritName(actor)} method ${method.getUint8(0)}`);
        return hookedA(self, actor, method);
    });
    console.log(`[blkprobe] ecprobe A hooked at ${a}`);
}
if (process.env.EC_B) {
    const b = dllraw.current.add(parseInt(process.env.EC_B, 16)) as NativePointer;
    const hookedB = new ProcHacker<{ b: NativePointer }>({ b }).hooking("b", void_t, null, VoidPointer, StaticPointer)((self, ref) => {
        say("ecprobe B", null, `ref ${ref}`);
        return hookedB(self, ref);
    });
    console.log(`[blkprobe] ecprobe B hooked at ${b}`);
}

// entityCreated through bdsx:ActorEventCoordinator::sendActorCreated: "ecprobe check <type> <method>" -- an event
// for that entity type with that ActorInitializationMethod (2 = Spawned) since the listener was installed.
const createdSeen: string[] = [];
if (process.env.CREATED_PROBE === "1") {
    events.entityCreated.on(ev => {
        createdSeen.push(`${culpritName(ev.entity)}/${ev.method}`);
    });
}
events.command.on(cmd => {
    const m = /^\/?ecprobe\s+check\s+(\S+)\s+(\d+)(\s+absent)?\s*$/.exec(cmd);
    if (m === null) return;
    const want = `minecraft:${m[1]}/${m[2]}`;
    const seen = createdSeen.includes(want);
    say(`ecprobe check ${m[1]} ${m[2]}${m[3] ? " absent" : ""}`, m[3] ? !seen : seen, `${createdSeen.length} event(s), e.g. ${createdSeen.slice(-6).join(" ")}`);
});

// splashPotionHit through ThrownPotionEffectSubcomponent::doOnHitEffect (docs/findings-slots.md "splashPotionHit").
// "spprobe harm|harmcancel|pass" sets what the listener does with the next hits (harm: turn the potion into
// Harming, id 23; harmcancel: the same and CANCEL); "spprobe check <x> <harmed|unharmed>" reads the pig nearest
// x=<x> through bdsx after its potion landed. Behind SPLASH_PROBE=1.
let splashMode = "pass";
const splashSeen: string[] = [];
const splashPigs: Actor[] = [];
if (process.env.SPLASH_PROBE === "1") {
    events.entityCreated.on(ev => {
        if (ev.entity.getIdentifier() === "minecraft:pig") splashPigs.push(ev.entity);
    });
    events.splashPotionHit.on(ev => {
        let raw = "";
        try {
            const data = (ev.entity as any as StaticPointer).getPointer(0x128);
            const begin = data.getPointer(0);
            const count = data.getPointer(8).subptr(begin) >>> 3;
            const item = count > 36 ? begin.getPointer(36 * 8) : null;
            raw = item === null || item.isNull() ? `items ${count}, no item 36` : `items ${count}, item36 ${item} bytes ${item.getBin(16).length} type@8 ${item.getUint8(8)} +0xc ${item.getInt16(0xc)}`;
        } catch (err) {
            raw = `(raw read threw ${(err as Error).message})`;
        }
        splashSeen.push(`${culpritName(ev.entity)} potion ${ev.potionEffect} (${splashMode}) [${raw}] pigs ${splashPigs.map(p => (decay.isDecayed(p) ? "decayed" : p.getPosition().x.toFixed(1))).join(",")}`);
        say("splashPotionHit", null, splashSeen[splashSeen.length - 1]);
        if (splashMode === "harm" || splashMode === "harmcancel") ev.potionEffect = 23;
        if (splashMode === "harmcancel") return CANCEL;
    });
}
events.command.on(cmd => {
    const m = /^\/?spprobe\s+(harm|harmcancel|pass|check)(?:\s+(-?\d+)\s+(harmed|unharmed))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] !== "check") {
        splashMode = m[1];
        say(`spprobe ${m[1]}`, null, `${splashSeen.length} event(s) so far`);
        return;
    }
    const x = parseInt(m[2]!, 10);
    let health = -1;
    for (const a of splashPigs) {
        if (decay.isDecayed(a)) continue;
        if (Math.abs(a.getPosition().x - (x + 0.5)) > 2) continue;
        health = a.getHealth();
    }
    const ok = m[3] === "harmed" ? health >= 0 && health < 10 : health === 10;
    say(`spprobe check ${x} ${m[3]}`, ok && splashSeen.length > 0, `pig health ${health} | events ${splashSeen.join(" ; ")}`);
});

// campfireLight / campfireDouse (next-steps Q1-A 2). "cfprobe cancel|allow" sets what the listeners answer; the
// engine's answer is the console's `testforblock` on the campfire's extinguished state. Behind CAMPFIRE_PROBE=1.
let cancelCampfire = false;
const campfireSeen: string[] = [];
if (process.env.CAMPFIRE_PROBE === "1") {
    events.campfireLight.on(ev => {
        campfireSeen.push(`light ${posStr(ev.blockPos)} ${cancelCampfire ? "cancel" : "allow"}`);
        say("campfireLight", null, campfireSeen[campfireSeen.length - 1]);
        if (cancelCampfire) return CANCEL;
    });
    events.campfireDouse.on(ev => {
        campfireSeen.push(`douse ${posStr(ev.blockPos)} ${cancelCampfire ? "cancel" : "allow"}`);
        say("campfireDouse", null, campfireSeen[campfireSeen.length - 1]);
        if (cancelCampfire) return CANCEL;
    });
}
events.command.on(cmd => {
    const m = /^\/?cfprobe\s+(cancel|allow|seen)(?:\s+(light|douse)\s+(\S+ \S+ \S+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] !== "seen") {
        cancelCampfire = m[1] === "cancel";
        say(`cfprobe ${m[1]}`, null, `${campfireSeen.length} event(s) so far`);
        return;
    }
    const hit = campfireSeen.some(e => e.startsWith(`${m[2]} ${m[3]}`));
    say(`cfprobe seen ${m[2]} ${m[3]}`, hit, campfireSeen.join(" ; "));
});

// EntityRegistry -> its entt registry: an actor holds EntityRegistry* at +8 and the entt registry at +16
events.command.on(cmd => {
    if (!/^\/?regprobe\s*$/.test(cmd)) return;
    const p = player as any as StaticPointer;
    say("regprobe", null, `EntityRegistry ${p.getPointer(8)} entt registry ${p.getPointer(16)} offset 0x${p.getPointer(16).subptr(p.getPointer(8)).toString(16)}`);
});

// projectileHit through ProjectileComponent::onHit, and HitResult::getEntity (derived): "phprobe check <victim>"
// -- an event whose victim resolves to <victim> (or "none" for a block hit). Behind PHIT_PROBE=1.
const hitsSeen: string[] = [];
if (process.env.PHIT_PROBE === "1") {
    events.projectileHit.on(ev => {
        hitsSeen.push(`${culpritName(ev.projectile)} -> ${ev.victim === null ? "none" : culpritName(ev.victim)}`);
        say("projectileHit", null, hitsSeen[hitsSeen.length - 1]);
    });
}
events.command.on(cmd => {
    const m = /^\/?phprobe\s+check\s+(\S+)\s*$/.exec(cmd);
    if (m === null) return;
    const want = m[1] === "none" ? "none" : `minecraft:${m[1]}`;
    say(`phprobe check ${m[1]}`, hitsSeen.some(h => h.endsWith(`-> ${want}`)), hitsSeen.join(" ; "));
});

// projectileHitBlock / lightningHitBlock, raised from their 1.26 callers (engine/blockhit.ts, findings-blocks.md section
// 21): "bhprobe check proj|light <block> <x y z>" -- an event on that block at that position; "bhprobe count light <n>"
// -- exactly n lightning events (one per bolt). Behind BHIT_PROBE=1.
const blockHitsSeen: string[] = [];
if (process.env.BHIT_PROBE === "1") {
    events.projectileHitBlock.on(ev => {
        blockHitsSeen.push(`proj ${ev.block.getName().replace("minecraft:", "")} ${posStr(ev.blockPos)} by ${culpritName(ev.projectile)}`);
        say("projectileHitBlock", null, blockHitsSeen[blockHitsSeen.length - 1]);
    });
    events.lightningHitBlock.on(ev => {
        blockHitsSeen.push(`light ${ev.block.getName().replace("minecraft:", "")} ${posStr(ev.blockPos)}`);
        say("lightningHitBlock", null, blockHitsSeen[blockHitsSeen.length - 1]);
    });
}
events.command.on(cmd => {
    const m = /^\/?bhprobe\s+(check\s+(proj|light)\s+(\S+)\s+(\S+ \S+ \S+)|count\s+(proj|light)\s+(\d+))\s*$/.exec(cmd);
    if (m === null) return;
    if (m[2] !== undefined) {
        const want = `${m[2]} ${m[3]} ${m[4]}`;
        say(`bhprobe check ${m[2]} ${m[3]} ${m[4]}`, blockHitsSeen.some(h => h.startsWith(want)), blockHitsSeen.join(" ; "));
    } else {
        const n = blockHitsSeen.filter(h => h.startsWith(`${m[5]} `)).length;
        say(`bhprobe count ${m[5]} ${m[6]}`, n === +m[6], `${n} ${m[5]} event(s): ${blockHitsSeen.join(" ; ")}`);
    }
});

// Attribute::getByName (next-steps Q1-B): bdsx's own example_and_test/test.ts check -- every AttributeName resolves to
// an Attribute whose id (+4, Endstone attribute.h) is the one this build numbers it (BaseAttributeMap::nativeIdOf),
// and whose name (+8) reads back -- plus health must be the very Attribute the player's health instance points at
// (AttributeInstance::attribute_, +8).
events.command.on(cmd => {
    if (!/^\/?gbnprobe\s*$/.test(cmd)) return;
    try {
        const getByName = procHacker.js("?getByName@Attribute@@SAAEAV1@AEBVHashedString@@@Z", StaticPointer, null, HashedString);
        const map = player!.getAttributes();
        const bad: string[] = [];
        const seen: string[] = [];
        let healthAttr: StaticPointer | null = null;
        for (const key of Object.keys(AttributeName) as (keyof typeof AttributeName)[]) {
            if (key === "ZombieSpawnReinforcementsChange" || key === "JumpStrength") continue;
            const hs = HashedString.construct();
            hs.set(AttributeName[key]);
            const attr = getByName(hs);
            hs.destruct();
            const id = attr.getUint32(4);
            const name = attr.getCxxString(8 + 8);
            const want = map.nativeIdOf(AttributeId[key]);
            seen.push(`${key}=${id}`);
            if (id !== want || name !== AttributeName[key]) bad.push(`${key}: id ${id} name ${name} (want ${want} ${AttributeName[key]})`);
            if (key === "Health") healthAttr = attr;
        }
        const inst = map.getMutableInstance(AttributeId.Health) as any as StaticPointer;
        const instAttr = inst.getPointer(8);
        const same = healthAttr !== null && instAttr.equalsptr(healthAttr);
        say("gbnprobe ids", bad.length === 0, bad.length === 0 ? seen.join(" ") : bad.join(" ; "));
        say("gbnprobe health", same, `getByName(minecraft:health) ${healthAttr} health instance attribute_ ${instAttr}`);
    } catch (err) {
        say("gbnprobe", false, `threw ${(err as Error).message}`);
    }
});

// ItemStackBase::isHumanoidWearableBlockItem (next-steps Q1-B): bdsx's own membership test (engine/item.ts) against the
// binary -- on 40 its out-of-line 0x1bc3ad0, on 51 isHumanoidWearableItem (0x1a59d80), which inlines the same test
// after the armor check, so it must agree for every item that is not armor. The driver fills the hotbar with the
// seven heads, carved_pumpkin and pumpkin, and inventory slots 9-12 with stone, apple, diamond_helmet and nothing.
events.command.on(cmd => {
    if (!/^\/?wbprobe\s*$/.test(cmd)) return;
    try {
        const WB = "?isHumanoidWearableBlockItem@ItemStackBase@@QEBA_NXZ";
        const WI = "?isHumanoidWearableItem@ItemStackBase@@QEBA_NXZ";
        const bin = WB in proc ? makefunc.js(proc[WB], bool_t, null, VoidPointer) : null;
        const wi = WI in proc ? makefunc.js(proc[WI], bool_t, null, VoidPointer) : null;
        const want = [true, true, true, true, true, true, true, true, false, false, false, false, false];
        const armor = [false, false, false, false, false, false, false, false, false, false, false, true, false];
        const c = player!.getInventory().container;
        const parts: string[] = [];
        let ok = true;
        want.forEach((w, i) => {
            const stack = c.getItem(i) as any as StaticPointer;
            const ref = stack.getPointer(8);
            const item = ref.isNull() ? null : ref.getPointer(0);
            const bt = item === null || item.isNull() ? null : itemBlockType(item);
            const own: boolean = isHumanoidWearableBlockItemOwn(stack);
            const viaBdsx = (stack as any as ItemStack).isHumanoidWearableBlockItem();
            const b = bin !== null ? bin(stack) : null;
            const w2 = wi !== null ? wi(stack) : null;
            const good = own === w && viaBdsx === w && (b === null || b === w) && (w2 === null || armor[i] || w2 === w);
            if (!good) ok = false;
            parts.push(`${i}:${bt === null ? "-" : blockTypeName(bt).replace("minecraft:", "")}=${own}${b !== null ? "/bin " + b : ""}${w2 !== null ? "/wearable " + w2 : ""}`);
        });
        say("wbprobe", ok, parts.join(" "));
    } catch (err) {
        say("wbprobe", false, `threw ${(err as Error).message}`);
    }
});

// getComponentItem's boolean (next-steps Q1-B): the live Item vftable of hotbar slots 0..2 and its slot 9
// (isComponentBased), both as RVAs, so the body the answer comes from can be read offline; plus bdsx's answer.
events.command.on(cmd => {
    if (!/^\/?cbprobe\s*$/.test(cmd)) return;
    try {
        const c = player!.getInventory().container;
        const rva = (p: NativePointer): string => "0x" + p.subptr(dllraw.current).toString(16);
        const parts: string[] = [];
        for (let i = 0; i < 3; i++) {
            const stack = c.getItem(i);
            const ref = (stack as any as StaticPointer).getPointer(8);
            if (ref.isNull()) { parts.push(`${i}: empty`); continue; }
            const item = ref.getPointer(0);
            const vft = item.getPointer(0);
            const ci = stack.getComponentItem();
            parts.push(`${i}: vftable ${rva(vft)} slot9 ${rva(vft.getPointer(0x48))} getComponentItem ${ci === null ? "null" : "item"}`);
        }
        say("cbprobe", null, parts.join(" | "));
    } catch (err) {
        say("cbprobe", false, `threw ${(err as Error).message}`);
    }
});

// playerInventoryChange through Player::inventoryChanged (next-steps Q1-A 2), behind INV_PROBE=1: "invprobe check <slot>
// <text|empty>" -- an event since the last check for that slot whose new item's toString contains <text> (or is null)
// and whose old item was something else.
const invSeen: { slot: number; old: string; now: string; nowNull: boolean }[] = [];
if (process.env.INV_PROBE === "1") {
    events.playerInventoryChange.on(ev => {
        const e = { slot: ev.slot, old: ev.oldItemStack.toString(), now: ev.newItemStack.toString(), nowNull: ev.newItemStack.isNull() };
        invSeen.push(e);
        say("playerInventoryChange", null, `slot ${e.slot}: ${e.old} -> ${e.now}`);
    });
}
events.command.on(cmd => {
    const m = /^\/?invprobe\s+check\s+(\d+)\s+(.+?)\s*$/.exec(cmd);
    if (m === null) return;
    const slot = +m[1], want = m[2];
    const hit = invSeen.some(e => e.slot === slot && (want === "empty" ? e.nowNull : e.now.includes(want)) && e.old !== e.now);
    say(`invprobe check ${slot} ${want}`, hit, invSeen.map(e => `${e.slot}:${e.now}`).join(" ; "));
    invSeen.length = 0;
});

// projectileShoot through ProjectileComponent::shoot(Actor&, Actor&) (next-steps Q1-A 2), behind SHOOT_PROBE=1:
// "shootprobe mark" forgets what was seen; "shootprobe check <projectile> <shooter>" -- an event since the mark with those
// two; "shootprobe none <projectile>" -- no event since the mark with that projectile (a dispenser's arrow has no
// shooter, so 2024's Spawner::spawnProjectile takes the other shoot overload).
const shotsSeen: string[] = [];
if (process.env.SHOOT_PROBE === "1") {
    events.projectileShoot.on(ev => {
        shotsSeen.push(`${culpritName(ev.projectile)} by ${culpritName(ev.shooter)}`);
        say("projectileShoot", null, shotsSeen[shotsSeen.length - 1]);
    });
}
events.command.on(cmd => {
    const m = /^\/?shootprobe\s+(mark|check|none)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] === "mark") {
        shotsSeen.length = 0;
        say("shootprobe mark", null, "");
        return;
    }
    const proj = `minecraft:${m[2]}`;
    if (m[1] === "check") {
        say(`shootprobe check ${m[2]} ${m[3]}`, shotsSeen.includes(`${proj} by minecraft:${m[3]}`), shotsSeen.slice(0, 8).join(" ; "));
    } else {
        say(`shootprobe none ${m[2]}`, !shotsSeen.some(s => s.startsWith(`${proj} by`)), shotsSeen.slice(0, 8).join(" ; "));
    }
});

// queryRegenerate through RakNetServerLocator::_startAnnouncingServer (next-steps Q1-A 2), behind QUERY_PROBE=1:
// "qrprobe check <players>" -- an event whose currentPlayers is <players>; the listener also rewrites maxPlayers to 77.
const queriesSeen: string[] = [];
if (process.env.QUERY_PROBE === "1") {
    events.queryRegenerate.on(ev => {
        queriesSeen.push(`${ev.currentPlayers}/${ev.maxPlayers} motd=${ev.motd} level=${ev.levelname} joinable=${ev.isJoinableThroughServerScreen}`);
        say("queryRegenerate", null, queriesSeen[queriesSeen.length - 1]);
        ev.maxPlayers = 77;
    });
}
events.command.on(cmd => {
    const m = /^\/?qrprobe\s+check\s+(\d+)\s*$/.exec(cmd);
    if (m === null) return;
    say(`qrprobe check ${m[1]}`, queriesSeen.some(q => q.startsWith(`${m[1]}/`)), queriesSeen.join(" ; "));
});

// Dimension's own virtuals (next-steps Q1-3 isInClouds): "dimprobe" prints the player's dimension vftable and slots
// 20..27 as RVAs, so getCloudHeight (Endstone dimension.h: slot 24) can be read offline before anything calls it.
events.command.on(cmd => {
    if (!/^\/?dimprobe\s*$/.test(cmd)) return;
    try {
        const dim = player!.getDimension() as any as StaticPointer;
        const vft = dim.getPointer(0);
        const rva = (p: NativePointer): string => "0x" + p.subptr(dllraw.current).toString(16);
        const slots: string[] = [];
        for (let i = 20; i < 28; i++) slots.push(`${i}:${rva(vft.getPointer(i * 8))}`);
        say("dimprobe", null, `dimension ${player!.getDimensionId()} vftable ${rva(vft)} ${slots.join(" ")}`);
    } catch (err) {
        say("dimprobe", false, `threw ${(err as Error).message}`);
    }
});

// Actor::isInClouds (derived, engine/dimension.ts): "cloudprobe <h>" -- isInClouds must equal `h < y < h + 4` for the
// cloud height <h> the binary's getCloudHeight returns in this dimension (192 / 128 / 8, read off the bodies), at the
// player's current position.
events.command.on(cmd => {
    const m = /^\/?cloudprobe\s+(\d+)\s*$/.exec(cmd);
    if (m === null) return;
    try {
        const h = +m[1];
        const y = player!.getPosition().y;
        const got = player!.isInClouds();
        const want = h < y && y < h + 4;
        say(`cloudprobe ${h} y=${y.toFixed(2)}`, got === want, `isInClouds ${got} (want ${want})`);
    } catch (err) {
        say("cloudprobe", false, `threw ${(err as Error).message}`);
    }
});

// Player::startCooldown(Item const*, bool) (next-steps Q1-3): hotbar 0 holds a goat horn, whose cooldown category is
// "goat_horn" for 140 ticks (GoatHornItem::getCooldownType/getCooldownTime). "cdprobe start" -- getItemCooldownLeft of
// minecraft:goat_horn is 0 before bdsx's startCooldown and 1..140 after (also asked as "goat_horn"); "cdprobe left", 8 s
// later -- 0 again, run out.
let cdStarted = -1;
events.command.on(cmd => {
    const m = /^\/?cdprobe\s+(start|left|dump)\s*$/.exec(cmd);
    if (m === null) return;
    const key = HashedString.construct();
    try {
        if (m[1] === "dump") {
            // the component getItemCooldownLeft reads (EnTT 0xc099c998, 0x80 bytes): two maps keyed by HashedString
            const comp = enttComponent(player as any, 0xc099c998, 0x80);
            const parts: string[] = [`component ${comp}`];
            if (comp !== null) {
                for (const at of [0x08, 0x48]) {
                    const head = comp.getPointer(at);
                    for (let n = head.getPointer(0), i = 0; !n.equalsptr(head) && i < 16; n = n.getPointer(0), i++) {
                        parts.push(`+0x${at.toString(16)}: ${n.getCxxString(0x18)} = ${n.getInt32(0x40)}`);
                    }
                }
            }
            for (const k of ["goat_horn", "minecraft:goat_horn"]) {
                key.set(k);
                parts.push(`left(${k}) ${player!.getItemCooldownLeft(key)}`);
            }
            say("cdprobe dump", null, parts.join(" | "));
            return;
        }
        key.set("minecraft:goat_horn");
        if (m[1] === "start") {
            const before = player!.getItemCooldownLeft(key);
            const item = player!.getInventory().container.getItem(0).getItem();
            player!.startCooldown(item!);
            cdStarted = player!.getItemCooldownLeft(key);
            key.set("goat_horn");
            const bare = player!.getItemCooldownLeft(key);
            say("cdprobe start", before === 0 && cdStarted > 0 && cdStarted <= 140 && bare === cdStarted, `before ${before} after ${cdStarted}, un-namespaced ${bare} (want 0, then 1..140 twice)`);
        } else {
            // 140 ticks is 7 s and the next console command comes 8 s later: the cooldown has run out
            const left = player!.getItemCooldownLeft(key);
            say("cdprobe left", left === 0 && cdStarted > 0, `left ${left} (started ${cdStarted}; want 0 -- expired)`);
        }
    } catch (err) {
        say("cdprobe", false, `threw ${(err as Error).message}`);
    } finally {
        key.destruct();
    }
});

// Actor::fetchNearbyActorsSorted(Vec3 const&, ActorType) (next-steps Q1-3): pigs penned 2, 5, 8 and 16 blocks east of the
// player. "nearprobe" -- a 10-block box with the Pig filter returns exactly the three inside, nearest first, each
// distanceSq equal to the squared distance between the two positions; the Cow filter returns none.
events.command.on(cmd => {
    if (!/^\/?nearprobe\s*$/.test(cmd)) return;
    try {
        const p = player!;
        const pos = p.getPosition();
        const range = Vec3.create(10, 10, 10);
        const pigs = p.fetchNearbyActorsSorted(range, ActorType.Pig);
        const cows = p.fetchNearbyActorsSorted(range, ActorType.Cow);
        const parts: string[] = [];
        let ok = pigs.length === 3 && cows.length === 0;
        let last = -1;
        for (const e of pigs) {
            const q = e.entity.getPosition();
            const d = (q.x - pos.x) ** 2 + (q.y - pos.y) ** 2 + (q.z - pos.z) ** 2;
            parts.push(`${culpritName(e.entity)} x=${q.x.toFixed(1)} d2=${e.distanceSq.toFixed(2)}/${d.toFixed(2)}`);
            if (e.distanceSq < last || Math.abs(e.distanceSq - d) > 0.05 || culpritName(e.entity) !== "minecraft:pig") ok = false;
            last = e.distanceSq;
        }
        say("nearprobe", ok, `${pigs.length} pigs, ${cows.length} cows | ${parts.join(" ; ")}`);
    } catch (err) {
        say("nearprobe", false, `threw ${(err as Error).message}`);
    }
});

// Actor::canSee (next-steps Q1-3): an armor stand 6 blocks east. "seeprobe <true|false>" -- canSee(stand) and
// canSee(a point at its chest) both give the expected answer (a stone wall at x=32 in between for false).
events.command.on(cmd => {
    const m = /^\/?seeprobe\s+(true|false)\s*$/.exec(cmd);
    if (m === null) return;
    try {
        const want = m[1] === "true";
        const stands = player!.fetchNearbyActorsSorted(Vec3.create(10, 10, 10), ActorType.ArmorStand);
        if (stands.length !== 1) { say(`seeprobe ${m[1]}`, false, `${stands.length} armor stands in range`); return; }
        const byActor = player!.canSee(stands[0].entity);
        const byPos = player!.canSee(Vec3.create(35.5, 69.2, 14.5));
        say(`seeprobe ${m[1]}`, byActor === want && byPos === want, `canSee(stand) ${byActor} canSee(point) ${byPos}`);
    } catch (err) {
        say("seeprobe", false, `threw ${(err as Error).message}`);
    }
});

// Player::isInRaid (next-steps Q1-3): "raidprobe <label>" prints bdsx's isInRaid for the player.
events.command.on(cmd => {
    const m = /^\/?raidprobe\s+(\S+)\s*$/.exec(cmd);
    if (m === null) return;
    try {
        // bdsx's isInRaid (the binary on 40, the derived on 51) and the engine function itself, for both players
        const own = (p: Player): boolean => {
            const pos = p.getPosition();
            return playerIsInRaid(p.getDimension() as any as StaticPointer, pos.x, pos.y, pos.z);
        };
        const sim = simbot === null ? "" : `; simbot alive ${simbot.isAlive()} at ${simbot.getPosition().toString()} isInRaid ${simbot.isInRaid()} engine ${own(simbot)}`;
        say(`raidprobe ${m[1]}`, null, `isInRaid ${player!.isInRaid()} engine ${own(player!)}${sim}`);
    } catch (err) {
        say("raidprobe", false, `threw ${(err as Error).message}`);
    }
});

// PlayerListEntry's default and UUID constructors (derived, engine/playerlist.ts): "pleprobe" -- a default entry holds
// 2024's defaults (id -1, empty strings, platform -1); it takes heap-sized strings; a copy of an entry built from the
// player carries the player's uuid and the defaults; the binary's destructor frees all three.
events.command.on(cmd => {
    if (!/^\/?pleprobe\s*$/.test(cmd)) return;
    try {
        const d = PlayerListEntry.construct();
        const dp = d as any as StaticPointer;
        const defaults = dp.getInt32(0) === -1 && dp.getInt32(4) === -1 && d.name === "" && d.xuid === "" && d.platformOnlineId === "" && d.buildPlatform === -1;
        d.name = "a-name-longer-than-fifteen";
        d.xuid = "12345678901234567890";
        const heap = d.name === "a-name-longer-than-fifteen" && d.xuid === "12345678901234567890";
        const real = PlayerListEntry.constructWith(player!);
        const copy = PlayerListEntry.construct(real);
        const rp = real as any as StaticPointer, cp = copy as any as StaticPointer;
        const sameUuid = rp.getBin64(8) === cp.getBin64(8) && rp.getBin64(16) === cp.getBin64(16) && rp.getBin64(8) !== "\u0000\u0000\u0000\u0000";
        const copyDefaults = cp.getInt32(0) === -1 && copy.name === "" && copy.buildPlatform === -1;
        const detail = `defaults ${defaults} heap ${heap} copy uuid ${sameUuid} copy defaults ${copyDefaults} (real name ${real.name})`;
        d.destruct();
        copy.destruct();
        real.destruct();
        say("pleprobe", defaults && heap && sameUuid && copyDefaults, `${detail}; three destructed`);
    } catch (err) {
        say("pleprobe", false, `threw ${(err as Error).message}`);
    }
});

// SimulatedPlayer::create (bdsx:SimulatedPlayer::create) and SimulatedPlayer::tryGetFromEntity (derived): "simprobe
// create" makes "simbot" two blocks south of the player; "simprobe check" -- it is in the level's players, a Player named
// simbot where it was put, tryGetFromEntity finds it and not the bot.
let simbot: SimulatedPlayer | null = null;
events.command.on(cmd => {
    const m = /^\/?simprobe\s+(create|check|attack)\s*$/.exec(cmd);
    if (m === null) return;
    try {
        if (m[1] === "create") {
            simbot = SimulatedPlayer.create("simbot", { x: 29, y: 68, z: 18 }, 0);
            say("simprobe create", simbot !== null, `returned ${simbot}`);
            return;
        }
        if (m[1] === "attack") {
            // a pig summoned next to simbot this same tick: the first attack lands, the second is inside the 10-tick cooldown
            bedrockServer.executeCommand("summon pig 30 68 18");
            const pigs = simbot!.fetchNearbyActorsSorted(Vec3.create(6, 6, 6), ActorType.Pig);
            if (pigs.length === 0) { say("simprobe attack", false, "no pig within 6 blocks"); return; }
            const pig = pigs[0].entity;
            const h0 = pig.getHealth();
            const first = simbot!.simulateAttack(pig);
            const h1 = pig.getHealth();
            const second = simbot!.simulateAttack(pig);
            const h2 = pig.getHealth();
            say("simprobe attack", first === true && h1 < h0 && second === false && h2 === h1, `first ${first} health ${h0} -> ${h1}; second ${second} -> ${h2} (want true and lower, then false and unchanged)`);
            return;
        }
        const players = bedrockServer.level.getPlayers().map(p => p.getName());
        const pos = simbot!.getPosition();
        const flagged = SimulatedPlayer.tryGetFromEntity((simbot as any).ctxbase, false);
        const notBot = SimulatedPlayer.tryGetFromEntity((player as any).ctxbase, false);
        const ok = players.includes("simbot") && simbot!.getName() === "simbot" && Math.abs(pos.x - 29.5) < 1 && Math.abs(pos.z - 18.5) < 1 && flagged !== null && notBot === null;
        say("simprobe check", ok, `players [${players.join(",")}] name ${simbot!.getName()} pos ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)} tryGetFromEntity(simbot) ${flagged !== null} (bot) ${notBot !== null}`);
    } catch (err) {
        say(`simprobe ${m[1]}`, false, `threw ${(err as Error).message}`);
    }
});

// SimulatedPlayer movement and looking (docs/findings-slots.md "SimulatedPlayer movement"): "simmove <step>" on simbot,
// checked by what the engine does with it over the next ticks (position, rotation, the block placed)
function afterTicks(n: number, fn: () => void): void {
    let t = 0;
    const tick = (): void => {
        if (++t < n) return;
        events.levelTick.remove(tick);
        try {
            fn();
        } catch (err) {
            say("simmove", false, `threw ${(err as Error).stack}`);
        }
    };
    events.levelTick.on(tick);
}
const wrapYaw = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;
const yawTo = (from: Vec3, x: number, z: number): number => wrapYaw((Math.atan2(-(x - from.x), z - from.z) * 180) / Math.PI);
let stopAt: Vec3 | null = null;
events.command.on(cmd => {
    const m = /^\/?simmove\s+(where|body|look|lookblock|lookactor|local|stop|stopped|moveto|navigate|place|stopdestroy)(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    const sb = simbot;
    if (sb === null) {
        say(`simmove ${m[1]}`, false, "no simbot");
        return;
    }
    try {
        const pos = Vec3.create(sb.getPosition());
        switch (m[1]) {
            case "where": {
                say("simmove where", null, `simbot at (${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}) alive ${sb.isAlive()} dimension ${sb.getDimensionId()}`);
                break;
            }
            case "body": {
                const want = Number(m[2] ?? "90");
                sb.simulateSetBodyRotation(want);
                const got = sb.getRotation().y;
                say(`simmove body ${want}`, Math.abs(wrapYaw(got - want)) < 0.5, `simulateSetBodyRotation(${want}) -> getRotation().y ${got.toFixed(2)}`);
                break;
            }
            case "look": {
                // a point 5 blocks east (+x): Bedrock's yaw for +x is -90
                sb.simulateLookAt(Vec3.create(pos.x + 5, pos.y + 1.6, pos.z));
                afterTicks(3, () => {
                    const y = sb.getRotation().y;
                    say("simmove look Vec3", Math.abs(wrapYaw(y - -90)) < 5, `simulateLookAt((x+5, eye, z)) -> yaw ${y.toFixed(2)} after 3 ticks (want -90)`);
                });
                break;
            }
            case "lookblock": {
                // the block 5 west (-x): yaw 90
                sb.simulateLookAt(BlockPos.create(Math.floor(pos.x) - 5, Math.floor(pos.y) + 1, Math.floor(pos.z)));
                afterTicks(3, () => {
                    const y = sb.getRotation().y;
                    say("simmove look BlockPos", Math.abs(wrapYaw(y - 90)) < 8, `simulateLookAt(BlockPos 5 west) -> yaw ${y.toFixed(2)} after 3 ticks (want ~90)`);
                });
                break;
            }
            case "lookactor": {
                const pigs = sb.fetchNearbyActorsSorted(Vec3.create(16, 8, 16), ActorType.Pig);
                if (pigs.length === 0) {
                    say("simmove look Actor", false, "no pig near simbot");
                    break;
                }
                const pig = pigs[0].entity;
                sb.simulateLookAt(pig);
                afterTicks(3, () => {
                    const pp = pig.getPosition(), now = sb.getPosition();
                    const want = yawTo(now, pp.x, pp.z), y = sb.getRotation().y;
                    say("simmove look Actor", Math.abs(wrapYaw(y - want)) < 10, `simulateLookAt(pig) -> yaw ${y.toFixed(2)} after 3 ticks (want ${want.toFixed(2)}, toward the pig)`);
                });
                break;
            }
            case "local": {
                // forward (local +z) at speed 1 for 20 ticks
                sb.simulateLocalMove(Vec3.create(0, 0, 1), 1);
                afterTicks(20, () => {
                    const now = sb.getPosition();
                    const d = Math.hypot(now.x - pos.x, now.z - pos.z);
                    say("simmove local", d > 1, `simulateLocalMove(forward, 1): moved ${d.toFixed(2)} blocks in 20 ticks, (${pos.x.toFixed(1)},${pos.z.toFixed(1)}) -> (${now.x.toFixed(1)},${now.z.toFixed(1)})`);
                });
                break;
            }
            case "stop": {
                sb.simulateStopMoving();
                afterTicks(4, () => {
                    stopAt = Vec3.create(sb.getPosition());
                    say("simmove stop", null, `simulateStopMoving() at (${stopAt.x.toFixed(2)},${stopAt.z.toFixed(2)})`);
                });
                break;
            }
            case "stopped": {
                if (stopAt === null) {
                    say("simmove stopped", false, "no stop step before");
                    break;
                }
                const d = Math.hypot(pos.x - stopAt.x, pos.z - stopAt.z);
                say("simmove stopped", d < 0.2, `moved ${d.toFixed(3)} blocks since the stop settled (want ~0)`);
                break;
            }
            case "moveto": {
                const tx = Math.floor(pos.x) + 3.5, tz = Math.floor(pos.z) + 0.5;
                sb.simulateMoveToLocation(Vec3.create(tx, pos.y, tz), 1, true);
                afterTicks(60, () => {
                    const now = sb.getPosition();
                    const d = Math.hypot(now.x - tx, now.z - tz);
                    say("simmove moveto", d < 1, `simulateMoveToLocation((${tx},${tz}), 1, true): ${d.toFixed(2)} blocks from the target after 60 ticks, at (${now.x.toFixed(1)},${now.z.toFixed(1)})`);
                    sb.simulateStopMoving();
                });
                break;
            }
            case "navigate": {
                const tx = Math.floor(pos.x) + 0.5, tz = Math.floor(pos.z) - 2.5;
                sb.simulateNavigateToLocations([Vec3.create(tx, pos.y, tz)], 1);
                afterTicks(140, () => {
                    const now = sb.getPosition();
                    const d = Math.hypot(now.x - tx, now.z - tz);
                    say("simmove navigate", d < 1, `simulateNavigateToLocations([(${tx},${tz})], 1): ${d.toFixed(2)} blocks from it after 140 ticks, at (${now.x.toFixed(1)},${now.z.toFixed(1)}), from (${pos.x.toFixed(1)},${pos.z.toFixed(1)})`);
                    sb.simulateStopMoving();
                });
                break;
            }
            case "place": {
                // slot 0 holds dirt (the driver gives it); use it on the top face (1) of the stone floor the driver laid at
                // y 67, two blocks east of simbot
                const bx = Math.floor(pos.x) + 2, by = 67, bz = Math.floor(pos.z);
                const r = sb.simulateUseItemInSlotOnBlock(0, BlockPos.create(bx, by, bz), 1, Vec3.create(0.5, 1, 0.5));
                afterTicks(2, () => {
                    const t = bedrockServer.executeCommand(`testforblock ${bx} ${by + 1} ${bz} dirt`, CommandResultType.Data);
                    say("simmove place", r === true && t.isSuccess(), `simulateUseItemInSlotOnBlock(0, (${bx},${by},${bz}), up) -> ${r}; dirt at (${bx},${by + 1},${bz}): ${t.isSuccess()}`);
                });
                break;
            }
            case "stopdestroy": {
                sb.simulateStopDestroyingBlock();
                say("simmove stopdestroy", null, "simulateStopDestroyingBlock() returned (no effect observed)");
                break;
            }
        }
    } catch (err) {
        say(`simmove ${m[1]}`, false, `threw ${(err as Error).stack}`);
    }
});
// SimulatedPlayer actions driving never-fired events (next-steps Q2), behind SIMACT_PROBE=1: "simact destroy|use|crit"
// has simbot break the block at 31 68 18, use hotbar slot 0 (a snowball), or jump and then hit a pig while falling;
// "simact seen <destroy|use|crit>" -- the matching bdsx event fired for simbot.
const simSeen: string[] = [];
let simCancel = false;
let blockCancel = false; // chestOpen / buttonPress only, so itemUseOnBlock lets the use through
if (process.env.SIMACT_PROBE === "1") {
    events.blockDestroy.on(ev => {
        simSeen.push(`destroy ${ev.player.getName()} ${ev.blockPos.x},${ev.blockPos.y},${ev.blockPos.z}${simCancel ? " cancelled" : ""}`);
        if (simCancel) say("blockDestroy", null, `call ${simSeen.filter(e => e.endsWith("cancelled")).length}: ${simSeen[simSeen.length - 1]} item ${ev.itemStack.toString()}`);
        if (simCancel) return CANCEL;
    });
    events.playerUseItem.on(ev => void simSeen.push(`use ${ev.player.getName()} method ${ev.useMethod} consume ${ev.consumeItem}`));
    events.playerDropItem.on(ev => {
        simSeen.push(`drop ${ev.player.getName()} ${ev.itemStack.toString()}${simCancel ? " cancelled" : ""}`);
        if (simCancel) return CANCEL;
    });
    if (process.env.SIMACT_NOINTER !== "1") events.playerInteract.on(ev => {
        simSeen.push(`interact ${ev.player.getName()} -> ${culpritName(ev.victim)}${simCancel ? " cancelled" : ""}`);
        if (simCancel) return CANCEL;
    });
    events.chestOpen.on(ev => {
        simSeen.push(`chest ${ev.player.getName()} ${ev.blockPos.x},${ev.blockPos.y},${ev.blockPos.z}${blockCancel ? " cancelled" : ""}`);
        if (blockCancel) return CANCEL;
    });
    if (process.env.SIMACT_NOBUTTON !== "1") events.buttonPress.on(ev => {
        simSeen.push(`button ${ev.player.getName()} ${ev.blockPos.x},${ev.blockPos.y},${ev.blockPos.z}${blockCancel ? " cancelled" : ""}`);
        if (blockCancel) return CANCEL;
    });
    events.attackBlock.on(ev => {
        simSeen.push(`attack ${ev.player === null ? "null" : ev.player.getName()} ${ev.blockPos.x},${ev.blockPos.y},${ev.blockPos.z} ${ev.block.getName()}${simCancel ? " cancelled" : ""}`);
        if (simCancel) return CANCEL;
    });
    events.itemUseOnBlock.on(ev => {
        simSeen.push(`useon ${culpritName(ev.actor)} ${ev.x},${ev.y},${ev.z} face ${ev.face} click ${ev.clickX.toFixed(2)},${ev.clickY.toFixed(2)},${ev.clickZ.toFixed(2)}${simCancel ? " cancelled" : ""}`);
        if (simCancel) return CANCEL;
    });
    events.itemUse.on(ev => {
        simSeen.push(`itemuse ${ev.player.getName()} ${ev.itemStack.toString()}${simCancel ? " cancelled" : ""}`);
        if (simCancel) return CANCEL;
    });
    events.entityStartSwimming.on(ev => {
        simSeen.push(`swim ${culpritName(ev.entity)}${simCancel ? " cancelled" : ""}`);
        if (simCancel) return CANCEL;
    });
    events.playerSleepInBed.on(ev => {
        simSeen.push(`sleep ${ev.player.getName()} ${ev.pos.x},${ev.pos.y},${ev.pos.z}${simCancel ? " cancelled" : ""}`);
        if (simCancel) return CANCEL;
    });
    events.blockInteractedWith.on(ev => {
        simSeen.push(`biw ${ev.player.getName()} ${ev.blockPos.x},${ev.blockPos.y},${ev.blockPos.z}${blockCancel ? " cancelled" : ""}`);
        if (blockCancel) return CANCEL;
    });
    if (process.env.SIMACT_NOCRIT !== "1") events.playerCrit.on(ev => void simSeen.push(`crit ${ev.player.getName()} -> ${culpritName(ev.victim)}`));
}
events.command.on(cmd => {
    const m = /^\/?simact\s+(destroy|use|crit|seen|cancel|count|drop|bed|swim|place|interact|useon|bow)(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    try {
        if (m[1] === "seen") {
            if (m[2] === "swimming" || m[2] === "dry") {
                const lastSwim = simSeen.filter(e => e.startsWith("swim ")).pop() ?? "";
                say(`simact seen ${m[2]}`, m[2] === "dry" ? lastSwim.endsWith("cancelled") : lastSwim === "swim minecraft:player" || lastSwim === "swim simbot", simSeen.join(" ; "));
                return;
            }
            if (m[2] === "asleep" || m[2] === "awake") {
                const asleep = simbot!.isSleeping();
                say(`simact seen ${m[2]}`, asleep === (m[2] === "asleep"), `isSleeping ${asleep} ; ${simSeen.join(" ; ")}`);
                return;
            }
            const hit = m[2] === "cancelled" ? simSeen.some(s => s.endsWith("cancelled")) : simSeen.some(s => s.startsWith(`${m[2]} simbot`) && !s.endsWith("cancelled"));
            say(`simact seen ${m[2]}`, hit, simSeen.join(" ; "));
            return;
        }
        if (m[1] === "cancel" && (m[2] === "blockon" || m[2] === "blockoff")) {
            blockCancel = m[2] === "blockon";
            say(`simact cancel ${m[2]}`, null, "");
            return;
        }
        if (m[1] === "cancel") {
            simCancel = m[2] === "on";
            say(`simact cancel ${m[2]}`, null, "");
            return;
        }
        if (m[1] === "count") {
            // "simact count <x>" -- exactly one destroy event at x,68,18 (GameMode::destroyBlock sees survival breaking
            // through SurvivalMode's thunk, so one hook must not fire twice)
            const n = simSeen.filter(e => e.startsWith(`destroy simbot ${m[2]},68,18`)).length;
            say(`simact count ${m[2]}`, n === 1, `${n} destroy event(s) at ${m[2]},68,18`);
            return;
        }
        if (m[1] === "bow") {
            // the held-back isUsingItem candidate (docs/findings-layouts.md "Candidates held back"): the ItemStack at
            // Player+1840 is not null exactly while the USINGITEM actor flag is set -- simbot before and while drawing
            // a bow, and the connected bot, which never uses anything
            const cand = (p: Player): string => {
                const slot = !(p as any as StaticPointer).addAs(ItemStack, 1840).isNull();
                if (p.isUsingItem() !== slot) return `isUsingItem ${p.isUsingItem()} disagrees with slot ${slot}`;
                return `slot ${slot} flag ${p.getStatusFlag(ActorFlags.UsingItem)}`;
            };
            const before = cand(simbot!);
            const r = simbot!.simulateUseItemInSlot(0);
            const during = cand(simbot!);
            const bot = cand(player!);
            const ok = before === "slot false flag false" && during === "slot true flag true" && bot === "slot false flag false";
            say("simact bow", ok, `simbot before: ${before}; use -> ${r}; drawing: ${during}; bot: ${bot}`);
            return;
        }
        if (m[1] === "useon") {
            // the stick in slot 0 used on the block at <x> 68 18 (a chest or a button)
            const x = +m[2]!;
            buttonPtrs[`before${x}`] = blockPtrAt(x, 68, 18);
            const r = simbot!.simulateUseItemOnBlock(simbot!.getInventory().container.getItem(0), BlockPos.create(x, 68, 18), 2, Vec3.create(0.5, 0.5, 0));
            // a button stays pressed about a second: read it in this same tick
            say(`simact useon ${x}`, null, `simulateUseItemOnBlock -> ${r}${blockCancel ? " (block cancelled)" : ""}`);
            buttonPtrs[`after${x}`] = blockPtrAt(x, 68, 18);
            if (blockNameAt(x, 68, 18) === "minecraft:stone_button") {
                // the press may land on a later tick; watch for five
                let ticks = 0;
                const watch = (): void => {
                    const t = bedrockServer.executeCommand(`testforblock ${x} 68 18 stone_button ["button_pressed_bit"=true]`, CommandResultType.Data);
                    if (t.isSuccess() || ++ticks >= 5) {
                        events.levelTick.remove(watch);
                        say(`simact pressed ${x}`, null, `${t.isSuccess()} after ${ticks} tick(s)`);
                    }
                };
                events.levelTick.on(watch);
            }
            return;
        }
        if (m[1] === "interact") {
            // what the GameTest "interactWithEntity" binding does: Player::interact(result, cow, Vec3::ZERO) -- with a
            // bucket in hand, milking the cow turns it into a milk bucket
            // one live cow for both calls: killing and resummoning in the same tick can hand back the dying one
            let cows = simbot!.fetchNearbyActorsSorted(Vec3.create(4, 4, 4), ActorType.Cow).filter(c => c.entity.isAlive());
            if (cows.length === 0) {
                bedrockServer.executeCommand("execute as @a[name=simbot] at @s run summon cow ~1 ~ ~");
                cows = simbot!.fetchNearbyActorsSorted(Vec3.create(4, 4, 4), ActorType.Cow);
            }
            if (cows.length === 0) { say("simact interact", false, "no cow"); return; }
            const result = new AllocatedPointer(8);
            result.fill(0, 8);
            const interact = makefunc.js(proc["bdsx:Player::interact"], VoidPointer, null, VoidPointer, VoidPointer, VoidPointer, VoidPointer);
            interact(simbot as any, result, cows[0].entity as any, Vec3.create(0, 0, 0) as any);
            const hand = simbot!.getInventory().container.getItem(0).toString().replace(/\[ItemStackNetId.*?\]\] /, "");
            say("simact interact", null, `result bit0 ${result.getUint8(0) & 1}; hand ${hand}${simCancel ? " (cancelled)" : ""}`);
            return;
        }
        if (m[1] === "place") {
            // the item in slot 0 used on the top face of the floor block at <x> 67 18
            const x = +m[2]!;
            const c = simbot!.getInventory().container;
            const slots: string[] = [];
            for (let i = 0; i < 9; i++) if (!c.getItem(i).isNull()) slots.push(`${i}:${c.getItem(i).toString().replace(/\[ItemStackNetId.*?\]\] /, "")}`);
            const item = c.getItem(0);
            const r = simbot!.simulateUseItemOnBlock(item, BlockPos.create(x, 67, 18), 1, Vec3.create(0.5, 1, 0.5));
            say(`simact place ${x} hotbar`, null, slots.join(" "));
            say(`simact place ${x}`, null, `simulateUseItemOnBlock(${item.toString()}) -> ${r}`);
            return;
        }
        if (m[1] === "swim") {
            // what the GameTest "swim" binding does: the player's own startSwimming virtual; the slot is found by the
            // address the table ships (40 slot 99, 51 slot 98 -- read off both bindings)
            const vft = (simbot as any as StaticPointer).getPointer(0);
            const target = proc["?startSwimming@Player@@UEAAXXZ"];
            let slot = -1;
            for (let i = 90; i < 110; i++) if (vft.getPointer(i * 8).equalsptr(target)) { slot = i; break; }
            if (slot < 0) { say("simact swim", false, "startSwimming is not in simbot's table 90..110"); return; }
            makefunc.js(vft.getPointer(slot * 8), void_t, null, VoidPointer)(simbot as any);
            say("simact swim", null, `slot ${slot} called; isSwimming ${simbot!.isSwimming()}${simCancel ? " (cancelled)" : ""}`);
            if (!simCancel) makefunc.js(vft.getPointer((slot + 1) * 8), void_t, null, VoidPointer)(simbot as any); // stopSwimming, the binding's next slot
            return;
        }
        if (m[1] === "bed") {
            // an empty hand used on the bed at 31 68 18, the way a player right-clicks it
            const stick = simbot!.getInventory().container.getItem(0);
            const r = simbot!.simulateUseItemOnBlock(stick, BlockPos.create(31, 68, 18), 1, Vec3.create(0.5, 0.5, 0.5));
            say("simact bed", null, `simulateUseItemOnBlock(${stick.toString()}, bed) -> ${r}; sleeping ${simbot!.isSleeping()}${simCancel ? " (cancelled)" : ""}`);
            return;
        }
        if (m[1] === "drop") {
            // what the GameTest "dropSelectedItem" binding does: the player's own drop virtual on the selected item,
            // randomly = false. The slot differs per build (40 +0x3a0, 51 +0x398, read off each binding's body); only
            // the one holding the shipped Player::drop is called
            const item = simbot!.getInventory().container.getItem(0);
            const vt = (simbot as any as StaticPointer).getPointer(0);
            const want = proc["?drop@Player@@UEAA_NAEBVItemStack@@_N@Z"];
            const off = [0x3a0, 0x398].find(o => vt.getPointer(o).equalsptr(want));
            if (off === undefined) { say("simact drop", false, "neither +0x3a0 nor +0x398 holds Player::drop"); return; }
            const drop = makefunc.js(vt.getPointer(off), bool_t, null, VoidPointer, VoidPointer, bool_t);
            bedrockServer.executeCommand("kill @e[type=item]", CommandResultType.Data);
            const before = item.toString();
            const r = drop(simbot as any, item as any, false);
            // the item entity appears the same tick; look one tick later to be safe
            let ticks = 0;
            const look = (): void => {
                if (++ticks < 2) return;
                events.levelTick.remove(look);
                const t = bedrockServer.executeCommand("testfor @e[type=item]", CommandResultType.Data);
                say("simact drop", null, `slot +0x${off.toString(16)}; ${before} -> drop ${r}; an item entity exists: ${t.isSuccess()}${simCancel ? " (cancelled)" : ""}`);
            };
            events.levelTick.on(look);
            return;
        }
        if (m[1] === "destroy") {
            const x = m[2] === undefined ? 31 : +m[2];
            say(`simact destroy ${x}`, null, `simulateDestroyBlock -> ${simbot!.simulateDestroyBlock(BlockPos.create(x, 68, 18), 1)}`);
        } else if (m[1] === "use") {
            const slot0 = simbot!.getInventory().container.getItem(0).toString();
            say("simact use", null, `slot 0 ${slot0}; simulateUseItemInSlot(0) -> ${simbot!.simulateUseItemInSlot(0)}`);
        } else {
            bedrockServer.executeCommand("execute as @a[name=simbot] at @s run summon pig ~1 ~ ~");
            let pigs = simbot!.fetchNearbyActorsSorted(Vec3.create(6, 6, 6), ActorType.Pig);
            if (pigs.length === 0) {
                bedrockServer.executeCommand("summon pig 30 68 18");
                pigs = simbot!.fetchNearbyActorsSorted(Vec3.create(6, 6, 6), ActorType.Pig);
            }
            if (pigs.length === 0) { say("simact crit", false, `no pig near simbot at ${simbot!.getPosition().toString()}`); return; }
            const pig = pigs[0].entity;
            const y0 = simbot!.getPosition().y;
            const jumped = (simbot as any).simulateJump();
            // timers only run when the node loop is pumped, not per tick, so wait on levelTick: the attack goes in on the
            // way down, when y has started to fall back toward y0
            let ticks = 0,
                top = y0;
            const onTick = (): void => {
                ticks++;
                const y = simbot!.getPosition().y;
                if (y > top) top = y;
                if ((top > y0 && y < top) || ticks > 20) {
                    events.levelTick.remove(onTick);
                    try {
                        const hit = simbot!.simulateAttack(pig);
                        say("simact crit", null, `jump ${jumped}, attack at tick ${ticks} y ${y.toFixed(2)} (top ${top.toFixed(2)}, ground ${y0.toFixed(2)}) -> ${hit}`);
                    } catch (err) {
                        say("simact crit", false, `threw ${(err as Error).message}`);
                    }
                }
            };
            events.levelTick.on(onTick);
        }
    } catch (err) {
        say(`simact ${m[1]}`, false, `threw ${(err as Error).message}`);
    }
});

// InventoryTransaction reads (next-steps A1, docs/findings-nbt.md section 28), behind INVTX_PROBE=1: a hook on the engine's
// own InventoryTransaction::addAction (40 0x258cbb0 / 51 0x2a67320) reads the transaction the engine just added to while
// "invtx arm" is on. For every call: the map's keys (walked here, not through bdsx), getActions for the added action's
// source holds a copy of it (source, slot, both stacks read back), every key the map holds is found at its own node, and
// sources the map does not hold give an empty vector. On the first WorldInteraction call (Player::drop's), addItemToContent
// with the dropped stack merges into the engine's own group (+3, then -3 back), and with a stack the content does not hold
// appends a group bdsx reads back (then removed again, it holds no tag). "invtx layout" -- InventoryAction's offsets;
// "invtx report" -- how many calls were seen.
if (process.env.INVTX_PROBE === "1") {
    let armed = false;
    let calls = 0;
    let contentTested = false;
    let groupsTested = false;
    let roundsDone = false;
    let syntheticDone = false;
    const keyOf = (p: StaticPointer): string => `${p.getInt32(0)}/${p.getInt8(4)}/${p.getUint32(8)}`;
    const sameKey = (a: StaticPointer, b: StaticPointer): boolean => {
        const t = a.getUint32(0);
        if (t !== b.getUint32(0)) return false;
        if (t === 0 || t === 99999) return a.getUint8(4) === b.getUint8(4);
        if (t === 1 || t === 3) return true;
        if (t === 2) return a.getUint32(8) === b.getUint32(8);
        return false;
    };
    const stackText = (s: ItemStack): string => (s.isNull() ? "empty" : `${s.getName()} x${s.getAmount()}`);
    const groups = (tx: InventoryTransaction): string =>
        tx.content
            .toArray()
            .map(g => `${g.itemId}:${g.itemAux}:${g.count}${g.overflow ? "!" : ""}`)
            .join(",");
    const check = (tx: InventoryTransaction, action: InventoryAction): void => {
        const n = ++calls;
        const raw = tx as any as StaticPointer;
        // the map, walked here: sentinel at +8, count at +0x10, node next +0, key +0x10, vector +0x20
        const head = raw.getPointer(8);
        const size = raw.getUint32(0x10);
        const nodes: NativePointer[] = [];
        for (let node = head.getPointer(0); !node.equalsptr(head) && nodes.length < 64; node = node.getPointer(0)) nodes.push(node);
        const keys = nodes.map(nd => keyOf(nd.add(0x10)));
        const src = action.source as any as StaticPointer;
        const srcKey = keyOf(src);
        say(`invtx #${n} map`, nodes.length === size && keys.includes(srcKey), `size ${size}, walked ${nodes.length} [${keys.join(" ")}]; added ${srcKey} slot ${action.slot} from ${stackText(action.from)} to ${stackText(action.to)}`);

        const acts = tx.getActions(action.source);
        const hit = acts.find(
            a =>
                sameKey(a.source as any, src) &&
                a.slot === action.slot &&
                stackText(a.from) === stackText(action.from) &&
                stackText(a.to) === stackText(action.to),
        );
        say(
            `invtx #${n} getActions(${srcKey})`,
            hit !== undefined && !(hit as any as StaticPointer).equalsptr(action as any),
            `${acts.length} action(s) [${acts.map(a => `${keyOf(a.source as any)} slot ${a.slot} ${stackText(a.from)} -> ${stackText(a.to)}`).join(" ; ")}]`,
        );

        const perKey = nodes.map(nd => {
            const v = (tx as any)._getActions(nd.add(0x10).as(InventorySource)) as StaticPointer;
            return { key: keyOf(nd.add(0x10)), at: v.equalsptr(nd.add(0x20)), n: tx.getActions(nd.add(0x10).as(InventorySource)).length };
        });
        say(`invtx #${n} every key`, perKey.every(k => k.at && k.n > 0), perKey.map(k => `${k.key} ${k.at ? "own node" : "ELSEWHERE"} ${k.n}`).join(" ; "));

        const absent: [number, number, number][] = [
            [0, 0, 0],
            [0, 119, 0],
            [0, -1, 0],
            [1, 0, 0],
            [2, -1, 0],
            [2, -1, 1],
            [3, 0, 0],
            [99999, 0, 0],
            [-1, 0, 0],
            [100, 0, 0],
        ];
        const empties: string[] = [];
        let emptyOk = true;
        for (const [t, c, f] of absent) {
            const s = new InventorySource(true);
            s.type = t;
            s.containerId = c & 0xff;
            s.flags = f;
            const sp = s as any as StaticPointer;
            // a key the map holds (by 1.26's equality) is not an absent one; types other than 0-3/99999 never compare equal
            if (nodes.some(nd => sameKey(nd.add(0x10) as any, sp))) continue;
            const len = tx.getActions(s).length;
            empties.push(`${keyOf(sp)} ${len}`);
            if (len !== 0) emptyOk = false;
        }
        say(`invtx #${n} absent sources`, emptyOk && empties.length > 0, empties.join(" ; "));

        // InventoryTransactionItemGroup::getItemInstance (40 0x258c920 / 51 0x2a67090): for every group the engine's content
        // holds, the returned stack is this build's ItemStack with the group's id and aux and count 1, and names the item
        // the transaction's own actions hold under that id. Values are copied out at once (toArray() gives views).
        const vptrOf = (s: ItemStack): string => (s as any as StaticPointer).getPointer(0).toString();
        const names = new Map<number, string>();
        let stackVptr: string | null = null;
        for (const nd of nodes) {
            for (const a of tx.getActions(nd.add(0x10).as(InventorySource))) {
                for (const s of [a.from, a.to]) {
                    if (stackVptr === null) stackVptr = vptrOf(s);
                    if (!s.isNull()) names.set(s.getId(), s.getName());
                }
            }
        }
        const gs = tx.content.toArray().map(g => ({ id: g.itemId, aux: g.itemAux, count: g.count, tag: (g as any as StaticPointer).getNullablePointer(8) }));
        const outs: string[] = [];
        let groupsOk = gs.length > 0;
        tx.content.toArray().forEach((g, i) => {
            const want = gs[i];
            const out = g.getItemStack();
            try {
                const got = {
                    vptr: vptrOf(out),
                    isNull: out.isNull(),
                    id: out.getId(),
                    aux: out.getAuxValue(),
                    amount: out.getAmount(),
                    name: out.isNull() ? "" : out.getName(),
                    ud: (out as any as StaticPointer).getNullablePointer(16),
                };
                const ok =
                    got.vptr === stackVptr &&
                    !got.isNull &&
                    got.id === want.id &&
                    got.aux === want.aux &&
                    got.amount === 1 &&
                    names.get(want.id) === got.name &&
                    want.tag === null &&
                    got.ud === null;
                if (!ok) groupsOk = false;
                outs.push(`{${want.id},${want.aux},${want.count}${want.tag ? ",tag" : ""}} -> ${got.name} x${got.amount} id ${got.id} aux ${got.aux} ud ${got.ud ? "set" : "null"}${got.vptr === stackVptr ? "" : " VPTR " + got.vptr}`);
            } finally {
                out.destruct();
            }
        });
        if (gs.length > 0) {
            groupsTested = true;
            say(`invtx #${n} getItemStack`, groupsOk, `${gs.length} group(s): ${outs.join(" ; ")}; names by id [${[...names].map(([k, v]) => `${k}=${v}`).join(" ")}]`);
            if (!roundsDone) {
                roundsDone = true;
                const g0 = tx.content.get(0)!;
                let bad = 0;
                for (let r = 0; r < 200; r++) {
                    const s = g0.getItemStack();
                    if (s.getId() !== gs[0].id || s.getAmount() !== 1) bad++;
                    s.destruct();
                }
                say("invtx getItemStack 200", bad === 0, `200 getItemStack + destruct on {${gs[0].id},${gs[0].aux}}: ${bad} bad`);
            }
        }
        if (!syntheticDone) {
            syntheticDone = true;
            // a group of bdsx's own with user data: the engine's ItemStack(Item&, 1, aux, tag) copies the tag, so the stack
            // has its own CompoundTag with the same content, and destructing it leaves the source's alone
            const src = ItemStack.constructWith("minecraft:diamond_sword", 1);
            src.setCustomName("getItemInstance");
            const srcUd = (src as any as StaticPointer).getNullablePointer(16);
            // raw memory, not new X(true): the class is abstract (no constructor). mem stays referenced to the end.
            const mem = new AllocatedPointer(0x18);
            mem.setInt32(src.getId(), 0);
            mem.setInt32(7, 4);
            mem.setPointer(srcUd, 8);
            mem.setInt32(4, 0x10);
            mem.setInt32(0, 0x14);
            const grp = mem.as(InventoryTransactionItemGroup);
            const out = grp.getItemStack();
            const outUd = (out as any as StaticPointer).getNullablePointer(16);
            const srcTag = JSON.stringify(src.save().tag);
            const outTag = JSON.stringify(out.save().tag);
            const res = `${out.getName()} x${out.getAmount()} aux ${out.getAuxValue()} ud ${outUd === null ? "null" : outUd.equalsptr(srcUd!) ? "SAME" : "own"}; tag ${outTag} vs ${srcTag}`;
            const tagOk = srcUd !== null && outUd !== null && !outUd.equalsptr(srcUd) && outTag === srcTag && out.getName() === src.getName() && out.getAmount() === 1 && out.getAuxValue() === 7;
            out.destruct();
            const after = JSON.stringify(src.save().tag);
            say("invtx getItemStack tag", tagOk && after === srcTag, `${res}; source after destruct ${after}`);
            // an id no item has: getItem gives an empty WeakPtr and the default (null) stack comes back
            mem.setInt32(0, 0);
            mem.setInt32(0, 4);
            mem.setPointer(null, 8);
            const nul = grp.getItemStack();
            say("invtx getItemStack id 0", nul.isNull() && nul.getAmount() === 0 && vptrOf(nul) === vptrOf(src), `isNull ${nul.isNull()} count ${nul.getAmount()} vptr ${vptrOf(nul) === vptrOf(src) ? "ItemStack" : vptrOf(nul)}`);
            nul.destruct();
            src.destruct();
            mem.setInt32(0, 0);
        }

        if (contentTested || action.source.type !== 2) return;
        contentTested = true;
        const stack = action.to.isNull() ? action.from : action.to;
        const before = groups(tx);
        // numbers, not the groups: toArray() gives views into the engine's vector, which the call below changes
        const vec = tx.content.toArray().map(g => ({ id: g.itemId, aux: g.itemAux, count: g.count }));
        const own = vec.findIndex(g => g.id === stack.getId() && g.aux === stack.getAuxValue());
        tx.addItemToContent(stack, 3);
        const plus = tx.content.toArray();
        const merged = own >= 0 && plus.length === vec.length && plus[own].count === vec[own].count + 3;
        const mid = groups(tx);
        tx.addItemToContent(stack, -3);
        const back = groups(tx);
        say(`invtx content merge`, merged && back === before, `${stackText(stack)} id ${stack.getId()} aux ${stack.getAuxValue()}: [${before}] +3 -> [${mid}] -3 -> [${back}]`);

        // a stack of bdsx's own that no drop in this driver involves, so the content cannot hold it already
        const other = ItemStack.constructWith("minecraft:diamond", 1);
        if (other.isNull() || tx.content.toArray().some(g => g.itemId === other.getId())) {
            say("invtx content new group", false, `constructWith(diamond) gave ${stackText(other)}; content [${groups(tx)}]`);
            other.destruct();
            return;
        }
        const len0 = tx.content.size();
        tx.addItemToContent(other, 2);
        const after = tx.content.toArray();
        const g = after[after.length - 1];
        const appended = after.length === len0 + 1 && g.itemId === other.getId() && g.itemAux === other.getAuxValue() && g.count === 2 && !g.overflow && (g as any as StaticPointer).getNullablePointer(8) === null;
        const shown = groups(tx);
        // drop the group again: it holds no CompoundTag, so moving the vector's end back frees nothing
        if (appended) {
            const cv = tx.content as any as StaticPointer;
            cv.setPointer(cv.getPointer(8).sub(0x18), 8);
        }
        say(`invtx content new group`, appended && groups(tx) === before, `${stackText(other)} id ${other.getId()} aux ${other.getAuxValue()} +2: [${shown}] -> removed [${groups(tx)}]`);
        other.destruct();
    };
    function onAddAction(tx: InventoryTransaction, action: InventoryAction): void {
        origAddAction(tx, action);
        if (!armed) return;
        try {
            check(tx, action);
        } catch (err) {
            say("invtx hook", false, `threw ${(err as Error).message}`);
        }
    }
    const origAddAction = procHacker.hooking("?addAction@InventoryTransaction@@QEAAXAEBVInventoryAction@@@Z", void_t, null, InventoryTransaction, InventoryAction)(onAddAction);
    events.command.on(cmd => {
        const m = /^\/?invtx\s+(arm|disarm|report|layout)\s*$/.exec(cmd);
        if (m === null) return;
        if (m[1] === "arm" || m[1] === "disarm") {
            armed = m[1] === "arm";
            say(`invtx ${m[1]}`, null, `calls so far ${calls}`);
            return;
        }
        if (m[1] === "layout") {
            const from = (InventoryAction as any).offsetOf("from") as number;
            const to = (InventoryAction as any).offsetOf("to") as number;
            const size = (InventoryAction as any)[NativeType.size] as number;
            // 1.26's addAction reads the from stack's count at +0xf2 and the to stack's at +0x18a (+0x22 into each), and
            // steps the vector by 0x200
            say("invtx layout", from === 0xd0 && to === 0x168 && size === 0x200, `from +0x${from.toString(16)} to +0x${to.toString(16)} size 0x${size.toString(16)}`);
            return;
        }
        say("invtx report", calls > 0 && contentTested && groupsTested && roundsDone && syntheticDone, `${calls} addAction call(s) seen while armed; content tested ${contentTested}; getItemStack groups ${groupsTested}, 200 rounds ${roundsDone}, synthetic ${syntheticDone}`);
    });
}

// levelExplode through Level::explode (next-steps Q2), behind EXPLODE_PROBE=1: "exprobe cancel|allow" sets what the
// listener returns; "exprobe seen <x>" -- an event near x (the TNT's x) with the mode that was set.
let explodeCancel = false;
const explosions: string[] = [];
if (process.env.EXPLODE_PROBE === "1") {
    events.levelExplode.on(ev => {
        explosions.push(`${Math.round(ev.position.x)} ${explodeCancel ? "cancel" : "allow"} power ${ev.power}`);
        say("levelExplode", null, explosions[explosions.length - 1]);
        if (explodeCancel) return CANCEL;
    });
}
events.command.on(cmd => {
    const m = /^\/?exprobe\s+(cancel|allow|seen)(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] !== "seen") { explodeCancel = m[1] === "cancel"; say(`exprobe ${m[1]}`, null, ""); return; }
    say(`exprobe seen ${m[2]}`, explosions.some(e => Math.abs(+e.split(" ")[0] - +m[2]!) <= 1), explosions.join(" ; "));
});

// ConnectionRequest in 1.26 (next-steps Q5): at login, dump the std::strings found in the request's first 0xc0 bytes
// (Endstone base_connection_request.h: optional<WebToken> raw_token_, RawGameServerToken, the authentication type) and,
// for each that looks like a JWT, its decoded payload -- where 2024's Certificate identity fields went.
let loginCert: { xuid: string; name: string; identity: string } | null = null;
events.command.on(cmd => {
    if (!/^\/?certprobe\s*$/.test(cmd)) return;
    try {
        // the login certificate (bdsx's API over the game server token) against the connected player: its name, the
        // uuid in its player-list entry (the engine's own), and its xuid
        const entry = PlayerListEntry.constructWith(player!);
        const uuid = mce.UUID.toString(entry.uuid);
        entry.destruct();
        let xuid = "(no getXuid)";
        try { xuid = player!.getXuid(); } catch (err) { xuid = `threw ${(err as Error).message}`; }
        // the name and xuid must match on both builds; 51 adopts the token's identity as the player's uuid, 40 makes up
        // its own for an offline player (a different one every session), so the uuid is judged on 51 only
        const on51 = String(pdbcache.bdsVersion).startsWith("1.26.51");
        const ok = loginCert !== null && loginCert.name === player!.getName() && loginCert.xuid === xuid && (!on51 || loginCert.identity === uuid);
        say("certprobe", ok, `login ${JSON.stringify(loginCert)} | player name ${player!.getName()} uuid ${uuid} xuid ${xuid}`);
    } catch (err) {
        say("certprobe", false, `threw ${(err as Error).message}`);
    }
});
if (process.env.LOGIN_PROBE === "1") {
    events.packetAfter(MinecraftPacketIds.Login).on(pk => {
        try {
            const req = (pk as any).connreq as StaticPointer | null;
            if (req === null) { say("loginprobe", false, "connreq null"); return; }
            const parts: string[] = [];
            for (let off = 8; off < 0xc0; off += 8) {
                const size = req.getInt32(off + 16), cap = req.getInt32(off + 24);
                if (size <= 0 || size > 100000 || cap < 15 || cap < size || req.getInt32(off + 20) !== 0 || req.getInt32(off + 28) !== 0) continue;
                const str = req.getCxxString(off);
                if (!/^[\x20-\x7e]+$/.test(str.slice(0, 40))) continue;
                let decoded = "";
                const seg = str.split(".");
                if (seg.length === 3) {
                    try { decoded = Buffer.from(seg[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").slice(0, 400); } catch { /* not base64 */ }
                }
                parts.push(`+0x${off.toString(16)} len ${size}: ${str.slice(0, 60)}${decoded ? ` | payload ${decoded}` : ""}`);
            }
            // the client-data WebToken's decoded payload (raw_token_ at +0x8: data_ at +0x30 in the token) -- its SelfSignedId
            const data = req.getCxxString(8 + 0x30);
            const m2 = /"SelfSignedId"\s*:\s*"([^"]*)"/.exec(data);
            say("loginprobe selfsigned", null, `client data ${data.length} chars, SelfSignedId ${m2 === null ? "(none)" : m2[1]}`);
            const cert = (pk as any).connreq.getCertificate();
            loginCert = { xuid: cert.getXuid(), name: cert.getIdentityName(), identity: cert.getIdentityString() };
            say("loginprobe cert", null, JSON.stringify(loginCert));
            say("loginprobe", null, `auth type candidates ${[0xa8, 0xb0, 0xb8].map(o => `+0x${o.toString(16)}=${req.getInt32(o)}`).join(" ")} | ${parts.join(" || ")}`);
        } catch (err) {
            say("loginprobe", false, `threw ${(err as Error).message}`);
        }
    });
}

// PlayerListPacket.getEntries (1.26 records), behind PLIST_PROBE=1: every PlayerList packet the server sends is decoded;
// "plprobe <name>" -- an add record for <name> was seen, with the player's own uuid when <name> is the bot.
const plSeen: string[] = [];
let plEntriesThrows = "";
if (process.env.PLIST_PROBE === "1") {
    // PLIST_CANCEL=<name>: CANCEL every PlayerList packet that adds <name> (the bot's own player_list log shows
    // whether it arrived), so a recipient-list broadcast is seen to be cancellable, not only seen
    const cancelName = process.env.PLIST_CANCEL;
    events.packetSend(MinecraftPacketIds.PlayerList).on(pk => {
        try {
            let cancel = false;
            for (const r of (pk as any).getEntries()) {
                plSeen.push(`${r.action} ${r.name ?? ""} ${mce.UUID.toString(r.uuid)} platform ${r.buildPlatform ?? ""}`);
                if (cancelName !== undefined && r.action === "add" && r.name === cancelName) cancel = true;
            }
            try { void (pk as any).entries; plEntriesThrows = "no"; } catch (err) { plEntriesThrows = (err as Error).message.slice(0, 60); }
            if (cancel) {
                plSeen.push(`cancelled ${cancelName}`);
                return CANCEL;
            }
        } catch (err) {
            plSeen.push(`threw ${(err as Error).message}`);
        }
    });
}
events.command.on(cmd => {
    const spawn = /^\/?plprobe\s+spawn\s+(\S+)\s*$/.exec(cmd);
    if (spawn !== null) {
        const sim = SimulatedPlayer.create(spawn[1], { x: 27, y: 68, z: 18 }, 0);
        say(`plprobe spawn ${spawn[1]}`, sim !== null, `returned ${sim}`);
        return;
    }
    const m = /^\/?plprobe\s+(\S+)\s*$/.exec(cmd);
    if (m === null) return;
    let want = `add ${m[1]} `;
    if (m[1] === player?.getName()) {
        const entry = PlayerListEntry.constructWith(player!);
        want += mce.UUID.toString(entry.uuid);
        entry.destruct();
    }
    say(`plprobe ${m[1]}`, plSeen.some(e => e.startsWith(want)) && plEntriesThrows.startsWith("PlayerListPacket.entries"), `want "${want}" | entries throws: ${plEntriesThrows} | ${plSeen.length} seen: ${plSeen.filter(e => e.includes(m[1])).slice(0, 4).join(" ; ")}`);
});

// RawPacket.sendTo (NetworkSystem::_sendInternal on 1.26): "rawprobe <n>" sends a hand-built SetHealth(n) to the bot,
// whose log prints "health <n>" when it arrives -- the check is in the bot's .bot.log, this line only says it was sent.
events.command.on(cmd => {
    const m = /^\/?rawprobe\s+(\d+)\s*$/.exec(cmd);
    if (m === null) return;
    if (player === null) { say("rawprobe", false, "no player"); return; }
    const raw = new RawPacket(MinecraftPacketIds.SetHealth);
    try {
        raw.writeVarInt(+m[1]);
        raw.sendTo(player.getNetworkIdentifier());
        say(`rawprobe ${m[1]}`, null, "sent SetHealth through RawPacket.sendTo; the bot log must show 'health " + m[1] + "'");
    } catch (err) {
        say(`rawprobe ${m[1]}`, false, `threw ${(err as Error).message}`);
    } finally {
        raw.dispose();
    }
});

// "btnprobe <x>": setblock a pressed stone button at <x> 68 18 and, in the same tick, ask testforblock whether it is
// pressed -- the control for "simact pressed"
events.command.on(cmd => {
    const m = /^\/?btnprobe\s+(\d+)\s*$/.exec(cmd);
    if (m === null) return;
    const set = bedrockServer.executeCommand(`setblock ${m[1]} 68 18 stone_button ["facing_direction"=2,"button_pressed_bit"=true]`, CommandResultType.Data);
    if (!set.isSuccess()) say(`btnprobe ${m[1]}`, null, "setblock of a pressed button failed");
    const t = bedrockServer.executeCommand(`testforblock ${m[1]} 68 18 stone_button ["button_pressed_bit"=true]`, CommandResultType.Data);
    const f = bedrockServer.executeCommand(`testforblock ${m[1]} 68 18 stone_button ["button_pressed_bit"=false]`, CommandResultType.Data);
    say(`btnprobe ${m[1]}`, null, `pressed=true ${t.isSuccess()} pressed=false ${f.isSuccess()} name ${blockNameAt(+m[1], 68, 18)}`);
    // a pressed button placed by setblock vs. what simbot's uses left behind (same facing): the pointers say which
    // uses pressed the button without trusting testforblock's state matching
    const pressed = blockPtrAt(+m[1], 68, 18);
    const rows = Object.entries(buttonPtrs).map(([k, p]) => `${k}${p === pressed ? "=PRESSED" : ""}`);
    const ok = buttonPtrs.before33 !== pressed && buttonPtrs.after33 === pressed && buttonPtrs.after32 !== pressed;
    say(`btnprobe ptr`, ok, `pressed permutation ${pressed}; ${rows.join(" ")} (want after33 pressed, before33 and the cancelled after32 not)`);
});

// hasDimension's false side (docs/findings-layouts.md "Candidates held back"): "dimwatch" samples, every tick for 400
// ticks, the dimension reference (layouts.Actor.dimensionRef: the WeakRef<Dimension> pointer, its control block at +8
// and that block's use count) of the bot and simbot, logging each change; "dimreport" prints the log. The candidate
// test is `control != null && uses != 0 && pointer != null`.
const dimLog: string[] = [];
function dimSample(a: Player): string {
    const off = (pdbcache.layouts as any).Actor?.dimensionRef as number | undefined;
    if (off === undefined) return "no layout";
    const sp = a as unknown as StaticPointer;
    const p = sp.getNullablePointer(off);
    const c = sp.getNullablePointer(off + 8);
    const uses = c === null ? -1 : c.getInt32(8);
    const has = c !== null && uses !== 0 && p !== null;
    return `${has ? "HAS" : "NONE"} ptr ${p === null ? "null" : "set"} ctrl ${c === null ? "null" : "set"} uses ${uses}`;
}
events.command.on(cmd => {
    if (/^\/?dimwatch\s*$/.test(cmd)) {
        const last = new Map<string, string>();
        let t = 0;
        const tick = (): void => {
            for (const [name, a] of [["bot", player], ["simbot", simbot]] as [string, Player | null][]) {
                if (a === null) continue;
                const s = dimSample(a);
                if (last.get(name) !== s) { dimLog.push(`t${t} ${name} ${s}`); last.set(name, s); }
            }
            if (++t >= 400) events.levelTick.remove(tick);
        };
        events.levelTick.on(tick);
        say("dimwatch", null, "sampling");
        return;
    }
    if (/^\/?dimreport\s*$/.test(cmd)) {
        const both = (n: string): boolean => dimLog.some(e => e.includes(` ${n} HAS`)) && dimLog.some(e => e.includes(` ${n} NONE`));
        say("dimreport", null, `bot both sides ${both("bot")}, simbot both sides ${both("simbot")} | ${dimLog.slice(0, 16).join(" ; ")}`);
    }
});

// hasDimension's false side, before the add (queue row 1, docs/findings-layouts.md "Candidates held back"): behind
// ADD_PROBE=1, pass-through hooks on the ILevel add functions, read from ServerLevel's ILevel table (an exact table,
// read from a live object). Endstone's level_interface.h lays them out one slot ahead of the table on both builds
// (getDimension, getDifficulty and hasCommandsEnabled confirm the +1), so addEntity / addGlobalEntity /
// addAutonomousEntity are slots 43 / 44 / 45: (this, BlockSource&, OwnerPtr<EntityContext>*) -> Actor*. Slot 46 is
// addUser: (this, OwnerPtr<EntityContext>*) -> void. Bodies read on both builds (40 0x7385d0 0x7381b0 0x7384f0 0x738ed0,
// 51 0x7cf340 0x7cef20 0x7cf260 0x7cfc40): each moves the context out of the OwnerPtr ({EntityRegistry* +0, entt
// registry* +8, EntityId +0x10, engaged +0x18}) and hands it to an actor manager. At entry the entity is built and
// not yet added; its Actor* is the ActorOwnerComponent's +0 (an Actor's own context starts at +8, so owner-8 reads as
// an Actor to enttComponent). "addreport" prints what the hooks saw.
const addLog: string[] = [];
const addCounts = new Map<string, { n: number; noneBefore: number; hasBefore: number; hasAfter: number; noneAfter: number }>();
// `has` is bdsx's own Actor.hasDimension(); the raw reading beside it is what the text shows, and `agree` whether both say
// the same (a disagreement is a bug in one of them)
let addDisagree = 0;
function dimRef(actor: StaticPointer): { has: boolean; text: string } {
    const off = (pdbcache.layouts as any).Actor?.dimensionRef as number | undefined;
    if (off === undefined) return { has: false, text: "no layout" };
    const p = actor.getNullablePointer(off);
    const c = actor.getNullablePointer(off + 8);
    const uses = c === null ? -1 : c.getInt32(8);
    const raw = c !== null && uses !== 0 && p !== null;
    const has = actor.as(Actor).hasDimension();
    if (has !== raw) addDisagree++;
    return { has, text: `${has ? "HAS" : "NONE"}(ptr ${p === null ? "null" : "set"} ctrl ${c === null ? "null" : "set"} uses ${uses}${has !== raw ? " DISAGREES" : ""})` };
}
if (process.env.ADD_PROBE === "1") {
    const table = proc["??_7ServerLevel@@6BILevel@@@"] as unknown as StaticPointer;
    const ownerHash = componentHash("ActorOwnerComponent");
    const actorOf = (owner: StaticPointer): StaticPointer | null => {
        if (owner.getUint8(0x18) !== 1) return null;
        const comp = enttComponent(owner.add(-8), ownerHash, 8);
        return comp === null ? null : comp.getNullablePointer(0);
    };
    const record = (name: string, actor: StaticPointer | null, before: { has: boolean; text: string } | null, ret: StaticPointer | null, regOk: boolean): void => {
        const c = addCounts.get(name) ?? addCounts.set(name, { n: 0, noneBefore: 0, hasBefore: 0, hasAfter: 0, noneAfter: 0 }).get(name)!;
        c.n++;
        if (actor === null || before === null) {
            if (addLog.length < 40) addLog.push(`${name}: no actor at entry (regOk ${regOk})`);
            return;
        }
        if (before.has) c.hasBefore++; else c.noneBefore++;
        const after = dimRef(actor);
        if (after.has) c.hasAfter++; else c.noneAfter++;
        let ident = "?";
        try { ident = (actor.as(Actor)).getIdentifier(); } catch (err) { ident = `threw ${(err as Error).message}`; }
        const same = ret === null ? "void" : ret.equalsptr(actor) ? "same" : "OTHER";
        if (addLog.length < 40) addLog.push(`${name} ${ident}: before ${before.text} after ${after.text} ret ${same} regOk ${regOk}`);
    };
    for (const [name, slot] of [["addEntity", 43], ["addGlobalEntity", 44], ["addAutonomousEntity", 45]] as [string, number][]) {
        const fn = table.getPointer(slot * 8) as NativePointer;
        console.log(`[blkprobe] INFO addprobe ${name} slot ${slot} at +0x${fn.subptr(dllraw.current).toString(16)}`);
        const original = new ProcHacker<{ f: NativePointer }>({ f: fn }).hooking("f", VoidPointer, null, VoidPointer, VoidPointer, StaticPointer)((self, region, owner) => {
            let actor: StaticPointer | null = null, before: { has: boolean; text: string } | null = null, regOk = false;
            try {
                regOk = owner.getPointer(8).equalsptr(owner.getPointer(0).add(0x30));
                actor = actorOf(owner);
                if (actor !== null) before = dimRef(actor);
            } catch (err) {
                if (addLog.length < 40) addLog.push(`${name}: entry threw ${(err as Error).message}`);
            }
            const ret = original(self, region, owner);
            try { record(name, actor, before, ret as unknown as StaticPointer | null, regOk); } catch (err) { if (addLog.length < 40) addLog.push(`${name}: record threw ${(err as Error).message}`); }
            return ret;
        });
    }
    {
        const fn = table.getPointer(46 * 8) as NativePointer;
        console.log(`[blkprobe] INFO addprobe addUser slot 46 at +0x${fn.subptr(dllraw.current).toString(16)}`);
        const original = new ProcHacker<{ f: NativePointer }>({ f: fn }).hooking("f", void_t, null, VoidPointer, StaticPointer)((self, owner) => {
            let actor: StaticPointer | null = null, before: { has: boolean; text: string } | null = null, regOk = false;
            try {
                regOk = owner.getPointer(8).equalsptr(owner.getPointer(0).add(0x30));
                actor = actorOf(owner);
                if (actor !== null) before = dimRef(actor);
            } catch (err) {
                if (addLog.length < 40) addLog.push(`addUser: entry threw ${(err as Error).message}`);
            }
            original(self, owner);
            try { record("addUser", actor, before, null, regOk); } catch (err) { if (addLog.length < 40) addLog.push(`addUser: record threw ${(err as Error).message}`); }
        });
    }
}
events.command.on(cmd => {
    if (!/^\/?addreport\s*$/.test(cmd)) return;
    const counts = [...addCounts].map(([k, c]) => `${k} n${c.n} before HAS ${c.hasBefore}/NONE ${c.noneBefore} after HAS ${c.hasAfter}/NONE ${c.noneAfter}`).join("; ");
    // both sides through bdsx's hasDimension(): some actor false before the add, every actor true after it, and the
    // raw reading never disagreeing with bdsx
    const e = addCounts.get("addEntity");
    const ok = e !== undefined && e.noneBefore > 0 && e.noneAfter === 0 && e.hasAfter === e.hasBefore + e.noneBefore && addDisagree === 0;
    say("addreport", ok, `${counts || "no add seen"}; disagreements ${addDisagree} | ${addLog.slice(0, 24).join(" ;; ")}`);
});

// getBlockTarget's strong check (docs/findings-synched.md): only an ender crystal holds a BLOCK_TARGET (ActorDataIDs 47),
// and the console cannot set one. "btprobe": summon a crystal next to the bot, read getBlockTarget (none yet), hand the
// engine's own EnderCrystal::readAdditionalSaveData {BlockTargetX/Y/Z} (the save keys; it writes data item 47), read it
// again, and read the engine's addAdditionalSaveData back -- the target set by BDS's code, not by bdsx.
events.command.on(cmd => {
    if (!/^\/?btprobe\s*$/.test(cmd)) return;
    if (player === null) { say("btprobe", false, "no player"); return; }
    try {
        bedrockServer.executeCommand("kill @e[type=ender_crystal]", CommandResultType.Data);
        bedrockServer.executeCommand("summon ender_crystal 29 69 20", CommandResultType.Data);
        const crystals = player.fetchNearbyActorsSorted(Vec3.create(10, 10, 10), ActorType.EnderCrystal);
        if (crystals.length === 0) { say("btprobe", false, "no ender crystal within 10 blocks"); return; }
        const c = crystals[0].entity;
        const before = c.getBlockTarget();
        const b = `${before.x},${before.y},${before.z}`;
        console.log(`[blkprobe] INFO btprobe step: before ${b}; building the CompoundTag`);
        const tag = NBT.allocate({ BlockTargetX: NBT.int(5), BlockTargetY: NBT.int(71), BlockTargetZ: NBT.int(-9) }) as any;
        console.log("[blkprobe] INFO btprobe step: tag built; calling readAdditionalSaveData");
        c.readAdditionalSaveData(tag);
        tag.dispose();
        console.log("[blkprobe] INFO btprobe step: readAdditionalSaveData returned");
        const after = c.getBlockTarget();
        const a = `${after.x},${after.y},${after.z}`;
        console.log(`[blkprobe] INFO btprobe step: after ${after.x},${after.y},${after.z}; calling save`);
        const saved = c.save();
        const sv = `${saved.BlockTargetX},${saved.BlockTargetY},${saved.BlockTargetZ}`;
        say("btprobe", b === "0,0,0" && a === "5,71,-9" && sv === "5,71,-9", `crystal ${c.getIdentifier()}: before ${b}, after readAdditionalSaveData ${a}, engine save ${sv} (want 0,0,0 then 5,71,-9 twice)`);
        bedrockServer.executeCommand("kill @e[type=ender_crystal]", CommandResultType.Data);
    } catch (err) {
        say("btprobe", false, `threw ${(err as Error).message}`);
    }
});

// "nbtprobe": bdsx's NBT layer on 1.26 (docs/findings-nbt.md). Every answer comes from the engine's own code or from
// memory the engine wrote: getId/toString/equals are the tag vftables' slots, `has` is the engine's contains, `setAllocated`
// is the engine's put, every dispose runs the engine's destructors over what bdsx built (a bad tree, vector or allocator
// dies there), and player.save() is the engine's Actor::save into a tag bdsx then reads.
events.command.on(cmd => {
    if (!/^\/?nbtprobe\s*$/.test(cmd)) return;
    const step = (label: string, fn: () => [boolean, string]): void => {
        try {
            const [ok, detail] = fn();
            say(`nbtprobe ${label}`, ok, detail);
        } catch (err) {
            say(`nbtprobe ${label}`, false, `threw ${(err as Error).message}`);
        }
    };
    step("vftables", () => {
        const types = [EndTag, ByteTag, ShortTag, IntTag, Int64Tag, FloatTag, DoubleTag, ByteArrayTag, StringTag, ListTag, CompoundTag, IntArrayTag];
        const ids = types.map(t => {
            const tag = (t as any).allocate() as Tag;
            const id = tag.getId();
            tag.dispose();
            return id;
        });
        return [ids.every((id, i) => id === i), `engine getId through each table: ${ids.join(",")} (want 0..11)`];
    });
    const long = "a-string-value-well-past-the-fifteen-byte-buffer";
    let tag: CompoundTag | null = null;
    step("build", () => {
        tag = NBT.allocate({
            b: NBT.byte(1), s: NBT.short(2), i: NBT.int(3), l: NBT.int64(4), f: NBT.float(1.5), d: NBT.double(2.5),
            str: long, ba: NBT.byteArray([1, 2, 3]), ia: NBT.intArray([4, 5, 6]), list: [NBT.int(7), NBT.int(8), NBT.int(9)],
            nested: { x: NBT.int(10) },
        }) as CompoundTag;
        const text = tag.toString(); // 1.26's CompoundTag::toString is "<n> entries"
        return [tag.size() === 11 && text === "11 entries", `size ${tag.size()}; engine toString "${text}"`];
    });
    if (tag === null) return;
    const t: CompoundTag = tag;
    const ints = (l: ListTag | null): string => JSON.stringify(l?.data.toArray().map(e => (e as IntTag).data));
    step("get", () => {
        const i = t.get<IntTag>("i"), str = t.get<StringTag>("str"), list = t.get<ListTag>("list"), nested = t.get<CompoundTag>("nested");
        const got = `i ${i?.data}, str ${str?.data === long}, list ${ints(list)} size ${list?.size()} type ${list?.type}, nested.x ${nested?.get<IntTag>("x")?.data}, missing ${t.get("zz")}`;
        return [i?.data === 3 && str?.data === long && list?.size() === 3 && list.type === Tag.Type.Int && ints(list) === "[7,8,9]" && nested?.get<IntTag>("x")?.data === 10 && t.get("zz") === null, got];
    });
    step("has", () => [t.has("f") && t.has("nested") && !t.has("zz") && !t.has("F"), `contains (engine get != null): f ${t.has("f")}, nested ${t.has("nested")}, zz ${t.has("zz")}, F ${t.has("F")}`]);
    step("equals", () => {
        const clone = t.allocateClone();
        const same = t.equals(clone);
        clone.setAllocated("extra", IntTag.allocateWith(1));
        const differ = !t.equals(clone);
        clone.dispose();
        return [same && differ, `engine equals: clone ${same}, clone+extra ${!differ}`];
    });
    step("delete", () => {
        const first = t.delete("s"), again = t.delete("s"), mid = t.delete("ia");
        const rest = ["b", "ba", "d", "f", "i", "l", "list", "nested", "str"];
        const lost = rest.filter(k => !t.has(k));
        return [first && !again && mid && !t.has("s") && !t.has("ia") && lost.length === 0 && t.size() === 9, `remove s ${first}, again ${again}, ia ${mid}; engine get finds s ${t.has("s")}, ia ${t.has("ia")}; lost ${JSON.stringify(lost)}; size ${t.size()}`];
    });
    step("erase", () => {
        // 64 keys erased in a scrambled order: after every erase the engine's own get must still find every key left,
        // which it only does if bdsx's rebalancing kept the tree ordered
        const big = CompoundTag.allocate();
        const keys = Array.from({ length: 64 }, (_, n) => `k${String(n).padStart(2, "0")}`);
        for (const k of keys) big.setAllocated(k, StringTag.allocateWith(`${long}-${k}`));
        const order = keys.map((k, n) => [k, (n * 37) % 64] as [string, number]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
        const left = new Set(keys);
        let bad = "";
        for (const k of order) {
            if (!big.delete(k)) { bad = `delete ${k} false`; break; }
            left.delete(k);
            const miss = [...left].find(x => big.get<StringTag>(x)?.data !== `${long}-${x}`);
            if (miss !== undefined || big.size() !== left.size || big.has(k)) { bad = `after ${k}: miss ${miss}, size ${big.size()}/${left.size}`; break; }
        }
        big.dispose();
        return [bad === "", bad || "64 erases, every survivor found by the engine each time; engine destructor ran"];
    });
    step("variant", () => {
        const v = t.data.get("i")!;
        v.set(StringTag.allocateWith(long));
        const after = t.get("i");
        return [after instanceof StringTag && after.data === long && t.size() === 9, `i re-emplaced as ${after?.constructor.name} ${after instanceof StringTag ? after.data.length + " chars" : ""}`];
    });
    step("list", () => {
        const list = ListTag.allocate();
        for (let n = 0; n < 40; n++) list.pushAllocated(StringTag.allocateWith(`${long}-${n}`));
        const ok = list.size() === 40 && list.type === Tag.Type.String && list.get<StringTag>(39).data === `${long}-39`;
        t.set("biglist", list); // a deep copy goes into the compound through the engine's put
        list.dispose(); // the engine's ListTag destructor frees the 40 strings and the vector bdsx grew
        const inside = t.get<ListTag>("biglist");
        return [ok && inside?.size() === 40 && inside.type === Tag.Type.String && inside.get<StringTag>(0).data === `${long}-0`, `40 pushes (${ok}), copy in compound size ${inside?.size()} type ${inside?.type}`];
    });
    step("clear", () => {
        t.clear();
        const empty = t.size() === 0 && !t.has("b");
        t.setAllocated("again", IntTag.allocateWith(5));
        return [empty && t.get<IntTag>("again")?.data === 5 && t.size() === 1, `after clear empty ${empty}; put again -> ${t.get<IntTag>("again")?.data}, size ${t.size()}`];
    });
    step("dispose", () => {
        t.dispose();
        return [true, "engine CompoundTag destructor over what bdsx built returned"];
    });
    step("value", () => {
        const back = NBT.allocate({ n: NBT.int(1), s: "x", list: [NBT.int(2)], c: { y: NBT.byte(3) } }) as CompoundTag;
        const v = back.value();
        back.dispose();
        const got = JSON.stringify(v);
        return [+v.n === 1 && v.s === "x" && +v.list[0] === 2 && +v.c.y === 3, got];
    });
    step("actor save", () => {
        if (player === null) return [false, "no player"];
        const saved = player.save();
        const pos = saved.Pos;
        return [saved.identifier === "minecraft:player" && Array.isArray(pos) && pos.length === 3, `engine Actor::save: identifier ${saved.identifier}, Pos ${JSON.stringify(pos.map((x: any) => +x))}, ${Object.keys(saved).length} keys`];
    });
});

// "nbtiprobe": ItemStackBase's NBT round trip on 1.26 (docs/findings-nbt.md "ItemStackBase"). The console puts a stack in
// hotbar slot 0 (read back through the confirmed PlayerInventory container path, tools/item-probe.ts); the engine's own
// save (bdsx:ItemStackBase::save with SaveToDisk) writes it; bdsx's load (_loadItem + Item::fixupCommon + the aux tail)
// reads it into an air stack the engine's ItemStack::fromTag made; the engine saves that again and the two saves must
// be the same. A Damage put into the saved tag must come back through getDamageValue; fromTag must agree as well.
events.command.on(cmd => {
    if (!/^\/?nbtiprobe\s*$/.test(cmd)) return;
    if (player === null) { say("nbtiprobe", false, "no player"); return; }
    const cases: [string, number, string | null][] = [
        ["minecraft:iron_sword", 1, "probe-sword-name-past-fifteen"],
        ["minecraft:stone", 5, null],
        ["minecraft:apple", 64, null],
    ];
    for (const [name, count, custom] of cases) {
        const label = `nbtiprobe ${name.slice(10)}`;
        let dst: ItemStack | null = null, fromTag: ItemStack | null = null;
        try {
            bedrockServer.executeCommand(`replaceitem entity @a slot.hotbar 0 ${name.slice(10)} ${count}`, CommandResultType.Data);
            const step = (m: string): void => console.log(`[blkprobe] INFO ${label} step: ${m}`);
            step("replaceitem done; reading hotbar 0");
            const src = player.getInventory().container.getItem(0);
            if (src.isNull()) { say(label, false, "replaceitem left hotbar slot 0 empty"); continue; }
            let named = true;
            if (custom !== null) {
                // bdsx's setCustomName (derived) on a stack with no user data, then again over the display it made;
                // the engine's own save must carry the second name
                step(`source x${src.getAmount()}; setCustomName twice`);
                src.setCustomName("first-name");
                src.setCustomName(custom);
                named = src.save().tag?.display?.Name === custom;
            }
            step(`source x${src.getAmount()}; engine save`);
            const saved = src.save();
            if (custom !== null) {
                // a durability the engine did not write: only a real load brings it back
                saved.tag.Damage = NBT.int(7);
            }
            step(`saved ${JSON.stringify(saved).slice(0, 160)}; fromTag(air)`);
            dst = ItemStack.fromTag({ Name: "minecraft:air", Count: NBT.byte(0), Damage: NBT.short(0), WasPickedUp: NBT.byte(0) });
            const air = JSON.stringify(dst.save());
            step(`air stack ${air}; bdsx load`);
            dst.load(saved);
            step("loaded; engine re-save");
            const again = dst.save();
            const a = JSON.stringify(saved), b = JSON.stringify(again);
            const nameOk = saved.Name === name && again.Name === name && dst.getAmount() === count;
            const dmgOk = custom === null || (dst.getDamageValue() === 7 && again.tag?.display?.Name === custom);
            step("fromTag(saved)");
            fromTag = ItemStack.fromTag(saved);
            const ftOk = fromTag.getAmount() === count && JSON.stringify(fromTag.save()) === a;
            say(label, named && a === b && nameOk && dmgOk && ftOk, `setCustomName ${named}; engine save ${a.slice(0, 240)}; ${air} -> bdsx load: ${again.Name} x${dst.getAmount()} damage ${dst.getDamageValue()}, re-save ${a === b ? "identical" : b.slice(0, 240)}; fromTag agrees ${ftOk}`);
        } catch (err) {
            say(label, false, `threw ${(err as Error).message}`);
        } finally {
            dst?.destruct(); fromTag?.destruct();
        }
    }
    bedrockServer.executeCommand("clear @a", CommandResultType.Data);
});

// "nbteprobe": MobEffectInstance's NBT round trip (docs/findings-nbt.md "MobEffectInstance"). `effect` gives the player
// Speed II with particles hidden; the engine saves the live instance, bdsx has the engine's static load construct a
// copy into an instance bdsx allocated (the class size is per build: 0x88 on 40, 0x90 on 51), and the engine saves
// the copy again. The two saves must be the same and carry the commanded id/amplifier/particles.
events.command.on(cmd => {
    if (!/^\/?nbteprobe\s*$/.test(cmd)) return;
    if (player === null) { say("nbteprobe", false, "no player"); return; }
    try {
        bedrockServer.executeCommand("effect @a speed 30 2 true", CommandResultType.Data);
        const key = new AllocatedPointer(0x20); // a MobEffect is read only for its id at +8 (actor-layout-probe.ts)
        key.fill(0, 0x20);
        key.setInt32(MobEffectIds.Speed, 8);
        const live = (player as any)._getEffect(key.as(MobEffect)) as MobEffectInstance | null;
        if (live === null) { say("nbteprobe", false, "no Speed instance after `effect`"); return; }
        const saved = live.save();
        const copy = MobEffectInstance.load(saved as any) as unknown as MobEffectInstance;
        const again = copy.save();
        // the engine's own round trip with no JS in between: its save's CompoundTag straight into its load. What the
        // engine itself does not keep (1.26's load reads the factor_* keys with getIntTag; its save writes them as
        // floats) is not bdsx's to keep either, so the two round trips are compared with each other
        const engineTag = live.allocateAndSave();
        const factorType = (engineTag.get<CompoundTag>("FactorCalculationData")?.get("factor_target") as Tag | null)?.constructor.name;
        const engineCopy = MobEffectInstance.load(engineTag as any) as unknown as MobEffectInstance;
        engineTag.dispose();
        const viaEngine = engineCopy.save();
        const a = JSON.stringify(viaEngine), b = JSON.stringify(again);
        const diff = [...new Set([...Object.keys(saved), ...Object.keys(again)])].filter(k => JSON.stringify(saved[k]) !== JSON.stringify(again[k]))
            .map(k => `${k}: ${JSON.stringify(saved[k])} -> ${JSON.stringify(again[k])}`);
        const ok = a === b && +saved.Id === MobEffectIds.Speed && +saved.Amplifier === 2 && +saved.ShowParticles === 0 &&
            copy.id === MobEffectIds.Speed && copy.amplifier === 2 && !copy.showParticles;
        say("nbteprobe", ok, `size 0x${MobEffectInstance[NativeType.size].toString(16)}; Id ${JSON.stringify(saved.Id)} Amplifier ${JSON.stringify(saved.Amplifier)}; copy id ${copy.id} amplifier ${copy.amplifier} showParticles ${copy.showParticles}; bdsx round trip ${a === b ? "identical to the engine's own" : "differs from the engine's own: " + b.slice(0, 300)}; vs the live save: ${diff.length === 0 ? "identical" : diff.join("; ")}; factor_target is a ${factorType}`);
    } catch (err) {
        say("nbteprobe", false, `threw ${(err as Error).message}`);
    } finally {
        bedrockServer.executeCommand("effect @a clear", CommandResultType.Data);
    }
});

// "nbtbprobe": BlockActor's NBT round trip (docs/findings-nbt.md "BlockActor"). A chest is placed; its block actor is
// saved by the engine (slot 2 of ??_7BlockActor@@6B@), given a CustomName the engine did not write, handed back to the
// engine's load (slot 1, with bdsx's DefaultDataLoadHelper), and saved again: the name must come back with id/x/y/z.
events.command.on(cmd => {
    if (!/^\/?nbtbprobe\s*$/.test(cmd)) return;
    if (player === null) { say("nbtbprobe", false, "no player"); return; }
    const [x, y, z] = [33, 68, 14];
    try {
        bedrockServer.executeCommand(`setblock ${x} ${y} ${z} chest`, CommandResultType.Data);
        const be = player.getDimensionBlockSource().getBlockEntity(BlockPos.create(x, y, z));
        if (be === null) { say("nbtbprobe", false, "no block actor at the chest"); return; }
        const saved = be.save();
        const name = "probe-chest-name-past-fifteen";
        const where = `${+saved.x},${+saved.y},${+saved.z}`;
        saved.CustomName = name;
        be.load(saved);
        const again = be.save();
        const ok = saved.id === "Chest" && where === `${x},${y},${z}` && again.CustomName === name && again.id === "Chest" && `${+again.x},${+again.y},${+again.z}` === where;
        say("nbtbprobe", ok, `engine save id ${saved.id} at ${where}, ${Object.keys(saved).length} keys; after bdsx load + engine re-save: CustomName ${again.CustomName}, id ${again.id}, ${JSON.stringify(again).slice(0, 200)}`);
    } catch (err) {
        say("nbtbprobe", false, `threw ${(err as Error).message}`);
    } finally {
        bedrockServer.executeCommand(`setblock ${x} ${y} ${z} air`, CommandResultType.Data);
    }
});

// "nbtcprobe": CommandBlockComponent::addAdditionalSaveData (docs/findings-nbt.md "CommandBlockComponent"). A command block
// minecart is summoned; bdsx finds its component (its own EnTT lookup: 1.26 has no out-of-line tryGetComponent) and has the
// engine's addAdditionalSaveData write it into a tag bdsx allocated. That must agree with what the engine's own Actor::save
// writes for the same keys. The saved tag, given a Command, CurrentTickCount and Ticking the engine did not write, goes back
// through the engine's MinecartCommandBlock::readAdditionalSaveData; bdsx's save and the engine's Actor::save must then both
// carry the new values and agree with each other again.
events.command.on(cmd => {
    if (!/^\/?nbtcprobe\s*$/.test(cmd)) return;
    if (player === null) { say("nbtcprobe", false, "no player"); return; }
    try {
        bedrockServer.executeCommand("kill @e[type=command_block_minecart]", CommandResultType.Data);
        bedrockServer.executeCommand("summon command_block_minecart 29 69 20", CommandResultType.Data);
        const carts = player.fetchNearbyActorsSorted(Vec3.create(10, 10, 10), ActorType.MinecartCommandBlock);
        if (carts.length === 0) { say("nbtcprobe", false, "no command block minecart within 10 blocks"); return; }
        const cart = carts[0].entity;
        const comp = cart.tryGetComponent("minecraft:command_block");
        if (comp === null) { say("nbtcprobe", false, `no CommandBlockComponent on ${cart.getIdentifier()}`); return; }
        console.log(`[blkprobe] INFO nbtcprobe step: ${cart.getIdentifier()} component at ${comp}; bdsx save`);
        const saveComp = (): Record<string, any> => {
            const t = CompoundTag.allocate();
            comp.addAdditionalSaveData(t);
            const v = t.value();
            t.dispose();
            return v;
        };
        const disagree = (mine: Record<string, any>, engine: Record<string, any>): string[] =>
            Object.keys(mine).filter(k => JSON.stringify(mine[k]) !== JSON.stringify(engine[k])).map(k => `${k}: ${JSON.stringify(mine[k])} vs ${JSON.stringify(engine[k])}`);
        const first = saveComp();
        const engine1 = cart.save();
        const d1 = disagree(first, engine1);
        console.log(`[blkprobe] INFO nbtcprobe step: bdsx save ${JSON.stringify(first).slice(0, 300)}; engine load`);
        const text = "say probe-command-block-past-fifteen";
        const edited: Record<string, any> = { ...first, Command: text, CurrentTickCount: NBT.int(7), Ticking: NBT.byte(1) };
        cart.readAdditionalSaveData(edited as any);
        const second = saveComp();
        const engine2 = cart.save();
        const d2 = disagree(second, engine2);
        const d3 = disagree(edited, second);
        const ok = Object.keys(first).length >= 3 && "Ticking" in first && "CurrentTickCount" in first && "Command" in first &&
            d1.length === 0 && d2.length === 0 && d3.length === 0 && second.Command === text && +second.CurrentTickCount === 7 && +second.Ticking === 1;
        say("nbtcprobe", ok, `bdsx save: ${Object.keys(first).length} keys, Ticking ${+first.Ticking} CurrentTickCount ${+first.CurrentTickCount} Command ${JSON.stringify(first.Command)}; vs engine Actor::save ${d1.length === 0 ? "identical" : d1.join("; ")}; after engine load: Command ${JSON.stringify(second.Command)} CurrentTickCount ${+second.CurrentTickCount} Ticking ${+second.Ticking}, vs the tag loaded ${d3.length === 0 ? "identical" : d3.join("; ")}, vs engine Actor::save ${d2.length === 0 ? "identical" : d2.join("; ")}`);
    } catch (err) {
        say("nbtcprobe", false, `threw ${(err as Error).message}`);
    } finally {
        bedrockServer.executeCommand("kill @e[type=command_block_minecart]", CommandResultType.Data);
    }
});

// "nbtnprobe": ItemComponent::buildNetworkTag / initializeFromNetwork (docs/findings-nbt.md "Item components"). bdsx calls
// both by vftable slot (4 and 5), found through ??_7ItemComponent@@6B@ / ??_7InteractButtonItemComponent@@6B@. Three cases:
// the base class (an ItemComponent with the engine's base vftable: buildNetworkTag returns null); an InteractButton
// component in bdsx memory with the engine's InteractButton vftable (no vanilla item has one): the engine's
// initializeFromNetwork reads a tag, its buildNetworkTag writes it back, into a second one and back again; and the apple's
// live food component, whose buildNetworkTag must match the engine's own ComponentItem::buildNetworkTag for the item and
// survive its own initializeFromNetwork. Networked components read the engine's cereal::ReflectionCtx, which the component
// item holds (layouts.ComponentItem.reflectionCtx); ComponentItem.getComponent hands it on.
events.command.on(cmd => {
    if (!/^\/?nbtnprobe\s*$/.test(cmd)) return;
    if (player === null) { say("nbtnprobe", false, "no player"); return; }
    const step = (label: string, fn: () => [boolean, string]): void => {
        try {
            const [ok, detail] = fn();
            say(`nbtnprobe ${label}`, ok, detail);
        } catch (err) {
            say(`nbtnprobe ${label}`, false, `threw ${(err as Error).message}`);
        }
    };
    try {
        bedrockServer.executeCommand("replaceitem entity @a slot.hotbar 0 apple 1", CommandResultType.Data);
        const stack = player.getInventory().container.getItem(0);
        const ci = stack.isNull() ? null : stack.getComponentItem();
        if (ci === null) { say("nbtnprobe", false, "no component item for the apple in hotbar 0"); return; }
        const ctxPtr = componentItemReflectionCtx(ci as unknown as StaticPointer);
        if (ctxPtr === null) { say("nbtnprobe", false, "the apple's ComponentItem holds no ReflectionCtx"); return; }
        const ctx = ctxPtr.as(cereal.ReflectionCtx);
        const slots = `slots: buildNetworkTag ${JSON.stringify(proc.vftable["??_7ItemComponent@@6B@\\?buildNetworkTag@ItemComponent@@UEBA?AV?$unique_ptr@VCompoundTag@@U?$default_delete@VCompoundTag@@@std@@@std@@AEBUReflectionCtx@cereal@@@Z"])}, initializeFromNetwork ${JSON.stringify(proc.vftable["??_7InteractButtonItemComponent@@6B@\\?initializeFromNetwork@InteractButtonItemComponent@@UEAA_NAEBVCompoundTag@@AEBUReflectionCtx@cereal@@@Z"])}`;
        console.log(`[blkprobe] INFO nbtnprobe ${slots}; ctx ${ctxPtr}`);
        step("base", () => {
            const p = new AllocatedPointer(0x10);
            p.fill(0, 0x10);
            p.setPointer(proc["??_7ItemComponent@@6B@"], 0);
            const t = p.as(ItemComponent).buildNetworkTag(ctx) as CompoundTag | null;
            const isNull = t === null || (t as unknown as VoidPointer).isNull();
            return [isNull, `ItemComponent's own buildNetworkTag through the engine's base vftable: ${isNull ? "null" : "a tag"} (want null)`];
        });
        step("interact", () => {
            const table = proc["??_7InteractButtonItemComponent@@6B@"];
            const make = (): AllocatedPointer => {
                const p = new AllocatedPointer(0x38); // sizeof: the deleting destructor frees 0x38 on both builds
                p.fill(0, 0x38);
                p.setPointer(table, 0);
                p.setInt32(15, 0x30); // interact_text (+0x18): an empty std::string, capacity 15
                return p;
            };
            const destroy = (p: AllocatedPointer): void => {
                // the engine's destructor (slot 0, no delete) frees the heap string its assign made
                makefunc.js(p.getPointer(0).getPointer(0), void_t, null, VoidPointer, int32_t)(p, 0);
            };
            const text = "probe-interact-text-past-fifteen";
            const input = NBT.allocate({ requires_interact: NBT.byte(1), interact_text: text }) as CompoundTag;
            const a = make(), b = make();
            try {
                const r1 = a.as(ItemComponent).initializeFromNetwork(input, ctx);
                const fields = `requires +0x10 ${a.getUint8(0x10)}, text +0x18 ${JSON.stringify(a.getCxxString(0x18))}`;
                const out = a.as(ItemComponent).buildNetworkTag(ctx);
                const v1 = JSON.stringify(out.value());
                const eq1 = out.equals(input);
                const r2 = b.as(ItemComponent).initializeFromNetwork(out, ctx);
                out.dispose();
                const out2 = b.as(ItemComponent).buildNetworkTag(ctx);
                const v2 = JSON.stringify(out2.value());
                const eq2 = out2.equals(input);
                out2.dispose();
                const ok = !!r1 && !!r2 && a.getUint8(0x10) === 1 && a.getCxxString(0x18) === text && eq1 && eq2;
                return [ok, `engine initializeFromNetwork ${!!r1}: ${fields}; engine buildNetworkTag ${v1}, equals the tag read ${eq1}; into a second one ${!!r2} and out again ${v2}, equals ${eq2}`];
            } finally {
                input.dispose();
                destroy(a);
                destroy(b);
            }
        });
        step("food", () => {
            const whole = ci.buildNetworkTag();
            const wv = whole.value();
            whole.dispose();
            let found: any = undefined, where = "";
            const walk = (o: any, path: string): void => {
                if (found !== undefined || o === null || typeof o !== "object") return;
                for (const k of Object.keys(o)) {
                    if (k === "minecraft:food") { found = o[k]; where = `${path}/${k}`; return; }
                    walk(o[k], `${path}/${k}`);
                }
            };
            walk(wv, "");
            const food = ci.getComponent("minecraft:food");
            if (food === null) return [false, "the apple has no minecraft:food component"];
            const mine = food.buildNetworkTag();
            if (mine === null || (mine as unknown as VoidPointer).isNull()) return [false, `the food component's buildNetworkTag returned null; the engine's item tag has it at ${where || "(nowhere)"}`];
            const a = JSON.stringify(mine.value());
            const r = food.initializeFromNetwork(mine);
            mine.dispose();
            const again = food.buildNetworkTag();
            const b = JSON.stringify(again.value());
            again.dispose();
            const e = JSON.stringify(found);
            return [found !== undefined && a === e && !!r && a === b, `engine ComponentItem::buildNetworkTag has it at ${where || "(nowhere)"}: ${(e ?? "").slice(0, 200)}; bdsx (slot 4, the item's ctx) ${a === e ? "identical" : a.slice(0, 200)}; initializeFromNetwork ${!!r}, then again ${a === b ? "identical" : b.slice(0, 200)}`];
        });
    } catch (err) {
        say("nbtnprobe", false, `threw ${(err as Error).message}`);
    } finally {
        bedrockServer.executeCommand("clear @a", CommandResultType.Data);
    }
});

// BlockUtils on 1.26 (docs/findings-blocks.md "BlockUtils on 1.26"). The engine's own out-of-line copies (isFullFlowingLiquid's
// neighbours) are called on Block objects made by Block.create(name, data): a liquid's data is its liquid_depth, so sixteen
// depths of four liquids give both answers for every predicate. `blkutil` is the liquid, height, fence, beehive and flower
// checks; `blkutil2` the nether-vegetation, legacy-data and destroy-time ones.
const blkuTags = (type: StaticPointer): string => {
    const begin = type.getPointer(0x1a0), end = type.getPointer(0x1a8);
    const out: string[] = [];
    for (let i = 0; i < end.subptr(begin); i += 0x30) out.push(begin.add(i).getCxxString(8));
    return out.join(",");
};
const blkuMake = (name: string, data = 0): Block | null => Block.create(name, data);
events.command.on(cmd => {
    if (!/^\/?blkutil\s*$/.test(cmd)) return;
    const step = (label: string, fn: () => [boolean, string]): void => {
        try {
            const [ok, detail] = fn();
            say(`blkutil ${label}`, ok, detail);
        } catch (err) {
            say(`blkutil ${label}`, false, `threw ${(err as Error).message}`);
        }
    };
    const need = (name: string, data = 0): Block => {
        const b = blkuMake(name, data);
        if (b === null) throw Error(`Block.create(${name}, ${data}) is null`);
        return b;
    };
    const depths = [0, 1, 3, 7, 8, 12, 15];
    step("liquid depth", () => {
        const rows: string[] = [];
        let bad = 0;
        for (const n of ["minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava"]) {
            for (const d of depths) {
                const b = need(n, d);
                const src = BlockUtils.isLiquidSource(b), down = BlockUtils.isDownwardFlowingLiquid(b), full = BlockUtils.isFullFlowingLiquid(b);
                const ok = src === (d === 0) && down === d >= 8 && full === (d === 0 || d >= 8);
                if (!ok) bad++;
                rows.push(`${n.slice(10)}:${d}=${+src}${+down}${+full}${ok ? "" : "!"}`);
            }
        }
        return [bad === 0, `source/down/full per depth (want 1/0/1 at 0, 0/0/0 at 1-7, 0/1/1 at 8+): ${rows.join(" ")}`];
    });
    step("not a liquid", () => {
        const rows: string[] = [];
        let bad = 0;
        for (const n of ["minecraft:stone", "minecraft:dirt", "minecraft:oak_planks", "minecraft:glass"]) {
            const b = need(n);
            const r = [BlockUtils.isLiquidSource(b), BlockUtils.isDownwardFlowingLiquid(b), BlockUtils.isWaterSource(b)];
            if (r.some(x => x)) bad++;
            rows.push(`${n.slice(10)}=${r.map(x => +x).join("")}`);
        }
        return [bad === 0, `source/down/waterSource, all want 0: ${rows.join(" ")}`];
    });
    step("water source", () => {
        const want: [string, number, boolean][] = [
            ["minecraft:water", 0, true], ["minecraft:flowing_water", 0, true], ["minecraft:lava", 0, false], ["minecraft:flowing_lava", 0, false],
            ["minecraft:water", 3, false], ["minecraft:water", 8, false], ["minecraft:flowing_water", 5, false], ["minecraft:stone", 0, false],
        ];
        const rows: string[] = [];
        let bad = 0;
        for (const [n, d, w] of want) {
            const got = BlockUtils.isWaterSource(need(n, d));
            if (got !== w) bad++;
            rows.push(`${n.slice(10)}:${d}=${+got}${got === w ? "" : "!"}`);
        }
        return [bad === 0, rows.join(" ")];
    });
    step("liquid height", () => {
        const pos = BlockPos.create(0, 64, 0);
        const f32 = Math.fround;
        const rows: string[] = [];
        let bad = 0;
        const cases: [string, number][] = [["minecraft:water", 0], ["minecraft:water", 1], ["minecraft:water", 3], ["minecraft:water", 7], ["minecraft:water", 8], ["minecraft:lava", 4], ["minecraft:stone", 0]];
        for (const [n, d] of cases) {
            // 2024: pos.y + 1 - (LiquidBlock::getHeightFromDepth(depth) - 1/9), getHeightFromDepth = ((depth < 8 ? depth : 0) + 1) / 9
            const want = f32(65 - f32(f32(((d < 8 ? d : 0) + 1) * f32(1 / 9)) - f32(1 / 9)));
            const got = BlockUtils.getLiquidBlockHeight(need(n, d), pos);
            const ok = Math.abs(got - want) < 1e-4;
            if (!ok) bad++;
            rows.push(`${n.slice(10)}:${d}=${got.toFixed(4)}(${want.toFixed(4)})${ok ? "" : "!"}`);
        }
        return [bad === 0, `y 64: ${rows.join(" ")}`];
    });
    step("thin fence or wall", () => {
        const want: [string, boolean][] = [["minecraft:iron_bars", true], ["minecraft:glass_pane", true], ["minecraft:cobblestone_wall", true], ["minecraft:stone", false], ["minecraft:oak_fence", false], ["minecraft:glass", false], ["minecraft:oak_planks", false]];
        const rows: string[] = [];
        let bad = 0;
        for (const [n, w] of want) {
            const got = BlockUtils.isThinFenceOrWallBlock(need(n));
            if (got !== w) bad++;
            rows.push(`${n.slice(10)}=${+got}${got === w ? "" : "!"}`);
        }
        return [bad === 0, rows.join(" ")];
    });
    step("beehive", () => {
        const want: [string, boolean][] = [["minecraft:beehive", true], ["minecraft:bee_nest", true], ["minecraft:stone", false], ["minecraft:oak_log", false], ["minecraft:honey_block", false]];
        const rows: string[] = [];
        let bad = 0;
        for (const [n, w] of want) {
            const got = BlockUtils.isBeehiveBlock(need(n).blockLegacy);
            if (got !== w) bad++;
            rows.push(`${n.slice(10)}=${+got}${got === w ? "" : "!"}`);
        }
        return [bad === 0, rows.join(" ")];
    });
    step("flowers for a tree with a beehive", () => {
        const yes = ["minecraft:poppy", "minecraft:dandelion", "minecraft:cornflower", "minecraft:sunflower", "minecraft:lilac", "minecraft:rose_bush", "minecraft:peony", "minecraft:wither_rose", "minecraft:cherry_leaves", "minecraft:pink_petals"];
        const no = ["minecraft:stone", "minecraft:dirt", "minecraft:oak_planks", "minecraft:oak_leaves", "minecraft:wheat", "minecraft:water"];
        const rows: string[] = [];
        let bad = 0, missing = 0, trues = 0;
        for (const n of yes) {
            const b = blkuMake(n);
            if (b === null) { missing++; rows.push(`${n.slice(10)}=none`); continue; }
            const got = BlockUtils.canGrowTreeWithBeehive(b);
            if (got) trues++; else bad++;
            rows.push(`${n.slice(10)}=${+got}`);
        }
        for (const n of no) {
            const b = blkuMake(n);
            if (b === null) { missing++; rows.push(`${n.slice(10)}=none`); continue; }
            const got = BlockUtils.canGrowTreeWithBeehive(b);
            if (got) bad++;
            rows.push(`${n.slice(10)}=${+got}`);
        }
        return [bad === 0 && trues >= 6, `${missing} names missing; ${rows.join(" ")}`];
    });
});

// what blkutil2 reads off the engine before anything is derived from it: the block tag vectors and the list NetherFungusBlock's
// mayPlaceOn tests (40 0x69dcd30 / 51 0x65ebe70, slot 68): three HashedString globals and one std::vector of references
const BLKU_NETHER: { [build: string]: { reg: number; begin: number; end: number; singles: number[] } } = {
    "40": { reg: 0xc95fe38, begin: 0xc970788, end: 0xc970790, singles: [0xc975b50, 0xc977e60, 0xc976e40] },
    "51": { reg: 0xccb0608, begin: 0xccd2328, end: 0xccd2330, singles: [0xcce3240, 0xcce0b58, 0xccdffe8] },
};
events.command.on(cmd => {
    if (!/^\/?blkutil2\s*$/.test(cmd)) return;
    const step = (label: string, fn: () => [boolean | null, string]): void => {
        try {
            const [ok, detail] = fn();
            say(`blkutil2 ${label}`, ok, detail);
        } catch (err) {
            say(`blkutil2 ${label}`, false, `threw ${(err as Error).message}`);
        }
    };
    const need = (name: string, data = 0): Block => {
        const b = blkuMake(name, data);
        if (b === null) throw Error(`Block.create(${name}, ${data}) is null`);
        return b;
    };
    const vecStrings = (p: StaticPointer, off: number): string | null => {
        const begin = p.getPointer(off), end = p.getPointer(off + 8);
        if (begin.isNull() || end.isNull()) return null;
        const n = end.subptr(begin);
        if (n <= 0 || n % 0x30 !== 0 || n > 0x30 * 32) return null;
        const out: string[] = [];
        for (let i = 0; i < n; i += 0x30) out.push(begin.add(i).getCxxString(8));
        return out.join(",");
    };
    step("tags", () => {
        const rows: string[] = [];
        for (const n of ["minecraft:wheat", "minecraft:carrots", "minecraft:beetroot", "minecraft:poppy", "minecraft:stone", "minecraft:oak_log"]) {
            const b = need(n);
            const bp = b as any as StaticPointer;
            const hits: string[] = [];
            for (let off = 0x78; off <= 0x110; off += 8) {
                const s = vecStrings(bp, off);
                if (s !== null) hits.push(`Block+0x${off.toString(16)}:[${s}]`);
            }
            const t = vecStrings(b.blockLegacy as any as StaticPointer, 0x1a0);
            rows.push(`${n.slice(10)} ${hits.join(" ") || "Block:none"} type+0x1a0:${t === null ? "none" : `[${t}]`}`);
        }
        return [null, rows.join(" | ")];
    });
    step("nether vegetation against the engine", () => {
        // the engine's own test: NetherFungusBlock's mayPlaceOn (slot 68) on the block at pos; bdsx's allowsNetherVegetation must agree
        if (player === null) return [false, "no player"];
        const region = player.getRegion();
        const fungus = need("minecraft:crimson_fungus").blockLegacy;
        const mayPlaceOn = makefunc.js([68 * 8], bool_t, { this: BlockLegacy }, BlockSource, BlockPos);
        const names = ["dirt", "grass_block", "podzol", "coarse_dirt", "mycelium", "dirt_with_roots", "moss_block", "pale_moss_block", "mud", "muddy_mangrove_roots", "farmland", "soul_soil", "warped_nylium", "crimson_nylium",
            "stone", "sand", "gravel", "netherrack", "oak_planks", "clay", "sandstone", "glass"];
        const rows: string[] = [];
        let bad = 0, yes = 0, no = 0;
        try {
            names.forEach((n, i) => {
                const pos = BlockPos.create(45 + i, 80, 34);
                bedrockServer.executeCommand(`setblock ${pos.x} ${pos.y} ${pos.z} ${n}`, CommandResultType.Data);
                const blk = region.getBlock(pos);
                const engine = mayPlaceOn.call(fungus, region, pos);
                const mine = BlockUtils.allowsNetherVegetation(blk.blockLegacy);
                if (engine !== mine) bad++;
                if (engine) yes++; else no++;
                rows.push(`${n}=${+engine}${+mine}${engine === mine ? "" : "!"}(${blk.getName().slice(10)})`);
            });
        } finally {
            bedrockServer.executeCommand("fill 45 80 34 70 80 34 air", CommandResultType.Data);
        }
        return [bad === 0 && yes >= 10 && no >= 5, `engine/bdsx per block: ${rows.join(" ")}; ${yes} yes, ${no} no`];
    });
    step("legacy data", () => {
        const rows: string[] = [];
        let bad = 0;
        const water = need("minecraft:water").blockLegacy;
        const w3 = water.getStateFromLegacyData(3);
        const ok1 = !BlockUtils.isLiquidSource(w3) && w3.getRuntimeId() === need("minecraft:water", 3).getRuntimeId() && w3.getRuntimeId() !== need("minecraft:water", 0).getRuntimeId();
        rows.push(`water data 3 runtime ${w3.getRuntimeId()} (Block.create ${need("minecraft:water", 3).getRuntimeId()}, default ${water.getDefaultState().getRuntimeId()}) source ${BlockUtils.isLiquidSource(w3)}`);
        if (!ok1) bad++;
        const stone = need("minecraft:stone").blockLegacy;
        const miss = stone.tryGetStateFromLegacyData(200);
        const s200 = stone.getStateFromLegacyData(200);
        const ok2 = s200 !== null && s200.getRuntimeId() === stone.getDefaultState().getRuntimeId();
        rows.push(`stone data 200: tryGet ${miss === null ? "null" : "block " + miss.getRuntimeId()}, getState runtime ${s200?.getRuntimeId()}, default ${stone.getDefaultState().getRuntimeId()}`);
        if (!ok2) bad++;
        // tryGetStateFromLegacyData already falls back to the default state on a miss (1.26), so the null branch is unreachable
        return [bad === 0, rows.join("; ")];
    });
    step("crop", () => {
        const want: [string, boolean][] = [["wheat", true], ["carrots", true], ["beetroot", true], ["potatoes", true], ["torchflower_crop", true], ["pitcher_crop", true], ["sweet_berry_bush", true],
            ["melon_stem", false], ["pumpkin_stem", false], ["stone", false], ["poppy", false], ["oak_sapling", false], ["oak_planks", false], ["farmland", false]];
        const rows: string[] = [];
        let bad = 0, missing = 0;
        for (const [n, w] of want) {
            const b = blkuMake("minecraft:" + n);
            if (b === null) { missing++; rows.push(`${n}=none`); continue; }
            const got = b.isCropBlock();
            if (got !== w) bad++;
            rows.push(`${n}=${+got}${got === w ? "" : "!"}`);
        }
        const tagsOf = (n: string): string => `${n}:[${blkuTags(need("minecraft:" + n).blockLegacy as any as StaticPointer)}]`;
        return [bad === 0 && missing < 4, `${missing} missing; ${rows.join(" ")}; type tags of the ones a 2024 list would have called crops: ${tagsOf("melon_stem")} ${tagsOf("pumpkin_stem")} ${tagsOf("sweet_berry_bush")}`];
    });
    step("nether list", () => {
        const build = process.env.BLKU_BUILD ?? "";
        const t = BLKU_NETHER[build];
        if (t === undefined) return [false, `BLKU_BUILD=${JSON.stringify(build)}`];
        const reg = engineSymbol("bdsx:BlockTypeRegistry::instance");
        if (reg === null) return [false, "no registry symbol"];
        const at = (rva: number): NativePointer => reg.sub(t.reg).add(rva);
        const singles = t.singles.map(r => `${at(r).getCxxString(8)}`);
        const begin = at(t.begin).getPointer(0), end = at(t.end).getPointer(0);
        const n = end.subptr(begin);
        const group: string[] = [];
        for (let i = 0; i < n; i += 8) group.push(begin.add(i).getPointer(0).getCxxString(8));
        return [null, `singles ${singles.join(",")}; group of ${group.length}: ${group.join(",")}`];
    });
});

// BlockLegacy::setDestroyTime / Block::canHurtAndBreakItem (docs/findings-blocks.md "Block leftovers").
// `bperm`: find BlockType's permutation vector (Endstone block_permutations_ +552 = 0x228, but a read there faulted). A
// qword pair (begin, end) inside the type is a candidate when both are near the type in the heap, the span is a whole
// number of 8-byte entries, and the first entry is a Block whose +0x68 points back at the type.
events.command.on(cmd => {
    if (!/^\/?bperm\s*$/.test(cmd)) return;
    const near = (p: NativePointer, ref: StaticPointer): boolean => !p.isNull() && Math.abs(p.subptr(ref)) < 2 ** 36;
    for (const name of ["minecraft:stone", "minecraft:lever"]) {
        try {
            const b = Block.create(name, 0);
            if (b === null) {
                say(`bperm ${name}`, false, "Block.create returned null");
                continue;
            }
            const type = b.blockLegacy as any as StaticPointer;
            const rows: string[] = [];
            for (let off = 0x1c0; off <= 0x2a0; off += 8) {
                const begin = type.getPointer(off), end = type.getPointer(off + 8);
                if (!near(begin, type) || !near(end, type)) continue;
                const n = end.subptr(begin);
                if (n <= 0 || n % 8 !== 0 || n > 0x40000) continue;
                const first = begin.getPointer(0);
                const back = near(first, type) ? first.getPointer(0x68).equals(type) : false;
                rows.push(`+0x${off.toString(16)} n=${n / 8} first->type ${back}`);
            }
            say(`bperm ${name}`, null, rows.join(" | ") || "no candidate pair");
        } catch (err) {
            say(`bperm ${name}`, false, `threw ${(err as Error).message}`);
        }
    }
});

// both bhurt and bdtime work on the block at 31,68,18: bdtime's mining part waits until bhurt is done
let bhurtBusy = false;
// Block::canHurtAndBreakItem: the engine's own answer is what a survival simbot's diamond pickaxe loses when it mines the
// block (2024: legacy destroy time > 0 decided whether mineBlock hurt the tool). Needs "simprobe create" first; the
// block at 31,68,18 is set and mined one after another.
events.command.on(cmd => {
    if (!/^\/?bhurt\s*$/.test(cmd)) return;
    if (simbot === null) {
        say("bhurt", false, "no simbot (run simprobe create first)");
        return;
    }
    const sim = simbot;
    bhurtBusy = true;
    const names = ["dirt", "stone", "tnt", "slime", "oak_planks", "glass"];
    const pos = BlockPos.create(31, 68, 18);
    const rows: string[] = [];
    let i = 0;
    let phase = 0;
    let ticks = 0;
    let lost = 0;
    let destroyRet: boolean | null = null;
    const damage = (): number => sim.getInventory().container.getItem(0).getDamageValue();
    const finish = (): void => {
        events.levelTick.remove(step);
        bhurtBusy = false;
        bedrockServer.executeCommand("setblock 31 68 18 air");
        say("bhurt rows", null, rows.join(" | "));
        // a console command arriving while the simbot digs can interrupt it: BHURT_CHAIN=1 runs bdtime right after
        if (process.env.BHURT_CHAIN === "1") runBdtime();
    };
    const step = (): void => {
        try {
            const name = names[i];
            if (phase === 0) {
                bedrockServer.executeCommand(`setblock 31 68 18 ${name}`);
                const pick = ItemStack.constructWith("minecraft:diamond_pickaxe", 1);
                sim.simulateSetItem(pick, true, 0);
                pick.destruct();
                phase = 1;
                ticks = 0;
                return;
            }
            if (phase === 1) {
                if (ticks++ === 0) {
                    const b = sim.getDimensionBlockSource().getBlock(pos);
                    if (b.getName() !== `minecraft:${name}`) {
                        rows.push(`${name} PLACED-WRONG(${b.getName()})`);
                        i++;
                        phase = 0;
                        if (i >= names.length) finish();
                        return;
                    }
                    lost = damage();
                    destroyRet = sim.simulateDestroyBlock(pos, 1);
                    return;
                }
                const gone = sim.getDimensionBlockSource().getBlock(pos).getName() === "minecraft:air";
                if (gone && ticks > 6 || ticks > 200) {
                    const d = damage() - lost;
                    const b = Block.create(`minecraft:${name}`, 0)!;
                    const derived = b.canHurtAndBreakItem();
                    say(`bhurt ${name}`, gone && (d > 0) === derived, `simulateDestroyBlock ${destroyRet}; broken ${gone} after ${ticks} ticks; the pickaxe lost ${d} durability; canHurtAndBreakItem ${derived}; destroySpeed ${b.getDestroySpeed()}`);
                    rows.push(`${name} lost ${d} derived ${derived}`);
                    i++;
                    phase = 0;
                    if (i >= names.length) finish();
                }
            }
        } catch (err) {
            say("bhurt", false, `threw ${(err as Error).stack}`);
            finish();
        }
    };
    events.levelTick.on(step);
});

// BlockLegacy::setDestroyTime: `bdtime` sets a lever type's (sixteen permutations) destroy time and reads every
// permutation back, restores it, then changes dirt's time and lets a survival simbot (simprobe create first) mine it with a
// diamond pickaxe: the engine's own mining time and durability loss must follow the value (17 ticks and 1 point at 0.5).
function runBdtime(): void {
    if (simbot === null) {
        say("bdtime", false, "no simbot (run simprobe create first)");
        return;
    }
    const sim = simbot;
    const L = pdbcache.layouts.Block as Record<string, number>;
    const f32 = (p: StaticPointer, off: number): number => p.getFloat32(off);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;
    try {
        const lever = Block.create("minecraft:lever", 0)!.blockLegacy;
        const perms = blockTypePermutations(lever as any as StaticPointer);
        const orig = perms.map(p => ({ d: f32(p, L.destroySpeed), e: f32(p, L.explosionResistance), m: p.getPointer(0xd0).isNull() ? null : f32(p.getPointer(0xd0), 0) }));
        const ret = lever.setDestroyTime(3);
        const after = perms.map(p => ({ d: f32(p, L.destroySpeed), e: f32(p, L.explosionResistance), m: p.getPointer(0xd0).isNull() ? null : f32(p.getPointer(0xd0), 0) }));
        const allSet = after.every(a => near(a.d, 3) && near(a.e, 3) && (a.m === null || near(a.m, 3)));
        const viaApi = Block.create("minecraft:lever", 5)!.getDestroySpeed();
        say("bdtime lever", perms.length === 16 && allSet && near(viaApi, 3), `${perms.length} permutations, before ${JSON.stringify(orig[0])}, after all set ${allSet} (first ${JSON.stringify(after[0])}), getDestroySpeed of one permutation ${viaApi}, returned ${ret}`);
        perms.forEach((p, i) => {
            p.setFloat32(orig[i].d, L.destroySpeed);
            p.setFloat32(orig[i].e, L.explosionResistance);
            if (orig[i].m !== null) p.getPointer(0xd0).setFloat32(orig[i].m!, 0);
        });
        say("bdtime lever restored", near(Block.create("minecraft:lever", 5)!.getDestroySpeed(), orig[5].d), `getDestroySpeed ${Block.create("minecraft:lever", 5)!.getDestroySpeed()} (was ${orig[5].d})`);
    } catch (err) {
        say("bdtime lever", false, `threw ${(err as Error).stack}`);
        return;
    }

    const pos = BlockPos.create(31, 68, 18);
    const legacy = Block.create("minecraft:dirt", 0)!.blockLegacy;
    const times = [0.5, 0, 2, 0.5];
    const rows: unknown[] = [];
    let i = 0;
    let phase = 0;
    let ticks = 0;
    let lost = 0;
    const damage = (): number => sim.getInventory().container.getItem(0).getDamageValue();
    const step = (): void => {
        try {
            if (phase === 0) {
                if (i > 0) legacy.setDestroyTime(times[i]);
                bedrockServer.executeCommand("setblock 31 68 18 dirt");
                const pick = ItemStack.constructWith("minecraft:diamond_pickaxe", 1);
                sim.simulateSetItem(pick, true, 0);
                pick.destruct();
                phase = 1;
                ticks = 0;
                return;
            }
            if (ticks++ === 0) {
                lost = damage();
                sim.simulateDestroyBlock(pos, 1);
                return;
            }
            const gone = sim.getDimensionBlockSource().getBlock(pos).getName() === "minecraft:air";
            if (gone && ticks > 6 || ticks > 250) {
                const d = damage() - lost;
                const b = Block.create("minecraft:dirt", 0)!;
                rows.push({ t: times[i], ticks, d, gone, hard: b.getDestroySpeed(), hurt: b.canHurtAndBreakItem() });
                i++;
                phase = 0;
                if (i >= times.length) {
                    events.levelTick.remove(step);
                    bedrockServer.executeCommand("setblock 31 68 18 air");
                    const R = rows as any as { t: number; ticks: number; d: number; gone: boolean; hard: number; hurt: boolean }[];
                    const base = R[0], zero = R[1], slow = R[2], back = R[3];
                    say("bdtime mining", base.gone && zero.gone && slow.gone && back.gone && zero.ticks < base.ticks && zero.d === 0 && !zero.hurt && slow.ticks > 2 * base.ticks && slow.d === 1 && back.hard === base.hard && Math.abs(back.ticks - base.ticks) <= 1,
                        R.map(r => `time ${r.t}: destroySpeed ${r.hard} broke=${r.gone} after ${r.ticks} ticks, pickaxe lost ${r.d}, canHurtAndBreakItem ${r.hurt}`).join(" | "));
                }
            }
        } catch (err) {
            say("bdtime mining", false, `threw ${(err as Error).stack}`);
            events.levelTick.remove(step);
            legacy.setDestroyTime(0.5);
        }
    };
    const waitForBhurt = (): void => {
        if (bhurtBusy) return;
        events.levelTick.remove(waitForBhurt);
        events.levelTick.on(step);
    };
    events.levelTick.on(waitForBhurt);
}
events.command.on(cmd => {
    if (/^\/?bdtime\s*$/.test(cmd)) runBdtime();
});
