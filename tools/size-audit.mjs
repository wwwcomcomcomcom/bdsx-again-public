/**
 * The reading list for docs/next-steps.md 4g: required names a build takes from a route that never read
 * the function (anything but resolved / instances / packets) whose .pdata size is more than `--ratio`
 * times off their 2024 namesake's. Not a veto -- ECS turned many 50-byte getters into 250-byte component
 * lookups -- but every wrong name found by hand so far was on this list (Actor::getPosition 27 -> 1,528,
 * Actor::getRuntimeID 56 -> 1,543, Actor::getRotation 27 -> 651).
 *
 * Usage: node tools/size-audit.mjs <version> [--ratio=3]
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";
const [v, ...rest] = process.argv.slice(2);
const R = Number(rest.find(a => a.startsWith("--ratio="))?.slice(8) ?? 3);
const req = JSON.parse(fs.readFileSync("data/required-symbols.json", "utf8")).symbols;
const base = JSON.parse(fs.readFileSync("data/baseline-symbols.json", "utf8")); const bs = base.symbols ?? base;
const szb = new Map(functions("work/bin/1.21.3.01/bedrock_server.exe").map(e => [e.begin, e.end - e.begin]));
const m = JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8"));
const sz = new Map(functions(`work/bin/${v}/bedrock_server.exe`).map(e => [e.begin, e.end - e.begin]));
const rows = []; let n = 0;
for (const s of req) {
    const a = m.symbols[s.name]; if (a === undefined || s.name.startsWith("??_7") || ["resolved", "instances", "packets"].includes(m.origin[s.name])) continue;
    n++; const b = bs[s.name]; if (b === undefined) continue;
    const sb = szb.get(b) ?? 0, st = sz.get(a) ?? 0, ratio = (st + 8) / (sb + 8);
    if (ratio > R || ratio < 1 / R) rows.push([ratio, s.name, m.origin[s.name], sb, st, a]);
}
rows.sort((x, y) => y[0] - x[0]);
console.log(`${v}: ${n} low-trust required function names, ${rows.length} more than ${R}x off their 2024 size`);
for (const r of rows) console.log(`  ${r[0].toFixed(1).padStart(6)} ${String(r[3]).padStart(5)} -> ${String(r[4]).padStart(5)} ${r[2].padEnd(14)} 0x${r[5].toString(16).padEnd(8)} ${r[1].slice(0, 90)}`);
