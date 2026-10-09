/**
 * Locate bdsx's game-thread hook site without a symbol table.
 *
 * bdsx/launcher.ts patches std::thread::_Invoke<std::tuple<<lambda_261...>>,0>
 * and needs the lambda's operator() as well. Both are unnamed in the target and
 * neither carries a string, so neither string anchoring nor any byte technique
 * reaches them. They do not need to be reached: launcher.ts already states the
 * exact code it patches, and that code names an import.
 *
 *     48 8B D9              mov rbx, rcx
 *     E8 rel32              call <lambda_261...>::operator()
 *     E8 rel32              call _Cnd_do_broadcast_at_thread_exit
 *
 * _Cnd_do_broadcast_at_thread_exit is imported from msvcp140.dll, so its IAT
 * slot is named in the import directory -- exact, not inferred. Its thunk is
 * the one instruction in .text that jumps through that slot; the call sites are
 * every E8 reaching that thunk; and the one with `mov rbx,rcx; call` in front
 * of it is the site launcher.ts describes. The containing .pdata function is
 * _Invoke, and the first call's target is the lambda.
 *
 * Nothing here is a guess, so the failure mode is finding zero or several
 * rather than finding the wrong one. Both are reported rather than resolved.
 *
 * Usage: node tools/find-gamethread.mjs <exe> [importName]
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";
import { sections, makeLocator } from "./callgraph.mjs";

const [exePath, wantName = "_Cnd_do_broadcast_at_thread_exit"] = process.argv.slice(2);
const buf = fs.readFileSync(exePath);
const secs = sections(buf);
const text = secs.find(s => s.name === ".text");

const toOff = rva => {
    for (const s of secs) {
        const size = Math.max(s.vsize, s.rawSize);
        if (rva >= s.rva && rva < s.rva + size) return rva - s.rva + s.rawPtr;
    }
    return -1;
};

// --- import directory: name -> IAT slot RVA
const peOff = buf.readUInt32LE(0x3c), opt = peOff + 24;
const magic = buf.readUInt16LE(opt);
const dirs = opt + (magic === 0x20b ? 112 : 96);
const impRva = buf.readUInt32LE(dirs + 8);
const imports = new Map();
for (let d = toOff(impRva); ; d += 20) {
    const origFirst = buf.readUInt32LE(d), nameRva = buf.readUInt32LE(d + 12), firstThunk = buf.readUInt32LE(d + 16);
    if (origFirst === 0 && nameRva === 0 && firstThunk === 0) break;
    const dllOff = toOff(nameRva);
    const dllEnd = buf.indexOf(0, dllOff);
    const dll = buf.toString("latin1", dllOff, dllEnd);
    let lookup = toOff(origFirst || firstThunk), slot = firstThunk;
    for (; ; lookup += 8, slot += 8) {
        const entry = buf.readBigUInt64LE(lookup);
        if (entry === 0n) break;
        if (entry & (1n << 63n)) continue;            // imported by ordinal, no name
        const hintOff = toOff(Number(entry));
        if (hintOff < 0) continue;
        const end = buf.indexOf(0, hintOff + 2);
        imports.set(buf.toString("latin1", hintOff + 2, end), { slot, dll });
    }
}

const imp = imports.get(wantName);
if (!imp) {
    console.error(`${wantName} is not imported by ${exePath}`);
    process.exit(1);
}
console.log(`${wantName}  <-  ${imp.dll}   IAT slot rva 0x${imp.slot.toString(16)}`);

const mem = buf.subarray(text.rawPtr, text.rawPtr + text.rawSize);

// --- the thunk: jmp [rip+disp] landing on that slot
const thunks = [];
for (let p = 0; p + 6 <= mem.length; p++) {
    if (mem[p] !== 0xff || mem[p + 1] !== 0x25) continue;
    if (text.rva + p + 6 + mem.readInt32LE(p + 2) === imp.slot) thunks.push(text.rva + p);
}
console.log(`import thunks: ${thunks.map(t => "0x" + t.toString(16)).join(", ") || "none"}`);

// --- call sites reaching a thunk, and the launcher.ts shape in front of them
const locate = makeLocator(functions(exePath));
const isThunk = new Set(thunks);
const sites = [];
for (let p = 0; p + 5 <= mem.length; p++) {
    if (mem[p] !== 0xe8) continue;
    if (!isThunk.has(text.rva + p + 5 + mem.readInt32LE(p + 1))) continue;
    const callRva = text.rva + p;
    const prev = p - 5;                                 // the preceding E8 rel32
    const shape = prev - 3;                             // 48 8B D9
    const matched = prev >= 3 && mem[prev] === 0xe8 &&
        mem[shape] === 0x48 && mem[shape + 1] === 0x8b && mem[shape + 2] === 0xd9;
    sites.push({
        callRva, matched,
        lambda: matched ? text.rva + prev + 5 + mem.readInt32LE(prev + 1) : null,
        fn: locate(callRva),
        patchRva: matched ? text.rva + shape : null,
    });
}

const hits = sites.filter(s => s.matched);
console.log(`calls to it: ${sites.length}   matching "mov rbx,rcx; call; call": ${hits.length}\n`);
for (const h of hits) {
    const f = functions(exePath).find(x => x.begin === h.fn);
    console.log(`std::thread::_Invoke<std::tuple<<lambda_...> >,0>   0x${h.fn?.toString(16)}  (${f ? f.end - f.begin : "?"} bytes)`);
    console.log(`  patch site (launcher.ts offset)                  0x${h.patchRva.toString(16)}  = fn + ${h.patchRva - h.fn}`);
    console.log(`  <lambda_...>::operator()                         0x${h.lambda.toString(16)}`);
}
if (hits.length === 0) {
    console.log("no site matches; nearest call sites and their containing functions:");
    for (const s of sites.slice(0, 10)) console.log(`  call 0x${s.callRva.toString(16)}  in fn 0x${s.fn?.toString(16)}`);
}
