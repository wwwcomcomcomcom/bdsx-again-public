/**
 * Find code that calls or jumps through a given import (IAT) slot.
 *
 * Imports are the one thing in a stripped binary that still has names, and
 * their addresses come straight out of the PE header rather than from
 * analysis. That makes them a strong anchor for the thin CRT wrappers bdsx
 * needs -- vsnprintf is a handful of instructions ending in a tail jump
 * through __stdio_common_vsprintf's slot -- and unlike a byte pattern it does
 * not care which compiler emitted the wrapper.
 *
 * Usage: node tools/iat-refs.mjs <exe> <iatSlotRva>
 */
import * as fs from "fs";

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

// call [rip+d] = FF 15 d32 ; jmp [rip+d] = FF 25 d32 ; both optionally REX-prefixed
const refs = [];
const end = text.rawPtr + text.rawSize - 6;
for (let p = text.rawPtr; p < end; p++) {
    if (buf[p] !== 0xff) continue;
    const modrm = buf[p + 1];
    if (modrm !== 0x15 && modrm !== 0x25) continue;
    const disp = buf.readInt32LE(p + 2);
    const insnRva = text.rva + (p - text.rawPtr);
    if (insnRva + 6 + disp !== slot) continue;
    refs.push({ rva: insnRva, kind: modrm === 0x15 ? "call" : "jmp", rex: buf[p - 1] >= 0x40 && buf[p - 1] <= 0x4f });
}

console.log(`references to IAT slot 0x${slot.toString(16)}: ${refs.length}`);
for (const r of refs) console.log(`  0x${r.rva.toString(16)}  ${r.kind}${r.rex ? " (rex-prefixed)" : ""}`);
