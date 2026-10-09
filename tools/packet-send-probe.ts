// Execution check for the send side of Q5-2 (docs/next-steps.md, docs/findings-packets.md 7): the
// 1.26 packetSendRaw rides on BatchedNetworkPeer::sendPacket -- the send-side mirror of the raw
// receive hook on BatchedNetworkPeer::_receivePacket (bdsx/event_impl/packetevent.ts, installSendRaw).
// Deployed as zz-pksprobe.ts; nothing is armed until the console says so:
//   "pksprobe arm"       packetSendRaw + packetSend listeners on Text
//   "pksprobe sendtext"  Player.sendChat("bdsxsendrawpass1", ...) -- uncancelled, must reach the bot
//   "pksprobe cancel"    Player.sendChat("bdsxsendrawcut2", ...) -- packetSendRaw cancels this one
//   "pksprobe report"    the checks
//   "pksprobe disarm"    removes every listener
//   "pksprobe kick"      ServerInstance.disconnectClient(bot, "bdsxkick5") -- queue row 1 (docs/findings-packets.md
//                        "Kick"): the bot's .bot.log must show "disconnected" with message bdsxkick5, and
//                        playerLeft must fire for the kicked player (printed as [pksprobe] PASS left-after-kick)
//   "pksprobe addr"      the player's IP and ping (docs/findings-packets.md "IP and ping"): NetworkIdentifier.getAddress()
//                        must be "127.0.0.1|<port>" for the bot on the same host, RakPeer's three pings must be in
//                        [0, 1000), and an unknown GUID must give UNASSIGNED_SYSTEM_ADDRESS and -1 (the other side)
// A third marker, "bdsxbroadcast", is not sent by this file at all -- the driver issues a plain
// console "say bdsxbroadcast3" between arm and report. That is BDS's own broadcast path (distinct
// from any single-target Player.sendChat), and the question this half of Q5-2 asks is whether it
// converges on the same NetworkSystem::send / BatchedNetworkPeer::sendPacket pipeline this build
// already hooks, since 1.26 has neither LoopbackPacketSender::sendToClients nor
// NetworkSystem::_sendInternal as separate addresses to hook the way 2024 did.
// The witness is the bot: livebot.cjs's "text" logger shows what actually arrived, so a
// line cancelled here is simply missing from .bot.log while an uncancelled one is there.
import { MinecraftPacketIds } from "bdsx/bds/packetids";
import { Player } from "bdsx/bds/player";
import { bedrockServer } from "bdsx/launcher";
import { CANCEL } from "bdsx/common";
import { events } from "bdsx/event";
import { packetSendRawOffThread } from "bdsx/event_impl/packetevent";
import { NetworkIdentifierType } from "bdsx/bds/networkidentifier";
import { RakNet } from "bdsx/bds/raknet";
import { bin } from "bdsx/bin";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[pksprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
let kickedName: string | null = null;
events.playerLeft.on(ev => {
    if (kickedName !== null) {
        const name = ev.player !== null ? ev.player.getNameTag() : "(null)";
        say("left-after-kick", name === kickedName, `playerLeft fired for ${name} after the kick of ${kickedName} (skipMessage=${ev.skipMessage})`);
        kickedName = null;
    }
    player = null;
});

let armed = false;
const rawLog: string[] = []; // markers seen by packetSendRaw, in order
let rawCount = 0,
    rawSameNi = 0;
let sendTextCount = 0; // packetSend(Text) hits -- the pre-existing NetworkSystem::send hook
let sendBroadcastSeen = false; // packetSend(Text) fired while the broadcast marker was in the raw payload
let rawSendListener: ((...args: any[]) => any) | null = null;
let sendListener: ((...args: any[]) => any) | null = null;

const MARKERS = ["bdsxsendrawpass1", "bdsxsendrawcut2", "bdsxbroadcast3"];
function markerOf(text: string): string {
    return MARKERS.find(m => text.includes(m)) ?? "?";
}

function arm(): void {
    if (armed) return;
    rawSendListener = (ptr, size, ni, id) => {
        rawCount++;
        if (player !== null && player.getNetworkIdentifier() === ni) rawSameNi++;
        const text = String.fromCharCode(...(ptr.getBuffer(size, 0) as Uint8Array));
        const msg = markerOf(text);
        rawLog.push(msg);
        if (msg === "bdsxbroadcast3" && sendTextCount > 0) sendBroadcastSeen = true;
        if (msg === "bdsxsendrawcut2") return CANCEL;
    };
    events.packetSendRaw(MinecraftPacketIds.Text).on(rawSendListener);
    sendListener = () => {
        sendTextCount++;
    };
    events.packetSend(MinecraftPacketIds.Text).on(sendListener);
    armed = true;
    say("arm", null, "packetSendRaw + packetSend listeners installed on Text");
}

function disarm(): void {
    if (!armed) return;
    if (rawSendListener !== null) events.packetSendRaw(MinecraftPacketIds.Text).remove(rawSendListener);
    if (sendListener !== null) events.packetSend(MinecraftPacketIds.Text).remove(sendListener);
    rawSendListener = null;
    sendListener = null;
    armed = false;
    say("disarm", null, "listeners removed");
}

events.command.on(cmd => {
    const m = /^\/?pksprobe(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    const arg = m[1] ?? "report";
    if (arg === "arm") {
        arm();
        return;
    }
    if (arg === "disarm") {
        disarm();
        return;
    }
    if (arg === "sendtext") {
        if (player === null) return say("sendtext", false, "no player");
        player.sendChat("bdsxsendrawpass1", "bdsx");
        say("sendtext", null, 'sent via Player.sendChat("bdsxsendrawpass1", "bdsx"); not cancelled, should reach the bot');
        return;
    }
    if (arg === "cancel") {
        if (player === null) return say("cancel", false, "no player");
        player.sendChat("bdsxsendrawcut2", "bdsx");
        say("cancel", null, 'sent via Player.sendChat("bdsxsendrawcut2", "bdsx"); packetSendRaw cancels this one -- must not reach the bot');
        return;
    }
    if (arg === "kick") {
        if (player === null) return say("kick", false, "no player");
        kickedName = player.getNameTag();
        bedrockServer.serverInstance.disconnectClient(player.getNetworkIdentifier(), "bdsxkick5");
        say("kick", null, `ServerInstance.disconnectClient(${kickedName}, "bdsxkick5") returned; .bot.log must show the message`);
        return;
    }
    if (arg === "addr") {
        if (player === null) return say("addr", false, "no player");
        const ni = player.getNetworkIdentifier();
        const peer = bedrockServer.rakPeer;
        const guid = ni.address.rakNetGuid;
        say("addr-type", ni.type === NetworkIdentifierType.RakNet, `NetworkIdentifier type ${ni.type} (0 = RakNet), guid ${bin.toString(guid.g, 16)}`);
        const text = ni.getAddress();
        say("addr", /^127\.0\.0\.1\|\d+$/.test(text), `getAddress() = "${text}"`);
        const sa = peer.GetSystemAddressFromGuid(guid);
        const buf = Buffer.alloc(128);
        sa.ToString(false, buf, "|".charCodeAt(0));
        const ipOnly = buf.subarray(0, buf.indexOf(0)).toString();
        say("addr-noport", ipOnly === "127.0.0.1", `SystemAddress.ToString(false) = "${ipOnly}", systemIndex ${sa.systemIndex}`);
        const avg = peer.GetAveragePing(ni.address);
        const last = peer.GetLastPing(ni.address);
        const low = peer.GetLowestPing(ni.address);
        const ok = (v: number): boolean => v >= 0 && v < 1000;
        say("ping", ok(avg) && ok(last) && ok(low) && low <= avg && low <= last, `average ${avg} ms, last ${last} ms, lowest ${low} ms`);
        // the other side: a GUID no connection has
        const other = new RakNet.AddressOrGUID(true);
        other.rakNetGuid.g = bin.make64(0x12345, 0x6789);
        other.rakNetGuid.systemIndex = 0xffff;
        const unknownAddr = peer.GetSystemAddressFromGuid(other.rakNetGuid).toString();
        say("addr-unknown", unknownAddr === "UNASSIGNED_SYSTEM_ADDRESS", `GetSystemAddressFromGuid(unknown) = "${unknownAddr}"`);
        const unknownPing = peer.GetAveragePing(other);
        say("ping-unknown", unknownPing === -1, `GetAveragePing(unknown) = ${unknownPing}`);
        return;
    }
    if (arg === "report") {
        say("raw-seen", rawCount > 0, `packetSendRaw fired ${rawCount} times, markers: ${rawLog.join(",") || "(none)"}`);
        say("raw-identity", rawCount === 0 || rawSameNi === rawCount, `packetSendRaw got the player's own NetworkIdentifier ${rawSameNi} of ${rawCount} times`);
        say(
            "pass-seen",
            rawLog.includes("bdsxsendrawpass1"),
            "the uncancelled marker reached packetSendRaw (check .bot.log directly for whether it also reached the bot)",
        );
        say(
            "cancel-not-forwarded",
            rawLog.includes("bdsxsendrawcut2"),
            "the cancelled marker reached packetSendRaw and was told to cancel (check .bot.log: it must be absent there)",
        );
        say("send-text-count", null, `packetSend(Text) fired ${sendTextCount} times total (pre-existing NetworkSystem::send hook)`);
        say(
            "broadcast-seen-raw",
            rawLog.includes("bdsxbroadcast3"),
            "the console's own 'say bdsxbroadcast3' broadcast reached packetSendRaw -- BatchedNetworkPeer::sendPacket is downstream of the broadcast path too",
        );
        say(
            "broadcast-seen-send",
            sendBroadcastSeen,
            "packetSend(Text) also fired while/after the broadcast marker was seen raw -- NetworkSystem::send is on the broadcast path in this build (single bot: multiplicity not measurable)",
        );
        say("raw-off-thread", null, `sends that came from another thread: ${packetSendRawOffThread.getInt32(0)}`);
        return;
    }
});
