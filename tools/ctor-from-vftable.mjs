/**
 * The functions that store a given vftable, and which of them is the
 * constructor.
 *
 * Every polymorphic constructor writes its class's vftable into [this] with
 * `lea rax,[rip+vftable]` / `mov [rcx],rax`; so does the destructor, which
 * restores it before running the base destructor. So the referencing functions
 * of a vftable are its constructors and destructors, and a destructor is told
 * apart structurally: it is slot 0 of the table (the deleting destructor
 * ??_G) or is called by slot 0 (the complete destructor ??_1). What is left
 * is a constructor (or several: copy/move constructors are rare on the
 * classes this is for).
 *
 * Validated on 1.21.3.01 with --check=<baseline-slots.json>, where the PDB
 * names every function found.
 *
 * Usage: node tools/ctor-from-vftable.mjs <exe> <scan-or-slots.json> <vftableRva|name>... [--check=work/vft/baseline-slots.json]
 */
import * as fs from "fs";
import { loadPE } from "./pe.mjs";
import { functions as pdataFunctions, containing } from "./pdata.mjs";
import { callGraph } from "./callgraph.mjs";

const args = process.argv.slice(2);
const check = (args.find(a => a.startsWith("--check=")) ?? "").slice(8);
const [exePath, tablesPath, ...wants] = args.filter(a => !a.startsWith("--"));
const pe = loadPE(exePath);
const tables = JSON.parse(fs.readFileSync(tablesPath, "utf8"));
const names = check ? JSON.parse(fs.readFileSync(check, "utf8")).names : {};
const nameOf = r => (names[r] ?? [])[0] ?? "";
const slotsOf = rva => {
    if (tables.vftables && !Array.isArray(tables.vftables)) { const e = Object.values(tables.vftables).find(v => v.rva === rva); return e ? e.slots : null; }
    const e = tables.vftables.find(v => v.rva === rva); return e ? e.slots : null;
};
const resolveWant = w => {
    if (/^0x/.test(w)) return Number(w);
    if (tables.vftables && !Array.isArray(tables.vftables) && w in tables.vftables) return tables.vftables[w].rva;
    return Number(w);
};

const fns = pdataFunctions(exePath);
const g = callGraph(exePath);

// every `lea r64,[rip+disp32]` in .text -> its target and containing function
export function referrers(target) {
    const { buf, text } = pe; const out = new Set();
    const end = text.rawPtr + text.rawSize - 7;
    for (let p = text.rawPtr; p < end; p++) {
        if ((buf[p] & 0xf8) !== 0x48 || buf[p + 1] !== 0x8d || (buf[p + 2] & 0xc7) !== 0x05) continue;
        const rva = text.rva + (p - text.rawPtr);
        if (rva + 7 + buf.readInt32LE(p + 3) !== target) continue;
        const f = containing(fns, rva);
        out.add(f ? f.begin : rva);
    }
    return [...out];
}

const result = {};
for (const w of wants) {
    const rva = resolveWant(w);
    const slots = slotsOf(rva) ?? [];
    const deleting = slots[0];
    const calledByDeleting = new Set(g.callees.get(deleting) ?? []);
    const refs = referrers(rva);
    const classified = refs.map(f => {
        let kind = "ctor";
        if (f === deleting) kind = "deleting dtor (slot 0)";
        else if (calledByDeleting.has(f)) kind = "dtor (called by slot 0)";
        const size = (fns.find(x => x.begin === f) ?? { end: f }).end - f;
        return { rva: f, kind, size, callers: (g.callers.get(f) ?? new Set()).size, name: nameOf(f) };
    });
    result[w] = classified;
    console.log(`${w} (0x${rva.toString(16)}, ${slots.length} slots): ${refs.length} referencing functions`);
    for (const c of classified) console.log(`  0x${c.rva.toString(16)}  ${c.kind.padEnd(24)} ${String(c.size).padStart(6)}B  callers ${String(c.callers).padStart(3)}  ${c.name.slice(0, 90)}`);
}
