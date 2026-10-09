/**
 * Locate a thin CRT wrapper by the import it forwards to.
 *
 * Takes an IAT slot, finds every call/jmp through it, maps each to its exact
 * .pdata function, and reports the distinct functions with their sizes. For
 * something like vsnprintf -- a hundred-byte forwarder around
 * __stdio_common_vsprintf -- that narrows two dozen references down to a
 * handful of candidate functions without any analysis at all.
 */
import * as fs from "fs";
import { functions, containing } from "./pdata.mjs";

const [exePath, slotArg] = process.argv.slice(2);
const slot = Number(slotArg);
const buf = fs.readFileSync(exePath);
const peOff = buf.readUInt32LE(0x3c);
const coff = peOff + 4;
const nSec = buf.readUInt16LE(coff + 2);
const secOff = coff + 20 + buf.readUInt16LE(coff + 16);
let text;
for (let i = 0; i < nSec; i++) {
    const o = secOff + i * 40;
    if (buf.toString("ascii", o, o + 8).replace(/\0+$/, "") === ".text") {
        text = { rva: buf.readUInt32LE(o + 12), rawSize: buf.readUInt32LE(o + 16), rawPtr: buf.readUInt32LE(o + 20) };
    }
}

const refs = [];
for (let p = text.rawPtr, end = text.rawPtr + text.rawSize - 6; p < end; p++) {
    if (buf[p] !== 0xff) continue;
    const modrm = buf[p + 1];
    if (modrm !== 0x15 && modrm !== 0x25) continue;
    const insnRva = text.rva + (p - text.rawPtr);
    if (insnRva + 6 + buf.readInt32LE(p + 2) === slot) refs.push({ rva: insnRva, kind: modrm === 0x15 ? "call" : "jmp" });
}

const fns = functions(exePath);
const byFn = new Map();
for (const r of refs) {
    const f = containing(fns, r.rva);
    const key = f ? f.begin : -1;
    if (!byFn.has(key)) byFn.set(key, { fn: f, refs: [] });
    byFn.get(key).refs.push(r);
}

console.log(`${refs.length} references in ${byFn.size} distinct functions`);
const rows = [...byFn.values()].filter(v => v.fn).sort((a, b) => (a.fn.end - a.fn.begin) - (b.fn.end - b.fn.begin));
for (const v of rows) {
    console.log(`  0x${v.fn.begin.toString(16)}..0x${v.fn.end.toString(16)}  ${String(v.fn.end - v.fn.begin).padStart(5)} bytes  refs: ${v.refs.map(r => r.kind).join(",")}`);
}
