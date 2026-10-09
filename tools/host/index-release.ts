// The release check (docs/findings-inventory.md section 29): <inst>\index.ts for a session that loads every stock example under
// bdsx/example_and_test/ (and the plugin template) and nothing else -- no probe. session.mjs copies index-probes.ts as
// index.ts first; the rel40/51 sessions then overwrite it with this file through --upload.
//
// Each example is required on its own inside try/catch, so one that throws cannot hide the ones after it (the stock
// example_and_test/index.ts is an import chain: the first throw ends it). Every console.error line printed while an
// example loads is attributed to it. The verdict per example:
//   [exload] PASS <name>                 loaded, and every red line it printed is on the known list below
//   [exload] FAIL <name> threw: <msg>    the module threw at load
//   [exload] FAIL <name> new red: <line> a red line not on the known list
// The red lines before the first example (bdsx's own boot) are counted under "<boot>" by the same rule.
import { events } from "bdsx/event";

// A red line an example is allowed to print, by example, and an example allowed to throw. Every entry is written down
// in docs/findings-inventory.md section 29. bdsx's cyan "[bdsx] <name>: no address in this build, using bdsx's own implementation"
// notes go through console.error too; they are not red lines and are never counted.
const KNOWN: Record<string, RegExp[]> = {
    // blockevent.ts installs 2024's SurvivalMode::destroyBlock hook beside the 1.26 one (findings-inventory.md section 29)
    "event-blockdestroy": [/Symbol not found: \?destroyBlock@SurvivalMode@@/],
    // 2024 decorations with no 1.26 address (findings-inventory.md section 28)
    hidemapmarker: [/Symbol not found: \?_updateTrackedEntityDecoration@MapItemSavedData@@/],
    "lowlevel-apihooking": [/Symbol not found: \?useItemOn@GameMode@@/, /Symbol not found: \?_updateTrackedEntityDecoration@MapItemSavedData@@/],
};
const KNOWN_THROW: Record<string, RegExp> = {
    // upstream's own guard: the permissions system was put on hold before the archive, and the stock index comments it out
    permissions: /The permissions system is currently on hold/,
};
const INFO = /^\[bdsx\] .*(no address in this build, using bdsx's own implementation|this build numbers it)/;

const EXAMPLES = [
    // the stock index's own order (example_and_test/index.ts)
    "actor-effects",
    "attribute",
    "blockcustomname",
    "customcommand",
    "custommotd",
    "event-blockdestroy",
    "event-knockback",
    "event-playerdropitem",
    "executecommand",
    "form",
    "hidemapmarker",
    "inventory",
    "ipban",
    "lowlevel-apihooking",
    "lowlevel-asm",
    "lowlevel-dll",
    "lowlevel-nativeclass",
    "lowlevel-string-and-vector",
    "nbt-sign",
    "net-chat",
    "net-disconnect",
    "net-login",
    "net-ping",
    "net-printall",
    "net-rawpacket",
    "net-scorepacket",
    "net-sendhook",
    "net-transferserver",
    "setblock",
    "settitle",
    "simulatedplayer",
    "storage",
    "test",
    "vulnerabilities",
    "shoot-projectile",
    // in the folder but not in the stock index
    "entity",
    "event-jump",
    "net-chat-to-console",
    "net-gametype",
    "net-hud",
    "permissions",
];

const origError = console.error;
const origAssert = console.assert;
let current = "<boot-examples>";
let red: string[] = [];
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
console.error = (...args: any[]): void => {
    red.push(strip(args.map(String).join(" ")));
    origError.apply(console, args);
};
// console.assert prints "Assertion failed" through its own path; count it as a red line of the example that asserted
console.assert = (cond?: boolean, ...args: any[]): void => {
    if (!cond) red.push(`Assertion failed${args.length ? ": " + args.map(String).join(" ") : ""}`);
    origAssert.call(console, cond, ...args);
};

function verdict(name: string, threw: Error | null, lines: string[]): void {
    if (threw !== null && KNOWN_THROW[name]?.test(String(threw.message))) {
        origError(`[exload] KNOWN ${name} threw (upstream): ${threw.message}`);
        return;
    }
    if (threw !== null) {
        origError(`[exload] FAIL ${name} threw: ${strip(String(threw.stack || threw)).split("\n").slice(0, 4).join(" | ")}`);
        return;
    }
    const known = KNOWN[name] || [];
    const fresh = lines.filter(l => !/^\s+at /.test(l) && !INFO.test(l) && !known.some(k => k.test(l)));
    if (fresh.length === 0) {
        origError(`[exload] PASS ${name}${lines.length ? ` (${lines.length} known red line(s))` : ""}`);
    } else {
        for (const l of fresh) origError(`[exload] FAIL ${name} new red: ${l.slice(0, 300)}`);
    }
}

for (const name of EXAMPLES) {
    current = name;
    red = [];
    origError(`[exload] begin ${name}`);
    let threw: Error | null = null;
    try {
        require(`./example_and_test/${name}`);
    } catch (err) {
        threw = err instanceof Error ? err : Error(String(err));
    }
    verdict(name, threw, red);
}
current = "plugin-example";
red = [];
origError(`[exload] begin plugin-example`);
try {
    require("./plugin-example/index");
    verdict("plugin-example", null, red);
} catch (err) {
    verdict("plugin-example", err instanceof Error ? err : Error(String(err)), red);
}
current = "<after>";
red = [];
// red lines printed after loading (intervals, commands, events, the tester) are still in <Tag>.err; mark the boundary
origError(`[exload] all ${EXAMPLES.length + 1} loaded`);
events.serverOpen.on(() => origError("[exload] serverOpen"));
// the console commands' order in the stderr stream, so a later error can be placed (the test suite's own are left out)
events.command.on((cmd, origin, ctx) => {
    if (cmd.startsWith("/testcommand_") || cmd.startsWith("testcommand_")) return;
    let id = "?";
    try {
        id = ctx.origin.getRequestId();
    } catch {}
    origError(`[exload] cmd ${cmd} (origin ${origin}, request id ${JSON.stringify(id)})`);
});
events.playerJoin.on(ev => origError(`[exload] playerJoin ${ev.player.getNameTag()}${ev.isSimulated ? " (simulated)" : ""}`));
