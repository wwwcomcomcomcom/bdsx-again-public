/**
 * Code that .pdata does not describe.
 *
 * x64 Windows only requires a RUNTIME_FUNCTION for a function that touches the
 * stack, so every leaf -- a thunk (`add rcx,8; jmp body`), a hash probe that
 * keeps everything in registers -- is invisible to every tool in this repo
 * that starts from `tools/pdata.mjs`. Three of the names bdsx still wants are
 * exactly that shape in the 2024 build (`BaseAttributeMap::getMutableInstance`,
 * `Actor::getHealth`, `Actor::getMaxHealth`), so they can never be found by
 * walking function tables.
 *
 * The recovery is the call graph: a leaf is still *called*, and a direct
 * `E8/E9 rel32` names its first byte exactly. Collecting every direct branch
 * target inside .text that is not a .pdata start gives the leaf entry points,
 * with the callers that prove them.
 *
 *   node tools/leaf-funcs.mjs <exe>                       # summary
 *   node tools/leaf-funcs.mjs <exe> --out=leaves.json     # the whole table
 *   node tools/leaf-funcs.mjs <exe> "--find=48b9b301..."  # byte pattern -> owning leaf
 *
 * Quote --find. An unquoted pattern with a space in it is split by the shell into
 * several arguments, and only the first is used: "--find=48 83c027" searches for the
 * single byte 0x48 and prints fifteen million lines.
 *   node tools/leaf-funcs.mjs <exe> --at=0x1a5c680        # what calls this address
 */
import * as fs from "fs";
import { loadPE, pdataFunctions } from "./pe.mjs";

const args = process.argv.slice(2);
const exe = args[0];
if (!exe) { console.error("usage: leaf-funcs.mjs <exe> [--out=] [--find=hex] [--at=0x..] [--min-callers=N]"); process.exit(1); }
const opt = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : undefined; };

const pe = loadPE(exe);
const funcs = pdataFunctions(pe);
const starts = new Set(funcs.map(f => f.begin));
const text = pe.text;
const base = text.rawPtr, lo = text.rva, hi = text.rva + text.vsize;

/** The .pdata function containing an rva, or null. */
function containing(rva) {
    let a = 0, b = funcs.length - 1;
    while (a <= b) { const m = (a + b) >> 1;
        if (rva < funcs[m].begin) b = m - 1;
        else if (rva >= funcs[m].end) a = m + 1;
        else return funcs[m]; }
    return null;
}

// Every direct branch whose target is in .text but is not a .pdata function
// start. Only branches from inside a real function count: bytes that are not
// code (jump tables, alignment) produce E8s that decode to nothing.
const leaves = new Map(); // target rva -> { call, jmp, callers:Set }
const size = Math.min(text.rawSize, text.vsize);
for (let o = 0; o + 5 <= size; o++) {
    const op = pe.buf[base + o];
    if (op !== 0xe8 && op !== 0xe9) continue;
    const from = lo + o;
    const target = (from + 5 + pe.buf.readInt32LE(base + o + 1)) >>> 0;
    if (target < lo || target >= hi) continue;
    if (starts.has(target)) continue;
    const owner = containing(from);
    if (!owner) continue;
    if (target > owner.begin && target < owner.end) continue; // a local branch
    if (pe.buf[base + (target - lo)] === 0xcc) continue;      // padding
    let e = leaves.get(target);
    if (!e) leaves.set(target, e = { call: 0, jmp: 0, callers: new Set() });
    if (op === 0xe8) e.call++; else e.jmp++;
    e.callers.add(owner.begin);
}

const rows = [...leaves.entries()].map(([rva, e]) => ({
    rva, call: e.call, jmp: e.jmp, callers: [...e.callers].sort((a, b) => a - b),
})).sort((a, b) => a.rva - b.rva);

const minc = Number(opt("min-callers") || 1);
const kept = rows.filter(r => r.callers.length >= minc);
const hex = n => "0x" + n.toString(16);

const at = opt("at");
if (at !== undefined) {
    const want = Number(at);
    const r = rows.find(x => x.rva === want);
    if (!r) console.log(`${hex(want)}: not a direct-branch target outside .pdata`);
    else console.log(`${hex(r.rva)}  calls=${r.call} jmps=${r.jmp}  callers: ${r.callers.map(hex).join(" ")}`);
}

const find = opt("find");
if (find !== undefined) {
    const pat = Buffer.from(find.replace(/[^0-9a-fA-F]/g, ""), "hex");
    const sorted = kept.map(r => r.rva);
    let from = 0;
    for (;;) {
        const i = pe.buf.indexOf(pat, base + from);
        if (i < 0 || i >= base + size) break;
        const rva = lo + (i - base);
        from = i - base + 1;
        const owner = containing(rva);
        // the nearest leaf entry at or before the hit, when no .pdata function owns it
        let lf = null;
        for (let k = sorted.length - 1; k >= 0; k--) if (sorted[k] <= rva) { lf = sorted[k]; break; }
        console.log(`${hex(rva)}  ${owner ? `pdata ${hex(owner.begin)}` : `LEAF ${lf !== null ? hex(lf) : "?"}` +
            (lf !== null ? ` (+${rva - lf}, callers ${leaves.get(lf).callers.size})` : "")}`);
    }
}

const out = opt("out");
if (out) {
    fs.writeFileSync(out, JSON.stringify({ exe, count: kept.length, leaves: kept.map(r => ({ ...r, rva: hex(r.rva), callers: r.callers.map(hex) })) }, null, 1));
    console.log(`${kept.length} leaf entry points -> ${out}`);
} else if (at === undefined && find === undefined) {
    console.log(`.pdata functions: ${funcs.length}`);
    console.log(`leaf entry points (direct-branch targets outside .pdata): ${rows.length}`);
    console.log(`  with 2+ callers: ${rows.filter(r => r.callers.length >= 2).length}`);
    console.log(`  jmp-only (thunks): ${rows.filter(r => r.call === 0).length}`);
}
