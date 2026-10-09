/**
 * The callable names still open: required by bdsx, called from JS (procHacker.js and the like, not hooks), with no
 * address on at least one build and no derived() entry. Grouped by the A1 verdict in data/arch-inventory.json, so the
 * cheap ones (absorbed into a layout: a field read bdsx can do itself) come first.
 *
 *   node tools/open-absorbed.mjs              every open callable name, by class
 *   node tools/open-absorbed.mjs --class=absorbed --impl=layout
 *   node tools/open-absorbed.mjs --grep=@Block@@
 */
import * as fs from "fs";

const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const arg = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const req = load("data/required-symbols.json").symbols;
const tables = ["1.26.40.8", "1.26.51.1"].map(v => load(`data/merged-${v}.json`));
const derived = load("data/derived.json").derived;
const inv = load("data/arch-inventory.json").names;
const has = (m, n) => n in m.symbols || n in (m.accessors ?? {}) || n in (m.constants ?? {});

// names the table serves under a `bdsx:` key (a changed signature); the required name is only the pre-1.26 fallback
// (keyed by the name's `?fn@Class@@` prefix; a `?` key that is a symbol, not a `bdsx:` one, is the 1.26 spelling bdsx binds first)
const bdsxKey = {
    "?canSee@Actor@@QEBA_NAEBVVec3@@@Z": "bdsx:Actor::canSee",
    "?getItemCooldownLeft@Player@@": "bdsx:Player::getItemCooldownLeft",
    "?hurt@Actor@@QEAA_N": "bdsx:Actor::hurt",
    "?isHiddenFrom@Player@@": "bdsx:Player::isHiddenFrom",
    "?knockback@Mob@@UEAAXPEAVActor@@H": "?knockback@Mob@@UEAAXPEAVActor@@MMMAEBUKnockbackParameters@@@Z",
    "?setPlayerUIItem@Player@@": "bdsx:Player::setPlayerUIItem",
    "?create@SimulatedPlayer@@": "bdsx:SimulatedPlayer::create",
    "?spawnItem@Spawner@@": "bdsx:Spawner::spawnItem",
    "?spawnMob@Spawner@@": "bdsx:Spawner::spawnMob",
};
const servedBy = name => Object.entries(bdsxKey).find(([k]) => name.startsWith(k))?.[1];
const wantClass = arg("class"), wantImpl = arg("impl"), grep = arg("grep");
const rows = [];
for (const s of req) {
    if (tables.every(m => has(m, s.name)) || s.name in derived) continue;
    if (servedBy(s.name) && tables.every(m => has(m, servedBy(s.name)))) continue;
    if (!s.kinds.some(k => k === "js" || k === "jsv")) continue;
    if (grep && !s.name.includes(grep)) continue;
    const e = inv[s.name] ?? {};
    // served under a `bdsx:` key in both tables (arch-inventory.mjs finds them, aliases included): the decorated name is only the pre-1.26 fallback
    if (e.source === "bdsx-key") continue;
    if (wantClass && e.class !== wantClass) continue;
    if (wantImpl && e.impl !== wantImpl) continue;
    const where = tables.map(m => (has(m, s.name) ? "+" : "-")).join("");
    rows.push([`${e.class ?? "?"}/${e.impl ?? "-"}`, where, s.name, (e.target ?? "").slice(0, 80), s.sites[0]]);
}
rows.sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
for (const r of rows) console.log(`${r[0].padEnd(18)} ${r[1]} ${r[2]}\n${" ".repeat(22)}${r[3] ? r[3] + " | " : ""}${r[4]}`);
console.log(`${rows.length} open callable names (40/51: + has an address, - does not)`);
