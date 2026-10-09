// Execution check for the console seam (A1-c-x, docs/findings-inventory.md section 11):
// BedrockLogOut survives in 1.26 only as a clone whose "%s" format argument was
// constant-propagated away (priority in ecx, the message in r8). launcher.ts puts
// "%s" back in rdx and enters bdsx's own logHook, so every BDS log line should
// reach events.serverLog. This counts the lines from load on and reports them.
// Deployed beside example_and_test as zz-conprobe.ts and driven by
//   tools/run-full.ps1 -Commands @("conprobe")
//
// `conprobe exec` checks bedrockServer.executeCommandOnConsole: in 2024 it fed a queue that bdsx's
// ConsoleInputReader::getLine patch drained, and 1.26 inlined that reader. It sends
// `scoreboard objectives add <name> dummy` that way, then 3 s later looks the objective up through the
// engine (Scoreboard::getObjective) and checks the command's output reached events.commandOutput (the console's printer), then removes it.
import { bedrockServer } from "bdsx/launcher";
import { pdbcache } from "bdsx/pdbcache";
import { NetworkIdentifier } from "bdsx/bds/networkidentifier";
import { ItemStack } from "bdsx/bds/inventory";
import { CommandResultType } from "bdsx/commandresult";
import { proc } from "bdsx/bds/symbols";
import { StaticPointer } from "bdsx/core";
import { events } from "bdsx/event";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[conprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

// Plugins load after "Server started.", so the lines counted are the ones BDS logs later -- e.g. the
// ERROR it prints for the first `conprobe` it does not know as a command. Boot lines prove the hook by
// their colour in the .out file (bdsx prints them; BDS's own writer has no colour).
let lines = 0;
let last: string | null = null;
const severities = new Map<string, number>();
events.serverLog.on((log, color) => {
    lines++;
    const k = JSON.stringify(color("x")); // the ANSI code the severity maps to
    severities.set(k, (severities.get(k) ?? 0) + 1);
    last = `${k} ${log}`;
});

// events.networkDisconnected (bdsx:NetworkSystem::onConnectionClosed on 1.26): one per leave or kick, and the
// identifier leaves NetworkIdentifier.all() 3 s later (networkidentifier.ts). `conprobe ndc` prints the totals.
let disconnects = 0;
let lefts = 0;
let dropped = 0;
events.playerLeft.on(() => {
    lefts++;
});
events.networkDisconnected.on(ni => {
    disconnects++;
    let address: string;
    try {
        address = ni.getAddress();
    } catch (err) {
        address = `(getAddress threw ${err})`;
    }
    const known = [...NetworkIdentifier.all()].includes(ni);
    say("networkDisconnected", true, `#${disconnects} ${address}, in NetworkIdentifier.all() ${known}`);
    setTimeout(() => {
        const still = [...NetworkIdentifier.all()].includes(ni);
        if (!still) dropped++;
        say("networkDisconnected identifier dropped", !still, `#${disconnects} ${address} still listed 4 s later: ${still}`);
    }, 4000);
});

// events.serverLeave (Minecraft::startLeaveGame on 1.26): once per stop, before serverStop, with the level still
// there and commands still running
let leaves = 0;
let stops = 0;
events.serverLeave.on(() => {
    leaves++;
    let list = "threw";
    try {
        list = String(bedrockServer.executeCommand("list", CommandResultType.Data).getFullCode());
    } catch (err) {
        list = `threw ${err}`;
    }
    say("serverLeave", leaves === 1 && stops === 0, `#${leaves}, serverStop so far ${stops}, \`list\` code ${list} (want #1, 0, 0)`);
});
events.serverStop.on(() => {
    stops++;
    say("serverStop after serverLeave", leaves === 1, `serverLeave fired ${leaves} time(s) before serverStop (want 1)`);
});

let execSeen: string[] = [];
let execRun = 0;
// a console command's output reaches the console through CommandOutputSender (events.commandOutput), not the log
events.commandOutput.on(line => {
    if (/ccprobe\d/.test(line)) execSeen.push(line.trim());
});
events.command.on(cmd => {
    const c = cmd.replace(/^\//, "");
    if (c === "conprobe exec") {
        const name = `ccprobe${++execRun}`;
        execSeen = [];
        let cmdEvent = 0;
        const onCmd = (x: string): void => {
            if (x.includes(name)) cmdEvent++;
        };
        events.command.on(onCmd);
        const before = bedrockServer.level.getScoreboard().getObjective(name) !== null;
        bedrockServer.executeCommandOnConsole(`scoreboard objectives add ${name} dummy`);
        const sync = bedrockServer.level.getScoreboard().getObjective(name) !== null;
        setTimeout(() => {
            events.command.remove(onCmd);
            const after = bedrockServer.level.getScoreboard().getObjective(name) !== null;
            say("executeCommandOnConsole runs", !before && after, `${name}: before ${before}, right after the call ${sync}, 3 s later ${after} (want false, _, true)`);
            say("executeCommandOnConsole fires events.command", cmdEvent === 1, `${cmdEvent} (want 1)`);
            say("executeCommandOnConsole output on the console", execSeen.length > 0, JSON.stringify(execSeen.slice(0, 3)));
            if (after) bedrockServer.executeCommand(`scoreboard objectives remove ${name}`);
        }, 3000);
        return;
    }
    if (c === "conprobe ndc") {
        say("networkDisconnected count", disconnects === 1 && lefts === 1 && dropped === 1,
            `${disconnects} disconnects, ${lefts} playerLeft, ${dropped} identifiers dropped (want 1, 1, 1)`);
        return;
    }
    if (c === "conprobe disc") {
        // Item.isMusicDisk: 2024 compared the item's vftable with RecordItem's. Prints each item's vftable as an offset
        // from ComponentItem's (RVA offline), whether it is component based, its minecraft:record component, isMusicDisk()
        const ci = proc["??_7ComponentItem@@6B@"];
        for (const id of ["minecraft:music_disc_13", "minecraft:music_disc_cat", "minecraft:music_disc_pigstep", "minecraft:diamond", "minecraft:stick", "minecraft:apple"]) {
            const stack = ItemStack.constructWith(id, 1);
            try {
                const item = stack.getItem();
                if (item === null) { say("disc", null, `${id}: no item`); continue; }
                const vft = (item as any as StaticPointer).getPointer(0);
                const comp = stack.getComponentItem();
                const rec = comp === null ? null : comp.getComponent("minecraft:record");
                const want = id.includes("music_disc");
                say("isMusicDisk", item.isMusicDisk() === want, `${id}: ${item.isMusicDisk()} (want ${want})`);
                say("disc", null, `${id}: vftable ComponentItem${vft.subptr(ci) >= 0 ? "+" : ""}0x${vft.subptr(ci).toString(16)}, componentItem ${comp !== null}, minecraft:record ${rec !== null}, isMusicDisk ${item.isMusicDisk()}`);
            } finally {
                stack.destruct();
            }
        }
        return;
    }
    if (c === "conprobe version") {
        // ServerInstance.getGameVersion() reads SharedConstants::CurrentGameSemVersion, 1.26's 24-byte SemVersion
        const v = bedrockServer.serverInstance.getGameVersion();
        if (v === null) return say("getGameVersion", false, "null");
        const want = pdbcache.bdsVersion.split(".").slice(0, 3).join(".");
        const got = `${v.major}.${v.minor}.${v.patch}`;
        say("getGameVersion numbers", got === want, `${got} (table ${pdbcache.bdsVersion}, want ${want})`);
        say("getGameVersion flags", v.validVersion && !v.anyVersion, `valid ${v.validVersion} any ${v.anyVersion} (want true false)`);
        say("getGameVersion strings", v.preRelease === "" && v.buildMeta === "" && v.fullVersionString === want,
            `pre ${JSON.stringify(v.preRelease)} meta ${JSON.stringify(v.buildMeta)} full ${JSON.stringify(v.fullVersionString)}`);
        return;
    }
    if (c !== "conprobe") return;
    const key = "bdsx:BedrockLogOut" in proc ? "bdsx:BedrockLogOut" : "?BedrockLogOut@@YAXIPEBDZZ" in proc ? "?BedrockLogOut@@YAXIPEBDZZ" : null;
    say("log hook target", key !== null, key ?? "neither the clone nor the 2024 name is in the table");
    say("serverLog lines", lines > 0 ? true : null, `${lines} lines since load, by colour ${JSON.stringify([...severities])}`);
    if (last !== null) say("serverLog last line", /\[\d{4}-\d\d-\d\d [\d:]+ (INFO|WARN|ERROR)\]/.test(last), JSON.stringify(last));
});
