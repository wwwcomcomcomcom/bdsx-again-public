/**
 * Which functions use a string, found two ways (docs/findings-nbt.md).
 *
 *   node tools/string-users.mjs <version> <string> [<string> ...] [--any]
 *
 * - "lea": a `lea r, [rip+disp32]` in .text that lands on the NUL-terminated literal in .rdata (every copy).
 * - "imm": the string's bytes inside .text itself. 1.26 builds short keys (at most 15 bytes, MSVC's SSO buffer) with
 *   `movabs`/`mov` immediates, so a save path that writes "IsGlobal" holds the bytes and no literal: Actor::save was
 *   found that way when the literals only led to Actor::load. A key longer than 8 bytes is split into a `movabs`
 *   (the first 8) and smaller moves, so the search uses the first 8 bytes; strings under 4 bytes are not searched.
 *
 * Prints each string's users, then the functions that use every string (or any, with --any), with .pdata size and
 * the name the build's merged table gives the function.
 */
import * as fs from "fs";
import { loadPE, pdataFunctions } from "./pe.mjs";

const args = process.argv.slice(2);
const any = args.includes("--any");
const [v, ...strs] = args.filter(a => a !== "--any");
if (!v || strs.length === 0) {
    console.error("usage: node tools/string-users.mjs <version> <string> [<string> ...] [--any]");
    process.exit(2);
}
const pe = loadPE(`work/bin/${v}/bedrock_server.exe`);
const funcs = pdataFunctions(pe);
const fnOf = r => {
    let lo = 0, hi = funcs.length - 1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (funcs[m].begin <= r) lo = m + 1;
        else hi = m - 1;
    }
    const f = funcs[hi];
    return f && r < f.end ? f : null;
};
const mergedPath = `data/merged-${v}.json`;
const names = new Map();
if (fs.existsSync(mergedPath)) for (const [k, r] of Object.entries(JSON.parse(fs.readFileSync(mergedPath, "utf8")).symbols)) names.set(r, k);

const { buf, text } = pe;
const rdata = pe.sec(".rdata");
const textEnd = text.rawPtr + text.rawSize;
const sets = [];
for (const s of strs) {
    const users = new Map(); // begin -> {size, how:Set}
    const add = (at, how) => {
        const f = fnOf(at);
        if (!f) return;
        if (!users.has(f.begin)) users.set(f.begin, { size: f.end - f.begin, how: new Set() });
        users.get(f.begin).how.add(how);
    };
    const lit = Buffer.from(s + "\0");
    const locs = new Set();
    for (let i = rdata.rawPtr; (i = buf.indexOf(lit, i)) >= 0 && i < rdata.rawPtr + rdata.rawSize; i++) locs.add(rdata.rva + i - rdata.rawPtr);
    for (let p = text.rawPtr + 3; p < textEnd - 4; p++) {
        if (buf[p - 2] !== 0x8d) continue; // lea r64, [rip+disp32]: 48/4c 8d modrm disp32
        const t = text.rva + (p - text.rawPtr) + 4 + buf.readInt32LE(p);
        if (locs.has(t)) add(text.rva + p - text.rawPtr, "lea");
    }
    if (s.length >= 4) {
        const raw = Buffer.from(s.slice(0, 8));
        for (let i = text.rawPtr; (i = buf.indexOf(raw, i)) >= 0 && i < textEnd; i++) add(text.rva + i - text.rawPtr, "imm");
    }
    console.log(`"${s}": ${locs.size} literal(s); ${users.size} function(s): ` + [...users].map(([b, u]) => `0x${b.toString(16)}(${u.size},${[...u.how].join("+")})`).join(" "));
    sets.push(users);
}
const all = any ? [...new Set(sets.flatMap(s => [...s.keys()]))] : [...sets[0].keys()].filter(f => sets.every(s => s.has(f)));
console.log(any ? "-- functions using any:" : "-- functions using all:");
for (const f of all.sort((a, b) => a - b)) {
    const size = sets.find(s => s.has(f)).get(f).size;
    console.log(`0x${f.toString(16)}  ${String(size).padStart(6)}  ${(names.get(f) ?? "").slice(0, 100)}`);
}
