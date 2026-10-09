// The ability block on a live player (docs/findings-abilities.md). 1.26 inlined every Abilities /
// LayeredAbilities / Ability function away, so all of them are bdsx's own bodies over
// symbols.json `layouts` -- six layers of twenty 12-byte records after a 24-byte PermissionsHandler.
// A wrong stride or a wrong layer base would still "work", so the checks are the ones only the real
// layout can pass: the vanilla defaults FlySpeed 0.05 and WalkSpeed 0.1 read as floats, `gamemode`
// moving mayfly/instabuild/invulnerable, and a write landing in the Base layer and nowhere else.
// Deployed as zz-abilprobe.ts; console: "abilprobe base", "gamemode creative @a", "abilprobe creative", ...
import { Abilities, AbilitiesIndex, AbilitiesLayer, Ability, LayeredAbilities } from "bdsx/bds/abilities";
import { serializeLayers, writeUpdateAbilitiesPayload } from "bdsx/bds/engine/abilities";
import { UpdateAbilitiesPacket } from "bdsx/bds/packets";
import { Player } from "bdsx/bds/player";
import { StaticPointer } from "bdsx/core";
import { events } from "bdsx/event";
import { pdbcache } from "bdsx/pdbcache";

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

const say = (ok: boolean, what: string): void => console.log(`[abil] ${ok ? "PASS" : "FAIL"} ${what}`);
const near = (a: number, b: number, e = 1e-4): boolean => Math.abs(a - b) <= e;
const layout = (): { layers: number; layerStride: number; layerCount: number; abilityStride: number; abilityCount: number } => ({
    layers: pdbcache.layouts.LayeredAbilities?.layers ?? 4,
    layerStride: pdbcache.layouts.LayeredAbilities?.layerStride ?? 228,
    layerCount: pdbcache.layouts.LayeredAbilities?.layerCount ?? 5,
    abilityStride: pdbcache.layouts.Abilities?.abilityStride ?? 12,
    abilityCount: pdbcache.layouts.Abilities?.abilityCount ?? 19,
});

/** the topmost layer that has the index set, or -1 -- the walk getAbility(index) runs, spelled out */
function layerOf(a: LayeredAbilities, index: AbilitiesIndex): number {
    const l = layout();
    for (let layer = l.layerCount - 1; layer >= 0; layer--) {
        if (a.getAbility(layer as AbilitiesLayer, index).type !== Ability.Type.Unset) return layer;
    }
    return -1;
}

/** every index that has a record set anywhere, as "index=value" -- the dump the other checks read */
function dump(a: LayeredAbilities): string {
    const l = layout(),
        out: string[] = [];
    for (let i = 0; i < l.abilityCount; i++) {
        const ability = a.getAbility(i);
        const type = ability.type;
        if (type === Ability.Type.Unset || type === Ability.Type.Invalid) continue;
        out.push(`${i}=${type === Ability.Type.Bool ? (ability.getBool() ? "true" : "false") : ability.getFloat().toFixed(3)}`);
    }
    return out.join(" ");
}

events.command.on(cmd => {
    const parts = cmd.replace(/^\//, "").trim().split(/\s+/);
    if (parts[0] !== "abilprobe") return;
    const sub = parts[1] ?? "base";
    if (player === null) {
        console.log("[abil] FAIL no player");
        return;
    }
    const p = player,
        l = layout();
    let abilities: LayeredAbilities;
    try {
        abilities = p.getAbilities();
    } catch (err) {
        console.log(`[abil] FAIL getAbilities threw ${(err as Error).message}`);
        return;
    }
    const base = abilities as any as StaticPointer;
    try {
        switch (sub) {
            case "base": {
                console.log(`[abil] layout layers=${l.layers} stride=${l.layerStride} count=${l.layerCount} ability=${l.abilityStride}x${l.abilityCount}`);
                // every layer is where the layout says it is, and the object is the one getAbilities returned
                let layersOk = true;
                for (let i = 0; i < l.layerCount; i++) {
                    const want = base.add(l.layers + i * l.layerStride);
                    if (!abilities.getLayer(i).equalsptr(want)) layersOk = false;
                }
                say(layersOk, `getLayer 0..${l.layerCount - 1} land on +${l.layers} + n*${l.layerStride}`);
                // a layer the object does not have must be readable and empty, not a wild pointer
                const none = abilities.getLayer(l.layerCount as AbilitiesLayer);
                say(!none.getBool(AbilitiesIndex.MayFly) && !none.getBool(0), `getLayer(${l.layerCount}) reads as an empty Abilities`);
                say(!abilities.getBool(99 as AbilitiesIndex), "getBool past the ability count is false");
                console.log(`[abil] set: ${dump(abilities)}`);
                // the two float abilities: vanilla defaults, and nothing else in the record is a float
                const fly = abilities.getFloat(AbilitiesIndex.FlySpeed),
                    walk = abilities.getFloat(AbilitiesIndex.WalkSpeed);
                say(near(fly, 0.05), `FlySpeed ${fly} -- want 0.05`);
                say(near(walk, 0.1), `WalkSpeed ${walk} -- want 0.1`);
                const pair = (abilities as any)._getFloatWithLayer(AbilitiesIndex.FlySpeed);
                say(near(pair.first, 0.05) && pair.second >= 0 && pair.second < l.layerCount, `getFloatWithLayer(FlySpeed) = {${pair.first}, layer ${pair.second}}`);
                const invalid = Ability.INVALID_ABILITY as any as StaticPointer;
                say(!invalid.isNull(), `Abilities::INVALID_ABILITY at ${invalid.toString()} type ${Ability.INVALID_ABILITY.type}`);
                break;
            }
            case "creative":
            case "survival": {
                // `gamemode` is the engine writing into the Base layer; these two follow it exactly
                const want = sub === "creative";
                const mayFly = abilities.getBool(AbilitiesIndex.MayFly),
                    insta = abilities.getBool(AbilitiesIndex.Instabuild),
                    flying = p.isFlying();
                say(mayFly === want && insta === want, `${sub}: mayfly ${mayFly} instabuild ${insta} -- want ${want} for both`);
                say(
                    layerOf(abilities, AbilitiesIndex.MayFly) === AbilitiesLayer.Base && layerOf(abilities, AbilitiesIndex.Instabuild) === AbilitiesLayer.Base,
                    `${sub}: both come from the Base layer (${layerOf(abilities, AbilitiesIndex.MayFly)}, ${layerOf(abilities, AbilitiesIndex.Instabuild)})`,
                );
                // Invulnerable is not the gamemode's: a joining bot is invulnerable from a layer
                // above Base, which is a layer 2024 did not have at all
                const invulnLayer = layerOf(abilities, AbilitiesIndex.Invulnerable);
                say(
                    abilities.getBool(AbilitiesIndex.Invulnerable) && invulnLayer > AbilitiesLayer.Base,
                    `${sub}: invulnerable comes from layer ${invulnLayer}, above Base`,
                );
                console.log(`[abil] ${sub}: isFlying ${flying}, set: ${dump(abilities)}`);
                break;
            }
            case "write": {
                // bdsx writes; the value must come back, and it must be the Base layer that changed
                const before = abilities.getBool(AbilitiesIndex.Muted);
                abilities.setAbility(AbilitiesIndex.Muted, !before);
                const after = abilities.getBool(AbilitiesIndex.Muted);
                const inBase = abilities.getAbility(AbilitiesLayer.Base, AbilitiesIndex.Muted);
                say(after === !before, `setAbility(Muted, ${!before}) reads back ${after}`);
                say(inBase.getBool() === !before && inBase.type === Ability.Type.Bool, `the write landed in the Base layer (type ${inBase.type})`);
                const set: number[] = [];
                for (let i = 0; i < l.layerCount; i++) {
                    if (abilities.getAbility(i as AbilitiesLayer, AbilitiesIndex.Muted).type !== Ability.Type.Unset) set.push(i);
                }
                console.log(`[abil] Muted is set in layers [${set.join(",")}] -- Base is ${AbilitiesLayer.Base}`);
                abilities.setAbility(AbilitiesIndex.Muted, before);
                say(abilities.getBool(AbilitiesIndex.Muted) === before, `restored to ${before}`);
                break;
            }
            case "sync": {
                // Player.syncAbilities (A3, Q1-2): 1.26 has no UpdateAbilitiesPacket constructor, so the
                // engine layer writes the payload into a createPacket-made packet. "abilprobe sync on"
                // sets Muted in the Base layer first (only bdsx changes it, so the engine has no reason to
                // send it on its own), "abilprobe sync off" clears it. The bot logs what arrived.
                const mode = parts[2] ?? "";
                if (mode === "on" || mode === "off") abilities.setAbility(AbilitiesIndex.Muted, mode === "on");
                const layers = serializeLayers(abilities);
                const desc = layers.map((x: { layer: number; abilitiesSet: number; abilityValues: number; flySpeed: number; verticalFlySpeed: number; walkSpeed: number }) => `L${x.layer} set=0x${x.abilitiesSet.toString(16)} val=0x${x.abilityValues.toString(16)} fly=${x.flySpeed.toFixed(3)} vfly=${x.verticalFlySpeed.toFixed(3)} walk=${x.walkSpeed.toFixed(3)}`);
                console.log(`[abil] sync ${layers.length} layers: ${desc.join(" | ")}`);
                // the same payload written into a packet, read back from its own memory, then freed
                const pkt = UpdateAbilitiesPacket.allocate();
                const mem = pkt as unknown as StaticPointer;
                writeUpdateAbilitiesPayload(mem, p.getUniqueIdPointer(), abilities);
                const vb = mem.getPointer(48 + 16), ve = mem.getPointer(48 + 24);
                const n = ve.subptr(vb) / 24;
                const idOk = mem.getInt32(48) === p.getUniqueIdLow() && mem.getInt32(52) === p.getUniqueIdHigh();
                say(n === layers.length && idOk, `packet memory: ${n} layers, target ${mem.getInt32(48)}:${mem.getInt32(52)} (the player ${p.getUniqueIdLow()}:${p.getUniqueIdHigh()}), perms ${mem.getUint8(56)}/${mem.getUint8(57)}, mode ${mem.getInt32(88)}`);
                const base1 = layers.find((x: { layer: number; abilityValues: number }) => x.layer === AbilitiesLayer.Base);
                const muted = abilities.getAbility(AbilitiesLayer.Base, AbilitiesIndex.Muted).getBool();
                if (base1) say(((base1.abilityValues >>> AbilitiesIndex.Muted) & 1) === (muted ? 1 : 0), `Base layer Muted bit ${(base1.abilityValues >>> AbilitiesIndex.Muted) & 1} matches getBool ${muted}`);
                pkt.dispose();
                p.syncAbilities();
                say(true, `syncAbilities() returned (Muted=${abilities.getBool(AbilitiesIndex.Muted)}); the bot's update_abilities line is the network-side check`);
                break;
            }
            case "perms": {
                // PermissionsHandler is the first 24 bytes of the same object the layers follow, so
                // `op` / `deop` moving the player byte says the base pointer is a real LayeredAbilities.
                // PlayerPermissionLevel: Visitor 0, Member 1, Operator 2.
                const want = parts[2] === "op" ? 2 : 1;
                const playerPerm = abilities.getPlayerPermissions(),
                    cmdPerm = abilities.getCommandPermissions();
                say(playerPerm === want, `getPlayerPermissions ${playerPerm} after \`${parts[2] === "op" ? "op" : "deop"} @a\` -- want ${want} (command permissions ${cmdPerm})`);
                if (parts[2] === "op") {
                    // the accessor bdsx now emits for the setter, round-tripped through the getter
                    abilities.setPlayerPermissions(1);
                    const back = abilities.getPlayerPermissions();
                    say(back === 1, `setPlayerPermissions(1) reads back ${back}`);
                    abilities.setPlayerPermissions(playerPerm);
                    say(abilities.getPlayerPermissions() === playerPerm, `restored to ${playerPerm}`);
                }
                break;
            }
            case "names": {
                // The ability names (docs/findings-abilities.md, "The name table"). 1.26 inlined both
                // getAbilityName and nameToAbilityIndex away; bdsx reads the `const char*` table the
                // binary still holds. A wrong table, or a wrong count, cannot produce these strings.
                const names: string[] = [];
                for (let i = 0; i < l.abilityCount; i++) names.push(Abilities.getAbilityName(i));
                console.log(`[abil] names: ${names.map((n, i) => `${i}=${n}`).join(" ")}`);
                say(
                    names.every(n => n.length > 0) && new Set(names).size === names.length,
                    `${l.abilityCount} names, all non-empty and distinct`,
                );
                say(names[0] === "build" && names[1] === "mine", `names[0..1] = ${names[0]}, ${names[1]} -- want build, mine`);
                // the capitals are the table's own: a lowercased guess could not produce them
                say(names[AbilitiesIndex.FlySpeed] === "flySpeed", `getAbilityName(FlySpeed) = ${JSON.stringify(names[AbilitiesIndex.FlySpeed])} -- want "flySpeed"`);
                say(names[AbilitiesIndex.WalkSpeed] === "walkSpeed", `getAbilityName(WalkSpeed) = ${JSON.stringify(names[AbilitiesIndex.WalkSpeed])} -- want "walkSpeed"`);
                say(
                    names[AbilitiesIndex.PrivilegedBuilder] === "privilegedBuilder",
                    `getAbilityName(PrivilegedBuilder) = ${JSON.stringify(names[AbilitiesIndex.PrivilegedBuilder])} -- want "privilegedBuilder"`,
                );
                // the twentieth entry is the one 2024 did not have, so the count is 20 and not 19
                if (l.abilityCount > AbilitiesIndex.AbilityCount) {
                    say(
                        names[AbilitiesIndex.VerticalFlySpeed] === "verticalFlySpeed",
                        `getAbilityName(${AbilitiesIndex.VerticalFlySpeed}) = ${JSON.stringify(names[AbilitiesIndex.VerticalFlySpeed])} -- want "verticalFlySpeed"`,
                    );
                }
                console.log(`[abil] getAbilityName(${l.abilityCount}) past the end = ${JSON.stringify(Abilities.getAbilityName(l.abilityCount))}`);
                // the search, back the other way: every name the lowercasing caller leaves alone
                let roundTrip = true,
                    checked = 0;
                for (let i = 0; i < names.length; i++) {
                    if (names[i] !== names[i].toLowerCase()) continue;
                    checked++;
                    if (Abilities.nameToAbilityIndex(names[i]) !== i) {
                        roundTrip = false;
                        console.log(`[abil] nameToAbilityIndex(${names[i]}) = ${Abilities.nameToAbilityIndex(names[i])}, want ${i}`);
                    }
                }
                say(roundTrip && checked >= 15, `nameToAbilityIndex round-trips ${checked} lowercase names to their own index`);
                say((Abilities.nameToAbilityIndex("nosuchability") as number) === -1, "a name that is no ability is -1");
                // and the names are tied to the live object: the index a name resolves to is the
                // index the console command moves
                if (parts[2] === "creative" || parts[2] === "survival") {
                    const want = parts[2] === "creative";
                    const mayFly = Abilities.nameToAbilityIndex("mayfly"),
                        insta = Abilities.nameToAbilityIndex("instabuild");
                    say(
                        mayFly === AbilitiesIndex.MayFly && insta === AbilitiesIndex.Instabuild,
                        `"mayfly" -> ${mayFly} (want ${AbilitiesIndex.MayFly}), "instabuild" -> ${insta} (want ${AbilitiesIndex.Instabuild})`,
                    );
                    say(
                        abilities.getBool(mayFly) === want && abilities.getBool(insta) === want,
                        `${parts[2]}: the abilities those two names name are ${abilities.getBool(mayFly)}/${abilities.getBool(insta)} -- want ${want} for both`,
                    );
                }
                break;
            }
            case "abilities": {
                // the per-layer class, not the layered one: the Base layer read directly
                const layer: Abilities = abilities.getLayer(AbilitiesLayer.Base);
                const mayFly = layer.getBool(AbilitiesIndex.MayFly);
                say(mayFly === abilities.getAbility(AbilitiesLayer.Base, AbilitiesIndex.MayFly).getBool(), `Abilities::getBool(MayFly) ${mayFly} agrees with the record`);
                const walk = layer.getFloat(AbilitiesIndex.WalkSpeed);
                say(near(walk, 0.1), `Abilities::getFloat(WalkSpeed) ${walk} -- want 0.1`);
                break;
            }
            default:
                console.log(`[abil] unknown subcommand ${sub}`);
        }
    } catch (err) {
        console.log(`[abil] FAIL ${sub} threw ${(err as Error).message}`);
    }
});
