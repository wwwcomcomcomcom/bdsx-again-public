/**
 * Linear disassembly of a PE at a given RVA, with resolved branch targets.
 *
 * llvm-objdump will not disassemble these binaries, and llvm-mc has no notion
 * of addresses. But llvm-mc --show-encoding prints each instruction's bytes,
 * which is enough to track the address ourselves and resolve rel32 call/jmp
 * targets back to RVAs. That is all that is needed to walk the CRT startup
 * chain down to main.
 *
 * Usage: node tools/disas.mjs <exe> <rva> [len]
 *
 * Known flaw: `size` is the length of llvm-mc's re-encoding, not of the original bytes, so an
 * instruction with redundant prefixes (the `66 2e 0f 1f ...` padding MSVC emits) is counted short
 * and every later address drifts. Enough for the CRT chain this was written for; to read a whole
 * function use tools/disas-exact.mjs (docs/findings-packets.md).
 */
import * as fs from "fs";
import { execFileSync } from "child_process";
import { llvm } from "./llvm.mjs";
import { pathToFileURL } from "url";


// These binaries are 40-130MB and the window scanner reads from them tens of
// thousands of times. Reading the file per call is what made the first
// signature sweep unusable.
const fileCache = new Map();
export function loadExe(path) {
    let buf = fileCache.get(path);
    if (buf === undefined) fileCache.set(path, (buf = fs.readFileSync(path)));
    return buf;
}

export function readRva(path, rva, len) {
    const buf = loadExe(path);
    const peOff = buf.readUInt32LE(0x3c);
    const coff = peOff + 4;
    const n = buf.readUInt16LE(coff + 2);
    const optSize = buf.readUInt16LE(coff + 16);
    const secOff = coff + 20 + optSize;
    for (let i = 0; i < n; i++) {
        const o = secOff + i * 40;
        const va = buf.readUInt32LE(o + 12), vs = buf.readUInt32LE(o + 8);
        const rs = buf.readUInt32LE(o + 16), rp = buf.readUInt32LE(o + 20);
        if (rva >= va && rva < va + Math.max(vs, rs)) {
            return buf.subarray(rva - va + rp, rva - va + rp + len);
        }
    }
    throw Error(`RVA 0x${rva.toString(16)} not mapped`);
}

export function disas(path, rva, len = 256) {
    const bytes = readRva(path, rva, len);
    const hex = [...bytes].map(b => "0x" + b.toString(16).padStart(2, "0")).join(" ");
    const out = execFileSync(llvm("llvm-mc"), ["--disassemble", "--show-encoding", "--triple=x86_64-pc-win32"], {
        input: hex,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
    });

    const insns = [];
    let addr = rva;
    for (const line of out.split("\n")) {
        const m = line.match(/^\s*(.+?)\s*#\s*encoding:\s*\[(.+)\]\s*$/);
        if (!m) continue;
        const text = m[1].trim();
        const enc = m[2].split(",").map(s => s.trim());
        const size = enc.length;
        let target = null;
        // llvm-mc renders rel32 branches as displacements from the END of the
        // instruction, which is exactly what x86 encodes.
        const br = text.match(/^(callq|jmp|je|jne)\s+(-?\d+)$/);
        if (br) target = addr + size + Number(br[2]);
        const bytes = enc.map(h => parseInt(h, 16));
        insns.push({ rva: addr, size, text, target, bytes });
        addr += size;
    }
    return insns;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const [path, rvaStr, lenStr] = process.argv.slice(2);
    for (const i of disas(path, Number(rvaStr), Number(lenStr ?? 256))) {
        const t = i.target !== null ? `   -> 0x${i.target.toString(16)}` : "";
        console.log(`0x${i.rva.toString(16).padStart(8, "0")}  ${i.text.padEnd(38)}${t}`);
    }
}
