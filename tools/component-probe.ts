// Actor::tryGetComponent<X> for the components 1.26 keeps in the EnTT registry (docs/findings-components.md
// "tryGetComponent: nine components"), and the members bdsx builds on them.
//
// What this checks that a table lookup cannot fake: a component a definition has is found and a component it
// has not is null, on the same build, over the same summoned entities -- a lookup with the wrong hash answers
// null for all of them, and one with the wrong stride answers a wrong pointer for every entity but the first
// slot of a page. Both answers have to appear for every component.
//
//   compprobe     summon a pen of entities, print which of the nine components each one holds, check the
//                 answers the vanilla definitions fix (`[comp] PASS|FAIL <component>`), that the pointer is
//                 stable and distinct per entity, then the members (setOwnerId, setHasCollision)
//   pushprobe     the 1.26 split of PushableComponent (`[push]`): which of PushableByEntityComponent /
//                 PushableByBlockComponent each entity holds against the packs' "minecraft:pushable", then both
//                 PushableByEntityComponent.push overloads read back through the engine's posDelta
//
// Entities are found by the diff of `level.getEntities()` (a small world) around each `summon`, not by
// position, and are removed again at the end. Deployed as zz-compprobe.ts.
import { Actor, ActorDefinitionIdentifier, ActorFlags } from "bdsx/bds/actor";
import { Vec3 } from "bdsx/bds/blockpos";
import { Player } from "bdsx/bds/player";
import { CommandResultType } from "bdsx/commandresult";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import type { StaticPointer } from "bdsx/core";
import { componentHash } from "bdsx/bds/engine/deps";
import { enttComponent } from "bdsx/bds/engine/entt";

const TAG = "[comp]";
let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`${TAG} ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
function run(cmd: string): void {
    bedrockServer.executeCommand(cmd, CommandResultType.Data);
}
function uid(a: Actor): string {
    return String(a.getUniqueIdBin());
}
function addr(p: { getAddressHigh(): number; getAddressLow(): number } | null): string {
    return p === null ? "null" : `0x${p.getAddressHigh().toString(16)}${p.getAddressLow().toString(16).padStart(8, "0")}`;
}

const KEYS = [
    "minecraft:projectile",
    "minecraft:rideable",
    "minecraft:shooter",
    "minecraft:npc",
    "minecraft:nameable",
    "minecraft:physics",
    "minecraft:damage_sensor",
    "minecraft:conditional_bandwidth_optimization",
] as const;
type Key = (typeof KEYS)[number];

// What the vanilla definitions fix. A type not listed for a component is only printed.
const YES: Record<string, string[]> = {
    "minecraft:projectile": ["arrow", "snowball", "ender_pearl", "egg"],
    "minecraft:rideable": ["horse", "pig", "boat", "minecart"],
    "minecraft:shooter": ["skeleton", "snow_golem"],
    "minecraft:npc": ["npc"],
    "minecraft:physics": ["zombie", "cow"],
};
const NO: Record<string, string[]> = {
    "minecraft:projectile": ["zombie", "cow", "pig", "horse", "boat", "minecart", "skeleton", "snow_golem", "npc", "painting", "armor_stand", "iron_golem"],
    "minecraft:rideable": ["skeleton", "npc", "arrow", "snowball", "painting", "armor_stand", "iron_golem"],
    "minecraft:shooter": ["zombie", "cow", "pig", "horse", "boat", "arrow", "npc", "iron_golem", "painting"],
    "minecraft:npc": ["zombie", "cow", "horse", "arrow", "skeleton", "iron_golem", "pig"],
};

const TYPES = [
    "zombie", "cow", "pig", "horse", "boat", "minecart", "skeleton", "snow_golem", "npc", "arrow", "snowball", "ender_pearl", "egg",
    "painting", "armor_stand", "iron_golem", "villager_v2", "lightning_bolt", "xp_orb",
];

events.command.on(cmd => {
    if (!/^\/?compprobe\s*$/.test(cmd)) return;
    if (player === null) { say("compprobe", false, "no player"); return; }
    const spawned: Actor[] = [];
    try {
        run("gamemode creative @a");
        const before = new Set<string>();
        for (const e of bedrockServer.level.getEntities()) before.add(uid(e));

        const found = new Map<string, Actor>();
        let x = 20;
        for (const t of TYPES) {
            run(`summon ${t} ${x} 70 30`);
            x += 3;
            let hit: Actor | null = null;
            for (const e of bedrockServer.level.getEntities()) {
                if (before.has(uid(e))) continue;
                let id = "";
                try { id = e.getIdentifier(); } catch (err) { continue; }
                if (id === `minecraft:${t}`) { hit = e; break; }
            }
            for (const e of bedrockServer.level.getEntities()) before.add(uid(e)); // whatever came with it is not the next one
            if (hit === null) { say("spawn", null, `${t}: not found after summon`); continue; }
            found.set(t, hit);
            spawned.push(hit);
        }
        say("spawn", found.size >= 12, `${found.size}/${TYPES.length} entity types present: ${[...found.keys()].join(" ")}`);

        // the matrix
        const has: Record<string, Record<string, boolean>> = {};
        const ptrs: Record<string, Record<string, StaticPointer>> = {};
        for (const key of KEYS) { has[key] = {}; ptrs[key] = {}; }
        for (const [t, e] of found) {
            const cells: string[] = [];
            for (const key of KEYS) {
                let p: StaticPointer | null = null;
                try {
                    p = e.tryGetComponent(key as any) as any;
                } catch (err) {
                    say("tryGetComponent", false, `${t} ${key} threw ${(err as Error).message}`);
                }
                has[key][t] = p !== null && p !== undefined;
                if (has[key][t]) ptrs[key][t] = p as any;
                cells.push(`${key.slice(10, 14)}=${has[key][t] ? 1 : 0}`);
            }
            say("matrix", null, `${t.padEnd(12)} ${cells.join(" ")}`);
        }

        for (const key of KEYS) {
            const bad: string[] = [];
            let yes = 0, no = 0;
            for (const t of YES[key] ?? []) if (found.has(t)) { yes++; if (!has[key][t]) bad.push(`${t} should hold it`); }
            for (const t of NO[key] ?? []) if (found.has(t)) { no++; if (has[key][t]) bad.push(`${t} should not hold it`); }
            const present = Object.keys(has[key]).filter(t => has[key][t]);
            const absent = Object.keys(has[key]).filter(t => !has[key][t]);
            const both = present.length > 0 && absent.length > 0;
            // pointers: stable across two calls, distinct per entity, readable
            const seen = new Map<string, string>();
            const ptrBad: string[] = [];
            for (const t of present) {
                const again = found.get(t)!.tryGetComponent(key as any) as any as StaticPointer | null;
                const p = ptrs[key][t];
                if (again === null || addr(again) !== addr(p)) ptrBad.push(`${t} not stable`);
                const a = addr(p);
                if (seen.has(a) && key !== "minecraft:physics") ptrBad.push(`${t} shares ${a} with ${seen.get(a)}`);
                seen.set(a, t);
                try { p.getUint8(0); } catch (err) { ptrBad.push(`${t} unreadable`); }
            }
            const ok = bad.length === 0 && both && ptrBad.length === 0;
            say(key.slice(10), ok, `defined answers yes ${yes} no ${no}${bad.length ? " -- " + bad.join("; ") : ""}; present on ${present.length} (${present.join(",")}), absent on ${absent.length}${both ? "" : " -- ONE-SIDED"}${ptrBad.length ? "; pointers: " + ptrBad.join("; ") : ""}`);
        }

        // Rideable: the seat count is an int32 at +0 and the definitions fix it (pig 1, minecart 1, boat 2): a value
        // that is only right if the pointer, the stride and the offset all are. areSeatsFull is that count against
        // the passengers of the ride, both answers.
        {
            const seats: Record<string, number> = {};
            for (const t of Object.keys(ptrs["minecraft:rideable"])) seats[t] = ptrs["minecraft:rideable"][t].getInt32(0);
            say("rideable seats", seats.pig === 1 && seats.boat === 2 && seats.minecart === 1, `seat count at +0: ${JSON.stringify(seats)} (definitions: pig 1, minecart 1, boat 2)`);
            const pig = found.get("pig"), boat = found.get("boat"), zombie0 = found.get("zombie");
            if (pig && boat) {
                pig.addTag("bdsxcomp");
                boat.addTag("bdsxcomp");
                const rp = pig.tryGetComponent("minecraft:rideable") as any;
                const rb = boat.tryGetComponent("minecraft:rideable") as any;
                const emptyPig = rp.areSeatsFull(pig), emptyBoat = rb.areSeatsFull(boat);
                say("areSeatsFull empty", emptyPig === false && emptyBoat === false, `empty pig ${emptyPig}, empty boat ${emptyBoat}`);
                run("ride @a start_riding @e[tag=bdsxcomp,type=pig] teleport_rider");
                const onPig = player.getVehicle();
                const seated = onPig !== null && onPig.equalsptr(pig);
                if (!seated) say("areSeatsFull ridden", null, `the ride command did not seat the player on the pig (vehicle ${onPig === null ? "none" : onPig.getIdentifier()})`);
                else {
                    const full = rp.areSeatsFull(pig);
                    say("areSeatsFull ridden", full === true, `player on the pig (1 seat): ${full}`);
                }
                run("ride @a stop_riding");
                run("ride @a start_riding @e[tag=bdsxcomp,type=boat] teleport_rider");
                const onBoat = player.getVehicle();
                if (onBoat === null || !onBoat.equalsptr(boat)) say("areSeatsFull boat", null, `the ride command did not seat the player in the boat (vehicle ${onBoat === null ? "none" : onBoat.getIdentifier()})`);
                else {
                    const full = rb.areSeatsFull(boat);
                    say("areSeatsFull boat", full === false, `player in the boat (2 seats): ${full}`);
                }
                run("ride @a stop_riding");
                // a full ride: a zombie on the minecart (1 seat), then a zombie and a cow in the boat (2 seats)
                const cart = found.get("minecart"), cow = found.get("cow");
                if (cart && zombie0) {
                    cart.addTag("bdsxcomp"); zombie0.addTag("bdsxcomp");
                    const rc = cart.tryGetComponent("minecraft:rideable") as any;
                    const before = rc.areSeatsFull(cart);
                    run("ride @e[tag=bdsxcomp,type=zombie] start_riding @e[tag=bdsxcomp,type=minecart] teleport_rider");
                    const v = zombie0.getVehicle();
                    if (v === null || !v.equalsptr(cart)) say("areSeatsFull minecart", null, `the ride command did not seat the zombie on the minecart (vehicle ${v === null ? "none" : v.getIdentifier()}); empty was ${before}`);
                    else say("areSeatsFull minecart", before === false && rc.areSeatsFull(cart) === true, `empty ${before}, with a zombie on it (1 seat) ${rc.areSeatsFull(cart)}`);
                    run("ride @e[tag=bdsxcomp,type=zombie] stop_riding");
                }
                if (zombie0) {
                    // A fresh boat, so nothing that rode the first one is left in its passenger list. Passengers are counted
                    // the other way round (each rider's own vehicle, from PassengerComponent), a number the function under
                    // test does not read.
                    const known = new Set<string>();
                    for (const e of bedrockServer.level.getEntities()) known.add(uid(e));
                    run("summon boat 20 70 36");
                    let boat2: Actor | null = null;
                    for (const e of bedrockServer.level.getEntities()) {
                        try { if (!known.has(uid(e)) && e.getIdentifier() === "minecraft:boat") { boat2 = e; break; } } catch (err) { /* mid-removal */ }
                    }
                    if (boat2 === null) say("areSeatsFull boat riders", null, "no second boat");
                    else {
                        spawned.push(boat2);
                        boat2.addTag("bdsxcomp2");
                        const b2 = boat2;
                        const riders = (): number => {
                            let n = 0;
                            const pv = player!.getVehicle(); // level.getEntities() does not list players
                            if (pv !== null && pv.equalsptr(b2)) n++;
                            const zv = zombie0.getVehicle();
                            if (zv !== null && zv.equalsptr(b2)) n++;
                            return n;
                        };
                        const rb2 = b2.tryGetComponent("minecraft:rideable") as any;
                        const c0 = riders(), f0 = rb2.areSeatsFull(b2);
                        run("ride @a start_riding @e[tag=bdsxcomp2,type=boat] teleport_rider");
                        const c1 = riders(), f1 = rb2.areSeatsFull(b2);
                        run("ride @e[tag=bdsxcomp,type=zombie] start_riding @e[tag=bdsxcomp2,type=boat] teleport_rider");
                        const c2 = riders(), f2 = rb2.areSeatsFull(b2);
                        say("areSeatsFull boat riders", c0 === 0 && c1 === 1 && c2 === 2 && f0 === false && f1 === false && f2 === true, `fresh boat, 2 seats; riders counted by vehicle ${c0}/${c1}/${c2} -> areSeatsFull ${f0}/${f1}/${f2} (wanted false/false/true)`);
                        run("ride @a stop_riding");
                        run("ride @e[tag=bdsxcomp,type=zombie] stop_riding");
                    }
                }
            }
        }

        // members
        const arrow = found.get("arrow"), zombie = found.get("zombie");
        if (arrow && zombie) {
            const pc = arrow.tryGetComponent("minecraft:projectile");
            if (pc === null) say("setOwnerId", false, "arrow has no projectile component");
            else {
                const id = zombie.getUniqueIdBin();
                (pc as any).setOwnerId(id);
                const back = (pc as any as StaticPointer).getBin64(8);
                const hex = (b: string): string => Buffer.from(b, "latin1").toString("hex");
                say("setOwnerId", back === id, `wrote the zombie's unique id 0x${hex(id)}, component +8 reads 0x${hex(back)}`);
            }
        }
        if (zombie) {
            const ph = zombie.tryGetComponent("minecraft:physics");
            if (ph === null) say("setHasCollision", false, "zombie has no physics component");
            else {
                const start = zombie.getStatusFlag(ActorFlags.HasCollision);
                (ph as any).setHasCollision(zombie, false);
                const off = zombie.getStatusFlag(ActorFlags.HasCollision);
                (ph as any).setHasCollision(zombie, true);
                const on = zombie.getStatusFlag(ActorFlags.HasCollision);
                say("setHasCollision", start === true && off === false && on === true, `zombie HasCollision before ${start}, after setHasCollision(false) ${off}, after (true) ${on}`);
            }
        }
        if (zombie) {
            // setAffectedByGravity is the tail of the engine's own setActorFlag over the two component pointers; the
            // engine's path (setStatusFlag) and bdsx's must leave the flag word and the dirty bit the same
            const ph = zombie.tryGetComponent("minecraft:physics") as any;
            const flags = enttComponent(zombie, componentHash("ActorDataFlagComponent"), 24);
            const dirty = enttComponent(zombie, componentHash("ActorDataDirtyFlagsComponent"), 24);
            if (ph === null || flags === null || dirty === null) say("setAffectedByGravity", false, `components: physics ${ph !== null} flags ${flags !== null} dirty ${dirty !== null}`);
            else {
                const word = (): string => `${flags.getUint32(4).toString(16).padStart(8, "0")}${flags.getUint32(0).toString(16).padStart(8, "0")}`;
                const g = (): boolean => zombie.getStatusFlag(ActorFlags.HasGravity);
                const start = g(), startWord = word();
                zombie.setStatusFlag(ActorFlags.HasGravity, false); // the engine
                const engOff = g(), engOffWord = word();
                zombie.setStatusFlag(ActorFlags.HasGravity, true);
                const engOn = g(), engOnWord = word();
                dirty.setUint8(dirty.getUint8(0) & ~1, 0);
                ph.setAffectedByGravity(flags, dirty, false); // bdsx
                const myOff = g(), myOffWord = word(), myDirty = (dirty.getUint8(0) & 1) !== 0;
                ph.setAffectedByGravity(flags, dirty, true);
                const myOn = g(), myOnWord = word();
                ph.setAffectedByGravity(flags, dirty, true); // no change: must not disturb anything
                const same = word() === myOnWord;
                const ok = start === true && engOff === false && engOn === true && myOff === false && myOn === true && engOffWord === myOffWord && engOnWord === myOnWord && startWord === myOnWord && myDirty && same;
                say("setAffectedByGravity", ok, `HasGravity=${ActorFlags.HasGravity}; zombie start ${start}; engine off ${engOff} on ${engOn}; bdsx off ${myOff} on ${myOn}; flag word engine-off ${engOffWord} bdsx-off ${myOffWord}, engine-on ${engOnWord} bdsx-on ${myOnWord}; dirty bit set by bdsx ${myDirty}`);
            }
        }
    } catch (err) {
        say("compprobe", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    } finally {
        for (const e of spawned) {
            try { e.remove(); } catch (err) { /* already gone */ }
        }
        try { run("kill @e[type=!player,x=18,y=60,z=27,dx=64,dy=30,dz=8]"); } catch (err) { /* nothing */ }
        run("gamemode survival @a");
        console.log(`${TAG} INFO compprobe done`);
    }
});

// ---- pushprobe -------------------------------------------------------------------------------------------------
// The vanilla packs (inst40 behavior_packs/vanilla*/entities, the newest version of each file) fix the answers. 1.26
// packs name the two components directly ("minecraft:pushable_by_entity" / "minecraft:pushable_by_block"); older files
// still carry "minecraft:pushable" {is_pushable, is_pushable_by_piston}, which the engine maps onto the pair.
//   both:        zombie pig cow boat minecart iron_golem (1.26 files, both keys); snowball (pushable true/true);
//                camel while standing (the keys sit in its camel_standing group)
//   block only:  arrow (1.26.40, by_block only), armor_stand and xp_orb (pushable false/true), and the player
//   neither:     shulker bat vex npc lightning_bolt area_effect_cloud (no key at all)
const PUSH_BOTH = ["zombie", "pig", "cow", "boat", "minecart", "iron_golem", "snowball", "camel"];
const PUSH_BLOCK_ONLY = ["armor_stand", "arrow", "xp_orb"];
const PUSH_NEITHER = ["shulker", "bat", "vex", "npc", "lightning_bolt", "area_effect_cloud"];
const PTAG = "[push]";
function psay(label: string, ok: boolean | null, detail: string): void {
    console.log(`${PTAG} ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
// the state vector (Actor+536 on both builds, docs/findings-layouts.md "The state vector"): pos +0, pos_prev +12, pos_delta +24
function posDelta(a: Actor): [number, number, number] {
    const sv = (a as any as StaticPointer).getPointer(536);
    return [sv.getFloat32(24), sv.getFloat32(28), sv.getFloat32(32)];
}
function fmt(v: number[]): string {
    return `(${v.map(n => n.toFixed(4)).join(", ")})`;
}
function summonOne(type: string, x: number, y: number, z: number): Actor | null {
    const known = new Set<string>();
    for (const e of bedrockServer.level.getEntities()) known.add(uid(e));
    run(`summon ${type} ${x} ${y} ${z}`);
    for (const e of bedrockServer.level.getEntities()) {
        if (known.has(uid(e))) continue;
        try { if (e.getIdentifier() === `minecraft:${type}`) return e; } catch (err) { /* mid-removal */ }
    }
    return null;
}

// Three console commands, 8 s apart in the driver: what the engine applies on a later tick (a component group
// swapped by an `event`, a freshly summoned mob's first push) is read one command later.
const pushSpawned: Actor[] = [];
let pushCamel: Actor | null = null;
let pushPairs: [Actor, Actor][] = [];
const show = (v: [boolean, boolean]): string => `${v[0] ? 1 : 0}${v[1] ? 1 : 0}`;
const answer = (a: Actor): [boolean, boolean] => [a.tryGetComponent("minecraft:pushable_by_entity") !== null, a.tryGetComponent("minecraft:pushable_by_block") !== null];
function xz(a: Actor): [number, number] {
    const p = a.getPosition();
    return [p.x, p.z]; // copied out now: the Vec3 may be a shared return buffer
}

events.command.on(cmd => {
    const m = /^\/?pushprobe([23]?)\s*$/.exec(cmd);
    if (m === null) return;
    const phase = m[1] === "" ? 1 : Number(m[1]);
    if (player === null) { psay(`pushprobe${m[1]}`, false, "no player"); return; }
    try {
        if (phase === 1) {
            run("gamemode creative @a");
            const found = new Map<string, Actor>();
            let x = 12;
            for (const t of [...PUSH_BOTH, ...PUSH_BLOCK_ONLY, ...PUSH_NEITHER]) {
                const e = summonOne(t, x, 70, 36);
                x += 3;
                if (e === null) { psay("spawn", null, `${t}: not found after summon`); continue; }
                found.set(t, e);
                pushSpawned.push(e);
            }
            const bad: string[] = [];
            const rows: string[] = [];
            const check = (t: string, a: Actor, wantEntity: boolean, wantBlock: boolean): void => {
                const [e, b] = answer(a);
                rows.push(`${t} ${e ? 1 : 0}${b ? 1 : 0}`);
                if (e !== wantEntity || b !== wantBlock) bad.push(`${t} entity ${e} block ${b} (wanted ${wantEntity} ${wantBlock})`);
            };
            for (const t of PUSH_BOTH) if (found.has(t)) check(t, found.get(t)!, true, true);
            for (const t of PUSH_BLOCK_ONLY) if (found.has(t)) check(t, found.get(t)!, false, true);
            for (const t of PUSH_NEITHER) if (found.has(t)) check(t, found.get(t)!, false, false);
            check("player", player, false, true);
            psay("matrix", null, `type entity|block: ${rows.join(" ")}`);
            const groups = [PUSH_BOTH, PUSH_BLOCK_ONLY, PUSH_NEITHER].map(g => g.filter(t => found.has(t)).length);
            psay("pushable_by_entity/by_block against the packs", bad.length === 0 && groups.every(n => n >= 2), `both ${groups[0]}, block only ${groups[1] + 1} (with the player), neither ${groups[2]}${bad.length ? " -- " + bad.join("; ") : ""}`);

            // pointers: the entity component is a per-entity element, stable and readable over its 0x28 bytes;
            // the block tag is one shared stand-in
            const ptrBad: string[] = [];
            const seen = new Map<string, string>();
            for (const t of PUSH_BOTH) {
                const a = found.get(t);
                if (!a) continue;
                const p = a.tryGetComponent("minecraft:pushable_by_entity") as any as StaticPointer | null;
                const q = a.tryGetComponent("minecraft:pushable_by_entity") as any as StaticPointer | null;
                if (p === null || q === null) continue;
                if (addr(p) !== addr(q)) ptrBad.push(`${t} not stable`);
                if (seen.has(addr(p))) ptrBad.push(`${t} shares ${addr(p)} with ${seen.get(addr(p))}`);
                seen.set(addr(p), t);
                try { for (let i = 0; i < 0x28; i += 8) p.getBin64(i); } catch (err) { ptrBad.push(`${t} unreadable`); }
            }
            psay("pushable_by_entity pointers", ptrBad.length === 0 && seen.size >= 2, `${seen.size} distinct, stable, 0x28 bytes readable${ptrBad.length ? " -- " + ptrBad.join("; ") : ""}`);

            // push(actor, vec): the engine adds vec to the actor's posDelta (the same tick, nothing else runs in between)
            const z1 = summonOne("zombie", 20.5, 70, 44.5);
            if (z1 === null) psay("push(vec)", false, "no zombie");
            else {
                pushSpawned.push(z1);
                const pc = z1.tryGetComponent("minecraft:pushable_by_entity");
                if (pc === null) psay("push(vec)", false, "zombie holds no PushableByEntityComponent");
                else {
                    const before = posDelta(z1);
                    pc.push(z1, Vec3.create(0.25, 0.5, -0.125));
                    const after = posDelta(z1);
                    const d = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];
                    const ok = Math.abs(d[0] - 0.25) < 1e-6 && Math.abs(d[1] - 0.5) < 1e-6 && Math.abs(d[2] + 0.125) < 1e-6;
                    psay("push(vec)", ok, `zombie posDelta ${fmt(before)} -> ${fmt(after)}, change ${fmt(d)} (pushed (0.25, 0.5, -0.125))`);
                    const before0 = posDelta(z1);
                    pc.push(z1, Vec3.create(0, 0, 0));
                    const after0 = posDelta(z1);
                    psay("push(vec) zero", before0.every((v, i) => v === after0[i]), `a zero vector leaves posDelta ${fmt(before0)} -> ${fmt(after0)}`);
                }
            }

            // for phase 2: pig pairs at several spacings per pushSelfOnly value, frozen in place. The 1.26 body only pushes
            // inside a distance window its rule decides (min at rule+0x48, max at +0x4c; 40 0x2cf2116-0x2cf2142): pigs
            // 0.05 apart and 12 apart were both left alone, 3.6 apart were pushed.
            pushPairs = [];
            const spacings = [0.4, 0.8, 1.5, 2.5];
            [false, true].forEach((selfOnly, k) => {
                spacings.forEach((d, j) => {
                    const px = 24.5 + j * 8, pz = 40.5 + k * 5;
                    const a = summonOne("pig", px, 70, pz);
                    const b = summonOne("pig", px + d, 70, pz);
                    if (a !== null) { pushSpawned.push(a); a.addTag("bdsxpair"); }
                    if (b !== null) { pushSpawned.push(b); b.addTag("bdsxpair"); }
                    if (a !== null && b !== null) pushPairs.push([a, b]);
                });
            });
            run("effect @e[tag=bdsxpair] slowness 60 255 true");
            pushCamel = found.get("camel") ?? null;
            if (pushCamel !== null) {
                pushCamel.addTag("bdsxpush");
                psay("camel standing", show(answer(pushCamel)) === "11", `entity|block ${show(answer(pushCamel))} before start_sitting_adult (wanted 11)`);
                run("event entity @e[tag=bdsxpush,type=camel] minecraft:start_sitting_adult");
            }
        } else if (phase === 2) {
            // one entity, both answers: the camel's pushable_by_entity lives in its camel_standing group, and
            // start_sitting_adult swapped that group for camel_sitting (pushable_by_block only)
            if (pushCamel === null) psay("camel sitting", false, "no camel");
            else {
                psay("camel sitting", show(answer(pushCamel)) === "01", `entity|block ${show(answer(pushCamel))} after start_sitting_adult (wanted 01)`);
                run("event entity @e[tag=bdsxpush,type=camel] minecraft:stop_sitting_adult");
            }
            // push(owner, other, pushSelfOnly): wherever the owner is pushed it must move away from the other, the other
            // away from the owner exactly when pushSelfOnly is false (2024 skipped the second push on true, and so does the
            // 1.26 body); a pair outside the rule's distance window is left alone (reported, not judged)
            const half = pushPairs.length / 2;
            if (pushPairs.length < 4) psay("push(actor)", false, `${pushPairs.length} pig pairs`);
            for (const selfOnly of [false, true]) {
                const rows: string[] = [];
                let pushed = 0, wrong = 0;
                pushPairs.slice(selfOnly ? half : 0, selfOnly ? pushPairs.length : half).forEach(([a, b], j) => {
                    const pc = a.tryGetComponent("minecraft:pushable_by_entity");
                    if (pc === null) { rows.push("no component"); wrong++; return; }
                    // the first two pairs are made to overlap (pigs are 0.9 wide): the engine had already pushed them
                    // apart to about 0.95 by now, and a rule may push only overlapping boxes
                    if (j < 2) {
                        const p = a.getPosition();
                        b.teleport(Vec3.create(p.x + 0.3, p.y, p.z));
                    }
                    const [ax, az] = xz(a), [bx, bz] = xz(b);
                    const dist = Math.hypot(ax - bx, az - bz);
                    const a0 = posDelta(a), b0 = posDelta(b);
                    pc.push(a, b, selfOnly);
                    const a1 = posDelta(a), b1 = posDelta(b);
                    const ua = (a1[0] - a0[0]) * (ax - bx) + (a1[2] - a0[2]) * (az - bz);
                    const ub = (b1[0] - b0[0]) * (bx - ax) + (b1[2] - b0[2]) * (bz - az);
                    const aMoved = a1.some((v, i) => v !== a0[i]), bMoved = b1.some((v, i) => v !== b0[i]);
                    let verdict: string;
                    if (!aMoved && !bMoved) verdict = "left alone";
                    else {
                        pushed++;
                        const ok = ua > 0 && (selfOnly ? !bMoved : ub > 0);
                        if (!ok) wrong++;
                        verdict = ok ? "ok" : "WRONG";
                    }
                    rows.push(`d=${dist.toFixed(2)} owner ${ua.toFixed(4)} other ${bMoved ? ub.toFixed(4) : "unchanged"} ${verdict}`);
                });
                psay(`push(actor) selfOnly=${selfOnly}`, pushed > 0 && wrong === 0, `${pushed} of ${rows.length} pairs pushed, ${wrong} wrong (owner along owner-other > 0, other along other-owner ${selfOnly ? "unchanged" : "> 0"}): ${rows.join("; ")}`);
            }
        } else {
            if (pushCamel === null) psay("camel standing again", false, "no camel");
            // INFO only: the 1.26.51 pack on the host has no readable camel.json, so what its stop_sitting_adult does is
            // not known; the both-answers check is the standing -> sitting pair above
            else psay("camel standing again", null, `entity|block ${show(answer(pushCamel))} after stop_sitting_adult (the 1.26.30 pack's group swap gives 11)`);
        }
    } catch (err) {
        psay(`pushprobe${m[1]}`, false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    } finally {
        if (phase === 3) {
            for (const e of pushSpawned) {
                try { e.remove(); } catch (err) { /* already gone */ }
            }
            pushSpawned.length = 0;
            try { run("kill @e[type=!player,x=10,y=60,z=34,dx=56,dy=30,dz=14]"); } catch (err) { /* nothing */ }
            run("gamemode survival @a");
        }
        console.log(`${PTAG} INFO pushprobe${m[1]} done`);
    }
});

// ---- The component leftovers (2026-09-30): DamageSensorComponent.isFatal, RideableComponent.pullInEntity,
// ShooterComponent.shootProjectile. Tag [comp2]. Each command summons its own pen and removes it again.
const T2 = "[comp2]";
function say2(label: string, ok: boolean | null, detail: string): void {
    console.log(`${T2} ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
function cleanup2(list: Actor[]): void {
    for (const e of list) {
        try { e.remove(); } catch (err) { /* already gone */ }
    }
    list.length = 0;
}

// dsprobe: the byte at DamageSensorComponent+4. An iron golem (100 health) takes a small hit and stays alive:
// not fatal. A pig takes a hit far above its health: fatal. Both answers, and the raw ints around it.
events.command.on(cmd => {
    if (!/^\/?dsprobe\s*$/.test(cmd)) return;
    if (player === null) { say2("dsprobe", false, "no player"); return; }
    const pen: Actor[] = [];
    try {
        run("gamemode survival @a");
        const raw = (p: any): string => `+0 ${p.getInt32(0)} +4 ${p.getUint8(4)} +8 ${p.getInt32(8)}`;
        const golem = summonOne("iron_golem", 30, 70, 50);
        const pig = summonOne("pig", 34, 70, 50);
        if (golem === null || pig === null) { say2("spawn", false, `golem ${golem !== null} pig ${pig !== null}`); return; }
        pen.push(golem, pig);
        golem.addTag("bdsxds");
        pig.addTag("bdsxds");
        const gc = golem.tryGetComponent("minecraft:damage_sensor") as any;
        const pc = pig.tryGetComponent("minecraft:damage_sensor") as any;
        if (gc === null || pc === null) { say2("component", false, `golem ${gc !== null} pig ${pc !== null}`); return; }
        say2("fresh", null, `golem ${raw(gc)}; pig ${raw(pc)}; isFatal golem ${gc.isFatal()} pig ${pc.isFatal()}`);
        const g0 = gc.isFatal(), p0 = pc.isFatal();
        run("damage @e[tag=bdsxds,type=iron_golem] 5 entity_attack");
        const g1 = gc.isFatal();
        say2("golem hit 5", null, `golem ${raw(gc)} isFatal ${g1}; health ${golem.getHealth()}`);
        run("damage @e[tag=bdsxds,type=pig] 1000 entity_attack");
        const p1 = pc.isFatal();
        say2("pig hit 1000", null, `pig ${raw(pc)} isFatal ${p1}`);
        say2("isFatal", g0 === false && p0 === false && g1 === false && p1 === true, `fresh golem ${g0}, fresh pig ${p0}, golem after 5 damage ${g1} (want false), pig after a lethal hit ${p1} (want true)`);
    } catch (err) {
        say2("dsprobe", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    } finally {
        cleanup2(pen);
        try { run("kill @e[tag=bdsxds]"); } catch (err) { /* nothing */ }
        console.log(`${T2} INFO dsprobe done`);
    }
});

// pullprobe: pullInEntity(ride, rider). A minecart's rideable definition has pull_in_entities true, a pig's has it
// false (the flag byte at +0x58 is printed): the zombie is pulled into the cart (returns true, its vehicle is the cart)
// and left alone by the pig (false, no vehicle). A rider already on the cart is refused a second time.
events.command.on(cmd => {
    if (!/^\/?pullprobe\s*$/.test(cmd)) return;
    if (player === null) { say2("pullprobe", false, "no player"); return; }
    const pen: Actor[] = [];
    try {
        run("gamemode creative @a");
        const cart = summonOne("minecart", 30, 70, 60);
        const pig = summonOne("pig", 36, 70, 60);
        const z1 = summonOne("zombie", 31, 70, 60);
        const z2 = summonOne("zombie", 37, 70, 60);
        if (cart === null || pig === null || z1 === null || z2 === null) { say2("spawn", false, `cart ${cart !== null} pig ${pig !== null} z1 ${z1 !== null} z2 ${z2 !== null}`); return; }
        pen.push(cart, pig, z1, z2);
        const rc = cart.tryGetComponent("minecraft:rideable") as any;
        const rp = pig.tryGetComponent("minecraft:rideable") as any;
        if (rc === null || rp === null) { say2("component", false, `cart ${rc !== null} pig ${rp !== null}`); return; }
        say2("flags", null, `cart pull flag +0x58 ${rc.getUint8(0x58)} float +0x5c ${rc.getFloat32(0x5c)}; pig pull flag ${rp.getUint8(0x58)} float ${rp.getFloat32(0x5c)}`);
        const before1 = z1.getVehicle();
        const r1 = rc.pullInEntity(cart, z1);
        const v1 = z1.getVehicle();
        say2("pull into the cart", r1 === true && v1 !== null && v1.equalsptr(cart) && before1 === null, `returned ${r1}, vehicle before ${before1 === null ? "none" : before1.getIdentifier()}, after ${v1 === null ? "none" : v1.getIdentifier()}`);
        const r1b = rc.pullInEntity(cart, z1);
        say2("pull again", r1b === false, `a rider already on the cart: returned ${r1b}`);
        const r2 = rp.pullInEntity(pig, z2);
        const v2 = z2.getVehicle();
        say2("pig refuses", r2 === false && v2 === null, `pull_in_entities false: returned ${r2}, vehicle ${v2 === null ? "none" : v2.getIdentifier()}`);
    } catch (err) {
        say2("pullprobe", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    } finally {
        cleanup2(pen);
        run("gamemode survival @a");
        console.log(`${T2} INFO pullprobe done`);
    }
});

// shootprobe: _shootProjectile(owner, definition, int). A snow golem and a skeleton each shoot what the call names, and
// the projectile that appears is that type; its ProjectileComponent owner id (+8) is the shooter's. Called with a boat as
// the owner (not a Mob: the body's first test) nothing appears.
events.command.on(cmd => {
    if (!/^\/?shootprobe\s*$/.test(cmd)) return;
    if (player === null) { say2("shootprobe", false, "no player"); return; }
    const pen: Actor[] = [];
    try {
        run("gamemode creative @a");
        const golem = summonOne("snow_golem", 30, 70, 70);
        const skel = summonOne("skeleton", 36, 70, 70);
        const boat = summonOne("boat", 42, 70, 70);
        if (golem === null || skel === null || boat === null) { say2("spawn", false, `golem ${golem !== null} skeleton ${skel !== null} boat ${boat !== null}`); return; }
        pen.push(golem, skel, boat);
        const fired = (owner: Actor, comp: any, projectile: string): { made: Actor[]; ownerOk: boolean | null } => {
            const known = new Set<string>();
            for (const e of bedrockServer.level.getEntities()) known.add(uid(e));
            const defi = ActorDefinitionIdentifier.constructWith(projectile);
            try { comp.shootProjectile(owner, defi, 0); } finally { defi.destruct(); }
            const made: Actor[] = [];
            for (const e of bedrockServer.level.getEntities()) {
                if (known.has(uid(e))) continue;
                let id = "";
                try { id = e.getIdentifier(); } catch (err) { continue; }
                if (id === projectile) made.push(e);
            }
            let ownerOk: boolean | null = null;
            if (made.length > 0) {
                const pcomp = made[0].tryGetComponent("minecraft:projectile") as any;
                if (pcomp !== null) ownerOk = String(pcomp.getBin64(8)) === String(owner.getUniqueIdBin());
            }
            return { made, ownerOk };
        };
        const gc = golem.tryGetComponent("minecraft:shooter") as any;
        const sc = skel.tryGetComponent("minecraft:shooter") as any;
        if (gc === null || sc === null) { say2("component", false, `golem ${gc !== null} skeleton ${sc !== null}`); return; }
        say2("power", null, `golem +0 ${gc.getFloat32(0)}, skeleton +0 ${sc.getFloat32(0)}`);
        const a = fired(golem, gc, "minecraft:snowball");
        pen.push(...a.made);
        say2("snow golem shoots a snowball", a.made.length === 1, `${a.made.length} minecraft:snowball appeared; owner id ${a.ownerOk === null ? "unread" : a.ownerOk ? "the golem's" : "NOT the golem's"}`);
        const b = fired(skel, sc, "minecraft:arrow");
        pen.push(...b.made);
        say2("skeleton shoots an arrow", b.made.length === 1, `${b.made.length} minecraft:arrow appeared; owner id ${b.ownerOk === null ? "unread" : b.ownerOk ? "the skeleton's" : "NOT the skeleton's"}`);
        say2("owner id", a.ownerOk === true && b.ownerOk === true, `projectile owner is the shooter: golem ${a.ownerOk}, skeleton ${b.ownerOk}`);
        const c = fired(boat, gc, "minecraft:snowball");
        pen.push(...c.made);
        say2("a boat cannot shoot", c.made.length === 0, `${c.made.length} snowballs appeared for a non-Mob owner (want 0)`);
    } catch (err) {
        say2("shootprobe", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    } finally {
        cleanup2(pen);
        run("gamemode survival @a");
        try { run("kill @e[type=!player,x=28,y=60,z=68,dx=20,dy=30,dz=6]"); } catch (err) { /* nothing */ }
        console.log(`${T2} INFO shootprobe done`);
    }
});

// ---- nameEntity (2026-09-30, agent-h). Tag [comp2].
// nameprobe: NameableComponent::nameEntity(actor, name). A vanilla vindicator's "minecraft:nameable" has a default_trigger
// (minecraft:stop_johnny) and one name action (name_filter "Johnny" -> minecraft:start_johnny, which adds the component
// group minecraft:vindicator_johnny). The engine's own save() lists the active groups in "definitions", so the name_actions
// loop is read back: "Johnny" puts +minecraft:vindicator_johnny in, any other name takes it out again (default_trigger).
// The name tag, the CanShowName flag and the persistent flag component are read as well. A pig has no name action: the
// tag is set and nothing else changes.
function defs(a: Actor): string[] {
    const s = a.save() as any;
    const d = s.definitions;
    const arr: any[] = Array.isArray(d) ? d : d !== undefined && d !== null && Array.isArray(d._value) ? d._value : [];
    return arr.map(x => (typeof x === "string" ? x : x !== null && typeof x === "object" && "_value" in x ? String(x._value) : String(x)));
}
events.command.on(cmd => {
    if (!/^\/?nameprobe\s*$/.test(cmd)) return;
    if (player === null) { say2("nameprobe", false, "no player"); return; }
    const pen: Actor[] = [];
    try {
        run("gamemode creative @a");
        const v = summonOne("vindicator", 30, 70, 62);
        const v2 = summonOne("vindicator", 36, 70, 62);
        const pig = summonOne("pig", 42, 70, 62);
        if (v === null || v2 === null || pig === null) { say2("spawn", false, `v ${v !== null} v2 ${v2 !== null} pig ${pig !== null}`); return; }
        pen.push(v, v2, pig);
        const cv = v.tryGetComponent("minecraft:nameable") as any;
        const cv2 = v2.tryGetComponent("minecraft:nameable") as any;
        const cp = pig.tryGetComponent("minecraft:nameable") as any;
        if (cv === null || cv2 === null || cp === null) { say2("component", false, `v ${cv !== null} v2 ${cv2 !== null} pig ${cp !== null}`); return; }
        const johnny = (a: Actor): boolean => defs(a).includes("+minecraft:vindicator_johnny");
        say2("before", null, `v defs ${JSON.stringify(defs(v))} tag "${v.getNameTag()}" canShow ${v.getStatusFlag(ActorFlags.CanShowName)}; pig tag "${pig.getNameTag()}" canShow ${pig.getStatusFlag(ActorFlags.CanShowName)}`);
        const j0 = johnny(v), j0b = johnny(v2);
        say2("starts plain", j0 === false && j0b === false && v.getNameTag() === "" && pig.getNameTag() === "", `johnny group: v ${j0}, v2 ${j0b}; names "${v.getNameTag()}" "${pig.getNameTag()}"`);
        // 1. a name with no action: the tag is set, the group stays out
        v2.setNameTag("Pre");
        say2("setNameTag first", v2.getNameTag() === "Pre", `tag "${v2.getNameTag()}"`);
        v2.setNameTag("");
        console.log(`${T2} INFO calling nameEntity: component ${cv2} actor ${v2}`);
        cv2.nameEntity(v2, "Bob");
        const b1 = johnny(v2);
        say2("Bob: tag", v2.getNameTag() === "Bob" && v2.getStatusFlag(ActorFlags.CanShowName) === true, `tag "${v2.getNameTag()}" canShow ${v2.getStatusFlag(ActorFlags.CanShowName)}`);
        say2("Bob: no johnny", b1 === false, `defs ${JSON.stringify(defs(v2))}`);
        // 2. "Johnny": the name action fires start_johnny
        cv.nameEntity(v, "Johnny");
        const j1 = johnny(v);
        say2("Johnny: tag", v.getNameTag() === "Johnny", `tag "${v.getNameTag()}" canShow ${v.getStatusFlag(ActorFlags.CanShowName)}`);
        say2("Johnny: name action", j1 === true, `defs ${JSON.stringify(defs(v))}`);
        // 3. renaming to another name: the default trigger (stop_johnny) removes the group again
        cv.nameEntity(v, "Jack");
        const j2 = johnny(v);
        say2("Jack: default trigger", v.getNameTag() === "Jack" && j2 === false, `tag "${v.getNameTag()}" johnny ${j2} defs ${JSON.stringify(defs(v))}`);
        // 4. a mob with the component and no action list
        cp.nameEntity(pig, "Piggy");
        say2("pig: tag", pig.getNameTag() === "Piggy" && pig.getStatusFlag(ActorFlags.CanShowName) === true, `tag "${pig.getNameTag()}" canShow ${pig.getStatusFlag(ActorFlags.CanShowName)}`);
        // 5. persistence: the saved NBT of a named mob against an unnamed one
        const u = summonOne("pig", 48, 70, 62);
        if (u !== null) {
            pen.push(u);
            const sn = JSON.stringify(pig.save()), su = JSON.stringify(u.save());
            const has = (s: string): boolean => /"Persistent(Flag)?"|"persistent"/i.test(s);
            const pv = (a: Actor): string => JSON.stringify((a.save() as any).Persistent);
            say2("persistent", null, `Persistent tag: named pig ${pv(pig)}, unnamed pig ${pv(u)}; keys with "pers": ${Object.keys(pig.save()).filter(k => /pers/i.test(k)).join(",")} (has ${has(sn)}/${has(su)})`);
        }
        // 6. and back to Johnny once more, on the second vindicator, so both sides of the group are seen on two mobs
        cv2.nameEntity(v2, "Johnny");
        say2("Johnny on v2", johnny(v2) === true, `defs ${JSON.stringify(defs(v2))}`);
    } catch (err) {
        say2("nameprobe", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    } finally {
        cleanup2(pen);
        run("gamemode survival @a");
        try { run("kill @e[type=!player,x=28,y=60,z=60,dx=24,dy=30,dz=6]"); } catch (err) { /* nothing */ }
        console.log(`${T2} INFO nameprobe done`);
    }
});
