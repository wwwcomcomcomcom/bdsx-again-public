/**
 * Read every vftable in a PDB-bearing build and name its slots.
 *
 * MSVC lays a vftable out as consecutive 8-byte function VAs in .rdata, with
 * no RTTI locator when the build has RTTI off (BDS does; checked: the qword
 * before ??_7ServerLevel@@6BILevel@@@ is the previous table's last slot). A
 * table ends where the next symbol in .rdata begins, or at the first value
 * that is not a .text address.
 *
 * Output: { vftables: { "??_7X@@6B@": { rva, slots: [rva...] } }, names: { rva: [name...] } }
 *
 * Usage: node tools/vftable-slots.mjs <exe> <symbols.json> <out.json>
 */
import * as fs from "fs";
import { loadPE, referencedPointerTables } from "./pe.mjs";

const [exePath, symPath, outPath] = process.argv.slice(2);
const pe = loadPE(exePath);
const table = JSON.parse(fs.readFileSync(symPath, "utf8")).symbols;

const rdata = pe.sec(".rdata");
const inRdata = r => r >= rdata.rva && r < rdata.rva + rdata.vsize;
// Boundaries: the next named symbol in .rdata, or the next address code takes
// with `lea` (identical-COMDAT-folded tables such as _Ref_count_obj2<T> share
// one 4-slot body whose neighbours are unnamed, and the PDB boundary alone
// over-reads them by 12 slots).
const refs = referencedPointerTables(pe);
const boundaries = [...new Set([...Object.values(table).filter(inRdata), ...refs.keys()])].sort((a, b) => a - b);
const nextBoundary = r => {
    let lo = 0, hi = boundaries.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (boundaries[m] <= r) lo = m + 1; else hi = m; }
    return lo < boundaries.length ? boundaries[lo] : rdata.rva + rdata.vsize;
};

const names = {};
for (const [n, r] of Object.entries(table)) {
    if (!pe.inText(r)) continue;
    (names[r] ??= []).push(n);
}

const vftables = {};
let slotTotal = 0;
const distinct = new Set();
for (const [name, rva] of Object.entries(table)) {
    if (!name.startsWith("??_7") || !inRdata(rva)) continue;
    const end = nextBoundary(rva);
    const o = pe.off(rva);
    const slots = [];
    for (let p = rva; p + 8 <= end; p += 8) {
        const fn = Number(pe.buf.readBigUInt64LE(o + (p - rva)) - pe.imageBase);
        if (!pe.inText(fn)) break;
        slots.push(fn);
        distinct.add(fn);
    }
    vftables[name] = { rva, slots };
    slotTotal += slots.length;
}
fs.writeFileSync(outPath, JSON.stringify({ exe: exePath, imageBase: pe.imageBase.toString(16), vftables, names }));
console.log(`${Object.keys(vftables).length} vftables, ${slotTotal} slots, ${distinct.size} distinct functions -> ${outPath}`);
