// Execution check for the Endstone-slot families added on 2026-09-17
// (scoreboard, commandorigin, connector; tools/endstone-slots.mjs).
//
// Deployed as a bdsx example plugin (<lab>\inst40\example_and_test\) and
// driven from the console by tools/run-full.ps1 -Commands: the server's own
// console hands a ServerCommandOrigin to MinecraftCommands::executeCommand,
// which bdsx hooks for events.command (command.register needs findCommand,
// which the table does not have, so the probe is not a registered command
// and must be imported ahead of example_and_test, whose imports throw early),
// the connector and the
// peer are bedrockServer fields, and the ServerScoreboard is the member of
// CommandRegistry at +0x48 (the instance probe's member scan, 1.26.40.8).
// Every line is tagged [slotprobe] and states the expectation it checks.
import { RakNet } from "bdsx/bds/raknet";
import { RakNetConnector } from "bdsx/bds/raknetinstance";
import { DisplaySlot, Scoreboard } from "bdsx/bds/scoreboard";
import { proc } from "bdsx/bds/symbols";
import { events } from "bdsx/event";
import { StaticPointer } from "bdsx/core";
import { bedrockServer } from "bdsx/launcher";
import { procHacker } from "bdsx/prochacker";

function check(label: string, ok: boolean, detail: string): void {
    console.log(`[slotprobe] ${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
function attempt(label: string, fn: () => void): void {
    try {
        fn();
    } catch (e) {
        console.log(`[slotprobe] FAIL ${label}: threw ${e && (e as Error).message}`);
    }
}

events.command.on((cmd, originName, ctx) => {
    if (cmd.replace(/^\//, "") !== "slotprobe") return;
    const origin = ctx.origin;
    console.log(`[slotprobe] start (origin name from the hook: ${originName})`);
    // ServerCommandOrigin: bodies that return constants or members
    attempt("origin", () => {
        const isServer = origin.vftable.equalsptr(proc["??_7ServerCommandOrigin@@6B@"]);
        check("origin is a ServerCommandOrigin", isServer, `vftable ${origin.vftable}`);
        if (!isServer) return;
        const type = origin.getOriginType();
        check("getOriginType == 7 (DedicatedServer)", type === 7, String(type));
        check("getName", true, JSON.stringify(origin.getName()));
        check("getRequestId", true, JSON.stringify(origin.getRequestId()));
        const level = origin.getLevel();
        check("getLevel == bedrockServer.level", level !== null && level.equalsptr(bedrockServer.level), `${level}`);
        const entity = origin.getEntity();
        check("getEntity == null", entity === null, `${entity}`);
        const bp = origin.getBlockPosition();
        check("getBlockPosition == 0,0,0", bp.x === 0 && bp.y === 0 && bp.z === 0, `${bp.x},${bp.y},${bp.z}`);
        const dim = origin.getDimension();
        check("getDimension non-null", dim !== null, `${dim}`);
    });
    // RakNetConnector
    attempt("connector", () => {
        const connector = bedrockServer.connector;
        const port = connector.getPort();
        check("getPort == 19132", port === 19132, String(port));
        const getPeer = procHacker.js("?getPeer@RakNetConnector@@UEAAPEAVRakPeerInterface@RakNet@@XZ", RakNet.RakPeer, null, RakNetConnector);
        const peer = getPeer(connector);
        const known = bedrockServer.rakPeer;
        check("getPeer == bedrockServer.rakPeer", peer !== null && peer.equalsptr(known), `${peer} vs ${known}`);
        // the listening peer's bound addresses hold the port in network byte
        // order (4A BC); the RakPeer in the holder at ServerNetworkSystem+0xf8,
        // which launcher.ts read from layouts before, has none in 16 KB
        let hits = 0;
        for (let off = 0; peer !== null && off < 0x4000; off += 2) {
            let w: number;
            try {
                w = (peer as any as StaticPointer).getUint16(off);
            } catch (e) {
                break;
            }
            if (w === 0xbc4a) hits++;
        }
        check("getPeer's RakPeer holds the port bytes", hits > 0, `x${hits}`);
    });
    // ServerScoreboard: the display slot is set from the console first
    // (scoreboard objectives add slotprobe dummy; setdisplay sidebar slotprobe)
    attempt("scoreboard", () => {
        const sb = (bedrockServer.commandRegistry as any as StaticPointer).getPointerAs(Scoreboard, 0x48);
        const vft = (sb as any as StaticPointer).getPointer(0);
        const isSb = vft.equalsptr(proc["??_7ServerScoreboard@@6B@"]);
        check("CommandRegistry+0x48 is a ServerScoreboard", isSb, `${vft}`);
        if (!isSb) return;
        const obj = sb.clearDisplayObjective(DisplaySlot.Sidebar);
        check("clearDisplayObjective(sidebar) returns the displayed objective", obj !== null, `${obj}`);
        const again = sb.clearDisplayObjective(DisplaySlot.Sidebar);
        check("clearDisplayObjective(sidebar) again returns null", again === null, `${again}`);
        if (obj === null) return;
        const disp = sb.setDisplayObjective(DisplaySlot.Sidebar, obj, 0);
        check("setDisplayObjective returns a DisplayObjective", disp !== null, `${disp}`);
        const back = sb.clearDisplayObjective(DisplaySlot.Sidebar);
        check("clearDisplayObjective returns what setDisplayObjective displayed", back !== null && back.equalsptr(obj), `${back} vs ${obj}`);
        const a = sb.createScoreboardId("slotprobe-a").idAsNumber;
        const b = sb.createScoreboardId("slotprobe-b").idAsNumber;
        check("createScoreboardId(string) hands out consecutive ids", a > 0 && b === a + 1, `${a}, ${b}`);
        const id = sb.createScoreboardId("slotprobe-c");
        sb.sync(id, obj);
        check("onScoreChanged(id, objective) returns", true, `id ${id.idAsNumber}`);
    });
    console.log("[slotprobe] end");
    return 0;
});
