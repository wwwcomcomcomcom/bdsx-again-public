/**
 * Find vftables in a stripped build by who references them.
 *
 * Code never takes the address of the middle of a vftable; a constructor or
 * destructor does `lea rax, [rip+vftable]` / `mov [this], rax` for its start.
 * So every .rdata address that is the target of a RIP-relative `lea` from
 * .text and holds a .text pointer is a vftable start, and a table runs to the
 * next such start or to the first non-.text qword.
 *
 * Validated on 1.21.3.01 where the PDB names the tables (see the summary the
 * tool prints when given --check=<vftable-slots.json>).
 *
 * Output: { vftables: [ { rva, slots: [rva...], refs } ] }
 *
 * Usage: node tools/vftable-scan.mjs <exe> <out.json> [--check=<slots.json>]
 */
import * as fs from "fs";
import { loadPE, referencedPointerTables } from "./pe.mjs";

const args = process.argv.slice(2);
const [exePath, outPath] = args.filter(a => !a.startsWith("--"));
const check = (args.find(a => a.startsWith("--check=")) ?? "").slice(8);

const pe = loadPE(exePath);
const rdata = pe.sec(".rdata");
const inRdata = r => r >= rdata.rva && r < rdata.rva + rdata.vsize;
const qwordAt = rva => {
    const o = pe.off(rva);
    return o < 0 || o + 8 > pe.buf.length ? -1n : pe.buf.readBigUInt64LE(o);
};
const textPtrAt = rva => {
    const v = qwordAt(rva);
    if (v < 0n) return -1;
    const r = Number(v - pe.imageBase);
    return pe.inText(r) ? r : -1;
};

// 1. every `lea r64, [rip+disp32]` in .text whose target is an 8-aligned .rdata qword holding a .text pointer
const refs = referencedPointerTables(pe);
const starts = [...refs.keys()].sort((a, b) => a - b);

// 2. read each table to the next start or the first non-.text qword
const vftables = [];
for (let i = 0; i < starts.length; i++) {
    const rva = starts[i];
    const limit = i + 1 < starts.length ? starts[i + 1] : rdata.rva + rdata.vsize;
    const slots = [];
    for (let p = rva; p + 8 <= limit; p += 8) {
        const fn = textPtrAt(p);
        if (fn < 0) break;
        slots.push(fn);
    }
    vftables.push({ rva, slots, refs: refs.get(rva) });
}
fs.writeFileSync(outPath, JSON.stringify({ exe: exePath, vftables }));
const slotTotal = vftables.reduce((a, v) => a + v.slots.length, 0);
console.log(`${vftables.length} referenced .rdata tables of .text pointers, ${slotTotal} slots -> ${outPath}`);

// 3. optional: grade against a PDB-derived slot table
if (check) {
    const truth = JSON.parse(fs.readFileSync(check, "utf8")).vftables;
    const byRva = new Map(vftables.map(v => [v.rva, v]));
    let found = 0, exact = 0, longer = 0, shorter = 0, missing = 0;
    const missNames = [];
    for (const [name, t] of Object.entries(truth)) {
        const v = byRva.get(t.rva);
        if (!v) { missing++; if (missNames.length < 8) missNames.push(name); continue; }
        found++;
        if (v.slots.length === t.slots.length) exact++;
        else if (v.slots.length > t.slots.length) longer++;
        else shorter++;
    }
    const truthStarts = new Set(Object.values(truth).map(t => t.rva));
    const extra = vftables.filter(v => !truthStarts.has(v.rva)).length;
    console.log(`check vs ${check}: ${Object.keys(truth).length} PDB vftables; start found ${found}, missing ${missing}; length exact ${exact}, scanner longer ${longer}, shorter ${shorter}; scanner starts not in PDB ${extra}`);
    for (const n of missNames) console.log("  missing:", n);
}
