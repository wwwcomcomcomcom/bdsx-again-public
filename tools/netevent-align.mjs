/**
 * Name the ServerNetworkHandler packet handlers (NetEventCallback virtuals)
 * on a 1.26 build by the baseline's local pattern of overrides.
 *
 * The 253/255-slot table is mostly one folded default handler; the ~70
 * overrides sit in declaration order, and new packets' handlers are added
 * at the front, so slot indices do not carry but the *run* of overrides
 * around one does (docs/findings-instances.md, "playerJoin"). For every
 * baseline override the mask window around it is searched in the target
 * mask, widest first; a unique hit at the widest window that hits at all is
 * the candidate, an ambiguous one is dropped. Then: target slots must keep
 * the baseline's order (insertions only), the function must not be the stub,
 * and the size ratio to the baseline body must be sane. A second build run
 * through the same tool gives the cross-build check (`--pair`).
 *
 * Usage: node tools/netevent-align.mjs <version> <tableRva> [--out=file] [--pair=other-candidates.json]
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";
import { callGraph } from "./callgraph.mjs";
const [v, tableArg, ...rest] = process.argv.slice(2);
const opt = k => (rest.find(a => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=");
const B = JSON.parse(fs.readFileSync("work/vft/baseline-slots.json", "utf8"));
const b = JSON.parse(fs.readFileSync("data/baseline-symbols.json", "utf8")).symbols;
const bt = Object.values(B.vftables).find(t => t.rva === b["??_7ServerNetworkHandler@@6BNetEventCallback@@@"]);
const mode = arr => { const c = new Map(); for (const x of arr) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0][0]; };
const bstub = mode(bt.slots), bmask = bt.slots.map(s => s === bstub ? "." : "#").join("");
const bfns = functions("work/bin/1.21.3.01/bedrock_server.exe"), bg = callGraph("work/bin/1.21.3.01/bedrock_server.exe");
const S = JSON.parse(fs.readFileSync(`work/vft/scan-${v}.json`, "utf8")); const vt = Array.isArray(S.vftables) ? S.vftables : Object.values(S.vftables);
const tt = vt.find(t => t.rva === Number(tableArg)); if (!tt) throw new Error("no table at " + tableArg);
const tstub = mode(tt.slots), tmask = tt.slots.map(s => s === tstub ? "." : "#").join("");
const tfns = functions(`work/bin/${v}/bedrock_server.exe`), tg = callGraph(`work/bin/${v}/bedrock_server.exe`);
const size = (fns, r) => { const e = fns.find(x => x.begin === r); return e ? e.end - e.begin : 0; };
const nameOf = i => (B.names[bt.slots[i]] ?? []).find(n => /^\?handle@ServerNetworkHandler@@UEAAXAEBVNetworkIdentifier@@AEBV\w+@@@Z$/.test(n)) ?? (B.names[bt.slots[i]] ?? []).find(n => /@ServerNetworkHandler@@/.test(n));
const out = [], rows = [];
for (let i = 0; i < bt.slots.length; i++) {
    if (bmask[i] !== "#") continue; const name = nameOf(i); if (!name) continue;
    // the fixed prologue (slots 0-12: onConnect, onTick, onDisconnect, ...) is a periodic mask that aligns two
    // slots off; Endstone's net_event_callback.h is the source for those, so only packet handlers are matched
    if (i < 13) { rows.push([i, name, "-", "prologue: Endstone's order, not the mask"]); continue; }
    let pick = null, reason = "";
    const MINWIN = Number(opt("minwin") || 6);   // a ±3 window is a coin toss in a table this repetitive
    for (let r = 12; r >= MINWIN; r--) {
        const lo = Math.max(0, i - r), pat = bmask.slice(lo, i + r + 1), center = i - lo;
        const hits = []; let k = -1; while ((k = tmask.indexOf(pat, k + 1)) >= 0) hits.push(k + center);
        if (hits.length === 1) { pick = hits[0]; reason = `window ±${r} unique`; break; }
        if (hits.length > 1) { reason = `window ±${r}: ${hits.length} hits`; break; }
    }
    if (pick === null) { rows.push([i, name, "-", reason || "no window hit"]); continue; }
    const bsz = size(bfns, bt.slots[i]), tsz = size(tfns, tt.slots[pick]);
    const ratio = bsz && tsz ? tsz / bsz : 0;
    // no size gate: the 2024 handlers were wrappers that 1.26 inlined the callee into (Disconnect 204B -> 786B is right)
    let verdict = "ok";
    if (tt.slots[pick] === tstub) verdict = "target slot is the stub";
    rows.push([i, name, pick, `${reason}; ${bsz}B -> ${tsz}B; callees ${(bg.callees.get(bt.slots[i]) ?? []).length} -> ${(tg.callees.get(tt.slots[pick]) ?? []).length}; ${verdict}`]);
    if (verdict === "ok") out.push({ name, bslot: i, tslot: pick, rva: tt.slots[pick], bsize: bsz, tsize: tsz });
}
// order: insertions only, so target slots must increase with baseline slots; keep the longest increasing subsequence
out.sort((a, b) => a.bslot - b.bslot);
const lis = (() => { const n = out.length, len = Array(n).fill(1), prev = Array(n).fill(-1); let best = 0; for (let i = 0; i < n; i++) { for (let j = 0; j < i; j++) if (out[j].tslot < out[i].tslot && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; } if (len[i] > len[best]) best = i; } const keep = new Set(); for (let i = best; i >= 0; i = prev[i]) keep.add(i); return keep; })();
const bad = new Set(out.map((_, k) => k).filter(k => !lis.has(k)));
const kept = out.filter((_, k) => !bad.has(k));
for (const r of rows) console.log(`  #${String(r[0]).padStart(3)} -> ${String(r[2]).padStart(3)}  ${r[1].replace(/^\?handle@ServerNetworkHandler@@UEAAXAEBVNetworkIdentifier@@AEBV/, "").replace(/@@@Z$/, "").slice(0, 40).padEnd(40)} ${r[3]}`);
console.log(`\n${v}: ${rows.length} baseline overrides, ${out.length} unique+sane, ${kept.length} after the order check (${bad.size} in inversions)`);
const pair = opt("pair") ? JSON.parse(fs.readFileSync(opt("pair"), "utf8")) : null;
// cross-build: the two tables differ by a few inserted slots, so the slot delta between the builds' candidates for the same packet should be one small constant per region
if (pair) { const deltas = kept.map(k => { const o = pair.candidates.find(x => x.name === k.name); return o ? [k.name.replace(/^\?handle@ServerNetworkHandler@@UEAAXAEBVNetworkIdentifier@@AEBV/, "").replace(/@@@Z$/, "").slice(0, 34), k.tslot, o.tslot, k.tslot - o.tslot, k.tsize, o.tsize] : null; }).filter(Boolean); console.log(`cross-build with ${opt("pair")} (${deltas.length} shared):`); for (const d of deltas) console.log(`  ${d[0].padEnd(34)} ${String(d[1]).padStart(3)} vs ${String(d[2]).padStart(3)}  delta ${String(d[3]).padStart(3)}  ${d[4]}B vs ${d[5]}B`); }
if (opt("out")) fs.writeFileSync(opt("out"), JSON.stringify({ _comment: `NetEventCallback handlers on ${v} by the baseline's local override pattern (tools/netevent-align.mjs); table 0x${tt.rva.toString(16)}; not merged until measured`, table: tt.rva, candidates: kept, symbols: Object.fromEntries(kept.map(k => [k.name, k.rva])) }, null, 1) + "\n");
