/**
 * Imported functions of a PE, and the .text thunks that reach them.
 *
 * An import is named in the import directory, so unlike everything derived
 * from code bytes it is exact rather than inferred -- the same property that
 * made tools/find-gamethread.mjs work where no signature could. A call to an
 * import goes through a `jmp [rip+slot]` thunk, so a function's imports are
 * recovered by finding the thunks and then the calls that reach them.
 */
import * as fs from "fs";
import { sections } from "./callgraph.mjs";

export function importTable(buf, secs) {
    const toOff = rva => {
        for (const s of secs) {
            const size = Math.max(s.vsize, s.rawSize);
            if (rva >= s.rva && rva < s.rva + size) return rva - s.rva + s.rawPtr;
        }
        return -1;
    };
    const peOff = buf.readUInt32LE(0x3c), opt = peOff + 24;
    const dirs = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96);
    const impRva = buf.readUInt32LE(dirs + 8);
    const bySlot = new Map();
    if (impRva === 0) return bySlot;
    for (let d = toOff(impRva); ; d += 20) {
        const origFirst = buf.readUInt32LE(d), nameRva = buf.readUInt32LE(d + 12), firstThunk = buf.readUInt32LE(d + 16);
        if (origFirst === 0 && nameRva === 0 && firstThunk === 0) break;
        const dllOff = toOff(nameRva);
        const dll = buf.toString("latin1", dllOff, buf.indexOf(0, dllOff)).toLowerCase();
        let lookup = toOff(origFirst || firstThunk), slot = firstThunk;
        for (; ; lookup += 8, slot += 8) {
            const entry = buf.readBigUInt64LE(lookup);
            if (entry === 0n) break;
            if (entry & (1n << 63n)) { bySlot.set(slot, `${dll}#${entry & 0xffffn}`); continue; }
            const h = toOff(Number(entry));
            if (h < 0) continue;
            bySlot.set(slot, `${dll}!${buf.toString("latin1", h + 2, buf.indexOf(0, h + 2))}`);
        }
    }
    return bySlot;
}

/** functionBegin -> Set(importName), for every function that calls one. */
export function importsByFunction(path, locate) {
    const buf = fs.readFileSync(path);
    const secs = sections(buf);
    const text = secs.find(s => s.name === ".text");
    const bySlot = importTable(buf, secs);
    const mem = buf.subarray(text.rawPtr, text.rawPtr + text.rawSize);

    // slot -> name, then thunk rva -> name
    const thunkName = new Map();
    for (let p = 0; p + 6 <= mem.length; p++) {
        if (mem[p] !== 0xff || mem[p + 1] !== 0x25) continue;
        const name = bySlot.get(text.rva + p + 6 + mem.readInt32LE(p + 2));
        if (name !== undefined) thunkName.set(text.rva + p, name);
    }

    const out = new Map();
    const add = (fn, name) => {
        let s = out.get(fn);
        if (s === undefined) out.set(fn, (s = new Set()));
        s.add(name);
    };
    for (let p = 0; p + 6 <= mem.length; p++) {
        const op = mem[p];
        if (op === 0xe8 || op === 0xe9) {
            const name = thunkName.get(text.rva + p + 5 + mem.readInt32LE(p + 1));
            if (name === undefined) continue;
            const fn = locate(text.rva + p);
            if (fn !== null) add(fn, name);
        } else if (op === 0xff && mem[p + 1] === 0x15) {
            // call [rip+disp] straight through the IAT, no thunk
            const name = bySlot.get(text.rva + p + 6 + mem.readInt32LE(p + 2));
            if (name === undefined) continue;
            const fn = locate(text.rva + p);
            if (fn !== null) add(fn, name);
        }
    }
    return { byFunction: out, importCount: new Set(bySlot.values()).size, thunks: thunkName.size };
}
