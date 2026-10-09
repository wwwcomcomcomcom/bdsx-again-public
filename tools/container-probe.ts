/**
 * "contprobe": ContainerComponent on 1.26 (docs/findings-containers.md section 23).
 *
 * The component is an EnTT element (hash fnv1a "ContainerComponent", stride 0x200 on both builds) whose Container sits
 * at +0x10, the way 2024's did. Entities work at a spot away from the other probes (x=2000, z=-2000, y from the
 * player's own height), and everything is cleaned up by `contprobe clean`.
 *
 *   contprobe setup     kill leftovers, summon a chest minecart, a hopper minecart and a pig next to the player
 *   contprobe lookup    tryGetComponent("minecraft:container"): non-null for both minecarts, null for the pig;
 *                       getEmptySlotsCount and getSlots on the still-empty containers (27 and 5 slots)
 *   contprobe fill      addItem puts diamond x3 into slot 0 and apple x2 into slot 1 of the chest minecart;
 *                       bdsx reads it back through getSlots and getEmptySlotsCount
 *   contprobe add       addItem(stack): an apple merges into slot 1, bread takes a fresh slot (empty count stays 25, then 24)
 *   contprobe addn      addItem(stack, face, count): count is the number that moves, the source keeps the rest
 *   contprobe actor/actor2  addItem(ItemActor): a dropped item entity goes into the container and is removed; an empty one is refused
 *   contprobe clean     kill the test entities
 */
import { Actor, ItemActor } from "bdsx/bds/actor";
import { ContainerComponent } from "bdsx/bds/components";
import { ItemStack } from "bdsx/bds/inventory";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { BlockActor, BlockActorType, ChestBlockActor } from "bdsx/bds/block";
import { BlockPos } from "bdsx/bds/blockpos";
import { blockActorHasCustomName } from "bdsx/bds/engine/blockactor";
import { CHEST_OPEN_BY_SLOT } from "bdsx/bds/engine/chest";
import { Player } from "bdsx/bds/player";
import { NativePointer, StaticPointer, VoidPointer } from "bdsx/core";
import { makefunc } from "bdsx/makefunc";
import { void_t } from "bdsx/nativetype";
import { ProcHacker } from "bdsx/prochacker";

const TAG = "[contprobe]";
const AREA = "x=1900,y=-64,z=-2100,dx=200,dy=500,dz=200";
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail: string): void {
    if (ok) pass++;
    else fail++;
    console.log(`${TAG} ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function find(id: string): Actor | null {
    for (const e of bedrockServer.level.getEntities()) {
        try {
            if (e.getIdentifier() !== id) continue;
            const p = e.getPosition();
            if (Math.abs(p.x - 2000) < 100 && Math.abs(p.z + 2000) < 100) return e;
        } catch (err) {
            /* an entity mid-removal can throw reading its own fields */
        }
    }
    return null;
}

function names(c: ContainerComponent): string {
    return c
        .getSlots()
        .toArray()
        .map(s => (s.isNull() ? "-" : `${s.getName()}x${s.getAmount()}`))
        .join(",");
}

function chest(): ContainerComponent | null {
    const e = find("minecraft:chest_minecart");
    return e === null ? null : e.tryGetComponent("minecraft:container");
}

events.command.on(cmd => {
    const m = /^\/?contprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    try {
        if (step === "setup") {
            bedrockServer.executeCommand(`kill @e[type=chest_minecart,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=hopper_minecart,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=pig,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=minecart,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=armor_stand,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=item,${AREA}]`);
            bedrockServer.executeCommand("execute as @a at @s run summon chest_minecart ~3 ~ ~");
            bedrockServer.executeCommand("execute as @a at @s run summon hopper_minecart ~6 ~ ~");
            bedrockServer.executeCommand("execute as @a at @s run summon pig ~9 ~ ~");
            bedrockServer.executeCommand("execute as @a at @s run summon minecart ~12 ~ ~");
            bedrockServer.executeCommand("execute as @a at @s run summon armor_stand ~15 ~ ~");
            console.log(`${TAG} INFO summoned`);
        } else if (step === "lookup") {
            const cm = find("minecraft:chest_minecart");
            const hm = find("minecraft:hopper_minecart");
            const pig = find("minecraft:pig");
            const plain = find("minecraft:minecart");
            const stand = find("minecraft:armor_stand");
            check("found", cm !== null && hm !== null, `chest ${cm !== null} hopper ${hm !== null} pig ${pig !== null} minecart ${plain !== null} armor_stand ${stand !== null}`);
            if (cm === null || hm === null) return;
            const cc = cm.tryGetComponent("minecraft:container");
            const hc = hm.tryGetComponent("minecraft:container");
            for (const [n, e] of [["pig", pig], ["minecart", plain], ["armor_stand", stand]] as [string, Actor | null][]) {
                if (e === null) continue;
                const nc = e.tryGetComponent("minecraft:container");
                check(`lookup ${n}`, nc === null, nc === null ? "null" : "non-null");
            }
            check("lookup chest minecart", cc !== null, String(cc !== null));
            check("lookup hopper minecart", hc !== null, String(hc !== null));
            if (cc !== null) {
                check("chest empty slots", cc.getEmptySlotsCount() === 27, String(cc.getEmptySlotsCount()));
                check("chest getSlots size", cc.getSlots().size() === 27, String(cc.getSlots().size()));
            }
            if (hc !== null) {
                check("hopper empty slots", hc.getEmptySlotsCount() === 5, String(hc.getEmptySlotsCount()));
                check("hopper getSlots size", hc.getSlots().size() === 5, String(hc.getSlots().size()));
            }
        } else if (step === "fill") {
            const cc = chest();
            if (cc === null) return check("fill", false, "no chest minecart");
            // BDS's replaceitem has no slot name for a minecart's container (slot.container, slot.chest and slot.storage
            // all left it empty), so the fill goes through the Container's own addItem
            cc.addItem(ItemStack.constructWith("minecraft:diamond", 3));
            cc.addItem(ItemStack.constructWith("minecraft:apple", 2));
        } else if (step === "fillcheck") {
            const cc = chest();
            if (cc === null) return check("fill", false, "no chest minecart");
            console.log(`${TAG} INFO slots ${names(cc)}`);
            check("fill empty slots", cc.getEmptySlotsCount() === 25, String(cc.getEmptySlotsCount()));
            const s = cc.getSlots().toArray();
            check("fill slot 0", !s[0].isNull() && s[0].getAmount() === 3 && s[0].getName() === "minecraft:diamond", `${s[0].getName()} x${s[0].getAmount()}`);
            check("fill slot 1", !s[1].isNull() && s[1].getAmount() === 2 && s[1].getName() === "minecraft:apple", `${s[1].getName()} x${s[1].getAmount()}`);
        } else if (step === "add") {
            const cc = chest();
            if (cc === null) return check("add", false, "no chest minecart");
            console.log(`${TAG} INFO constructing apple`);
            const apple = ItemStack.constructWith("minecraft:apple", 1);
            console.log(`${TAG} INFO calling addItem(apple)`);
            const r1 = cc.addItem(apple);
            console.log(`${TAG} INFO addItem returned ${r1}`);
            const s1 = cc.getSlots().toArray();
            check("addItem apple merges", r1 === true && cc.getEmptySlotsCount() === 25 && s1[1].getAmount() === 3, `ret ${r1} empty ${cc.getEmptySlotsCount()} slot1 x${s1[1].getAmount()}`);
            const bread = ItemStack.constructWith("minecraft:bread", 1);
            const r2 = cc.addItem(bread);
            const s2 = cc.getSlots().toArray();
            check("addItem bread takes a slot", r2 === true && cc.getEmptySlotsCount() === 24 && !s2[2].isNull() && s2[2].getName() === "minecraft:bread", `ret ${r2} empty ${cc.getEmptySlotsCount()} slot2 ${s2[2].getName()}`);
            console.log(`${TAG} INFO slots ${names(cc)}`);
        } else if (step === "addn") {
            const cc = chest();
            if (cc === null) return check("addn", false, "no chest minecart");
            const before = cc.getEmptySlotsCount();
            const gold = ItemStack.constructWith("minecraft:gold_ingot", 10);
            console.log(`${TAG} INFO calling addItem(gold, -1, 4)`);
            const r = cc.addItem(gold, -1, 4);
            console.log(`${TAG} INFO addItem returned ${r}`);
            const s = cc.getSlots().toArray();
            let held = 0;
            for (const it of s) if (!it.isNull() && it.getName() === "minecraft:gold_ingot") held += it.getAmount();
            check("addItem(stack,-1,4) moves four", r === true && held === 4 && gold.getAmount() === 6 && cc.getEmptySlotsCount() === before - 1, `ret ${r} in container ${held} source left ${gold.getAmount()} empty ${before} -> ${cc.getEmptySlotsCount()}`);
            const r2 = cc.addItem(gold, -1, 6);
            let held2 = 0;
            for (const it of cc.getSlots().toArray()) if (!it.isNull() && it.getName() === "minecraft:gold_ingot") held2 += it.getAmount();
            check("addItem(stack,-1,6) merges the rest", r2 === true && held2 === 10 && gold.getAmount() === 0, `ret ${r2} in container ${held2} source left ${gold.getAmount()}`);
            console.log(`${TAG} INFO slots ${names(cc)}`);
        } else if (step === "actor") {
            // a killed hopper minecart drops its own item; `summon item` gives an item entity with an empty stack
            bedrockServer.executeCommand(`kill @e[type=hopper_minecart,${AREA}]`);
            bedrockServer.executeCommand("execute as @a at @s run summon item ~ ~ ~");
            console.log(`${TAG} INFO killed the hopper minecart, summoned an empty item entity`);
        } else if (step === "actor2") {
            const cc = chest();
            if (cc === null) return check("actor2", false, "no chest minecart");
            const items: ItemActor[] = [];
            for (const e of bedrockServer.level.getEntities()) {
                try {
                    if (e.getIdentifier() !== "minecraft:item") continue;
                    const p = e.getPosition();
                    if (Math.abs(p.x - 2000) < 100 && Math.abs(p.z + 2000) < 100) items.push(e as ItemActor);
                } catch (err) {
                    /* skip */
                }
            }
            console.log(`${TAG} INFO item entities: ${items.map(i => (i.itemStack.isNull() ? "empty" : `${i.itemStack.getName()}x${i.itemStack.getAmount()}`)).join(", ")}`);
                        const real = items.find(i => !i.itemStack.isNull());
            if (real === undefined) return check("actor real item", false, "the killed minecart dropped nothing");
            const name = real.itemStack.getName();
            const amount = real.itemStack.getAmount();
            const flag = () => (real as any as StaticPointer).getUint8(617);
            const flagBefore = flag();
            const before = cc.getEmptySlotsCount();
            const r = cc.addItem(real);
            let held = 0;
            for (const it of cc.getSlots().toArray()) if (!it.isNull() && it.getName() === name) held += it.getAmount();
            check("addItem(ItemActor) moves the entity's stack", r === true && held === amount && real.itemStack.getAmount() === 0 && cc.getEmptySlotsCount() === before - 1, `ret ${r} ${name} in container ${held} of ${amount} entity left ${real.itemStack.getAmount()} empty ${before} -> ${cc.getEmptySlotsCount()}`);
            check("addItem(ItemActor) removes the entity (removed byte +617)", flagBefore === 0 && flag() === 1, `${flagBefore} -> ${flag()}`);
            const e0 = cc.getEmptySlotsCount();
            const r2 = cc.addItem(real);
            check("addItem(ItemActor) refuses the emptied, removed entity", r2 === false && cc.getEmptySlotsCount() === e0, `ret ${r2} empty ${e0} -> ${cc.getEmptySlotsCount()}`);
        } else if (step === "clean") {
            bedrockServer.executeCommand(`kill @e[type=chest_minecart,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=hopper_minecart,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=pig,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=minecart,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=armor_stand,${AREA}]`);
            bedrockServer.executeCommand(`kill @e[type=item,${AREA}]`);
            console.log(`${TAG} INFO cleaned; ${pass} PASS / ${fail} FAIL so far`);
        } else if (step === "report") {
            console.log(`${TAG} INFO total ${pass} PASS / ${fail} FAIL`);
        }
    } catch (err) {
        fail++;
        console.log(`${TAG} FAIL ${step} threw ${(err as Error).stack}`);
    }
});

/**
 * "bactprobe": BlockActor's container, custom name and ChestBlockActor::openBy on 1.26 (docs/findings-containers.md section 24).
 * Block actors the driver places with `setblock`, apart from each other (adjacent chests pair): chest A (36,68,18), chest B
 * (39,68,18), hopper (36,68,21), standing sign (39,68,21). The engine's own readers -- BlockActor::save's NBT and the main
 * interface's hasCustomName -- are the oracles for bdsx's calls.
 *
 *   bactprobe container   getContainer: chest 27 slots, hopper 5, sign null; replaceitem puts diamond x3 in chest A only
 *   bactprobe name        setCustomName / getCustomName against the engine's hasCustomName and the saved CustomName
 *   bactprobe arm         count calls of ChestBlockActor::openBy (slot 29): the hook kills the server after the first call (findings-containers.md section 25), so the drivers leave it out
 *   bactprobe direct      bdsx's openBy(player) on chest A: the counter goes up by one
 *   bactprobe report      the counter after simbot used the chest at (31,68,18) (`simact useon 31`)
 */

const BTAG = "[bactprobe]";
let bpass = 0;
let bfail = 0;
function bcheck(name: string, ok: boolean, detail: string): void {
    if (ok) bpass++;
    else bfail++;
    console.log(`${BTAG} ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}
const BPOS = { a: [36, 18], b: [39, 18], h: [36, 21], s: [39, 21], c: [31, 18] } as const;
function actorAt(k: keyof typeof BPOS): BlockActor | null {
    const p = bedrockServer.level.getPlayers().find(x => x.getName() !== "simbot");
    if (p === undefined) return null;
    return p.getDimensionBlockSource().getBlockEntity(BlockPos.create(BPOS[k][0], 68, BPOS[k][1]));
}
let openByCalls = 0;
let openByHooked = false;
events.command.on(cmd => {
    const m = /^\/?bactprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    try {
        const a = actorAt("a"), b = actorAt("b"), h = actorAt("h"), s = actorAt("s");
        if (step === "open") {
            // openBy without a hook on it: what Container::startOpen writes on the chest's container (2024's body, both builds:
            // a viewer set at +0x200, its count at +0x210, an "opened" byte at +0x1d0) is read before and after. Chest C
            // (31,68,18) is opened by simbot through the engine (`simact useon 31` just before), which shows what a real open
            // leaves; chest B (39,68,18) is never touched by the engine, so a change there is the call's own.
            const c = actorAt("c");
            const sim = bedrockServer.level.getPlayers().find(x => x.getName() === "simbot");
            const bot = bedrockServer.level.getPlayers().find(x => x.getName() !== "simbot");
            if (!(b instanceof ChestBlockActor) || !(c instanceof ChestBlockActor) || sim === undefined || bot === undefined) return bcheck("open setup", false, `B ${b} C ${c} sim ${sim !== undefined} bot ${bot !== undefined}`);
            const state = (x: BlockActor): string => {
                const k = x.getContainer() as any as StaticPointer;
                return `count ${k.getInt32(0x210)} flag ${k.getUint8(0x1d0)}`;
            };
            const hasOpen = (p: Player): boolean => !(p as any as StaticPointer).getPointer(0x5a0).isNull();
            console.log(`${BTAG} INFO players: bot ${bot.getName()} ${bot} uid ${bot.getUniqueIdBin()} +0x5a0 ${(bot as any as StaticPointer).getPointer(0x5a0)}; sim ${sim.getName()} ${sim} uid ${sim.getUniqueIdBin()} +0x5a0 ${(sim as any as StaticPointer).getPointer(0x5a0)}`);
            bcheck("open: simbot holds C open, the bot holds nothing", hasOpen(sim) && !hasOpen(bot), `simbot open container ${hasOpen(sim)}, bot ${hasOpen(bot)}`);
            bcheck("open: the engine's own open of C", state(c) === "count 1 flag 1", `C ${state(c)} (want count 1 flag 1)`);
            bcheck("open: B untouched", state(b) === "count 0 flag 0", `B ${state(b)}`);
            // openBy is more than startOpen: the player-gameplay event it sends is what makes the engine open a container for a
            // player who holds none (the bot's +0x5a0 goes from null to a pointer inside the call), and only then does the
            // second half run startOpen on the chest's container with that player.
            const bot0 = (bot as any as StaticPointer).getPointer(0x5a0);
            const c0 = state(c);
            b.openBy(bot);
            const bot1 = (bot as any as StaticPointer).getPointer(0x5a0);
            bcheck("openBy(bot): the player gets a container and B registers it", bot0.isNull() && !bot1.isNull() && state(b) === "count 1 flag 1" && state(c) === c0, `bot +0x5a0 ${bot0} -> ${bot1}; B count 0 flag 0 -> ${state(b)}; C ${c0} -> ${state(c)} (unchanged)`);
            b.openBy(sim);
            bcheck("openBy(simbot): a second viewer", state(b) === "count 2 flag 1", `B ${state(b)} after openBy(simbot) (want count 2 flag 1), C ${state(c)}`);
            b.openBy(sim);
            bcheck("openBy again: the viewer set keeps one entry per player", state(b) === "count 2 flag 1", `B ${state(b)} after a second openBy(simbot)`);
            const cont = b.getContainer() as any as StaticPointer;
            const stopOpen = makefunc.js(cont.getPointer(0).getPointer(0xb8), void_t, null, VoidPointer, VoidPointer);
            stopOpen(cont, sim as any);
            bcheck("Container::stopOpen(simbot) takes one viewer out", state(b).startsWith("count 1 "), `B ${state(b)} after stopOpen(simbot), C ${state(c)}`);
            stopOpen(cont, bot as any);
            bcheck("Container::stopOpen(bot) takes the other out", state(b).startsWith("count 0 "), `B ${state(b)} after stopOpen(bot)`);
            return;
        }
        if (step === "container") {
            if (a === null || b === null || h === null || s === null) return bcheck("actors", false, `chest A ${a}, chest B ${b}, hopper ${h}, sign ${s}`);
            bcheck("actors", a.getType() === BlockActorType.Chest && b.getType() === BlockActorType.Chest && h.getType() === BlockActorType.Hopper && s.getType() === BlockActorType.Sign, `types ${a.getType()} ${b.getType()} ${h.getType()} ${s.getType()}`);
            const ca = a.getContainer(), cb = b.getContainer(), ch = h.getContainer(), cs = s.getContainer();
            bcheck("getContainer null for a sign", cs === null && ca !== null && cb !== null && ch !== null, `chest A ${ca !== null} chest B ${cb !== null} hopper ${ch !== null} sign ${cs !== null}`);
            if (ca === null || cb === null || ch === null) return;
            bcheck("getContainer sizes", ca.getSlots().size() === 27 && cb.getSlots().size() === 27 && ch.getSlots().size() === 5, `chest A ${ca.getSlots().size()} chest B ${cb.getSlots().size()} hopper ${ch.getSlots().size()} (27/27/5)`);
            bcheck("getContainer distinct", !(ca as any as StaticPointer).equalsptr(cb as any) && !(ca as any as StaticPointer).equalsptr(ch as any), `A ${ca} B ${cb} hopper ${ch}`);
            const empty = (c: typeof ca) => c.getSlots().toArray().every(x => x.isNull());
            bcheck("chests start empty", empty(ca) && empty(cb), `A empty ${empty(ca)} B empty ${empty(cb)}`);
            bedrockServer.executeCommand(`replaceitem block ${BPOS.a[0]} 68 ${BPOS.a[1]} slot.container 0 diamond 3`);
            bedrockServer.executeCommand(`replaceitem block ${BPOS.h[0]} 68 ${BPOS.h[1]} slot.container 2 apple 5`);
            const s0 = ca.getSlots().toArray()[0];
            const hs = ch.getSlots().toArray()[2];
            bcheck("getContainer reads what BDS put in", !s0.isNull() && s0.getName() === "minecraft:diamond" && s0.getAmount() === 3 && !hs.isNull() && hs.getName() === "minecraft:apple" && hs.getAmount() === 5 && empty(cb), `chest A slot 0 ${s0.isNull() ? "-" : `${s0.getName()}x${s0.getAmount()}`}, hopper slot 2 ${hs.isNull() ? "-" : `${hs.getName()}x${hs.getAmount()}`}, chest B empty ${empty(cb)}`);
            const saved = JSON.stringify(a.save());
            bcheck("engine save agrees", saved.includes("diamond") && !JSON.stringify(b.save()).includes("diamond"), `A's NBT has diamond ${saved.includes("diamond")}, B's ${JSON.stringify(b.save()).includes("diamond")}`);
        } else if (step === "name") {
            if (a === null || b === null) return bcheck("name actors", false, `chest A ${a}, chest B ${b}`);
            const has = (x: BlockActor) => blockActorHasCustomName(x as any as StaticPointer);
            const savedName = (x: BlockActor): string | undefined => (x.save() as any).CustomName;
            bcheck("name starts empty", !has(a) && a.getCustomName() === "" && savedName(a) === undefined, `has ${has(a)} name "${a.getCustomName()}" saved ${savedName(a)}`);
            a.setCustomName("Probe Chest");
            bcheck("setCustomName short", has(a) && a.getCustomName() === "Probe Chest" && savedName(a) === "Probe Chest", `has ${has(a)} name "${a.getCustomName()}" saved ${savedName(a)}`);
            bcheck("setCustomName leaves the other chest", !has(b) && b.getCustomName() === "" && savedName(b) === undefined, `B has ${has(b)} name "${b.getCustomName()}" saved ${savedName(b)}`);
            const long = "A chest with a name that does not fit an SSO buffer";
            a.setCustomName(long);
            bcheck("setCustomName heap string", has(a) && a.getCustomName() === long && savedName(a) === long, `has ${has(a)} name "${a.getCustomName()}" saved ${savedName(a)}`);
            a.setCustomName("Short again");
            bcheck("setCustomName back to short", a.getCustomName() === "Short again" && savedName(a) === "Short again", `name "${a.getCustomName()}" saved ${savedName(a)}`);
            a.setCustomName("");
            bcheck("setCustomName empty", !has(a) && a.getCustomName() === "", `has ${has(a)} name "${a.getCustomName()}" saved ${savedName(a)}`);
            b.setCustomName("Other");
            bcheck("setCustomName on B", b.getCustomName() === "Other" && a.getCustomName() === "", `A "${a.getCustomName()}" B "${b.getCustomName()}"`);
            b.setCustomName("");
        } else if (step === "arm") {
            if (openByHooked) return console.log(`${BTAG} INFO already armed, calls ${openByCalls}`);
            if (!(a instanceof ChestBlockActor)) return bcheck("arm", false, `chest A resolves to ${a === null ? "null" : a.constructor.name}`);
            const fn = (a as any as StaticPointer).getPointer(0).getPointer(CHEST_OPEN_BY_SLOT * 8);
            const counter = makefunc.np(() => {
                openByCalls++;
                console.log(`${BTAG} INFO openBy fired #${openByCalls}`);
            }, void_t, null);
            new ProcHacker<{ openBy: NativePointer }>({ openBy: fn as NativePointer }).hookingRawWithCallOriginal("openBy", counter, [], []);
            openByHooked = true;
            console.log(`${BTAG} INFO armed openBy at ${fn} (slot ${CHEST_OPEN_BY_SLOT})`);
        } else if (step === "direct") {
            if (!(a instanceof ChestBlockActor)) return bcheck("direct", false, "chest A is not a ChestBlockActor");
            const p: Player | undefined = bedrockServer.level.getPlayers().find(x => x.getName() !== "simbot");
            if (p === undefined) return bcheck("direct", false, "no player");
            const before = openByCalls;
            console.log(`${BTAG} INFO calling openBy(${p.getName()}) on chest A, armed ${openByHooked}`);
            a.openBy(p);
            bcheck("openBy direct", openByHooked ? openByCalls === before + 1 : true, `returned; counter ${before} -> ${openByCalls} (armed ${openByHooked}; the player has no open container: only the gameplay event, no startOpen)`);
        } else if (step === "report") {
            console.log(`${BTAG} INFO openBy calls ${openByCalls}; total ${bpass} PASS / ${bfail} FAIL`);
        }
    } catch (err) {
        bfail++;
        console.log(`${BTAG} FAIL ${step} threw ${(err as Error).stack}`);
    }
});
