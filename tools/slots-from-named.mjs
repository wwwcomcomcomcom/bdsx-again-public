/**
 * Write a stripped build's named vftables in the baseline-slots format, so
 * tools/vftable-match.mjs can align the *next* build against it instead of
 * against 1.21.3.01. Two builds weeks apart share a compiler and almost every
 * slot; the 2024 baseline shares neither.
 *
 * Tables: every scanned table, since the walk's one feature is how many
 * tables hold a function and that count is only right over the whole set;
 * a table a trusted source named (live instances, live packets, the two-walk
 * agreement) carries its name, the rest carry a placeholder key. Names: the
 * merged table's, per .text address.
 *
 * Usage: node tools/slots-from-named.mjs <version> <out.json>
 */
import * as fs from "fs";
const [v, out] = process.argv.slice(2);
const load = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const scan = load(`work/vft/scan-${v}.json`).vftables;
const byRva = new Map(); for (const t of Object.values(scan)) byRva.set(t.rva, t);
const vftables = {};
for (const src of [load(`data/candidates-instances-${v}.json`)?.vftables, load(`data/candidates-packets-${v}.json`)?.vftables, load(`data/candidates-vftable-${v}.json`)?.vftables]) {
    for (const [n, r] of Object.entries(src ?? {})) { const t = byRva.get(r); if (t && !(n in vftables)) vftables[n] = { rva: r, slots: t.slots }; }
}
for (const t of Object.values(scan)) { const k = `vft_0x${t.rva.toString(16)}`; if (!Object.values(vftables).some(x => x.rva === t.rva)) vftables[k] = { rva: t.rva, slots: t.slots }; }
const names = {};
// (the pairs-in-tables candidates are not a source: docs/findings-slots.md)
for (const f of [`data/merged-${v}.json`]) {
    for (const [n, r] of Object.entries(load(f)?.symbols ?? {})) { if (typeof r !== "number" || n.startsWith("??_7")) continue; (names[r] ??= []).includes(n) || names[r].push(n); }
}
fs.writeFileSync(out, JSON.stringify({ exe: `work/bin/${v}/bedrock_server.exe`, source: "tools/slots-from-named.mjs", vftables, names }));
console.log(`${Object.keys(vftables).length} named tables, ${Object.keys(names).length} named functions -> ${out}`);
