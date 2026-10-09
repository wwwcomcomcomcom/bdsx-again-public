// Execution check for the constructor bdsx carries itself because the 1.26
// builds inline it everywhere: ActorCommandOrigin(Actor&), and the UUID
// generator it needs (docs/findings-instances.md, "Constructors from held
// tables"). Deployed beside example_and_test as zz-originprobe.ts and driven
// by a client sending `/originprobe` (tools/livebot.cjs, BP_COMMAND), so
// the command's own origin hands over a live actor.
import { Actor } from "bdsx/bds/actor";
import { ActorCommandOrigin, CommandOriginType } from "bdsx/bds/commandorigin";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { mce } from "bdsx/mce";
function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[origin] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
function attempt(label: string, f: () => [boolean, string]): void {
    try {
        const [ok, detail] = f();
        say(label, ok, detail);
    } catch (err) {
        say(label, false, `threw ${(err as Error).message}`);
    }
}
function check(actor: Actor, how: string): void {
    say("actor", null, `${how}: ${actor}`);
    const origin = ActorCommandOrigin.allocateWith(actor);
    attempt("getEntity", () => { const e = origin.getEntity(); return [e !== null && e.equalsptr(actor), `${e} for actor ${actor}`]; });
    attempt("getLevel", () => { const l = origin.getLevel(); return [l !== null && l.equalsptr(bedrockServer.level), `${l} (level ${bedrockServer.level})`]; });
    attempt("getDimension", () => { const d = origin.getDimension(); const ad = actor.getDimension(); return [d !== null && d.equalsptr(ad), `${d} (actor's ${ad})`]; });
    attempt("getOriginType", () => { const t = origin.getOriginType(); return [t === CommandOriginType.Entity, `${t} (Entity is ${CommandOriginType.Entity})`]; });
    attempt("getName", () => { const n = origin.getName(); return [n === actor.getName(), `"${n}" (actor "${actor.getName()}")`]; });
    attempt("uuid", () => [!/^\0*$/.test(origin.uuid), mce.UUID.toString(origin.uuid)]);
    attempt("entityId", () => [origin.entityId === actor.getUniqueIdBin(), `${actor.getUniqueIdLow()}/${actor.getUniqueIdHigh()}`]);
    // Q5-5: Player.getUuid()/getCertificate() go through UserEntityIdentifierComponent
    // (bds/implements.ts), whose uuid/certificate offsets were still 2024's (+0xa8/+0xd8) until now.
    // This is a *different* uuid from the one just above -- ActorCommandOrigin's is a fresh
    // mce::UUID::generate() with no relation to player identity. There is no other in-process oracle
    // for a player's real uuid, so PASS here only means "not all zero, did not throw"; the actual
    // confirmation is comparing the printed string against the uuid the bot itself decodes off BDS's
    // own player_list packet at join (tools/livebot.cjs logs `player_list`) -- the same
    // cross-process witness docs/findings-containers.md 14 used for the identical +184 offset, read
    // there from ??0PlayerListEntry@@QEAA@AEBVPlayer@@@Z rather than from this class (note:
    // mce.UUID.toString's byte order does not match the client's -- compare reversed).
    if (actor.isPlayer()) {
        const player = actor;
        attempt("getUuid", () => [!/^\0*$/.test(player.getUuid()), mce.UUID.toString(player.getUuid())]);
        attempt("getXuid", () => {
            const x = player.getXuid();
            return [true, x.length === 0 ? "(empty -- offline/unauthenticated bot, expected)" : x];
        });
        // 1.26 keeps no Certificate object behind a player (the component holds the auth info by
        // value now, not a pointer to one) -- null, not a garbage-pointer read, is the correct value.
        attempt("getCertificate", () => {
            const c = player.getCertificate();
            return [c === null, `${c}`];
        });
    }
    say("done", null, "ActorCommandOrigin checks finished");
}
events.command.on((cmd, originName, ctx) => {
    if (cmd.replace(/^\//, "") !== "originprobe") return;
    attempt("UUID::generate", () => {
        const a = mce.UUID.generate(), b = mce.UUID.generate();
        return [a !== b && a.length === 8, `${mce.UUID.toString(a)} and ${mce.UUID.toString(b)}`];
    });
    const actor = ctx.origin.getEntity();
    if (actor === null) {
        say("ActorCommandOrigin", null, `the origin "${originName}" has no entity; send /originprobe from a client, or kill @a (the respawn hook runs the same checks)`);
        return;
    }
    check(actor, "the command's origin");
});
// Player::respawn is execution-confirmed and hooked by bdsx, so `kill @a`
// on a joined client hands over a live ServerPlayer without any client-side
// command support
// and playerJoin, which on 1.26 hooks the SetLocalPlayerAsInitialized packet
// handler and finds the player through ServerNetworkHandler::_getServerPlayer
events.playerJoin.on(ev => {
    check(ev.player, "playerJoin");
});
// playerLeft hooks ServerNetworkHandler::_onPlayerLeft, one hop below the
// disconnect handler; the bot's disconnect is what fires it
events.playerLeft.on(ev => {
    say("playerLeft", ev.player !== null, `${ev.player} (${(ev as any).skipMessage})`);
});
let respawns = 0;
events.playerRespawn.on(ev => {
    if (respawns++ > 0) return;
    check(ev.player, "playerRespawn");
});
console.log("[origin] loaded");
