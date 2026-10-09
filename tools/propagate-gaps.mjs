/**
 * Call-edge propagation, anchored gap by gap.
 *
 * tools/propagate-match.mjs pairs the callees of a matched function
 * positionally only when both callee lists have the same length, which
 * discards a list as soon as one call was added or removed anywhere in it
 * (16 of 18 ground-truth functions, docs/next-steps.md). With thousands of
 * names known, most callee lists now contain several already-paired
 * callees. Those are anchors: between two consecutive anchors that match
 * on both sides, the unknown callees are paired positionally when -- and
 * only when -- the gap has the same length on both sides. A gap that grew
 * or shrank is skipped; the rest of the list still contributes.
 *
 * Every proposal is a vote across all matched callers; a target claimed by
 * two baseline functions, or a baseline function with two targets, is
 * dropped. Precision is measured first: --holdout=F hides a fraction F of
 * the known pairs, runs the rule, and scores its proposals for them.
 *
 * Usage: node tools/propagate-gaps.mjs <version> [--holdout=0.2] [--seed=1] [--out=file]
 *        [--holdoutOut=file | --holdoutIn=file]  write / reuse the held-out baseline set, so the
 *                                                 same functions are hidden on two builds (tools/gaps-agree.mjs)
 *        [--sizes]    the size loosening: inside a gap whose length differs between the
 *                     builds, an unknown baseline callee is paired with the one unknown
 *                     target callee whose function size is within 15% of its own, if that
 *                     match is unique both ways (function bounds from .pdata)
 *        [--setdiff]  the set-difference loosening: a matched caller whose callee lists, with the
 *                     known callees removed, leave exactly one unknown on each side pairs those two
 *                     regardless of gap lengths (measured with --holdout before it is trusted)
 *   known pairs: data/merged-<v>.json names mapped to 1.21.3.01 through
 *   data/baseline-symbols.json, plus the string/propagation pair file of the build when present
 */
import * as fs from "fs";
import { callGraph } from "./callgraph.mjs";

const args = process.argv.slice(2);
const v = args[0];
const opt = Object.fromEntries(args.slice(1).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true]; }));
const HOLDOUT = Number(opt.holdout ?? 0), SEED = Number(opt.seed ?? 1), MAX_CALLEES = Number(opt.maxCallees ?? 96);
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const full = load("data/baseline-symbols.json").symbols;
const merged = load(`data/merged-${v}.json`);
const B = callGraph("work/bin/1.21.3.01/bedrock_server.exe");
const T = callGraph(`work/bin/${v}/bedrock_server.exe`);
const bFuncs = new Set(B.callees.keys()), tFuncs = new Set(T.callees.keys());

// known pairs: baseline rva -> target rva
const known = new Map();
for (const [n, t] of Object.entries(merged.symbols)) { const b = full[n]; if (b !== undefined && typeof t === "number" && !n.startsWith("??_7")) known.set(b, t); }
const pairFile = v === "1.26.40.8" ? "work/derived/pairs2.json" : "work/derived51/pairs.json";
if (fs.existsSync(pairFile)) for (const [b, t] of Object.entries(load(pairFile).pairs)) if (!known.has(Number(b))) known.set(Number(b), t);
// hold out
let rng = SEED; const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const heldOut = new Map();
if (opt.holdoutIn) { const hs = new Set(load(opt.holdoutIn).heldOut.map(Number)); for (const [b, t] of [...known]) if (hs.has(b)) { heldOut.set(b, t); known.delete(b); } }
else if (HOLDOUT > 0) for (const [b, t] of [...known]) if (rand() < HOLDOUT) { heldOut.set(b, t); known.delete(b); }
if (opt.holdoutOut) fs.writeFileSync(opt.holdoutOut, JSON.stringify({ heldOut: [...heldOut.keys()] }));
const SETDIFF = !!opt.setdiff, SIZES = !!opt.sizes;
const sizeMaps = new Map();
const sizeOf = (G, f) => { let m = sizeMaps.get(G); if (!m) { m = new Map(G.funcs.map(x => [x.begin, x.end - x.begin])); sizeMaps.set(G, m); } const sz = m.get(f); return sz === undefined ? -1 : sz; };
let sizeVotes = 0;
const knownRev = new Map([...known].map(([b, t]) => [t, b]));
console.log(`known pairs ${known.size}${HOLDOUT ? `, held out ${heldOut.size}` : ""}`);

const seq = (map, f) => { const a = map.get(f); if (!a) return null; const out = [], seen = new Set(); for (const x of a) { if (!seen.has(x)) { seen.add(x); out.push(x); } } return out; };

// votes: baseline callee -> Map(target callee -> count)
const votes = new Map();
let callersUsed = 0, gapsEqual = 0, gapsUnequal = 0, setdiffVotes = 0;
for (const [b, t] of known) {
    const bs = seq(B.callees, b), ts = seq(T.callees, t);
    if (!bs || !ts || bs.length > MAX_CALLEES || ts.length > MAX_CALLEES) continue;
    // anchor positions: indices i,j with known.get(bs[i]) === ts[j], in order (greedy, monotone)
    const anchors = [[-1, -1]];
    let j0 = 0;
    for (let i = 0; i < bs.length; i++) {
        const kt = known.get(bs[i]); if (kt === undefined) continue;
        const j = ts.indexOf(kt, j0); if (j < 0) continue;
        anchors.push([i, j]); j0 = j + 1;
    }
    anchors.push([bs.length, ts.length]);
    if (SETDIFF) {
        // set difference: the unknown callees left after removing every known one
        const ub = bs.filter(x => !known.has(x)), ut = ts.filter(x => !knownRev.has(x));
        if (ub.length === 1 && ut.length === 1 && anchors.length >= 3) { const m = votes.get(ub[0]) ?? votes.set(ub[0], new Map()).get(ub[0]); m.set(ut[0], (m.get(ut[0]) ?? 0) + 1); setdiffVotes++; }
    }
    if (anchors.length < 3) continue;   // no anchor inside: nothing to hang a gap on
    callersUsed++;
    for (let k = 0; k + 1 < anchors.length; k++) {
        const [i0, j0_] = anchors[k], [i1, j1] = anchors[k + 1];
        const gb = i1 - i0 - 1, gt = j1 - j0_ - 1;
        if (gb <= 0 || gb !== gt) {
            if (gb > 0 || gt > 0) gapsUnequal++;
            if (SIZES && gb > 0 && gt > 0) {
                const ub = [], ut = [];
                for (let d = 1; d <= gb; d++) if (!known.has(bs[i0 + d])) ub.push(bs[i0 + d]);
                for (let d = 1; d <= gt; d++) if (!knownRev.has(ts[j0_ + d])) ut.push(ts[j0_ + d]);
                const st = ut.map(t => [t, sizeOf(T, t)]);
                for (const bc of ub) {
                    const sb = sizeOf(B, bc); if (sb < 16) continue;
                    const hits = st.filter(([, sz]) => sz >= 16 && Math.abs(sz - sb) <= 0.15 * Math.max(sz, sb));
                    if (hits.length !== 1) continue;
                    const [tc, sz] = hits[0];
                    // unique the other way too: no other unknown baseline callee in the gap matches tc
                    if (ub.some(o => o !== bc && (x => x >= 16 && Math.abs(sz - x) <= 0.15 * Math.max(sz, x))(sizeOf(B, o)))) continue;
                    const m = votes.get(bc) ?? votes.set(bc, new Map()).get(bc); m.set(tc, (m.get(tc) ?? 0) + 1); sizeVotes++;
                }
            }
            continue;
        }
        gapsEqual++;
        for (let d = 1; d <= gb; d++) {
            const bc = bs[i0 + d], tc = ts[j0_ + d];
            if (known.has(bc) || knownRev.has(tc)) continue;   // an unknown-on-one-side mismatch: leave it
            const m = votes.get(bc) ?? votes.set(bc, new Map()).get(bc);
            m.set(tc, (m.get(tc) ?? 0) + 1);
        }
    }
}
// cohesion of a proposal b -> t, independent of the caller gap that made it:
// b's own callees that are known must reappear (through their pairs) among
// t's callees. [matched, knownCalleesOfB, knownCalleesOfT]
function cohesion(b, t) {
    const bs = seq(B.callees, b) ?? [], ts = seq(T.callees, t) ?? [];
    const tset = new Set(ts);
    let kb = 0, hit = 0, kt = 0;
    for (const x of bs) { const y = known.get(x); if (y === undefined) continue; kb++; if (tset.has(y)) hit++; }
    for (const y of ts) if (knownRev.has(y)) kt++;
    return [hit, kb, kt];
}
// resolve: mutual best, no ties, no double claims
const proposal = new Map(), claimed = new Map(), voteCount = new Map();
for (const [bc, m] of votes) {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue;
    proposal.set(bc, sorted[0][0]); voteCount.set(bc, sorted[0][1]);
}
for (const [bc, tc] of proposal) (claimed.get(tc) ?? claimed.set(tc, []).get(tc)).push(bc);
for (const [tc, bcs] of claimed) if (bcs.length > 1) for (const bc of bcs) proposal.delete(bc);
console.log(`callers with inner anchors ${callersUsed}; gaps equal ${gapsEqual}, unequal (skipped) ${gapsUnequal}${SETDIFF ? `; set-difference votes ${setdiffVotes}` : ""}${SIZES ? `; size votes in unequal gaps ${sizeVotes}` : ""}; proposals ${proposal.size}`);

if (HOLDOUT > 0 || opt.holdoutIn) {
    let right = 0, wrong = 0, reached = 0; const byVotes = {}, byCoh = {}; const coh = {};
    for (const [b, t] of heldOut) {
        const p = proposal.get(b); if (p === undefined) continue; reached++; const ok = p === t; if (ok) right++; else wrong++;
        const k = Math.min(voteCount.get(b), 3); (byVotes[k] ??= [0, 0])[ok ? 0 : 1]++;
        const c = cohesion(b, p); coh[b] = c;
        // classes: no known callee on either side (blind), all known callees of b found in t (full), some (partial), none (contradicted)
        const cls = c[1] === 0 && c[2] === 0 ? "blind" : c[1] > 0 && c[0] === c[1] ? "full" : c[0] > 0 ? "partial" : "contradicted";
        (byCoh[cls] ??= [0, 0])[ok ? 0 : 1]++;
    }
    console.log(`held-out: ${heldOut.size}, reached ${reached}, right ${right}, wrong ${wrong}, precision ${(100 * right / Math.max(1, reached)).toFixed(1)}%`);
    console.log(`  by callers voting: ${Object.entries(byVotes).map(([k, [r, w]]) => `${k}${k === "3" ? "+" : ""}: ${r}/${r + w}`).join("  ")}`);
    console.log(`  by callee cohesion: ${Object.entries(byCoh).map(([k, [r, w]]) => `${k}: ${r}/${r + w}`).join("  ")}`);
    if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify({ v, setdiff: SETDIFF, proposals: Object.fromEntries(proposal), votes: Object.fromEntries(voteCount), cohesion: coh, heldOut: Object.fromEntries(heldOut) })); console.log(`-> ${opt.out}`); }
} else {
    const required = new Set(load("data/required-symbols.json").symbols.map(s => s.name));
    const bNames = new Map(); for (const [n, r] of Object.entries(full)) (bNames.get(r) ?? bNames.set(r, []).get(r)).push(n);
    const symbols = {}; let req = 0;
    const baselineOf = {}, votesOf = {}, cohesionOf = {};
    for (const [b, t] of proposal) for (const n of bNames.get(b) ?? []) { if (n in merged.symbols) continue; symbols[n] = t; baselineOf[n] = b; votesOf[n] = voteCount.get(b); cohesionOf[n] = cohesion(b, t); if (required.has(n)) req++; }
    console.log(`new names ${Object.keys(symbols).length}, required ${req}`);
    if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify({ _comment: `Gap-anchored call-edge propagation (tools/propagate-gaps.mjs) on ${v}: unknown callees paired positionally inside equal-length gaps between known callee pairs, mutual-best votes, no double claims. Precision from --holdout runs is recorded in docs/findings-slots.md.${SETDIFF ? " With the set-difference loosening." : ""}`, setdiff: SETDIFF, symbols, baselineOf, votes: votesOf, cohesion: cohesionOf }, null, 1)); console.log(`-> ${opt.out}`); }
}
