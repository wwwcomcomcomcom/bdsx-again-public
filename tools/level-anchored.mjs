/**
 * Level virtuals by Endstone's header order, anchored on the confirmed slots.
 *
 * Endstone's ILevel/Level headers lay out one slot more than the live table
 * (tools/endstone-slots.mjs refuses the family at its length gate), and the
 * confirmed names show where: between header slot 35 and 380 every anchor
 * sits exactly one slot above its header index (delta -1). The region once
 * stopped at 288 because getGameRules seemed to sit at live 348 against
 * header 341; that anchor was the error (slot 348 returns Abilities; the
 * GameRules pair is at 342/343 = header+1, docs/findings-slots.md). So names
 * whose header slot lies in the anchored region are read at header+1, nothing
 * outside. The second route is the other 1.26 build: its own header revision
 * (HEAD carries the slot 1.26.51.1 inserted, `unknown347`) puts the same name
 * at the same live slot, or one later past the insertion, with the same
 * function size (--pair). Overloaded names are skipped (their order needs a
 * body check), and so is a leaf with no .pdata entry unless its bytes match.
 *
 * Usage: node tools/endstone-slots.mjs <endstoneDir> <v> <es-level.json> --families=level
 *        node tools/level-anchored.mjs <v> <es-level.json> [--lo=1] [--hi=380] [--pair=other-out.json] [--out=file]
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";
import { readRva } from "./disas.mjs";
const [v, esPath, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const a = rest.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const LO = Number(opt("lo", 1)), HI = Number(opt("hi", 380));
const slots = JSON.parse(fs.readFileSync(esPath, "utf8")).families.level.slots;
const req = JSON.parse(fs.readFileSync("data/required-symbols.json", "utf8")).symbols.map(s => s.name);
const M = JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8")); const m = M.symbols, o = M.origin ?? {};
const inst = JSON.parse(fs.readFileSync(`data/candidates-instances-${v}.json`, "utf8")).vftables;
const S = JSON.parse(fs.readFileSync(`work/vft/scan-${v}.json`, "utf8")); const vt = Array.isArray(S.vftables) ? S.vftables : Object.values(S.vftables);
const t = vt.find(x => x.rva === inst["??_7ServerLevel@@6BILevel@@@"]);
const fns = functions(`work/bin/${v}/bedrock_server.exe`);
const size = r => { const e = fns.find(x => x.begin === r); return e ? e.end - e.begin : 0; };
// anchors: exact names already in the table, with their header index, to show the delta the region rests on
const by = new Map(); for (const [n, r] of Object.entries(m)) (by.get(r) ?? by.set(r, []).get(r)).push(n);
console.log(`${v}: live table ${t.slots.length} slots, header ${slots.length}; anchors:`);
t.slots.forEach((s, i) => { const ns = (by.get(s) ?? []).filter(n => /@(Level|ServerLevel)@@/.test(n) && /resolved|endstone/.test(o[n] ?? "")); if (!ns.length) return; const meth = ns[0].match(/^\?(\w+)@/)?.[1]; const idx = slots.map((x, k) => x.name === meth ? k : -1).filter(k => k >= 0); console.log(`  live ${i} header ${idx.join("/")} delta ${idx.length ? idx[0] - i : "?"} ${meth}`); });
const out = {};
for (const n of req) {
    const mm = n.match(/^\?(\w+)@(Level|ServerLevel)@@UE[AB]A/); if (!mm || n in m) continue;
    const idx = slots.map((x, k) => x.name === mm[1] ? k : -1).filter(k => k >= 0);
    if (idx.length !== 1) continue;
    const h = idx[0]; if (h < LO || h > HI) continue;
    const live = h + 1, rva = t.slots[live];
    // a leaf has no .pdata entry and so no size: its first seven bytes (the load, for a getter or a
    // forwarder to a manager) stand in for it in the pair check
    out[n] = { slot: live, headerSlot: h, rva, size: size(rva), head: readRva(`work/bin/${v}/bedrock_server.exe`, rva, 7).toString("hex") };
}
const pair = opt("pair") ? JSON.parse(fs.readFileSync(opt("pair"), "utf8")).candidates : null;
let agree = 0;
for (const [n, x] of Object.entries(out)) { const y = pair?.[n]; const ok = y && (y.slot === x.slot || Math.abs(y.slot - x.slot) === 1 && y.slot - x.slot === y.headerSlot - x.headerSlot) && (x.size === 0 ? y.size === 0 && x.head === y.head : x.size === y.size || (x.size && y.size && Math.abs(x.size - y.size) / x.size < 0.2)); if (ok) agree++; console.log(`  ${ok ? "AGREE" : pair ? "     " : ""} slot ${x.slot} ${x.size ? x.size + "B" : x.head} ${n.slice(0, 70)}${y ? ` | other: slot ${y.slot} ${y.size}B` : ""}`); }
console.log(`${Object.keys(out).length} names in the anchored region${pair ? `, ${agree} agree with the pair on slot and size` : ""}`);
if (opt("out")) fs.writeFileSync(opt("out"), JSON.stringify({ version: v, table: t.rva, lo: LO, hi: HI, candidates: out }, null, 1) + "\n");
