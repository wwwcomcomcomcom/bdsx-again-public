/**
 * Minimal PE reader shared by the vftable tools: sections, RVA <-> file
 * offset, image base, and a .text/.pdata classifier.
 */
import * as fs from "fs";

export function loadPE(path) {
    const buf = fs.readFileSync(path);
    const peOff = buf.readUInt32LE(0x3c);
    const coff = peOff + 4;
    const nSec = buf.readUInt16LE(coff + 2);
    const optOff = coff + 20;
    const imageBase = buf.readBigUInt64LE(optOff + 24);
    const secOff = optOff + buf.readUInt16LE(coff + 16);
    const sections = [];
    for (let i = 0; i < nSec; i++) {
        const o = secOff + i * 40;
        sections.push({
            name: buf.toString("ascii", o, o + 8).replace(/\0+$/, ""),
            rva: buf.readUInt32LE(o + 12),
            vsize: buf.readUInt32LE(o + 8),
            rawSize: buf.readUInt32LE(o + 16),
            rawPtr: buf.readUInt32LE(o + 20),
            chars: buf.readUInt32LE(o + 36),
        });
    }
    const sec = name => sections.find(s => s.name === name);
    const sectionOf = rva => sections.find(s => rva >= s.rva && rva < s.rva + Math.max(s.vsize, s.rawSize));
    const off = rva => {
        const s = sectionOf(rva);
        if (!s) return -1;
        const o = rva - s.rva;
        return o < s.rawSize ? s.rawPtr + o : -1;
    };
    const text = sec(".text");
    const inText = rva => rva >= text.rva && rva < text.rva + text.vsize;
    return { buf, imageBase, sections, sec, sectionOf, off, text, inText };
}

/** .pdata function starts as a Set and sorted array. */
export function pdataFunctions(pe) {
    const p = pe.sec(".pdata");
    const starts = [];
    for (let o = 0; o + 12 <= p.rawSize; o += 12) {
        const b = pe.buf.readUInt32LE(p.rawPtr + o);
        const e = pe.buf.readUInt32LE(p.rawPtr + o + 4);
        if (b === 0 && e === 0) continue;
        starts.push({ begin: b, end: e });
    }
    starts.sort((a, b) => a.begin - b.begin);
    return starts;
}

/**
 * Every .rdata qword address that a `lea r64, [rip+disp32]` in .text points
 * at and that holds a .text pointer: the start of a vftable (or of some other
 * function-pointer table). Returns Map rva -> reference count.
 */
export function referencedPointerTables(pe) {
    const rdata = pe.sec(".rdata");
    const inRdata = r => r >= rdata.rva && r < rdata.rva + rdata.vsize;
    const refs = new Map();
    const { buf, text } = pe;
    const end = text.rawPtr + text.rawSize - 7;
    for (let p = text.rawPtr; p < end; p++) {
        if ((buf[p] & 0xf8) !== 0x48 || buf[p + 1] !== 0x8d || (buf[p + 2] & 0xc7) !== 0x05) continue;
        const target = text.rva + (p - text.rawPtr) + 7 + buf.readInt32LE(p + 3);
        if (!inRdata(target) || (target & 7) !== 0) continue;
        const o = pe.off(target);
        if (o < 0 || o + 8 > buf.length) continue;
        if (!pe.inText(Number(buf.readBigUInt64LE(o) - pe.imageBase))) continue;
        refs.set(target, (refs.get(target) ?? 0) + 1);
    }
    return refs;
}
