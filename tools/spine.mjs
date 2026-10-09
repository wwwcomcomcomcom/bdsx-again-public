/**
 * Walk the server's startup spine by hand: print a function's callees on the
 * baseline with their PDB names, and on the target with whatever is already
 * known about each callee (a pairs file, a candidate file) plus its size and
 * callee count, so the two lists can be aligned by eye and by anchors.
 *
 * Usage: node tools/spine.mjs <baselineExe> <targetExe> <baseline-slots.json> <pairs.json> <baseFnNameOrRva> <targetFnRva>
 */
import * as fs from "fs";
import { callGraph } from "./callgraph.mjs";
const [bExe, tExe, slotsPath, pairsPath, bWant, tWant] = process.argv.slice(2);
const B = JSON.parse(fs.readFileSync(slotsPath, "utf8"));
const pairs = JSON.parse(fs.readFileSync(pairsPath, "utf8")).pairs;
const rev = new Map(Object.entries(pairs).map(([b, t]) => [t, Number(b)]));
const rvaOf = new Map(); for (const [r, ns] of Object.entries(B.names)) for (const n of ns) rvaOf.set(n, Number(r));
const nm = r => (B.names[r] ?? [])[0] ?? `?0x${r.toString(16)}`;
const bg = callGraph(bExe), tg = callGraph(tExe);
const size = (g, r) => { const f = g.funcs.find(x => x.begin === r); return f ? f.end - f.begin : 0; };
let bRva = /^0x/.test(bWant) ? Number(bWant) : rvaOf.get(bWant);
if (bRva === undefined) { const k = [...rvaOf.keys()].find(n => n.startsWith(bWant)); bRva = rvaOf.get(k); }
const tRva = Number(tWant);
const seq = (g, r) => { const out = [], seen = new Set(); for (const c of g.callees.get(r) ?? []) { if (seen.has(c)) continue; seen.add(c); out.push(c); } return out; };
console.log(`baseline ${nm(bRva).slice(0, 60)} 0x${bRva.toString(16)} (${size(bg, bRva)}B): ${seq(bg, bRva).length} distinct callees`);
seq(bg, bRva).forEach((c, i) => console.log(`  b${String(i).padStart(2)} 0x${c.toString(16).padStart(8)} ${String(size(bg, c)).padStart(6)}B ${String((bg.callees.get(c) ?? []).length).padStart(3)}c  ${pairs[c] !== undefined ? "=> 0x" + pairs[c].toString(16) : "          "}  ${nm(c).slice(0, 80)}`));
console.log(`target 0x${tRva.toString(16)} (${size(tg, tRva)}B): ${seq(tg, tRva).length} distinct callees`);
seq(tg, tRva).forEach((c, i) => console.log(`  t${String(i).padStart(2)} 0x${c.toString(16).padStart(8)} ${String(size(tg, c)).padStart(6)}B ${String((tg.callees.get(c) ?? []).length).padStart(3)}c  ${rev.has(c) ? "<= " + nm(rev.get(c)).slice(0, 70) : ""}`));
