// Read a Windows minidump (procdump / WER) on this machine: no debugger, no symbols needed.
//
//   node tools/minidump.mjs <file.dmp> [symbols.json] [--threads] [--mem=0x<addr>[,0x<addr>...]]
//
// Prints the exception (code, access kind and address), the faulting thread's registers, RIP and every
// stack qword that points into a loaded image as module+0xRVA (the same shape as bdsx's [ Fault Capture ],
// docs/findings-gamethread.md), and 0x80 bytes behind each register when the dump holds that memory.
// --threads adds every thread's RIP/RSP and the first image pointers on its stack (for a hang).
// --mem dumps 0x80 bytes at the given addresses. With a symbols table (data/symbols-<v>.json or
// merged-<v>.json), the table names nearest at or below the faulting bedrock_server.exe RVA are listed.
// Streams read: ThreadList (3), ModuleList (4), MemoryList (5), Exception (6), Memory64List (9).
import { readFileSync } from "node:fs";

const [file, ...rest] = process.argv.slice(2);
const opts = rest.filter(a => a.startsWith("--")), symPath = rest.find(a => !a.startsWith("--"));
if (!file) { console.error("usage: node tools/minidump.mjs <file.dmp> [--threads] [--mem=0x..]"); process.exit(2); }
const b = readFileSync(file);
if (b.toString("latin1", 0, 4) !== "MDMP") { console.error("not a minidump"); process.exit(2); }
const u32 = o => b.readUInt32LE(o), u64 = o => b.readBigUInt64LE(o);
const hex = v => "0x" + BigInt(v).toString(16);

const streams = new Map();
for (let i = 0, n = u32(8), dir = u32(12); i < n; i++) {
    const e = dir + i * 12;
    streams.set(u32(e), { size: u32(e + 4), rva: u32(e + 8) });
}

// memory: [start, size, fileOffset]
const mem = [];
if (streams.has(5)) { const s = streams.get(5).rva; for (let i = 0, n = u32(s); i < n; i++) { const d = s + 4 + i * 16; mem.push([u64(d), BigInt(u32(d + 8)), u32(d + 12)]); } }
if (streams.has(9)) {
    const s = streams.get(9).rva; let off = u64(s + 8);
    for (let i = 0n, n = u64(s); i < n; i++) { const d = s + 16 + Number(i) * 16; const size = u64(d + 8); mem.push([u64(d), size, Number(off)]); off += size; }
}
function read(addr, len) {
    for (const [start, size, off] of mem) if (addr >= start && addr + BigInt(len) <= start + size) return b.subarray(off + Number(addr - start), off + Number(addr - start) + len);
    return null;
}

const modules = [];
if (streams.has(4)) {
    const s = streams.get(4).rva;
    for (let i = 0, n = u32(s); i < n; i++) {
        const m = s + 4 + i * 108, nameRva = u32(m + 20);
        const full = b.toString("utf16le", nameRva + 4, nameRva + 4 + u32(nameRva));
        modules.push({ base: u64(m), size: BigInt(u32(m + 8)), name: full.split("\\").pop() });
    }
}
const where = a => { for (const m of modules) if (a >= m.base && a < m.base + m.size) return `${m.name}+${hex(a - m.base)}`; return null; };

const REGS = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
function context(rva) { const r = {}; REGS.forEach((k, i) => { r[k] = u64(rva + 0x78 + i * 8); }); r.rip = u64(rva + 0xf8); return r; }
function stackPointers(rsp, qwords, limit) {
    const out = [];
    for (let i = 0; i < qwords && out.length < limit; i++) {
        const q = read(rsp + BigInt(i * 8), 8); if (!q) break;
        const w = where(q.readBigUInt64LE(0)); if (w) out.push(`[rsp+${hex(i * 8)}] ${w}`);
    }
    return out;
}
function dump(addr, label) {
    const m = read(addr, 0x80); if (!m) return false;
    for (let o = 0; o < 0x80; o += 0x20) {
        const q = [0, 8, 16, 24].map(k => m.readBigUInt64LE(o + k));
        console.log(`   [${label}+${hex(o)}] ${q.map(v => hex(v).padStart(18)).join(" ")}  ${q.map(where).filter(Boolean).join(" ")}`);
    }
    return true;
}

const threads = [];
if (streams.has(3)) {
    const s = streams.get(3).rva;
    for (let i = 0, n = u32(s); i < n; i++) { const t = s + 4 + i * 48; threads.push({ id: u32(t), ctx: context(u32(t + 44)) }); }
}

console.log(`${file}: ${modules.length} modules, ${threads.length} threads, ${mem.length} memory ranges`);
if (streams.has(6)) {
    const s = streams.get(6).rva, tid = u32(s), code = u32(s + 8), addr = u64(s + 24), np = u32(s + 32);
    const info = [...Array(np)].map((_, i) => u64(s + 40 + i * 8));
    const kind = code === 0xc0000005 && np >= 2 ? ` ${["read", "write", "", "", "", "", "", "", "execute"][Number(info[0])] || "?"} of ${hex(info[1])}` : "";
    console.log(`exception ${hex(code)}${kind} at ${hex(addr)} ${where(addr) || "(no module)"}, thread ${tid}`);
    const bds = modules.find(m => /^bedrock_server\.exe$/i.test(m.name));
    if (symPath && bds && addr >= bds.base && addr < bds.base + bds.size) {
        const t = JSON.parse(readFileSync(symPath, "utf8")), syms = t.symbols ?? t, rva = Number(addr - bds.base);
        const near = Object.entries(syms).filter(([, v]) => typeof v === "number" && v <= rva && rva - v < 0x2000).sort((x, y) => y[1] - x[1]).slice(0, 5);
        console.log("   nearest table names at or below the RVA:"); for (const [n, v] of near) console.log(`     +0x${(rva - v).toString(16)}  0x${v.toString(16)}  ${n.slice(0, 100)}`);
    }
    const r = context(u32(s + 164));
    console.log("   " + REGS.map(k => `${k}=${hex(r[k])}`).join(" ") + ` rip=${hex(r.rip)}`);
    console.log("   stack, code pointers only: " + stackPointers(r.rsp, 8192, 32).join(", "));
    const seen = new Map();
    for (const k of REGS) {
        if (k === "rsp") continue;
        if (seen.has(r[k])) { console.log(`   ${k}: same as ${seen.get(r[k])}`); continue; }
        seen.set(r[k], k);
        if (r[k] > 0x10000n && !dump(r[k], k)) console.log(`   ${k}: not in the dump`);
    }
} else console.log("no exception stream (a dump taken on demand, not at a crash)");

if (opts.includes("--threads")) for (const t of threads) {
    console.log(`thread ${t.id}: rip ${hex(t.ctx.rip)} ${where(t.ctx.rip) || "(no module)"} rsp ${hex(t.ctx.rsp)}`);
    console.log("   " + stackPointers(t.ctx.rsp, 2048, 8).join(", "));
}
for (const o of opts) if (o.startsWith("--mem=")) for (const a of o.slice(6).split(",")) if (!dump(BigInt(a), a)) console.log(`${a}: not in the dump`);
