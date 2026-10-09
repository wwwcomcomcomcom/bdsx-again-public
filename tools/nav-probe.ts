/**
 * "navprobe": NavigationComponent on 1.26 (docs/findings-components.md, section NavigationComponent).
 *
 * The component is an EnTT element of 0x60 bytes on both builds (hash 0xbb725ebe = fnv1a "NavigationComponent"; every
 * user indexes `leaq (r,r,2); shll $5`). 2024's fields (docs/findings-components.md, section NavigationComponent) were read off 2024's leaf
 * bodies; this probe reads the live component of mobs whose behaviour packs differ and prints the bytes.
 *
 *   navprobe dump   summons one mob per type (tagged bdsxnav) and dumps each one's 0x60 bytes
 *   navprobe again  dumps the same mobs 8 s later, after their goals ran
 *   navprobe check  every NavigationComponent accessor bdsx carries, against the behaviour packs' own navigation JSON and the
 *                   engine's own createPath / stop (createPath -> setPath -> setPath -> stop frees paths the engine made
 *                   and paths bdsx replaced)
 *   navprobe clean  kills them
 */
import { Actor, Mob } from "bdsx/bds/actor";
import { AttributeId } from "bdsx/bds/attribute";
import { Vec3 } from "bdsx/bds/blockpos";
import { Player } from "bdsx/bds/player";
import { componentHash } from "bdsx/bds/engine/deps";
import { enttComponent } from "bdsx/bds/engine/entt";
import { NativePointer, StaticPointer } from "bdsx/core";
import { dllraw } from "bdsx/dllraw";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";

const TAG = "[navprobe]";
const NAV = componentHash("NavigationComponent");
const NAV_SIZE = 0x60;
const MOBS: [string, number][] = [
    ["minecraft:zombie", 29.5],
    ["minecraft:pig", 33.5],
    ["minecraft:strider", 37.5],
    ["minecraft:skeleton", 41.5],
    ["minecraft:spider", 45.5],
    ["minecraft:villager_v2", 49.5],
    ["minecraft:chicken", 53.5],
];

function tagged(): Map<string, Actor> {
    const out = new Map<string, Actor>();
    for (const e of bedrockServer.level.getEntities()) {
        try {
            if (e.hasTag("bdsxnav")) out.set(e.getIdentifier(), e);
        } catch (err) {
            /* an entity mid-removal can throw reading its own fields */
        }
    }
    return out;
}

function hex(p: StaticPointer, from: number, to: number): string {
    const b: string[] = [];
    for (let i = from; i < to; i++) b.push(p.getUint8(i).toString(16).padStart(2, "0"));
    return b.join(" ");
}

function dump(label: string, e: Actor): void {
    const c = enttComponent(e, NAV, NAV_SIZE);
    if (c === null) {
        console.log(`${TAG} INFO ${label}: no NavigationComponent`);
        return;
    }
    console.log(`${TAG} INFO ${label}:`);
    for (let off = 0; off < NAV_SIZE; off += 16) console.log(`${TAG} INFO   +0x${off.toString(16).padStart(2, "0")}: ${hex(c, off, off + 16)}`);
    const f = (off: number): string => c.getFloat32(off).toFixed(3);
    console.log(`${TAG} INFO   floats +0x1c ${f(0x1c)} +0x20 ${f(0x20)} +0x24 ${f(0x24)} +0x28 ${f(0x28)} +0x2c ${f(0x2c)} +0x30 ${f(0x30)} +0x34 ${f(0x34)}`);
    // any pointer field whose target starts with a pointer into the image is a polymorphic object: print its vftable
    for (let off = 0; off < NAV_SIZE; off += 8) {
        try {
            // a user-space heap pointer: high dword 1..0x7fff, low dword 8-aligned (floats and flags are not)
            const hi = c.getUint32(off + 4);
            if (hi === 0 || hi > 0x7fff || (c.getUint32(off) & 7) !== 0) continue;
            const obj = c.getPointer(off);
            if (obj.isNull()) continue;
            const vp = obj.getPointer(0) as NativePointer;
            const r = vp.subptr(dllraw.current);
            if (r < 0x100000 || r > 0x10000000) {
                // not polymorphic: a plain heap object (the Path, or a std::vector's storage). Its first 0x48 bytes.
                if (off >= 0x30) console.log(`${TAG} INFO   +0x${off.toString(16)} -> heap ${hex(obj, 0, 0x48)}`);
                continue;
            }
            const slots: string[] = [];
            for (let i = 0; i < 16; i++) slots.push(`${i}:${(vp.getPointer(i * 8) as NativePointer).subptr(dllraw.current).toString(16)}`);
            console.log(`${TAG} INFO   +0x${off.toString(16)} object vptr 0x${r.toString(16)} slots ${slots.join(" ")}`);
        } catch (err) {
            /* not an object */
        }
    }
    console.log(`${TAG} INFO   pointers +0x40 ${c.getPointer(0x40)} +0x48 ${c.getPointer(0x48)} +0x50 ${c.getPointer(0x50)} +0x58 ${c.getPointer(0x58)}`);
}

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

// what the vanilla behaviour packs say each mob's minecraft:navigation.walk / .climb carries (work/navjson, read from
// the host's behavior_packs/vanilla*/entities: zombie {can_break_doors, is_amphibious, can_pass_doors, can_walk,
// using_door_annotation}, pig {avoid_damage_blocks, avoid_water, can_path_over_water, using_door_annotation}, skeleton
// {avoid_sun, is_amphibious, avoid_water, using_door_annotation}, spider (climb) {can_path_over_water}, chicken
// {avoid_damage_blocks, can_path_over_water, using_door_annotation}, strider {can_path_over_lava, avoid_water, can_sink:
// false, can_walk_in_lava}). canFloat is bdsx's name for can_path_over_water.
const EXPECT: Record<string, { sun: boolean; water: boolean; float: boolean; lava: boolean }> = {
    "minecraft:zombie": { sun: false, water: false, float: false, lava: false },
    "minecraft:pig": { sun: false, water: true, float: true, lava: false },
    "minecraft:skeleton": { sun: true, water: true, float: false, lava: false },
    "minecraft:spider": { sun: false, water: false, float: true, lava: false },
    "minecraft:chicken": { sun: false, water: false, float: true, lava: false },
    "minecraft:strider": { sun: false, water: true, float: false, lava: true },
};

const say = (label: string, ok: boolean | null, detail: string): void => console.log(`${TAG} ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);

function nodes(path: StaticPointer): number {
    return path.getPointer(8).subptr(path.getPointer(0)) / 16;
}
function lastNode(path: StaticPointer): [number, number, number] {
    const end = path.getPointer(8);
    return [end.getInt32(-16), end.getInt32(-12), end.getInt32(-8)];
}
const near3 = (a: number[], b: number[], r: number): boolean => a.every((v, i) => Math.abs(v - b[i]) <= r);

function check(): void {
    const all = tagged();
    for (const [id, want] of Object.entries(EXPECT)) {
        const e = all.get(id);
        if (e === undefined) {
            say(`${id} present`, false, "not found");
            continue;
        }
        const nav = e.tryGetComponent("minecraft:navigation");
        if (nav === null) {
            say(`${id} component`, false, "tryGetComponent(minecraft:navigation) returned null");
            continue;
        }
        const raw = enttComponent(e, NAV, NAV_SIZE)!;
        const rawWater = ((raw.getUint8(0) >> 3) & 1) !== 0;
        const got = { sun: nav.getAvoidSun(), water: rawWater, float: nav.getCanFloat(), lava: nav.getCanPathOverLava() };
        say(`${id} flags`, got.sun === want.sun && got.water === want.water && got.float === want.float && got.lava === want.lava, `avoid_sun ${got.sun} avoid_water(raw bit 3) ${got.water} can_path_over_water ${got.float} can_path_over_lava ${got.lava}; the pack says ${JSON.stringify(want)}`);
    }
    const zombie = all.get("minecraft:zombie");
    const pig = all.get("minecraft:pig");
    if (zombie === undefined || pig === undefined || player === null) {
        say("mobs", false, `zombie ${zombie !== undefined} pig ${pig !== undefined} player ${player !== null}`);
        return;
    }
    const zn = zombie.tryGetComponent("minecraft:navigation")!;
    const zraw = enttComponent(zombie, NAV, NAV_SIZE)!;
    // setters: each flips its own bit and nothing else
    const before = zraw.getUint16(0);
    zn.setAvoidSun(true);
    const afterSun = zraw.getUint16(0);
    say("setAvoidSun", zn.getAvoidSun() === true && afterSun === (before | 0x4), `word 0x${before.toString(16)} -> 0x${afterSun.toString(16)}`);
    zn.setAvoidSun(false);
    zn.setAvoidWater(true);
    const afterWater = zraw.getUint16(0);
    say("setAvoidWater", ((afterWater >> 3) & 1) === 1 && afterWater === (before | 0x8), `word 0x${before.toString(16)} -> 0x${afterWater.toString(16)}`);
    zn.setAvoidWater(false);
    zn.setCanFloat(true);
    const afterFloat = zraw.getUint16(0);
    say("setCanFloat", zn.getCanFloat() === true && afterFloat === (before | 0x20), `word 0x${before.toString(16)} -> 0x${afterFloat.toString(16)}`);
    zn.setCanFloat(false);
    say("setters restored", zraw.getUint16(0) === before, `word 0x${zraw.getUint16(0).toString(16)} (was 0x${before.toString(16)})`);
    const speed0 = zn.getSpeed();
    zn.setSpeed(2.5);
    say("setSpeed/getSpeed", zn.getSpeed() === 2.5 && zraw.getFloat32(0x14) === 2.5, `read ${zn.getSpeed()}, raw +0x14 ${zraw.getFloat32(0x14)}`);
    zn.setSpeed(speed0);
    say("getSpeed natural", null, `zombie ${speed0}, pig ${pig.tryGetComponent("minecraft:navigation")!.getSpeed()}`);
    // the position the engine last stored for the stuck check is where the mob was
    const pn = pig.tryGetComponent("minecraft:navigation")!;
    const pp = pn.getLastStuckCheckPosition();
    const ppos = pig.getPosition();
    // a mob that never walked has stored nothing (all zero: 40's pig); one that did has its own position there
    const idle = pp.x === 0 && pp.y === 0 && pp.z === 0;
    say("getLastStuckCheckPosition pig", idle ? null : Math.abs(pp.x - ppos.x) < 12 && Math.abs(pp.z - ppos.z) < 12 && Math.abs(pp.y - ppos.y) < 3, `last (${pp.x.toFixed(2)}, ${pp.y.toFixed(2)}, ${pp.z.toFixed(2)})${idle ? " (never stored)" : ""} pig at (${ppos.x.toFixed(2)}, ${ppos.y.toFixed(2)}, ${ppos.z.toFixed(2)})`);
    const zp = zn.getLastStuckCheckPosition();
    const zpos = zombie.getPosition();
    // a snapshot: the position of the last stuck check, which for a mob that has not yet had one is where it was summoned
    say("getLastStuckCheckPosition zombie", Math.abs(zp.x - zpos.x) < 12 && Math.abs(zp.z - zpos.z) < 12 && Math.abs(zp.y - zpos.y) < 3, `last (${zp.x.toFixed(2)}, ${zp.y.toFixed(2)}, ${zp.z.toFixed(2)}) zombie at (${zpos.x.toFixed(2)}, ${zpos.y.toFixed(2)}, ${zpos.z.toFixed(2)})`);
    const d = zraw.getInt32(4) - zraw.getInt32(0xc);
    say("isStuck", zn.isStuck(d - 1) === true && zn.isStuck(d) === false && zn.isStuck(d + 1000) === false, `tick ${zraw.getInt32(4)} - stuckTick ${zraw.getInt32(0xc)} = ${d}`);
    const fr = zn.getMaxDistance(zombie);
    say("getMaxDistance", fr > 0 && fr === zombie.getAttribute(AttributeId.FollowRange), `${fr}`);
    const pigPath = enttComponent(pig, NAV, NAV_SIZE)!.getPointer(0x58);
    say("isDone pig", pigPath.isNull() ? pn.isDone() === true : null, `pig path ${pigPath}, isDone ${pn.isDone()}`);
    // the engine's own createPath, through the navigation object's vftable
    const target = Vec3.allocate();
    const zp2 = zombie.getPosition();
    target.x = zp2.x + 6;
    target.y = zp2.y;
    target.z = zp2.z;
    // the path ends on a block near the target (the ground below it need not be at the target's own height)
    const want: [number, number, number] = [Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)];
    const p1 = zn.createPath(zombie, target);
    if (p1 === null) {
        say("createPath(Vec3)", false, "the engine returned no path");
    } else {
        const p1p = p1 as any as StaticPointer;
        const ln = lastNode(p1p);
        say("createPath(Vec3)", nodes(p1p) > 0 && Math.abs(ln[0] - want[0]) <= 2 && Math.abs(ln[2] - want[2]) <= 2 && Math.abs(ln[1] - want[1]) <= 4, `${nodes(p1p)} nodes, cursor ${p1p.getUint32(0x18)}, last node ${ln.join(",")}, target block ${want.join(",")}`);
        zn.setPath(p1);
        say("setPath", zraw.getPointer(0x58).equals(p1p) && !zn.isDone(), `component path ${zraw.getPointer(0x58)} (want ${p1p}), isDone ${zn.isDone()}`);
    }
    const p2 = zn.createPath(zombie, player as any as Actor);
    if (p2 === null) {
        say("createPath(Actor)", false, "the engine returned no path");
    } else {
        const p2p = p2 as any as StaticPointer;
        const ln = lastNode(p2p);
        const ppos2 = (player as any as Actor).getPosition();
        say("createPath(Actor)", nodes(p2p) > 0 && near3(ln, [Math.floor(ppos2.x), Math.floor(ppos2.y - 1.62), Math.floor(ppos2.z)], 3), `${nodes(p2p)} nodes, last node ${ln.join(",")}, player at (${ppos2.x.toFixed(2)}, ${ppos2.y.toFixed(2)}, ${ppos2.z.toFixed(2)})`);
        zn.setPath(p2); // bdsx deletes the first path
        say("setPath replaces", zraw.getPointer(0x58).equals(p2p) && !zn.isDone(), `component path ${zraw.getPointer(0x58)} (want ${p2p}), isDone ${zn.isDone()}`);
    }
    zn.stop(zombie as Mob);
    say("stop", zraw.getPointer(0x58).isNull() && zn.isDone(), `component path ${zraw.getPointer(0x58)}, isDone ${zn.isDone()}`);
}

events.command.on(cmd => {
    const m = /^\/?navprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    try {
        if (step === "dump") {
            for (const [id, x] of MOBS) bedrockServer.executeCommand(`summon ${id.replace("minecraft:", "")} ${x} 68 20.5`);
            let n = 0;
            for (const e of bedrockServer.level.getEntities()) {
                try {
                    const id = e.getIdentifier();
                    const spec = MOBS.find(s => s[0] === id);
                    if (spec === undefined || e.hasTag("bdsxnav")) continue;
                    const pos = e.getPosition();
                    if (Math.abs(pos.x - spec[1]) < 1 && Math.abs(pos.z - 20.5) < 1) {
                        e.addTag("bdsxnav");
                        n++;
                    }
                } catch (err) {
                    /* skip */
                }
            }
            console.log(`${TAG} INFO summoned and tagged ${n} of ${MOBS.length}`);
        }
        if (step === "dump" || step === "again") {
            const all = tagged();
            for (const [id] of MOBS) {
                const e = all.get(id);
                if (e === undefined) console.log(`${TAG} INFO ${id}: not found`);
                else dump(id, e);
            }
        }
        if (step === "check") check();
        if (step === "clean") bedrockServer.executeCommand("kill @e[tag=bdsxnav]");
    } catch (err) {
        console.log(`${TAG} FAIL ${step} threw ${(err as Error).stack}`);
    }
});
