/**
 * Which of the missing required names are *self-contained* -- and therefore
 * do not need an address in bedrock_server.exe at all.
 *
 * Vec3 was the first case (docs/findings-layouts.md, "Constants"): the twelve
 * constants have no storage in 1.26, so the table ships their bytes. The same
 * question applies to every value-like helper class bdsx uses. A method that
 * calls nothing and reads no global is arithmetic on its arguments: its
 * behaviour is fixed by the type, so bdsx can carry it itself, the way
 * Endstone carries Vec3's operators in its own header, and no matching route
 * has to find it.
 *
 * This reads the 2024 baseline body of every required name that this build's
 * table still misses and measures three things: does it call anything, does
 * it touch a global (a rip-relative reference outside .rdata), and how big is
 * it. Classes are then ranked by how much of their missing surface is
 * self-contained. It decides nothing; it says where the Vec3 move can be
 * repeated. What the values are, and whether re-deriving one is right, is a
 * per-class judgement -- and a re-derivation must be written from the
 * semantics of the type, never lifted from the binary.
 *
 * Usage: node tools/util-classes.mjs [<version>] [--out=data/util-classes.json]
 */
import * as fs from "fs";
import { disas } from "./disas.mjs";
import { functions, containing } from "./pdata.mjs";
import { loadPE } from "./pe.mjs";

const args = process.argv.slice(2);
const v = args.find(a => !a.startsWith("--")) ?? "1.26.40.8";
const out = (args.find(a => a.startsWith("--out=")) ?? "--out=data/util-classes.json").slice(6);
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));

const req = load("data/required-symbols.json").symbols;
const table = load(`data/symbols-${v}.json`);
const held = new Set([...Object.keys(table.symbols), ...Object.keys(table.accessors ?? {}), ...Object.keys(table.constants ?? {})]);
const baseline = load("data/baseline-symbols.json").symbols;
const leaves = (() => { try { return load("data/leaf-accessors.json").accessors; } catch { return {}; } })();
// names bdsx already carries itself (data/derived.json): not missing any more,
// they simply have no address to find
const derived = (() => { try { return load("data/derived.json").derived; } catch { return {}; } })();

const BE = "work/bin/1.21.3.01/bedrock_server.exe";
const fns = functions(BE);
const pe = loadPE(BE);
const sectionOf = rva => pe.sectionOf(rva)?.name ?? "?";

/** the class a decorated name belongs to, and what kind of thing it is */
function classOf(n) {
    if (n.startsWith("??_7")) return (n.match(/^\?\?_7(\w+)@/) || [, "(global)"])[1];
    if (n.startsWith("?") ) {
        const parts = n.replace(/^\?\??/, "").split("@@")[0].split("@");
        return parts.length > 1 ? parts.slice(1).reverse().join("::") : "(global)";
    }
    return "(plain)";
}
function shapeOf(n) {
    if (n.startsWith("??_7")) return "vftable";
    if (/^\?\?[01]/.test(n)) return "ctor/dtor";
    if (/@@2/.test(n) && /[AB]$/.test(n)) return "static data";
    if (/@@[SQ]?[A-Z]*SA/.test(n) || /@@SA/.test(n)) return "static fn";
    if (/@@[UMEG]E[A-Z]A/.test(n)) return "virtual";
    if (/@@[AIQ]E[A-Z]A/.test(n)) return "member";
    if (/@@[A-Z]A/.test(n)) return "free fn";
    return "other";
}

const rows = [];
for (const r of req) {
    const n = r.name;
    if (held.has(n) || n in derived) continue;
    const shape = shapeOf(n);
    const rva = baseline[n];
    const row = { name: n, cls: classOf(n), shape, kinds: r.kinds, sites: r.sites.length, baselineRva: rva ?? null };
    rows.push(row);
    if (rva === undefined || shape === "vftable" || shape === "static data") continue;
    if (n in leaves) { row.verdict = "accessor"; row.size = 8; continue; }
    const f = containing(fns, rva);
    const size = f && f.begin === rva ? f.end - f.begin : 32;   // no .pdata entry: a leaf, read a window
    row.size = size;
    if (size > 4096) { row.verdict = "big"; continue; }
    let ins;
    try { ins = disas(BE, rva, Math.min(size, 1024)); } catch { row.verdict = "unreadable"; continue; }
    let calls = 0, globals = 0, rdata = 0;
    for (const i of ins) {
        if (/^(callq|jmpq?)\s+\*/.test(i.text)) calls++;                       // indirect
        else if (/^callq/.test(i.text)) calls++;
        else if (i.text.includes("%rip")) {
            // llvm-mc prints rip-relative as a displacement from the next instruction
            const m = i.text.match(/(-?\d+)\(%rip\)/);
            const target = m ? i.rva + i.size + Number(m[1]) : null;
            const sec = target === null ? "?" : sectionOf(target);
            if (sec === ".rdata" || sec === ".text") rdata++;                  // a constant pool entry or a jump table
            else globals++;
        }
        if (i.text === "retq" && i.rva + i.size >= rva + size) break;
    }
    row.calls = calls; row.globals = globals; row.consts = rdata;
    row.verdict = calls === 0 && globals === 0 ? "self-contained" : calls === 0 ? "reads a global" : "calls out";
}

// aggregate
const byCls = {};
for (const r of rows) {
    const c = (byCls[r.cls] ??= { cls: r.cls, missing: 0, selfContained: 0, accessor: 0, callsOut: 0, globals: 0, vftables: 0, data: 0, names: [] });
    c.missing++;
    if (r.shape === "vftable") c.vftables++;
    else if (r.shape === "static data") c.data++;
    else if (r.verdict === "self-contained") { c.selfContained++; c.names.push(r.name); }
    else if (r.verdict === "accessor") c.accessor++;
    else if (r.verdict === "reads a global") c.globals++;
    else if (r.verdict === "calls out") c.callsOut++;
}
const ranked = Object.values(byCls).sort((a, b) => b.selfContained - a.selfContained || b.missing - a.missing);
console.log(`${v}: ${rows.length} required names still missing (${Object.keys(derived).length} more are carried by bdsx itself, data/derived.json)\n`);
console.log("class                      missing  self-contained  accessor  reads-global  calls-out  vftable  data");
for (const c of ranked.slice(0, 30)) {
    console.log(
        `${c.cls.padEnd(26)} ${String(c.missing).padStart(6)}  ${String(c.selfContained).padStart(14)}  ${String(c.accessor).padStart(8)}  ${String(c.globals).padStart(12)}  ${String(c.callsOut).padStart(9)}  ${String(c.vftables).padStart(7)}  ${String(c.data).padStart(4)}`,
    );
}
const totals = rows.reduce((a, r) => ((a[r.verdict ?? r.shape] = (a[r.verdict ?? r.shape] ?? 0) + 1), a), {});
console.log("\nverdicts:", totals);
fs.writeFileSync(out, JSON.stringify({
    _comment: "Missing required names measured for self-containment against the 1.21.3.01 baseline body (tools/util-classes.mjs). self-contained = no call and no rip-relative reference outside .rdata, i.e. arithmetic on its arguments, which bdsx can carry itself instead of resolving. A re-derivation must come from the semantics of the type, never from these bytes.",
    bdsVersion: v,
    generatedAt: new Date().toISOString(),
    classes: ranked,
    names: rows,
}, null, 1) + "\n");
console.log(`-> ${out}`);
