// Execution check for the item component vftables (docs/findings-nbt.md section 22) and the
// FreezeOnHitSubcomponent table (same section).
//
// Deployed as zz-icprobe beside example_and_test and driven from the console (tools/run-full.ps1 -Commands):
//   icprobe sweep   builds an ItemStack for each name in ITEMS (bdsx's ItemStack.constructWith), and for every item that
//                   has a component map asks it for each of the nineteen component ids bdsx knows. A component the
//                   item holds must come back as bdsx's own JS class for that id (ItemComponent.setResolver keys the
//                   class on the object's +0 vptr, which must equal the table the symbol file names), and the
//                   component's own buildNetworkTag must equal the entry the engine's ComponentItem::buildNetworkTag
//                   writes under that id. Every other id the engine's tag lists must NOT resolve to one of the
//                   nineteen classes (no mixing).
//   icprobe freeze  FreezeOnHitSubcomponent through bdsx's OnHitSubcomponent bindings (procHacker.jsv on the table):
//                   an object built in bdsx memory the way the engine's factory builds one (0x18 bytes, vptr at +0),
//                   getName, writetoJSON, and on 1.26.40 readfromJSON (1.26.51 replaced that slot).
// Every line is tagged [icprobe] and states the expectation it checks.
import { freezeOnHitReadJson } from "bdsx/bds/engine/freezeonhit";
import { OnHitSubcomponent } from "bdsx/bds/components";
import { JsonValue, JsonValueType } from "bdsx/bds/connreq";
import { componentItemReflectionCtx } from "bdsx/bds/engine/item";
import { Actor, ActorType } from "bdsx/bds/actor";
import { BlockSource } from "bdsx/bds/block";
import { Vec3 } from "bdsx/bds/blockpos";
import { ComponentItem, ItemStack } from "bdsx/bds/inventory";
import { Player, SimulatedPlayer } from "bdsx/bds/player";
import { bedrockServer } from "bdsx/launcher";
import { procHacker } from "bdsx/prochacker";
import { CompoundTag, NBT } from "bdsx/bds/nbt";
import {
    ArmorItemComponent,
    cereal,
    CooldownItemComponent,
    DiggerItemComponent,
    DisplayNameItemComponent,
    DurabilityItemComponent,
    EntityPlacerItemComponent,
    FoodItemComponent,
    FuelItemComponent,
    IconItemComponent,
    ItemComponent,
    OnUseItemComponent,
    PlanterItemComponent,
    ProjectileItemComponent,
    RecordItemComponent,
    RenderOffsetsItemComponent,
    RepairableItemComponent,
    ShooterItemComponent,
    ThrowableItemComponent,
    WeaponItemComponent,
    WearableItemComponent,
} from "bdsx/bds/item_component";
import { proc } from "bdsx/bds/symbols";
import { AllocatedPointer, NativePointer, StaticPointer, VoidPointer } from "bdsx/core";
import { dllraw } from "bdsx/dllraw";
import { events } from "bdsx/event";
import { makefunc } from "bdsx/makefunc";
import { asm, Register } from "bdsx/assembler";
import { CxxString, float32_t, int32_t } from "bdsx/nativetype";
import { pdbcache } from "bdsx/pdbcache";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[icprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
const rva = (p: VoidPointer): string => "0x" + (p as NativePointer).subptr(dllraw.current).toString(16);

type Cls = new () => ItemComponent;
// id -> [bdsx class, the symbol the resolver keys it on]
const COMPS: [string, Cls, string][] = [
    ["minecraft:cooldown", CooldownItemComponent, "??_7CooldownItemComponent@@6B@"],
    ["minecraft:armor", ArmorItemComponent, "??_7ArmorItemComponent@@6B@"],
    ["minecraft:durability", DurabilityItemComponent, "??_7DurabilityItemComponent@@6B@"],
    ["minecraft:digger", DiggerItemComponent, "??_7DiggerItemComponent@@6B@"],
    ["minecraft:display_name", DisplayNameItemComponent, "??_7DisplayNameItemComponent@@6B@"],
    ["minecraft:entity_placer", EntityPlacerItemComponent, "??_7EntityPlacerItemComponent@@6B@"],
    ["minecraft:food", FoodItemComponent, "??_7FoodItemComponent@@6B?$NetworkedItemComponent@VFoodItemComponent@@@@@"],
    ["minecraft:fuel", FuelItemComponent, "??_7FuelItemComponent@@6B@"],
    ["minecraft:icon", IconItemComponent, "??_7IconItemComponent@@6B@"],
    ["minecraft:on_use", OnUseItemComponent, "??_7OnUseItemComponent@@6B@"],
    ["minecraft:block_placer", PlanterItemComponent, "??_7PlanterItemComponent@@6B@"],
    ["minecraft:projectile", ProjectileItemComponent, "??_7ProjectileItemComponent@@6B@"],
    ["minecraft:record", RecordItemComponent, "??_7RecordItemComponent@@6B@"],
    ["minecraft:render_offsets", RenderOffsetsItemComponent, "??_7RenderOffsetsItemComponent@@6B@"],
    ["minecraft:repairable", RepairableItemComponent, "??_7RepairableItemComponent@@6B@"],
    ["minecraft:shooter", ShooterItemComponent, "??_7ShooterItemComponent@@6B@"],
    ["minecraft:throwable", ThrowableItemComponent, "??_7ThrowableItemComponent@@6B@"],
    ["minecraft:weapon", WeaponItemComponent, "??_7WeaponItemComponent@@6B@"],
    ["minecraft:wearable", WearableItemComponent, "??_7WearableItemComponent@@6B@"],
];
const MAPPED = new Set<Function>(COMPS.map(c => c[1]));

// broad on purpose: 1.26 still has many native items with no component map, so which item carries which component
// is read off the engine's own network tag rather than assumed
const ITEMS = (
    "apple bread cooked_beef carrot potato baked_potato beetroot melon_slice sweet_berries glow_berries cookie pumpkin_pie " +
    "golden_carrot golden_apple enchanted_golden_apple chorus_fruit dried_kelp honey_bottle rabbit_stew mushroom_stew " +
    "coal charcoal blaze_rod stick bamboo lava_bucket bucket water_bucket " +
    "snowball egg ender_pearl ender_eye experience_bottle splash_potion lingering_potion potion fire_charge wind_charge trident " +
    "bow crossbow arrow tipped_arrow firework_rocket fishing_rod carrot_on_a_stick warped_fungus_on_a_stick flint_and_steel shears " +
    "wooden_sword stone_sword iron_sword diamond_sword netherite_sword mace wooden_pickaxe iron_pickaxe diamond_pickaxe " +
    "iron_axe diamond_shovel diamond_hoe " +
    "leather_helmet leather_chestplate leather_leggings leather_boots chainmail_helmet iron_helmet iron_chestplate " +
    "diamond_helmet diamond_chestplate diamond_leggings diamond_boots golden_helmet netherite_helmet turtle_helmet elytra " +
    "shield wolf_armor iron_horse_armor leather_horse_armor saddle carved_pumpkin " +
    "music_disc_13 music_disc_cat music_disc_pigstep music_disc_otherside music_disc_relic music_disc_creator music_disc_precipice " +
    "pig_spawn_egg zombie_spawn_egg armor_stand painting minecart oak_boat oak_chest_boat end_crystal " +
    "wheat_seeds melon_seeds pumpkin_seeds beetroot_seeds torchflower_seeds pitcher_pod nether_wart cocoa_beans sugar_cane kelp " +
    "oak_sign oak_hanging_sign red_bed cake oak_door iron_door repeater comparator redstone string campfire flower_pot " +
    "goat_horn spyglass brush name_tag lead compass recovery_compass clock bundle totem_of_undying echo_shard trial_key " +
    "ominous_trial_key ominous_bottle armadillo_scute breeze_rod heavy_core book writable_book enchanted_book map empty_map " +
    "bone_meal ink_sac glow_ink_sac red_dye white_dye iron_ingot diamond emerald gold_nugget feather gunpowder bone " +
    "honeycomb nautilus_shell heart_of_the_sea nether_star dragon_breath phantom_membrane rabbit_foot glistering_melon_slice " +
    "spider_eye fermented_spider_eye magma_cream ghast_tear sugar paper slime_ball clay_ball brick netherite_ingot " +
    "prismarine_shard amethyst_shard copper_ingot stone oak_log torch " +
    // the throwaway behaviour pack's items (tools/host/icpack.ps1): absent when the pack is not installed
    "bdsxprobe:shooter bdsxprobe:armor bdsxprobe:repair bdsxprobe:food bdsxprobe:throw bdsxprobe:placer"
).split(" ");
const fullName = (name: string): string => (name.includes(":") ? name : `minecraft:${name}`);

/** every "minecraft:*" key anywhere in a tag's value, with the value under it */
function componentKeys(v: any): Map<string, any> {
    const out = new Map<string, any>();
    const walk = (o: any): void => {
        if (o === null || typeof o !== "object") return;
        for (const k of Object.keys(o)) {
            if (k.startsWith("minecraft:") && !out.has(k)) out.set(k, o[k]);
            walk(o[k]);
        }
    };
    walk(v);
    return out;
}

function sweep(): void {
    const seen = new Map<string, { items: string[]; bad: string[]; vptrs: Set<string>; tagOk: number; tagBad: string[] }>();
    for (const [id] of COMPS) seen.set(id, { items: [], bad: [], vptrs: new Set(), tagOk: 0, tagBad: [] });
    const mixing: string[] = [];
    const unknownKeys = new Map<string, string>();
    let made = 0,
        compItems = 0,
        failedMake = 0;
    for (const name of ITEMS) {
        let stack: ItemStack;
        try {
            stack = ItemStack.constructWith(fullName(name));
        } catch (err) {
            failedMake++;
            continue;
        }
        try {
            if (stack.isNull()) {
                failedMake++;
                continue;
            }
            made++;
            const ci = stack.getComponentItem();
            if (ci === null) continue;
            compItems++;
            const whole = (ci as ComponentItem).buildNetworkTag();
            const keys = whole === null ? new Map<string, any>() : componentKeys(whole.value());
            if (whole !== null) whole.dispose();
            for (const [id, cls, sym] of COMPS) {
                const c = ci.getComponent(id);
                if (c === null) continue;
                const s = seen.get(id)!;
                s.items.push(name);
                const vp = (c as any as StaticPointer).getPointer(0);
                s.vptrs.add(rva(vp));
                const table = proc[sym];
                if (!(c instanceof cls) || table.isNull() || !vp.equalsptr(table)) {
                    s.bad.push(`${name}: ${c.constructor.name} vptr ${rva(vp)} (table ${table.isNull() ? "missing" : rva(table)})`);
                }
                // the engine's own tag for this item lists the component: the object bdsx resolved writes the same entry
                if (keys.has(id)) {
                    try {
                        const mine = c.buildNetworkTag();
                        const a = mine === null || (mine as unknown as VoidPointer).isNull() ? "null" : JSON.stringify(mine.value());
                        if (mine !== null && !(mine as unknown as VoidPointer).isNull()) mine.dispose();
                        const e = JSON.stringify(keys.get(id));
                        if (a === e) s.tagOk++;
                        else s.tagBad.push(`${name}: bdsx ${a.slice(0, 120)} vs engine ${e.slice(0, 120)}`);
                    } catch (err) {
                        s.tagBad.push(`${name}: buildNetworkTag threw ${(err as Error).message}`);
                    }
                }
            }
            // ids the engine lists that bdsx has no class for must come back as the base class, never as one of ours
            for (const k of keys.keys()) {
                if (COMPS.some(c => c[0] === k)) continue;
                const c = ci.getComponent(k);
                if (c === null) continue;
                if (!unknownKeys.has(k)) unknownKeys.set(k, `${name}:${rva((c as any as StaticPointer).getPointer(0))}`);
                if (MAPPED.has(c.constructor)) mixing.push(`${name} ${k} -> ${c.constructor.name}`);
            }
        } finally {
            stack.destruct();
        }
    }
    say("items", null, `${made} built, ${failedMake} not, ${compItems} with a component map`);
    for (const [id, cls] of COMPS) {
        const s = seen.get(id)!;
        if (s.items.length === 0) {
            say(id, null, `no item of the ${ITEMS.length} holds it (static only)`);
            continue;
        }
        say(
            `${id} -> ${cls.name}`,
            s.bad.length === 0,
            `${s.items.length} item(s) [${s.items.slice(0, 6).join(",")}${s.items.length > 6 ? ",..." : ""}], vptr ${[...s.vptrs].join("/")}` +
                (s.bad.length ? `; WRONG: ${s.bad.slice(0, 4).join("; ")}` : ", the shipped table, resolves as its own class"),
        );
        if (s.tagOk + s.tagBad.length > 0) {
            say(`${id} network tag`, s.tagBad.length === 0, `${s.tagOk} item(s) where bdsx's buildNetworkTag on it equals the engine's entry` + (s.tagBad.length ? `; DIFFER: ${s.tagBad.slice(0, 3).join("; ")}` : ""));
        } else {
            say(`${id} network tag`, null, "the engine's item tag does not list it (not a networked component)");
        }
    }
    say("no mixing", mixing.length === 0, `${unknownKeys.size} other component id(s) resolve as the base class [${[...unknownKeys.keys()].join(",")}]` + (mixing.length ? `; MIXED: ${mixing.join("; ")}` : ""));
}

const Json$ctorType = makefunc.js(proc["??0Value@Json@@QEAA@W4ValueType@1@@Z"], JsonValue, null, JsonValue, int32_t);
function freeze(): void {
    const table = proc["??_7FreezeOnHitSubcomponent@@6B@"];
    if (table.isNull()) {
        say("table", false, "??_7FreezeOnHitSubcomponent@@6B@ has no address");
        return;
    }
    const make = (isSphere: number, size: number, snap: number): AllocatedPointer => {
        // the engine's factory (40 0x1acebd0 / 51 0x24c6450): 0x18 bytes, zeroed, vptr at +0
        const p = new AllocatedPointer(0x18);
        p.fill(0, 0x18);
        p.setPointer(table, 0);
        p.setUint8(isSphere, 0x8);
        p.setFloat32(size, 0xc);
        p.setUint8(snap, 0x10);
        return p;
    };
    const fields = (p: AllocatedPointer): string => `+0x8 ${p.getUint8(0x8)}, +0xc ${p.getFloat32(0xc)}, +0x10 ${p.getUint8(0x10)}`;
    const a = make(1, 2.5, 1);
    const sub = a.as(OnHitSubcomponent);
    const name = sub.getName();
    say("getName", name === "freeze_on_hit", `${JSON.stringify(name)} (want "freeze_on_hit"), table ${rva(table)}`);
    const writeOf = (p: AllocatedPointer): any => {
        const j = new JsonValue(true);
        Json$ctorType(j, JsonValueType.Object);
        p.as(OnHitSubcomponent).writetoJSON(j);
        return j;
    };
    const j1 = writeOf(a);
    const v1 = j1.value();
    say(
        "writetoJSON",
        v1 !== null && v1.size === 2.5 && v1.snap_to_block === true && v1.shape === "sphere",
        `${JSON.stringify(v1)} (want size 2.5, snap_to_block true, shape "sphere" from +0xc/+0x10/+0x8)`,
    );
    const b = make(0, 0.75, 0);
    const j2 = writeOf(b);
    const v2 = j2.value();
    say("writetoJSON other side", v2 !== null && v2.size === 0.75 && v2.snap_to_block === false && v2.shape === "cube", `${JSON.stringify(v2)} (want 0.75, false, "cube")`);
    const empty = new JsonValue(true);
    Json$ctorType(empty, JsonValueType.Object);
    const native = pdbcache.search("?readfromJSON@FreezeOnHitSubcomponent@@UEAAXAEAVValue@Json@@AEBVSemVersion@@@Z") !== -1;
    // bdsx's readfromJSON: the engine's on 40, engine/freezeonhit.ts on 51 (the derived over the parsed value). The JS reader is also
    // run by hand on both builds; on 40 that is the check against the engine's own answer, {} included (defaults 1.0 / false / cube)
    const cases: [string, JsonValue, string][] = [
        ["first JSON", j1, "+0x8 1, +0xc 2.5, +0x10 1"],
        ["second JSON", j2, "+0x8 0, +0xc 0.75, +0x10 0"],
        ["empty object", empty, "+0x8 0, +0xc 1, +0x10 0"],
    ];
    const viaBdsx: string[] = [];
    const viaJs: string[] = [];
    let ok = true;
    for (const [label, json, want] of cases) {
        const c = make(1, 9, 1);
        c.as(OnHitSubcomponent).readfromJSON(json);
        const f1 = fields(c);
        const d = make(1, 9, 1);
        freezeOnHitReadJson(d, json);
        const f2 = fields(d);
        viaBdsx.push(`${label} ${f1}`);
        viaJs.push(`${label} ${f2}`);
        if (f1 !== want || f2 !== want) ok = false;
    }
    say("readfromJSON", ok, `${native ? "engine's own" : "engine/freezeonhit.ts"}: ${viaBdsx.join("; ")}; the JS reader by hand: ${viaJs.join("; ")} (want 1/2.5/1, 0/0.75/0, 0/1/0 -- the objects start as 1/9/1)`);
    empty.destruct();
    j1.destruct();
    j2.destruct();
}

// The components no vanilla item holds on 1.26 (every item that would carry them is native). The object is built in
// bdsx memory the way the item's factory would leave it before loading: the component's size (what its deleting
// destructor frees, both builds), zeroed, the table at +0. The table's own slot 4 (reached through bdsx's
// ItemComponent.buildNetworkTag, which dispatches on the object's vptr) must write that component's schema, and
// slot 5 must read a changed value back in. Zeroed members are empty vectors/strings; Shooter holds an
// ItemDescriptor (a vptr) and is left out.
const SYNTH: Record<string, { sym: string; size: number; keys: string[]; flip?: [string, () => any]; pre?: (p: AllocatedPointer) => void }> = {
    // the zeroed armor writes {} (40 and 51 alike): its fields are set first, so an empty schema shows as an empty tag
    armor: { sym: "??_7ArmorItemComponent@@6B@", size: 0x10, keys: ["protection"], flip: ["protection", () => NBT.int(9)], pre: p => { p.setInt32(7, 8); p.setInt32(7, 0xc); } },
    render_offsets: { sym: "??_7RenderOffsetsItemComponent@@6B@", size: 0xa0, keys: ["main_hand", "off_hand"] },
    digger: { sym: "??_7DiggerItemComponent@@6B@", size: 0x30, keys: ["destroy_speeds", "use_efficiency"], flip: ["use_efficiency", () => NBT.byte(1)] },
    repairable: { sym: "??_7RepairableItemComponent@@6B@", size: 0x28, keys: ["repair_items"] },
    // an empty "entity" is refused by its initializeFromNetwork (false), so the flip names a real one
    entity_placer: { sym: "??_7EntityPlacerItemComponent@@6B@", size: 0x108, keys: ["entity", "use_on", "dispense_on"], flip: ["entity", () => "minecraft:pig"] },
};
function synth(which: string): void {
    const d = SYNTH[which];
    if (d === undefined) {
        say("synth", false, `unknown component '${which}'`);
        return;
    }
    const table = proc[d.sym];
    if (table.isNull()) {
        say(`synth ${which}`, false, `${d.sym} has no address`);
        return;
    }
    // any component item holds the engine's ReflectionCtx; the apple is one on both builds
    const apple = ItemStack.constructWith("minecraft:apple");
    try {
        const ci = apple.getComponentItem();
        const ctxPtr = ci === null ? null : componentItemReflectionCtx(ci as unknown as StaticPointer);
        if (ctxPtr === null) {
            say(`synth ${which}`, false, "no ReflectionCtx (the apple is not a component item)");
            return;
        }
        const ctx = ctxPtr.as(cereal.ReflectionCtx);
        const p = new AllocatedPointer(d.size);
        p.fill(0, d.size);
        p.setPointer(table, 0);
        if (d.pre !== undefined) d.pre(p);
        const comp = p.as(ItemComponent);
        const t0 = comp.buildNetworkTag(ctx);
        if (t0 === null || (t0 as unknown as VoidPointer).isNull()) {
            say(`synth ${which}`, false, `table ${rva(table)}: buildNetworkTag returned null`);
            return;
        }
        const v0 = t0.value();
        const s0 = JSON.stringify(v0);
        const have = componentKeys({ x: v0 }); // top-level keys too
        const top = Object.keys(v0 ?? {});
        const missing = d.keys.filter(k => !top.includes(k) && !have.has(k));
        if (top.length === 0) {
            say(`synth ${which} schema`, null, `table ${rva(table)}: the engine's slot 4 writes {} even with the fields set (${d.pre !== undefined ? "+0x8/+0xc = 7" : "zeroed"}): no networked field to tell it by, static only`);
            t0.dispose();
            return;
        }
        say(`synth ${which} schema`, missing.length === 0, `table ${rva(table)} (0x${d.size.toString(16)} bytes, zeroed): the engine's slot 4 writes ${s0.slice(0, 300)} (want keys ${d.keys.join(",")}${missing.length ? `; MISSING ${missing.join(",")}` : ""})`);
        // slot 5 reads its own tag back unchanged
        const r1 = comp.initializeFromNetwork(t0, ctx);
        t0.dispose();
        const t1 = comp.buildNetworkTag(ctx);
        const s1 = JSON.stringify(t1.value());
        t1.dispose();
        say(`synth ${which} round trip`, s1 === s0, `initializeFromNetwork(own tag) ${!!r1}, rebuilt ${s1 === s0 ? "identical" : s1.slice(0, 200)}`);
        if (d.flip !== undefined && !(d.flip[0] in (v0 ?? {}))) {
            say(`synth ${which} ${d.flip[0]}`, null, "not a top-level key of the tag, not flipped");
        } else if (d.flip !== undefined) {
            const [key, val] = d.flip;
            const v = JSON.parse(JSON.stringify(v0)) as any;
            (v0 as any)[key] = val();
            const flipped = NBT.allocate(v0) as CompoundTag;
            // ActorDefinitionIdentifier writes its full name back, "<init event>" appended (seen in the 2026-09-28 pair:
            // "minecraft:pig<>"); this corrected expectation has not been run yet
            if (which === "entity_placer") (v0 as any)[key] = "minecraft:pig<>";
            const want = JSON.stringify(which === "entity_placer" ? v0 : flipped.value());
            const r2 = comp.initializeFromNetwork(flipped, ctx);
            flipped.dispose();
            const t2 = comp.buildNetworkTag(ctx);
            const s2 = JSON.stringify(t2.value());
            t2.dispose();
            say(`synth ${which} ${key}`, !!r2 && s2 === want && s2 !== s0, `initializeFromNetwork with ${key} changed ${!!r2}: rebuilt ${s2.slice(0, 200)} (want ${want.slice(0, 200)}, not the zero object's); shape ${Object.keys(v).join(",")}`);
        }
    } finally {
        apple.destruct();
    }
}


// ---------------------------------------------------------------------------------------------------------------
// The component methods (docs/findings-nbt.md "The rest of the item components"). The engine-side references:
//   throw <label> <yaw> <pitch>  icsim throws the snowball in its hotbar slot 0 (SimulatedPlayer::simulateUseItemInSlot). The
//                        engine's own throw (ThrowableItemComponent's use callback -> _doThrow, which inlines
//                        getShootDir and _getLaunchPower) calls ProjectileItemComponent::shootProjectile, which bdsx
//                        hooks here: the direction and power the engine computed are its arguments. bdsx's
//                        getShootDir(icsim, 0) and getLaunchPower (both derived()) must give the same numbers.
//   shoot                bdsx's own shootProjectile call on a snowball's ProjectileItemComponent: a snowball comes back
//                        and flies along the direction bdsx passed; with no player the engine refuses (null).
//   launch               getLaunchPower on bdsxprobe:throw (scale_power_by_draw_duration on) and on the snowball (off),
//                        against the field values the engine's own network tag reports.
//   repair               handleItemRepair on bdsxprobe:repair (max durability 100, repair_items diamond x25).
//   name                 setActorCustomName: a named item names a pig, an unnamed one leaves the other pig alone.
//   food                 getUsingConvertsToItemDescriptor on bdsxprobe:food (using_converts_to minecraft:bowl) and the
//                        apple (none), against the engine's network tag.
let icsim: SimulatedPlayer | null = null;
const SHOOT_KEY = "?shootProjectile@ProjectileItemComponent@@QEBAPEAVActor@@AEAVBlockSource@@AEBVVec3@@1MPEAVPlayer@@@Z";
interface Shot {
    comp: string;
    pos: number[];
    dir: number[];
    power: number;
    player: string;
    ret: string;
}
const shots: Shot[] = [];
let shootHooked = false;
function hookShoot(): void {
    if (shootHooked) return;
    shootHooked = true;
    const orig = procHacker.hooking(
        SHOOT_KEY,
        Actor,
        { this: ProjectileItemComponent },
        BlockSource,
        Vec3,
        Vec3,
        float32_t,
        Player,
    )(function (this: ProjectileItemComponent, region: BlockSource, pos: Vec3, dir: Vec3, power: number, player: Player | null): Actor | null {
        const rec: Shot = {
            comp: rva((this as any as StaticPointer).getPointer(0)),
            pos: [pos.x, pos.y, pos.z],
            dir: [dir.x, dir.y, dir.z],
            power,
            player: player === null ? "null" : player.getName(),
            ret: "",
        };
        const r = orig.call(this, region, pos, dir, power, player);
        rec.ret = r === null ? "null" : r.getIdentifier();
        shots.push(rec);
        return r as Actor;
    });
}
const v3 = (a: number[]): string => `(${a.map(x => x.toFixed(6)).join(", ")})`;
const vecOf = (v: Vec3): number[] => [v.x, v.y, v.z];
const maxDiff = (a: number[], b: number[]): number => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

function compOf<T extends ItemComponent>(stack: ItemStack, id: string): T | null {
    const ci = stack.getComponentItem();
    if (ci === null) return null;
    return ci.getComponent(id) as T | null;
}
/** the engine's own network-tag entry for one component of an item */
function engineEntry(stack: ItemStack, id: string): any {
    const ci = stack.getComponentItem();
    if (ci === null) return undefined;
    const whole = (ci as ComponentItem).buildNetworkTag();
    if (whole === null) return undefined;
    const v = componentKeys(whole.value()).get(id);
    whole.dispose();
    return v;
}

function simStep(): void {
    if (icsim === null) icsim = SimulatedPlayer.create("icsim", { x: 29, y: 68, z: 18 }, 0);
    say("sim", icsim !== null, `icsim ${icsim === null ? "not created" : "at " + icsim.getPosition().toString()}`);
}

function icsimAlive(): boolean {
    return icsim !== null && bedrockServer.level.getPlayers().some(p => p.getName() === "icsim");
}
function throwStep(label: string, yaw: number, setPitch: number): void {
    hookShoot();
    if (!icsimAlive()) {
        say(`throw ${label}`, false, "icsim is not in the level (re-created for the next step)");
        icsim = null;
        simStep();
        return;
    }
    if (icsim === null) return;
    // the snowball goes in right here, so nothing between the steps can take it away
    bedrockServer.executeCommand("replaceitem entity icsim slot.hotbar 0 snowball 16");
    // a simulated player's pitch goes back to 0 every tick (tp's pitch does not stay, simulateLookAt has no address on
    // 1.26), so the step writes yaw and pitch into the rotation getRotation points at, in this same call: the engine's
    // throw reads the same Actor+0x228 rotation a few instructions later
    const rot = icsim.getRotation();
    rot.y = yaw;
    rot.x = setPitch;
    const slot0 = icsim.getInventory().container.getItem(0);
    const proj = compOf<ProjectileItemComponent>(slot0, "minecraft:projectile");
    const thr = compOf<ThrowableItemComponent>(slot0, "minecraft:throwable");
    if (proj === null || thr === null) {
        say(`throw ${label}`, false, `slot 0 ${slot0.toString()} has no projectile/throwable component`);
        return;
    }
    const mine = vecOf(proj.getShootDir(icsim, 0));
    const minePower = thr.getLaunchPower(0, 20, 0);
    const n0 = shots.length;
    const used = icsim.simulateUseItemInSlot(0);
    const shot = shots.length > n0 ? shots[n0] : null;
    if (shot === null) {
        say(`throw ${label}`, false, `simulateUseItemInSlot(0) ${used}, the engine never called shootProjectile (rotation ${rot.x} ${rot.y})`);
        return;
    }
    const d = maxDiff(mine, shot.dir);
    // the pitch the step is about: level (as tp left it), or up/down (written above)
    // and the engine saw it: the direction's y is -sin(pitch), so it must be clearly up or down (a copy would leave 0)
    const pitchOk = label === "level" ? Math.abs(rot.x) < 1 && Math.abs(shot.dir[1]) < 1e-6 : label === "up" ? rot.x < -5 && shot.dir[1] > 0.3 : rot.x > 5 && shot.dir[1] < -0.3;
    say(
        `throw ${label} getShootDir`,
        pitchOk && d < 1e-6 && shot.player === "icsim" && shot.ret === "minecraft:snowball",
        `rotation pitch ${rot.x} yaw ${rot.y}; the engine's throw passed dir ${v3(shot.dir)} to shootProjectile (component ${shot.comp}, player ${shot.player}, returned ${shot.ret}); bdsx getShootDir(icsim, 0) ${v3(mine)}, max diff ${d.toExponential(2)} (want < 1e-6)`,
    );
    say(`throw ${label} getLaunchPower`, Math.abs(minePower - shot.power) < 1e-6, `the engine's power ${shot.power}; bdsx getLaunchPower(0, 20, 0) on the same item's throwable ${minePower}`);
    const r90 = vecOf(proj.getShootDir(icsim, 90));
    say(`throw ${label} offset`, null, `getShootDir(icsim, 90) ${v3(r90)}: 2024's rotation about Y (x cos + z sin, z cos - x sin) of ${v3(mine)}`);
}

function shootStep(): void {
    hookShoot();
    if (!icsimAlive() || icsim === null) {
        say("shoot", false, "icsim is not in the level");
        return;
    }
    const sim = icsim;
    const stack = ItemStack.constructWith("minecraft:snowball");
    try {
        const proj = compOf<ProjectileItemComponent>(stack, "minecraft:projectile");
        if (proj === null) {
            say("shoot", false, "the snowball has no minecraft:projectile");
            return;
        }
        const region = sim.getRegion();
        // south and nearly level, down the cleared strip (z 18.5 -> 24), so nothing stops it before the flight check
        const r0 = sim.getRotation();
        r0.y = 0;
        r0.x = -5;
        const p = sim.getPosition();
        const pos = Vec3.create(p.x, p.y - 0.1, p.z);
        const p0 = [pos.x, pos.y, pos.z];
        const dir = proj.getShootDir(sim, 0);
        const d = vecOf(dir);
        const n0 = shots.length;
        const actor = proj.shootProjectile(region, pos, dir, 1.5, sim);
        const hooked = shots.length > n0 ? shots[n0] : null;
        const id = actor === null ? "null" : actor.getIdentifier();
        say(
            "shoot",
            actor !== null && id === "minecraft:snowball" && hooked !== null && hooked.power === 1.5 && maxDiff(hooked.dir, d) < 1e-6,
            `bdsx shootProjectile(region, ${v3(p0)}, dir ${v3(d)}, 1.5, icsim) -> ${id}; the hook saw power ${hooked?.power} dir ${hooked === null ? "-" : v3(hooked.dir)}`,
        );
        if (actor !== null) {
            const uid = actor.getUniqueIdBin();
            setTimeout(() => {
                try {
                    let a: Actor | null;
                    try {
                        a = bedrockServer.level.fetchEntity(uid, false);
                    } catch (err) {
                        say("shoot flight", null, `the snowball was removed within 120 ms (${(err as Error).message})`);
                        return;
                    }
                    if (a === null) {
                        say("shoot flight", null, "the snowball was gone 120 ms later");
                        return;
                    }
                    let q: Vec3;
                    try {
                        q = a.getPosition();
                    } catch (err) {
                        say("shoot flight", null, `the snowball's wrapper could not be read 120 ms later (${(err as Error).message})`);
                        return;
                    }
                    const dx = q.x - p0[0],
                        dz = q.z - p0[2];
                    const moved = Math.hypot(dx, dz);
                    const angle = Math.acos(Math.max(-1, Math.min(1, (dx * d[0] + dz * d[2]) / (moved * Math.hypot(d[0], d[2])))));
                    say("shoot flight", moved > 0.5 && angle < 0.05, `120 ms later it is ${v3([q.x, q.y, q.z])}: ${moved.toFixed(2)} blocks sideways, ${angle.toFixed(4)} rad off the direction bdsx passed (want < 0.05)`);
                } catch (err) {
                    say("shoot flight", false, `threw ${(err as Error).message}`);
                }
            }, 120);
        }
        const none = proj.shootProjectile(region, pos, dir, 1.5, null as any);
        say("shoot no player", none === null, `shootProjectile(..., player null) -> ${none === null ? "null" : none.getIdentifier()} (want null: the body returns 0 without a player)`);
    } finally {
        stack.destruct();
    }
}

function launchStep(): void {
    // expected from the fields the engine's own tag reports, by 1.26's inlined formula (both callbacks, 40 0x281e800/0x27cd1c0)
    const expect = (e: any, a: number, b: number, c: number): number => {
        let power = 1;
        if (Number(e.scale_power_by_draw_duration) !== 0) {
            const t = (c - a) / b;
            power = Math.min((t * t + 2 * t) / 3, 1);
        }
        return Math.min(power * Number(e.launch_power_scale), Number(e.max_launch_power));
    };
    for (const name of ["bdsxprobe:throw", "minecraft:snowball"]) {
        let stack: ItemStack;
        try {
            stack = ItemStack.constructWith(name);
        } catch (err) {
            say(`launch ${name}`, false, `constructWith threw ${(err as Error).message}`);
            continue;
        }
        try {
            const thr = compOf<ThrowableItemComponent>(stack, "minecraft:throwable");
            const e = engineEntry(stack, "minecraft:throwable");
            if (thr === null || e === undefined) {
                say(`launch ${name}`, false, `no throwable component (${stack.isNull() ? "the item does not exist" : "not listed"})`);
                continue;
            }
            const rows: string[] = [];
            let ok = true;
            for (const [a, b, c] of [
                [0, 20, 10],
                [0, 20, 40],
                [10, 20, 10],
                [0, 20, 20],
            ]) {
                const got = thr.getLaunchPower(a, b, c);
                const want = Math.fround(expect(e, a, b, c));
                if (Math.abs(got - want) > 1e-5) ok = false;
                rows.push(`(${a},${b},${c}) ${got.toFixed(6)}/${want.toFixed(6)}`);
            }
            say(`launch ${name}`, ok, `engine tag ${JSON.stringify(e)}; bdsx/expected ${rows.join(" ")}`);
        } finally {
            stack.destruct();
        }
    }
}

function repairStep(): void {
    let item: ItemStack;
    try {
        item = ItemStack.constructWith("bdsxprobe:repair");
    } catch (err) {
        say("repair", false, `constructWith threw ${(err as Error).message}`);
        return;
    }
    try {
        const comp = compOf<RepairableItemComponent>(item, "minecraft:repairable");
        if (comp === null) {
            say("repair", false, `bdsxprobe:repair ${item.isNull() ? "does not exist (the pack is not installed?)" : "has no minecraft:repairable"}`);
            return;
        }
        say("repair component", comp instanceof RepairableItemComponent, `${comp.constructor.name}, engine tag ${JSON.stringify(engineEntry(item, "minecraft:repairable"))}`);
        // setDamageValue has no address on 1.26: the Damage user-data int, through save and load
        const saved = item.save();
        saved.tag = { ...(saved.tag ?? {}), Damage: NBT.int(60) };
        item.load(saved);
        if (item.getDamageValue() !== 60) {
            say("repair", false, `could not damage the item: getDamageValue ${item.getDamageValue()} after loading Damage 60`);
            return;
        }
        const cases: [string, number, number, number][] = [
            ["minecraft:diamond", 1, 35, 1],
            ["minecraft:diamond", 3, 0, 3],
            ["minecraft:diamond", 5, 0, 3],
            ["minecraft:stick", 1, -1, 0],
        ];
        for (const [mat, count, wantDamage, wantUsed] of cases) {
            const m = ItemStack.constructWith(mat, count);
            try {
                const r = comp.handleItemRepair(item, m, false);
                const isNull = r.item.isNull();
                const dmg = isNull ? -1 : r.item.getDamageValue();
                const used = r.materialsUsed;
                const name = isNull ? "(empty)" : r.item.getName();
                r.destruct();
                say(
                    `repair ${mat} x${count}`,
                    dmg === wantDamage && used === wantUsed && item.getDamageValue() === 60 && m.getAmount() === count,
                    `result ${name} damage ${dmg}, materials used ${used} (want damage ${wantDamage === -1 ? "none, an empty stack" : wantDamage}, used ${wantUsed}); the input still damage ${item.getDamageValue()}, material count ${m.getAmount()}`,
                );
            } finally {
                m.destruct();
            }
        }
    } finally {
        item.destruct();
    }
}

function nameStep(): void {
    if (!icsimAlive() || icsim === null) {
        say("name", false, "icsim is not in the level");
        return;
    }
    const region = icsim.getRegion();
    const pigs = [Actor.summonAt(region, Vec3.create(31.5, 68, 21.5), ActorType.Pig), Actor.summonAt(region, Vec3.create(27.5, 68, 21.5), ActorType.Pig)];
    if (pigs.some(p => p === null)) {
        say("name", false, `Actor.summonAt gave ${pigs.map(p => (p === null ? "null" : p.getIdentifier())).join(", ")}`);
        return;
    }
    let placerStack: ItemStack | null = null;
    let placer: EntityPlacerItemComponent | null = null;
    let synthMem: AllocatedPointer | null = null;
    try {
        placerStack = ItemStack.constructWith("bdsxprobe:placer");
        placer = compOf<EntityPlacerItemComponent>(placerStack, "minecraft:entity_placer");
    } catch (err) {
        placer = null;
    }
    let from = "bdsxprobe:placer's engine-built component";
    if (placer === null) {
        // 1.26's function takes no component (40 0x3f77080 / 51 0x302a020: rcx is the actor), so any object serves
        synthMem = new AllocatedPointer(0x108);
        synthMem.fill(0, 0x108);
        synthMem.setPointer(proc["??_7EntityPlacerItemComponent@@6B@"], 0);
        placer = synthMem.as(EntityPlacerItemComponent);
        from = "a bdsx-built EntityPlacer (the pack's item is missing)";
    }
    const named = ItemStack.constructWith("minecraft:pig_spawn_egg");
    const plain = ItemStack.constructWith("minecraft:pig_spawn_egg");
    try {
        named.setCustomName("probe-placer-name");
        const [a, b] = pigs;
        const a0 = a.getNameTag(),
            b0 = b.getNameTag();
        placer.setActorCustomName(a, named);
        placer.setActorCustomName(b, plain);
        const a1 = a.getNameTag(),
            b1 = b.getNameTag();
        say("name", a1 === "probe-placer-name" && b1 === b0, `via ${from}: named item: pig name ${JSON.stringify(a0)} -> ${JSON.stringify(a1)} (want "probe-placer-name"); unnamed item: ${JSON.stringify(b0)} -> ${JSON.stringify(b1)} (want unchanged)`);
    } finally {
        named.destruct();
        plain.destruct();
        if (placerStack !== null) placerStack.destruct();
        if (synthMem !== null) synthMem.fill(0, 8);
    }
}

// BaseDescriptor::getFullName, impl_'s vftable slot 3 on both builds (tools/item-probe.ts "descriptor", agent-v)
const BaseDescriptor$getFullName = makefunc.js(
    asm().mov_r_rp(Register.rax, Register.rcx, 1, 0).jmp_rp(Register.rax, 1, 0x18).alloc("icprobe BaseDescriptor::getFullName via vft[3]"),
    CxxString,
    { this: VoidPointer, structureReturn: true },
);
/** the name an ItemDescriptor gives, through its impl_ (null impl_: none) */
function descriptorItem(desc: VoidPointer): string {
    const impl = (desc as StaticPointer).getNullablePointer(8);
    if (impl === null) return "(no impl)";
    return `${BaseDescriptor$getFullName.call(impl)} [impl vptr ${rva(impl.getPointer(0))}]`;
}
function foodStep(): void {
    for (const [name, want] of [
        ["bdsxprobe:food", "minecraft:bowl"],
        ["minecraft:apple", null],
    ] as [string, string | null][]) {
        let stack: ItemStack;
        try {
            stack = ItemStack.constructWith(name);
        } catch (err) {
            say(`food ${name}`, false, `constructWith threw ${(err as Error).message}`);
            continue;
        }
        try {
            const food = compOf<FoodItemComponent>(stack, "minecraft:food");
            const e = engineEntry(stack, "minecraft:food");
            if (food === null || e === undefined) {
                say(`food ${name}`, false, `no food component (${stack.isNull() ? "the item does not exist" : "not listed"})`);
                continue;
            }
            const engine = JSON.stringify(e.using_converts_to);
            const desc = food.getUsingConvertsToItemDescriptor();
            const got = descriptorItem(desc);
            desc.destruct();
            const ok = want === null ? got === "(no impl)" || got.startsWith(" [") : got.startsWith(want + " [") && engine.includes(want);
            say(`food ${name}`, ok, `bdsx getUsingConvertsToItemDescriptor() names ${got}; the engine's tag using_converts_to ${engine.slice(0, 160)} (want ${want ?? "none"})`);
        } finally {
            stack.destruct();
        }
    }
}

function simGone(): void {
    icsim = null; // simulateDisconnect has no address on 1.26; the driver's kill and stop end icsim
    say("sim gone", null, `${shots.length} shootProjectile call(s) seen by the hook`);
}

events.command.on(cmd => {
    const m = /^\/?icprobe(?=\s|$)\s*(.*)$/.exec(cmd);
    if (m === null) return;
    const step = m[1].trim();
    try {
        if (step === "sweep") sweep();
        else if (step === "freeze") freeze();
        else if (step.startsWith("synth ")) synth(step.slice(6).trim());
        else if (step === "sim") simStep();
        else if (step.startsWith("throw ")) {
            const [label, yaw, pitch] = step.slice(6).trim().split(/\s+/);
            throwStep(label, Number(yaw), Number(pitch));
        } else if (step === "shoot") shootStep();
        else if (step === "launch") launchStep();
        else if (step === "repair") repairStep();
        else if (step === "name") nameStep();
        else if (step === "food") foodStep();
        else if (step === "simgone") simGone();
        else say("usage", false, `unknown step '${step}'`);
    } catch (err) {
        say(`step '${step}'`, false, `threw: ${(err as Error).stack}`);
    }
});
