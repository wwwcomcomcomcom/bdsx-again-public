/**
 * The accessors that are offsets, not functions.
 *
 * A getter such as `mov rax,[rcx+X]; ret` has no .pdata entry, a body that
 * differs from hundreds of others by the offset alone, and no caller in the
 * call graph because it is inlined: no route that matches functions across
 * builds can find it (docs/next-steps.md step 3). What defines it is the
 * field: class, offset, width, kind. This reads the 2024 baseline body of
 * every required name that has no .pdata entry and writes that definition.
 * The baseline offset is a prior, not the answer: docs/findings-layouts.md
 * has how the target's offset is read.
 *
 * Usage: node tools/leaf-accessors.mjs data/leaf-accessors.json
 */
import * as fs from "fs";
import { disas } from "./disas.mjs";
import { functions } from "./pdata.mjs";
const out = process.argv[2];
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const req = load("data/required-symbols.json").symbols;
const full = load("data/baseline-symbols.json").symbols;
const BE = "work/bin/1.21.3.01/bedrock_server.exe";
const pd = new Set(functions(BE).map(f => f.begin));
const W = { q: 8, l: 4, w: 2, b: 1 };
const result = {}; const kinds = {}; const other = [];
for (const r of req) {
    const n = r.name; const b = full[n];
    if (b === undefined || pd.has(b) || n.startsWith("??")) continue;
    if (!/@@[AIQ]E/.test(n)) continue;              // non-virtual members only
    let ins; try { ins = disas(BE, b, 32).map(i => i.text); } catch (e) { continue; }
    const [i0 = "", i1 = "", i2 = "", i3 = ""] = ins;
    const cls = (n.match(/@(\w+)@@/) || [])[1];
    let e = null, m;
    if ((m = i0.match(/^mov([qlwb])\s+(-?\d*)\(%rcx\),\s*%(rax|eax|ax|al)$/)) && i1 === "retq") e = { kind: "get", width: W[m[1]], off: Number(m[2] || 0) };
    else if ((m = i0.match(/^movz([bw])l\s+(-?\d*)\(%rcx\),\s*%eax$/)) && i1 === "retq") e = { kind: "get", width: W[m[1]], off: Number(m[2] || 0), zx: true };
    else if ((m = i0.match(/^movs([bwl])[lq]\s+(-?\d*)\(%rcx\),\s*%[er]ax$/)) && i1 === "retq") e = { kind: "get", width: W[m[1]], off: Number(m[2] || 0), sx: true };
    else if ((m = i0.match(/^movs([sd])\s+(-?\d*)\(%rcx\),\s*%xmm0$/)) && i1 === "retq") e = { kind: "get", width: m[1] === "s" ? 4 : 8, off: Number(m[2] || 0), float: true };
    else if ((m = i0.match(/^leaq\s+(-?\d*)\(%rcx\),\s*%rax$/)) && i1 === "retq") e = { kind: "lea", width: 8, off: Number(m[1] || 0) };
    else if ((m = i0.match(/^mov([qlwb])\s+%(rdx|edx|dx|dl),\s*(-?\d*)\(%rcx\)$/)) && i1 === "retq") e = { kind: "set", width: W[m[1]], off: Number(m[3] || 0) };
    else if ((m = i0.match(/^movs([sd])\s+%xmm1,\s*(-?\d*)\(%rcx\)$/)) && i1 === "retq") e = { kind: "set", width: m[1] === "s" ? 4 : 8, off: Number(m[2] || 0), float: true };
    else if ((m = i0.match(/^mov([ql])\s+(-?\d*)\(%rcx\),\s*%[er]ax$/)) && /^mov[ql]\s+%[er]ax,\s*\(%rdx\)$/.test(i1) && /^movq\s+%rdx,\s*%rax$/.test(i2) && i3 === "retq") e = { kind: "get-hidden", width: W[m[1]], off: Number(m[2] || 0) };
    if (e) { result[n] = { cls, ...e, baselineRva: b, sites: r.sites.length }; kinds[e.kind] = (kinds[e.kind] || 0) + 1; }
    else other.push([n, ins.slice(0, 3).join(" ; ")]);
}
console.log(`accessors ${Object.keys(result).length}:`, kinds, `; other pdata-less leaves ${other.length}`);
const byCls = {}; for (const [n, e] of Object.entries(result)) (byCls[e.cls] ??= []).push(`${(n.match(/^\?(\w+)@/) || [])[1]}[${e.kind},${e.width}${e.float ? "f" : ""},+0x${e.off.toString(16)}]`);
for (const [c, l] of Object.entries(byCls).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${c.padEnd(24)} ${l.length}: ${l.join(" ")}`);
fs.writeFileSync(out, JSON.stringify({ _comment: "Required non-virtual members whose 2024 baseline body is a field access with no .pdata entry (tools/leaf-accessors.mjs): kind get/lea/set/get-hidden, width in bytes, off = the BASELINE offset (a prior). Target offsets live in data/candidates-instances-<v>.json accessors, read from live objects.", accessors: result, otherLeaves: Object.fromEntries(other) }, null, 1));
console.log(`-> ${out}`);
