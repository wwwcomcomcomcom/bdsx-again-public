/**
 * Find data constants by who references them, not by what bytes they are.
 *
 * A dword equal to 1 is not a distinguishing feature -- there are tens of
 * thousands. What distinguishes SharedConstants::MajorVersion is that some
 * single function loads it alongside MinorVersion, PatchVersion and
 * RevisionVersion to build the version string. So: take every .rdata dword
 * holding a value we expect, find every RIP-relative reference to it from
 * .text, and look for a code window that touches one candidate of each value.
 *
 * References are found without disassembling: an x86-64 RIP-relative operand
 * is a disp32 whose target is (end of instruction) + disp32. Scanning every
 * offset for a disp32 that lands on a candidate over-generates, but the
 * clustering step discards the noise -- and unlike byte-pattern matching this
 * survives a compiler change, because it anchors on data layout rather than
 * instruction selection.
 *
 * Usage: node tools/xref-scan.mjs <exe> <value>[,<value>...] [windowBytes]
 */
import * as fs from "fs";

function sections(buf) {
    const peOff = buf.readUInt32LE(0x3c);
    const coff = peOff + 4;
    const n = buf.readUInt16LE(coff + 2);
    const optSize = buf.readUInt16LE(coff + 16);
    const secOff = coff + 20 + optSize;
    const out = [];
    for (let i = 0; i < n; i++) {
        const o = secOff + i * 40;
        out.push({
            name: buf.toString("ascii", o, o + 8).replace(/\0+$/, ""),
            rva: buf.readUInt32LE(o + 12),
            vsize: buf.readUInt32LE(o + 8),
            rawSize: buf.readUInt32LE(o + 16),
            rawPtr: buf.readUInt32LE(o + 20),
        });
    }
    return out;
}

const [exePath, valuesArg, windowArg] = process.argv.slice(2);
const WANT = valuesArg.split(",").map(Number);
const WINDOW = Number(windowArg ?? 512);

const buf = fs.readFileSync(exePath);
const secs = sections(buf);
const text = secs.find(s => s.name === ".text");
// Constants can land in any initialised data section; lld does not place them
// the same way MSVC's linker does, so do not assume .rdata.
const data = secs.filter(s => s !== text && s.rawSize > 0 && !/^\.(pdata|reloc|rsrc|tls)$/.test(s.name));

// 1. every data dword holding a value we are looking for
const candidates = new Map(); // rva -> value
for (const sec of data) {
    for (let o = 0; o + 4 <= sec.rawSize; o += 4) {
        const v = buf.readInt32LE(sec.rawPtr + o);
        if (WANT.includes(v)) candidates.set(sec.rva + o, v);
    }
}
console.log(`scanned sections: ${data.map(s => s.name).join(" ")}`);
console.log(`data dwords matching {${WANT}}: ${candidates.size}`);

// 2. every RIP-relative reference from .text to one of them
const dataLo = Math.min(...data.map(s => s.rva));
const dataHi = Math.max(...data.map(s => s.rva + Math.max(s.vsize, s.rawSize)));
const refs = []; // {codeRva, targetRva, value}
const end = text.rawPtr + text.rawSize - 4;
for (let p = text.rawPtr; p < end; p++) {
    const disp = buf.readInt32LE(p);
    if (disp === 0) continue;
    const codeRva = text.rva + (p - text.rawPtr);
    const target = codeRva + 4 + disp;
    if (target < dataLo || target >= dataHi) continue;
    const v = candidates.get(target);
    if (v !== undefined) refs.push({ codeRva, targetRva: target, value: v });
}
console.log(`references into the candidate set: ${refs.length}`);

// 3. code windows that touch one candidate of every wanted value
refs.sort((a, b) => a.codeRva - b.codeRva);
const hits = [];
for (let i = 0; i < refs.length; i++) {
    const seen = new Map(); // value -> targetRva
    for (let j = i; j < refs.length && refs[j].codeRva - refs[i].codeRva <= WINDOW; j++) {
        if (!seen.has(refs[j].value)) seen.set(refs[j].value, refs[j].targetRva);
    }
    if (seen.size === WANT.length) {
        hits.push({ codeRva: refs[i].codeRva, span: seen });
    }
}

// Collapse overlapping windows that resolve to the same set of targets.
const uniq = new Map();
for (const h of hits) {
    const key = WANT.map(v => h.span.get(v)).join(",");
    if (!uniq.has(key)) uniq.set(key, h);
}

console.log(`\nwindows (<= ${WINDOW} bytes) touching one of each value: ${uniq.size}`);
for (const [key, h] of uniq) {
    console.log(`  code 0x${h.codeRva.toString(16)}`);
    for (const v of WANT) console.log(`    ${String(v).padStart(6)} -> 0x${h.span.get(v).toString(16)}`);
}
