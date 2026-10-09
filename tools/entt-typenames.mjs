/**
 * Every EnTT type name a build carries, read off the binary rather than guessed.
 *
 * Route 10 (docs/findings-components.md) needs a component's *name* to compute
 * fnv1a-32 of it, and the name had to be guessed from Endstone's headers or a
 * 2024 decorated symbol. Both guesses miss: 2024 spells the jump flag
 * `FlagComponent<MobIsJumpingFlag>` and 1.26 spells it
 * `MobIsJumpingFlagComponent`, so the 2024 spelling hashes to zero users.
 *
 * It does not have to be guessed. `entt::type_info<T>` is emitted as a 146-byte
 * function per component that fills a descriptor with the hash, a pointer to the
 * type's name and the name's length, and the three stores are a fixed 25-byte
 * sequence:
 *
 *     c7 40 04 <hash:u32>        movl  $hash, 4(%rax)
 *     48 8d 0d <rel32>           leaq  name(%rip), %rcx
 *     48 89 48 08                movq  %rcx, 8(%rax)
 *     48 c7 40 10 <len:u32>      movq  $len, 16(%rax)
 *
 * Scanning .text for it yields name -> hash for the whole build. The hash is
 * checked against fnv1a-32 of the name that was read, so a false positive from
 * the scan cannot survive.
 *
 *   node tools/entt-typenames.mjs <exe> [--out=f.json] [--grep=<substr>] [--hash=0x...]
 */
import * as fs from "fs";
import { pathToFileURL } from "url";

export function fnv1a32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

function sections(buf) {
    const peOff = buf.readUInt32LE(0x3c), coff = peOff + 4;
    const n = buf.readUInt16LE(coff + 2), secOff = coff + 20 + buf.readUInt16LE(coff + 16);
    const out = [];
    for (let i = 0; i < n; i++) {
        const o = secOff + i * 40;
        out.push({
            name: buf.toString("ascii", o, o + 8).replace(/\0+$/, ""),
            rva: buf.readUInt32LE(o + 12), vsize: buf.readUInt32LE(o + 8),
            rawPtr: buf.readUInt32LE(o + 20), rawSize: buf.readUInt32LE(o + 16),
        });
    }
    return out;
}

export function enttTypeNames(exePath) {
    const buf = fs.readFileSync(exePath);
    const secs = sections(buf);
    const text = secs.find(s => s.name === ".text");
    const fileOff = rva => {
        for (const s of secs) if (rva >= s.rva && rva < s.rva + s.vsize) return s.rawPtr + (rva - s.rva);
        return -1;
    };
    const mem = buf.subarray(text.rawPtr, text.rawPtr + text.rawSize);
    const out = [];
    for (let p = 0; p + 25 <= mem.length; p++) {
        if (mem[p] !== 0xc7 || mem[p + 1] !== 0x40 || mem[p + 2] !== 0x04) continue;
        if (mem[p + 7] !== 0x48 || mem[p + 8] !== 0x8d || mem[p + 9] !== 0x0d) continue;
        if (mem[p + 14] !== 0x48 || mem[p + 15] !== 0x89 || mem[p + 16] !== 0x48 || mem[p + 17] !== 0x08) continue;
        if (mem[p + 18] !== 0x48 || mem[p + 19] !== 0xc7 || mem[p + 20] !== 0x40 || mem[p + 21] !== 0x10) continue;
        const hash = mem.readUInt32LE(p + 3);
        const nameRva = text.rva + p + 14 + mem.readInt32LE(p + 10);
        const len = mem.readUInt32LE(p + 22);
        if (len === 0 || len > 512) continue;
        const o = fileOff(nameRva);
        if (o < 0 || o + len > buf.length) continue;
        const name = buf.toString("latin1", o, o + len);
        if (!/^[\x20-\x7e]+$/.test(name)) continue;
        if (fnv1a32(name) !== hash) continue;   // the hash must be fnv1a of the name that was read
        out.push({ name, hash, rva: text.rva + p, nameRva });
    }
    // one entry per name (the same type_info can be emitted more than once)
    const seen = new Map();
    for (const e of out) if (!seen.has(e.name)) seen.set(e.name, e);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const args = process.argv.slice(2);
    const exe = args.find(a => !a.startsWith("--"));
    const out = args.find(a => a.startsWith("--out="))?.slice(6);
    const grep = args.find(a => a.startsWith("--grep="))?.slice(7);
    const wanted = args.find(a => a.startsWith("--hash="))?.slice(7);
    let list = enttTypeNames(exe);
    if (grep) list = list.filter(e => e.name.toLowerCase().includes(grep.toLowerCase()));
    if (wanted) { const h = parseInt(wanted, 16) >>> 0; list = list.filter(e => e.hash === h); }
    if (out) {
        fs.writeFileSync(out, JSON.stringify(Object.fromEntries(list.map(e => [e.name, "0x" + e.hash.toString(16)])), null, 1));
        console.error(`${list.length} type names -> ${out}`);
    } else {
        for (const e of list) console.log(`0x${e.hash.toString(16).padStart(8, "0")}  ${e.name}`);
        console.error(`${list.length} type names`);
    }
}
