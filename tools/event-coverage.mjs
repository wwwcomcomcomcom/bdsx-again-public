/**
 * Which bdsx events can work on a build, and which have been shown to.
 *
 * For every `events.X.setInstaller` in bdsx/bdsx/event_impl: the decorated names (or `bdsx:` keys) the
 * installer mentions, how many of them the build's merged table ships, and whether the event has FIRED
 * under bdsx's own hook (data/events-fired.json). Three states matter:
 *   FIRED      done
 *   UNFIRED    a target ships but the hook has never run with bdsx's prototype -- the dangerous state:
 *              Mob::_hurt sat here, execution-"confirmed" by a counter, and killed the server on first use
 *   NO TARGET  nothing to hook yet; needs a symbol (or a new seam, as playerJoin / playerDimensionChange did)
 *
 * Usage: node tools/event-coverage.mjs [version ...]     default: both 1.26 builds
 */
import * as fs from "fs";
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["1.26.40.8", "1.26.51.1"];
const fired = JSON.parse(fs.readFileSync("data/events-fired.json", "utf8")).fired;
const tables = versions.map(v => JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8")).symbols);
const rows = [];
for (const f of fs.readdirSync("bdsx/bdsx/event_impl").filter(f => f.endsWith(".ts"))) {
    const parts = fs.readFileSync(`bdsx/bdsx/event_impl/${f}`, "utf8").split(/events\.(\w+)\.setInstaller/);
    for (let i = 1; i < parts.length; i += 2) {
        // an installer ends where the next begins; 6,000 characters covers the longest
        const body = parts[i + 1].slice(0, 6000);
        const names = [...new Set([...body.matchAll(/"((?:\?|bdsx:)[^"]+)"/g)].map(x => x[1]))];
        // an installer that listens to another event (projectileHitBlock on projectileHit) also rides on its targets
        const via = [...new Set([...body.matchAll(/events\.(\w+)\.on\(/g)].map(x => x[1]))].filter(e => e !== parts[i]);
        rows.push({ ev: parts[i], f, names, via });
    }
}
const own = new Map(rows.map(r => [r.ev, r.names]));
for (const r of rows) {
    for (const e of r.via) for (const n of own.get(e) ?? []) if (!r.names.includes(n)) r.names.push(n);
    r.shipped = tables.map(t => r.names.filter(n => n in t));
    r.state = r.ev in fired ? "FIRED" : r.shipped.some(s => s.length) ? "UNFIRED" : "NO TARGET";
}
const order = { UNFIRED: 0, "NO TARGET": 1, FIRED: 2 };
rows.sort((a, b) => order[a.state] - order[b.state] || a.ev.localeCompare(b.ev));
for (const st of ["UNFIRED", "NO TARGET", "FIRED"]) {
    const rs = rows.filter(r => r.state === st); console.log(`\n${st} (${rs.length})`);
    for (const r of rs) console.log(`  ${r.ev.padEnd(26)} ${r.f.padEnd(15)} ${st === "FIRED" ? "" : (r.shipped[0][0] ?? r.names[0] ?? "(no native target: JS-side event)").slice(0, 90)}`);
}
