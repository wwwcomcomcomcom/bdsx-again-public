// Execution checks for the SimulatedPlayer actions 1.26 inlined into the GameTest bindings
// (docs/findings-slots.md "SimulatedPlayer: the five that were inlined"): simulateInteract (actor and block),
// simulateSetItem, simulateStopDestroyingBlock, simulateDisconnect. Deployed as zz-simpprobe.ts; console:
//   "simp create <name>", "simp iact", "simp iblock", "simp setitem", "simp destroy control|stop", "simp dc <name>"
// Everything happens around x=-2000, z=2000 (a ticking area the driver adds) so that no other probe's blocks are touched.
//
// The Q7 leftovers a simulated player can reach (docs/findings-slots.md "Q7 through a simulated player"), with
// SIMQ7_PROBE=1 (drivers simq7*40/51.ps1), which installs the listeners below and so bdsx's hooks for them:
//   "simp jump [sprint]"   simulateJump: the jump itself, and whether playerJump / the jump's exhaustion follow (they do not)
//   "simp jumpcall [sprint|creative]"  the JumpExhaustion per-entity function called through bdsx's playerJump hook
//   "simp bds"             blockDestructionStart from a survival simulateDestroyBlock (1.26: onStartDestroyBlock)
//   "simp place [cancel]"  blockPlace from the engine's own placement (simulateUseItemInSlotOnBlock -> mayPlace)
//   "simp dropall [bot]"   bdsx's own PlayerInventory::dropAllOnDeath -> Player::drop on a live player
//   "simp cbdp <mode>"     BlockSource::checkBlockDestroyPermissions for a player whose abilities are real
import { ActorType } from "bdsx/bds/actor";
import { AttributeId } from "bdsx/bds/attribute";
import { BlockPos, Vec3 } from "bdsx/bds/blockpos";
import { componentHash } from "bdsx/bds/engine/deps";
import { enttComponent } from "bdsx/bds/engine/entt";
import { ItemStack } from "bdsx/bds/inventory";
import { Player, SimulatedPlayer } from "bdsx/bds/player";
import { CommandResultType } from "bdsx/commandresult";
import { CANCEL } from "bdsx/common";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { makefunc } from "bdsx/makefunc";
import { bool_t, void_t } from "bdsx/nativetype";
import { pdbcache } from "bdsx/pdbcache";
import { procHacker } from "bdsx/prochacker";
import { AllocatedPointer, VoidPointer } from "bdsx/core";
import type { StaticPointer } from "bdsx/core";
import { proc } from "bdsx/bds/symbols";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[simp] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

const X = -2000;
const Z = 2000;
const sims = new Map<string, SimulatedPlayer>();

// --- SIMQ7_PROBE=1: what bdsx's own hooks report, by level tick ---
let tickNo = 0;
const jumpLog: { name: string; tick: number }[] = [];
const bdsLog: { name: string; x: number; y: number; z: number; tick: number }[] = [];
const placeLog: { name: string; block: string; x: number; y: number; z: number; tick: number; cancelled: boolean }[] = [];
let cancelPlace = false;
if (process.env.SIMQ7_PROBE === "1") {
    events.levelTick.on(() => {
        tickNo++;
    });
    events.playerJump.on(ev => {
        jumpLog.push({ name: ev.player.getName(), tick: tickNo });
    });
    events.blockDestructionStart.on(ev => {
        bdsLog.push({ name: ev.player.getName(), x: ev.blockPos.x, y: ev.blockPos.y, z: ev.blockPos.z, tick: tickNo });
    });
    events.blockPlace.on(ev => {
        placeLog.push({ name: ev.player.getName(), block: ev.block.getName(), x: ev.blockPos.x, y: ev.blockPos.y, z: ev.blockPos.z, tick: tickNo, cancelled: cancelPlace });
        if (cancelPlace) return CANCEL;
    });
    say("simq7", null, "playerJump, blockDestructionStart and blockPlace listeners installed");
}
function exhaustion(p: Player): number {
    const inst = p.getAttributes().getMutableInstance(AttributeId.PlayerExhaustion);
    return inst === null ? NaN : inst.currentValue;
}
function inventorySummary(p: Player): string {
    const slots = p.getInventory().getSlots();
    const parts: string[] = [];
    for (let i = 0; i < slots.size(); i++) {
        const item = slots.get(i);
        if (item === null || item.isNull()) continue;
        parts.push(`${i}:${item.toString().replace(/\[ItemStackNetId.*?\]\] /, "")}`);
    }
    return parts.length === 0 ? "(empty)" : parts.join(", ");
}
function otherPlayer(): Player | null {
    return bedrockServer.level.getPlayers().find(p => !(p instanceof SimulatedPlayer)) ?? null;
}
let simulateJumpBool: ((self: SimulatedPlayer) => boolean) | null = null;

function test(cmd: string): boolean {
    return bedrockServer.executeCommand(cmd, CommandResultType.Data).isSuccess();
}
function handItem(sim: SimulatedPlayer): string {
    return sim.getInventory().container.getItem(sim.getInventory().getSelectedSlot()).toString().replace(/\[ItemStackNetId.*?\]\] /, "");
}
function slotItem(sim: SimulatedPlayer, slot: number): string {
    return sim.getInventory().container.getItem(slot).toString().replace(/\[ItemStackNetId.*?\]\] /, "");
}
/** run `fn` on every level tick until it returns true or `max` ticks passed; `done(ticks)` after */
function everyTick(max: number, fn: (n: number) => boolean, done: (n: number, finished: boolean) => void): void {
    let n = 0;
    const on = (): void => {
        n++;
        let finished = false;
        try {
            finished = fn(n);
        } catch (err) {
            events.levelTick.remove(on);
            say("tick", false, `threw ${(err as Error).stack}`);
            return;
        }
        if (finished || n >= max) {
            events.levelTick.remove(on);
            done(n, finished);
        }
    };
    events.levelTick.on(on);
}

events.command.on(cmd => {
    const m = /^\/?simp\s+(create|iact|iblock|setitem|destroy|dc|list|jump|jumpcall|bds|place|dropall|cbdp)(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    const arg = m[2] ?? null;
    try {
        if (m[1] === "create") {
            const name = arg ?? "simbot";
            const sim = SimulatedPlayer.create(name, { x: X, y: 68, z: Z }, 0);
            if (sim === null) {
                say(`create ${name}`, false, "returned null");
                return;
            }
            sims.set(name, sim);
            const names = bedrockServer.level.getPlayers().map(p => p.getName());
            const pos = sim.getPosition();
            say(`create ${name}`, names.includes(name), `players [${names.join(",")}] at ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)} alive ${sim.isAlive()}`);
            return;
        }
        if (m[1] === "list") {
            say("list", null, bedrockServer.level.getPlayers().map(p => p.getName()).join(","));
            return;
        }
        if (m[1] === "dc") {
            const name = arg ?? "simdc";
            const sim = sims.get(name);
            if (sim === undefined) {
                say(`dc ${name}`, false, "no such simulated player");
                return;
            }
            const before = test(`testfor @a[name=${name}]`);
            const listed0 = bedrockServer.level.getPlayers().map(p => p.getName()).includes(name);
            sim.simulateDisconnect();
            sims.delete(name);
            everyTick(60, n => n >= 20, () => {
                const after = test(`testfor @a[name=${name}]`);
                const listed1 = bedrockServer.level.getPlayers().map(p => p.getName()).includes(name);
                everyTick(40, () => false, ticks => {
                    say(`dc ${name}`, before && listed0 && !after && !listed1, `before: testfor ${before} listed ${listed0}; 20 ticks after: testfor ${after} listed ${listed1}; the level ticked ${ticks} more times`);
                });
            });
            return;
        }
        const sim = sims.get("simbot");
        if (sim === undefined) {
            say(`${m[1]}`, false, "no simbot");
            return;
        }
        if (m[1] === "iact") {
            // a bucket in the selected slot (the driver gave it) and a live cow next to simbot: interacting milks the cow
            const before = handItem(sim);
            bedrockServer.executeCommand(`summon cow ${X + 1} 68 ${Z}`);
            const cows = sim.fetchNearbyActorsSorted(Vec3.create(4, 4, 4), ActorType.Cow).filter(c => c.entity.isAlive());
            if (cows.length === 0) {
                say("iact", false, "no cow next to simbot");
                return;
            }
            const r = sim.simulateInteractWithActor(cows[0].entity);
            const after = handItem(sim);
            say("iact", r === true && /milk/i.test(after) && !/milk/i.test(before), `simulateInteractWithActor(cow) -> ${r}; hand ${before} -> ${after}`);
            return;
        }
        if (m[1] === "iblock") {
            // a lever: each interaction flips open_bit. The state is read as the interned Block permutation at the position
            // (testforblock's state matching is unreliable on 1.26.40, docs/findings-slots.md "buttonPress"), and as testforblock
            const bx = X;
            const bz = Z + 3;
            const pos = BlockPos.create(bx, 68, bz);
            const perm = (): string => sim.getDimensionBlockSource().getBlock(pos).getAddressBin();
            const open = (): boolean => test(`testforblock ${bx} 68 ${bz} lever ["open_bit"=true]`);
            bedrockServer.executeCommand(`setblock ${bx} 68 ${bz} lever ["lever_direction"="up_north_south"]`);
            const name = sim.getDimensionBlockSource().getBlock(pos).getName();
            const p0 = perm();
            const t0 = open();
            const r1 = sim.simulateInteractWithBlock(pos, 1);
            const p1 = perm();
            const t1 = open();
            const r2 = sim.simulateInteractWithBlock(pos, 1);
            const p2 = perm();
            const t2 = open();
            say("iblock", name === "minecraft:lever" && r1 === true && r2 === true && p1 !== p0 && p2 === p0, `${name}: permutation off -> ${p1 === p0 ? "same" : "changed"} -> ${p2 === p0 ? "back to off" : "not off"} (interact ${r1}, ${r2}); testforblock open_bit ${t0} -> ${t1} -> ${t2} (info only) (want changed, then back)`);
            bedrockServer.executeCommand(`setblock ${bx} 68 ${bz} air`);
            return;
        }
        if (m[1] === "setitem") {
            const dia = ItemStack.constructWith("minecraft:diamond", 3);
            const app = ItemStack.constructWith("minecraft:apple", 2);
            try {
                const slot0 = sim.getInventory().getSelectedSlot();
                const r1 = sim.simulateSetItem(dia, false, 4);
                const s4 = slotItem(sim, 4);
                const sel1 = sim.getInventory().getSelectedSlot();
                const r2 = sim.simulateSetItem(app, true, 6);
                const s6 = slotItem(sim, 6);
                const sel2 = sim.getInventory().getSelectedSlot();
                const hand = handItem(sim);
                const ok = r1 === true && /diamond/i.test(s4) && /3/.test(s4) && sel1 === slot0 && r2 === true && /apple/i.test(s6) && sel2 === 6 && /apple/i.test(hand);
                say("setitem", ok, `slot 4 ${s4} (selected ${slot0} -> ${sel1}, returned ${r1}); slot 6 ${s6} (selected -> ${sel2}, returned ${r2}); hand ${hand}`);
            } finally {
                dia.destruct();
                app.destruct();
            }
            return;
        }
        if (m[1] === "destroy") {
            // a survival simbot digs dirt next to it (about 15 ticks by hand). "control" lets it finish; "stop" stops it 3 ticks in
            const mode = arg ?? "control";
            const bx = X;
            const bz = Z + 1;
            const l = pdbcache.layouts.SimulatedPlayer as Record<string, number> | undefined;
            const flag = (): number => (l === undefined ? -1 : (sim as any as StaticPointer).getUint8(l.destroying));
            bedrockServer.executeCommand(`setblock ${bx} 68 ${bz} dirt`);
            const r = sim.simulateDestroyBlock(BlockPos.create(bx, 68, bz), 1);
            const flag0 = flag();
            if (mode === "control") {
                everyTick(120, () => !test(`testforblock ${bx} 68 ${bz} dirt`), (n, finished) => {
                    say("destroy control", r === true && finished, `simulateDestroyBlock -> ${r}, destroying flag ${flag0}; the dirt was gone after ${n} tick(s) (want true and well under 120)`);
                });
                return;
            }
            let stopped = false;
            let flagAtStop = -1;
            let flagAfter = -1;
            everyTick(120, n => {
                if (n === 3 && !stopped) {
                    flagAtStop = flag();
                    sim.simulateStopDestroyingBlock();
                    flagAfter = flag();
                    stopped = true;
                }
                return !test(`testforblock ${bx} 68 ${bz} dirt`);
            }, (n, finished) => {
                say("destroy stop", r === true && !finished && flagAtStop === 1 && flagAfter === 0, `simulateDestroyBlock -> ${r}; destroying flag ${flag0} at start, ${flagAtStop} just before the stop, ${flagAfter} after; after ${n} ticks the dirt is ${finished ? "GONE" : "still there"} (want still there)`);
                bedrockServer.executeCommand(`setblock ${bx} 68 ${bz} air`);
            });
            return;
        }
        if (m[1] === "jump") {
            // A survival simbot on the stone floor jumps once (simulateJump, its bool read through a local binding: bdsx's
            // declares void). What a jump costs is the oracle: 1.26's JumpExhaustion system adds the ExhaustionComponent's
            // jump value (+4; +8 when the sprint flag is up) to the exhaustion attribute, and bdsx's playerJump hook sits on
            // that system's per-entity function. The first run (2026-10-02) showed simulateJump does not reach it, so this
            // step asserts the jump itself (the feet rise) and reports the effects; "jump control" is 40 quiet ticks.
            if (simulateJumpBool === null) simulateJumpBool = procHacker.js("?simulateJump@SimulatedPlayer@@QEAA_NXZ", bool_t, null, SimulatedPlayer);
            const sprint = arg === "sprint";
            const comp = enttComponent(sim, componentHash("ExhaustionComponent"), 40);
            const jumpValue = comp === null ? NaN : comp.getFloat32(4);
            const sprintValue = comp === null ? NaN : comp.getFloat32(8);
            const label = sprint ? "jump sprint" : "jump";
            const others0 = jumpLog.filter(j => j.name !== "simbot").length;
            let r: boolean | null = null;
            let e0 = NaN;
            let j0 = 0;
            let y0 = NaN;
            let yMax = -Infinity;
            let sprinting = false;
            everyTick(14, n => {
                if (n === 2) {
                    e0 = exhaustion(sim);
                    j0 = jumpLog.filter(j => j.name === "simbot").length;
                    y0 = sim.getFeetPos().y;
                    if (sprint) sim.setSprinting(true);
                    sprinting = sim.isSprinting();
                    r = simulateJumpBool!(sim);
                } else if (n > 2) {
                    yMax = Math.max(yMax, sim.getFeetPos().y);
                }
                return false;
            }, () => {
                const e1 = exhaustion(sim);
                const mine = jumpLog.filter(j => j.name === "simbot");
                const j1 = mine.length;
                const delta = e1 - e0;
                const want = sprinting ? sprintValue : jumpValue;
                const reached = j1 - j0 === 1 && Math.abs(delta - want) < 1e-4;
                say(`${label} physical`, r === true && yMax - y0 > 0.5, `simulateJump -> ${r}; feet y ${y0.toFixed(2)} -> highest ${yMax.toFixed(2)} over 12 ticks (want a rise over 0.5)`);
                say(`${label} effects`, null, `sprinting ${sprinting}; playerJump for simbot ${j0} -> ${j1}; exhaustion ${e0.toFixed(4)} -> ${e1.toFixed(4)} (delta ${delta.toFixed(4)}; ExhaustionComponent jump ${jumpValue.toFixed(4)}, sprint jump ${sprintValue.toFixed(4)}): the JumpExhaustion system ${reached ? "RAN" : "did not run"} for the simulated jump`);
                if (sprint) {
                    if (sprinting) sim.setSprinting(false);
                    return;
                }
                everyTick(40, () => false, () => {
                    const e2 = exhaustion(sim);
                    const j2 = jumpLog.filter(j => j.name === "simbot").length;
                    const others = jumpLog.filter(j => j.name !== "simbot").length - others0;
                    say("jump control", j2 === j1 && Math.abs(e2 - e1) < 1e-6, `40 ticks with no jump: playerJump for simbot ${j1} -> ${j2}, exhaustion ${e1.toFixed(4)} -> ${e2.toFixed(4)}; events for any other player over the step ${others} (info)`);
                });
            });
            return;
        }
        if (m[1] === "jumpcall") {
            // The JumpExhaustion system's per-entity function called through bdsx's hook, the way "placeprobe call" first
            // checked mayPlace: simbot's entity id, an ActorDataFlag dword (bit 3 = sprinting), a game type, simbot's own
            // ExhaustionComponent, a context whose first word is simbot's EntityRegistry, and a world default game type 0.
            // The hook must name simbot, and the original must then queue the jump value (sprint: the sprint jump's; game
            // type 1, creative: nothing), which the attribute system applies within a few ticks.
            const variant = arg ?? "plain";
            const fnp = proc["bdsx:JumpExhaustionSystem::_tickEntity"];
            const comp = enttComponent(sim, componentHash("ExhaustionComponent"), 40);
            const self = sim as any as StaticPointer;
            // Actor+8 is the EntityRegistry, +16 the entt registry inside it (+0x30), +24 the entity id (layouts.Actor)
            const entityRegistry = self.getPointer(8);
            if (comp === null || !entityRegistry.add(0x30).equalsptr(self.getPointer(16))) {
                say(`jumpcall ${variant}`, false, `refused: ExhaustionComponent ${comp === null ? "missing" : "found"}, EntityRegistry+0x30 ${entityRegistry.add(0x30)} vs the actor's registry ${self.getPointer(16)}`);
                return;
            }
            const fn = makefunc.js(fnp, void_t, null, VoidPointer, VoidPointer, VoidPointer, VoidPointer, VoidPointer, VoidPointer);
            const id = new AllocatedPointer(8);
            id.setUint32(self.getUint32(24));
            const flags = new AllocatedPointer(16);
            flags.fill(0, 16);
            if (variant === "sprint") flags.setUint32(8);
            const gameType = new AllocatedPointer(8);
            gameType.setInt32(variant === "creative" ? 1 : 0);
            const context = new AllocatedPointer(8);
            context.setPointer(entityRegistry);
            const defaultGameType = new AllocatedPointer(8);
            defaultGameType.setInt32(0);
            const want = variant === "creative" ? 0 : comp.getFloat32(variant === "sprint" ? 8 : 4);
            let e0 = NaN;
            let j0 = 0;
            let j1 = 0;
            everyTick(8, n => {
                if (n === 2) {
                    e0 = exhaustion(sim);
                    j0 = jumpLog.filter(j => j.name === "simbot").length;
                    fn(id, flags, gameType, comp, context, defaultGameType);
                    j1 = jumpLog.filter(j => j.name === "simbot").length;
                }
                return false;
            }, () => {
                const e1 = exhaustion(sim);
                const delta = e1 - e0;
                say(`jumpcall ${variant}`, j1 - j0 === 1 && Math.abs(delta - want) < 1e-4, `the hook named simbot ${j1 - j0} time(s) during the call; exhaustion ${e0.toFixed(4)} -> ${e1.toFixed(4)} (delta ${delta.toFixed(4)}, want ${want.toFixed(4)})`);
            });
            return;
        }
        if (m[1] === "bds") {
            // A survival simbot digs dirt (the "destroy control" step's setup). SimulatedPlayer's preAiStep calls
            // ServerPlayerBlockUseHandler::onStartDestroyBlock on the first tick of a dig and serverTickBlockBreaking after,
            // and 1.26 inlined sendBlockDestructionStarted into the first: one event per start, before the block breaks.
            const bx = X;
            const bz = Z + 1;
            bedrockServer.executeCommand(`setblock ${bx} 68 ${bz} dirt`);
            const n0 = bdsLog.length;
            const t0 = tickNo;
            const r = sim.simulateDestroyBlock(BlockPos.create(bx, 68, bz), 1);
            let brokeAt = -1;
            everyTick(120, () => {
                if (!test(`testforblock ${bx} 68 ${bz} dirt`)) {
                    brokeAt = tickNo;
                    return true;
                }
                return false;
            }, (n, finished) => {
                everyTick(10, () => false, () => {
                    const evs = bdsLog.slice(n0);
                    const mine = evs.filter(e => e.name === "simbot");
                    const at = mine.filter(e => e.x === bx && e.y === 68 && e.z === bz);
                    const ok = r === true && finished && mine.length === 1 && at.length === 1 && at[0].tick <= brokeAt;
                    say("bds", ok, `simulateDestroyBlock -> ${r} at tick ${t0}; blockDestructionStart events ${evs.map(e => `${e.name}@${e.x},${e.y},${e.z} tick ${e.tick}`).join("; ") || "none"}; the dirt broke ${finished ? `at tick ${brokeAt} (${n} ticks)` : "NEVER"} (want exactly one event for simbot at the dirt, at or before the break)`);
                    bedrockServer.executeCommand(`setblock ${bx} 68 ${bz} air`);
                });
            });
            return;
        }
        if (m[1] === "place") {
            // simbot holds dirt in slot 0 (the driver gives it) and uses it on the stone floor through the engine's own
            // placement (GameMode::useItemOn). bdsx raises blockPlace from BlockSource::mayPlace when the actor is a
            // ServerPlayer and the engine said yes; a cancel turns mayPlace's answer into false.
            const cancel = arg === "cancel";
            const fx = cancel ? X + 3 : X + 2;
            bedrockServer.executeCommand(`setblock ${fx} 68 ${Z} air`);
            const slot0 = slotItem(sim, 0);
            const n0 = placeLog.length;
            cancelPlace = cancel;
            let r: boolean;
            try {
                r = sim.simulateUseItemInSlotOnBlock(0, BlockPos.create(fx, 67, Z), 1);
            } finally {
                cancelPlace = false;
            }
            const placed = test(`testforblock ${fx} 68 ${Z} dirt`);
            const evs = placeLog.slice(n0);
            const mine = evs.filter(e => e.name === "simbot");
            const at = mine.filter(e => e.x === fx && e.y === 68 && e.z === Z && /dirt/.test(e.block));
            const ok = cancel ? !placed && at.length >= 1 : r === true && placed && at.length >= 1 && at.length === mine.length;
            say(cancel ? "place cancel" : "place", ok, `slot 0 ${slot0}; simulateUseItemInSlotOnBlock(0, ${fx} 67 ${Z}, up) -> ${r}; blockPlace events ${evs.map(e => `${e.name} ${e.block}@${e.x},${e.y},${e.z}${e.cancelled ? " CANCEL" : ""}`).join("; ") || "none"}; dirt at ${fx} 68 ${Z}: ${placed} (want ${cancel ? "an event, cancelled, and no dirt" : "an event for simbot at the new block, and the dirt"})`);
            bedrockServer.executeCommand(`setblock ${fx} 68 ${Z} air`);
            return;
        }
        if (m[1] === "dropall") {
            // bdsx's own dropAllOnDeath (a derived(), docs/findings-containers.md "dropAllOnDeath") on a live player: each slot
            // goes through Player::drop, and bdsx's doDropSlot leaves a slot alone when drop refuses. simbot's abilities are
            // real; the headless bot's are all false (the loading-screen layer), which is the refusing side.
            const who = arg === "bot" ? otherPlayer() : sim;
            const label = arg === "bot" ? "dropall bot" : "dropall";
            if (who === null) {
                say(label, false, "no such player");
                return;
            }
            const pos = who.getPosition();
            const area = `x=${Math.floor(pos.x)},y=${Math.floor(pos.y)},z=${Math.floor(pos.z)},r=4`;
            bedrockServer.executeCommand(`kill @e[type=item,${area}]`, CommandResultType.Data);
            const before = inventorySummary(who);
            let health = NaN;
            let ability = "?";
            try {
                health = who.getHealth();
                ability = String(who.getAbilities().getBool(2 as any));
            } catch (err) {
                ability = `threw ${(err as Error).message}`;
            }
            who.getInventory().dropAllOnDeath(false);
            const after = inventorySummary(who);
            everyTick(3, () => false, () => {
                const items = test(`testfor @e[type=item,${area}]`);
                if (arg === "bot") {
                    say(label, null, `health ${health}, ability[2] ${ability}; ${before} -> ${after}; item entities near it: ${items} (the refusing side: want unchanged, none)`);
                } else {
                    say(label, before !== "(empty)" && after === "(empty)" && items, `health ${health}, ability[2] ${ability}; ${before} -> ${after}; item entities near it: ${items} (want every slot dropped and item entities)`);
                }
                bedrockServer.executeCommand(`kill @e[type=item,${area}]`, CommandResultType.Data);
            });
            return;
        }
        if (m[1] === "cbdp") {
            // checkBlockDestroyPermissions for simbot on dirt with its (empty) hand, flag false. 1.26's body: outside
            // adventure the allow bit stays set and the answer is Actor::canUseAbility(Mine); in adventure it is
            // PrivilegedBuilder, then the item's can_destroy only when the world's adventure overrides are on
            // (docs/findings-blocks.md 11). The headless bot's answer is printed beside it.
            const mode = arg ?? "survival";
            const bx = X;
            const bz = Z + 5;
            bedrockServer.executeCommand(`setblock ${bx} 68 ${bz} dirt`);
            const pos = BlockPos.create(bx, 68, bz);
            const region = sim.getDimensionBlockSource();
            const item = sim.getInventory().container.getItem(sim.getInventory().getSelectedSlot());
            const r = region.checkBlockDestroyPermission(sim, pos, item, false);
            const bot = otherPlayer();
            let botAnswer = "no bot";
            if (bot !== null) {
                const botItem = bot.getInventory().container.getItem(bot.getInventory().getSelectedSlot());
                botAnswer = String(bot.getDimensionBlockSource().checkBlockDestroyPermission(bot, pos, botItem, false));
            }
            const want = mode === "survival" ? true : mode === "adventure" ? false : null;
            say(`cbdp ${mode}`, want === null ? null : r === want, `simbot (${mode}) on ${region.getBlock(pos).getName()} -> ${r}${want === null ? "" : ` (want ${want})`}; the headless bot -> ${botAnswer} (info)`);
            return;
        }
    } catch (err) {
        say(m[1], false, `threw ${(err as Error).stack}`);
    }
});
