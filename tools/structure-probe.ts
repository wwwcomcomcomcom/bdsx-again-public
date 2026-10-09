/**
 * "nbtsprobe": StructureTemplate's NBT round trip (docs/findings-nbt.md "StructureTemplate").
 *
 * The driver builds a 3x3x3 of stone with an oak log and a chest in it and `structure save`s it to memory. Then:
 *
 *   nbtsprobe          finds the template the command made in StructureManager's name map (+0x60, walked read-only),
 *                      checks getOrCreate returns that same template, has the engine save it twice (StructureTemplate
 *                      ::save, the vftable slot-5 forwarder, and StructureTemplateData::save directly), checks bdsx's
 *                      StructureTemplateData fields against what the engine wrote, then getOrCreate's a fresh
 *                      "<name>_copy", has the engine load the saved tag into it and save it again: the two saves must
 *                      be identical (the engine's own save -> load -> save, bdsx only carrying the tag).
 *   nbtsprobe placed   after the driver's `structure load <name>_copy` 10 blocks east: the engine placed what bdsx
 *                      loaded, so every block there must match the original's.
 */
import { BlockPos } from "bdsx/bds/blockpos";
import { StructureTemplate } from "bdsx/bds/structure";
import { Player } from "bdsx/bds/player";
import { Actor } from "bdsx/bds/actor";
import { NativePointer, StaticPointer } from "bdsx/core";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { proc } from "bdsx/bds/symbols";
import { procHacker } from "bdsx/bds/proc";
import { AllocatedPointer, VoidPointer } from "bdsx/core";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[stprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

// the box the driver fills and saves, and where it loads the copy (10 blocks east)
const X0 = 40,
    Y0 = 68,
    Z0 = 14,
    SHIFT = 10;
let copyName: string | null = null;

/** StructureManager's unordered_map<string, unique_ptr<StructureTemplate>> at +0x60: its std::list head at +0x68 */
function templates(): { key: string; tmpl: NativePointer }[] {
    const sm = bedrockServer.structureManager as any as StaticPointer;
    const head = sm.getPointer(0x68);
    const out: { key: string; tmpl: NativePointer }[] = [];
    let node = head.getPointer(0);
    for (let i = 0; i < 4096 && !node.equals(head); i++, node = node.getPointer(0)) {
        out.push({ key: node.getCxxString(0x10), tmpl: node.getPointer(0x30) });
    }
    return out;
}

const vec = (v: any): number[] => (Array.isArray(v) ? v.map(x => +x) : []);
const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

events.command.on(cmd => {
    const m = /^\/?nbtsprobe(?:\s+(placed))?\s*$/.exec(cmd);
    if (m === null) return;
    if (m[1] === "placed") {
        placed();
        return;
    }
    try {
        const names = ["?save@StructureTemplate@@QEBA?AV?$unique_ptr@VCompoundTag@@U?$default_delete@VCompoundTag@@@std@@@std@@XZ",
            "?save@StructureTemplateData@@QEBA?AV?$unique_ptr@VCompoundTag@@U?$default_delete@VCompoundTag@@@std@@@std@@XZ",
            "?getOrCreate@StructureManager@@QEAAAEAVStructureTemplate@@AEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            "?load@StructureTemplateData@@QEAA_NAEBVCompoundTag@@@Z"];
        say("table", null, names.map(n => `${n.slice(1, n.indexOf("@@"))} ${n in proc ? proc[n] : "MISSING"}`).join("; "));
        const smp = bedrockServer.structureManager as any as StaticPointer;
        const want = "??_7StructureManager@@6B@" in proc ? proc["??_7StructureManager@@6B@"] : null;
        say("manager", want !== null && smp.getPointer(0).equals(want),
            `Level::getStructureManager's object ${smp}: vptr ${smp.getPointer(0)}, ??_7StructureManager@@6B@ ${want}`);
        const list = templates();
        say("map", null, `${list.length} template(s), ${list.filter(t => t.key.startsWith("mystructure:")).map(t => t.key).join(", ")} among them`);
        const found = list.find(t => /(^|:)bdsxprobe$/.test(t.key));
        if (found === undefined) {
            say("nbtsprobe", false, "no template named *bdsxprobe in the map: did `structure save` run?");
            return;
        }
        const sm = bedrockServer.structureManager;
        const tmpl = sm.getOrCreate(found.key);
        const tp = tmpl as any as StaticPointer;
        say("getOrCreate", tp.equals(found.tmpl) && tmpl.name === found.key,
            `getOrCreate("${found.key}") ${tp} vs the map's ${found.tmpl}; its name field "${tmpl.name}"`);

        // the engine's save, twice: through StructureTemplate::save (this+0x28 forwarder) and the data's own
        const saved = tmpl.save();
        const direct = tmpl.data.save();
        const a = JSON.stringify(saved);
        const size = vec(saved.size), origin = vec(saved.structure_world_origin);
        const st = saved.structure ?? {};
        const layers = Array.isArray(st.block_indices) ? st.block_indices.length : -1;
        const layer0 = layers > 0 ? st.block_indices[0] : undefined;
        const cells = layer0 != null && typeof layer0.length === "number" ? layer0.length : -1;
        say("block_indices", null, `${Object.prototype.toString.call(st.block_indices)} of ${Object.prototype.toString.call(layer0)}: ${JSON.stringify(st.block_indices)?.slice(0, 200)}`);
        const palette = st.palette?.default?.block_palette;
        const paletteNames = Array.isArray(palette) ? palette.map((b: any) => b.name) : [];
        const bpd = st.palette?.default?.block_position_data ?? {};
        const chest = Object.values(bpd).map((v: any) => v?.block_entity_data?.id).filter(x => x !== undefined);
        say("nbtsprobe save", a === JSON.stringify(direct) && same(size, [3, 3, 3]) && same(origin, [X0, Y0, Z0]) && cells === 27 &&
            paletteNames.some((n: string) => n.endsWith(":stone")) && paletteNames.some((n: string) => n.endsWith("chest")) && chest.length === 1,
            `keys ${Object.keys(saved).join(",")}; format_version ${JSON.stringify(saved.format_version)}; size ${size}; structure_world_origin ${origin}; ` +
            `block_indices ${layers} layer(s) x ${cells}; palette ${paletteNames.join(",")}; block entities ${chest.join(",")}; ` +
            `StructureTemplate::save ${a === JSON.stringify(direct) ? "=" : "!="} StructureTemplateData::save`);

        // bdsx's own view of the data (engineLayout offsets) against what the engine wrote
        const d = tmpl.data;
        const dsize = [d.size.x, d.size.y, d.size.z], dorigin = [d.structureWorldOrigin.x, d.structureWorldOrigin.y, d.structureWorldOrigin.z];
        say("nbtsprobe fields", same(dsize, size) && same(dorigin, origin),
            `formatVersion ${d.formatVersion}; size ${dsize}; structureWorldOrigin ${dorigin} (the engine wrote ${size} / ${origin})`);

        // the engine's own save -> load -> save, bdsx carrying the tag
        copyName = found.key.replace(/bdsxprobe$/, "bdsxprobe_copy");
        const copy = sm.getOrCreate(copyName) as StructureTemplate;
        const cp = copy as any as StaticPointer;
        const inMap = templates().find(t => t.key === copyName);
        say("getOrCreate new", inMap !== undefined && cp.equals(inMap.tmpl) && copy.name === copyName,
            `getOrCreate("${copyName}") ${cp} (${typeof copy} ${copy?.constructor?.name}) vs the map's ${inMap?.tmpl}; name "${copy.name}"; vptr ${cp.getPointer(0)} vs the original's ${tp.getPointer(0)}`);
        let before = "";
        try {
            before = JSON.stringify(copy.save());
            say("nbtsprobe empty save", before.length > 0, `a fresh template saves as ${before}`);
        } catch (err) {
            say("nbtsprobe empty save", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
        }
        const tag = tmpl.allocateAndSave();
        let loaded: boolean;
        try {
            loaded = copy.load(tag);
        } finally {
            tag.dispose();
        }
        const again = copy.save();
        const b = JSON.stringify(again);
        let where = "";
        if (a !== b) {
            let i = 0;
            while (i < a.length && a[i] === b[i]) i++;
            where = ` at ${i}: ${a.slice(Math.max(0, i - 60), i + 60)} vs ${b.slice(Math.max(0, i - 60), i + 60)}`;
        }
        say("nbtsprobe roundtrip", loaded && a === b && before !== a,
            `"${copyName}" empty save ${before.length} chars; load ${loaded}; re-save ${b.length} chars, ${a === b ? "identical to the original's" : "differs" + where}`);
    } catch (err) {
        say("nbtsprobe", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    }
});

function placed(): void {
    if (player === null) {
        say("nbtsprobe placed", false, "no player");
        return;
    }
    if (copyName === null) {
        say("nbtsprobe placed", false, "`nbtsprobe` did not make a copy");
        return;
    }
    try {
        const region = player.getDimensionBlockSource();
        const diff: string[] = [];
        const seen = new Set<string>();
        for (let dx = 0; dx < 3; dx++)
            for (let dy = 0; dy < 3; dy++)
                for (let dz = 0; dz < 3; dz++) {
                    const o = region.getBlock(BlockPos.create(X0 + dx, Y0 + dy, Z0 + dz)).getName();
                    const c = region.getBlock(BlockPos.create(X0 + SHIFT + dx, Y0 + dy, Z0 + dz)).getName();
                    seen.add(o);
                    if (o !== c) diff.push(`${dx},${dy},${dz}: ${o} vs ${c}`);
                }
        say("nbtsprobe placed", diff.length === 0 && seen.size >= 3,
            `27 blocks of "${copyName}" placed at +${SHIFT} x: ${diff.length === 0 ? "all match the original" : diff.slice(0, 5).join("; ")} (kinds ${[...seen].join(",")})`);
    } catch (err) {
        say("nbtsprobe placed", false, `threw ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// "stsetprobe": StructureSettings on 1.26 (docs/findings-structure.md). The engine has no constructor, destructor or
// accessor for it any more, so bdsx writes the object; every check here is the ENGINE reading what bdsx wrote
// (fillFromWorld / placeInWorld) or bdsx reading what the ENGINE wrote (the settings `/structure load` builds, seen
// through a hook on StructureManager::tryPlaceStructureInWorld, STSET_PROBE=1).
//
// The driver tps the bot to x=2000 first and waits; everything else is one `stsetprobe`, which runs its own setup and
// clean-up commands through bedrockServer.executeCommand.
import { CommandResultType } from "bdsx/commandresult";
import { StructureSettings } from "bdsx/bds/structure";
import { engineLayout } from "bdsx/bds/engine/deps";
import { int32_t, NativeType, void_t } from "bdsx/nativetype";

const SS = {
    ignoreEntities: engineLayout("StructureSettings", "ignoreEntities", 0x20),
    reloadActorEquipment: engineLayout("StructureSettings", "reloadActorEquipment", 0x21),
    ignoreBlocks: engineLayout("StructureSettings", "ignoreBlocks", 0x22),
    ignoreJigsawBlocks: engineLayout("StructureSettings", "ignoreJigsawBlocks", 0x24),
    lastTouchedByPlayerId: engineLayout("StructureSettings", "lastTouchedByPlayerId", 0x50),
    structureSize: engineLayout("StructureSettings", "structureSize", 0x28),
    structureOffset: engineLayout("StructureSettings", "structureOffset", 0x34),
    pivot: engineLayout("StructureSettings", "pivot", 0x40),
    mirror: engineLayout("StructureSettings", "mirror", 0x59),
    rotation: engineLayout("StructureSettings", "rotation", 0x58),
    animationMode: engineLayout("StructureSettings", "animationMode", 0x5a),
    animationSeconds: engineLayout("StructureSettings", "animationSeconds", 0x5c),
    integrityValue: engineLayout("StructureSettings", "integrityValue", 0x60),
    integritySeed: engineLayout("StructureSettings", "integritySeed", 0x64),
    size: engineLayout("StructureSettings", "size", 0x68),
};

/** what tryPlaceStructureInWorld was handed, copied out at the call */
const placeSnaps: { label: string; copy: AllocatedPointer }[] = [];
let placeLabel = "";
if (process.env.STSET_PROBE === "1") {
    const original = procHacker.hooking(
        "bdsx:StructureManager::tryPlaceStructureInWorld",
        int32_t,
        null,
        VoidPointer,
        VoidPointer,
        VoidPointer,
        VoidPointer,
        VoidPointer,
        VoidPointer,
        StaticPointer,
        VoidPointer,
        VoidPointer,
    )((self, area, level, dim, bbox, pos, settings, tmpl, anim) => {
        const copy = new AllocatedPointer(SS.size);
        copy.copyFrom(settings, SS.size);
        placeSnaps.push({ label: placeLabel, copy });
        return original(self, area, level, dim, bbox, pos, settings, tmpl, anim);
    });
}

/**
 * The engine's reader of `reloadActorEquipment` (settings +0x21): placeInWorld's entity step passes the flag on, and after each
 * loaded entity, if it is set, calls this function with the new Actor (this in rcx, no other argument, no result). It looks up an
 * EnTT component on the actor and tail-calls the routine that rebuilds SlotDropChancesComponent. bdsx does not know its name.
 */
let reloadCalls = 0;
const reloadTypes: string[] = [];
if (process.env.STSET_PROBE === "1") {
    const originalReload = procHacker.hooking("bdsx:Actor::_reloadEquipmentAfterStructureLoad", void_t, null, VoidPointer)(actor => {
        reloadCalls++;
        try {
            reloadTypes.push(actor.as(Actor).getIdentifier());
        } catch (err) {
            reloadTypes.push("?");
        }
        return originalReload(actor);
    });
}

const run = (c: string): boolean => {
    try {
        return bedrockServer.executeCommand(c, CommandResultType.Data).isSuccess();
    } catch (err) {
        console.log(`[stprobe] INFO command "${c}" threw ${(err as Error).message}`);
        return false;
    }
};

const STX = 2000, STY = 68, STZ = 14; // the source box: x 2000..2003, z 14..16, one block high
const BOXES = ["gold_block", "iron_block", "diamond_block"];

const bn = (region: any, x: number, y: number, z: number): string => region.getBlock(BlockPos.create(x, y, z)).getName().replace("minecraft:", "");
const fields = (s: AllocatedPointer) => ({
    palette: s.getCxxString(0),
    ignoreEntities: s.getBoolean(SS.ignoreEntities),
    reload: s.getBoolean(SS.reloadActorEquipment),
    ignoreBlocks: s.getBoolean(SS.ignoreBlocks),
    jigsaw: s.getBoolean(SS.ignoreJigsawBlocks),
    lastTouched: `${s.getInt32(SS.lastTouchedByPlayerId + 4)}:${s.getInt32(SS.lastTouchedByPlayerId)}`,
    size: [s.getInt32(SS.structureSize), s.getInt32(SS.structureSize + 4), s.getInt32(SS.structureSize + 8)],
    offset: [s.getInt32(SS.structureOffset), s.getInt32(SS.structureOffset + 4), s.getInt32(SS.structureOffset + 8)],
    pivot: [s.getFloat32(SS.pivot), s.getFloat32(SS.pivot + 4), s.getFloat32(SS.pivot + 8)],
    mirror: s.getUint8(SS.mirror),
    rotation: s.getUint8(SS.rotation),
    mode: s.getUint8(SS.animationMode),
    seconds: s.getFloat32(SS.animationSeconds),
    integrity: s.getFloat32(SS.integrityValue),
    seed: s.getUint32(SS.integritySeed),
});

events.command.on(cmd => {
    if (!/^\/?stsetprobe\s*$/.test(cmd)) return;
    if (player === null) {
        say("stsetprobe", false, "no player");
        return;
    }
    try {
        stsetprobe();
    } catch (err) {
        say("stsetprobe", false, `threw ${(err as Error).stack ?? (err as Error).message}`);
    }
});

function stsetprobe(): void {
    const region = player!.getDimensionBlockSource();
    const sm = bedrockServer.structureManager;
    const pal = bedrockServer.level.getBlockPalette();
    const mk = (): StructureSettings => StructureSettings.construct();

    // ---- 1. the constructor, on memory that is not zero
    {
        const raw = new AllocatedPointer(SS.size);
        raw.fill(0xcd, SS.size);
        const s = raw.as(StructureSettings);
        s[NativeType.ctor]();
        const f = fields(raw);
        const ok = f.palette === "default" && !f.ignoreEntities && !f.reload && !f.ignoreBlocks && !f.jigsaw && f.lastTouched === "-1:-1" &&
            f.size.every(v => v === 0) && f.offset.every(v => v === 0) && f.pivot.every(v => v === 0) && f.mirror === 0 && f.rotation === 0 &&
            f.mode === 0 && f.seconds === 0 && f.integrity === 100 && f.seed === 0;
        say("stset ctor", ok, `0xcd memory after the constructor: ${JSON.stringify(f)}`);
        s[NativeType.dtor]();
    }

    // ---- 2. the source box
    run(`fill ${STX} ${STY} ${STZ} ${STX + 3} ${STY} ${STZ + 2} stone`);
    run(`setblock ${STX} ${STY} ${STZ} gold_block`);
    run(`setblock ${STX + 3} ${STY} ${STZ} iron_block`);
    run(`setblock ${STX + 1} ${STY} ${STZ + 2} diamond_block`);
    run(`kill @e[type=armor_stand]`);
    run(`summon armor_stand ${STX + 3.5} ${STY} ${STZ + 1.5}`);
    say("stset box", bn(region, STX, STY, STZ) === "gold_block" && bn(region, STX + 3, STY, STZ) === "iron_block" && bn(region, STX + 1, STY, STZ + 2) === "diamond_block",
        `${bn(region, STX, STY, STZ)} ${bn(region, STX + 3, STY, STZ)} ${bn(region, STX + 1, STY, STZ + 2)} ${bn(region, STX + 1, STY, STZ + 1)}`);

    // ---- 3. fillFromWorld: the engine reads size, offset and the two ignore flags out of bdsx's object
    const pos = BlockPos.create(STX, STY, STZ);
    const entities = (t: StructureTemplate): number => {
        const st = (t.save() as any).structure ?? {};
        return Array.isArray(st.entities) ? st.entities.length : 0;
    };
    const sizeOf = (t: StructureTemplate) => [t.getSize().x, t.getSize().y, t.getSize().z];
    const originOf = (t: StructureTemplate) => [t.data.structureWorldOrigin.x, t.data.structureWorldOrigin.y, t.data.structureWorldOrigin.z];
    const at = (t: StructureTemplate, x: number, y: number, z: number): string => {
        const b = t.tryGetBlockAtPos(BlockPos.create(x, y, z));
        return b === null ? "null" : b.getName().replace("minecraft:", "");
    };
    const tA = sm.getOrCreate("mystructure:stsetA");
    {
        const s = mk();
        s.setStructureSize(BlockPos.create(4, 1, 3));
        s.setStructureOffset(BlockPos.create(0, 0, 0));
        tA.fillFromWorld(region, pos, s);
        const corner = [at(tA, 0, 0, 0), at(tA, 3, 0, 0), at(tA, 1, 0, 2), at(tA, 1, 0, 1)];
        say("stset fill size", sizeOf(tA).join() === "4,1,3" && originOf(tA).join() === `${STX},${STY},${STZ}`,
            `the engine stored size ${sizeOf(tA)} and world origin ${originOf(tA)} (settings size 4,1,3, offset 0,0,0, pos ${STX},${STY},${STZ})`);
        say("stset fill blocks", corner.join() === "gold_block,iron_block,diamond_block,stone", `tryGetBlockAtPos (0,0,0) (3,0,0) (1,0,2) (1,0,1): ${corner}`);
        say("stset fill entities", entities(tA) === 1, `ignoreEntities false: ${entities(tA)} entity in the saved structure (the armor stand)`);
        // the engine bounds-checks the flat index only ((sizeY * x + y) * sizeZ + z against the block count), like 2024
        say("stset out of range", at(tA, 4, 0, 0) === "null" && at(tA, 9, 0, 0) === "null", `tryGetBlockAtPos past the last cell: ${at(tA, 4, 0, 0)} ${at(tA, 9, 0, 0)} (the flat index runs out at 12; (0,1,0) is still index 3: ${at(tA, 0, 1, 0)})`);
        s[NativeType.dtor]();
    }
    const tB = sm.getOrCreate("mystructure:stsetB");
    {
        const s = mk();
        s.setStructureSize(BlockPos.create(1, 1, 3));
        s.setStructureOffset(BlockPos.create(3, 0, 0));
        s.setIgnoreEntities(true);
        tB.fillFromWorld(region, pos, s);
        say("stset fill offset", sizeOf(tB).join() === "1,1,3" && originOf(tB).join() === `${STX + 3},${STY},${STZ}` && at(tB, 0, 0, 0) === "iron_block" && at(tB, 0, 0, 2) === "stone",
            `size ${sizeOf(tB)}, world origin ${originOf(tB)} (pos + offset 3,0,0), (0,0,0) ${at(tB, 0, 0, 0)}, (0,0,2) ${at(tB, 0, 0, 2)}`);
        say("stset ignoreEntities", entities(tB) === 0, `setIgnoreEntities(true): ${entities(tB)} entity (the armor stand is inside the box; fill A saw ${entities(tA)})`);
        s[NativeType.dtor]();
    }
    const tC = sm.getOrCreate("mystructure:stsetC");
    {
        const s = mk();
        s.setStructureSize(BlockPos.create(4, 1, 3));
        s.setIgnoreBlocks(true);
        tC.fillFromWorld(region, pos, s);
        say("stset ignoreBlocks", at(tC, 0, 0, 0) === "null" && at(tC, 3, 0, 0) === "null" && entities(tC) === 1 && sizeOf(tC).join() === "4,1,3",
            `setIgnoreBlocks(true): (0,0,0) ${at(tC, 0, 0, 0)}, (3,0,0) ${at(tC, 3, 0, 0)}, entities ${entities(tC)}, size ${sizeOf(tC)}`);
        s[NativeType.dtor]();
    }
    run(`kill @e[type=armor_stand]`);

    // ---- 4. placeInWorld against `/structure load` with the same rotation and mirror
    const R = ["0_degrees", "90_degrees", "180_degrees", "270_degrees"];
    const M = ["none", "x", "z", "xz"];
    const window = (ox: number, oz: number): string[] => {
        const out: string[] = [];
        for (let dz = -4; dz <= 5; dz++) for (let dx = -4; dx <= 5; dx++) out.push(bn(region, ox + dx, STY, oz + dz));
        return out;
    };
    const clear = (ox: number, oz: number) => run(`fill ${ox - 4} ${STY} ${oz - 4} ${ox + 5} ${STY} ${oz + 5} air`);
    const sigs: string[] = [];
    const cases: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [0, 2], [0, 3], [1, 2]];
    for (const [rot, mir] of cases) {
        const EX = 2010, EZ = 30, BX = 2010, BZ = 46;
        clear(EX, EZ);
        clear(BX, BZ);
        placeLabel = `load ${rot} ${mir}`;
        const ok = run(`structure load stsetA ${EX} ${STY} ${EZ} ${R[rot]} ${M[mir]}`);
        const s = mk();
        s.setStructureSize(BlockPos.create(4, 1, 3));
        s.setRotation(rot);
        s.setMirror(mir);
        const raw = s as any as AllocatedPointer;
        raw.setFloat32(1.5, SS.pivot);
        raw.setFloat32(0, SS.pivot + 4);
        raw.setFloat32(1, SS.pivot + 8);
        tA.placeInWorld(region, pal, BlockPos.create(BX, STY, BZ), s);
        s[NativeType.dtor]();
        const e = window(EX, EZ), b = window(BX, BZ);
        const nonAir = (w: string[]) => w.filter(n => n !== "air").length;
        const same = e.every((n, i) => n === b[i]);
        const sig = e.map(n => (n === "air" ? "." : n[0])).join("");
        sigs.push(sig);
        say(`stset place rot ${rot * 90} mirror ${M[mir]}`, ok && same && nonAir(e) === 12, `command ${ok}; engine ${nonAir(e)} blocks, bdsx ${nonAir(b)} blocks, ${same ? "identical" : "DIFFER"} over the 10x10 window`);
    }
    say("stset place distinct", new Set([sigs[1], sigs[4], sigs[5], sigs[0]]).size === 4, `rotation 90, mirror x, mirror z and the plain load are four different arrangements: ${new Set(sigs).size} distinct of ${sigs.length}`);
    run(`kill @e[type=armor_stand]`);

    // ---- 5. integrity and its seed (bdsx writes the float raw: setIntegrityValue is not one of the names)
    {
        run(`fill 2020 ${STY} 14 2027 ${STY} 21 stone`);
        const tU = sm.getOrCreate("mystructure:stsetU");
        const s0 = mk();
        s0.setStructureSize(BlockPos.create(8, 1, 8));
        tU.fillFromWorld(region, BlockPos.create(2020, STY, 14), s0);
        s0[NativeType.dtor]();
        const stones = (ox: number, oz: number) => {
            let n = 0;
            let sig = "";
            for (let dz = 0; dz < 8; dz++) for (let dx = 0; dx < 8; dx++) {
                const on = bn(region, ox + dx, STY, oz + dz) === "stone";
                n += on ? 1 : 0;
                sig += on ? "#" : ".";
            }
            return { n, sig };
        };
        const place = (oz: number, integrity: number, seed: number) => {
            run(`fill 2020 ${STY} ${oz} 2027 ${STY} ${oz + 7} air`);
            const s = mk();
            s.setStructureSize(BlockPos.create(8, 1, 8));
            (s as any as AllocatedPointer).setFloat32(integrity, SS.integrityValue);
            s.setIntegritySeed(seed);
            tU.placeInWorld(region, pal, BlockPos.create(2020, STY, oz), s);
            s[NativeType.dtor]();
            return stones(2020, oz);
        };
        const full = place(30, 100, 7), a1 = place(40, 50, 1), a2 = place(50, 50, 1), b = place(60, 50, 2);
        say("stset integrity", full.n === 64 && a1.n > 8 && a1.n < 56, `integrity 100: ${full.n}/64 stones; integrity 50: ${a1.n}/64`);
        say("stset seed", a1.sig === a2.sig && a1.sig !== b.sig, `seed 1 twice: ${a1.sig === a2.sig ? "identical" : "DIFFER"} (${a1.n}, ${a2.n}); seed 2: ${b.sig === a1.sig ? "the SAME as seed 1" : "different"} (${b.n})`);
        for (const oz of [14, 30, 40, 50, 60]) run(`fill 2020 ${STY} ${oz} 2027 ${STY} ${oz + 7} air`);
    }

    // ---- 6. the settings the engine builds (hooked): the layout from the other side, and the animation getters
    if (process.env.STSET_PROBE === "1") {
        const before = placeSnaps.length;
        void before;
        const engineLoads = placeSnaps.filter(p => p.label.startsWith("load "));
        const parts: string[] = [];
        let ok = engineLoads.length >= cases.length;
        engineLoads.forEach((p, i) => {
            const [rot, mir] = cases[i] ?? [-1, -1];
            const f = fields(p.copy);
            const good = f.rotation === rot && f.mirror === mir && f.size.join() === "4,1,3" && f.palette === "default" && f.integrity === 100 && f.mode === 0 && f.seconds === 0;
            if (!good) ok = false;
            parts.push(`${p.label}: rot ${f.rotation} mir ${f.mirror} size ${f.size} offset ${f.offset} pivot ${f.pivot} palette ${f.palette} integrity ${f.integrity} seed ${f.seed} mode ${f.mode} sec ${f.seconds} lastTouched ${f.lastTouched}`);
        });
        say("stset engine settings", ok, `${engineLoads.length} engine-built settings: ${parts.slice(0, 3).join(" | ")}`);
        const piv = engineLoads[0] ? fields(engineLoads[0].copy).pivot : [];
        say("stset engine pivot", piv.join() === "1.5,0,1", `engine pivot for size 4,1,3: ${piv} (bdsx wrote 1.5,0,1 and placed identically above)`);

        // animated, as the command spells it
        placeLabel = "animated";
        const n0 = placeSnaps.length;
        run(`structure load stsetA 2040 ${STY} 14 90_degrees z block_by_block 2`);
        placeLabel = "plain";
        const anim = placeSnaps.slice(n0).find(p => p.label === "animated");
        if (anim === undefined) {
            say("stset animation", false, "the hook saw no tryPlaceStructureInWorld for the animated load");
        } else {
            const f = fields(anim.copy);
            const st = anim.copy.as(StructureSettings);
            const plain = placeSnaps.find(p => p.label === "load 0 0")!.copy.as(StructureSettings);
            say("stset animation", f.mode !== 0 && f.seconds === 2 && f.rotation === 1 && f.mirror === 2 && st.getAnimationTicks() === 40 && st.isAnimated() === true &&
                plain.getAnimationTicks() === 0 && plain.isAnimated() === false,
                `"90_degrees z block_by_block 2": mode ${f.mode}, seconds ${f.seconds}, rotation ${f.rotation}, mirror ${f.mirror}; getAnimationTicks ${st.getAnimationTicks()}, isAnimated ${st.isAnimated()}; the plain load: ${plain.getAnimationTicks()}, ${plain.isAnimated()}`);
        }
    } else {
        say("stset engine settings", null, "STSET_PROBE=1 not set: the tryPlaceStructureInWorld hook is off");
    }

    // ---- 7. the two flags that had only static evidence: reloadActorEquipment and ignoreJigsawBlocks
    {
        // 7a. reloadActorEquipment: the engine calls its equipment reload after each loaded entity only when the byte is set
        if (process.env.STSET_PROBE === "1") {
            const placeEntities = (ox: number, reload: boolean): { calls: number; stands: number; types: string[] } => {
                run(`kill @e[type=armor_stand]`);
                const c0 = reloadCalls, t0 = reloadTypes.length;
                const s = mk();
                s.setStructureSize(BlockPos.create(4, 1, 3));
                s.setReloadActorEquipment(reload);
                tA.placeInWorld(region, pal, BlockPos.create(ox, STY, 60), s);
                s[NativeType.dtor]();
                const raw = s as any as AllocatedPointer;
                void raw;
                return { calls: reloadCalls - c0, stands: 0, types: reloadTypes.slice(t0) };
            };
            const off = placeEntities(2010, false);
            const on = placeEntities(2020, true);
            const off2 = placeEntities(2030, false);
            const cmd0 = reloadCalls;
            run(`structure load stsetA 2040 ${STY} 60`);
            const cmdCalls = reloadCalls - cmd0;
            say("stset reload flag", off.calls === 0 && off2.calls === 0 && on.calls === 1 && on.types[0] === "minecraft:armor_stand",
                `placeInWorld with the entity (armor stand): reload false ${off.calls} calls, true ${on.calls} call(s) (${on.types}), false again ${off2.calls}; /structure load ${cmdCalls} call(s)`);
        } else {
            say("stset reload flag", null, "STSET_PROBE=1 not set");
        }

        // 7b. ignoreJigsawBlocks: a structure holding a jigsaw block
        const JX = 2070;
        run(`fill ${JX} ${STY} ${STZ} ${JX + 2} ${STY} ${STZ} stone`);
        run(`setblock ${JX + 1} ${STY} ${STZ} jigsaw`);
        run(`setblock ${JX + 2} ${STY} ${STZ} gold_block`);
        const seenJ = bn(region, JX + 1, STY, STZ);
        const tJ = sm.getOrCreate("mystructure:stsetJ");
        const sj = mk();
        sj.setStructureSize(BlockPos.create(3, 1, 1));
        sj.setIgnoreEntities(true);
        tJ.fillFromWorld(region, BlockPos.create(JX, STY, STZ), sj);
        sj[NativeType.dtor]();
        const inTemplate = at(tJ, 1, 0, 0);
        const placeJ = (ox: number, ignore: boolean): string => {
            run(`fill ${ox} ${STY} 66 ${ox + 2} ${STY} 66 air`);
            const s = mk();
            s.setStructureSize(BlockPos.create(3, 1, 1));
            s.setIgnoreEntities(true);
            s.setIgnoreJigsawBlocks(ignore);
            tJ.placeInWorld(region, pal, BlockPos.create(ox, STY, 66), s);
            s[NativeType.dtor]();
            return [0, 1, 2].map(d => bn(region, ox + d, STY, 66)).join();
        };
        const jOff = placeJ(2010, false), jOn = placeJ(2020, true);
        run(`structure load stsetJ 2030 ${STY} 66`);
        const jCmd = [0, 1, 2].map(d => bn(region, 2030 + d, STY, 66)).join();
        say("stset jigsaw flag", seenJ === "jigsaw" && inTemplate === "jigsaw" && jOff !== jOn,
            `source middle block ${seenJ}, in the template ${inTemplate}; placeInWorld ignoreJigsawBlocks false: ${jOff}; true: ${jOn}; /structure load: ${jCmd}`);
        for (const ox of [2010, 2020, 2030]) run(`fill ${ox} ${STY} 66 ${ox + 2} ${STY} 66 air`);
        run(`fill ${JX} ${STY} ${STZ} ${JX + 2} ${STY} ${STZ} air`);
        run(`structure delete stsetJ`);
        run(`fill 2010 ${STY} 60 2045 ${STY} 63 air`);
        run(`kill @e[type=armor_stand]`);
    }

    // ---- clean-up
    run(`fill ${STX - 5} ${STY} ${STZ - 5} ${STX + 45} ${STY} ${STZ + 60} air`);
    run(`kill @e[type=armor_stand]`);
    for (const n of ["stsetA", "stsetB", "stsetC", "stsetU"]) run(`structure delete ${n}`);
    say("stset done", null, "cleaned up");
}
