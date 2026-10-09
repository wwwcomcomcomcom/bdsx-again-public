// Execution check for the receive-side packet events on 1.26 (docs/next-steps.md Q5,
// docs/findings-packets.md): packetBefore / packetAfter now ride on each packet type's static
// IPacketHandlerDispatcher (bdsx/event_impl/packetevent.ts, installPacketDispatchers). Deployed as
// zz-pktprobe.ts; nothing is registered until the console says so:
//   "pkprobe arm"      before+after listeners on every packet id (counts, order), and on Text:
//                      a chat line containing "bdsxcancel" is cancelled in packetBefore
//   "pkprobe form"     bdsx's public Form API sends a modal form; the bot (BP_FORM_REPLY) answers
//                      and form.ts resolves it from packetAfter(ModalFormResponse)
//   "pkprobe sendtext" bdsx's public Player.sendChat() builds a TextPacket (1.26 variant layout,
//                      Q5-3, docs/findings-packets.md) and sends it to the bot; the bot's own
//                      "text" logger (livebot.cjs) shows it arrived
//   "pkprobe report"   the checks
//   "pkprobe disarm"   removes every listener; "pkprobe after-disarm" then checks nothing arrives
// The witness for cancel is BDS itself: a chat line BDS handled is echoed back to the bot
// (livebot.cjs logs it as "text"), a cancelled one is not -- read the .bot.log. The witness for
// sendtext is the same bot log, read the other direction.
import { Form } from "bdsx/bds/form";
import { NetworkIdentifier } from "bdsx/bds/networkidentifier";
import { MinecraftPacketIds } from "bdsx/bds/packetids";
import { PlayerAuthInputPacket, TextPacket } from "bdsx/bds/packets";
import { Player } from "bdsx/bds/player";
import { CANCEL } from "bdsx/common";
import { PACKET_ID_COUNT } from "bdsx/const";
import { events } from "bdsx/event";
import { packetRawOffThread } from "bdsx/event_impl/packetevent";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[pktprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

// Q5-3 second half: PlayerAuthInputPacket's input_data bitset moved to packet+0x88 in 1.26
// (docs/findings-packets.md 10절); getInput() now reads it directly instead of calling a native
// function that no longer exists. Both checks below are unconditional (cheap, read-only JS events,
// same as playerJoin/playerLeft above), independent of "pkprobe arm".
const sneakLog: boolean[] = []; // events.entitySneak firings, in order
events.entitySneak.on(ev => {
    sneakLog.push(ev.isSneaking);
});
const authInputBits: string[] = []; // getInput() reads seen on PlayerAuthInput packets, in order
events.packetBefore(MinecraftPacketIds.PlayerAuthInput).on(pk => {
    const p = pk as PlayerAuthInputPacket;
    const seen: string[] = [];
    if (p.getInput(PlayerAuthInputPacket.InputData.StartSneaking)) seen.push("start");
    if (p.getInput(PlayerAuthInputPacket.InputData.StopSneaking)) seen.push("stop");
    if (p.getInput(PlayerAuthInputPacket.InputData.Sneaking)) seen.push("sneaking");
    if (seen.length > 0) authInputBits.push(seen.join("+"));
});

const before = new Map<number, number>();
const after = new Map<number, number>();
const textLog: string[] = []; // "before:<msg>" / "after:<msg>" in the order they fired
let sameNi = 0,
    otherNi = 0;
let armed = false;
let countWhileDisarmed = 0;
const listeners: [MinecraftPacketIds, "b" | "a" | "r", (...a: any[]) => any][] = [];
let rawCount = 0,
    rawSameNi = 0;
let formResult: string | null = null;

// 1.26's TextPacket layout (Q5-3, docs/findings-packets.md, confirmed via the payload destructor on
// both builds): pk.message/pk.name/pk.type now read the real std::variant fields (Endstone
// text_packet.h), so the probe reads the object through the class instead of scanning its raw bytes
// for a marker substring.
const MARKERS = ["bdsxpass1", "bdsxcancel2", "bdsxafter3", "bdsxrawcut4"];
let fieldsOk: { message: boolean; name: boolean; type: boolean; className: boolean } | null = null;
function checkFields(pk: TextPacket, marker: string): void {
    if (fieldsOk !== null || marker === "?") return;
    fieldsOk = {
        message: pk.message === marker,
        name: pk.name === "bdsxprobe", // livebot.cjs's BP_CHAT source_name
        type: pk.type === TextPacket.Types.Chat,
        // Q5-4: Packet::getName() is vft[2]; 1.26 returns std::string_view with no out-of-line symbol to
        // name the slot by (same situation as getId, docs/findings-packets.md 12) -- check it still
        // returns the plain class name.
        className: pk.getName() === "TextPacket",
    };
}
function markerOf(pk: TextPacket): string {
    const msg = pk.message;
    return MARKERS.includes(msg) ? msg : "?";
}

function onAny(map: Map<number, number>) {
    return (pk: any, ni: NetworkIdentifier, id: number) => {
        if (!armed) countWhileDisarmed++;
        map.set(id, (map.get(id) ?? 0) + 1);
        if (player !== null) {
            if (player.getNetworkIdentifier() === ni) sameNi++;
            else otherNi++;
        }
    };
}

function arm(): void {
    if (armed) return;
    const b = onAny(before),
        a = onAny(after);
    for (let id = 0; id < PACKET_ID_COUNT; id++) {
        if (id === MinecraftPacketIds.Text) continue;
        events.packetBefore(id).on(b);
        events.packetAfter(id).on(a);
        listeners.push([id, "b", b], [id, "a", a]);
    }
    const tb = (pk: TextPacket, ni: NetworkIdentifier, id: number) => {
        b(pk, ni, id);
        const msg = markerOf(pk);
        checkFields(pk, msg);
        textLog.push("before:" + msg);
        if (msg.includes("bdsxcancel")) return CANCEL;
    };
    const ta = (pk: TextPacket, ni: NetworkIdentifier, id: number) => {
        a(pk, ni, id);
        checkFields(pk, markerOf(pk));
        textLog.push("after:" + markerOf(pk));
    };
    // packetRaw sees the wire bytes (header varint + payload): the chat text is in them verbatim
    const tr = (ptr: any, size: number, ni: NetworkIdentifier, id: number) => {
        rawCount++;
        if (player !== null && player.getNetworkIdentifier() === ni) rawSameNi++;
        const text = String.fromCharCode(...(ptr.getBuffer(size, 0) as Uint8Array));
        const msg = MARKERS.find(m => text.includes(m)) ?? "?";
        textLog.push("raw:" + msg);
        if (msg === "bdsxrawcut4") return CANCEL;
    };
    events.packetRaw(MinecraftPacketIds.Text).on(tr);
    listeners.push([MinecraftPacketIds.Text, "r", tr]);
    events.packetBefore(MinecraftPacketIds.Text).on(tb);
    events.packetAfter(MinecraftPacketIds.Text).on(ta);
    listeners.push([MinecraftPacketIds.Text, "b", tb], [MinecraftPacketIds.Text, "a", ta]);
    armed = true;
    say("arm", null, `${listeners.length} listeners on ${PACKET_ID_COUNT} ids`);
}

// PK_ARM=1 arms at load, so the login-phase packets (Login, RequestNetworkSettings, ...) are counted too
if (process.env.PK_ARM === "1") arm();

events.command.on(cmd => {
    const m = /^\/?pkprobe(?:\s+(\S+))?\s*$/.exec(cmd);
    if (m === null) return;
    const arg = m[1] ?? "report";
    if (arg === "arm") {
        arm();
        return;
    }
    if (arg === "disarm") {
        for (const [id, kind, fn] of listeners) (kind === "b" ? events.packetBefore(id) : kind === "a" ? events.packetAfter(id) : events.packetRaw(id)).remove(fn as any);
        listeners.length = 0;
        armed = false;
        countWhileDisarmed = 0;
        say("disarm", null, "every listener removed");
        return;
    }
    if (arg === "after-disarm") {
        say("disarm-quiet", countWhileDisarmed === 0, `${countWhileDisarmed} listener calls after every listener was removed`);
        return;
    }
    if (arg === "form") {
        if (player === null) return say("form", false, "no player");
        Form.sendTo(player.getNetworkIdentifier(), { type: "modal", title: "pktprobe", content: "packetAfter check", button1: "yes", button2: "no" }).then(
            res => {
                formResult = JSON.stringify(res);
                say("form-resolved", res === true, `Form.sendTo resolved with ${formResult} (the bot answered true)`);
            },
            err => say("form-resolved", false, `rejected: ${err}`),
        );
        say("form", null, "sent");
        return;
    }
    if (arg === "sendtext") {
        if (player === null) return say("sendtext", false, "no player");
        // Player.sendChat is bdsx's own public API (bds/player.ts): TextPacket.allocate(), set
        // type/name/message, sendNetworkPacket, dispose. Using it (instead of hand-building a
        // packet here) exercises the real call path a plugin would use, including the
        // AuthorAndMessage variant switch the `name` setter does (Q5-3).
        player.sendChat("bdsxsenttext5", "bdsx");
        say("sendtext", null, 'sent via Player.sendChat("bdsxsenttext5", "bdsx") (TextPacket.allocate, 1.26 variant layout, Q5-3); check .bot.log for it');
        return;
    }
    if (arg === "report") {
        const ids = [...before.keys()].sort((x, y) => x - y);
        const describe = (id: number) => `${MinecraftPacketIds[id] ?? id}=${before.get(id)}/${after.get(id) ?? 0}`;
        say("ids", null, `before/after per id: ${ids.map(describe).join(" ")}`);
        say("coverage", ids.length >= (process.env.PK_ARM === "1" ? 6 : 2), `${ids.length} distinct packet ids reached packetBefore`);
        const mismatched = ids.filter(id => id !== MinecraftPacketIds.Text && before.get(id) !== after.get(id));
        say("pairs", ids.length > 0 && mismatched.length === 0, `every uncancelled id has as many afters as befores (mismatched: ${mismatched.map(describe).join(" ") || "none"})`);
        say("identity", sameNi > 0 && otherNi === 0, `listeners got the player's own NetworkIdentifier instance ${sameNi} times, another instance ${otherNi} times`);
        say("text", null, textLog.join(" | ") || "(no Text packet)");
        say(
            "field-message",
            fieldsOk?.message ?? false,
            fieldsOk === null ? "no recognized Text packet reached packetBefore/After" : "pk.message read back exactly (1.26 variant layout, +0xa8/+0xc8 by index)",
        );
        say("field-name", fieldsOk?.name ?? false, `pk.name (variant index 1, +0xa8) read the bot's BP_CHAT source_name "bdsxprobe"`);
        say("field-type", fieldsOk?.type ?? false, "pk.type (+0xa0) read TextPacket.Types.Chat");
        say(
            "field-classname",
            fieldsOk?.className ?? false,
            fieldsOk === null
                ? "no recognized Text packet reached packetBefore/After"
                : 'pk.getName() (vft[2], Q5-4) read "TextPacket" (std::string_view return via CxxStringView)',
        );
        const pass = textLog.find(t => t.startsWith("before:") && t.includes("bdsxpass"));
        const passMsg = pass?.slice("before:".length);
        const bi = textLog.indexOf("before:" + passMsg),
            ai = textLog.indexOf("after:" + passMsg);
        say("text-order", pass !== undefined && bi >= 0 && ai > bi, `a passed chat line fires before, then after (before #${bi}, after #${ai})`);
        const cancelled = textLog.find(t => t.startsWith("before:") && t.includes("bdsxcancel"));
        const cmsg = cancelled?.slice("before:".length);
        say(
            "text-cancel",
            cancelled !== undefined && !textLog.includes("after:" + cmsg),
            `a chat line cancelled in packetBefore never reaches packetAfter (${cmsg ?? "not seen"}); BDS's echo is in the .bot.log`,
        );
        const ri = textLog.indexOf("raw:" + passMsg);
        say("raw-order", ri >= 0 && bi > ri && ai > bi, `a passed chat line fires raw, then before, then after (raw #${ri}, before #${bi}, after #${ai})`);
        say(
            "raw-cancel",
            textLog.includes("raw:bdsxrawcut4") && !textLog.includes("before:bdsxrawcut4") && !textLog.includes("after:bdsxrawcut4"),
            "a chat line cancelled in packetRaw never reaches packetBefore or packetAfter; BDS's echo is in the .bot.log",
        );
        say("raw-identity", rawCount > 0 && rawSameNi === rawCount, `packetRaw got the player's own NetworkIdentifier instance ${rawSameNi} of ${rawCount} times`);
        say("raw-thread", null, `receives that came from another thread: ${packetRawOffThread.getInt32(0)}`);
        say("form-state", formResult !== null, `Form result ${formResult ?? "never resolved"}`);
        say("authinput-bits", authInputBits.length > 0, `getInput() saw: ${authInputBits.join(", ") || "none"} (packet+0x88, Q5-3)`);
        say("entitySneak", sneakLog.length > 0, `entitySneak fired: ${sneakLog.map(x => (x ? "true" : "false")).join(",") || "none"} (needs BP_AUTH_INPUT=1 on the bot)`);
        if (player !== null) {
            const own = player.getNetworkIdentifier();
            const back = own.getActor();
            say("ni-roundtrip", back !== null && back.equalsptr(player), `the NetworkIdentifier bdsx reads from UserEntityIdentifierComponent resolves back to the player`);
        }
        return;
    }
});
