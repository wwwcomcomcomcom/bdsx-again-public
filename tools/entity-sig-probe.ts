// Execution check for the events whose native function changed signature in 1.26
// (docs/findings-slots.md, "Changed signatures"): playerDimensionChange, entityKnockback and
// playerSleepInBed hook the function under its present decorated name with the present prototype.
// Deployed beside example_and_test as zz-sigprobe.ts; a bot joins and the console drives it:
//   "tp @a 29 68 14", "execute as @a at @s run summon zombie ~1 ~ ~1" (the zombie's hits are knockback),
//   "execute as @a in nether run tp @s 0 80 0" (the dimension change)
//
// The second half is Q2: the events whose hook target ships but whose 2024 prototype had never
// been run, and the two calls bdsx makes into the binary from JavaScript (Mob::knockback,
// Actor::hurt). Everything in that half is behind SIG_EVENTS -- this file compiles into every
// session on the host, so a hook that is still being proved must never install by default.
import { Actor, ActorDamageByActorSource, ActorDamageByChildActorSource, ActorDamageCause, ActorDamageSource, Mob } from "bdsx/bds/actor";
import { BlockPos, ChunkPos } from "bdsx/bds/blockpos";
import { bin } from "bdsx/bin";
import { AbilitiesIndex } from "bdsx/bds/abilities";
import { Player } from "bdsx/bds/player";
import { procHacker } from "bdsx/bds/proc";
import { proc } from "bdsx/bds/symbols";
import { AllocatedPointer, StaticPointer, VoidPointer } from "bdsx/core";
import { dllraw } from "bdsx/dllraw";
import { events } from "bdsx/event";
import { bin64_t, float32_t } from "bdsx/nativetype";

function say(label: string, detail: string): void {
    console.log(`[sigprobe] ${label}: ${detail}`);
}
function verdict(label: string, ok: boolean, detail: string): void {
    console.log(`[sigprobe] ${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
// whatever naming call this build supports; a probe must never throw into a native hook
function name(a: { getIdentifier?(): string }): string {
    try {
        return String(a.getIdentifier?.());
    } catch (err) {
        return String(a);
    }
}
// SIG_ONLY=hurt|knockback|dimension installs one hook alone, to tell which of them a crash belongs to
const only = process.env.SIG_ONLY ?? "";
const want = (k: string): boolean => only === "" || only === k;
let knockbacks = 0;
let lastParams: number[] | null = null;
if (want("knockback"))
    events.entityKnockback.on(ev => {
        if (ev.parameters !== null) {
            lastParams = [];
            for (let i = 0; i < 28; i++) lastParams.push(ev.parameters.getUint8(i));
        }
        if (knockbacks++ >= 6) return;
        let raw = "";
        if (lastParams !== null) for (let i = 0; i < 28; i++) raw += lastParams[i].toString(16).padStart(2, "0") + (i % 4 === 3 ? " " : "");
        say(
            "entityKnockback",
            `target ${name(ev.target)} source ${ev.source === null ? "null" : name(ev.source)} damage ${ev.damage} xd ${ev.xd.toFixed(3)} zd ${ev.zd.toFixed(
                3,
            )} power ${ev.power} height ${ev.height} cap ${ev.heightCap} raw ${raw}`,
        );
    });
// the fights themselves, so that a silent knockback hook can be told from a quiet golem
let hurts = 0;
if (want("hurt"))
    events.entityHurt.on(ev => {
        if (hurts++ < 8) say("entityHurt", `${name(ev.entity)} damage ${ev.damage} cause ${ev.damageSource.cause} knock ${ev.knock} ignite ${ev.ignite} (knockbacks so far ${knockbacks})`);
    });
if (want("dimension"))
    events.playerDimensionChange.on(ev => {
        say("playerDimensionChange", `${ev.player.getName()} -> dimension ${ev.dimension} (portal ${ev.useNetherPortal})`);
    });
if (want("sleep"))
    events.playerSleepInBed.on(ev => {
        say("playerSleepInBed", `${ev.player.getName()} at ${ev.pos.x} ${ev.pos.y} ${ev.pos.z}`);
    });

// ---------------------------------------------------------------------------------------------
// Q2. The UNFIRED events, and the two calls into the binary.
//
// SIG_EVENTS is a comma-separated opt-in list; nothing below installs without it:
//   levelup  entityDie  pickup  save  totem      -- the hooks bdsx's own installers put in
//   calls                                        -- `sigprobe knock|hurt`, which call into BDS
const evs = new Set(
    (process.env.SIG_EVENTS ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(s => s.length !== 0),
);
const counts: Record<string, number> = {};
function mark(k: string, detail: string): void {
    counts[k] = (counts[k] ?? 0) + 1;
    if (counts[k] <= 4) console.log(`[sigprobe] PASS ${k}: fire #${counts[k]} ${detail}`);
}
const SUMMARY: [string, string][] = [
    ["playerLevelUp", "levelup"],
    ["entityDie", "entityDie"],
    ["playerPickupItem", "pickup"],
    ["levelSave", "save"],
    ["entityConsumeTotem", "totem"],
    ["playerDropItem", "drop"],
    ["playerAttack", "attack"],
];
if (evs.has("levelup")) events.playerLevelUp.on(ev => mark("playerLevelUp", `${ev.player.getName()} +${ev.levels}`));
if (evs.has("entityDie")) events.entityDie.on(ev => mark("entityDie", `${name(ev.entity)} cause ${ev.damageSource.cause}`));
if (evs.has("pickup")) events.playerPickupItem.on(ev => mark("playerPickupItem", `${ev.player.getName()} <- ${name(ev.itemActor)}`));
if (evs.has("save")) events.levelSave.on(ev => mark("levelSave", `level ${ev.level}`));
if (evs.has("totem"))
    events.entityConsumeTotem.on(ev => {
        let item = "?";
        try {
            item = String(ev.totem.getId());
        } catch (err) {
            item = `(${(err as Error).message})`;
        }
        mark("entityConsumeTotem", `${name(ev.entity)} totem id ${item}`);
    });
// Not a firing check -- the console cannot make BDS send an InventoryTransaction packet, so this
// event never fires from a console session (Q7). Subscribing is enough to run
// events.playerDropItem.setInstaller(), which installs the native hook
// procHacker.hooking("?drop@Player@@UEAA_NAEBVItemStack@@_N@Z", ...) under the present prototype
// (rcx=this, rdx=ItemStack const&, r8b=randomly -- confirmed unchanged by reading both 1.26
// bodies to the end, docs/findings-slots.md "Changed signatures"). The check here is that
// installing that hook does not crash the boot.
if (evs.has("drop"))
    events.playerDropItem.on(ev => {
        let item = "?";
        try {
            item = ev.itemStack.toString();
        } catch (err) {
            item = `(${(err as Error).message})`;
        }
        mark("playerDropItem", `${ev.player.getName()} item ${item} inContainer ${ev.inContainer} slot ${ev.hotbarSlot ?? "?"}`);
    });
// events.playerAttack fires from the new "bdsx:Actor::attack" hook (docs/findings-audit.md "attack").
// Like drop, the console cannot make a headless bot swing (Q7), so subscribing is the boot-safety
// half of the check; `sigprobe attack` below is the direct-call half, calling through the same
// hooked address the way BDS's own vtable dispatch would.
let attackPlayer: Player | null = null;
if (evs.has("attack")) {
    events.playerJoin.on(ev => {
        attackPlayer = ev.player;
    });
    events.playerAttack.on(ev => mark("playerAttack", `${ev.player.getName()} -> ${name(ev.victim)}`));
}

// `PlayerInventory::dropAllOnDeath` and `Inventory::dropSlot`, next-steps Q1-B-3
// (docs/findings-containers.md 12): both are now `derived()` on both builds instead of a
// 1.26.40.8-only address bdsx never called. `sigprobe dropall` below arms the check; the call
// itself is made from `events.levelTick` rather than the console command's own callback, the
// same precaution `Mob::sendArmorSlot` (docs/status.md, 2026-09-23) earned -- a native call that
// spawns an entity and touches network state is run from the game-tick context real plugin code
// already calls it from, not tested only from whatever thread the console line happens to run on.
let dropallPlayer: Player | null = null;
let dropallArmed: { before: string } | null = null;
function summarizeInventory(): string {
    if (dropallPlayer === null) return "(no player)";
    const slots = dropallPlayer.getInventory().getSlots();
    const parts: string[] = [];
    for (let i = 0; i < slots.size(); i++) {
        const item = slots.get(i);
        if (item === null || item.isNull()) continue;
        let s = "?";
        try {
            s = item.toString();
        } catch (err) {
            s = `(${(err as Error).message})`;
        }
        parts.push(`${i}:${s}`);
    }
    return parts.length === 0 ? "(empty)" : parts.join(", ");
}
if (evs.has("dropall")) {
    events.playerJoin.on(ev => {
        dropallPlayer = ev.player;
    });
    events.levelTick.on(() => {
        if (dropallArmed === null) return;
        const { before } = dropallArmed;
        dropallArmed = null;
        if (dropallPlayer === null) {
            verdict("dropAllOnDeath", false, "player left before the tick ran");
            return;
        }
        // Diagnostic only: 2024's `?drop@Player@@` (baseline 0x19dc9f0) opens with
        // `if (!hasDimension()) return false;` then, unless the caller is dead
        // (`getHealth() <= 0`), requires `LayeredAbilities::getBool(AbilitiesIndex 2)` -- this is
        // the gate whose value decides whether the call below can succeed at all on a live player.
        let abilityDiag = "?";
        try {
            const abilities = dropallPlayer.getAbilities();
            abilityDiag = `health=${dropallPlayer.getHealth()} ability[Build]=${abilities.getBool(AbilitiesIndex.Build)} ability[DoorsAndSwitches]=${abilities.getBool(
                2 as AbilitiesIndex,
            )} ability[OpenContainers]=${abilities.getBool(AbilitiesIndex.OpenContainers)}`;
        } catch (err) {
            abilityDiag = `threw ${(err as Error).message}`;
        }
        console.log(`[sigprobe] INFO dropall: ${abilityDiag}`);
        try {
            dropallPlayer.getInventory().dropAllOnDeath(false);
        } catch (err) {
            verdict("dropAllOnDeath", false, `threw ${(err as Error).message} (before: ${before})`);
            return;
        }
        const after = summarizeInventory();
        // doDropSlot (implements.ts) now leaves a slot untouched when Player::drop refuses it, so
        // "before non-empty, after empty" only happens when every drop actually returned true --
        // this verdict is not a substitute for the driver's own "testfor @e[type=item]" (BDS
        // confirming the entity), but it is no longer possible to PASS here on a refused drop that
        // silently destroyed the item the way an earlier version of this check could.
        verdict("dropAllOnDeath", before !== "(empty)" && after === "(empty)", `before ${before} -> after ${after}`);
    });
}

// A victim to call into: the actor bdsx's own entityHurt hook last saw whose identifier matches
// `sigprobe arm <identifier>`. It is held as an ActorUniqueID and re-fetched, never as a pointer --
// a mob that died between the capture and the call would otherwise be a freed Actor, and calling
// into one is not distinguishable from a wrong address (docs/findings-blocks.md 11). The filter
// matters: a burning zombie 30 blocks away fires entityHurt too, and the last one wins.
let armKind: string | null = null;
let victimId: bin64_t | null = null;
let victimKind = "";
// ActorDamageSource has neither a constructor nor a vftable symbol on either 1.26 build, so the
// object is copied off a live one: the 2024 constructor (0x17bc880) is `movl %edx, 8(%rcx);
// movq <vft>, (%rcx); retq` and nothing else, and 2024's vftable slot 0 sized-deletes 16 bytes, so
// a vftable pointer and a cause *are* the object. The console drives a `damage ... <cause>` with no
// damager first, whose source has no attacker and is therefore the plain base class.
let sourceVft: VoidPointer | null = null;
let sourceCause = 0;
const sourceBytes = new AllocatedPointer(32); // what the live source really holds, for the record
// the two caller-owned structs the hooks see, copied out (they do not outlive the hook)
const seenKnockParams = new AllocatedPointer(28);
let sawKnockParams = false;
const seenHurtParams = new AllocatedPointer(24);
let sawHurtParams = false;

const ACTOR_DAMAGE_SOURCE_VFTABLE = "??_7ActorDamageSource@@6B@";

function hex(p: StaticPointer, n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += p.getUint8(i).toString(16).padStart(2, "0") + (i % 4 === 3 ? " " : "");
    return out.trim();
}

if (evs.has("calls")) {
    events.entityKnockback.on(ev => {
        try {
            if (ev.parameters !== null) {
                seenKnockParams.copyFrom(ev.parameters, 28);
                sawKnockParams = true;
            }
        } catch (err) {
            /* never throw into a native hook */
        }
    });
    events.entityHurt.on(ev => {
        try {
            if (armKind !== null && name(ev.entity) !== armKind) return;
            victimId = ev.entity.getUniqueIdBin();
            victimKind = name(ev.entity);
            sourceVft = ev.damageSource.vftable;
            sourceCause = ev.damageSource.cause;
            sourceBytes.copyFrom(ev.damageSource as any, 32);
            if (ev.parameters !== null) {
                seenHurtParams.copyFrom(ev.parameters, 24);
                sawHurtParams = true;
            }
        } catch (err) {
            /* never throw into a native hook */
        }
    });
}

function liveVictim(): Actor | null {
    return victimId === null ? null : Actor.fromUniqueIdBin(victimId, false);
}
// bdsx's own ActorDamageSource.create: on 1.26 there is no constructor, so it builds the 48-byte
// object over symbols.json's ??_7ActorDamageSource@@6B@ (bds/implements.ts). Using it here is the
// point -- a source built the 2024 way (16 bytes) takes the server down inside Mob::_hurt.
function buildSource(): ActorDamageSource {
    return ActorDamageSource.create(sourceCause);
}

if (evs.size !== 0)
    events.command.on(cmd => {
        const c = cmd.replace(/^\//, "").trim();
        if (c !== "sigprobe" && !c.startsWith("sigprobe ")) return;
        const arg = c.slice("sigprobe".length).trim();
        try {
            if (arg.startsWith("arm")) {
                armKind = arg.slice(3).trim() || null;
                victimId = null;
                victimKind = "";
                sourceVft = null;
                sawHurtParams = false;
                console.log(`[sigprobe] INFO arm: capturing only ${armKind ?? "(anything)"}`);
            } else if (arg === "capture") {
                const rva = sourceVft === null ? -1 : sourceVft.subptr(dllraw.current);
                // the table's ??_7ActorDamageSource@@6B@ has to be the vptr BDS's own plain source
                // carries, or bdsx's ActorDamageSource.create builds something else entirely
                const tableVft = ACTOR_DAMAGE_SOURCE_VFTABLE in proc ? proc[ACTOR_DAMAGE_SOURCE_VFTABLE] : null;
                const same = tableVft !== null && sourceVft !== null && tableVft.equalsptr(sourceVft);
                verdict(
                    "capture",
                    sourceVft !== null && victimId !== null && same,
                    `victim ${victimKind || "(none)"}, live source vftable rva 0x${rva.toString(16)} (table ${tableVft === null ? "LACKS it" : same ? "same" : "DIFFERENT: " + tableVft}) cause ${sourceCause}, live source ${hex(
                        sourceBytes,
                        32,
                    )}, BDS HurtEffectsSettings ${sawHurtParams ? hex(seenHurtParams, 24) : "(none)"}`,
                );
            } else if (arg === "knock") {
                const mob = liveVictim();
                if (mob === null || !(mob instanceof Mob)) {
                    verdict("Mob.knockback", false, `no live captured mob (${victimKind || "none"})`);
                    return;
                }
                sawKnockParams = false;
                const before = knockbacks;
                // the 2024 JS signature -- the three trailing floats must come back out of the
                // struct the hook reads, which is the whole point of the change
                mob.knockback(null, 1, 0.6, 0.6, 0.55, 0.45, 0.35);
                const p = sawKnockParams ? [seenKnockParams.getFloat32(0), seenKnockParams.getFloat32(4), seenKnockParams.getFloat32(8), seenKnockParams.getFloat32(12)] : null;
                const ok = p !== null && Math.abs(p[0] - 0.55) < 1e-6 && Math.abs(p[1] - 0.45) < 1e-6 && Math.abs(p[2] - 0.35) < 1e-6;
                verdict(
                    "Mob.knockback",
                    ok,
                    p === null
                        ? `${victimKind}: the hook saw no KnockbackParameters (entityKnockback fires ${before} -> ${knockbacks})`
                        : `${victimKind}: hook saw power ${p[0]} height ${p[1]} cap ${p[2]} slowdown ${p[3]} (entityKnockback fires ${before} -> ${knockbacks})`,
                );
            } else if (arg === "hurtraw" || arg === "hurt") {
                const mob = liveVictim();
                if (mob === null) {
                    verdict(`Actor.${arg}`, false, `no live captured mob (${victimKind || "none"})`);
                    return;
                }
                if (sourceVft === null) {
                    verdict(`Actor.${arg}`, false, "no ActorDamageSource template captured");
                    return;
                }
                const src = buildSource();
                const before = hurts;
                const hp = mob.getHealth();
                console.log(`[sigprobe] INFO source: ${hex(src as any, 48)}`);
                if (arg === "hurtraw") {
                    // Mob::_hurt on its own, with the result buffer in our hands: Actor::hurt reads
                    // the variant index the callee leaves at +4 and throws bad_variant_access (an
                    // int3, exit 0x80000003) on anything but 0 or 1, so what is written there is the
                    // first thing to look at. Run once with HurtEffectsSettings.receive_damage
                    // false (what bdsx used to pass) and once with it true (what BDS passes).
                    const hurt = procHacker.js("bdsx:Mob::_hurt", StaticPointer, { this: Mob }, StaticPointer, ActorDamageSource, float32_t, StaticPointer);
                    for (const receive of [false, true]) {
                        const result = new AllocatedPointer(16);
                        result.fill(0, 16);
                        const params = new AllocatedPointer(24);
                        params.fill(0, 24);
                        params.setBoolean(true, 0);
                        params.setBoolean(receive, 2);
                        const h0 = liveVictim()?.getHealth() ?? -1;
                        const ret = hurt.call(mob as any, result, src, 3, params);
                        const after = liveVictim();
                        console.log(
                            `[sigprobe] INFO Mob._hurt raw receive_damage=${receive}: returned ${ret}, result ${hex(result, 16)}, health ${h0} -> ${after === null ? -1 : after.getHealth()}`,
                        );
                    }
                    return;
                }
                const got = mob.hurt(src, 3, true, false);
                const after = liveVictim();
                const hp2 = after === null ? -1 : after.getHealth();
                verdict("Actor.hurt", hurts > before && hp2 < hp, `${victimKind} cause ${sourceCause}: returned ${got}, health ${hp} -> ${hp2} (entityHurt fires ${before} -> ${hurts})`);
            } else if (arg === "attack") {
                // The direct-call half of the attack check (docs/findings-audit.md "attack"): call
                // through "bdsx:Actor::attack" the way BDS's own vtable slot 52 dispatch would --
                // this=the bot's Player, hidden sret, the armed victim, ActorDamageCause.EntityAttack --
                // and see the hook we installed above actually run (fires increments) and the victim
                // take damage, not just that the boot survived with the hook idle.
                const victim = liveVictim();
                if (victim === null) {
                    verdict("Actor.attack", false, `no live captured mob (${victimKind || "none"})`);
                    return;
                }
                if (attackPlayer === null) {
                    verdict("Actor.attack", false, "no player captured (playerJoin never fired)");
                    return;
                }
                const before = counts["playerAttack"] ?? 0;
                const hp = victim.getHealth();
                // diagnostic only: the body gates on the attacker's AttackMobs/AttackPlayers ability
                // (0x21f0a0 in 1.26.40.8 is an AbilitiesComponent lookup, canUseAbility's own EnTT
                // shape -- component hash 0x68b75d48 = AbilitiesComponent), one of the checks a
                // console-only bot may still be failing while it sits in the loading-screen layer
                // (docs/findings-abilities.md).
                let abilities = "?";
                try {
                    abilities = `attackPlayers=${attackPlayer.getAbilities().getBool(AbilitiesIndex.AttackPlayers)} attackMobs=${attackPlayer
                        .getAbilities()
                        .getBool(AbilitiesIndex.AttackMobs)}`;
                } catch (err) {
                    abilities = `threw ${(err as Error).message}`;
                }
                console.log(`[sigprobe] INFO attacker abilities: ${abilities}`);
                const causeBuf = new AllocatedPointer(4);
                causeBuf.setInt32(ActorDamageCause.EntityAttack, 0);
                const result = new AllocatedPointer(16);
                result.fill(0, 16);
                const attack = procHacker.js("bdsx:Actor::attack", StaticPointer, { this: Player }, StaticPointer, Actor, StaticPointer);
                const ret = attack.call(attackPlayer, result, victim, causeBuf);
                const after = liveVictim();
                const hp2 = after === null ? -1 : after.getHealth();
                const fires = counts["playerAttack"] ?? 0;
                verdict(
                    "Actor.attack",
                    fires > before,
                    `${victimKind}: returned ${ret === null ? "null" : result.equalsptr(ret) ? "echoed result ptr" : "OTHER ptr"}, result ${hex(result, 16)}, health ${hp} -> ${hp2} (playerAttack fires ${before} -> ${fires})`,
                );
            } else if (arg === "dropall") {
                // Only arms the check -- the actual `dropAllOnDeath` call is made from
                // events.levelTick above, not from this console callback.
                if (dropallPlayer === null) {
                    verdict("dropAllOnDeath", false, "no player captured (playerJoin never fired)");
                    return;
                }
                const before = summarizeInventory();
                dropallArmed = { before };
                console.log(`[sigprobe] INFO dropall: armed, inventory before: ${before}`);
            } else {
                for (const [k, key] of SUMMARY) {
                    if (!evs.has(key)) continue;
                    // levelSave fires during the driven stop, after the last console command, so a
                    // summary taken here can only report what it has seen so far
                    if (key === "save") console.log(`[sigprobe] INFO levelSave: ${counts[k] ?? 0} fires before shutdown`);
                    // playerDropItem needs a client to send InventoryTransaction (Q7); a
                    // console-only session cannot make that happen, so 0 fires here is an
                    // install-only check (INFO), not a failure. A human session that actually
                    // drops an item should see this line turn into a PASS.
                    else if (key === "drop") {
                        const n = counts[k] ?? 0;
                        if (n > 0) verdict(k, true, `${n} fires`);
                        else console.log(`[sigprobe] INFO playerDropItem: 0 fires (needs a real client, Q7 -- hook install is the check here)`);
                    }
                    else verdict(k, (counts[k] ?? 0) > 0, `${counts[k] ?? 0} fires`);
                }
            }
        } catch (err) {
            verdict(arg === "" ? "summary" : arg, false, `threw ${(err as Error).message}`);
        }
    });

// ---------------------------------------------------------------------------------------------
// Q3 audit follow-ups (docs/findings-audit.md "Audit follow-ups", 2026-09-27). SIG_EVENTS=child:
//  - entityHurt from an arrow: the resolver must give ActorDamageByChildActorSource (its vftable now ships),
//    getDamagingEntity() the shooter (BDS's slot 12, +0x40) and getChildEntityUniqueId() the arrow
//    (layouts.ActorDamageByChildActorSource.childId, +0x78 on 1.26; 2024 read +0x58). The arrow's
//    getOwner() (derived over getOwnerId) must be the shooter.
//  - entityHurt from a melee mob: ActorDamageByActorSource, getDamagingEntity() the attacker; from magma:
//    ActorDamageByBlockSource, its block (layouts.ActorDamageByBlockSource.block, +0x30 on 1.26) magma.
//  - constructWith for both classes (engine constructors, sizes from layouts), read back, destructed.
//  - `sigprobe audit`: the player's getOwner() is null, setVariant (derived over SynchedActorData) reads back
//    through BDS's getVariant, and ChunkSource.isWithinWorldLimit resolves its slot through the corrected
//    ??_7WorldLimitChunkSource@@6B@.
let auditPlayer: Player | null = null;
if (evs.has("child")) {
    events.playerJoin.on(ev => {
        auditPlayer = ev.player;
    });
    let childHits = 0;
    let actorHits = 0;
    let blockHits = 0;
    let builtChild = false;
    let builtActor = false;
    const hexId = (v: string): string => `0x${bin.toString(v, 16)}`;
    const idOf = (a: Actor | null): string => (a === null ? "null" : hexId(a.getUniqueIdBin()));
    const vftRva = (p: StaticPointer): string => `0x${p.getPointer(0).subptr(dllraw.current).toString(16)}`;
    events.entityHurt.on(ev => {
        try {
            const src = ev.damageSource;
            const victim = name(ev.entity);
            if (src.isChildEntitySource()) {
                if (childHits++ >= 4) return;
                const shooter = src.getDamagingEntity();
                const childId = src.getChildEntityUniqueId();
                const child = Actor.fromUniqueIdBin(childId);
                const owner = child === null ? null : child.getOwner();
                const shooterName = shooter === null ? "null" : name(shooter);
                const childName = child === null ? "null" : name(child);
                const ownerSame = owner !== null && shooter !== null && idOf(owner) === idOf(shooter);
                verdict(
                    "childSource",
                    shooterName === "minecraft:skeleton" && childName === "minecraft:arrow" && ownerSame,
                    `${victim} cause ${src.cause} vft ${vftRva(src as any)}: getDamagingEntity ${shooterName} (${idOf(shooter)}), getChildEntityUniqueId ${hexId(childId)} -> ${childName}, child.getOwner ${owner === null ? "null" : name(owner)} (${idOf(owner)}) same as shooter ${ownerSame}`,
                );
                if (!builtChild && shooter !== null && child !== null) {
                    builtChild = true;
                    const s = ActorDamageByChildActorSource.constructWith(child, shooter, ActorDamageCause.Projectile);
                    const vftOk = (s as unknown as StaticPointer).getPointer(0).equalsptr(proc["??_7ActorDamageByChildActorSource@@6B@"]);
                    const got = `vft ${vftRva(s as any)} (table's ${vftOk}), cause ${s.cause}, getChildEntityUniqueId ${hexId(s.getChildEntityUniqueId())} (arrow ${idOf(child)}), getDamagingEntityUniqueID ${hexId(s.getDamagingEntityUniqueID())} (shooter ${idOf(shooter)})`;
                    const ok = vftOk && hexId(s.getChildEntityUniqueId()) === idOf(child) && hexId(s.getDamagingEntityUniqueID()) === idOf(shooter);
                    s.destruct();
                    verdict("childConstructWith", ok, got);
                }
            } else if (src.isBlockSource()) {
                if (blockHits++ >= 3) return;
                const b = src.block;
                const bn = b === null ? "null" : b.getName();
                verdict("blockSource", bn === "minecraft:magma", `${victim} cause ${src.cause} vft ${vftRva(src as any)}: block ${bn}`);
            } else if (src.isEntitySource()) {
                if (actorHits++ >= 3) return;
                const d = src.getDamagingEntity();
                verdict("actorSource", d !== null && !src.isChildEntitySource(), `${victim} cause ${src.cause} vft ${vftRva(src as any)}: getDamagingEntity ${d === null ? "null" : name(d)}`);
                if (!builtActor && d !== null) {
                    builtActor = true;
                    const s = ActorDamageByActorSource.constructWith(d, ActorDamageCause.EntityAttack);
                    const vftOk = (s as unknown as StaticPointer).getPointer(0).equalsptr(proc["??_7ActorDamageByActorSource@@6B@"]);
                    const got = `vft ${vftRva(s as any)} (table's ${vftOk}), cause ${s.cause}, getDamagingEntityUniqueID ${hexId(s.getDamagingEntityUniqueID())} (attacker ${idOf(d)})`;
                    const ok = vftOk && hexId(s.getDamagingEntityUniqueID()) === idOf(d);
                    s.destruct();
                    verdict("actorConstructWith", ok, got);
                }
            }
        } catch (err) {
            verdict("damageSource", false, `threw ${(err as Error).message}`);
        }
    });
    events.command.on(cmd => {
        const c = cmd.replace(/^\//, "").trim();
        if (c !== "sigprobe audit") return;
        const p = auditPlayer;
        if (p === null) {
            verdict("audit", false, "(no player)");
            return;
        }
        try {
            const owner = p.getOwner();
            verdict("getOwner", owner === null, `the player's owner ${owner === null ? "null" : name(owner)}`);
        } catch (err) {
            verdict("getOwner", false, `threw ${(err as Error).message}`);
        }
        try {
            const v0 = p.getVariant();
            p.setVariant(v0 + 3);
            const v1 = p.getVariant();
            p.setVariant(v0);
            const v2 = p.getVariant();
            verdict("setVariant", v1 === v0 + 3 && v2 === v0, `getVariant ${v0} -> setVariant(${v0 + 3}) -> ${v1} -> setVariant(${v0}) -> ${v2}`);
        } catch (err) {
            verdict("setVariant", false, `threw ${(err as Error).message}`);
        }
        try {
            const cs = p.getDimension().getChunkSource();
            const at = BlockPos.create(p.getPosition());
            const pos = ChunkPos.create(at.x >> 4, at.z >> 4);
            const table = proc["??_7WorldLimitChunkSource@@6B@"];
            const r = cs.isWithinWorldLimit(pos);
            console.log(
                `[sigprobe] INFO isWithinWorldLimit: chunk (${pos.x}, ${pos.z}) -> ${r}; the dimension's chunk source vft ${vftRva(cs as any)}, ??_7WorldLimitChunkSource@@6B@ 0x${table.subptr(dllraw.current).toString(16)}`,
            );
        } catch (err) {
            verdict("isWithinWorldLimit", false, `threw ${(err as Error).message}`);
        }
    });
}

for (const n of [
    "?knockback@Mob@@UEAAXPEAVActor@@MMMAEBUKnockbackParameters@@@Z",
    "?startSleepInBed@Player@@UEAA?AW4BedSleepingResult@@AEBVBlockPos@@_NM@Z",
    "?changeDimension@ServerPlayer@@UEAAXUDimensionType@@@Z",
    "?addLevels@Player@@UEAAXH@Z",
    "?die@Mob@@UEAAXAEBVActorDamageSource@@@Z",
    "?take@Player@@QEAA_NAEAVActor@@HH@Z",
    "?save@Level@@UEAAXXZ",
    "?consumeTotem@Actor@@UEAA_NXZ",
])
    say("table", `${n in proc ? "has" : "LACKS"} ${n}`);
console.log(`[sigprobe] loaded (SIG_EVENTS=${[...evs].join(",")})`);
