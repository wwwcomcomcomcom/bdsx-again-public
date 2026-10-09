/**
 * Rank candidate functions by how many places call them.
 *
 * Some functions are identifiable by frequency alone.
 * `std::basic_string<char>::~basic_string` is called from everywhere in a C++
 * binary of this size, so among a set of candidates that all look structurally
 * right, the one with an order of magnitude more callers is it.
 *
 * Counts direct `call rel32` only, which is all that matters here.
 *
 * Usage: node tools/rank-by-callers.mjs <exe> <rva> [<rva> ...]
 *        node tools/rank-by-callers.mjs <exe> --stdin
 */
import * as fs from "fs";

const exePath = process.argv[2];
let targets = process.argv.slice(3);
if (targets[0] === "--stdin") targets = fs.readFileSync(0, "utf8").split(/\s+/).filter(Boolean);
const want = new Map(targets.map(t => [Number(t), 0]));

const buf = fs.readFileSync(exePath);
const peOff = buf.readUInt32LE(0x3c), coff = peOff + 4;
const nSec = buf.readUInt16LE(coff + 2), secOff = coff + 20 + buf.readUInt16LE(coff + 16);
let text;
for (let i = 0; i < nSec; i++) {
    const o = secOff + i * 40;
    if (buf.toString("ascii", o, o + 8).replace(/\0+$/, "") === ".text") {
        text = { rva: buf.readUInt32LE(o + 12), rawSize: buf.readUInt32LE(o + 16), rawPtr: buf.readUInt32LE(o + 20) };
    }
}

for (let p = text.rawPtr, end = text.rawPtr + text.rawSize - 5; p < end; p++) {
    if (buf[p] !== 0xe8) continue;                       // call rel32
    const site = text.rva + (p - text.rawPtr);
    const target = site + 5 + buf.readInt32LE(p + 1);
    if (want.has(target)) want.set(target, want.get(target) + 1);
}

const rows = [...want.entries()].sort((a, b) => b[1] - a[1]);
for (const [rva, n] of rows.slice(0, 15)) console.log(`  ${String(n).padStart(7)} callers   0x${rva.toString(16)}`);
