// Finds Actor's built-in component pointers on a live player (docs/findings-layouts.md,
// "Actor's built-in components"): 1.26 keeps StateVectorComponent*, AABBShapeComponent* and
// ActorRotationComponent* side by side in the Actor (Endstone's actor.h, BuiltInActorComponents),
// and getPosition / getRotation / getAABB are reads through them. After `tp @a 29.5 68 14.5` the
// position is known, so the offset is the one whose pointer leads to those three floats, with the
// box around them through the next pointer.
// Deployed as zz-layoutprobe.ts; console: "tp @a 29.5 68 14.5", "layoutprobe"
import { Actor, ActorDamageCause, ActorDataIDs, ActorFlags, ActorType } from "bdsx/bds/actor";
import { AttributeId, AttributeInstance } from "bdsx/bds/attribute";
import { MobEffect, MobEffectIds, MobEffectInstance } from "bdsx/bds/effects";
import { computeHashOf } from "bdsx/bds/hashedstring";
import { BlockPos, Facing, Vec3 } from "bdsx/bds/blockpos";
import { Direction } from "bdsx/common";
import { CommandPermissionLevel } from "bdsx/bds/command";
import { Player, PlayerPermission, ServerPlayer } from "bdsx/bds/player";
import { procHacker } from "bdsx/bds/proc";
import { AllocatedPointer, StaticPointer, VoidPointer } from "bdsx/core";
import { events } from "bdsx/event";
import { pdbcache } from "bdsx/pdbcache";
import { CxxString, NativeType, bin64_t, bool_t, uint16_t, void_t } from "bdsx/nativetype";
import { bin } from "bdsx/bin";
import { bedrockServer } from "bdsx/launcher";
import { ItemStack } from "bdsx/bds/inventory";
import { PlayerListEntry, PlayerListPacket, PlayerSkinPacket } from "bdsx/bds/packets";
import { SerializedSkin } from "bdsx/bds/skin";
import { engineLayout } from "bdsx/bds/engine/deps";
import { mce } from "bdsx/mce";
import { proc } from "bdsx/bds/symbols";
import { Bedrock } from "bdsx/bds/bedrock";
import { ServerNetworkHandler } from "bdsx/bds/networkidentifier";

// the player playerJoin handed over (the hook and the lookup behind it are execution-confirmed)
let joined: StaticPointer | null = null;
let player: Player | null = null;
let spawnedAtJoin = "not captured";
events.playerJoin.on(ev => {
    player = ev.player;
    joined = (ev.player as any as StaticPointer).add(0);
    // Player::isSpawned is a field accessor at +0x709 in both 1.26 builds (2024 read +2904, and the
    // only byte displacement Player::_hurt and Player::respawn share is that one in every build).
    // playerJoin runs before ServerPlayer::doInitialSpawn -- the one function that writes the byte --
    // so this reading is the negative half of the check and `dirprobe` below is the positive one.
    try {
        spawnedAtJoin = String(ev.player.isSpawned());
    } catch (err) {
        spawnedAtJoin = `threw ${(err as Error).message}`;
    }
});
events.playerLeft.on(() => {
    joined = null;
    player = null;
});
const near = (a: number, b: number, e = 0.02): boolean => Math.abs(a - b) <= e;
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "layoutprobe") return;
    if (joined === null) { console.log("[layout] no player"); return; }
    const p = joined;
    for (let off = 0x100; off < 0x600; off += 8) {
        try {
            const q = p.getPointer(off);
            if (q.isNull()) continue;
            const x = q.getFloat32(0), y = q.getFloat32(4), z = q.getFloat32(8);
            if (!near(x, 29.5) || !near(z, 14.5) || y < 60 || y > 75) continue;
            let box = "", rot = "";
            try { const b = p.getPointer(off + 8); box = [0, 4, 8, 12, 16, 20].map(i => b.getFloat32(i).toFixed(2)).join(" "); } catch (err) { box = "unreadable"; }
            try { const r = p.getPointer(off + 16); rot = [0, 4, 8, 12].map(i => r.getFloat32(i).toFixed(2)).join(" "); } catch (err) { rot = "unreadable"; }
            console.log(`[layout] Actor+0x${off.toString(16)} -> (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) prev (${q.getFloat32(12).toFixed(2)}, ${q.getFloat32(16).toFixed(2)}, ${q.getFloat32(20).toFixed(2)}) delta (${q.getFloat32(24).toFixed(2)}, ${q.getFloat32(28).toFixed(2)}, ${q.getFloat32(32).toFixed(2)}) | +8 box ${box} | +16 rot ${rot}`);
        } catch (err) {
            // not a readable pointer
        }
    }
    // the accessors the table ships from that offset, through bdsx's own Actor methods
    if (player !== null) {
        try {
            const pos = player.getPosition(), rot = player.getRotation();
            const ok = near(pos.x, 29.5) && near(pos.y, 69.62) && near(pos.z, 14.5) && near(rot.x, 45) && near(rot.y, 90);
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} getPosition (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) getRotation (${rot.x.toFixed(2)}, ${rot.y.toFixed(2)}) -- want (29.50, 69.62, 14.50) and (45, 90) after \`tp @a 29.5 68 14.5 90 45\``);
        } catch (err) {
            console.log(`[layout] FAIL accessors threw ${(err as Error).message}`);
        }
        // Actor::getEntityTypeId, found by ActorTypeComponent's hash: a player is ActorType.Player (0x13f)
        try {
            const t = player.getEntityTypeId();
            console.log(`[layout] ${t === ActorType.Player ? "PASS" : "FAIL"} getEntityTypeId 0x${t.toString(16)} (want 0x${ActorType.Player.toString(16)}, ActorType.Player)`);
        } catch (err) {
            console.log(`[layout] FAIL getEntityTypeId threw ${(err as Error).message}`);
        }
        // Actor::getActorIdentifier, found by ActorDefinitionIdentifierComponent's hash
        try {
            const id = player.getActorIdentifier().canonicalName.str;
            console.log(`[layout] ${id === "minecraft:player" ? "PASS" : "FAIL"} getActorIdentifier canonicalName "${id}" (want "minecraft:player")`);
        } catch (err) {
            console.log(`[layout] FAIL getActorIdentifier threw ${(err as Error).message}`);
        }
        // Actor::getAttributes -- the not_null wrapper throws rather than returning null, so reaching a
        // readable pointer twice with the same value is as far as this goes until BaseAttributeMap's
        // getMutableInstance has an address (data/candidates, next-steps Q1)
        try {
            const a = player.getAttributes(), b = player.getAttributes();
            const same = (a as any as StaticPointer).equals(b as any as StaticPointer);
            let head = "";
            for (let i = 0; i < 0x50; i += 8) head += (a as any as StaticPointer).getPointer(i).toString() + " ";
            console.log(`[layout] ${same ? "PASS" : "FAIL"} getAttributes ${a} stable ${same} head ${head}`);
        } catch (err) {
            console.log(`[layout] FAIL getAttributes threw ${(err as Error).message}`);
        }
        // Actor::getRuntimeID, found by its component's type hash: the first client of a session is runtime id 1
        // (the bot logs the id start_game gave it)
        try {
            const id = player.getRuntimeID();
            // bdsx models the 8-byte id as a pointer value
            console.log(`[layout] ${id.getAddressHigh() === 0 && id.getAddressLow() === 1 ? "PASS" : "FAIL"} getRuntimeID ${id} (the bot's start_game runtime id is 1)`);
        } catch (err) {
            console.log(`[layout] FAIL getRuntimeID threw ${(err as Error).message}`);
        }
    }
    console.log("[layout] done");
});
// `nonownerprobe`: Bedrock.NonOwnerPointer in 1.26's 24-byte shape (docs/findings-nbt.md "NonOwnerPointer"). The launcher's
// nonOwnerPointerServerNetworkHandler is built from the Level's pointer (engine/networkhandler.ts); its object must be the
// handler updateServerAnnouncement ran on, with the NetEventCallback table at +0x10, and each copy must take and drop
// exactly one use on the count block.
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "nonownerprobe") return;
    const NOP = Bedrock.NonOwnerPointer.make(ServerNetworkHandler);
    const size = NOP[NativeType.size];
    console.log(`[layout] ${size === 0x18 ? "PASS" : "FAIL"} nonowner size 0x${size.toString(16)} (want 0x18)`);
    try {
        const np = bedrockServer.nonOwnerPointerServerNetworkHandler;
        const raw = np as any as StaticPointer;
        const control = raw.getNullablePointer(0), count = raw.getNullablePointer(8);
        const handler = np.get();
        const snh = bedrockServer.serverNetworkHandler as any as StaticPointer;
        const same = handler !== null && (handler as any as StaticPointer).equalsptr(snh);
        const table = snh.getPointer(0x10);
        const want = proc["??_7ServerNetworkHandler@@6BNetEventCallback@@@"];
        const ok = control !== null && control.getUint8(0) === 1 && count !== null && same && table.equalsptr(want);
        console.log(`[layout] ${ok ? "PASS" : "FAIL"} nonowner launcher: control ${control} valid ${control?.getUint8(0)}, count block ${count}, get() ${handler} == serverNetworkHandler ${snh}: ${same}; handler+0x10 ${table} (want ??_7ServerNetworkHandler@@6BNetEventCallback@@@ ${want})`);
        if (count === null) return;
        const uses = (): number => count.getInt32(8);
        const u0 = uses();
        const fresh = bedrockServer.minecraft.getNonOwnerPointerServerNetworkHandler();
        const u1 = uses();
        const copy = NOP.construct();
        copy.assign(fresh);
        const u2 = uses();
        const copySame = copy.get() !== null && (copy.get() as any as StaticPointer).equalsptr(snh);
        const freshSame = fresh.get() !== null && (fresh.get() as any as StaticPointer).equalsptr(snh);
        copy.dispose();
        const u3 = uses();
        fresh.dispose();
        const u4 = uses();
        const emptied = fresh.get() === null && (fresh as any as StaticPointer).getNullablePointer(8) === null;
        const counted = u1 === u0 + 1 && u2 === u0 + 2 && u3 === u0 + 1 && u4 === u0;
        console.log(`[layout] ${counted && copySame && freshSame && emptied ? "PASS" : "FAIL"} nonowner uses: ${u0} -> getNonOwnerPointerServerNetworkHandler ${u1} -> assign ${u2} -> dispose ${u3} -> dispose ${u4} (want +1,+2,+1,+0); fresh.get() == handler ${freshSame}, copy.get() == handler ${copySame}, emptied after dispose ${emptied}`);
    } catch (err) {
        console.log(`[layout] FAIL nonowner threw ${(err as Error).message}`);
    }
    try {
        const c = bedrockServer.connector as any as StaticPointer;
        const vt = c.getPointer(0), want = proc["??_7RakNetConnector@@6BConnector@@@"];
        console.log(`[layout] ${vt.equalsptr(want) ? "PASS" : "FAIL"} nonowner connector: ServerNetworkSystem member ${c}, vftable ${vt} (want ??_7RakNetConnector@@6BConnector@@@ ${want})`);
    } catch (err) {
        console.log(`[layout] FAIL nonowner connector threw ${(err as Error).message}`);
    }
});
// `hpprobe <step>`: Actor::getHealth / getMaxHealth, which 1.26 keeps only as the free functions
// ActorAttribute::getHealth / getMaxHealth over the entity's EntityContext (docs/findings-components.md).
// Both read the same static Attribute and differ only in the float they take off the AttributeInstance
// (+124 vs +120), so a full-health player cannot tell them apart -- `effect @a health_boost 60 1 true`
// raises the maximum and leaves the current value where it is, which does.
events.command.on(cmd => {
    const m = cmd.replace(/^\//, "").match(/^hpprobe(?:\s+(\S+))?$/);
    if (m === null) return;
    const step = m[1] ?? "base";
    if (player === null) { console.log("[layout] no player"); return; }
    try {
        const hp = player.getHealth();
        const max = player.getMaxHealth();
        const ok = step === "boost" ? hp === 20 && max > hp : hp === 20 && max === 20;
        console.log(`[layout] ${ok ? "PASS" : "FAIL"} hpprobe ${step}: getHealth ${hp} getMaxHealth ${max} (want ${step === "boost" ? "20 and more than 20" : "20 and 20"})`);
    } catch (err) {
        console.log(`[layout] FAIL hpprobe ${step} threw ${(err as Error).message}`);
    }
});
// `attrprobe <step>`: BaseAttributeMap::getMutableInstance, which 1.26 has in no form -- bdsx runs the
// lower_bound itself over symbols.json `layouts.BaseAttributeMap` (docs/findings-components.md). The
// health attribute is the one the console can move: `effect @a health_boost 60 1 true` raises the
// maximum, and setAttribute writes the current value where Actor::getHealth reads it.
events.command.on(cmd => {
    const m = cmd.replace(/^\//, "").match(/^attrprobe(?:\s+(\S+))?$/);
    if (m === null) return;
    const step = m[1] ?? "base";
    if (player === null) { console.log("[layout] no player"); return; }
    try {
        const map = player.getAttributes();
        const inst = map.getMutableInstance(AttributeId.Health);
        if (inst === null) { console.log(`[layout] FAIL attrprobe ${step}: getMutableInstance(Health) is null`); return; }
        // the raw floats around the four bdsx names, so minValue and defaultValue can be read off a
        // state where the console has separated them
        let raw = "";
        for (let off = 0x68; off <= 0x94; off += 4) raw += `+0x${off.toString(16)}=${(inst as any as StaticPointer).getFloat32(off)} `;
        const cur = inst.currentValue, min = inst.minValue, max = inst.maxValue, def = inst.defaultValue;
        const got = player.getAttribute(AttributeId.Health);
        if (step === "set") {
            // Actor's own setAttribute, not ServerPlayer's: that one also sends an UpdateAttributesPacket,
            // and packet allocation needs std::_Allocate, which this build's table has no address for
            const set = (v: number): void => void Actor.prototype.setAttribute.call(player!, AttributeId.Health, v);
            set(15);
            const after = player.getHealth();
            set(20);
            const back = player.getHealth();
            const ok = after === 15 && back === 20;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} attrprobe set: setAttribute(Health, 15) -> getHealth ${after}, back to 20 -> getHealth ${back} (want 15 then 20)`);
        } else {
            const wantMax = step === "boost" ? 28 : 20;
            const ok = got === 20 && cur === 20 && max === wantMax;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} attrprobe ${step}: getAttribute(Health) ${got} current ${cur} min ${min} max ${max} default ${def} (want ${20} and max ${wantMax})`);
        }
        console.log(`[layout] INFO attrprobe ${step} instance ${inst} raw ${raw}`);
        if (step === "base") {
            const absent = map.getMutableInstance(AttributeId.JumpStrength);
            console.log(`[layout] INFO attrprobe getMutableInstance(JumpStrength) ${absent === null ? "null" : String(absent)}`);
        }
    } catch (err) {
        console.log(`[layout] FAIL attrprobe ${step} threw ${(err as Error).message}`);
    }
});
// `gmprobe <mode>` after `gamemode <mode> @a`: the game-mode functions found by ActorGameTypeComponent's hash
// (docs/findings-components.md) and the isSurvival bdsx derives from two of them
const GM: Record<string, number> = { survival: 0, creative: 1, adventure: 2, spectator: 6 };
events.command.on(cmd => {
    const m = /^\/?gmprobe (\w+)$/.exec(cmd);
    if (m === null || player === null) return;
    const want = m[1];
    try {
        const got = { type: player.getGameType(), survival: player.isSurvival(), creative: player.isCreative(), adventure: player.isAdventure(), spectator: player.isSpectator(), attackable: player.isAttackableGamemode() };
        const ok = got.type === GM[want] && got.survival === (want === "survival") && got.creative === (want === "creative") && got.adventure === (want === "adventure") && got.spectator === (want === "spectator") && got.attackable === (want === "survival" || want === "adventure");
        console.log(`[layout] ${ok ? "PASS" : "FAIL"} gamemode ${want}: ${JSON.stringify(got)}`);
    } catch (err) {
        console.log(`[layout] FAIL gamemode ${want}: threw ${(err as Error).message}`);
    }
});
// `effprobe <none|speed|remove|clear>`: the MobEffectsComponent family (docs/findings-components.md).
// The key below is the probe's own (MobEffect.create is derived since 2026-09-28 and checked by `effidprobe` and
// the "public" line); getEffect only reads the argument's +8 (MobEffect::mId -- the 2024 getId is
// `movl 8(%rcx), %eax`), so the probe hands it a 32-byte buffer with the id written there. That is the claim being tested as much as the address is.
// The view must keep the buffer alive: `as()` copies only the address, and an AllocatedPointer's memory is
// freed when that JS object is collected. Q8 (2026-09-25): the probe used to drop `buf` here, so once a GC ran
// between load and `effprobe speed` the key's +8 was freed memory and getEffect indexed with garbage -> null.
// EFF_STALE=1 rebuilds that dangling key on purpose, to show it (docs/findings-components.md "Q8").
const asMobEffect = (id: MobEffectIds, owned = true): MobEffect => {
    const buf = new AllocatedPointer(0x20);
    buf.fill(0, 0x20);
    buf.setInt32(id, 8);
    const e = buf.as(MobEffect);
    if (owned) (e as any).$buffer = buf;
    return e;
};
const effStale = process.env.EFF_STALE === "1";
const speed = asMobEffect(MobEffectIds.Speed, !effStale);
if (effStale) console.log("[layout] INFO EFF_STALE=1: the Speed key does not own its buffer (the pre-fix probe)");
function effectOf(a: Actor, e: MobEffect): MobEffectInstance | null {
    return (a as any)._getEffect(e) as MobEffectInstance | null;
}
// Actor::addEffect through bdsx's own hook with the 2024 prototype: `effect @a speed 30 1` has to reach it
let added = 0;
let lastAdded = "none";
const Actor$addEffect = procHacker.hooking("?addEffect@Actor@@QEAAXAEBVMobEffectInstance@@@Z", void_t, null, Actor, MobEffectInstance)((actor, inst) => {
    added++;
    try {
        // Q8 (40-only, intermittent: getEffect null right after this fired): whose effect was it
        const target = player !== null && (actor as any as StaticPointer).equalsptr(player as any) ? "the probe's player" : `another actor ${actor}`;
        lastAdded = `id ${inst.id} duration ${inst.duration} amplifier ${inst.amplifier} on ${target}`;
    } catch (err) {
        lastAdded = `unreadable (${(err as Error).message})`;
    }
    Actor$addEffect(actor, inst);
});
events.command.on(cmd => {
    const m = /^\/?effprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    if (player === null) { console.log("[layout] no player"); return; }
    try {
        if (step === "remove") player.removeEffect(MobEffectIds.Speed);
        if (step === "clear") player.removeAllEffects();
        const inst = effectOf(player, speed);
        const has = (player as any)._hasEffect(speed) as boolean;
        const want = step === "speed" || step === "speed2";
        let raw = "";
        if (inst !== null) for (let i = 0; i < 0x28; i++) raw += (inst as any as StaticPointer).getUint8(i).toString(16).padStart(2, "0") + (i % 4 === 3 ? " " : "");
        const detail = inst === null ? "null" : `id ${inst.id} duration ${inst.duration} amplifier ${inst.amplifier} raw ${raw}`;
        // `effect @a speed 30 1` then `effect @a speed 20 2 true`: the amplifier and showParticles move,
        // which is what pins MobEffectInstance's 1.26 offsets as well as the address
        const amp = step === "speed2" ? 2 : 1, dur = step === "speed2" ? 400 : 600, particles = step !== "speed2";
        const ok = want
            ? inst !== null && inst.id === MobEffectIds.Speed && inst.duration > 0 && inst.duration <= dur && inst.amplifier === amp && inst.showParticles === particles && has === true
            : inst === null && has === false;
        console.log(`[layout] ${ok ? "PASS" : "FAIL"} effprobe ${step}: key id ${(speed as any as StaticPointer).getInt32(8)} getEffect ${detail} showParticles ${inst === null ? "-" : inst.showParticles} hasEffect ${has} (want ${want ? `Speed, duration <= ${dur}, amplifier ${amp}, showParticles ${particles}, true` : "null, false"})`);
        // the public API over MobEffect.create (MobEffect::getById, derived over mMobEffects on 1.26): Speed follows
        // the console, Haste is never given, and getEffect(Speed) reads the same amplifier
        const pubHas = player.hasEffect(MobEffectIds.Speed);
        const pubHaste = player.hasEffect(MobEffectIds.Haste);
        const pubInst = player.getEffect(MobEffectIds.Speed);
        const pubOk = want
            ? pubHas === true && pubHaste === false && pubInst !== null && pubInst.id === MobEffectIds.Speed && pubInst.amplifier === amp
            : pubHas === false && pubHaste === false && pubInst === null;
        console.log(`[layout] ${pubOk ? "PASS" : "FAIL"} effprobe ${step} public: hasEffect(Speed) ${pubHas} hasEffect(Haste) ${pubHaste} getEffect(Speed) ${pubInst === null ? "null" : `id ${pubInst.id} amplifier ${pubInst.amplifier}`} (want ${want ? `true, false, id 1 amplifier ${amp}` : "false, false, null"})`);
        if (effStale) {
            // the same lookup with a key built just now (and kept alive by `fresh`), in the same step
            const fresh = asMobEffect(MobEffectIds.Speed);
            const f = effectOf(player, fresh);
            console.log(`[layout] INFO effprobe ${step} fresh key: key id ${(fresh as any as StaticPointer).getInt32(8)} getEffect ${f === null ? "null" : `id ${f.id} duration ${f.duration} amplifier ${f.amplifier}`}`);
        }
        // nothing has been added yet at the `none` step, so it only reports
        console.log(`[layout] ${step === "none" ? "INFO" : added > 0 ? "PASS" : "FAIL"} addEffect hook fired ${added} time(s), last ${lastAdded}`);
    } catch (err) {
        console.log(`[layout] FAIL effprobe ${step} threw ${(err as Error).message}`);
    }
});
// `effcreate`: MobEffectInstance.create (the constructor, derived on 1.26: docs/findings-components.md "MobEffectInstance's
// constructor on 1.26") and getAmplifier. The engine's own save() reads the built instance, then Actor::addEffect gives it to
// the player and getEffect reads it back. Run `effect @a clear` after.
events.command.on(cmd => {
    if (!/^\/?effcreate$/.test(cmd)) return;
    if (player === null) { console.log("[layout] no player"); return; }
    try {
        const inst = MobEffectInstance.create(MobEffectIds.Haste, 600, 2, true, false, false);
        let raw = "";
        for (let i = 0; i < 0x30; i++) raw += (inst as any as StaticPointer).getUint8(i).toString(16).padStart(2, "0") + (i % 4 === 3 ? " " : "");
        const fieldsOk = inst.id === MobEffectIds.Haste && inst.duration === 600 && inst.amplifier === 2 && inst.getAmplifier() === 2 && inst.ambient && !inst.showParticles && !inst.displayAnimation && !inst.noCounter;
        console.log(`[layout] ${fieldsOk ? "PASS" : "FAIL"} effcreate fields: id ${inst.id} duration ${inst.duration} amplifier ${inst.amplifier} getAmplifier ${inst.getAmplifier()} ambient ${inst.ambient} showParticles ${inst.showParticles} display ${inst.displayAnimation} noCounter ${inst.noCounter}; raw ${raw}`);
        // save() hands back NBT wrappers ({_value}); the factor data's target is 1.0 and its padding 0 when the constructor
        // wrote 1.0f at the right place (the first run wrote it at the padding: padding_duration 1065353216)
        const saved = inst.save();
        const val = (v: any): any => (v !== null && typeof v === "object" && "_value" in v ? v._value : v);
        const fcd = saved.FactorCalculationData ?? {};
        const saveOk =
            val(saved.Id) === MobEffectIds.Haste && val(saved.Amplifier) === 2 && val(saved.Duration) === 600 && val(saved.Ambient) === 1 && val(saved.ShowParticles) === 0 &&
            val(saved.DisplayOnScreenTextureAnimation) === 0 && val(fcd.factor_target) === 1 && val(fcd.padding_duration) === 0;
        console.log(`[layout] ${saveOk ? "PASS" : "FAIL"} effcreate engine save: ${JSON.stringify(saved)} (want Id 3, Amplifier 2, Duration 600, Ambient 1, ShowParticles 0, DisplayOnScreenTextureAnimation 0, factor_target 1, padding_duration 0)`);
        player.addEffect(inst);
        const live = player.getEffect(MobEffectIds.Haste);
        const liveOk = live !== null && live.amplifier === 2 && live.getAmplifier() === 2 && live.ambient && !live.showParticles && live.duration > 0 && live.duration <= 600;
        console.log(`[layout] ${liveOk ? "PASS" : "FAIL"} effcreate addEffect: getEffect(Haste) ${live === null ? "null" : `amplifier ${live.amplifier} getAmplifier ${live.getAmplifier()} ambient ${live.ambient} showParticles ${live.showParticles} duration ${live.duration}`}`);
    } catch (err) {
        console.log(`[layout] FAIL effcreate threw ${(err as Error).stack}`);
    }
});
// `effidprobe`: MobEffect.create (MobEffect::getById) and getId, both derived on 1.26 over MobEffect::mMobEffects and
// MobEffect+8 (docs/findings-components.md "MobEffect::getById"). Every registered id comes back as a MobEffect whose
// getId is that id, all distinct, the same object twice; out of range (the 38-slot bound, a negative id) is null.
events.command.on(cmd => {
    if (!/^\/?effidprobe$/.test(cmd)) return;
    try {
        const count = engineLayout("MobEffect", "count", -1);
        const speed1 = MobEffect.create(MobEffectIds.Speed);
        const speed2 = MobEffect.create(MobEffectIds.Speed);
        const speedOk = speed1 !== null && speed1.getId() === 1 && speed2 !== null && (speed1 as any as StaticPointer).equalsptr(speed2 as any);
        console.log(`[layout] ${speedOk ? "PASS" : "FAIL"} effidprobe MobEffect.create(1).getId() ${speed1 === null ? "null" : speed1.getId()}, same object twice ${speed1 !== null && speed2 !== null && (speed1 as any as StaticPointer).equalsptr(speed2 as any)} (want 1, true)`);
        const seen = new Set<string>();
        const bad: string[] = [];
        let filled = 0;
        for (let id = 1; id < count; id++) {
            const e = MobEffect.create(id);
            if (e === null) { bad.push(`${id}:null`); continue; }
            filled++;
            const key = (e as any as StaticPointer).toString();
            if (seen.has(key)) bad.push(`${id}:dup`);
            seen.add(key);
            if (e.getId() !== id || e.id !== id) bad.push(`${id}:getId ${e.getId()} id ${e.id}`);
        }
        console.log(`[layout] ${count === 38 && bad.length === 0 && filled === count - 1 ? "PASS" : "FAIL"} effidprobe ids 1..${count - 1}: ${filled} registered, ${seen.size} distinct, mismatches [${bad.join(" ")}] (want 37, 37, [])`);
        const zero = MobEffect.create(0);
        console.log(`[layout] INFO effidprobe MobEffect.create(0) (UNKNOWN_EFFECT slot) ${zero === null ? "null" : `id ${zero.getId()}`}`);
        const outs = [count, count + 1, 1000, -1, 0x7fffffff].map(id => MobEffect.create(id));
        const outOk = outs.every(e => e === null);
        console.log(`[layout] ${outOk ? "PASS" : "FAIL"} effidprobe out of range ${count}, ${count + 1}, 1000, -1, 0x7fffffff: ${outs.map(e => (e === null ? "null" : "non-null")).join(" ")} (want all null)`);
        // the public entry points take an out-of-range id as "no such effect" instead of reading through null
        const p = player;
        if (p !== null) {
            const h = p.hasEffect(1000 as MobEffectIds), g = p.getEffect(-1 as MobEffectIds);
            console.log(`[layout] ${h === false && g === null ? "PASS" : "FAIL"} effidprobe hasEffect(1000) ${h} getEffect(-1) ${g} (want false, null)`);
        }
    } catch (err) {
        console.log(`[layout] FAIL effidprobe threw ${(err as Error).message}`);
    }
});
// `effnameprobe <step>`: MobEffect's name fields and MobEffectInstance::getComponentName on 1.26
// (docs/findings-components.md "MobEffect's fields and getComponentName"). The fields are the constructor's stores, the
// same on both 1.26 builds as in 2024 (descriptionId +0x80, resourceName +0xb0, iconName +0xd0, componentName +0x100);
// getComponentName is derived from its inlined copy in Mob::hasComponent.
//   dump             every registered effect's strings, one INFO line each, plus the checks over all of them
//   speed            after `effect @a speed 30 1`: the live instance's getComponentName
//   new <EnumName>   after `effect @a <resource> 30 0` for a 1.26-only effect: the same through MobEffectIds.<EnumName>
//   none             an instance whose id is out of range reads HashedString::defaultErrorValue (empty)
const pascalOf = (s: string): string => s.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
events.command.on(cmd => {
    const m = /^\/?effnameprobe(?:\s+(\S+))?(?:\s+(\S+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1] ?? "dump";
    try {
        if (step === "dump") {
            const count = engineLayout("MobEffect", "count", -1);
            const bad: string[] = [];
            const names = new Set<string>();
            const modOff: string[] = [];
            for (let id = 0; id < count; id++) {
                const e = MobEffect.create(id);
                if (e === null) { console.log(`[layout] INFO effnameprobe #${id} null`); continue; }
                const cn = e.componentName;
                const res = e.resourceName;
                console.log(
                    `[layout] INFO effnameprobe #${id} resource '${res}' description '${e.descriptionId}' icon '${e.iconName}' component '${cn.str}'` +
                        ` harmful ${e.harmful} iconIndex ${e.icon} durationModifier ${e.durationModifier} showParticles ${e.showParticles} enum ${MobEffectIds[id]}`,
                );
                if (id === 0) continue;
                if (res === "" || names.has(res)) bad.push(`${id}:resource '${res}'`);
                names.add(res);
                if (cn.str !== `minecraft:effect.${res}`) bad.push(`${id}:component '${cn.str}'`);
                const h = computeHashOf(cn.str);
                if (cn.hash === null || !cn.hash.equalsptr(h)) bad.push(`${id}:hash`);
                if (e.durationModifier !== (e.harmful ? 0.5 : 1)) modOff.push(`${res}=${e.durationModifier}`);
                if (id >= 31 && MobEffectIds[id] !== pascalOf(res)) bad.push(`${id}:enum ${MobEffectIds[id]} vs ${pascalOf(res)}`);
            }
            console.log(`[layout] ${bad.length === 0 ? "PASS" : "FAIL"} effnameprobe dump ids 1..${count - 1}: resourceName distinct and non-empty, componentName 'minecraft:effect.'+resourceName with its FNV hash, ids 31..37 named by their resource, mismatches [${bad.join(" ")}] (want [])`);
            // the constructor stores 0.5 (harmful) or 1 at +0xa4; registration overrides some afterwards (first run: haste 1.5,
            // nausea/regeneration/blindness/poison/wither/fatal_poison 0.25), so this is a record, not a check
            console.log(`[layout] INFO effnameprobe dump durationModifier differing from the constructor's 0.5-if-harmful-else-1: [${modOff.join(" ")}]`);
            const s = MobEffect.create(MobEffectIds.Speed);
            const ok = s !== null && s.resourceName === "speed" && s.descriptionId === "potion.moveSpeed" && s.componentName.str === "minecraft:effect.speed" && !s.harmful;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} effnameprobe Speed resourceName '${s?.resourceName}' descriptionId '${s?.descriptionId}' componentName '${s?.componentName.str}' harmful ${s?.harmful} (want speed, potion.moveSpeed, minecraft:effect.speed, false)`);
            return;
        }
        const p = player;
        if (step === "speed" || step === "new") {
            if (p === null) { console.log(`[layout] FAIL effnameprobe ${step}: no player`); return; }
            const enumName = step === "speed" ? "Speed" : (m[2] ?? "");
            const id = (MobEffectIds as any)[enumName] as number | undefined;
            if (typeof id !== "number") { console.log(`[layout] FAIL effnameprobe ${step}: no MobEffectIds.${enumName}`); return; }
            const e = MobEffect.create(id);
            const inst = p.getEffect(id);
            const res = e === null ? "(null)" : e.resourceName;
            const got = inst === null ? "(no instance)" : inst.getComponentName();
            const ok = e !== null && pascalOf(res) === enumName && got === `minecraft:effect.${res}` && inst!.id === id;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} effnameprobe ${step} MobEffectIds.${enumName} = ${id}: MobEffect.resourceName '${res}', getEffect(${id}).getComponentName() '${got}' (want the resource named by the enum, minecraft:effect.<it>)`);
            return;
        }
        if (step === "none") {
            const inst = new MobEffectInstance(true);
            inst.id = 99;
            const hs = (inst as any)._getComponentName();
            const dev = proc["?defaultErrorValue@HashedString@@2V1@A"];
            const same = dev !== null && dev !== undefined && (hs as StaticPointer).equalsptr(dev);
            console.log(`[layout] ${inst.getComponentName() === "" && same ? "PASS" : "FAIL"} effnameprobe id 99 getComponentName '${inst.getComponentName()}', is HashedString::defaultErrorValue ${same}, hash ${hs.hash} (want '', true)`);
            inst.id = 0;
            console.log(`[layout] INFO effnameprobe id 0 (UNKNOWN_EFFECT slot) getComponentName '${inst.getComponentName()}'`);
            return;
        }
        console.log(`[layout] FAIL effnameprobe unknown step ${step}`);
    } catch (err) {
        console.log(`[layout] FAIL effnameprobe ${step} threw ${(err as Error).message}`);
    }
});
console.log("[layout] loaded");

// `tagprobe <step>`: Actor::hasTag / addTag / removeTag / getTags, found by TagsComponent's EnTT type
// hash and settled by TagCommand::execute's own `commands.tag.*` strings (docs/findings-components.md).
// The console's `tag` command writes through BDS's copy of the same four functions, so every step has
// one side write and the other side read -- a wrong address can hardly agree with BDS about the set.
events.command.on(cmd => {
    const m = /^\/?tagprobe(?: (\w+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1] ?? "base";
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        if (step === "base") {
            // bdsx writes, bdsx reads
            const added = p.addTag("bdsxtag");
            const again = p.addTag("bdsxtag"); // already there -> false
            const has = p.hasTag("bdsxtag");
            const miss = p.hasTag("nosuchtag");
            const tags = p.getTags();
            const ok = added === true && again === false && has === true && miss === false && tags.indexOf("bdsxtag") >= 0;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} tagprobe base: addTag ${added}/${again} hasTag ${has}/${miss} getTags [${tags.join(",")}] (want true/false true/false with bdsxtag)`);
        } else if (step === "console") {
            // `tag @a add consoletag` ran before this: BDS wrote, bdsx reads
            const has = p.hasTag("consoletag");
            const tags = p.getTags();
            const ok = has === true && tags.indexOf("consoletag") >= 0 && tags.indexOf("bdsxtag") >= 0;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} tagprobe console: hasTag(consoletag) ${has} getTags [${tags.join(",")}] (want true and both tags)`);
        } else if (step === "remove") {
            // bdsx removes its own tag; the `tag @a list` after this is BDS reading
            const gone = p.removeTag("bdsxtag");
            const twice = p.removeTag("bdsxtag"); // no longer there -> false
            const has = p.hasTag("bdsxtag");
            const tags = p.getTags();
            const ok = gone === true && twice === false && has === false && tags.indexOf("bdsxtag") < 0 && tags.indexOf("consoletag") >= 0;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} tagprobe remove: removeTag ${gone}/${twice} hasTag ${has} getTags [${tags.join(",")}] (want true/false false, consoletag left)`);
        }
    } catch (err) {
        console.log(`[layout] FAIL tagprobe ${step} threw ${(err as Error).message}`);
    }
});

// `sadprobe`: the SynchedActorData seam (docs/findings-slots.md / next-steps Q1-1). Three things at
// once -- the `lea Actor+0x128` accessor bdsx emits for getEntityData, the generic wrapper getters
// (getInt / getFloat / getString, which propagation had pointed at an EnTT sparse-set lookup and a
// trade function), and BDS's own inlined copies of two of them, Actor::getNameTag (id 4) and
// Actor::getVariant (id 2). The check is that the two separately compiled paths agree, and that the
// string path lands on the name BDS itself put there.
const SynchedActorDataEntityWrapper$getString = procHacker.js(
    "?getString@SynchedActorDataEntityWrapper@@QEBAAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@G@Z",
    CxxString,
    null,
    VoidPointer,
    uint16_t,
);
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "sadprobe") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        const w = p.getEntityData();
        console.log(`[layout] ${w.isNull() ? "FAIL" : "PASS"} sadprobe entityData: getEntityData() -> ${w} (lea Actor+0x128)`);
        const name = p.getName();
        const viaWrapper = SynchedActorDataEntityWrapper$getString(w, 4);
        const viaActor = p.getNameTag();
        const okName = viaWrapper === name && viaActor === name;
        console.log(`[layout] ${okName ? "PASS" : "FAIL"} sadprobe name: getString(4) "${viaWrapper}" getNameTag() "${viaActor}" (want both "${name}")`);
        const intVia = w.getInt(2);
        const variant = p.getVariant();
        console.log(`[layout] ${intVia === variant ? "PASS" : "FAIL"} sadprobe variant: getInt(2) ${intVia} getVariant() ${variant} (want equal)`);
        // A player's variant is 0, so the agreement above is real but weak. These sweeps say which ids
        // hold a non-zero value of each type at all, which is what a stronger check would have to use.
        const ints: string[] = [], floats: string[] = [];
        for (let id = 0; id < 141; id++) { const n = w.getInt(id); if (n !== 0) ints.push(`${id}=${n}`); }
        for (let id = 0; id < 141; id++) { const f = w.getFloat(id); if (f !== 0) floats.push(`${id}=${f}`); }
        console.log(`[layout] INFO sadprobe ints: ${ints.length === 0 ? "none nonzero" : ints.join(" ")}`);
        console.log(`[layout] INFO sadprobe floats: ${floats.length === 0 ? "none nonzero" : floats.join(" ")}`);
        // Each getter returns its payload only when the item's type matches the constant it compares
        // (2 Int, 3 Float, 4 String), so a working pair reads non-zero values at *disjoint* ids. If the
        // type check were wrong -- or if either address were some other function -- the two sets would
        // not separate like this.
        const idsOf = (a: string[]): Set<string> => new Set(a.map(x => x.split("=")[0]));
        const iSet = idsOf(ints), fSet = idsOf(floats);
        const overlap = [...iSet].filter(id => fSet.has(id));
        const okTypes = ints.length > 0 && floats.length > 0 && overlap.length === 0;
        console.log(`[layout] ${okTypes ? "PASS" : "FAIL"} sadprobe types: ${iSet.size} int ids and ${fSet.size} float ids, overlap [${overlap.join(",")}] (want both nonempty and no overlap)`);
    } catch (err) {
        console.log(`[layout] FAIL sadprobe threw ${(err as Error).message}`);
    }
});

// `setprobe`: SynchedActorDataEntityWrapper::set<int> / set<float>, which 1.26 keeps no out-of-line
// copy of and which bdsx therefore writes itself (docs/findings-synched.md). Three things have to be
// right and each is checked separately: the payload offset (BDS's own Actor::getVariant must read
// back what bdsx wrote), the type refusal (a setter must leave an item of another type alone), and
// the dirty bit (SynchedActorData+24, which is what makes BDS send the change).
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "setprobe") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        const w = p.getEntityData();
        // bdsx's ActorDataIDs only names a handful of the 141 ids, so the raw ones are cast in
        const VARIANT = 2 as ActorDataIDs, FLOAT_ID = 108 as ActorDataIDs;
        const sad = (w as any as StaticPointer).getPointer(0);
        const dirtyWord = (id: number): number => sad.getUint32(24 + (id >>> 5) * 4);
        const bitOf = (id: number): number => (dirtyWord(id) >>> (id & 31)) & 1;

        // (1) the payload: bdsx writes id 2 (VARIANT), BDS's own inlined getInt reads it
        const before = p.getVariant();
        w.setInt(VARIANT, 7);
        const afterWrapper = w.getInt(VARIANT), afterBds = p.getVariant();
        const okInt = afterWrapper === 7 && afterBds === 7;
        console.log(`[layout] ${okInt ? "PASS" : "FAIL"} setprobe int: variant ${before} -> getInt ${afterWrapper} / Actor::getVariant ${afterBds} (want both 7)`);
        // (2) the dirty bit for that id
        const okDirty = bitOf(2) === 1;
        console.log(`[layout] ${okDirty ? "PASS" : "FAIL"} setprobe dirty: bit for id 2 is ${bitOf(2)} (want 1), word 0x${dirtyWord(2).toString(16)}`);
        // (3) the type refusal: id 108 is a float item, so set<int> must not touch it
        const f108 = w.getFloat(FLOAT_ID);
        w.setInt(FLOAT_ID, 999);
        const f108after = w.getFloat(FLOAT_ID), i108 = w.getInt(FLOAT_ID);
        const okRefuse = f108after === f108 && i108 === 0;
        console.log(`[layout] ${okRefuse ? "PASS" : "FAIL"} setprobe refuse: setInt on float id 108 left ${f108} as ${f108after}, getInt reads ${i108} (want unchanged and 0)`);
        // (4) set<float> on its own type, and the mirror refusal on an int id
        w.setFloat(FLOAT_ID, 3.5);
        const f108set = w.getFloat(FLOAT_ID);
        w.setFloat(VARIANT, 1.5);
        const stillSeven = w.getInt(VARIANT);
        const okFloat = f108set === 3.5 && stillSeven === 7;
        console.log(`[layout] ${okFloat ? "PASS" : "FAIL"} setprobe float: setFloat(108) -> ${f108set} (want 3.5), setFloat on int id 2 left ${stillSeven} (want 7)`);
        // put the world back
        w.setFloat(FLOAT_ID, f108);
        w.setInt(VARIANT, before);
        console.log(`[layout] INFO setprobe restored: variant ${p.getVariant()} float108 ${w.getFloat(FLOAT_ID)}`);
    } catch (err) {
        console.log(`[layout] FAIL setprobe threw ${(err as Error).message}`);
    }
});

// `varprobe`: the two derived() names that had no derived.json entry, Actor::setVariant (bdsx's own set<int> on id 2) and
// Actor::getOwner (getOwnerId, then the Mob lookup). setVariant is read back through BDS's own getVariant, with two
// values and the restore; a player's owner is null (docs/findings-audit.md "Audit follow-ups").
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "varprobe") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        const before = p.getVariant();
        p.setVariant(3);
        const a = p.getVariant();
        p.setVariant(11);
        const b = p.getVariant();
        p.setVariant(before);
        const c = p.getVariant();
        const ok = a === 3 && b === 11 && c === before;
        console.log(`[layout] ${ok ? "PASS" : "FAIL"} varprobe setVariant: ${before} -> 3:${a} 11:${b} restored:${c} (want 3, 11, ${before})`);
        const owner = p.getOwner();
        console.log(`[layout] ${owner === null ? "PASS" : "FAIL"} varprobe getOwner: player's owner ${owner === null ? "null" : "not null"} (want null)`);
    } catch (err) {
        console.log(`[layout] FAIL varprobe threw ${(err as Error).message}`);
    }
});

// `strprobe`: Actor::setScoreTag (bdsx's own set<string>, 1.26 has no out-of-line copy) and
// Actor::getBlockTarget (the wrapper's getPosition at id 47). The score tag is the strong one --
// bdsx writes the item and BDS's own getString reads it back, including a string long enough to
// leave the small-string buffer and take the heap (docs/findings-synched.md).
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "strprobe") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    const LONG = "bdsx-score-tag-well-past-fifteen-bytes";
    try {
        const w = p.getEntityData();
        const sad = (w as any as StaticPointer).getPointer(0);
        const bitOf = (id: number): number => (sad.getUint32(24 + (id >>> 5) * 4) >>> (id & 31)) & 1;
        const was = p.getScoreTag();
        p.setScoreTag("bdsxscore");
        const short = p.getScoreTag(), shortDirty = bitOf(84);
        p.setScoreTag(LONG);
        const long = p.getScoreTag();
        const ok = short === "bdsxscore" && long === LONG && shortDirty === 1;
        console.log(`[layout] ${ok ? "PASS" : "FAIL"} strprobe scoreTag: "${was}" -> "${short}" -> "${long}" dirty ${shortDirty} (want bdsxscore, the long one, 1)`);
        p.setScoreTag(was);
        console.log(`[layout] ${p.getScoreTag() === was ? "PASS" : "FAIL"} strprobe restore: back to "${p.getScoreTag()}"`);
        // getBlockTarget: a player has no block target, so this reports rather than asserts. The sweep
        // says whether any BlockPos item is non-zero at all, which is what a stronger check would need.
        const bt = p.getBlockTarget();
        console.log(`[layout] INFO strprobe blockTarget: ${bt.x},${bt.y},${bt.z} (a player has none; 0,0,0 is what 2024 returns too)`);
        console.log(`[layout] ${bt.x === 0 && bt.y === 0 && bt.z === 0 ? "PASS" : "INFO"} strprobe blockTarget shape: read without throwing, zero for a missing item`);
    } catch (err) {
        console.log(`[layout] FAIL strprobe threw ${(err as Error).message}`);
    }
});

// `hurtprobe <none|hit>`: Actor's last-hurt block (docs/findings-layouts.md, "The last-hurt block").
// 1.26 keeps the nine fields and no getter: six ship as `accessors` (+824 timestamp, +832 cause,
// +836 damage as a float, +840/+844/+848 the three counters) and the three that name another actor,
// plus wasLastHitByPlayer, are derived() over `layouts.Actor` (+800/+808/+816 ids, +276 countdown).
// Timing is the whole difficulty: the fields are written inside Mob::_hurt, and Actor::baseTick clears
// the byMob id 60 ticks after the hit, so a console command 8 s later reads a cleared block. The probe
// captures the victim on the entityHurt hook (execution-confirmed, docs/findings-slots.md) and snapshots
// the values three ticks later on levelTick; `hurtprobe hit` prints that snapshot.
interface HurtSnapshot {
    damage: number;
    cause: number;
    timestamp: number;
    byMobTime: number;
    byMobTimestamp: number;
    mobTimestamp: number;
    byMobName: string;
    byPlayerName: string;
    mobName: string;
    byMobIsThePlayer: boolean;
    byPlayerIsThePlayer: boolean;
    was: boolean;
    /** the MobHurtTimeComponent countdown as BDS itself left it three ticks after the hit */
    hurtTimeFromBds: number;
    /** the same slot after Actor::setHurtTime wrote a value of ours, and after it put BDS's back */
    hurtTimeWritten: number;
    hurtTimeRestored: number;
}
// `hurtprobe mob` reads the other end of the same hit. getLastHurtMob (+800) and
// getLastHurtMobTimestamp (+840) belong to the *attacker*, not the victim, and nothing a player does
// writes them: the pair is written by Mob::doHurtTarget, inlined (1.26.40.8 0x240a03e, the store
// `movq %rax,800(%rbx)` / `movl 408(%rbx),%eax; movl %eax,840(%rbx)` under `testb $2,528(%rdi)` -- rbx
// is the attacker, rdi the target; 2024's out-of-line ?setLastHurtMob@Actor@@ 0x19c66b0 is the same
// three steps at +944/+968 behind the same bit of target+648). So a mob has to hit something: the
// golem-vs-zombie scenario. On every hit taken by a non-player the probe asks the victim who hit it
// (getLastHurtByMob, +808, already confirmed) and then asks *that* actor what it last hurt. If +800 is
// the field the body says it is, the answer is this very victim, by pointer identity.
interface HurtMobSnapshot {
    attacker: string;
    victim: string;
    mob: string;
    mobIsTheVictim: boolean;
    mobTimestamp: number;
    victimTimestamp: number;
    ok: boolean;
}
let hurtVictim: Actor | null = null;
let hurtSnapVictimId: bin64_t | null = null;
let hurtVictimId: bin64_t = bin.zero(4) as bin64_t;
let hurtTimeDone = false;
let hurtPending = 0;
let hurtSnap: HurtSnapshot | null = null;
let hurtMobSnap: HurtMobSnapshot | null = null;
let hurtMobTries = 0;
let hurtError = "";
let hurtCount = 0;
events.entityHurt.on(ev => {
    try {
        hurtCount++;
        if (ev.entity instanceof Player) return; // the bot gets hit too; the summoned mob is the subject
        hurtVictim = ev.entity;
        hurtVictimId = ev.entity.getUniqueIdBin();
        hurtPending = 3;
        // the sweep needs the same actor at tick 1 and tick 5, so it pins its own subject rather than
        // following hurtVictim, which a second hit in those four ticks would replace
        if (sweepA === null) {
            sweepVictimId = hurtVictimId;
            sweepTick = 0;
        }
    } catch (err) {
        hurtError = `entityHurt: ${(err as Error).message}`;
    }
});
const isThePlayer = (a: Actor | null): boolean => a !== null && joined !== null && (a as any as StaticPointer).equals(joined);
const nameOf = (a: Actor | null): string => {
    if (a === null) return "null";
    try {
        const tag = a.getNameTag();
        return tag === "" ? String(a) : tag;
    } catch (err) {
        return `unreadable(${(err as Error).message})`;
    }
};
// mobs carry no name tag, so the hit-taker and the hit-maker would both print as a bare pointer;
// the identifier makes the line readable without weakening the pointer identity check beside it
const kindOf = (a: Actor | null): string => {
    if (a === null) return "null";
    try {
        return `${a.getIdentifier()}@${String(a)}`;
    } catch (err) {
        return `unidentified(${(err as Error).message})@${String(a)}`;
    }
};
// A sweep of the SynchedActorData int slots over the ticks that follow a hit. 2024's
// Actor::setHurtTime is set<int>(entity_data, 11, time), but 1.26 keeps a MobHurtTimeComponent
// (Endstone mob.h, BuiltInMobComponents) and the first run showed id 11 reading 0 and refusing a
// write, i.e. no Int item there at all. Rather than guess a new id, ask the engine: the slot that
// holds the hurt-time countdown is the one that is non-zero one tick after the hit and smaller four
// ticks later. The sweep reads through getInt, which returns 0 for an id whose item is absent or of
// another type, so a non-zero reading already means "an Int item lives here".
const SWEEP_IDS = 64;
let sweepTick = -1;
let sweepVictimId: bin64_t | null = null;
let sweepA: number[] | null = null;
let sweepB: number[] | null = null;
// The same question asked of the object rather than of the synched data. 1.26 keeps the countdown in a
// MobHurtTimeComponent that Mob holds by pointer, and Endstone's mob.h declares the triple
// BuiltInMobComponents { death_ticking, mob_animation, mob_hurt_time }, so the three consecutive
// pointers around +0x418 are those three components and the hurt-time one is the last of them. The
// check follows exactly that block -- a wild walk over every pointer-shaped word in the Mob found the
// same single answer on both builds when this was first looked for, but it dereferences whatever
// happens to look like a pointer, which is not something a probe should do on every run.
const POINTED_FROM = 0x400;
const POINTED_TO = 0x440;
const POINTED_WORDS = 8;
function pointedInts(a: Actor): Map<string, number> {
    const p = a as any as StaticPointer;
    const out = new Map<string, number>();
    for (let off = POINTED_FROM; off < POINTED_TO; off += 8) {
        try {
            const hi = p.getUint32(off + 4);
            if (hi === 0 || hi > 0xffff) continue;
            const q = p.getPointer(off);
            if (q.isNull()) continue;
            for (let w = 0; w < POINTED_WORDS; w++) out.set(`${off}:${w * 4}`, q.getInt32(w * 4));
        } catch {
            // not a readable pointer
        }
    }
    return out;
}
let pointedA: Map<string, number> | null = null;
let pointedB: Map<string, number> | null = null;
function sweepInts(a: Actor): number[] {
    const ed = a.getEntityData();
    const out: number[] = [];
    for (let id = 0; id < SWEEP_IDS; id++) {
        try {
            out.push(ed.getInt(id as ActorDataIDs));
        } catch {
            out.push(-999999);
        }
    }
    return out;
}
events.levelTick.on(() => {
    if (sweepTick >= 0 && sweepVictimId !== null) {
        // fetched back by id every time: the subject of a hurt event can be dead four ticks later
        const v = Actor.fromUniqueIdBin(sweepVictimId, false);
        if (v === null) sweepTick = -1; // it died; there is nothing left to compare against
        else {
            sweepTick++;
            try {
                if (sweepTick === 1) {
                    sweepA = sweepInts(v);
                    pointedA = pointedInts(v);
                } else if (sweepTick === 5) {
                    sweepB = sweepInts(v);
                    pointedB = pointedInts(v);
                    sweepTick = -1;
                }
            } catch (err) {
                hurtError = `sweep: ${(err as Error).message}`;
                sweepTick = -1;
            }
        }
    }
    if (hurtPending === 0 || hurtVictim === null) return;
    if (--hurtPending > 0) return;
    const a = hurtVictim;
    try {
        const byMob = a.getLastHurtByMob();
        const byPlayer = a.getLastHurtByPlayer();
        const mob = a.getLastHurtMob();
        const snap: HurtSnapshot = {
            damage: a.getLastHurtDamage(),
            cause: a.getLastHurtCause(),
            timestamp: a.getLastHurtTimestamp(),
            byMobTime: a.getLastHurtByMobTime(),
            byMobTimestamp: a.getLastHurtByMobTimestamp(),
            mobTimestamp: a.getLastHurtMobTimestamp(),
            byMobName: nameOf(byMob),
            byPlayerName: nameOf(byPlayer),
            mobName: nameOf(mob),
            byMobIsThePlayer: isThePlayer(byMob),
            byPlayerIsThePlayer: isThePlayer(byPlayer),
            was: a.wasLastHitByPlayer(),
            hurtTimeFromBds: -1,
            hurtTimeWritten: -1,
            hurtTimeRestored: -1,
        };
        // Actor::setHurtTime writes the MobHurtTimeComponent the Mob holds at +0x428 (see below: in
        // 1.26 there is no Int item at SynchedActorData id 11 any more). The round trip goes both
        // ways: BDS has just hurt this mob, so the dword must already hold the engine's own countdown;
        // then bdsx's setter must move it; then putting the engine's value back must land on the same
        // number. The readings here are the probe's own, straight through the pointer.
        //
        // This is the only *write* in the probe, so it obeys the rule the golem session earned: a
        // captured actor is held as an ActorUniqueID and fetched back, never as a pointer. Three ticks
        // is long enough for a mob in a brawl to die, and writing 17 into a freed Actor is heap
        // corruption -- twice today a session died with 0xC0000409 a few seconds later, in the middle
        // of the golem-versus-zombie part, when this wrote through the raw pointer. It is also done
        // once per session: the first hit answers the question, the rest are only risk.
        if (!hurtTimeDone && snap.byPlayerIsThePlayer) {
            const live = Actor.fromUniqueIdBin(hurtVictimId, false);
            if (live !== null) {
                hurtTimeDone = true;
                const hurtTimeAt = (): number => (live as any as StaticPointer).getPointer(0x428).getInt32(0);
                snap.hurtTimeFromBds = hurtTimeAt();
                live.setHurtTime(17);
                snap.hurtTimeWritten = hurtTimeAt();
                live.setHurtTime(snap.hurtTimeFromBds);
                snap.hurtTimeRestored = hurtTimeAt();
            }
        }
        // Keep the hit the console made, not merely the last hit. A session that runs at midnight with
        // difficulty normal has mobs hurting each other in the background, and the snapshot used to be
        // whichever of those landed last -- which is how a run once reported `getLastHurtDamage 3` for a
        // wandering trader that no armour had softened. The player-caused hit, once seen, sticks, and the
        // decay reading below is taken from the very actor the snapshot belongs to.
        if (hurtSnap === null || !hurtSnap.byPlayerIsThePlayer) {
            hurtSnap = snap;
            hurtSnapVictimId = hurtVictimId;
        }
    } catch (err) {
        hurtError = `snapshot: ${(err as Error).message}`;
    }
    // the attacker's side of the same hit: it has, by definition, just hurt this victim
    try {
        const attacker = a.getLastHurtByMob();
        if (attacker !== null && !(attacker instanceof Player)) {
            hurtMobTries++;
            const mob = attacker.getLastHurtMob();
            const snap: HurtMobSnapshot = {
                attacker: kindOf(attacker),
                victim: kindOf(a),
                mob: kindOf(mob),
                mobIsTheVictim: mob !== null && (mob as any as StaticPointer).equals(a as any as StaticPointer),
                mobTimestamp: attacker.getLastHurtMobTimestamp(),
                victimTimestamp: a.getLastHurtMobTimestamp(),
                ok: false,
            };
            snap.ok = snap.mobIsTheVictim && snap.mobTimestamp > 0;
            // keep the first hit that satisfied it; a later exchange must not erase the evidence
            if (hurtMobSnap === null || !hurtMobSnap.ok) hurtMobSnap = snap;
        }
    } catch (err) {
        hurtError = `lastHurtMob: ${(err as Error).message}`;
    }
});
events.command.on(cmd => {
    const m = /^\/?hurtprobe(?: (\w+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1] ?? "none";
    if (step === "none") {
        // nothing has hurt the bot yet: every field is at its initial value, which is the cheapest way
        // to see that the six accessors read memory the Actor actually owns rather than throwing
        if (player === null) { console.log("[layout] no player"); return; }
        const p = player;
        try {
            const got = {
                damage: p.getLastHurtDamage(),
                cause: p.getLastHurtCause(),
                timestamp: p.getLastHurtTimestamp(),
                byMobTime: p.getLastHurtByMobTime(),
                byMobTimestamp: p.getLastHurtByMobTimestamp(),
                mobTimestamp: p.getLastHurtMobTimestamp(),
                byMobNull: p.getLastHurtByMob() === null,
                byPlayerNull: p.getLastHurtByPlayer() === null,
                mobNull: p.getLastHurtMob() === null,
                was: p.wasLastHitByPlayer(),
                isHurt: p.isHurt(),
            };
            const ok = got.damage === 0 && got.byMobNull && got.byPlayerNull && got.mobNull && got.was === false && got.isHurt === false;
            console.log(
                `[layout] ${ok ? "PASS" : "FAIL"} hurtprobe none: ${JSON.stringify(got)} (want damage 0, the three references null, wasLastHitByPlayer false, isHurt false at full health)`,
            );
        } catch (err) {
            console.log(`[layout] FAIL hurtprobe none threw ${(err as Error).message}`);
        }
        return;
    }
    if (step === "mob") {
        // getLastHurtMob / getLastHurtMobTimestamp, the two fields the bot could never move: they are
        // written on the attacker by Mob::doHurtTarget, so the run needs a mob that hits another mob
        if (hurtMobSnap === null) {
            console.log(
                `[layout] FAIL hurtprobe mob: no mob-on-mob hit captured (entityHurt fired ${hurtCount} time(s), ${hurtMobTries} with a non-player attacker)${hurtError === "" ? "" : ", last error " + hurtError}`,
            );
            return;
        }
        const s2 = hurtMobSnap;
        console.log(
            `[layout] ${s2.ok ? "PASS" : "FAIL"} hurtprobe mob: ${s2.attacker} hurt ${s2.victim}, and its getLastHurtMob is ${s2.mob} (the very victim ${s2.mobIsTheVictim}) with getLastHurtMobTimestamp ${s2.mobTimestamp}; the victim's own is ${s2.victimTimestamp} (want the victim by identity and a timestamp above 0)`,
        );
        console.log(`[layout] INFO hurtprobe mob snapshot: ${JSON.stringify(s2)} tries ${hurtMobTries}`);
        return;
    }
    if (hurtSnap === null) {
        console.log(`[layout] FAIL hurtprobe ${step}: nothing captured (entityHurt fired ${hurtCount} time(s), none for a non-player)${hurtError === "" ? "" : ", last error " + hurtError}`);
        return;
    }
    const s = hurtSnap;
    // `damage @e[type=zombie,c=1] 3 entity_attack entity @s` ran as the player: damage is exactly 3, and
    // that is what proves the float fix. What lands in the field is the damage hurtEffects receives, i.e.
    // after the zombie's own armour: 2.94 of the 3 asked for. That it is a fraction at all is the point --
    // the int32_t bdsx declared until now reads eax, which this function never writes, and a float read at a
    // wrong offset does not land next to the number the console asked for.
    const okDamage = s.damage > 2.5 && s.damage <= 3 && s.damage !== Math.round(s.damage);
    const okCause = s.cause === ActorDamageCause.EntityAttack;
    const okWho = s.byMobIsThePlayer && s.byPlayerIsThePlayer && s.was === true;
    const okTimes = s.byMobTime > 0 && s.byMobTime <= 60 && s.byMobTimestamp > 0 && s.timestamp > 0;
    console.log(`[layout] ${okDamage ? "PASS" : "FAIL"} hurtprobe damage: getLastHurtDamage ${s.damage} (want a fraction just under the 3 the console asked for -- float, not int32)`);
    console.log(`[layout] ${okCause ? "PASS" : "FAIL"} hurtprobe cause: getLastHurtCause ${s.cause} (want ${ActorDamageCause.EntityAttack}, EntityAttack)`);
    console.log(
        `[layout] ${okWho ? "PASS" : "FAIL"} hurtprobe who: getLastHurtByMob ${s.byMobName} (the bot ${s.byMobIsThePlayer}) getLastHurtByPlayer ${s.byPlayerName} (the bot ${s.byPlayerIsThePlayer}) wasLastHitByPlayer ${s.was} (want the bot twice and true)`,
    );
    console.log(
        `[layout] ${okTimes ? "PASS" : "FAIL"} hurtprobe times: byMobTime ${s.byMobTime} byMobTimestamp ${s.byMobTimestamp} timestamp ${s.timestamp} mobTimestamp ${s.mobTimestamp} (want 0 < byMobTime <= 60 and both timestamps above 0)`,
    );
    if (sweepA !== null && sweepB !== null) {
        const a = sweepA, b = sweepB;
        const live = [];
        const moved = [];
        for (let id = 0; id < SWEEP_IDS; id++) {
            if (a[id] !== 0) live.push(`${id}=${a[id]}`);
            if (a[id] !== b[id]) moved.push(`${id}: ${a[id]} -> ${b[id]}`);
        }
        console.log(`[layout] INFO hurtprobe sweep live (1 tick after the hit): ${live.join(" ")}`);
        console.log(`[layout] INFO hurtprobe sweep moved (1 tick -> 5 ticks): ${moved.join(" | ")}`);
    } else {
        console.log(`[layout] INFO hurtprobe sweep: not captured (${sweepA === null ? "no A" : "no B"})`);
    }
    if (pointedA !== null && pointedB !== null) {
        const a = pointedA, b = pointedB;
        // a hurt-time countdown is a word that goes down by exactly one per tick: four ticks, four less.
        // Asking for that rather than for "something changed" is what makes this a check and not a dump --
        // among the three built-in mob components only one word behaves that way, and it has to be the
        // one the table ships: the other two components are ticked by other rules and do not count down.
        const down: string[] = [];
        const noisy: string[] = [];
        for (const [k, v] of a) {
            const w = b.get(k);
            if (w === undefined || w === v) continue;
            const where = `Mob+0x${Number(k.split(":")[0]).toString(16)} [+${k.split(":")[1]}] ${v} -> ${w}`;
            if (w === v - 4 && v > 0) down.push(where);
            else noisy.push(where);
        }
        const wantWhere = `Mob+0x428 [+0]`;
        const okScan = down.length === 1 && down[0].startsWith(wantWhere);
        console.log(
            `[layout] ${okScan ? "PASS" : "FAIL"} hurtprobe component: of the ${a.size} words behind the three BuiltInMobComponents pointers, the ones that fell by exactly 4 over 4 ticks are [${down.join(" | ")}] (want exactly one, at ${wantWhere} -- the MobHurtTimeComponent the table ships)`,
        );
        console.log(`[layout] INFO hurtprobe other movers: ${noisy.join(" | ")}`);
    }
    const okHurtTime = s.hurtTimeFromBds > 0 && s.hurtTimeWritten === 17 && s.hurtTimeRestored === s.hurtTimeFromBds;
    console.log(
        `[layout] ${okHurtTime ? "PASS" : "FAIL"} hurtprobe hurttime: three ticks after the hit BDS had left ${s.hurtTimeFromBds} in the MobHurtTimeComponent, setHurtTime(17) made it ${s.hurtTimeWritten}, putting it back made it ${s.hurtTimeRestored} (want a countdown above 0, then 17, then the same countdown)`,
    );
    console.log(`[layout] INFO hurtprobe snapshot: ${JSON.stringify(s)} lastHurtMob ${s.mobName}`);
    // the same entity now, 8 s (160 ticks) after the hit: Actor::baseTick has cleared the byMob id and
    // its countdown, and has left the cause, the damage and the timestamps alone -- a second reading of
    // the same six offsets that no wrong pair of offsets would produce
    try {
        const a = hurtSnapVictimId === null ? null : Actor.fromUniqueIdBin(hurtSnapVictimId, false);
        if (a !== null) {
            const cleared = a.getLastHurtByMob() === null && a.getLastHurtByMobTime() === 0;
            const kept = a.getLastHurtDamage() === s.damage && a.getLastHurtCause() === s.cause && a.getLastHurtTimestamp() === s.timestamp;
            console.log(
                `[layout] ${cleared && kept ? "PASS" : "FAIL"} hurtprobe decay: byMob ${a.getLastHurtByMob() === null ? "null" : "still set"} byMobTime ${a.getLastHurtByMobTime()} damage ${a.getLastHurtDamage()} cause ${a.getLastHurtCause()} timestamp ${a.getLastHurtTimestamp()} (Actor::baseTick clears the id and the countdown 60 ticks after the hit and leaves the rest)`,
            );
        }
    } catch (err) {
        console.log(`[layout] FAIL hurtprobe decay threw ${(err as Error).message}`);
    }
});

// `flagprobe <label>` / `flagwrite`: the status-flag family (docs/findings-synched.md, "The status
// flags"). The bitset is not in SynchedActorData any more -- it is an ECS component whose pointer the
// wrapper caches at +8, which the wrapper's constructor (1.26.40.8 0x2420140 / 1.26.51.1 0x2cb5460)
// stores second, after the SynchedActorDataComponent and before the dirty-flags component.
// Read side: `effect @a invisibility` must turn flag 5 on and `effect @a clear` must turn it off.
// Write side: bdsx calls SynchedActorDataAccess::setActorFlag and checks both the bit and the
// ActorDataIDs dirty bit the engine picks by range (0 for flags <= 63, 92 for 64..127).
const flagNameOf = (i: number): string => (ActorFlags as any)[i] ?? String(i);
function flagParts(p: Player): { bits: StaticPointer; dirty: StaticPointer } | null {
    const w = p.getEntityData() as any as StaticPointer;
    if (w.isNull()) return null;
    const bits = w.getPointer(8), dirty = w.getPointer(16);
    if (bits.isNull() || dirty.isNull()) return null;
    return { bits, dirty };
}
events.command.on(cmd => {
    const argv = cmd.replace(/^\//, "").split(/\s+/);
    if (argv[0] !== "flagprobe") return;
    const label = argv[1] ?? "";
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        const parts = flagParts(p);
        if (parts === null) { console.log(`[layout] FAIL flagprobe ${label}: no flag component at wrapper+8`); return; }
        const words: string[] = [], set: string[] = [];
        for (let w = 0; w < 6; w++) {
            const v = parts.bits.getUint32(w * 4);
            words.push(v.toString(16).padStart(8, "0"));
            for (let b = 0; b < 32; b++) if ((v >>> b) & 1) set.push(flagNameOf(w * 32 + b));
        }
        console.log(`[layout] INFO flagprobe ${label} words ${words.join(" ")}`);
        console.log(`[layout] INFO flagprobe ${label} set: ${set.join(" ") || "(none)"}`);
        // a live player always has these three, and a wrong pointer would not produce them together
        const has = (f: ActorFlags): boolean => p.getStatusFlag(f);
        const sane = has(ActorFlags.HasCollision) && has(ActorFlags.HasGravity);
        console.log(`[layout] ${sane ? "PASS" : "FAIL"} flagprobe ${label} sane: HasCollision ${has(ActorFlags.HasCollision)} HasGravity ${has(ActorFlags.HasGravity)} (want both true), Breathing ${has(ActorFlags.Breathing)}`);
        console.log(`[layout] INFO flagprobe ${label} invisible: ${has(ActorFlags.Invisible)}`);
    } catch (err) {
        console.log(`[layout] FAIL flagprobe ${label} threw ${(err as Error).message}`);
    }
});
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "flagwrite") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        const parts = flagParts(p);
        if (parts === null) { console.log("[layout] FAIL flagwrite: no flag component at wrapper+8"); return; }
        const dirtyBit = (id: number): number => (parts.dirty.getUint32((id >>> 5) * 4) >>> (id & 31)) & 1;
        // clear the two dirty ids first so the check below is about this write and not an earlier one
        for (const id of [0, 92]) {
            const off = (id >>> 5) * 4;
            parts.dirty.setUint32((parts.dirty.getUint32(off) & ~(1 << (id & 31))) >>> 0, off);
        }
        // (1) a flag in the first word: the engine marks ActorDataIDs 0 dirty for anything <= 63
        const wasLow = p.getStatusFlag(ActorFlags.Invisible);
        p.setStatusFlag(ActorFlags.Invisible, !wasLow);
        const gotLow = p.getStatusFlag(ActorFlags.Invisible), dirtyLow = dirtyBit(0);
        const okLow = gotLow === !wasLow && dirtyLow === 1;
        console.log(`[layout] ${okLow ? "PASS" : "FAIL"} flagwrite low: Invisible ${wasLow} -> ${gotLow} (want ${!wasLow}), dirty id 0 ${dirtyLow} (want 1)`);
        p.setStatusFlag(ActorFlags.Invisible, wasLow);
        // (2) a flag past 63, which goes into the second 64-bit word and marks ActorDataIDs 92 instead
        const wasHigh = p.getStatusFlag(ActorFlags.InScaffolding);
        p.setStatusFlag(ActorFlags.InScaffolding, !wasHigh);
        const gotHigh = p.getStatusFlag(ActorFlags.InScaffolding), dirtyHigh = dirtyBit(92), dirty0 = dirtyBit(0);
        const okHigh = gotHigh === !wasHigh && dirtyHigh === 1;
        console.log(`[layout] ${okHigh ? "PASS" : "FAIL"} flagwrite high: InScaffolding(69) ${wasHigh} -> ${gotHigh} (want ${!wasHigh}), dirty id 92 ${dirtyHigh} (want 1), id 0 ${dirty0}`);
        p.setStatusFlag(ActorFlags.InScaffolding, wasHigh);
        // (3) the no-op: the engine only writes when the value differs, so nothing else moves
        const restored = p.getStatusFlag(ActorFlags.Invisible) === wasLow && p.getStatusFlag(ActorFlags.InScaffolding) === wasHigh;
        console.log(`[layout] ${restored ? "PASS" : "FAIL"} flagwrite restore: back to ${wasLow} / ${wasHigh}`);
    } catch (err) {
        console.log(`[layout] FAIL flagwrite threw ${(err as Error).message}`);
    }
});

// `nameprobe`: Actor::setNameTag (1.26.40.8 0xe0e800 / 1.26.51.1 0xd4e6f0). It is not the one-liner
// setScoreTag is -- it does three things, and deriving only the first would silently drop the other
// two, so all three are checked: the NAME data item (id 4), the cached std::string at Actor+736 which
// it empties, and the HashedString of the new name it stores at Actor+392. The third is the decisive
// one, because bdsx can compute that hash itself (HashedString::computeHash is derived).
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "nameprobe") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player, raw = p as any as StaticPointer;
    const NEW = "bdsxnametag";
    try {
        const was = p.getNameTag();
        // the cached string only tells us something if it is not already empty, so put a sentinel in
        // it first -- but only while it is in the small-string state, where the bytes are the object's
        // own (capacity at +760, size at +752, buffer at +736)
        let sentinel = false;
        if (raw.getUint32(760) < 16) {
            raw.setUint8(0x78 /* 'x' */, 736);
            raw.setUint8(0, 737);
            raw.setUint32(1, 752);
            sentinel = true;
        }
        p.setNameTag(NEW);
        const viaBds = p.getNameTag();
        const viaItem = SynchedActorDataEntityWrapper$getString(p.getEntityData(), 4);
        console.log(`[layout] ${viaBds === NEW && viaItem === NEW ? "PASS" : "FAIL"} nameprobe item: getNameTag "${viaBds}" getString(4) "${viaItem}" (want "${NEW}")`);
        const cached = raw.getCxxString(736), cachedSize = raw.getUint32(752);
        const okCache = cached === "" && cachedSize === 0 && sentinel;
        console.log(`[layout] ${okCache ? "PASS" : "FAIL"} nameprobe cache: the std::string at Actor+736 is "${cached}" size ${cachedSize} (want empty after an "x" sentinel; sentinel written ${sentinel})`);
        const want = computeHashOf(NEW), got = raw.getPointer(392);
        const okHash = got.equals(want);
        console.log(`[layout] ${okHash ? "PASS" : "FAIL"} nameprobe hash: Actor+392 ${got} (want computeHash("${NEW}") ${want})`);
        p.setNameTag(was);
        console.log(`[layout] ${p.getNameTag() === was ? "PASS" : "FAIL"} nameprobe restore: back to "${p.getNameTag()}"`);
        // getFloat against known vanilla defaults rather than only "non-zero" (next-steps Q1-1d)
        const w = p.getEntityData();
        const fall = w.getFloat(111 as ActorDataIDs), plate = w.getFloat(140 as ActorDataIDs), ambient = w.getFloat(108 as ActorDataIDs);
        const okFloat = fall === 1 && plate === 64 && ambient === 8;
        console.log(`[layout] ${okFloat ? "PASS" : "FAIL"} nameprobe floats: FALL_DAMAGE_MULTIPLIER ${fall} (want 1) NAMEPLATE_RENDER_DISTANCE_MAX ${plate} (want 64) AMBIENT_SOUND_INTERVAL ${ambient} (want 8)`);
    } catch (err) {
        console.log(`[layout] FAIL nameprobe threw ${(err as Error).message}`);
    }
});

// `miscprobe`: the two bdsx now derives from names it already has -- hasTotemEquipped
// (!getEquippedTotem().isNull()) and Player::isHungry (the hunger attribute's max above its current).
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "miscprobe") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        let totem = "threw";
        try { totem = String(p.hasTotemEquipped()); } catch (err) { totem = `threw ${(err as Error).message}`; }
        console.log(`[layout] INFO miscprobe totem: hasTotemEquipped ${totem}`);
        const attr = p.getAttributes().getMutableInstance(AttributeId.PlayerHunger);
        const cur = attr === null ? NaN : attr.currentValue, max = attr === null ? NaN : attr.maxValue;
        const hungry = p.isHungry();
        const ok = attr !== null && hungry === (max > cur);
        console.log(`[layout] ${ok ? "PASS" : "FAIL"} miscprobe hungry: isHungry ${hungry}, hunger ${cur}/${max} (want isHungry === max > current)`);
    } catch (err) {
        console.log(`[layout] FAIL miscprobe threw ${(err as Error).message}`);
    }
});

// `spawnprobe <what>`: Player's respawn point and the two names that hang off LayeredAbilities
// (docs/findings-layouts.md, "The respawn point"). 1.26 keeps the struct but only two of the five
// functions, so this checks both directions: BDS's own `spawnpoint` / `clearspawnpoint` / `op` write
// the fields and bdsx reads them back, then bdsx writes through setRespawnPosition /
// setSpawnBlockRespawnPosition / setPermissions and BDS's own getters read them.
const SPAWN_UNSET = -2147483648;
function spawnLine(p: Player): string {
    const pos = p.getSpawnPosition();
    const dim = p.getSpawnDimension();
    const has = p.hasRespawnPosition();
    return `pos (${pos.x}, ${pos.y}, ${pos.z}) dim ${dim} has ${has}`;
}
function spawnRaw(p: Player, member: string): number[] {
    // the same three ints through the raw pointer, so a wrong accessor and a wrong layout cannot agree
    const base = (p as any as StaticPointer);
    const off = member === "block" ? 2784 : 2796;
    return [base.getInt32(off), base.getInt32(off + 4), base.getInt32(off + 8)];
}
const spawnEq = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
events.command.on(cmd => {
    const m = /^\/?spawnprobe(?:\s+(\S+))?/.exec(cmd);
    if (m === null) return;
    const what = m[1] ?? "read";
    if (player === null) { console.log("[spawn] no player"); return; }
    const p = player;
    try {
        if (what === "read" || what === "bds") {
            // BDS wrote it with `spawnpoint @a 29 68 14`; bdsx reads it back three ways
            const pos = p.getSpawnPosition(), dim = p.getSpawnDimension(), has = p.hasRespawnPosition();
            const raw = spawnRaw(p, "pos");
            const ok = pos.x === 29 && pos.y === 68 && pos.z === 14 && dim === 0 && has && spawnEq(raw, [29, 68, 14]);
            console.log(`[spawn] ${ok ? "PASS" : "FAIL"} read: ${spawnLine(p)} raw ${raw.join(",")} (want (29, 68, 14) dim 0 has true, after \`spawnpoint @a 29 68 14\`)`);
        } else if (what === "cleared") {
            // BDS wrote the unset value with `clearspawnpoint @a`; the sentinel is what bdsx assumes
            const raw = spawnRaw(p, "pos"), rawBlock = spawnRaw(p, "block");
            const has = p.hasRespawnPosition(), dim = p.getSpawnDimension();
            const ok = spawnEq(raw, [SPAWN_UNSET, SPAWN_UNSET, SPAWN_UNSET]) && !has;
            console.log(`[spawn] ${ok ? "PASS" : "FAIL"} cleared: raw ${raw.join(",")} block ${rawBlock.join(",")} dim ${dim} has ${has} (want INT_MIN,INT_MIN,INT_MIN and has false, after \`clearspawnpoint @a\`)`);
        } else if (what === "set") {
            // bdsx writes through the address; the fields it must move are the ones BDS just moved
            p.setRespawnPosition(BlockPos.create(31, 69, 16), 0);
            const pos = p.getSpawnPosition(), has = p.hasRespawnPosition(), dim = p.getSpawnDimension();
            const ok = pos.x === 31 && pos.y === 69 && pos.z === 16 && has && dim === 0;
            console.log(`[spawn] ${ok ? "PASS" : "FAIL"} set: ${spawnLine(p)} (want (31, 69, 16) dim 0 has true after setRespawnPosition)`);
        } else if (what === "block") {
            // setSpawnBlockRespawnPosition writes the argument into spawn_block_pos AND the player's own
            // position into player_position -- the second half is what a wrong address cannot fake. The
            // body takes x and z from the position (Actor+536) but y from the box below it (Actor+544),
            // so the y it writes is the block the player stands on, not floor(position.y).
            const here = p.getPosition();
            // the body reads y from the box at Actor+544 (`movq 544(%rcx),%rcx; movss 4(%rcx),%xmm1`),
            // which is the AABB's min y -- the block the player stands on, not floor(position.y)
            let feetY = NaN;
            try { feetY = (p as any as StaticPointer).getPointer(544).getFloat32(4); } catch (err) { feetY = NaN; }
            const wantPos = [Math.floor(here.x), Math.floor(feetY), Math.floor(here.z)];
            p.setSpawnBlockRespawnPosition(BlockPos.create(33, 70, 18), 0);
            const rawBlock = spawnRaw(p, "block"), raw = spawnRaw(p, "pos");
            const okBlock = spawnEq(rawBlock, [33, 70, 18]);
            const okPos = raw[0] === wantPos[0] && raw[2] === wantPos[2] && (Number.isNaN(feetY) ? raw[1] <= Math.floor(here.y) && raw[1] >= Math.floor(here.y) - 2 : raw[1] === wantPos[1]);
            console.log(`[spawn] ${okBlock && okPos ? "PASS" : "FAIL"} block: spawn_block ${rawBlock.join(",")} (want 33,70,18) player_position ${raw.join(",")} (want floor of the player's x/z at ${here.x.toFixed(2)},${here.z.toFixed(2)} and the block under its feet ${feetY.toFixed(2)} = ${wantPos.join(",")})`);
        } else if (what === "bed") {
            // the derived setBedRespawnPosition: the same call with the player's own dimension
            p.setBedRespawnPosition(BlockPos.create(35, 71, 20));
            const rawBlock = spawnRaw(p, "block");
            const dim = p.getSpawnDimension();
            const ok = spawnEq(rawBlock, [35, 71, 20]) && dim === p.getDimensionId();
            console.log(`[spawn] ${ok ? "PASS" : "FAIL"} bed: spawn_block ${rawBlock.join(",")} dim ${dim} (want 35,71,20 and the player's own dimension ${p.getDimensionId()})`);
        } else if (what === "clear") {
            // bdsx's own clearRespawnPosition: every int back to the sentinel, dimension back to Undefined
            p.clearRespawnPosition();
            const raw = spawnRaw(p, "pos"), rawBlock = spawnRaw(p, "block"), dim = p.getSpawnDimension();
            const unset = [SPAWN_UNSET, SPAWN_UNSET, SPAWN_UNSET];
            const ok = spawnEq(raw, unset) && spawnEq(rawBlock, unset) && dim === 3 && !p.hasRespawnPosition();
            console.log(`[spawn] ${ok ? "PASS" : "FAIL"} clear: raw ${raw.join(",")} block ${rawBlock.join(",")} dim ${dim} has ${p.hasRespawnPosition()} (want INT_MIN everywhere, dim 3, has false)`);
        } else if (what === "perm") {
            // BDS's `op @a` / `deop @a` moved the byte; bdsx reads it through getAbilities()
            const level = p.getPermissionLevel(), cmdLevel = p.getCommandPermissionLevel();
            console.log(`[spawn] INFO perm: getPermissionLevel ${level} (${PlayerPermission[level] ?? "?"}) getCommandPermissionLevel ${cmdLevel}`);
        } else if (what === "opped") {
            const level = p.getPermissionLevel();
            console.log(`[spawn] ${level === PlayerPermission.OPERATOR ? "PASS" : "FAIL"} opped: getPermissionLevel ${level} (want ${PlayerPermission.OPERATOR}, OPERATOR, after \`op @a\`)`);
        } else if (what === "deopped") {
            const level = p.getPermissionLevel();
            console.log(`[spawn] ${level === PlayerPermission.MEMBER ? "PASS" : "FAIL"} deopped: getPermissionLevel ${level} (want ${PlayerPermission.MEMBER}, MEMBER, after \`deop @a\`)`);
        } else if (what === "setperm") {
            // bdsx writes the command permission; BDS's own Player::getCommandPermissionLevel reads it back
            const was = p.getCommandPermissionLevel();
            p.setPermissions(CommandPermissionLevel.Host);
            const got = p.getCommandPermissionLevel();
            p.setPermissions(was);
            const back = p.getCommandPermissionLevel();
            const ok = got === CommandPermissionLevel.Host && back === was;
            console.log(`[spawn] ${ok ? "PASS" : "FAIL"} setperm: was ${was}, after setPermissions(Host) BDS's own getCommandPermissionLevel says ${got} (want ${CommandPermissionLevel.Host}), restored ${back}`);
        } else if (what === "xpdump") {
            // why the level reads 0 on one build and not the other: is the instance missing, or is it zero?
            const map = p.getAttributes();
            for (let id = 1; id <= 19; id++) {
                let line = "null";
                try {
                    const inst = map.getMutableInstance(id);
                    line = inst === null ? "null" : `current ${inst.currentValue} min ${inst.minValue} max ${inst.maxValue} default ${inst.defaultValue}`;
                } catch (err) { line = `threw ${(err as Error).message}`; }
                if (line !== "null") console.log(`[spawn] INFO xpdump id ${id} (bdsx calls it ${AttributeId[id] ?? "?"}): ${line}`);
            }
            const raw = map as any as StaticPointer;
            const ids = raw.getPointer(0), end = raw.getPointer(8);
            const d = end.subBin(ids.getAddressBin());
            const n = Math.floor((d.getAddressHigh() * 0x100000000 + d.getAddressLow()) / 4);
            const list: number[] = [];
            for (let i = 0; i < Math.min(n, 64); i++) list.push(ids.getUint32(i * 4));
            console.log(`[spawn] INFO xpdump id vector: ${n} entries ${list.join(",")}`);
        } else if (what === "xp") {
            // the XP curve, against the level BDS's `xp <n>L @a` just set
            const level = Math.trunc(p.getExperienceLevel());
            const need = p.getXpNeededForNextLevel();
            const want = level < 15 ? level * 2 + 7 : level < 30 ? level * 5 - 38 : level * 9 - 158;
            console.log(`[spawn] ${need === want ? "PASS" : "FAIL"} xp: level ${level} getXpNeededForNextLevel ${need} (want ${want})`);
        } else {
            console.log(`[spawn] INFO ${what}: ${spawnLine(p)}`);
        }
    } catch (err) {
        console.log(`[spawn] FAIL spawnprobe ${what} threw ${(err as Error).message}`);
    }
});

// `attridprobe <what>`: the attribute ids differ between the two 1.26 builds
// (docs/findings-layouts.md, "The attribute ids are not the same in the two 1.26 builds").
// `dump` walks every live AttributeInstance and looks for something that names it; `snap` and
// `diff` say which id a console command moved, which is a route that does not depend on the
// min/max/default fingerprints at all.
function attrInstances(p: Player): { id: number; inst: AttributeInstance }[] {
    // read the map directly: getMutableInstance now translates the id, so walking the live vector
    // through it would translate twice. This route must not know about the mapping at all.
    const l = pdbcache.layouts.BaseAttributeMap ?? { ids: 0, instances: 24, instanceSize: 128 };
    const map = p.getAttributes() as any as StaticPointer;
    const begin = map.getPointer(l.ids), end = map.getPointer(l.ids + 8);
    const d = end.subBin(begin.getAddressBin());
    const n = Math.floor((d.getAddressHigh() * 0x100000000 + d.getAddressLow()) / 4);
    const base = map.getPointer(l.instances);
    const out: { id: number; inst: AttributeInstance }[] = [];
    for (let i = 0; i < Math.min(n, 64); i++) out.push({ id: begin.getUint32(i * 4), inst: base.addAs(AttributeInstance, i * l.instanceSize) });
    return out;
}
let attrSnap: Map<number, number> | null = null;
events.command.on(cmd => {
    const m = /^\/?attridprobe(?:\s+(\S+))?/.exec(cmd);
    if (m === null) return;
    const what = m[1] ?? "dump";
    if (player === null) { console.log("[attr] no player"); return; }
    const p = player;
    try {
        const live = attrInstances(p);
        const ids = live.map(e => e.id);
        if (what === "dump") {
            // does the instance name itself? anything in the first 0x70 bytes that reaches a
            // readable ASCII string is worth knowing: it would make the mapping name-based
            for (const { id, inst } of live) {
                const raw = inst as any as StaticPointer;
                const found: string[] = [];
                for (let off = 0; off < 0x70; off += 8) {
                    try {
                        const q = raw.getPointer(off);
                        if (q.isNull()) continue;
                        const str = q.getString();
                        if (/^[\x20-\x7e]{4,64}$/.test(str)) found.push(`+0x${off.toString(16)} "${str}"`);
                    } catch (err) { /* not a readable pointer */ }
                }
                console.log(`[attr] INFO dump id ${id}: ${found.length === 0 ? "names nothing in its first 0x70 bytes" : found.join(" ")}`);
            }
        } else if (what === "snap") {
            attrSnap = new Map();
            for (const { id, inst } of live) attrSnap.set(id, inst.currentValue);
            console.log(`[attr] INFO snap: ${ids.length} native ids ${ids.join(",")}`);
        } else if (what.startsWith("diff")) {
            if (attrSnap === null) { console.log("[attr] FAIL diff: no snapshot"); return; }
            const want = what.slice(5); // attridprobe diff:PlayerLevel
            const moved: number[] = [], detail: string[] = [];
            for (const { id, inst } of live) {
                const was = attrSnap.get(id);
                if (was !== undefined && was !== inst.currentValue) { moved.push(id); detail.push(`${id} (${was} -> ${inst.currentValue})`); }
                attrSnap.set(id, inst.currentValue);
            }
            const bdsxId = want === "" ? null : ((AttributeId as any)[want] as number | undefined) ?? null;
            const native = bdsxId === null ? null : p.getAttributes().nativeIdOf(bdsxId);
            const ok = native === null ? moved.length > 0 : moved.includes(native);
            console.log(`[attr] ${ok ? "PASS" : "FAIL"} diff${want === "" ? "" : ":" + want}: native ids moved [${detail.join(", ")}]${native === null ? "" : ` (want ${native}, which is where bdsx's ${want} = ${bdsxId} lands on this build)`}`);
        } else if (what === "ids") {
            // every name bdsx maps, through the shipped table, against the fingerprint that does
            // not change between builds
            const FP: Record<string, [number, number, number]> = {
                PlayerHunger: [0, 20, 20], PlayerSaturation: [0, 20, 5], PlayerExhaustion: [0, 20, 0],
                PlayerLevel: [0, 24791, 0], PlayerExperience: [0, 1, 0], Health: [0, 20, 20],
                FollowRange: [0, 2048, 16], KnockbackResistance: [-2, 1, 0], AttackDamage: [1, 1, 1],
                Absorption: [0, 16, 0], Luck: [-1024, 1024, 0],
            };
            let pass = 0, fail = 0;
            for (const [name, fp] of Object.entries(FP)) {
                const id = (AttributeId as any)[name] as number;
                const native = p.getAttributes().nativeIdOf(id);
                const inst = p.getAttributes().getMutableInstance(id);
                const ok = inst !== null && inst.minValue === fp[0] && inst.maxValue === fp[1] && inst.defaultValue === fp[2];
                ok ? pass++ : fail++;
                console.log(`[attr] ${ok ? "PASS" : "FAIL"} ids ${name}: bdsx ${id} -> native ${native}, ${inst === null ? "no instance" : `min ${inst.minValue} max ${inst.maxValue} default ${inst.defaultValue}`} (want ${fp.join("/")})`);
            }
            console.log(`[attr] ${fail === 0 ? "PASS" : "FAIL"} ids: ${pass} of ${pass + fail} names land on an instance with the right fingerprint; live ids ${ids.join(",")}`);
        }
    } catch (err) {
        console.log(`[attr] FAIL attridprobe ${what} threw ${(err as Error).message}`);
    }
});

// `dirprobe <south|west|north|east>`: Player::getDirection and Player::isSpawned.
// getDirection is bdsx's own body now (docs/findings-layouts.md): the 2024 function is
// Direction::getDirection(sin(yaw), -cos(yaw)) over Actor::getRotation().y, and getRotation is an
// accessor, so nothing in it needs an address. The console moves the value -- `tp @a x y z <yaw> 0`
// sets the yaw -- and two things have to agree at each of the four cardinal yaws: the quadrant that
// Facing.convertYRotationToFacingDirection returns (bdsx code that was already executed on both
// builds, and a different formula: floor(yaw/90 + 0.5) & 3 rather than the sign of a sine) and the
// direction the label asks for. isSpawned rides along: it must be true here, on a player that has
// spawned, and it was read at playerJoin before ServerPlayer::doInitialSpawn wrote the byte.
const wantedDirection: Record<string, { dir: Direction.Type; facing: Facing; yaw: number }> = {
    south: { dir: Direction.Type.South, facing: Facing.South, yaw: 0 },
    west: { dir: Direction.Type.West, facing: Facing.West, yaw: 90 },
    north: { dir: Direction.Type.North, facing: Facing.North, yaw: 180 },
    east: { dir: Direction.Type.East, facing: Facing.East, yaw: -90 },
};
events.command.on(cmd => {
    const m = /^\/?dirprobe(?: (\w+))?$/.exec(cmd);
    if (m === null) return;
    const label = m[1] ?? "south";
    const want = wantedDirection[label];
    if (want === undefined) { console.log(`[layout] FAIL dirprobe: unknown label ${label}`); return; }
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        const yaw = p.getRotation().y;
        const dir = p.getDirection();
        const facing = Facing.convertYRotationToFacingDirection(yaw);
        // BDS normalises the yaw into (-180, 180], so `tp ... 180` reads back as -180 and `tp ... 270`
        // as -90; compare the angles rather than the numbers
        const dy = Math.abs(((yaw - want.yaw) % 360) + 360) % 360;
        const ok = dir === want.dir && facing === want.facing && (dy < 1 || dy > 359);
        console.log(
            `[layout] ${ok ? "PASS" : "FAIL"} dirprobe ${label}: yaw ${yaw} -> getDirection ${dir} (${Direction.Type[dir] ?? "?"}), and Facing.convertYRotationToFacingDirection says ${facing} (${Facing[facing] ?? "?"}) (want ${want.dir} / ${want.facing} at yaw ${want.yaw})`,
        );
    } catch (err) {
        console.log(`[layout] FAIL dirprobe ${label} threw ${(err as Error).message}`);
    }
    try {
        const now = p.isSpawned();
        // what is asserted is only what is known: a player standing in the world has the byte set.
        // Whether bdsx's playerJoin runs before ServerPlayer's initial spawn is BDS's ordering, not
        // ours, so the earlier reading is reported rather than required -- if it prints false, the
        // transition is real evidence and the check can be tightened to demand it.
        console.log(
            `[layout] ${now === true ? "PASS" : "FAIL"} dirprobe spawned: isSpawned is ${now} on a player standing in the world (want true); at playerJoin it read ${spawnedAtJoin}`,
        );
    } catch (err) {
        console.log(`[layout] FAIL dirprobe spawned threw ${(err as Error).message}`);
    }
});

// --- Q1-0(a): the riding family (docs/findings-riding.md) ------------------------------------------
// 1.26 has no address for Actor::getVehicle / isRiding / isPassenger -- every caller inlined the EnTT
// lookup -- so bdsx reads PassengerComponent and VehicleComponent itself. The console moves the value:
// `/ride <rider> start_riding <vehicle>` and `/ride <rider> stop_riding`. The two hooks are the other
// half of the item (`?startRiding@Actor@@UEAA_NAEAV1@_N@Z` gained a third argument in 1.26 and
// `?stopRiding@Actor@@QEAAX_N000@Z` a fourth); they install only behind RIDE_PROBE=1, because every
// session compiles this file and no other session should be taking those hooks.
let rideStarts: string[] = [];
let rideStops: string[] = [];
let ridePair: { rider: bin64_t; vehicle: bin64_t } | null = null;
let riddenVehicle: bin64_t | null = null;
function actorLabel(a: Actor): string {
    try {
        return `${ActorType[a.getEntityTypeId()] ?? a.getEntityTypeId()}`;
    } catch (err) {
        return `threw ${(err as Error).message}`;
    }
}
if (process.env.RIDE_PROBE === "1") {
    events.entityStartRiding.on(ev => {
        // hold the pair as ActorUniqueIDs, never as pointers: the probe reads them many seconds later
        ridePair = { rider: ev.entity.getUniqueIdBin(), vehicle: ev.ride.getUniqueIdBin() };
        rideStarts.push(`${actorLabel(ev.entity)} -> ${actorLabel(ev.ride)}`);
    });
    events.entityStopRiding.on(ev => {
        rideStops.push(
            `${actorLabel(ev.entity)} exit=${ev.exitFromRider} destroyed=${ev.actorIsBeingDestroyed} switching=${ev.switchingRides} teleported=${ev.isBeingTeleported}`,
        );
    });
}
function rideRelation(tag: string, rider: Actor, vehicle: Actor): void {
    riddenVehicle = vehicle.getUniqueIdBin();
    const checks: [string, boolean][] = [];
    checks.push(["rider.isRiding()", rider.isRiding() === true]);
    const got = rider.getVehicle();
    checks.push(["rider.getVehicle() is the vehicle", got !== null && got.equalsptr(vehicle)]);
    checks.push(["rider.isRiding(vehicle)", rider.isRiding(vehicle) === true]);
    checks.push(["vehicle.isPassenger(rider)", vehicle.isPassenger(rider) === true]);
    checks.push(["vehicle.isRiding() is false", vehicle.isRiding() === false]);
    checks.push(["vehicle.getVehicle() is null", vehicle.getVehicle() === null]);
    checks.push(["rider.isPassenger(vehicle) is false", rider.isPassenger(vehicle) === false]);
    checks.push(["rider.isRiding(rider) is false", rider.isRiding(rider) === false]);
    for (const [what, ok] of checks) console.log(`[layout] ${ok ? "PASS" : "FAIL"} rideprobe ${tag}: ${what}`);
    console.log(`[layout] rideprobe ${tag}: rider ${actorLabel(rider)}, vehicle ${actorLabel(vehicle)}, got ${got === null ? "null" : actorLabel(got)}`);
}
events.command.on(cmd => {
    const m = /^\/?rideprobe(?: (\w+))?$/.exec(cmd);
    if (m === null) return;
    const phase = m[1] ?? "before";
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    try {
        if (phase === "before" || phase === "after") {
            const riding = p.isRiding();
            const vehicle = p.getVehicle();
            const ok = riding === false && vehicle === null;
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} rideprobe ${phase}: the player rides nothing (isRiding ${riding}, getVehicle ${vehicle === null ? "null" : actorLabel(vehicle)})`);
            if (phase === "after") {
                // the VehicleComponent side of the negative control: the vehicle the player was in must
                // now say it carries nobody. Read through its ActorUniqueID, never a held pointer.
                if (riddenVehicle !== null) {
                    const wasVehicle = Actor.fromUniqueIdBin(riddenVehicle, false);
                    if (wasVehicle === null) {
                        console.log("[layout] rideprobe after: the vehicle is gone, no passenger-side check");
                    } else {
                        const empty = wasVehicle.isPassenger(p) === false;
                        console.log(`[layout] ${empty ? "PASS" : "FAIL"} rideprobe after: the ${actorLabel(wasVehicle)} the player left carries nobody`);
                    }
                }
                console.log(`[layout] rideprobe events: ${rideStarts.length} entityStartRiding [${rideStarts.join("; ")}], ${rideStops.length} entityStopRiding [${rideStops.join("; ")}]`);
                const okEv = process.env.RIDE_PROBE !== "1" || (rideStarts.length > 0 && rideStops.length > 0);
                console.log(`[layout] ${okEv ? "PASS" : "FAIL"} rideprobe events: both riding events fired through bdsx's own hooks`);
            }
        } else if (phase === "arm") {
            // the smoketest world has riding pairs of its own (a cow in a boat), so the captures are
            // cleared right before the console makes the pair this probe is about
            console.log(`[layout] rideprobe arm: forgetting ${rideStarts.length} start and ${rideStops.length} stop events seen so far [${rideStarts.join("; ")}]`);
            rideStarts = [];
            rideStops = [];
            ridePair = null;
        } else if (phase === "riding") {
            const vehicle = p.getVehicle();
            if (vehicle === null) { console.log("[layout] FAIL rideprobe riding: the player's getVehicle is null after /ride start_riding"); return; }
            const isCart = vehicle.getEntityTypeId() === ActorType.MinecartRideable;
            console.log(`[layout] ${isCart ? "PASS" : "FAIL"} rideprobe riding: the vehicle bdsx found is the minecart the console summoned (${actorLabel(vehicle)})`);
            rideRelation("riding", p, vehicle);
        } else if (phase === "mob" || phase === "gone") {
            if (ridePair === null) { console.log(`[layout] FAIL rideprobe ${phase}: entityStartRiding never fired`); return; }
            const rider = Actor.fromUniqueIdBin(ridePair.rider, false);
            const vehicle = Actor.fromUniqueIdBin(ridePair.vehicle, false);
            if (rider === null || vehicle === null) { console.log(`[layout] FAIL rideprobe ${phase}: one of the pair the event named is gone`); return; }
            if (phase === "mob") {
                rideRelation("mob", rider, vehicle);
            } else {
                // the negative control, on the same two actors and through both components: after
                // /ride ... stop_riding the PassengerComponent side and the VehicleComponent side must
                // both say no, which a lookup that always answers "found" could not do
                const checks: [string, boolean][] = [
                    ["rider.isRiding() is false", rider.isRiding() === false],
                    ["rider.getVehicle() is null", rider.getVehicle() === null],
                    ["rider.isRiding(vehicle) is false", rider.isRiding(vehicle) === false],
                    ["vehicle.isPassenger(rider) is false", vehicle.isPassenger(rider) === false],
                ];
                for (const [what, ok] of checks) console.log(`[layout] ${ok ? "PASS" : "FAIL"} rideprobe gone: ${what}`);
            }
        } else {
            console.log(`[layout] FAIL rideprobe: unknown phase ${phase}`);
        }
    } catch (err) {
        console.log(`[layout] FAIL rideprobe ${phase} threw ${(err as Error).message}`);
    }
});

// ---------------------------------------------------------------------------
// `wxprobe <step>`: the five Actor weather getters (Q1 0 A-1, docs/findings-weather.md).
//
// 1.26 kept all five out of line, in the Actor translation unit and in the 2024 declaration order --
// isInPrecipitation, isInRain, isInSnow, isInThunderstorm -- each one named by the inner Weather
// function it ends in. The console moves every one of them, and the readings are only accepted
// together, because the relations between them are what a wrong address cannot fake:
//
//   raining        precipitation true, and exactly one of rain/snow (the biome temperature decides
//                  which), and thunderstorm false -- the lightning term is 0
//   thundering     precipitation true, exactly one of rain/snow, and thunderstorm == rain
//   roofed         a block put above the column makes all four false without touching the weather
//                  (the heightmap test inside Weather::isPrecipitatingAt), and removing it again
//                  brings them back
//   clear          all four false
//
// and isInWaterOrRain, which is isInWater() || isRainingAt(head position), must equal isInRain at
// every step, because a player standing on a stone platform in the air is in no water at all.
//
// The platform is why the driver builds one: on it the column is open to the sky by construction
// and the heightmap is the block under the player's feet, so nothing about the world's terrain has
// to be assumed. What still has to be true of the world is that the biome has precipitation at all;
// `Bthunder` is a second site a thousand blocks away that says so when the first one is dry.
interface WxReading { precip: string; rain: string; snow: string; thunder: string; waterOrRain: string; inWater: string; portal: string; feet: string; pos: string }
const wxReadings = new Map<string, WxReading>();
const wxRead = (fn: () => boolean): string => {
    try {
        return String(fn());
    } catch (err) {
        return `threw ${(err as Error).message}`;
    }
};
events.command.on(cmd => {
    const m = /^\/?wxprobe(?: (\w+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1] ?? "read";
    if (step !== "verdict") {
        const a = player;
        if (a === null) {
            console.log(`[wx] FAIL ${step}: no player`);
            return;
        }
        let pos = "unreadable";
        try {
            const p = a.getPosition();
            pos = `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`;
        } catch (err) {
            pos = `threw ${(err as Error).message}`;
        }
        // the block the player stands *in* -- getPosition is the eye, so the feet come from the box
        // at Actor+544 the way spawnprobe reads them. A block the console never managed to place
        // must not be able to look like a wrong address.
        let feet = "unreadable";
        try {
            const here = a.getPosition();
            const feetY = (a as any as StaticPointer).getPointer(544).getFloat32(4);
            feet = a
                .getDimensionBlockSource()
                .getBlock(BlockPos.create(Math.floor(here.x), Math.floor(feetY), Math.floor(here.z)))
                .getName();
        } catch (err) {
            feet = `threw ${(err as Error).message}`;
        }
        const reading: WxReading = {
            precip: wxRead(() => a.isInPrecipitation()),
            rain: wxRead(() => a.isInRain()),
            snow: wxRead(() => a.isInSnow()),
            thunder: wxRead(() => a.isInThunderstorm()),
            waterOrRain: wxRead(() => a.isInWaterOrRain()),
            inWater: wxRead(() => a.isInWater()),
            portal: wxRead(() => a.isInsidePortal()),
            feet,
            pos,
        };
        wxReadings.set(step, reading);
        console.log(`[wx] INFO ${step}: ${JSON.stringify(reading)}`);
        return;
    }
    for (const [k, v] of wxReadings) console.log(`[wx] INFO reading ${k}: ${JSON.stringify(v)}`);
    const need = ["Arain", "Athunder", "Aroof", "Aopen", "Aclear"];
    const missing = need.filter(k => !wxReadings.has(k));
    if (missing.length !== 0) {
        console.log(`[wx] FAIL verdict: missing readings ${missing.join(",")}`);
        return;
    }
    const r = (k: string): WxReading => wxReadings.get(k)!;
    if (r("Athunder").precip !== "true") {
        const b = wxReadings.get("Bthunder");
        console.log(
            `[wx] FAIL verdict: the test column never precipitates (site A precip ${r("Athunder").precip}` +
                `${b === undefined ? "" : `, site B precip ${b.precip}`}) -- a biome without rain, or a wrong address`,
        );
        return;
    }
    const xor1 = (k: string): boolean => (r(k).rain === "true") !== (r(k).snow === "true");
    const allFalse = (k: string): boolean =>
        r(k).precip === "false" && r(k).rain === "false" && r(k).snow === "false" && r(k).thunder === "false";
    const checks: [string, boolean, string][] = [
        ["rain precip", r("Arain").precip === "true", `isInPrecipitation ${r("Arain").precip} while it rains (want true)`],
        ["rain one of two", xor1("Arain"), `isInRain ${r("Arain").rain} isInSnow ${r("Arain").snow} (want exactly one true -- the biome picks)`],
        ["rain no thunder", r("Arain").thunder === "false", `isInThunderstorm ${r("Arain").thunder} under /weather rain (want false)`],
        ["thunder precip", r("Athunder").precip === "true", `isInPrecipitation ${r("Athunder").precip} while it thunders (want true)`],
        ["thunder one of two", xor1("Athunder"), `isInRain ${r("Athunder").rain} isInSnow ${r("Athunder").snow} (want exactly one true)`],
        [
            "thunder tracks rain",
            r("Athunder").thunder === r("Athunder").rain,
            `isInThunderstorm ${r("Athunder").thunder} isInRain ${r("Athunder").rain} under /weather thunder (want them equal: thunderstorm is raining && lightning)`,
        ],
        ["roof", allFalse("Aroof"), `a block above the column: ${JSON.stringify(r("Aroof"))} (want all four false, weather untouched)`],
        ["open again", r("Aopen").precip === "true", `isInPrecipitation ${r("Aopen").precip} after the block is removed (want true)`],
        ["clear", allFalse("Aclear"), `after /weather clear: ${JSON.stringify(r("Aclear"))} (want all four false)`],
    ];
    for (const k of need) {
        // isInWaterOrRain is isInWater() || isRainingAt(head position); the player stands on a stone
        // platform in the air, so the water term is false and the two must agree at every step.
        checks.push([
            `waterOrRain ${k}`,
            r(k).waterOrRain === r(k).rain && r(k).inWater !== "true",
            `isInWaterOrRain ${r(k).waterOrRain} isInRain ${r(k).rain} isInWater ${r(k).inWater} (want the first two equal and no water)`,
        ]);
    }
    for (const [name, ok, why] of checks) console.log(`[wx] ${ok ? "PASS" : "FAIL"} ${name}: ${why}`);
});

// ---------------------------------------------------------------------------
// The A-2 three (Q1 0 A-2, docs/findings-weather.md): `wxmob <phase|off>` and `wxjump`.
//
// isInWater and isJumping are one EnTT existence test each -- 2024 spells both as
// `add rcx,8; jmp <ActorEnvironment::getIsInWater | MobJump::isJumping>` and both callees are
// `ctx.hasComponent<...>()`, an empty flag type with no payload at all. 1.26 has no out-of-line
// copy of either, so bdsx does the membership test itself (`enttHas`, docs/findings-riding.md).
// The water hash is corroborated inside the binary: it is the immediate in front of the rain test
// in Actor::isInWaterOrRain, whose address the weather half of this probe checks.
// isInsidePortal is an address.
//
// **The bot cannot answer any of these.** A headless client that never sends movement runs no
// player physics on the server: put it in a water block and its isInWater stays false -- and so
// does the *binary's* own isInWaterOrRain, which is how we know it is the world and not the
// lookup. Every positive here therefore comes from a mob, which does tick. The mobs are the ones
// the console hurt (entityHurt is execution-confirmed), they are held as ActorUniqueIDs and
// fetched back, and each phase is *sampled every tick* rather than read once, so the exact moment
// the console command lands does not matter.
interface WxMobPhase { water: [number, number]; portal: [number, number]; mobs: number }
const wxMobPhases = new Map<string, WxMobPhase>();
let wxPhase = "";
const wxIsJumping = (a: Actor): boolean => (Player.prototype as unknown as Record<string, () => boolean>).isJumping.call(a as unknown as Player);
const wxJumpIds: bin64_t[] = [];
const wxJumpSeen = new Map<string, { kind: string; t: number; f: number }>();
let wxPlayerJumpTrue = 0;
let wxPlayerJumpFalse = 0;
let wxMobError = "";
// the block a mob is standing in: x/z from the position, y from the bounding box at Actor+544
// (getPosition is eye-height). The water phase reported this and it is what showed the basin
// really was water; the portal phase records it at the first true, so the positive says what
// the mob was standing in rather than only how many ticks it lasted.
let wxPortalWitness = "";
const wxFeet = (a: Actor): string => {
    const here = a.getPosition();
    const feetY = (a as any as StaticPointer).getPointer(544).getFloat32(4);
    const at = BlockPos.create(Math.floor(here.x), Math.floor(feetY), Math.floor(here.z));
    return `${at.x},${at.y},${at.z} = ${a.getDimensionBlockSource().getBlock(at).getName()}`;
};
events.entityHurt.on(ev => {
    try {
        const a = ev.entity;
        if (a instanceof Player) return;
        // only the rabbits the driver summons. A session at difficulty easy has zombies and golems
        // hurting each other in the background, and the first run of this check sampled those
        // instead of the mob the console had just teleported into the water.
        const kind = kindOf(a);
        if (!kind.includes("rabbit")) return;
        const id = a.getUniqueIdBin();
        if (wxJumpSeen.has(id)) return;
        wxJumpSeen.set(id, { kind, t: 0, f: 0 });
        if (wxJumpIds.length < 8) wxJumpIds.push(id);
    } catch (err) {
        wxMobError = `capture: ${(err as Error).message}`;
    }
});
events.levelTick.on(() => {
    try {
        const p = player;
        if (p !== null) {
            if (wxIsJumping(p)) wxPlayerJumpTrue++;
            else wxPlayerJumpFalse++;
        }
    } catch (err) {
        wxMobError = `player: ${(err as Error).message}`;
    }
    if (wxJumpIds.length === 0) return;
    try {
        const phase = wxPhase === "" ? null : wxMobPhases.get(wxPhase)!;
        let live = 0;
        for (const id of wxJumpIds) {
            const a = Actor.fromUniqueIdBin(id, false);
            if (a === null) continue;
            live++;
            const seen = wxJumpSeen.get(id)!;
            // bdsx declares isJumping on Player only, but the name is ?isJumping@Actor@@ and the
            // component is a Mob's, so a hopping rabbit is what can answer it
            if (wxIsJumping(a)) seen.t++;
            else seen.f++;
            if (phase !== null) {
                phase.water[a.isInWater() ? 0 : 1]++;
                const inPortal = a.isInsidePortal();
                phase.portal[inPortal ? 0 : 1]++;
                if (inPortal && wxPortalWitness === "") wxPortalWitness = `${kindOf(a)} in phase ${wxPhase}, feet block ${wxFeet(a)}`;
            }
        }
        if (phase !== null) phase.mobs = Math.max(phase.mobs, live);
    } catch (err) {
        wxMobError = `sample: ${(err as Error).message}`;
        wxJumpIds.length = 0;
    }
});
events.command.on(cmd => {
    const m = /^\/?wxmob (\w+)$/.exec(cmd);
    if (m === null) return;
    const phase = m[1];
    if (phase === "off") {
        wxPhase = "";
        return;
    }
    wxPhase = phase;
    if (!wxMobPhases.has(phase)) wxMobPhases.set(phase, { water: [0, 0], portal: [0, 0], mobs: 0 });
    let feet = "unreadable";
    try {
        let a: Actor | null = null;
        for (const id of wxJumpIds) {
            a = Actor.fromUniqueIdBin(id, false);
            if (a !== null) break;
        }
        if (a === null) feet = "no live mob";
        else feet = wxFeet(a);
    } catch (err) {
        feet = `threw ${(err as Error).message}`;
    }
    console.log(`[wx] INFO phase ${phase} begins, ${wxJumpIds.length} captured mob(s), first one's feet block ${feet}`);
});
events.command.on(cmd => {
    if (!/^\/?wxjump$/.test(cmd)) return;
    for (const [, s2] of wxJumpSeen) console.log(`[wx] INFO jump sample ${s2.kind}: jumping ${s2.t} tick(s), not jumping ${s2.f}`);
    const hopped = [...wxJumpSeen.values()].filter(s2 => s2.t > 0 && s2.f > 0);
    console.log(
        `[wx] ${hopped.length > 0 ? "PASS" : "FAIL"} jumping mob: ${hopped.length} of ${wxJumpSeen.size} sampled mob(s) were seen both jumping and not jumping` +
            `${wxMobError === "" ? "" : ` (last error ${wxMobError})`}`,
    );
    console.log(
        `[wx] ${wxPlayerJumpTrue === 0 && wxPlayerJumpFalse > 0 ? "PASS" : "FAIL"} jumping player: the bot, which never jumps, read true ${wxPlayerJumpTrue} time(s) and false ${wxPlayerJumpFalse} time(s)`,
    );
});
events.command.on(cmd => {
    if (!/^\/?wxverdict2$/.test(cmd)) return;
    for (const [k, v] of wxMobPhases) {
        console.log(`[wx] INFO phase ${k}: mobs ${v.mobs}, isInWater true/false ${v.water[0]}/${v.water[1]}, isInsidePortal true/false ${v.portal[0]}/${v.portal[1]}`);
    }
    const need = ["dry", "water", "dry2", "portal", "portalend"];
    const missing = need.filter(k => !wxMobPhases.has(k));
    if (missing.length !== 0) {
        console.log(`[wx] FAIL verdict2: missing phases ${missing.join(",")}${wxMobError === "" ? "" : ` (last error ${wxMobError})`}`);
        return;
    }
    console.log(`[wx] INFO portal witness: ${wxPortalWitness === "" ? "isInsidePortal was never true" : wxPortalWitness}`);
    const q = (k: string): WxMobPhase => wxMobPhases.get(k)!;
    const sampled = (k: string): boolean => q(k).water[0] + q(k).water[1] > 0;
    const p = wxReadings.get("noportal");
    const checks: [string, boolean, string][] = [
        ["mob sampled", need.every(sampled), `ticks sampled per phase: ${need.map(k => `${k} ${q(k).water[0] + q(k).water[1]}`).join(", ")} (want all above 0)`],
        // every negative check names the phase it read, because a phase whose mobs are all dead
        // reads 0 true as well: that is what the drowned first run looked like, and `sampled` is
        // what keeps "nothing was asked" from passing as "the answer was false".
        ["water off", sampled("dry") && q("dry").water[0] === 0, `isInWater true ${q("dry").water[0]} of ${q("dry").water[0] + q("dry").water[1]} tick(s) on dry land (want 0 of above 0)`],
        ["water on", q("water").water[0] > 0, `isInWater true ${q("water").water[0]} of ${q("water").water[0] + q("water").water[1]} tick(s) with the platform flooded (want above 0)`],
        ["water off again", sampled("dry2") && q("dry2").water[0] === 0, `isInWater true ${q("dry2").water[0]} of ${q("dry2").water[0] + q("dry2").water[1]} tick(s) after the water is taken away (want 0 of above 0)`],
        ["portal off", sampled("dry") && q("dry").portal[0] === 0, `isInsidePortal true ${q("dry").portal[0]} of ${q("dry").portal[0] + q("dry").portal[1]} tick(s) on plain stone (want 0 of above 0)`],
        // 2024's body is two comparisons: the inside block's BlockLegacy against
        // `VanillaBlockTypes::mPortal`, and, failing that, the block name's hash against
        // `VanillaBlockTypeIds::EndPortal`. Both branches are asked here, because a bare nether
        // portal block deletes itself (the run that filled eighteen of them found them gone eight
        // seconds later) so that one needs a lit obsidian frame, while an end portal block has no
        // validity rule at all and can simply be placed.
        [
            "portal on",
            q("portal").portal[0] + q("portalend").portal[0] > 0,
            `isInsidePortal true ${q("portal").portal[0]} of ${q("portal").portal[0] + q("portal").portal[1]} tick(s) in a nether portal and ` +
                `${q("portalend").portal[0]} of ${q("portalend").portal[0] + q("portalend").portal[1]} tick(s) in an end portal (want above 0 in either -- they are the two blocks the body compares against)`,
        ],
    ];
    if (p !== undefined) {
        checks.push([
            "player never ticks these",
            p.inWater === "false" && p.portal === "false",
            `the bot on dry stone reads isInWater ${p.inWater} isInsidePortal ${p.portal} (want both false -- the negative control, and the only thing the bot can answer here)`,
        ]);
    }
    for (const [name, ok, why] of checks) console.log(`[wx] ${ok ? "PASS" : "FAIL"} ${name}: ${why}`);
});

// `fieldprobe <step>`: the Q1-0 B batch -- four names 1.26 left no body for, each one field
// (docs/findings-layouts.md). Every step is written so that the thing that answers is not the thing
// being checked: the distances come out of console coordinates, the speed out of a position this
// probe recorded a tick earlier, and the two Player bytes are read back by BDS's own functions.
const FTAG = "[field]";
function fcheck(step: string, ok: boolean, why: string): void {
    console.log(`${FTAG} ${ok ? "PASS" : "FAIL"} ${step}: ${why}`);
}
// BDS's own `?canOpenContainerScreen@Player@@QEAA_NXZ`: false exactly when the container-manager
// member is non-null, which is the half of it this batch needs. Bound lazily so a build whose table
// lacks the name costs the session nothing.
// BDS's own `?canShowNameTag@Actor@@UEBA_NXZ` (Actor vftable slot 32 on both builds): an inline
// try_get<ActorDataFlagComponent> and `byte+1 & 0x40`, i.e. flag 14 -- the reader setNameTagVisible's
// write has to reach. Bound lazily like canOpenContainerScreen.
let canShowNameTag: ((a: Actor) => boolean) | null = null;
let canShowError = "";
try {
    const fn = procHacker.js("?canShowNameTag@Actor@@UEBA_NXZ", bool_t, { this: Actor });
    canShowNameTag = (a: Actor) => (fn as any).call(a);
} catch (err) {
    canShowError = (err as Error).message;
}
let canOpenContainerScreen: ((p: Player) => boolean) | null = null;
let canOpenError = "";
try {
    const fn = procHacker.js("?canOpenContainerScreen@Player@@QEAA_NXZ", bool_t, { this: Player });
    canOpenContainerScreen = (p: Player) => (fn as any).call(p);
} catch (err) {
    canOpenError = (err as Error).message;
}

// the speed check: every tick, remember where each sampled actor was, and compare the next tick's
// getSpeedInMetersPerSecond with 20 * (how far it actually moved since then)
interface SpeedRow { kind: string; agree: number; disagree: number; moving: number; max: number; worst: number; raw: string; hurt: string; hurtSpeed: number }
// the nine floats at the state vector, so a reading of zero can say which of the two it is:
// pos_prev holding a copy of pos at the moment levelTick runs, or +12 not being pos_prev at all
function stateVectorFloats(a: Actor): string {
    const v = (a as unknown as StaticPointer).getPointer(pdbcache.layouts.Actor?.stateVector ?? 536);
    const f: string[] = [];
    for (let i = 0; i < 9; i++) f.push(v.getFloat32(i * 4).toFixed(4));
    return `pos[${f.slice(0, 3).join(" ")}] prev[${f.slice(3, 6).join(" ")}] delta[${f.slice(6, 9).join(" ")}]`;
}
const speedRows = new Map<string, SpeedRow>();
const speedPrev = new Map<string, [number, number, number]>();
const speedIds: bin64_t[] = [];
let speedOn = false;
let speedError = "";
events.entityHurt.on(ev => {
    try {
        if (!speedOn) return;
        const a = ev.entity;
        if (a instanceof Player) return;
        const id = a.getUniqueIdBin();
        if (!speedRows.has(id)) {
            speedRows.set(id, { kind: kindOf(a), agree: 0, disagree: 0, moving: 0, max: 0, worst: 0, raw: "", hurt: "", hurtSpeed: 0 });
            if (speedIds.length < 8) speedIds.push(id);
        }
        // The one reading taken from inside the tick rather than between two of them. levelTick runs
        // after the engine has copied pos into pos_prev, so the 2024 formula is 0 there by
        // construction; a hurt hook fires in the middle of the actor's own tick -- for a falling mob,
        // right after the move -- which is where the two are still a tick apart.
        const row = speedRows.get(id)!;
        const speed = a.getSpeedInMetersPerSecond();
        if (speed > row.hurtSpeed) {
            row.hurtSpeed = speed;
            row.hurt = `${speed.toFixed(3)} m/s, ${stateVectorFloats(a)}`;
        }
    } catch (err) {
        speedError = `capture: ${(err as Error).message}`;
    }
});
events.levelTick.on(() => {
    if (!speedOn) return;
    try {
        for (const id of speedIds) {
            const a = Actor.fromUniqueIdBin(id, false);
            if (a === null) continue;
            const row = speedRows.get(id)!;
            const p = a.getPosition();
            const here: [number, number, number] = [p.x, p.y, p.z];
            const was = speedPrev.get(id);
            speedPrev.set(id, here);
            if (was === undefined) continue;
            const moved = Math.sqrt((here[0] - was[0]) ** 2 + (here[1] - was[1]) ** 2 + (here[2] - was[2]) ** 2);
            const speed = a.getSpeedInMetersPerSecond();
            if (speed > row.max) row.max = speed;
            if (moved === 0 && speed === 0) continue;
            row.moving++;
            if (row.raw === "" && moved > 0.05) row.raw = `moved ${moved.toFixed(4)} this tick, ${stateVectorFloats(a)}`;
            const err = Math.abs(speed - moved * 20);
            if (err > row.worst) row.worst = err;
            if (err < 0.02) row.agree++;
            else row.disagree++;
        }
    } catch (err) {
        speedError = `sample: ${(err as Error).message}`;
        speedIds.length = 0;
    }
});

// `fieldprobe worldon` / `world`: the isInWorld sampler. Mobs are captured by the hurt hook and held
// by ActorUniqueID; every tick each is fetched twice through BDS's own Level::fetchEntity -- once
// allowing removed actors and once not -- so the answer "is it still in the world" comes from the
// engine, and bdsx's derived isInWorld() on the same object is compared with it.
interface WorldRow { kind: string; inWorld: number; out: number; agree: number; disagree: number; gone: boolean; first: string }
const worldRows = new Map<string, WorldRow>();
let worldOn = false;
let worldError = "";
events.entityHurt.on(ev => {
    try {
        if (!worldOn) return;
        const a = ev.entity;
        if (a instanceof Player) return;
        const id = a.getUniqueIdBin();
        if (!worldRows.has(id) && worldRows.size < 6) worldRows.set(id, { kind: kindOf(a), inWorld: 0, out: 0, agree: 0, disagree: 0, gone: false, first: "" });
    } catch (err) {
        worldError = `capture: ${(err as Error).message}`;
    }
});
events.levelTick.on(() => {
    if (!worldOn) return;
    try {
        const level = bedrockServer.level;
        for (const [id, row] of worldRows) {
            if (row.gone) continue;
            const any = level.fetchEntity(id, true);
            if (any === null) {
                row.gone = true;
                continue;
            }
            const live = level.fetchEntity(id, false) !== null;
            const w = any.isInWorld();
            if (w) row.inWorld++;
            else {
                row.out++;
                if (row.first === "") {
                    const sp = any as unknown as StaticPointer;
                    const l = pdbcache.layouts.Actor ?? {};
                    row.first = `added=${sp.getUint8(l.added ?? 233)} removed=${sp.getUint8(l.removed ?? 737)} fetch(live)=${live}`;
                }
            }
            if (w === live) row.agree++;
            else row.disagree++;
        }
    } catch (err) {
        worldError = `sample: ${(err as Error).message}`;
        worldOn = false;
    }
});

events.command.on(cmd => {
    const m = /^\/?fieldprobe (\w+)(?: (\S+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const p = player;
    if (p === null) {
        console.log(`${FTAG} FAIL ${step}: no player`);
        return;
    }
    try {
        switch (step) {
            case "dist": {
                // Two points the console typed, ten blocks apart on x at the same y and z. Whatever the
                // player's own y is, d2^2 - d1^2 has to be 100 -- so this checks the arithmetic without
                // needing to know where getPosition puts the eye.
                const x = Number(m[2] ?? "29.5");
                const d1 = p.distanceTo(Vec3.create(x, 68, 14.5));
                const d2 = p.distanceTo(Vec3.create(x + 10, 68, 14.5));
                const pos = p.getPosition();
                console.log(`${FTAG} INFO dist pos=${pos.x.toFixed(3)} ${pos.y.toFixed(3)} ${pos.z.toFixed(3)} d1=${d1} d2=${d2} d2^2-d1^2=${d2 * d2 - d1 * d1}`);
                fcheck("dist", Math.abs(d2 * d2 - d1 * d1 - 100) < 0.05, `distanceTo to two points the console placed ten blocks apart gives ${d1} and ${d2}, and ${(d2 * d2 - d1 * d1).toFixed(3)} is 100`);
                fcheck("dist-zero", p.distanceTo(pos) < 1e-3, `distanceTo(its own getPosition()) is ${p.distanceTo(pos)}`);
                break;
            }
            case "speedon":
                speedOn = true;
                speedRows.clear();
                speedPrev.clear();
                speedIds.length = 0;
                console.log(`${FTAG} INFO speed sampling on`);
                break;
            case "speed": {
                const bot = p.getSpeedInMetersPerSecond();
                console.log(`${FTAG} INFO speed bot=${bot}`);
                fcheck("speed-still", bot === 0, `a bot that never moves reads ${bot} m/s`);
                let moving = 0, agree = 0, disagree = 0, max = 0;
                for (const [, r] of speedRows) {
                    console.log(`${FTAG} INFO speed sample ${r.kind}: moving ticks ${r.moving}, agree ${r.agree}, disagree ${r.disagree}, max ${r.max.toFixed(3)} m/s, worst error ${r.worst.toFixed(4)}`);
                    console.log(`${FTAG} INFO speed raw ${r.kind}: ${r.raw === "" ? "(never moved more than 0.05 in a tick)" : r.raw}`);
                    console.log(`${FTAG} INFO speed inhook ${r.kind}: ${r.hurt === "" ? "(never hurt)" : r.hurt}`);
                    moving += r.moving;
                    agree += r.agree;
                    disagree += r.disagree;
                    if (r.max > max) max = r.max;
                }
                fcheck("speed-sampled", moving >= 20, `${moving} tick(s) of movement were sampled across ${speedRows.size} mob(s)`);
                // Between two ticks the engine has already copied pos into pos_prev, so 2024's formula
                // is zero there -- for every actor, on every build, including the baseline. That is not
                // a wrong offset, and the `raw` line above says so: pos and pos_prev are bit-identical
                // while pos_delta at +24 holds that tick's movement.
                fcheck("speed-between-ticks", max === 0, `read between ticks, every actor is 0 m/s (fastest seen: ${max.toFixed(3)})`);
                let inhook = 0;
                for (const [, r] of speedRows) if (r.hurtSpeed > 0) inhook++;
                let best = 0;
                for (const [, r] of speedRows) if (r.hurtSpeed > best) best = r.hurtSpeed;
                fcheck("speed-in-tick", inhook > 0, `read from inside the actor's own tick (a hurt hook), ${inhook} of ${speedRows.size} mob(s) gave a non-zero speed, fastest ${best.toFixed(3)} m/s` +
                    `${speedError === "" ? "" : ` (last error ${speedError})`}`);
                speedOn = false;
                break;
            }
            case "init": {
                // bdsx writes the byte, BDS's own ServerPlayer::isPlayerInitialized reads it back.
                const off = pdbcache.layouts.ServerPlayer?.localPlayerInitialized;
                const sp = p as unknown as StaticPointer;
                const before = p.isPlayerInitialized();
                console.log(`${FTAG} INFO init offset=${off} before=${before} byte=${off === undefined ? "?" : sp.getUint8(off)}`);
                if (off === undefined) {
                    fcheck("init", false, "this build's symbols.json has no layouts.ServerPlayer.localPlayerInitialized");
                    break;
                }
                fcheck("init-before", before, "BDS says a joined bot is initialized");
                sp.setUint8(0, off);
                const cleared = p.isPlayerInitialized();
                p.setLocalPlayerAsInitialized();
                const again = p.isPlayerInitialized();
                console.log(`${FTAG} INFO init cleared=${cleared} again=${again} byte=${sp.getUint8(off)}`);
                fcheck("init-clear", !cleared, `zeroing +${off} makes BDS's own isPlayerInitialized() answer false`);
                fcheck("init-set", again, `setLocalPlayerAsInitialized() puts it back, and BDS answers true again`);
                break;
            }
            case "container": {
                // Same shape: bdsx writes the pointer, BDS's own canOpenContainerScreen reads it.
                const off = pdbcache.layouts.Player?.containerManager;
                const sp = p as unknown as StaticPointer;
                if (off === undefined) {
                    fcheck("container", false, "this build's symbols.json has no layouts.Player.containerManager");
                    break;
                }
                const before = p.hasOpenContainer();
                const canBefore = canOpenContainerScreen === null ? null : canOpenContainerScreen(p);
                console.log(`${FTAG} INFO container offset=${off} hasOpen=${before} canOpen=${canBefore}${canOpenError === "" ? "" : ` (canOpenContainerScreen unavailable: ${canOpenError})`}`);
                fcheck("container-empty", !before, "a bot with nothing open reads hasOpenContainer() false");
                fcheck("container-canopen", canBefore === true, `BDS's own canOpenContainerScreen() is ${canBefore} while the member is null`);
                // any non-null value will do: nothing else runs between the write and the restore
                sp.setPointer(p as unknown as VoidPointer, off);
                const held = p.hasOpenContainer();
                const canHeld = canOpenContainerScreen === null ? null : canOpenContainerScreen(p);
                sp.setPointer(null, off);
                const after = p.hasOpenContainer();
                const canAfter = canOpenContainerScreen === null ? null : canOpenContainerScreen(p);
                console.log(`${FTAG} INFO container held=${held}/${canHeld} restored=${after}/${canAfter}`);
                fcheck("container-held", held, `writing a non-null pointer at +${off} makes hasOpenContainer() true`);
                fcheck("container-bds", canHeld === false, `and BDS's own canOpenContainerScreen() turns ${canHeld} -- it is the same member`);
                fcheck("container-restored", !after && canAfter === canBefore, `clearing it puts both answers back (${after}, ${canAfter})`);
                break;
            }
            case "respawnread": {
                // The engine writes these three: after `spawnpoint` and a death, BDS's own respawn path
                // stores the candidate (the spawn point + 0.5 on x and z) and the ready byte. bdsx only reads.
                const l = pdbcache.layouts.Player ?? {};
                const sp = p as unknown as StaticPointer;
                const off = l.respawnOriginalPosition;
                if (off === undefined) {
                    fcheck("respawnread", false, "this build's symbols.json has no layouts.Player.respawnOriginalPosition");
                    break;
                }
                const [x, z] = (m[2] ?? "34,16").split(",").map(Number);
                const v = [sp.getFloat32(off), sp.getFloat32(off + 4), sp.getFloat32(off + 8)];
                const pos = p.getPosition();
                console.log(`${FTAG} INFO respawnread vec=${v.map(n => n.toFixed(3)).join(" ")} ready=${sp.getUint8(l.respawnReady!)} spawned=${sp.getUint8(1801)} end=${sp.getUint8(l.respawningFromTheEnd!)} pos=${pos.x.toFixed(3)} ${pos.y.toFixed(3)} ${pos.z.toFixed(3)}`);
                fcheck("respawnread-vec", v[0] === x + 0.5 && v[2] === z + 0.5, `after \`spawnpoint @a ${x} .. ${z}\` and a death, +${off} holds ${v[0]}, ${v[2]} = the spawn point + 0.5`);
                fcheck("respawnread-pos", near(pos.x, v[0]) && near(pos.z, v[2]), `and the respawned player stands there (${pos.x.toFixed(3)}, ${pos.z.toFixed(3)})`);
                break;
            }
            case "respawnwrite": {
                // bdsx writes through the derived setRespawnReady, then BDS's own Player::respawn reads the
                // Vec3 back: its body copies +2904 into the state vector's pos_prev and moves the player there.
                const l = pdbcache.layouts.Player ?? {};
                const sp = p as unknown as StaticPointer;
                const off = l.respawnOriginalPosition!;
                const target = Vec3.create(31.5, 69.25, 17.5);
                sp.setUint8(0, l.respawnReady!);
                sp.setUint8(1, l.respawningFromTheEnd!);
                p.setRespawnReady(target);
                const ready = sp.getUint8(l.respawnReady!), end = sp.getUint8(l.respawningFromTheEnd!);
                fcheck("respawnwrite-bytes", ready === 1 && end === 0, `setRespawnReady() leaves the ready byte ${ready} and the from-the-end byte ${end}`);
                p.respawn();
                const sv = sp.getPointer(pdbcache.layouts.Actor?.stateVector ?? 536);
                const prev = [sv.getFloat32(12), sv.getFloat32(16), sv.getFloat32(20)];
                const pos = p.getPosition();
                console.log(`${FTAG} INFO respawnwrite vec=${[sp.getFloat32(off), sp.getFloat32(off + 4), sp.getFloat32(off + 8)].join(" ")} prev=${prev.join(" ")} pos=${pos.x} ${pos.y} ${pos.z}`);
                fcheck("respawnwrite-bds", prev[0] === target.x && prev[1] === target.y && prev[2] === target.z, `BDS's own Player::respawn() copies exactly (${prev.join(", ")}) into pos_prev`);
                fcheck("respawnwrite-pos", near(pos.x, target.x) && near(pos.z, target.z), `and puts the player at x ${pos.x.toFixed(3)} z ${pos.z.toFixed(3)}`);
                break;
            }
            case "worldon":
                worldOn = true;
                worldRows.clear();
                console.log(`${FTAG} INFO world sampling on`);
                break;
            case "world": {
                // hasDimension is a held-back candidate; its test runs inside isInWorld only
                const inW = p.isInWorld();
                const sp = p as unknown as StaticPointer;
                const l = pdbcache.layouts.Actor ?? {};
                console.log(`${FTAG} INFO world bot isInWorld=${inW} added=${sp.getUint8(l.added ?? 233)} removed=${sp.getUint8(l.removed ?? 737)} dimension=${p.getDimensionId()}`);
                fcheck("world-bot", inW, `a joined bot is in the world (${inW})`);
                let inWorld = 0, out = 0, agree = 0, disagree = 0, gone = 0;
                for (const [, r] of worldRows) {
                    console.log(`${FTAG} INFO world sample ${r.kind}: in ${r.inWorld} out ${r.out} agree ${r.agree} disagree ${r.disagree} gone ${r.gone} first-out ${r.first || "-"}`);
                    inWorld += r.inWorld;
                    out += r.out;
                    agree += r.agree;
                    disagree += r.disagree;
                    if (r.gone) gone++;
                }
                fcheck("world-sampled", worldRows.size > 0 && inWorld > 0, `${worldRows.size} mob(s), ${inWorld} tick(s) in the world${worldError === "" ? "" : ` (last error ${worldError})`}`);
                fcheck("world-removed", out > 0 && gone > 0, `after \`kill\` ${out} tick(s) read false before ${gone} mob(s) left the level entirely`);
                fcheck("world-agree", disagree === 0 && agree > 0, `on every one of ${agree + disagree} sample(s) isInWorld() matched BDS's own fetchEntity(id, false) (${disagree} disagreed)`);
                worldOn = false;
                break;
            }
            case "platform": {
                const want = Number(m[2] ?? "12");
                const got = p.getPlatform();
                console.log(`${FTAG} INFO platform got=${got} sent=${want}`);
                fcheck("platform", got === want, `getPlatform() reads ${got}; the bot's login chain sent DeviceOS ${want}`);
                break;
            }
            case "skin": {
                const want = m[2] ?? "";
                const skin = p.getSkin();
                const id = skin.id, playFab = skin.playFabId, full = skin.fullId;
                console.log(`${FTAG} INFO skin id=${JSON.stringify(id)} playFabId=${JSON.stringify(playFab)} fullId=${JSON.stringify(full)} resourcePatch=${JSON.stringify(skin.resourcePatch).slice(0, 80)} geometry=${JSON.stringify(skin.defaultGeometryName)}`);
                fcheck("skin-id", id === want, `getSkin().id is ${JSON.stringify(id)}; the bot sent SkinId ${JSON.stringify(want)}`);
                fcheck("skin-fullid", full.startsWith(want), `and fullId ${JSON.stringify(full)} starts with it -- the member two strings later`);
                break;
            }
            case "using": {
                // Candidate only (docs/findings-layouts.md, "Candidates held back"): isUsingItem is not
                // shipped, so this reads the candidate slot directly and reports, never PASSes. The engine
                // has never been seen filling it -- a bot cannot use an item.
                const off = 1840;
                const sp = p as unknown as StaticPointer;
                const vt = proc["??_7ItemStack@@6B@"];
                const here = sp.getPointer(off);
                const empty = sp.addAs(ItemStack, off).isNull();
                console.log(`${FTAG} CAND using vptr@+${off}=${here} ItemStack vftable=${vt} same=${here.equalsptr(vt)} isNull=${empty}`);
                break;
            }
            case "selslot": {
                // ?setSelectedSlot@Player@@ (an address: 40 0x2338d0 / 51 0x2beae0, 566B on both). BDS's own
                // function writes PlayerInventory::selected_ through the out-of-line selectSlot, reads the item
                // back through the container's virtual getItem, and sends a MobEquipmentPacket through the
                // Dimension. The witnesses are outside the function: PlayerInventory+16, BDS's own
                // Player::getSelectedItem, the container's own getItem(n), and the bot's mob_equipment log.
                const n = Number(m[2] ?? "0");
                const inv = p.getInventory();
                const before = inv.getSelectedSlot();
                const ret = p.setSelectedSlot(n);
                const after = inv.getSelectedSlot();
                const bds = p.getSelectedItem();
                const inRange = n >= 0 && n < 9;
                const viaInv = inRange ? inv.container.getItem(n) : ItemStack.EMPTY_ITEM;
                console.log(`${FTAG} INFO selslot n=${n} selected ${before} -> ${after} ret=${ret} '${ret.toString()}' bdsSelected=${bds} '${bds.toString()}' container[n]=${viaInv}`);
                if (inRange) {
                    fcheck(`selslot-${n}-sel`, after === n, `after setSelectedSlot(${n}) PlayerInventory::selected_ reads ${after}`);
                    fcheck(`selslot-${n}-ret`, ret.equalsptr(viaInv), `it returns the container's own slot ${n} (${ret} vs getItem(${n}) ${viaInv}, '${ret.toString()}')`);
                    fcheck(`selslot-${n}-bds`, bds.equalsptr(viaInv), `BDS's own Player::getSelectedItem now reads slot ${n} (${bds}, '${bds.toString()}')`);
                } else {
                    fcheck(`selslot-${n}-oob`, after === before && ret.equalsptr(ItemStack.EMPTY_ITEM), `an out-of-hotbar slot is refused: selected_ stays ${after}, returns EMPTY_ITEM (${ret.equalsptr(ItemStack.EMPTY_ITEM)})`);
                }
                break;
            }
            case "eating": {
                // ?forceAllowEating@Player@@ (derived: isCreative() || Level::getDifficulty() == Peaceful, the 2024
                // body). The console moves both inputs (`difficulty`, `gamemode`) and the driver passes the
                // value 2024's rule predicts; the two pieces are BDS's own (isCreative address, Level slot 36).
                const want = m[2] === "true";
                const creative = p.isCreative();
                const diff = p.getLevel().getDifficulty();
                const got = p.forceAllowEating();
                console.log(`${FTAG} INFO eating creative=${creative} difficulty=${diff} forceAllowEating=${got} expected=${want}`);
                fcheck(`eating-${creative ? "creative" : "survival"}-d${diff}`, got === want, `forceAllowEating() is ${got} with isCreative=${creative} and getDifficulty=${diff} (expected ${want})`);
                break;
            }
            case "nametag": {
                // bdsx writes (setNameTagVisible, derived: setStatusFlag(CanShowName) -> BDS's
                // SynchedActorDataAccess::setActorFlag), BDS's own canShowNameTag reads it back.
                if (canShowNameTag === null) {
                    fcheck("nametag", false, `canShowNameTag unavailable: ${canShowError}`);
                    break;
                }
                // the address is the one this player's own vftable carries (sanity: not some other function)
                const vt = (p as unknown as StaticPointer).getPointer(0);
                const want = proc["?canShowNameTag@Actor@@UEBA_NXZ"];
                let slot = -1;
                for (let i = 0; i < 64; i++) {
                    const f = vt.getPointer(i * 8);
                    if (f.equalsptr(want)) { slot = i; break; }
                }
                console.log(`${FTAG} INFO nametag fn=${want} slot-in-player-vftable=${slot}`);
                fcheck("nametag-slot", slot >= 0, `the player's own vftable holds canShowNameTag at slot ${slot}`);
                const before = canShowNameTag(p), flagBefore = p.getStatusFlag(ActorFlags.CanShowName);
                console.log(`${FTAG} INFO nametag before canShow=${before} flag14=${flagBefore}`);
                fcheck("nametag-agree", before === flagBefore, `before anything is written, BDS (${before}) and bdsx's flag read (${flagBefore}) agree`);
                p.setNameTagVisible(false);
                const off = canShowNameTag(p), flagOff = p.getStatusFlag(ActorFlags.CanShowName);
                p.setNameTagVisible(true);
                const on = canShowNameTag(p), flagOn = p.getStatusFlag(ActorFlags.CanShowName);
                p.setNameTagVisible(false);
                const off2 = canShowNameTag(p);
                p.setNameTagVisible(before);
                const restored = canShowNameTag(p);
                console.log(`${FTAG} INFO nametag off=${off}/${flagOff} on=${on}/${flagOn} off2=${off2} restored=${restored}`);
                fcheck("nametag-off", off === false && flagOff === false, `setNameTagVisible(false): BDS's own canShowNameTag() is ${off}`);
                fcheck("nametag-on", on === true && flagOn === true, `setNameTagVisible(true): BDS's own canShowNameTag() is ${on}`);
                fcheck("nametag-off2", off2 === false, `and false again (${off2}) -- it follows every write, not just the first`);
                fcheck("nametag-restore", restored === before, `restoring the original value (${before}) reads back ${restored}`);
                break;
            }
            case "nametagread": {
                // the other direction, INFO only: after a console effect, what BDS itself left in flag 14
                const show = canShowNameTag === null ? null : canShowNameTag(p);
                console.log(`${FTAG} INFO nametagread ${m[2] ?? ""} canShow=${show} flag14=${p.getStatusFlag(ActorFlags.CanShowName)} invisible=${p.getStatusFlag(ActorFlags.Invisible)}`);
                break;
            }
            case "entityctx": {
                // Actor / Player / ServerPlayer ::tryGetFromEntity (derived: ActorOwnerComponent, and a
                // PlayerComponent / ServerPlayerComponent flag in front). The answers are fixed from the
                // outside: the bot's own context must give back the bot, a pig's must give back the pig
                // for Actor and null for both player kinds, and Level::getUsers (BDS's own list) must hold
                // exactly one context that resolves to the bot.
                const ctx = p.ctxbase;
                const a = Actor.tryGetFromEntity(ctx), pl = Player.tryGetFromEntity(ctx), sp = ServerPlayer.tryGetFromEntity(ctx);
                fcheck("ctx-actor", a === p, `Actor.tryGetFromEntity(bot.ctxbase) is the bot (${a === null ? "null" : a.constructor.name})`);
                fcheck("ctx-player", pl === p && sp === p, `Player (${pl === p}) and ServerPlayer (${sp === p}) give back the bot too`);
                const level = bedrockServer.level;
                const users = level.getUsers();
                const uv = users as unknown as StaticPointer;
                const bytes = uv.getPointer(8).subptr(uv.getPointer(0));
                let mine = 0, other = 0;
                for (const u of users) {
                    const got = ServerPlayer.tryGetFromEntity(u);
                    if (got === p) mine++;
                    else if (got !== null) other++;
                }
                console.log(`${FTAG} INFO entityctx users=${users.size()} bytes=${bytes} mine=${mine} other=${other}`);
                fcheck("ctx-users", users.size() === 1 && mine === 1, `BDS's getUsers() holds ${users.size()} context(s) (${bytes} bytes) and ${mine} resolves to the bot`);
                const players = level.getPlayers();
                fcheck("ctx-getplayers", players.length === 1 && players[0] === p, `level.getPlayers() is [bot] (${players.length})`);
                let pigs = 0, pigPlayer = 0, pigBack = 0, total = 0, nulls = 0;
                for (const e of (level as any)._getEntities()) {
                    total++;
                    const act = Actor.tryGetFromEntity(e);
                    if (act === null) { nulls++; continue; }
                    if (act.getIdentifier() === "minecraft:pig") {
                        pigs++;
                        if (Player.tryGetFromEntity(e) !== null || ServerPlayer.tryGetFromEntity(e) !== null) pigPlayer++;
                        // an Actor's ctxbase is its own copy of the context, so the round trip is the entity id
                        if (act.ctxbase.entityId === e.entityId) pigBack++;
                    }
                }
                console.log(`${FTAG} INFO entityctx entities=${total} unresolved=${nulls} pigs=${pigs} pigAsPlayer=${pigPlayer} pigCtxRoundTrip=${pigBack}`);
                fcheck("ctx-pig", pigs >= 1 && pigBack === pigs, `the console's pig(s) resolve through Actor.tryGetFromEntity and their ctxbase names the entity id they came from (${pigBack}/${pigs})`);
                fcheck("ctx-pig-notplayer", pigs >= 1 && pigPlayer === 0, `and neither Player nor ServerPlayer accepts a pig (${pigPlayer})`);
                break;
            }
            case "playerlist": {
                // BDS's own PlayerListEntry(Player const&) fills the entry; bdsx reads it back against the
                // player. Then updatePlayerList (derived emplace over the 1.26 element layout, BDS's own
                // serializer and entry/packet destructors) and the public setName; the bot's decoded
                // player_list lines in the transcript are the witness for what went over the wire.
                const L = pdbcache.layouts.PlayerListEntry;
                if (L === undefined) {
                    fcheck("playerlist", false, "this build's symbols.json has no layouts.PlayerListEntry");
                    break;
                }
                const entry = PlayerListEntry.constructWith(p);
                const raw = entry as unknown as StaticPointer;
                const name = entry.name, plat = entry.buildPlatform;
                const idOk = raw.getBin64(L.id) === p.getUniqueIdBin();
                const skinPtr = raw.getPointer(L.skin), skin = p.getSkin() as unknown as StaticPointer;
                console.log(`${FTAG} INFO playerlist name=${name} platform=${plat} id=${raw.getBin64(L.id)} uid=${p.getUniqueIdBin()} uuid=${mce.UUID.toString(entry.uuid)} xuid=${JSON.stringify(entry.xuid)} skin=${skinPtr} player.skin=${skin} teacher=${raw.getUint8(L.isTeacher)} host=${raw.getUint8(L.isHost)} sub=${raw.getUint8(L.isSubClient)}`);
                fcheck("playerlist-name", name === p.getName(), `BDS's ctor put the name ${JSON.stringify(name)} at +${L.name}`);
                fcheck("playerlist-platform", plat === p.getPlatform() && plat === Number(m[2] ?? "12"), `and the platform ${plat} at +${L.buildPlatform} (the bot logged in with ${m[2] ?? "12"})`);
                fcheck("playerlist-id", idOk, `and the player's ActorUniqueID at +${L.id}`);
                fcheck("playerlist-skin", skinPtr.equalsptr(skin), `and at +${L.skin} the same SerializedSkin getSkin() returns`);
                fcheck("playerlist-skinfield", entry.skin.equalsptr(skin), "the bdsx skin property follows the pointer");
                entry.destruct();
                const pk = PlayerListPacket.allocate();
                const P = pdbcache.layouts.PlayerListPacket;
                const mode = P === undefined ? -1 : (pk as unknown as StaticPointer).getInt32(P.mode);
                pk.dispose();
                fcheck("playerlist-mode", mode === 5, `the factory's packet carries ${mode} at +72, as every constructor in the image writes`);
                console.log(`${FTAG} INFO playerlist sending updatePlayerList`);
                p.updatePlayerList();
                fcheck("playerlist-update", true, "updatePlayerList() returned (entry ctor, derived emplace, send, both destructors)");
                let threw = "";
                try {
                    p.setName("bdsxlisted");
                } catch (err) {
                    threw = (err as Error).message;
                }
                fcheck("playerlist-setname", threw === "" && p.getName() === "bdsxlisted" && p.getNameTag() === "bdsxlisted", `public setName("bdsxlisted") ${threw === "" ? "returned" : `threw ${threw}`}; getName()=${p.getName()}`);
                p.setName("bdsxprobe");
                fcheck("playerlist-restore", p.getName() === "bdsxprobe", "and renaming back through the public setName too");
                break;
            }
            case "name": {
                // BDS's own setName (the address) writes; the getName accessor (+3008) and BDS's own
                // getNameTag (entity data id 4) read it back.
                const before = p.getName(), tagBefore = p.getNameTag();
                console.log(`${FTAG} INFO name before=${before} tag=${tagBefore}`);
                fcheck("name-before", before === "bdsxprobe", `getName() reads ${JSON.stringify(before)} before anything is renamed`);
                (p as any)._setName("bdsxrenamed");
                const after = p.getName(), tagAfter = p.getNameTag();
                console.log(`${FTAG} INFO name after=${after} tag=${tagAfter}`);
                fcheck("name-set", after === "bdsxrenamed", `BDS's Player::setName rewrites the name member: getName() is now ${JSON.stringify(after)}`);
                fcheck("name-tag", tagAfter === "bdsxrenamed", `and its second step reached the entity data: BDS's own getNameTag() is ${JSON.stringify(tagAfter)}`);
                (p as any)._setName("bdsxprobe");
                fcheck("name-restore", p.getName() === "bdsxprobe" && p.getNameTag() === "bdsxprobe", "renaming back restores both");
                try {
                    p.setName("bdsxprobe");
                    console.log(`${FTAG} INFO name public setName() (with updatePlayerList) returned`);
                } catch (err) {
                    console.log(`${FTAG} INFO name public setName() threw after the rename: ${(err as Error).message}`);
                }
                break;
            }
            case "chunks": {
                // `?resendAllChunks@Player@@` (docs/next-steps.md Q1 0 C-2): derived() reads
                // layouts.Player.networkChunkPublisher (+0x7e8 on both builds) and, if it is set, calls
                // NetworkChunkPublisher::clearRegion() -- the same two steps `?suspendRegion@Player@@`
                // opens with, which is how the call target was found. clearRegion only clears the
                // publisher's "already sent" tracking, so there is nothing to read back server-side; the
                // witness is the bot's own chunk packet count (livebot.cjs logs "chunk_count" every
                // 2s -- a burst right after this command is the functional check). This step only
                // confirms the call itself returns without throwing and the player is still connected.
                let threw = "";
                try {
                    p.resendAllChunks();
                } catch (err) {
                    threw = (err as Error).message;
                }
                fcheck("chunks-call", threw === "", `resendAllChunks() ${threw === "" ? "returned" : `threw ${threw}`}`);
                fcheck("chunks-alive", p.isPlayerInitialized(), "player still connected and initialized right after the call");
                break;
            }
            default:
                console.log(`${FTAG} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${FTAG} FAIL ${step} threw ${(err as Error).message}`);
    }
});

// OnFireSystem (docs/findings-layouts.md "OnFireSystem"): Actor.setOnFire goes to the 1.26 out-of-line
// OnFireSystem::setOnFire(Actor&, int) (40 0x2cb4460 / 51 0x2f1d840), setOnFireNoEffects to the
// useEffects=false branch of ScriptActor::setOnFire (derived(), engine/onfire.ts). The witness is BDS's own
// state: the OnFireComponent (ticks int +0, "effects" byte +4, 8 bytes) the entt registry holds for the actor,
// ActorFlags.OnFire, which BDS's fire system raises from that component on the following ticks, and the health
// the fire takes. BDS's fire system (2024 OnFireServerSystem::_tickServerImpl, 1.21.3.01 0xa6cb00) zeroes the ticks
// of a player whose Invulnerable ability is set unless the +4 byte is set -- the byte is what setOnFire has and the
// no-effects form lacks -- and a joining bot is invulnerable from a layer (abilities-probe.ts), so the no-effects
// form is watched on a mob (a cow the driver tags bdsxfire) and on the player both, the player's side being the
// engine's own "no effects" rule.
// Console, 8 s apart: "weather clear", "gamemode survival @a", "fireprobe summon" (a cow at 29.5 68 17.5, tagged
// bdsxfire), "fireprobe noeffects" (12 s), "fireprobe noeffburning", "fireprobe out", "fireprobe fire" (12 s, the
// player), "fireprobe burning", "kill @e[tag=bdsxfire]".
// (A setTimeout check from inside the handler ran only at shutdown, on a decayed Player: every read is on a command.)
import { enttComponent as fireEntt } from "bdsx/bds/engine/entt";
import { componentHash as fireHash } from "bdsx/bds/engine/deps";
import { AbilitiesIndex as FireAbilitiesIndex } from "bdsx/bds/abilities";
const FIRE = "[fireprobe]";
const ON_FIRE = fireHash("OnFireComponent");
let fireMobHealth = -1;
function fireState(a: Actor): { has: boolean; ticks: number; effects: number } {
    const c = fireEntt(a, ON_FIRE, 8);
    return c === null ? { has: false, ticks: 0, effects: 0 } : { has: true, ticks: c.getInt32(0), effects: c.getUint8(4) };
}
function fireLine(a: Actor): string {
    const s = fireState(a);
    return `component ${s.has ? `ticks=${s.ticks} effects=${s.effects}` : "absent"}, OnFire flag ${a.getStatusFlag(ActorFlags.OnFire)}`;
}
function fireMob(): Actor | null {
    for (const e of bedrockServer.level.getEntities()) {
        try {
            if (e.getIdentifier() === "minecraft:cow" && e.hasTag("bdsxfire")) return e;
        } catch (err) {
            /* an entity mid-removal can throw reading its own fields */
        }
    }
    return null;
}
events.command.on(cmd => {
    const m = /^\/?fireprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const p = player;
    if (p === null) { console.log(`${FIRE} FAIL ${step}: no player`); return; }
    const check = (name: string, ok: boolean, why: string): void => console.log(`${FIRE} ${ok ? "PASS" : "FAIL"} ${step}-${name}: ${why}`);
    const burning = (a: Actor, below: number): boolean => {
        const s = fireState(a);
        return a.getStatusFlag(ActorFlags.OnFire) && s.ticks > 0 && s.ticks < below;
    };
    const cold = (a: Actor): boolean => {
        const s = fireState(a);
        return (!s.has || s.ticks <= 0) && !a.getStatusFlag(ActorFlags.OnFire);
    };
    try {
        if (step === "summon") {
            // summon and tag in one handler: a console `tag @e[...,r=3]` 8 s after the summon missed a cow that had
            // wandered off (one session of three)
            bedrockServer.executeCommand("summon cow 29.5 68 17.5");
            let tagged = 0;
            for (const e of bedrockServer.level.getEntities()) {
                try {
                    if (e.getIdentifier() !== "minecraft:cow" || e.hasTag("bdsxfire")) continue;
                    const pos = e.getPosition();
                    if (Math.abs(pos.x - 29.5) < 1 && Math.abs(pos.z - 17.5) < 1 && tagged === 0 && e.addTag("bdsxfire")) tagged++;
                } catch (err) {
                    /* an entity mid-removal can throw reading its own fields */
                }
            }
            check("cow", tagged === 1, `summoned and tagged ${tagged} cow(s)`);
            return;
        }
        // the cow burns to death during the no-effects round (10 HP), so only those two steps need it
        const found = fireMob();
        if (found === null && (step === "noeffects" || step === "noeffburning")) { console.log(`${FIRE} FAIL ${step}: no cow tagged bdsxfire`); return; }
        const mob = found as Actor;
        switch (step) {
            case "noeffects": {
                check("before", cold(mob) && cold(p), `nothing burning before the call: cow ${fireLine(mob)}; player ${fireLine(p)}`);
                fireMobHealth = mob.getHealth();
                mob.setOnFireNoEffects(12);
                p.setOnFireNoEffects(12);
                const a = fireState(mob), b = fireState(p);
                check("ticks", a.has && a.ticks === 240 && b.has && b.ticks === 240, `setOnFireNoEffects(12) -> cow ${fireLine(mob)}; player ${fireLine(p)} (want ticks=240 on both)`);
                check("no-effects-byte", a.effects === 0 && b.effects === 0, `the +4 byte setOnFire sets is left at ${a.effects} / ${b.effects}`);
                break;
            }
            case "noeffburning": {
                check("mob-burns", burning(mob, 240 - 100), `8 s after setOnFireNoEffects(12), BDS's fire system counting the cow down and flagging it: ${fireLine(mob)}`);
                const hp = mob.getHealth();
                check("mob-damage", hp < fireMobHealth, `the cow's health ${fireMobHealth} -> ${hp}`);
                const invulnerable = p.getAbilities().getBool(FireAbilitiesIndex.Invulnerable);
                check(
                    "player-rule",
                    invulnerable ? cold(p) : burning(p, 240 - 100),
                    `the player (Invulnerable ${invulnerable}): ${fireLine(p)} -- BDS drops a no-effects fire on an invulnerable player and burns anyone else`,
                );
                break;
            }
            case "out":
                check("expired", (found === null || cold(found)) && cold(p), `after the 12 s ran out: cow ${found === null ? "burnt to death" : fireLine(found)}; player ${fireLine(p)}`);
                break;
            case "fire": {
                p.setOnFire(12);
                const s = fireState(p);
                check("ticks", s.has && s.ticks === 240, `setOnFire(12), no armour, not in water: ${fireLine(p)} (want ticks=240)`);
                check("effects-byte", s.effects === 1, `the +4 byte is ${s.effects} (setOnFire sets it, the no-effects form does not)`);
                break;
            }
            case "burning": {
                const invulnerable = p.getAbilities().getBool(FireAbilitiesIndex.Invulnerable);
                check("burns", burning(p, 240 - 100), `8 s after setOnFire(12) (player Invulnerable ${invulnerable}): ${fireLine(p)}`);
                break;
            }
            default:
                console.log(`${FIRE} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${FIRE} FAIL ${step} threw ${(err as Error).message}`);
    }
});

// ServerNetworkHandler::setMaxNumPlayers (docs/findings-packets.md "setMaxNumPlayers"): derived() on 1.26, where
// SetMaxPlayersCommand::execute inlines it. The witness is BDS's own reader of the same field: the console `list`
// prints "There are N/max players online", from max_num_players_ (ListCommand reads +0x3b8 on 40). Console, 8 s apart:
// "setmaxplayers 12", "maxprobe engine 12", "maxprobe set 7 0 7", "list", "maxprobe set 0 -1 1", "list",
// "maxprobe set 100 1 40", "list", "maxprobe app", "setmaxplayers 10".
const MAX = "[maxprobe]";
events.command.on(cmd => {
    const m = /^\/?maxprobe (\w+)(?: (-?\d+))?(?: (-?\d+))?(?: (-?\d+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const snh = bedrockServer.serverNetworkHandler;
    try {
        switch (step) {
            case "engine": {
                const want = Number(m[2]);
                console.log(`${MAX} ${snh.maxPlayers === want ? "PASS" : "FAIL"} engine-${want}: after the engine's own setmaxplayers ${want}, bdsx reads maxPlayers ${snh.maxPlayers}`);
                break;
            }
            case "set": {
                const n = Number(m[2]), wantRet = Number(m[3]), wantMax = Number(m[4]);
                const before = snh.maxPlayers;
                const ret = snh.setMaxNumPlayers(n) as unknown as number;
                const after = snh.maxPlayers;
                const players = bedrockServer.level.getPlayers().length;
                console.log(
                    `${MAX} ${ret === wantRet && after === wantMax ? "PASS" : "FAIL"} set-${n}: ${before} -> setMaxNumPlayers(${n}) returned ${ret} (want ${wantRet}), max now ${after} (want ${wantMax}), ${players} player(s) in`,
                );
                console.log(`${MAX} INFO the next \`list\` should say ${players}/${wantMax}`);
                break;
            }
            case "app": {
                // the reference setMaxNumPlayers calls slot 5 on: DedicatedServer's IMinecraftApp table, whose slot 5 is `ret`
                const layout = (pdbcache.layouts as any).ServerNetworkHandler?.app;
                const app = (snh as any as StaticPointer).getPointer(layout);
                const vptr = app.getPointer(0);
                const table = proc["??_7DedicatedServer@@6BAppIsland@Bedrock@@@"];
                const slot5 = vptr.getPointer(5 * 8);
                console.log(`${MAX} ${vptr.equalsptr(table) ? "PASS" : "FAIL"} app-table: *(handler+0x${Number(layout).toString(16)}) has vptr ${vptr} (DedicatedServer's table ${table})`);
                console.log(`${MAX} ${slot5.getUint8(0) === 0xc3 ? "PASS" : "FAIL"} app-slot5: slot 5 at ${slot5} starts with 0x${slot5.getUint8(0).toString(16)} (a bare ret is 0xc3)`);
                break;
            }
            default:
                console.log(`${MAX} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${MAX} FAIL ${step} threw ${(err as Error).message}`);
    }
});

// ServerInstance.disconnectAllClients (docs/findings-packets.md "disconnectAll"): derived() on 1.26, a loop over the
// NetworkSystem's connections through the per-client disconnectClientWithMessage. The witness is BDS's and the
// client's own: the bot's log shows the message, BDS logs "Player disconnected", playerLeft fires, and no player is
// left. Console: "discprobe all" then, 8 s later, "discprobe after".
import { networkConnectionIds as discIds } from "bdsx/bds/engine/networkhandler";
const DISC = "[discprobe]";
let discLeft: string[] = [];
let discArmed = false;
events.playerLeft.on(ev => {
    if (discArmed) discLeft.push(ev.player.getNameTag());
});
events.command.on(cmd => {
    const m = /^\/?discprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    try {
        const connections = discIds(bedrockServer.networkSystem as unknown as StaticPointer).length;
        const players = bedrockServer.level.getPlayers().map(p => p.getNameTag());
        if (step === "all") {
            console.log(`${DISC} ${connections >= 1 && players.length >= 1 ? "PASS" : "FAIL"} before: ${connections} connection(s), players [${players.join(", ")}]`);
            discArmed = true;
            discLeft = [];
            bedrockServer.serverInstance.disconnectAllClients("bdsxkickall7");
            console.log(`${DISC} INFO all: disconnectAllClients("bdsxkickall7") returned; the bot's log must show the message`);
        } else if (step === "after") {
            console.log(`${DISC} ${discLeft.length >= 1 ? "PASS" : "FAIL"} left: playerLeft fired for [${discLeft.join(", ")}]`);
            console.log(`${DISC} ${players.length === 0 ? "PASS" : "FAIL"} empty: players now [${players.join(", ")}], ${connections} connection(s) left`);
            discArmed = false;
        } else {
            console.log(`${DISC} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${DISC} FAIL ${step} threw ${(err as Error).message}`);
    }
});

// TickingArea (docs/findings-blocks.md "Ticking areas"): Dimension.getTickingAreas() (derived: the list pointer at
// layouts.Dimension.tickingAreas), TickingAreaList.getAreas() (derived: the vector at +8), and ITickingArea.isRemoved /
// getView / ITickingAreaView.getAvailableChunk through the 1.26 TickingArea / TickingAreaView tables. The witness is
// BDS's own /tickingarea: the count the list holds follows `tickingarea add` and `remove`, and the area's view hands out
// the chunk it keeps loaded. Console, 8 s apart: "taprobe before", "tickingarea add 0 0 0 15 0 15 bdsxta",
// "taprobe added", "taprobe remove", "taprobe gone".
import { ChunkPos as TaChunkPos } from "bdsx/bds/blockpos";
const TA = "[taprobe]";
let taBaseline = -1;
events.command.on(cmd => {
    const m = /^\/?taprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const p = player;
    if (p === null) { console.log(`${TA} FAIL ${step}: no player`); return; }
    const check = (name: string, ok: boolean, why: string): void => console.log(`${TA} ${ok ? "PASS" : "FAIL"} ${step}-${name}: ${why}`);
    try {
        const list = p.getDimension().getTickingAreas();
        const areas = list.getAreas();
        const n = areas.size();
        switch (step) {
            case "before":
                taBaseline = n;
                check("list", n >= 0 && n < 64, `the overworld's list holds ${n} area(s) before the add`);
                break;
            case "added": {
                check("count", n === taBaseline + 1, `after tickingarea add: ${taBaseline} -> ${n}`);
                for (let i = 0; i < n; i++) {
                    const area = areas.get(i).p;
                    if (area === null) continue;
                    const removed = area.isRemoved();
                    const view = area.getView();
                    const inside = view.getAvailableChunk(TaChunkPos.create(0, 0));
                    const hasInside = inside.p !== null;
                    inside.dispose();
                    const outside = view.getAvailableChunk(TaChunkPos.create(1000, 1000));
                    const hasOutside = outside.p !== null;
                    outside.dispose();
                    check(`area${i}`, !removed && hasInside && !hasOutside, `isRemoved ${removed}; its view has chunk (0,0) ${hasInside}, chunk (1000,1000) ${hasOutside}`);
                }
                break;
            }
            case "remove": {
                const before: string[] = [];
                for (let i = 0; i < n; i++) before.push(String(areas.get(i).p));
                bedrockServer.executeCommand("tickingarea remove bdsxta");
                const again = list.getAreas();
                const m2 = again.size();
                let seen = "";
                for (let i = 0; i < m2; i++) {
                    const area = again.get(i).p;
                    if (area !== null) seen += ` ${area} isRemoved=${area.isRemoved()}`;
                }
                console.log(`${TA} INFO remove: ${n} area(s) before [${before.join(", ")}], ${m2} right after the command:${seen}`);
                break;
            }
            case "gone":
                check("count", n === taBaseline, `8 s after tickingarea remove: ${n} area(s), baseline ${taBaseline}`);
                break;
            default:
                console.log(`${TA} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${TA} FAIL ${step} threw ${(err as Error).message}`);
    }
});

// ServerInstance.getMotd/setMotd (docs/findings-packets.md "getMotd"): 2024's serverName (+0x2c8) is 40 +0x398 / 51
// +0x3a0, and allowIncomingConnections (40 0xa62e60 / 51 0x9761b0) is 2024's function: flag byte = 1, the name (or ""
// when not announcing) into serverName, then updateServerAnnouncement. The first witness is the engine's own write at
// boot (server-name from server.properties); the second is the engine function's write read back through bdsx.
// Console: "motdprobe boot", "motdprobe set x", "motdprobe set <long>", "motdprobe quiet", "motdprobe restore".
import { serverProperties as motdProps } from "bdsx/serverproperties";
import * as motdChild from "child_process";
const MOTD = "[motdprobe]";
events.command.on(cmd => {
    const m = /^\/?motdprobe (\w+)(?: (.+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const want = motdProps["server-name"];
    const snh = bedrockServer.serverNetworkHandler;
    try {
        const flagAt = (pdbcache.layouts as any).ServerNetworkHandler?.serverName - 0x10;
        const flag = () => (snh as any as StaticPointer).getUint8(flagAt);
        switch (step) {
            case "boot": {
                const motd = bedrockServer.serverInstance.getMotd();
                console.log(`${MOTD} ${typeof want === "string" && want !== "" && motd === want ? "PASS" : "FAIL"} boot: getMotd() "${motd}", server.properties server-name "${want}"`);
                console.log(`${MOTD} INFO incoming flag at +0x${flagAt.toString(16)} = ${flag()} (allowIncomingConnections sets 1)`);
                break;
            }
            case "set": {
                const value = m[2] ?? "x";
                const before = bedrockServer.serverInstance.getMotd();
                bedrockServer.serverInstance.setMotd(value);
                const after = bedrockServer.serverInstance.getMotd();
                console.log(`${MOTD} ${after === value && before !== value ? "PASS" : "FAIL"} set-${value.length}: "${before}" -> setMotd("${value}") -> getMotd() "${after}", flag ${flag()}`);
                break;
            }
            case "quiet": {
                // allowIncomingConnections(name, false): 2024 stores "" instead of the name
                snh.allowIncomingConnections("unannounced", false);
                const after = bedrockServer.serverInstance.getMotd();
                console.log(`${MOTD} ${after === "" ? "PASS" : "FAIL"} quiet: allowIncomingConnections("unannounced", false) -> getMotd() "${after}" (want ""), flag ${flag()}`);
                break;
            }
            case "restore": {
                bedrockServer.serverInstance.setMotd(want);
                const after = bedrockServer.serverInstance.getMotd();
                console.log(`${MOTD} ${after === want ? "PASS" : "FAIL"} restore: setMotd(server-name) -> getMotd() "${after}"`);
                break;
            }
            case "ping": {
                // an unconnected RakNet ping to this server (LAN visibility on): the reply's second field is the name
                // updateServerAnnouncement handed to the locator. Run as a child process and waited for: this
                // launcher's event loop does not turn while the game runs (an in-process dgram's callbacks and its
                // timeout only ran at stop). RakNet answers pings on its own thread.
                const expect = m[2] === undefined || m[2] === "server-name" ? want : m[2];
                const port = String(motdProps["server-port"] || 19132);
                let out: string;
                try {
                    out = motdChild.execFileSync("node", [`${process.env.BDSX_REPO}\\tools\\ping-protocol.cjs`, "127.0.0.1", port], { timeout: 8000, encoding: "utf8" });
                } catch (e) {
                    out = `ping failed: ${(e as Error).message}`;
                }
                const line = /motd\s*:\s*(.*)/.exec(out);
                const name = line === null ? undefined : line[1].split(";")[1];
                console.log(`${MOTD} ${name === expect ? "PASS" : "FAIL"} ping-${expect}: the ping reply names "${name}" (getMotd() "${bedrockServer.serverInstance.getMotd()}"): ${line === null ? out.trim() : line[1].trim()}`);
                break;
            }
            default:
                console.log(`${MOTD} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${MOTD} FAIL ${step} threw ${(err as Error).message}`);
    }
});

// Actor.teleport (docs/findings-layouts.md "Actor.teleport"): TeleportCommand::computeTarget + applyTarget (engine/
// teleport.ts; 40 0x3c88710 / 0x3c88370, 51 0x3a15b20 / 0x3a15770 with its extra version argument). The witness is
// BDS's own state after the call: getPosition() and getDimensionId() of the bot and of a summoned pig (tagged
// bdsxtp), in the handler and again 8 s later, and for a dimension change the actor as the level lists it afterwards
// (a non-player crossing dimensions is re-created in the other one, so the pig is found again by its tag).
// Console, 8 s apart: "tickingarea add 16 0 0 47 0 31 bdsxtp" (the pig's overworld chunks stay loaded while the bot
// is in the nether), "tpprobe summon", "tpprobe same", "tpprobe sameread", "tpprobe nether", "execute in nether run
// fill -3 79 -3 4 83 4 air", "execute in nether run fill -3 78 -3 4 78 4 obsidian", "tpprobe netherread", "tpprobe
// nethermob", "tpprobe nethermobread", "tpprobe back", "tpprobe backread", "kill @e[tag=bdsxtp]", "tickingarea
// remove bdsxtp".
import { DimensionId as TpDimensionId } from "bdsx/bds/actor";
const TP = "[tpprobe]";
function tpPig(): Actor | null {
    for (const e of bedrockServer.level.getEntities()) {
        try {
            if (e.getIdentifier() === "minecraft:pig" && e.hasTag("bdsxtp")) return e;
        } catch (err) {
            /* an entity mid-removal can throw reading its own fields */
        }
    }
    return null;
}
function tpWhere(a: Actor): string {
    const p = a.getPosition();
    return `dim ${a.getDimensionId()} pos ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
}
/** x and z exact (to 0.01), y from `y` to `y + ySlack`: a player's position is its eye, a mob's its feet */
function tpAt(a: Actor, dim: number, x: number, y: number, z: number, ySlack: number, xzSlack = 0.01): boolean {
    const p = a.getPosition();
    return (
        a.getDimensionId() === dim &&
        Math.abs(p.x - x) <= xzSlack &&
        Math.abs(p.z - z) <= xzSlack &&
        p.y >= y - 0.01 - (xzSlack > 0.01 ? 1 : 0) &&
        p.y <= y + ySlack + 0.01
    );
}
const TP_PLAYER_EYE = 1.7; // Player::getPosition is the eye, 1.62 above the feet
events.command.on(cmd => {
    const m = /^\/?tpprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const p = player;
    if (p === null) { console.log(`${TP} FAIL ${step}: no player`); return; }
    const check = (name: string, ok: boolean, why: string): void => console.log(`${TP} ${ok ? "PASS" : "FAIL"} ${step}-${name}: ${why}`);
    try {
        if (step === "summon") {
            bedrockServer.executeCommand("summon pig 29.5 68 17.5");
            let tagged = 0;
            for (const e of bedrockServer.level.getEntities()) {
                try {
                    if (e.getIdentifier() !== "minecraft:pig" || e.hasTag("bdsxtp")) continue;
                    const pos = e.getPosition();
                    if (Math.abs(pos.x - 29.5) < 1 && Math.abs(pos.z - 17.5) < 1 && tagged === 0 && e.addTag("bdsxtp")) tagged++;
                } catch (err) {
                    /* an entity mid-removal can throw reading its own fields */
                }
            }
            check("pig", tagged === 1, `summoned and tagged ${tagged} pig(s); player ${tpWhere(p)}`);
            return;
        }
        const pig = tpPig();
        switch (step) {
            case "same": {
                if (pig === null) { check("pig", false, "no pig tagged bdsxtp"); return; }
                console.log(`${TP} INFO same: before, player ${tpWhere(p)}; pig ${tpWhere(pig)}`);
                p.teleport(Vec3.create(35.5, 68, 20.5), TpDimensionId.Overworld);
                pig.teleport(Vec3.create(24.5, 68, 10.5), TpDimensionId.Overworld);
                check("player-now", tpAt(p, 0, 35.5, 68, 20.5, TP_PLAYER_EYE), `teleport((35.5,68,20.5), Overworld) -> player ${tpWhere(p)}`);
                check("pig-now", tpAt(pig, 0, 24.5, 68, 10.5, 0.1), `teleport((24.5,68,10.5), Overworld) -> pig ${tpWhere(pig)}`);
                break;
            }
            case "sameread":
                // a pig walks off within 8 s (up to ~10 blocks in the first run): only the player is held to the spot
                check("player-later", tpAt(p, 0, 35.5, 68, 20.5, TP_PLAYER_EYE), `8 s later: player ${tpWhere(p)}`);
                console.log(`${TP} INFO sameread: pig 8 s later ${pig === null ? "not listed" : tpWhere(pig)}`);
                break;
            case "nether":
                console.log(`${TP} INFO nether: before, player ${tpWhere(p)}`);
                p.teleport(Vec3.create(0.5, 80, 0.5), TpDimensionId.Nether);
                console.log(`${TP} INFO nether: right after the call, player ${tpWhere(p)} (a player's change of dimension is a queued request)`);
                break;
            case "netherread":
                check("player", tpAt(p, 1, 0.5, 80, 0.5, TP_PLAYER_EYE), `teleport((0.5,80,0.5), Nether) -> player ${tpWhere(p)}`);
                break;
            case "nethermob": {
                if (pig === null) { check("pig", false, "no pig tagged bdsxtp"); return; }
                console.log(`${TP} INFO nethermob: before, pig ${tpWhere(pig)}`);
                pig.teleport(Vec3.create(1.5, 79, 1.5), TpDimensionId.Nether);
                // a non-player is re-created in the other dimension: find it again by its tag
                const again = tpPig();
                check("pig-now", again !== null && tpAt(again, 1, 1.5, 79, 1.5, 0.1), `teleport((1.5,79,1.5), Nether) -> ${again === null ? "no pig listed" : `pig ${tpWhere(again)}`}`);
                break;
            }
            case "nethermobread":
                check("pig-later", pig !== null && pig.getDimensionId() === 1, `8 s later, still in the nether: ${pig === null ? "no pig tagged bdsxtp" : `pig ${tpWhere(pig)}`}`);
                break;
            case "back":
                // the pig first: its nether chunk is loaded by the bot standing next to it
                if (pig !== null) {
                    pig.teleport(Vec3.create(31.5, 68, 17.5), TpDimensionId.Overworld);
                    const again = tpPig();
                    check("pig-now", again !== null && tpAt(again, 0, 31.5, 68, 17.5, 0.1), `teleport((31.5,68,17.5), Overworld) from the nether -> ${again === null ? "no pig listed" : `pig ${tpWhere(again)}`}`);
                } else check("pig-now", false, "no pig tagged bdsxtp");
                p.teleport(Vec3.create(29.5, 68, 14.5), TpDimensionId.Overworld);
                break;
            case "backread":
                check("player", tpAt(p, 0, 29.5, 68, 14.5, TP_PLAYER_EYE), `teleport((29.5,68,14.5), Overworld) from the nether -> player ${tpWhere(p)}`);
                check("pig-later", pig !== null && pig.getDimensionId() === 0, `8 s later, still in the overworld: ${pig === null ? "no pig tagged bdsxtp" : `pig ${tpWhere(pig)}`}`);
                break;
            default:
                console.log(`${TP} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${TP} FAIL ${step}: threw ${(err as Error).stack ?? err}`);
    }
});

// ActorDefinitionIdentifier.constructWith and Actor.summonAt (CommandUtils::spawnEntityAt) on 1.26
// (docs/findings-layouts.md "ActorDefinitionIdentifier and spawnEntityAt"). Console, with the bot in:
// "tp @a 29.5 68 14.5", "summonprobe adid", "summonprobe spawn", "summonprobe read", "kill @e[tag=bdsxsummon]".
// `adid` reads the constructed identifiers back field by field, including a name no entity has (the constructor
// does not validate; spawning it is the other side of the check). `spawn` summons a pig by name, one by numeric
// ActorType and one from a prebuilt identifier, and expects null for the unknown name. `read` 8 s later expects
// the three pigs still listed by the level.
import { ActorDefinitionIdentifier as SumAdid } from "bdsx/bds/actor";
const SUM = "[sumprobe]";
const SUM_TAG = "bdsxsummon";
function sumAdidFields(a: SumAdid): string {
    return `ns "${a.namespace}" id "${a.identifier}" init "${a.initEvent}" full "${a.fullName}" canonical "${a.canonicalName.str}" hash ${a.canonicalName.hash}`;
}
function sumTagged(): Actor[] {
    const out: Actor[] = [];
    for (const e of bedrockServer.level.getEntities()) {
        try {
            if (e.hasTag(SUM_TAG)) out.push(e);
        } catch (err) {
            /* an entity mid-removal can throw reading its own fields */
        }
    }
    return out;
}
events.command.on(cmd => {
    const m = /^\/?summonprobe (\w+)$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const check = (name: string, ok: boolean, why: string): void => console.log(`${SUM} ${ok ? "PASS" : "FAIL"} ${step}-${name}: ${why}`);
    try {
        if (step === "adid") {
            const cases: [string, string | number, string, string, string][] = [
                // label, input, want identifier, want canonical, want initEvent
                ["str", "minecraft:pig", "pig", "minecraft:pig", ""],
                ["bare", "pig", "pig", "minecraft:pig", ""],
                ["num", ActorType.Pig, "pig", "minecraft:pig", ""],
                ["unknown", "minecraft:bdsx_no_such_entity", "bdsx_no_such_entity", "minecraft:bdsx_no_such_entity", ""],
            ];
            for (const [label, input, wantId, wantCanonical, wantInit] of cases) {
                const a = SumAdid.constructWith(input as any);
                const ok =
                    a.namespace === "minecraft" &&
                    a.identifier === wantId &&
                    a.canonicalName.str === wantCanonical &&
                    a.initEvent === wantInit &&
                    a.canonicalName.hash !== null;
                check(label, ok, `constructWith(${JSON.stringify(input)}) -> ${sumAdidFields(a)} (want ns "minecraft" id "${wantId}" canonical "${wantCanonical}" init "${wantInit}", nonzero hash)`);
                a.destruct();
            }
            const ev = SumAdid.constructWith("minecraft:pig<minecraft:entity_born>");
            console.log(`${SUM} INFO adid-event: constructWith("minecraft:pig<minecraft:entity_born>") -> ${sumAdidFields(ev)}`);
            ev.destruct();
            return;
        }
        const p = player;
        if (p === null) { console.log(`${SUM} FAIL ${step}: no player`); return; }
        switch (step) {
            case "spawn": {
                const region = p.getRegion();
                const spawned = (label: string, a: Actor | null, x: number): void => {
                    if (a === null) { check(label, false, "summonAt returned null"); return; }
                    const id = a.getIdentifier();
                    const pos = a.getPosition();
                    const at = Math.abs(pos.x - x) < 0.6 && Math.abs(pos.z - 17.5) < 0.6 && pos.y >= 67.9 && pos.y <= 69;
                    const tagged = a.addTag(SUM_TAG);
                    check(label, id === "minecraft:pig" && at && tagged, `summonAt -> ${id} at ${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)} tagged ${tagged} (want minecraft:pig at ${x},68,17.5)`);
                };
                spawned("str", Actor.summonAt(region, Vec3.create(27.5, 68, 17.5), "minecraft:pig"), 27.5);
                spawned("num", Actor.summonAt(region, Vec3.create(29.5, 68, 17.5), ActorType.Pig), 29.5);
                const prebuilt = SumAdid.constructWith("minecraft:pig");
                spawned("adid", Actor.summonAt(region, Vec3.create(31.5, 68, 17.5), prebuilt), 31.5);
                prebuilt.destruct();
                const none = Actor.summonAt(region, Vec3.create(33.5, 68, 17.5), "minecraft:bdsx_no_such_entity" as any);
                check("unknown", none === null, `summonAt("minecraft:bdsx_no_such_entity") -> ${none === null ? "null" : none.getIdentifier()} (want null)`);
                const listed = sumTagged();
                check("listed", listed.length === 3, `level lists ${listed.length} actor(s) tagged ${SUM_TAG}: [${listed.map(a => a.getIdentifier()).join(",")}] (want 3 pigs)`);
                break;
            }
            case "read": {
                const listed = sumTagged();
                const pigs = listed.filter(a => a.getIdentifier() === "minecraft:pig").length;
                check("later", listed.length === 3 && pigs === 3, `8 s later the level lists ${listed.length} tagged, ${pigs} pig(s) (want 3 and 3)`);
                break;
            }
            case "gone":
                console.log(`${SUM} INFO gone: ${sumTagged().length} tagged actor(s) listed after the kill`);
                break;
            default:
                console.log(`${SUM} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${SUM} FAIL ${step}: threw ${(err as Error).stack ?? err}`);
    }
});

// ---------------------------------------------------------------------------------------------------------------
// Audit leftovers (Q3, agent-s 2026-09-28; docs/findings-audit.md "Audit leftovers"). Four names the previous audit
// batch left open, each checked against BDS's own state on both sides:
//   reset      Player::resetPlayerLevel (40 0x2124b0 / 51 0x29fba0): after `xp 5L` + `xp 3`, level and progress 0
//              and the next-level requirement field (+0xb24) 7, its dirty byte (+0xb23) 0
//   tagbefore/tagafter  ILevel slot 303 getTagRegistry: the level's tag registry's tag-name vector (+0x40, Endstone
//              tag_registry.h `tags_ // +64`) lacks a fresh tag before `tag @a add` and holds it after, while
//              BDS's Actor::hasTag agrees
//   food <item> <0|1>   FoodItemComponent::canAlwaysEat through the IFoodItemComponent subobject, against the
//              component's own network tag's can_always_eat; and the component resolves as FoodItemComponent
//   nisd <count> <block 0|1>  NetworkItemStackDescriptor(ItemStack const&) and its destructor (derived, the deleting
//              destructor with flag 0), 200 rounds
import { CxxVector as AlVector } from "bdsx/cxxvector";
import { FoodItemComponent as AlFood } from "bdsx/bds/item_component";
import { NetworkItemStackDescriptor as AlNisd } from "bdsx/bds/inventory";
import { NBT as NBTal } from "bdsx/bds/nbt";
const AL = "[auditleft]";
const AL_TAG = "bdsxauditreg";
const alFoodSeen: string[] = [];
function alTags(): string[] {
    const reg = bedrockServer.level.getTagRegistry();
    return (reg as any as VoidPointer).addAs(AlVector.make(CxxString), 0x40).toArray();
}
function alFind(o: any, key: string): any {
    if (o === null || typeof o !== "object") return undefined;
    for (const k of Object.keys(o)) {
        if (k === key) return o[k];
        const r = alFind(o[k], key);
        if (r !== undefined) return r;
    }
    return undefined;
}
events.command.on(cmd => {
    const m = /^\/?auditleft (\w+)(?: (\S+))?(?: (\S+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const check = (name: string, ok: boolean, why: string): void => console.log(`${AL} ${ok ? "PASS" : "FAIL"} ${step}-${name}: ${why}`);
    const p = player;
    if (p === null) { console.log(`${AL} FAIL ${step}: no player`); return; }
    try {
        switch (step) {
            case "reset": {
                const raw = p as any as StaticPointer;
                const lv0 = p.getExperienceLevel(), pr0 = p.getExperienceProgress();
                check("before", lv0 === 5 && pr0 > 0, `after xp 5L + xp 3: level ${lv0}, progress ${pr0.toFixed(4)} (want 5 and > 0)`);
                p.resetExperienceLevels();
                const lv1 = p.getExperienceLevel(), pr1 = p.getExperienceProgress();
                const need = raw.getInt32(0xb24), dirty = raw.getUint8(0xb23), last = raw.getInt32(0xb28);
                check("after", lv1 === 0 && pr1 === 0, `resetExperienceLevels() -> level ${lv1}, progress ${pr1} (want 0 and 0)`);
                check("fields", need === 7 && dirty === 0, `Player+0xb24 ${need} (want 7, 2024 +0x19c8), +0xb23 ${dirty} (want 0, 2024 +0x19c4); +0xb28 ${last} (2024 +0x19c0, not written in 1.26)`);
                check("curve", p.getXpNeededForNextLevel() === 7, `getXpNeededForNextLevel() ${p.getXpNeededForNextLevel()} at level 0 (want 7)`);
                break;
            }
            case "tagbefore": {
                const tags = alTags();
                check("absent", !tags.includes(AL_TAG) && !p.hasTag(AL_TAG), `registry holds ${tags.length} tag name(s) [${tags.slice(0, 12).join(",")}], ${AL_TAG} ${tags.includes(AL_TAG) ? "present" : "absent"}; hasTag ${p.hasTag(AL_TAG)} (want absent, false)`);
                break;
            }
            case "tagafter": {
                const tags = alTags();
                const mine = p.getTags();
                check("present", tags.includes(AL_TAG) && p.hasTag(AL_TAG) && mine.includes(AL_TAG), `registry holds ${tags.length} tag name(s), ${AL_TAG} at index ${tags.indexOf(AL_TAG)}; hasTag ${p.hasTag(AL_TAG)}; getTags [${mine.join(",")}] (want present, true, listed)`);
                check("sameobj", bedrockServer.level.getTagRegistry().equalsptr(bedrockServer.level.getTagRegistry()), `two calls give the same registry ${bedrockServer.level.getTagRegistry()}`);
                break;
            }
            case "food": {
                const want = m[3] === "1";
                const item = p.getSelectedItem();
                const name = item.getName();
                const ci = item.getComponentItem();
                // 1.26 still has native food items (golden_apple is one): those have no component map to ask
                if (ci === null) { console.log(`${AL} INFO food: ${name} is not a component item (getComponentItem() null)`); break; }
                const food = ci.getComponent("minecraft:food");
                if (food === null) { console.log(`${AL} INFO food: ${name} has no minecraft:food component`); break; }
                check("class", food instanceof AlFood, `${name}: component ${food} resolves as ${food.constructor.name} (want FoodItemComponent, the NetworkedItemComponent<FoodItemComponent> vftable)`);
                const mine = (food as AlFood).canAlwaysEat();
                const tag = food.buildNetworkTag();
                const tv = tag === null ? null : tag.value();
                if (tag !== null) tag.dispose();
                const eng = alFind(tv, "can_always_eat");
                const engBool = eng === undefined ? undefined : !!(typeof eng === "object" && eng !== null ? eng.value ?? eng.data : eng);
                check("value", mine === want && engBool === want, `${name} (${m[2]}): canAlwaysEat() ${mine}, the component's own network tag can_always_eat ${JSON.stringify(eng)} (want ${want} from both)`);
                if (mine === engBool) alFoodSeen.push(`${name}=${mine}`);
                break;
            }
            case "foodflip": {
                // The true side. 1.26's vanilla foods that can always be eaten are native items (no component
                // map), so the apple's own component is flipped by the engine: initializeFromNetwork with its own
                // network tag, can_always_eat set to 1, then restored from the untouched tag.
                const item = p.getSelectedItem();
                const ci = item.getComponentItem();
                const food = ci === null ? null : ci.getComponent("minecraft:food");
                if (food === null) { check("comp", false, `${item.getName()}: no food component`); break; }
                const orig = food.buildNetworkTag();
                const v = orig.value();
                let holder: any = null;
                const walk = (o: any): void => {
                    if (holder !== null || o === null || typeof o !== "object") return;
                    if ("can_always_eat" in o) { holder = o; return; }
                    for (const k of Object.keys(o)) walk(o[k]);
                };
                walk(v);
                if (holder === null) { orig.dispose(); check("tag", false, "no can_always_eat in the network tag"); break; }
                holder.can_always_eat = NBTal.byte(1);
                const flipped = NBTal.allocate(v) as any;
                const r1 = food.initializeFromNetwork(flipped);
                flipped.dispose();
                const on = (food as AlFood).canAlwaysEat();
                const t1 = food.buildNetworkTag();
                const e1 = alFind(t1.value(), "can_always_eat");
                t1.dispose();
                const r2 = food.initializeFromNetwork(orig);
                const off = (food as AlFood).canAlwaysEat();
                const t2 = food.buildNetworkTag();
                const e2 = alFind(t2.value(), "can_always_eat");
                t2.dispose();
                orig.dispose();
                check("on", !!r1 && on === true && JSON.stringify(e1) === '{"_value":1}', `${item.getName()}: initializeFromNetwork(can_always_eat 1) ${!!r1} -> canAlwaysEat() ${on}, its network tag ${JSON.stringify(e1)} (want true, 1)`);
                check("off", !!r2 && off === false && JSON.stringify(e2) === '{"_value":0}', `restored from its own tag ${!!r2} -> canAlwaysEat() ${off}, its network tag ${JSON.stringify(e2)} (want false, 0)`);
                if (on === true) alFoodSeen.push(`${item.getName()}(flipped)=true`);
                break;
            }
            case "foodsum": {
                const t = alFoodSeen.filter(x => x.endsWith("=true")).length, f = alFoodSeen.filter(x => x.endsWith("=false")).length;
                check("both", t > 0 && f > 0, `component items whose canAlwaysEat() equals their network tag: [${alFoodSeen.join(",")}] (want at least one true and one false)`);
                break;
            }
            case "nisd": {
                const wantCount = Number(m[2]), wantBlock = m[3] === "1";
                const item = p.getSelectedItem();
                const name = item.getName(), amount = item.getAmount();
                let count = -1, rid = -1, net = -1, udLen = -1, rounds = 0;
                for (let i = 0; i < 200; i++) {
                    const d = AlNisd.constructWith(item);
                    const raw = d as any as StaticPointer;
                    if (i === 0) {
                        count = raw.getUint16(0x10);
                        net = raw.getUint8(0x18);
                        rid = raw.getUint32(0x38);
                        udLen = raw.getInt32(0x50);
                        console.log(`${AL} INFO nisd: ${name} vptr ${raw.getPointer(0)} count ${count} includeNetIds ${net} blockRuntimeId ${rid} userData ${udLen}B ('${d._unknown.slice(0, 40).replace(/[^\x20-\x7e]/g, ".")}')`);
                    }
                    d.destruct();
                    rounds++;
                }
                check("count", count === wantCount && count === amount, `${name}: descriptor stack size ${count}, ItemStack.getAmount() ${amount} (want ${wantCount})`);
                check("block", (rid !== 0) === wantBlock && net === 0, `${name}: block runtime id ${rid} (want ${wantBlock ? "nonzero" : "0"}), includeNetIds ${net} (want 0)`);
                check("dtor", rounds === 200, `${rounds} construct/destruct rounds, user data ${udLen} bytes (a heap string when > 15)`);
                break;
            }
            default:
                console.log(`${AL} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${AL} FAIL ${step}: threw ${(err as Error).stack ?? err}`);
    }
});

// `skinprobe <step>`: SerializedSkin on 1.26 (docs/findings-layouts.md "SerializedSkin"). The skin the bot
// logged in with is read through bdsx's fields and compared with what tools/livebot.cjs sent
// (BP_SKIN_ID, BP_PLAYFAB_ID, BP_SKIN_JSON in the skin40/skin51 drivers); bdsx's own skins are built by
// the engine's SerializedSkinImpl() and torn down by the engine's inlined destructor (the make_shared
// control block's _Destroy, called on the object's address minus 0x10), and every check reads a byte the
// engine wrote rather than one bdsx wrote.
//   skinprobe read <cmdVersion>   the bot's skin, and its control block
//   skinprobe life <cmdVersion>   200 rounds of construct / write / destruct, plus copy and move refused
//   skinprobe packet <cmdVersion> PlayerSkinPacket's skin: 1.26 holds it by SerializedSkinRef
// <cmdVersion> is the build's CurrentCmdVersion::Latest, which SerializedSkinImpl() stores in its
// MinEngineVersion: 50 on 1.26.40.8, 52 on 1.26.51.1 (read out of both constructors).
const STAG = "[skin]";
function scheck(step: string, ok: boolean, why: string): void {
    console.log(`${STAG} ${ok ? "PASS" : "FAIL"} ${step}: ${why}`);
}
// ServerNetworkHandler's login path (40 0xa8d870 / after SerializedSkinRef(ConnectionRequest)) replaces a skin that fails
// its checks with a default one marked trusted: a non-persona skin must have an 8K/16K/64K image and be trusted, a persona
// skin a valid geometry version. The library's default skin is a persona one, so PersonaSkin stays true.
const SKIN_SENT = {
    SkinId: "bdsx-revival-probe.Custom",
    PlayFabId: "bdsxplayfab0123",
    CapeId: "bdsx-cape-probe-0123456789",
    SkinAnimationData: "bdsx-anim-probe",
    ArmSize: "slim",
    PremiumSkin: true,
    PersonaSkin: true,
    CapeOnClassicSkin: true,
    OverrideSkin: true,
    ProfileHash: "bdsx-profile-hash-0123",
    GeometryVersion: [1, 21, 30],
};
/** an empty MSVC std::string: size 0, capacity 15 */
function isEmptySso(sp: StaticPointer, off: number): boolean {
    return sp.getBin64(off + 16) === bin.make64(0, 0) && sp.getBin64(off + 24) === bin.make64(15, 0);
}
function skinDefaultsOk(s: SerializedSkin, cmdVersion: number): string {
    const sp = s as unknown as StaticPointer;
    const bad: string[] = [];
    if (s.id !== "" || s.capeId !== "" || s.animationData !== "" || s.profileHash !== "") bad.push("a string is not empty");
    if (s.armSizeType !== 1) bad.push(`armSizeType ${s.armSizeType} (Wide is 1)`);
    const v = s.geometryDataEngineVersion;
    if (v.commandVersion !== cmdVersion) bad.push(`commandVersion ${v.commandVersion}, want ${cmdVersion}`);
    if (v.molangVersion !== -1) bad.push(`molangVersion ${v.molangVersion}, want -1`);
    if (s.skinImage.width !== 0 || s.skinImage.blob.size !== 0) bad.push("the skin image is not empty");
    if (s.personaPieces.size() !== 0 || s.skinAnimatedImages.size() !== 0) bad.push("a vector is not empty");
    if (s.isPremium || s.isPersona || s.isPersonaCapeOnClassicSkin || s.overridesPlayerAppearance) bad.push("a flag is set");
    if (!isEmptySso(sp, engineLayout("SerializedSkin", "profileHash", -1))) bad.push("profileHash is not an empty SSO string");
    return bad.join("; ");
}

events.command.on(cmd => {
    const m = /^\/?skinprobe (\w+)(?: (\S+))?$/.exec(cmd);
    if (m === null) return;
    const step = m[1];
    const cmdVersion = Number(m[2] ?? "0");
    try {
        const destroyAddr = proc["bdsx:std::_Ref_count_obj2<ThreadOwner<SerializedSkinImpl>>::_Destroy"];
        switch (step) {
            case "read": {
                const p = player;
                if (p === null) {
                    scheck("read", false, "no player");
                    return;
                }
                const s = p.getSkin();
                const sp = s as unknown as StaticPointer;
                // Player+2736 -> SerializedSkinRef {object, control block}; make_shared's block holds its
                // vptr and the two counts, then the object at +0x10
                const ref = (p as unknown as StaticPointer).getPointer(pdbcache.layouts.Player?.skin ?? 2736);
                const obj = ref.getPointer(0), ctrl = ref.getPointer(8);
                scheck("read-ref", obj.equalsptr(sp) && ctrl.add(0x10).equalsptr(obj), `getSkin() ${sp} is the SerializedSkinRef's object, 0x10 into its control block ${ctrl}`);
                scheck(
                    "read-ctrl-destroy",
                    ctrl.getPointer(0).getPointer(0).equalsptr(destroyAddr),
                    `slot 0 of that control block's vftable is the table's _Destroy ${destroyAddr} -- the destructor bdsx calls on its own skins`,
                );
                const v = s.geometryDataEngineVersion;
                const img = s.skinImage;
                console.log(
                    `${STAG} INFO read id=${JSON.stringify(s.id)} playFabId=${JSON.stringify(s.playFabId)} capeId=${JSON.stringify(s.capeId)} anim=${JSON.stringify(s.animationData)} arm=${s.armSizeType}(${s.armSize}) ` +
                        `premium=${s.isPremium} persona=${s.isPersona} capeOnClassic=${s.isPersonaCapeOnClassicSkin} primary=${s.isPrimaryUser} override=${s.overridesPlayerAppearance} trusted=${s.isTrustedSkin} ` +
                        `profileHash=${JSON.stringify(s.profileHash)} geomVer=${v.major}.${v.minor}.${v.patch} cmd=${v.commandVersion} molang=${v.molangVersion} ` +
                        `image=${img.width}x${img.height} fmt=${img.imageFormat} blob=${img.blob.size} cape=${s.capeImage.width}x${s.capeImage.height} pieces=${s.personaPieces.size()} anims=${s.skinAnimatedImages.size()} ` +
                        `color=${s.skinColor.r},${s.skinColor.g},${s.skinColor.b},${s.skinColor.a}`,
                );
                scheck("read-id", s.id === SKIN_SENT.SkinId, `id ${JSON.stringify(s.id)}, sent SkinId ${JSON.stringify(SKIN_SENT.SkinId)} (+0x0)`);
                // playFabId (+0x20) reads empty whatever the login sends (docs/findings-layouts.md "What the console proved");
                // the member after it is the check
                scheck("read-fullid", s.fullId.startsWith(SKIN_SENT.SkinId), `fullId ${JSON.stringify(s.fullId)} starts with the SkinId (+0x40)`);
                const pieces = s.personaPieces.toArray();
                console.log(`${STAG} INFO read pieces: ${pieces.map(x => `${x.pieceId}:${x.pieceType}${x.isDefaultPiece ? "*" : ""}`).join(" ")}`);
                scheck("read-pieces", pieces.length > 0 && pieces.every(x => x.pieceId.length > 0 && x.pieceType > 0 && x.pieceType < 26), `${pieces.length} persona pieces, each with an id and a PieceType (+0x198, 0x60-byte elements)`);
                scheck("read-image", img.width > 0 && img.height > 0 && img.blob.size === img.width * img.height * 4, `skinImage ${img.width}x${img.height} holds ${img.blob.size} bytes = w*h*4 (+0xa0)`);
                scheck(
                    "read-geomver",
                    v.major === SKIN_SENT.GeometryVersion[0] && v.minor === SKIN_SENT.GeometryVersion[1] && v.patch === SKIN_SENT.GeometryVersion[2],
                    `geometryDataEngineVersion ${v.major}.${v.minor}.${v.patch}, sent ${SKIN_SENT.GeometryVersion.join(".")} (MinEngineVersion +0x128)`,
                );
                scheck("read-anim", s.animationData === SKIN_SENT.SkinAnimationData, `animationData ${JSON.stringify(s.animationData)}, sent SkinAnimationData base64-encoded (+0x158; 2024 +0x1a8)`);
                scheck("read-cape", s.capeId === SKIN_SENT.CapeId, `capeId ${JSON.stringify(s.capeId)}, sent CapeId (+0x178; 2024 +0x1c8)`);
                scheck("read-arm", s.armSizeType === 0 && s.armSize === "slim", `armSizeType ${s.armSizeType} (${s.armSize}), sent ArmSize "slim" (+0x1b0, a byte)`);
                scheck("read-premium", s.isPremium === SKIN_SENT.PremiumSkin, `isPremium ${s.isPremium}, sent PremiumSkin ${SKIN_SENT.PremiumSkin} (+0x209)`);
                scheck("read-persona", s.isPersona === SKIN_SENT.PersonaSkin, `isPersona ${s.isPersona}, sent PersonaSkin ${SKIN_SENT.PersonaSkin} (+0x20a)`);
                scheck("read-caponclassic", s.isPersonaCapeOnClassicSkin === SKIN_SENT.CapeOnClassicSkin, `isPersonaCapeOnClassicSkin ${s.isPersonaCapeOnClassicSkin}, sent CapeOnClassicSkin (+0x20b)`);
                scheck("read-override", s.overridesPlayerAppearance === SKIN_SENT.OverrideSkin, `overridesPlayerAppearance ${s.overridesPlayerAppearance}, sent OverrideSkin (+0x20d)`);
                scheck("read-profilehash", s.profileHash === SKIN_SENT.ProfileHash, `profileHash ${JSON.stringify(s.profileHash)}, sent ProfileHash (+0x210, new in 1.26)`);
                let copyErr = "";
                try {
                    SerializedSkin.construct(s);
                } catch (err) {
                    copyErr = (err as Error).message;
                }
                scheck("read-nocopy", copyErr.includes("not available on BDS 1.26"), `SerializedSkin.construct(the bot's skin) throws: ${JSON.stringify(copyErr.slice(0, 100))}`);
                break;
            }
            case "life": {
                const ROUNDS = 200;
                let firstBad = "";
                let dtorBad = "";
                for (let i = 0; i < ROUNDS; i++) {
                    const s = new SerializedSkin(true);
                    const sp = s as unknown as StaticPointer;
                    sp.fill(0xcd, SerializedSkin[NativeType.size]);
                    s.construct();
                    if (i === 0) {
                        firstBad = skinDefaultsOk(s, cmdVersion);
                        console.log(`${STAG} INFO life size=0x${SerializedSkin[NativeType.size].toString(16)} round0 defaults: ${firstBad || "all as the engine constructor writes them"}`);
                    }
                    // heap strings (longer than 15), so the destructor has something to free
                    s.id = `bdsx-life-skin-id-${i}-0123456789`;
                    s.capeId = `bdsx-life-cape-${i}-0123456789`;
                    s.animationData = `bdsx-life-anim-${i}-0123456789`;
                    if (s.id !== `bdsx-life-skin-id-${i}-0123456789` || s.capeId !== `bdsx-life-cape-${i}-0123456789`) firstBad ||= `round ${i}: a written string did not read back`;
                    s.destruct();
                    // the engine's destructor resets every std::string to empty SSO and zeroes the tint map's
                    // bucket vector (+0x1c8..+0x1e0) after freeing it
                    const tint = engineLayout("SerializedSkin", "pieceTintColors", -1);
                    const reset =
                        isEmptySso(sp, 0) &&
                        isEmptySso(sp, engineLayout("SerializedSkin", "capeId", -1)) &&
                        isEmptySso(sp, engineLayout("SerializedSkin", "animationData", -1)) &&
                        sp.getBin64(tint + 0x18) === bin.make64(0, 0) &&
                        sp.getBin64(tint + 0x20) === bin.make64(0, 0) &&
                        sp.getBin64(tint + 0x28) === bin.make64(0, 0);
                    if (!reset && dtorBad === "") dtorBad = `round ${i}: after destruct the strings or the tint map's bucket vector (+${tint + 0x18}) are not reset`;
                }
                scheck("life-ctor", firstBad === "", `SerializedSkinImpl() on 0xcd-filled memory: ${firstBad || `empty strings and vectors, armSizeType 1, commandVersion ${cmdVersion}, molangVersion -1`}`);
                scheck("life-dtor", dtorBad === "", `${ROUNDS} rounds of construct, three heap strings, destruct: ${dtorBad || "every round the engine's destructor freed and reset the strings and the tint map"}`);
                const a = SerializedSkin.construct();
                let copyErr = "",
                    moveErr = "";
                try {
                    SerializedSkin.construct(a);
                } catch (err) {
                    copyErr = (err as Error).message;
                }
                try {
                    const b = new SerializedSkin(true);
                    b[NativeType.ctor_move](a);
                } catch (err) {
                    moveErr = (err as Error).message;
                }
                a.destruct();
                scheck("life-nocopy", copyErr.includes("not available on BDS 1.26"), `copy throws ${JSON.stringify(copyErr.slice(0, 100))}`);
                scheck("life-nomove", moveErr.includes("not available on BDS 1.26"), `move throws ${JSON.stringify(moveErr.slice(0, 100))}`);
                break;
            }
            case "packet": {
                const ROUNDS = 200;
                let bad = "";
                for (let i = 0; i < ROUNDS; i++) {
                    const pk = PlayerSkinPacket.allocate();
                    const s = pk.skin;
                    const pkp = pk as unknown as StaticPointer;
                    const ctrl = pkp.getPointer(engineLayout("PlayerSkinPacket", "skin", -1) + 8);
                    if (i === 0) {
                        const d = skinDefaultsOk(s, cmdVersion);
                        console.log(`${STAG} INFO packet skin=${s} ctrl=${ctrl} new=${JSON.stringify(pk.localizedNewSkinName)} old=${JSON.stringify(pk.localizedOldSkinName)} defaults: ${d || "as the constructor writes them"}`);
                        if (d !== "") bad = `round 0: ${d}`;
                        if (!ctrl.add(0x10).equalsptr(s as unknown as StaticPointer) || !ctrl.getPointer(0).getPointer(0).equalsptr(destroyAddr)) bad ||= "round 0: the skin is not a make_shared SerializedSkinImpl";
                    }
                    pk.localizedNewSkinName = `bdsx-new-skin-name-${i}-0123456789`;
                    pk.localizedOldSkinName = "old";
                    if (pk.localizedNewSkinName !== `bdsx-new-skin-name-${i}-0123456789` || pk.localizedOldSkinName !== "old") bad ||= `round ${i}: a name did not read back`;
                    if (s.armSizeType !== 1) bad ||= `round ${i}: armSizeType ${s.armSizeType}`;
                    pk.dispose();
                }
                scheck("packet", bad === "", `${ROUNDS} PlayerSkinPackets from the engine: the skin behind the SerializedSkinRef at +${engineLayout("PlayerSkinPacket", "skin", -1)} is a default SerializedSkinImpl, the two names at +${engineLayout("PlayerSkinPacket", "localizedNewSkinName", -1)}/+${engineLayout("PlayerSkinPacket", "localizedOldSkinName", -1)} read back, dispose clean: ${bad || "ok"}`);
                break;
            }
            default:
                console.log(`${STAG} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${STAG} FAIL ${step}: threw ${(err as Error).stack ?? err}`);
    }
});

// `atkprobe`: Actor::canAttack, derived() over the target's PLAYING_DEAD flag and type id (the 1.26 vtable has no slot for
// it; docs/findings-inventory.md section 14). Both answers, each from the engine's own data: a zombie and a cow are true, a
// ghast (the 0xb29 test) is false, a zombie with PLAYING_DEAD set through BDS's own setActorFlag is false and true again once
// cleared, a null target is false. The ghast's real type id is printed so a renumbering would show.
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "atkprobe") return;
    if (player === null) { console.log("[layout] no player"); return; }
    const p = player;
    const uidOf = (a: Actor): string => String(a.getUniqueIdBin());
    const spawned: Actor[] = [];
    try {
        bedrockServer.executeCommand("gamemode creative @a");
        const seen = new Set<string>();
        for (const e of bedrockServer.level.getEntities()) seen.add(uidOf(e));
        const found = new Map<string, Actor>();
        let x = 20;
        for (const t of ["zombie", "cow", "ghast", "happy_ghast"]) {
            bedrockServer.executeCommand(`summon ${t} ${x} 70 30`);
            x += 4;
            for (const e of bedrockServer.level.getEntities()) {
                if (seen.has(uidOf(e))) continue;
                seen.add(uidOf(e));
                let id = "";
                try { id = e.getIdentifier(); } catch (err) { continue; }
                if (id === `minecraft:${t}` && !found.has(t)) { found.set(t, e); spawned.push(e); }
            }
        }
        console.log(`[layout] INFO atkprobe spawned: ${[...found.keys()].join(" ")}`);
        for (const [t, e] of found) console.log(`[layout] INFO atkprobe type id ${t} = 0x${e.getEntityTypeId().toString(16)}`);
        const zombie = found.get("zombie"), cow = found.get("cow"), ghast = found.get("ghast");
        const say = (ok: boolean, what: string, got: unknown, want: unknown): void =>
            console.log(`[layout] ${ok ? "PASS" : "FAIL"} atkprobe ${what}: ${got} (want ${want})`);
        if (zombie === undefined || cow === undefined || ghast === undefined) {
            console.log("[layout] FAIL atkprobe missing spawn");
            return;
        }
        const r1 = p.canAttack(zombie), r2 = p.canAttack(cow), r3 = p.canAttack(ghast), r4 = p.canAttack(null), r5 = zombie.canAttack(cow);
        say(r1 === true, "player -> zombie", r1, true);
        say(r2 === true, "player -> cow", r2, true);
        say(r3 === false, "player -> ghast", r3, false);
        say(r4 === false, "player -> null", r4, false);
        say(r5 === true, "zombie -> cow", r5, true);
        const hg = found.get("happy_ghast");
        if (hg !== undefined) console.log(`[layout] INFO atkprobe player -> happy_ghast: ${p.canAttack(hg)} (2024 has no such type; its low byte differs from ghast's ${ghast.getEntityTypeId() & 0xff})`);
        const before = cow.getStatusFlag(ActorFlags.PlayingDead);
        cow.setStatusFlag(ActorFlags.PlayingDead, true);
        const flagged = cow.getStatusFlag(ActorFlags.PlayingDead), r6 = p.canAttack(cow);
        cow.setStatusFlag(ActorFlags.PlayingDead, before);
        const r7 = p.canAttack(cow);
        say(flagged === true && r6 === false, "cow with PLAYING_DEAD", `flag ${flagged} -> ${r6}`, "flag true -> false");
        say(r7 === true, "cow with the flag cleared", r7, true);
    } catch (err) {
        console.log(`[layout] FAIL atkprobe threw ${(err as Error).message}`);
    } finally {
        for (const e of spawned) { try { e.kill(); } catch (err) { /* already gone */ } }
    }
});
