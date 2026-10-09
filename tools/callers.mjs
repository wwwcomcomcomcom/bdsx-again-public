/**
 * Direct callers of a function: every `call rel32` / `jmp rel32` in .text that lands on it, grouped by the
 * .pdata function that holds the instruction, with the name the build's merged table gives it.
 *
 *   node tools/callers.mjs <version> 0x<rva> [0x<rva> ...]
 */
import * as fs from "fs";
import { loadPE, pdataFunctions } from "./pe.mjs";

const [v, ...targets] = process.argv.slice(2);
if (!v || targets.length === 0) {
    console.error("usage: node tools/callers.mjs <version> 0x<rva> [0x<rva> ...]");
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
const mergedPath = v === "1.21.3.01" ? "work/names-1.21.3.01.json" : `data/merged-${v}.json`;
const names = new Map();
if (fs.existsSync(mergedPath)) {
    const j = JSON.parse(fs.readFileSync(mergedPath, "utf8"));
    if (j.symbols) for (const [k, r] of Object.entries(j.symbols)) names.set(r, k);
    else for (const [r, k] of Object.entries(j)) names.set(+r, k);
}
const want = new Set(targets.map(t => parseInt(t, 16)));
const { buf, text } = pe;
const hits = new Map();
for (let p = text.rawPtr; p < text.rawPtr + text.rawSize - 5; p++) {
    if (buf[p] !== 0xe8 && buf[p] !== 0xe9) continue;
    const at = text.rva + (p - text.rawPtr);
    const t = at + 5 + buf.readInt32LE(p + 1);
    if (!want.has(t)) continue;
    const f = fnOf(at);
    const key = `${t}`;
    if (!hits.has(key)) hits.set(key, []);
    hits.get(key).push([at, f, buf[p] === 0xe9 ? "jmp" : "call"]);
}
for (const t of want) {
    const l = hits.get(`${t}`) ?? [];
    console.log(`0x${t.toString(16)} ${(names.get(t) ?? "").slice(0, 80)}: ${l.length} site(s)`);
    for (const [at, f, kind] of l) console.log(`  ${kind} at 0x${at.toString(16)} in 0x${f ? f.begin.toString(16) : "?"} (${f ? f.end - f.begin : "?"}) ${f ? (names.get(f.begin) ?? "").slice(0, 90) : ""}`);
}
