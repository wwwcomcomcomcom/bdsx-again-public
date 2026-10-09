/**
 * Find a function by what it must contain, not by what it looks like.
 *
 * Exact bytes do not survive the compiler change and a single wildcard
 * signature is fragile to write blind. This takes the two things that do
 * survive -- a function's size, from .pdata, and the immediate constants its
 * source obliges it to contain -- and intersects them.
 *
 * `std::basic_string<char>::~basic_string` is the motivating case: whatever
 * registers it picks, it must compare capacity against 16, compare the
 * allocation size against 4096, add 39 and compare against 31, because that is
 * what _Deallocate does. Those constants are in the source, not the codegen.
 *
 * Usage:
 *   node tools/find-function.mjs <exe> --size=70..140 \
 *        --has="48 81 ? 00 10 00 00" --has="48 83 ? 27" --has="48 83 ? 1F"
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";

const args = process.argv.slice(2);
const exePath = args[0];
const sizeArg = args.find(a => a.startsWith("--size="))?.slice(7) ?? "1..100000";
const [minSize, maxSize] = sizeArg.split("..").map(Number);
const patterns = args.filter(a => a.startsWith("--has=")).map(a =>
    a.slice(6).trim().split(/\s+/).map(t => (t === "?" ? null : parseInt(t, 16))),
);
const startPat = args.find(a => a.startsWith("--starts="))?.slice(9)
    ?.trim().split(/\s+/).map(t => (t === "?" ? null : parseInt(t, 16)));

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

const contains = (body, pat) => {
    outer: for (let i = 0; i + pat.length <= body.length; i++) {
        for (let k = 0; k < pat.length; k++) if (pat[k] !== null && body[i + k] !== pat[k]) continue outer;
        return true;
    }
    return false;
};
const startsWith = (body, pat) => {
    for (let k = 0; k < pat.length; k++) if (pat[k] !== null && body[k] !== pat[k]) return false;
    return true;
};

const hits = [];
for (const f of functions(exePath)) {
    const size = f.end - f.begin;
    if (size < minSize || size > maxSize) continue;
    if (f.begin < text.rva || f.begin >= text.rva + text.rawSize) continue;
    const off = f.begin - text.rva + text.rawPtr;
    const body = buf.subarray(off, off + size);
    if (startPat && !startsWith(body, startPat)) continue;
    if (!patterns.every(p => contains(body, p))) continue;
    hits.push({ rva: f.begin, size });
}

console.log(`functions ${minSize}..${maxSize} bytes containing all ${patterns.length} pattern(s)${startPat ? " and matching the start pattern" : ""}: ${hits.length}`);
for (const h of hits.slice(0, Number(process.env.LIMIT ?? 20))) console.log(`  0x${h.rva.toString(16)}  ${h.size} bytes`);
