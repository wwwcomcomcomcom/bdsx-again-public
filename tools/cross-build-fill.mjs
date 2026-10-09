/**
 * Fill a required name one 1.26 build ships and the other lacks.
 *
 * Found the hard way: 1.26.51.1 had no Actor::hasType, which bdsx's Actor
 * resolver calls for every mob a hook receives, so every mob-carrying event
 * killed that build while 1.26.40.8 passed (docs/findings-slots.md, "Changed
 * signatures"). Two builds weeks apart share a compiler and most bodies, so a
 * function one table names can be looked for in the other by two routes that
 * do not share a failure:
 *   A. the cross-build pair map (tools/carry-pipeline.mjs: work/derived40to51/
 *      pairs.json and str-pairs.json -- vftable alignment, call edges, strings);
 *   B. the body: same .pdata size (within 3%) and the same leading bytes with
 *      rel32 operands masked, searched over the whole image.
 * A name is accepted when A and B give the same function, or when A is silent
 * and B has exactly one hit in the image. Anything else is printed and left.
 * The name is only as good as its source, and that source is usually call-edge
 * propagation, which has put a 1.5 KB function under Actor::getPosition: so a
 * source whose size is more than three times off the 2024 function's is not
 * carried at all (it is listed as SUSPECT, for a body read).
 * Accessors and constants are per-build data and are not handled here.
 *
 * Usage: node tools/cross-build-fill.mjs <fromVersion> <toVersion> [--out=file]
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";
import { readRva } from "./disas.mjs";
const [from, to, ...rest] = process.argv.slice(2);
const out = rest.find(a => a.startsWith("--out="))?.slice(6);
const req = JSON.parse(fs.readFileSync("data/required-symbols.json", "utf8")).symbols;
const A = JSON.parse(fs.readFileSync(`data/merged-${from}.json`, "utf8")), B = JSON.parse(fs.readFileSync(`data/merged-${to}.json`, "utf8"));
const has = (m, n) => n in m.symbols || n in (m.accessors ?? {}) || n in (m.constants ?? {});
const exeA = `work/bin/${from}/bedrock_server.exe`, exeB = `work/bin/${to}/bedrock_server.exe`;
const fa = functions(exeA), fb = functions(exeB);
// pair maps are stored 40 -> 51; invert when filling the other way
const dir = from < to ? `work/derived${from.split(".")[2]}to${to.split(".")[2]}` : `work/derived${to.split(".")[2]}to${from.split(".")[2]}`;
const pairMap = new Map();
for (const f of ["pairs.json", "str-pairs.json"]) {
    const p = `${dir}/${f}`; if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8")).pairs;
    for (const [k, v] of Array.isArray(j) ? j : Object.entries(j)) { const a = Number(k), b = Number(typeof v === "object" ? v.rva ?? v.target ?? v[0] : v); if (from < to) pairMap.set(a, b); else pairMap.set(b, a); }
}
// leading bytes with call/jmp rel32 and rip-relative disp32 zeroed, crudely: any 4 bytes after e8/e9, and after a modrm 05/0d/15/1d/25/2d/35/3d
function head(exe, rva, len) {
    const b = Buffer.from(readRva(exe, rva, len));
    for (let i = 0; i < b.length - 4; i++) {
        if (b[i] === 0xe8 || b[i] === 0xe9) { b.fill(0, i + 1, i + 5); i += 4; }
        else if ((b[i] & 0xc7) === 0x05 && i > 0 && [0x8b, 0x8d, 0x89, 0x3b, 0x39, 0x03, 0x2b, 0x85, 0x15, 0x25].includes(b[i - 1])) { b.fill(0, i + 1, i + 5); i += 4; }
    }
    return b.toString("hex");
}
const base = JSON.parse(fs.readFileSync("data/baseline-symbols.json", "utf8")); const bsyms = base.symbols ?? base;
const fbase = functions("work/bin/1.21.3.01/bedrock_server.exe"); const baseSize = new Map(fbase.map(e => [e.begin, e.end - e.begin]));
const bySize = new Map(); for (const e of fb) { const s = e.end - e.begin; (bySize.get(s) ?? bySize.set(s, []).get(s)).push(e); }
const result = {}, evidence = {};
for (const s of req) {
    const n = s.name; if (!(n in A.symbols) || has(B, n)) continue;
    const ra = A.symbols[n]; const ea = fa.find(x => x.begin === ra);
    if (!ea) { console.log(`  skip (no .pdata on ${from}) ${n.slice(0, 80)}`); continue; }
    const size = ea.end - ea.begin, len = Math.min(size, 64), ha = head(exeA, ra, len);
    const b0 = bsyms[n] === undefined ? undefined : baseSize.get(bsyms[n]); const ratio = b0 === undefined ? 1 : (size + 8) / (b0 + 8);
    if (ratio > 3 || ratio < 1 / 3) { console.log(`  SUSPECT ${n.slice(0, 67).padEnd(67)} ${from} 0x${ra.toString(16)} ${size}B against ${b0}B in 2024 (${A.origin[n]}): not carried`); continue; }
    const hits = []; for (let d = -Math.ceil(size * 0.03); d <= Math.ceil(size * 0.03); d++) for (const e of bySize.get(size + d) ?? []) if (head(exeB, e.begin, len) === ha) hits.push(e.begin);
    const pa = pairMap.get(ra);
    let pick = null, why = "";
    if (pa !== undefined && hits.includes(pa)) { pick = pa; why = `pair map and body agree (${hits.length} body hit${hits.length > 1 ? "s" : ""})`; }
    else if (pa === undefined && hits.length === 1) { pick = hits[0]; why = "pair map silent, body unique in the image"; }
    console.log(`  ${pick !== null ? "FILL" : "    "} ${n.slice(0, 70).padEnd(70)} ${from} 0x${ra.toString(16)} ${size}B (${A.origin[n]}) -> ${pick !== null ? "0x" + pick.toString(16) + " " + why : `pair ${pa === undefined ? "-" : "0x" + pa.toString(16)}, body hits ${hits.length}${hits.length && hits.length < 4 ? " " + hits.map(h => "0x" + h.toString(16)).join(",") : ""}`}`);
    if (pick !== null) { result[n] = pick; evidence[n] = { from: ra, size, origin: A.origin[n], why }; }
}
console.log(`${Object.keys(result).length} filled`);
if (out) fs.writeFileSync(out, JSON.stringify({ _comment: `Required names ${from} ships and ${to} lacked, carried by tools/cross-build-fill.mjs: the pair map and the body must agree, or the body must be unique in the image where the pair map is silent. Never hook targets; a name is only as good as its source on ${from} (evidence.origin).`, from, to, symbols: result, evidence }, null, 1) + "\n");
