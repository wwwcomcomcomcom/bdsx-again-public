/**
 * Exact function boundaries from the PE exception directory.
 *
 * x64 Windows requires a RUNTIME_FUNCTION { BeginAddress, EndAddress,
 * UnwindInfo } for every non-leaf function, so .pdata is a complete, exact
 * function table that needs no analysis and no PDB. It is the cheapest
 * ground truth available in a stripped binary.
 */
import * as fs from "fs";
import { pathToFileURL } from "url";

export function functions(exePath) {
    const buf = fs.readFileSync(exePath);
    const peOff = buf.readUInt32LE(0x3c);
    const coff = peOff + 4;
    const nSec = buf.readUInt16LE(coff + 2);
    const secOff = coff + 20 + buf.readUInt16LE(coff + 16);
    let pdata;
    for (let i = 0; i < nSec; i++) {
        const o = secOff + i * 40;
        if (buf.toString("ascii", o, o + 8).replace(/\0+$/, "") === ".pdata") {
            pdata = { rva: buf.readUInt32LE(o + 12), rawSize: buf.readUInt32LE(o + 16), rawPtr: buf.readUInt32LE(o + 20) };
        }
    }
    const out = [];
    for (let o = 0; o + 12 <= pdata.rawSize; o += 12) {
        const begin = buf.readUInt32LE(pdata.rawPtr + o);
        const end = buf.readUInt32LE(pdata.rawPtr + o + 4);
        if (begin === 0 && end === 0) continue;
        out.push({ begin, end });
    }
    out.sort((a, b) => a.begin - b.begin);
    return out;
}

/** The function containing an RVA, or null. */
export function containing(funcs, rva) {
    let lo = 0, hi = funcs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rva < funcs[mid].begin) hi = mid - 1;
        else if (rva >= funcs[mid].end) lo = mid + 1;
        else return funcs[mid];
    }
    return null;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const fns = functions(process.argv[2]);
    console.log(`${fns.length} functions in .pdata`);
    for (const rva of process.argv.slice(3).map(Number)) {
        const f = containing(fns, rva);
        console.log(`  0x${rva.toString(16)} -> ${f ? `0x${f.begin.toString(16)}..0x${f.end.toString(16)} (${f.end - f.begin} bytes)` : "no function"}`);
    }
}
