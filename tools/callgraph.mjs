/**
 * Call edges of a PE, recovered without disassembling it.
 *
 * A near call is E8 followed by a rel32 relative to the end of the
 * instruction. Scanning every offset for one over-generates -- an E8 byte
 * occurs inside other instructions' operands -- but a candidate is kept only
 * when its computed target is exactly the first byte of a function in .pdata,
 * which discards almost all of it. The same is done for E9 (tail jumps),
 * since MSVC emits a great many of the calls we care about as tail calls.
 *
 * Exported as both directions because the two questions that matter are
 * symmetric: what does this function call, and who calls it.
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";
import { pathToFileURL } from "url";

export function sections(buf) {
    const peOff = buf.readUInt32LE(0x3c), coff = peOff + 4;
    const n = buf.readUInt16LE(coff + 2), secOff = coff + 20 + buf.readUInt16LE(coff + 16);
    const out = [];
    for (let i = 0; i < n; i++) {
        const o = secOff + i * 40;
        out.push({
            name: buf.toString("ascii", o, o + 8).replace(/\0+$/, ""),
            rva: buf.readUInt32LE(o + 12), vsize: buf.readUInt32LE(o + 8),
            rawSize: buf.readUInt32LE(o + 16), rawPtr: buf.readUInt32LE(o + 20),
        });
    }
    return out;
}

export function makeLocator(funcs) {
    const sorted = funcs.slice().sort((a, b) => a.begin - b.begin);
    const begins = new Int32Array(sorted.length), ends = new Int32Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) { begins[i] = sorted[i].begin; ends[i] = sorted[i].end; }
    return rva => {
        let lo = 0, hi = sorted.length - 1, ans = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (begins[m] <= rva) { ans = m; lo = m + 1; } else hi = m - 1; }
        return ans >= 0 && rva < ends[ans] ? begins[ans] : null;
    };
}

export function callGraph(path) {
    const buf = fs.readFileSync(path);
    const secs = sections(buf);
    const text = secs.find(s => s.name === ".text");
    const funcs = functions(path);
    const isFunc = new Set(funcs.map(f => f.begin));
    const locate = makeLocator(funcs);
    const mem = buf.subarray(text.rawPtr, text.rawPtr + text.rawSize);

    const callees = new Map();   // caller begin -> [callee begin] in call order
    const callers = new Map();   // callee begin -> Set(caller begin)
    for (let p = 0; p + 5 <= mem.length; p++) {
        const op = mem[p];
        if (op !== 0xe8 && op !== 0xe9) continue;
        const target = text.rva + p + 5 + mem.readInt32LE(p + 1);
        if (!isFunc.has(target)) continue;
        const from = locate(text.rva + p);
        if (from === null || from === target) continue;
        let a = callees.get(from); if (a === undefined) callees.set(from, (a = [])); a.push(target);
        let s = callers.get(target); if (s === undefined) callers.set(target, (s = new Set())); s.add(from);
    }
    return { callees, callers, funcs, text, buf, secs, locate, count: funcs.length };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const g = callGraph(process.argv[2]);
    let edges = 0;
    for (const a of g.callees.values()) edges += a.length;
    console.log(`functions ${g.count}   call sites ${edges}   with callees ${g.callees.size}   with callers ${g.callers.size}`);
}
