/**
 * Read a reach-probe run (tools/reach-probe-launcher.js output, the [rp]
 * lines) and annotate every vftable it reached: slot count, what the walk or
 * any merged source already calls that address, and every path that reached
 * it (which object, which member offset). The naming decision is made from
 * this listing by hand and recorded in data/candidates-instances-<v>.json.
 *
 * Usage: node tools/reach-name.mjs <version> <run.out> [--min-slots=N]
 */
import * as fs from "fs";
const [v, file, ...rest] = process.argv.slice(2);
const MIN = Number((rest.find(a => a.startsWith("--min-slots=")) ?? "--min-slots=0").slice(12));
const scan = JSON.parse(fs.readFileSync(`work/vft/scan-${v}.json`, "utf8")).vftables;
const byRva = new Map(Object.values(scan).map(t => [t.rva, t]));
const merged = JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8"));
const names = new Map();
for (const [n, r] of Object.entries(merged.symbols)) if (n.startsWith("??_7")) (names.get(r) ?? names.set(r, []).get(r)).push(`${n} [${merged.origin[n]}]`);
const B = JSON.parse(fs.readFileSync("work/vft/baseline-slots.json", "utf8")).vftables;
const bBySize = {}; for (const [n, t] of Object.entries(B)) (bBySize[t.slots.length] ??= []).push(n);
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(l => l.includes("[rp]"));
const reached = new Map();   // rva -> { paths: [] }
const objs = [];
for (const l of lines) {
    let m;
    if ((m = l.match(/\[rp\] (?:NEW )?OBJ (\S+) ptr=(\S+) vft=0x([0-9a-f]+)/))) { objs.push({ label: m[1], ptr: m[2], rva: parseInt(m[3], 16) }); (reached.get(parseInt(m[3], 16)) ?? reached.set(parseInt(m[3], 16), { paths: [] }).get(parseInt(m[3], 16))).paths.push(`OBJ ${m[1]}`); }
    else if ((m = l.match(/\[rp\] (NEW )?(INLINE|MEM2?) (\S+) (\+0x[0-9a-f]+)(?: -> blk(\+0x[0-9a-f]+))? (?:-> obj )?vft=0x([0-9a-f]+)/))) { const r = parseInt(m[6], 16); (reached.get(r) ?? reached.set(r, { paths: [] }).get(r)).paths.push(`${m[1] ? "NEW " : ""}${m[2]} ${m[3]} ${m[4]}${m[5] ? " blk" + m[5] : ""}`); }
}
console.log(`${objs.length} objects, ${reached.size} distinct vftables reached`);
const rows = [...reached.entries()].map(([r, x]) => ({ r, t: byRva.get(r), paths: x.paths })).filter(x => x.t && x.t.slots.length >= MIN).sort((a, b) => b.t.slots.length - a.t.slots.length);
for (const { r, t, paths } of rows) {
    const known = names.get(r) ?? [];
    const sameSize = (bBySize[t.slots.length] ?? []).length;
    console.log(`\n0x${r.toString(16)}  ${t.slots.length} slots, ${t.refs} refs; baseline tables of that size: ${sameSize}${known.length ? "; named: " + known.join(", ") : ""}`);
    const uniq = [...new Set(paths)];
    for (const p of uniq.slice(0, 12)) console.log(`    ${p}`);
    if (uniq.length > 12) console.log(`    ... ${uniq.length - 12} more paths`);
}
