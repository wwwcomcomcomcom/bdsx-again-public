/**
 * Grow a function correspondence outward from string-anchored seeds.
 *
 * tools/string-anchor-match.mjs resolves only functions that reference unique
 * literals themselves, which is 6.7% of bdsx's symbol set and none of the 29
 * that bdsx/launcher.ts needs -- those are constructors, vftables and getters,
 * exactly the code that sits away from literals. But 58.6% of them are one
 * call-graph hop from a function that does carry one.
 *
 * So this is Endstone's third step, automated: having anchored a function,
 * walk its call edges. If a matched pair (b, t) calls the same number of
 * distinct functions, their call sequences are matched positionally -- MSVC
 * emits calls in source order, so the nth callee of b corresponds to the nth
 * callee of t when nothing was added or removed between them.
 *
 * That assumption is wrong often enough to need a check, so it is never
 * trusted on its own. Every proposal is a vote, a pair is accepted only when
 * it is the mutual best of its round and beats its runner-up, and a target
 * claimed by two baseline functions is dropped. Propagation then repeats, so
 * pairs accepted in one round seed the next.
 *
 * Usage: node tools/propagate-match.mjs <baselineExe> <targetExe> <seeds.json> [table.json]
 * Env:   ROUNDS MIN_VOTES MARGIN MAX_CALLEES OUT PAIRS_OUT
 */
import * as fs from "fs";
import { callGraph } from "./callgraph.mjs";

const ROUNDS = Number(process.env.ROUNDS ?? 6);
const MIN_VOTES = Number(process.env.MIN_VOTES ?? 1);
const MARGIN = Number(process.env.MARGIN ?? 1);
// A function with a very long call list is usually a unity initialiser or a
// dispatch table; one insertion shifts every position and the whole sequence
// becomes wrong at once.
const MAX_CALLEES = Number(process.env.MAX_CALLEES ?? 64);

const [baseExe, targetExe, seedPath, tablePath] = process.argv.slice(2);
process.stderr.write("call graphs...");
const B = callGraph(baseExe);
const T = callGraph(targetExe);
process.stderr.write("\r               \r");

/** Callees in call order, de-duplicated, keeping the first occurrence. */
function seq(map, fn) {
    const a = map.get(fn);
    if (a === undefined) return null;
    const out = [], seen = new Set();
    for (const x of a) {
        if (seen.has(x)) continue;
        seen.add(x);
        out.push(x);
    }
    return out;
}

const seeds = JSON.parse(fs.readFileSync(seedPath, "utf8"));
const matched = new Map();   // baseline rva -> target rva
const claimed = new Map();   // target rva -> baseline rva
const origin = new Map();    // baseline rva -> which round it came from
for (const [b, t] of Object.entries(seeds.pairs ?? {})) {
    const bb = Number(b);
    if (claimed.has(t)) continue;
    matched.set(bb, t);
    claimed.set(t, bb);
    origin.set(bb, 0);
}
console.log(`seeds: ${matched.size}`);

for (let round = 1; round <= ROUNDS; round++) {
    const votes = new Map();   // "b:t" -> count
    const bump = (b, t) => {
        if (matched.has(b) || claimed.has(t)) return;
        const k = b + ":" + t;
        votes.set(k, (votes.get(k) ?? 0) + 1);
    };

    for (const [b, t] of matched) {
        const bc = seq(B.callees, b), tc = seq(T.callees, t);
        if (bc && tc && bc.length === tc.length && bc.length > 0 && bc.length <= MAX_CALLEES) {
            for (let i = 0; i < bc.length; i++) bump(bc[i], tc[i]);
        }
        // A function with exactly one caller on each side identifies it, which
        // is what reaches constructors and getters: they call little and are
        // called from one place.
        const bp = B.callers.get(b), tp = T.callers.get(t);
        if (bp && tp && bp.size === 1 && tp.size === 1) bump([...bp][0], [...tp][0]);
    }

    // best target per baseline function, and best baseline per target
    const bestB = new Map(), bestT = new Map();
    for (const [k, c] of votes) {
        const i = k.indexOf(":");
        const b = Number(k.slice(0, i)), t = Number(k.slice(i + 1));
        const cb = bestB.get(b);
        if (cb === undefined || c > cb.c) bestB.set(b, { c, o: t, second: cb ? cb.c : 0 });
        else if (c > (cb.second ?? 0)) cb.second = c;
        const ct = bestT.get(t);
        if (ct === undefined || c > ct.c) bestT.set(t, { c, o: b, second: ct ? ct.c : 0 });
        else if (c > (ct.second ?? 0)) ct.second = c;
    }

    let added = 0;
    for (const [b, v] of bestB) {
        if (v.c < MIN_VOTES || v.c - (v.second ?? 0) < MARGIN) continue;
        const rev = bestT.get(v.o);
        if (rev.o !== b || rev.c - (rev.second ?? 0) < MARGIN) continue;
        if (matched.has(b) || claimed.has(v.o)) continue;
        matched.set(b, v.o);
        claimed.set(v.o, b);
        origin.set(b, round);
        added++;
    }
    console.log(`round ${round}: +${added}  (total ${matched.size})`);
    if (added === 0) break;
}

// The whole correspondence, not just the named part. Chaining across versions
// composes these maps hop by hop, and most of what it carries has no name in
// any table -- the name is attached once, at the end.
if (process.env.PAIRS_OUT) {
    const all = {};
    for (const [b, t] of matched) all[b] = t;
    fs.writeFileSync(process.env.PAIRS_OUT, JSON.stringify({ baseline: baseExe, target: targetExe, pairs: all }) + "\n");
    console.log(`wrote ${process.env.PAIRS_OUT} (${matched.size} pairs)`);
}

if (tablePath) {
    const table = JSON.parse(fs.readFileSync(tablePath, "utf8")).symbols;
    const shared = new Map();
    for (const rva of Object.values(table)) shared.set(rva, (shared.get(rva) ?? 0) + 1);
    const resolved = {}, detail = {};
    let folded = 0;
    for (const [name, rva] of Object.entries(table)) {
        if (shared.get(rva) > 1) { folded++; continue; }
        const t = matched.get(rva);
        if (t === undefined) continue;
        resolved[name] = t;
        detail[name] = { rva: t, round: origin.get(rva) };
    }
    const n = Object.keys(resolved).length;
    console.log(`\ntable symbols: ${Object.keys(table).length}  (COMDAT-folded ${folded})`);
    console.log(`  matched: ${n}  (${(n / Object.keys(table).length * 100).toFixed(1)}%)`);
    const byRound = new Map();
    for (const d of Object.values(detail)) byRound.set(d.round, (byRound.get(d.round) ?? 0) + 1);
    console.log("  by round: " + [...byRound].sort((a, b) => a[0] - b[0]).map(([r, c]) => `${r}:${c}`).join("  "));
    if (process.env.OUT) {
        fs.writeFileSync(process.env.OUT, JSON.stringify({
            method: `call-sequence propagation from string-anchored seeds, ${ROUNDS} rounds, mutual best`,
            baseline: baseExe, target: targetExe, symbols: resolved, detail,
        }, null, 1) + "\n");
        console.log(`wrote ${process.env.OUT}`);
    }
}
