/**
 * Name the target's virtual functions by aligning vftables from a few seeds.
 *
 * A vftable is a vector of function pointers in declaration order. Between
 * builds virtuals are added and removed, so slot indices shift (Level::tick
 * is slot 99 of 342 in 1.21.3.01 and 119 of 409 in 1.26.40.8) and positional
 * matching finds nothing. What survives is the shape: how many tables each
 * slot's function appears in. Actor::foo unoverridden sits in every Actor
 * subclass table, Mob::foo in the Mob subtree, a destructor in one. That
 * integer sequence is aligned by dynamic programming with known functions
 * pinned as anchors.
 *
 * Table pairing: a target table containing a known function is aligned
 * against every baseline table containing that function, and the pairings
 * within a margin of the best score all vote. Names transfer only where the
 * votes are unanimous both ways -- a target function proposed as exactly one
 * baseline function which is proposed for exactly one target function -- and
 * the two functions' table counts agree within tolerance. Ambiguities stay
 * unresolved until later rounds pin more anchors.
 *
 * Usage:
 *   node tools/vftable-match.mjs --baseline=work/vft/baseline-slots.json \
 *        --target=work/vft/scan-1.26.40.8.json --seeds=a.json[,b.json] \
 *        --out=work/vft/match-1.26.40.8.json [--holdout=substr] \
 *        [--check=work/derived/pairs.json] [--multTol=0.25] [--margin=2]
 */
import * as fs from "fs";
import { functions as pdataFunctions } from "./pdata.mjs";
import { callGraph } from "./callgraph.mjs";

const opt = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return [m[1], m[2] ?? true]; }));
const B = JSON.parse(fs.readFileSync(opt.baseline, "utf8"));
const T = JSON.parse(fs.readFileSync(opt.target, "utf8"));
const MULT_TOL = Number(opt.multTol ?? 0.25);
const MARGIN = Number(opt.margin ?? 2);
const MAX_ROUNDS = Number(opt.rounds ?? 30);
const MAX_PROMISCUITY = Number(opt.maxPromiscuity ?? 64);
// --strict: a slot is accepted only when it lies between two anchors in the
// same gap-free diagonal run, i.e. its shift is pinned on both sides. Slots
// beyond the outermost anchors, or in runs where the DP placed a gap among
// look-alike slots, are left for a later round.
const STRICT = !!opt.strict;
// --strictAbove=N: strict only for baseline tables longer than N slots. The
// measured errors sit in a few huge interface tables (MinecraftEventing,
// webrtc) whose slots all look alike; small tables are ~98% right unstrict.
const STRICT_ABOVE = Number(opt.strictAbove ?? Infinity);
// --strictUniform=F: strict when a share >= F of the baseline table's slots
// share one table count -- a single-implementer interface (MinecraftEventing,
// a packet) whose slots the count feature cannot tell apart.
const STRICT_UNIFORM = Number(opt.strictUniform ?? 2);
const uniformity = new Map();
const uniformityOf = bt => {
    let u = uniformity.get(bt);
    if (u === undefined) {
        const h = new Map();
        for (const f of bt.slots) { const m = bMult.get(f); h.set(m, (h.get(m) ?? 0) + 1); }
        u = bt.slots.length ? Math.max(...h.values()) / bt.slots.length : 1;
        uniformity.set(bt, u);
    }
    return u;
};
// --size: function size from .pdata as a weak feature (leaf functions have no entry)
const USE_SIZE = !!opt.size;
// --callees=<pairs.json>: the callee sets of the two functions, compared
// through independently known baseline->target pairs (string anchoring /
// propagation). Two slots that look alike by table count are told apart by
// what their bodies call.
const CALLEE_PAIRS = opt.callees;

// --- baseline: fold identical tables, index functions -------------------------
const bByRva = new Map();
for (const [name, v] of Object.entries(B.vftables)) {
    const e = bByRva.get(v.rva);
    if (e) e.names.push(name); else bByRva.set(v.rva, { rva: v.rva, names: [name], slots: v.slots });
}
const bTables = [...bByRva.values()];
const bIndex = new Map();
for (const t of bTables) t.slots.forEach((f, i) => (bIndex.get(f) ?? bIndex.set(f, []).get(f)).push({ t, i }));
const bMult = new Map([...bIndex].map(([f, occ]) => [f, new Set(occ.map(o => o.t)).size]));
const nameOf = f => (B.names[f] ?? [])[0] ?? `0x${f.toString(16)}`;
const rvaOfName = new Map();
for (const [r, names] of Object.entries(B.names)) for (const n of names) rvaOfName.set(n, Number(r));

// --- target -------------------------------------------------------------------
const tTables = T.vftables;
const tIndex = new Map();
for (const t of tTables) t.slots.forEach((f, i) => (tIndex.get(f) ?? tIndex.set(f, []).get(f)).push({ t, i }));
const tMult = new Map([...tIndex].map(([f, occ]) => [f, new Set(occ.map(o => o.t)).size]));
let bSize = new Map(), tSize = new Map();
if (USE_SIZE) {
    for (const f of pdataFunctions(B.exe)) bSize.set(f.begin, f.end - f.begin);
    for (const f of pdataFunctions(T.exe)) tSize.set(f.begin, f.end - f.begin);
}
let bCallees = null, tCallees = null, calleePairs = null;
if (CALLEE_PAIRS) {
    bCallees = callGraph(B.exe).callees; tCallees = callGraph(T.exe).callees;
    calleePairs = new Map(Object.entries(JSON.parse(fs.readFileSync(CALLEE_PAIRS, "utf8")).pairs).map(([b, t]) => [Number(b), t]));
}
const calleeSim = (tf, bf) => {
    const bc = bCallees.get(bf), tc = tCallees.get(tf);
    if (!bc || !tc) return (!bc && !tc) ? 0.2 : -0.2;
    const mapped = new Set();
    for (const c of bc) { const t = calleePairs.get(c) ?? knownRev.get(c); if (t !== undefined) mapped.add(t); }
    if (!mapped.size) return 0;
    let inter = 0;
    for (const c of new Set(tc)) if (mapped.has(c)) inter++;
    if (inter / mapped.size >= 0.5) return 1.5;
    if (inter === 0 && mapped.size >= 2) return -1.5;
    return 0;
};
const sizeSim = (tf, bf) => {
    const a = tSize.get(tf), b = bSize.get(bf);
    if (a === undefined || b === undefined) return (a === undefined) === (b === undefined) ? 0.2 : -0.3;
    const r = Math.min(a, b) / Math.max(a, b);
    return r >= 0.75 ? 0.5 : r >= 0.4 ? 0 : -0.5;
};

// --- seeds: target fn -> baseline fn ---------------------------------------------
const seeds = new Map();
let heldOut = null;
// --holdoutFrac=0.5 [--holdoutSeed=N]: hold out a random fraction of the seeds
// and score the walk on them, which is the precision measurement at scale.
const holdoutSet = new Map();
const FRAC = Number(opt.holdoutFrac ?? 0);
let rng = Number(opt.holdoutSeed ?? 1);
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
for (const file of opt.seeds.split(",")) {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [name, v] of Object.entries(j.symbols ?? j)) {
        const rva = typeof v === "number" ? v : v.rva;
        const bf = rvaOfName.get(name);
        if (bf === undefined || !bIndex.has(bf) || !tIndex.has(rva)) continue;
        if (opt.holdout && name.includes(opt.holdout)) { heldOut = { name, rva, bf }; continue; }
        if (FRAC > 0 && rand() < FRAC) { holdoutSet.set(bf, rva); continue; }
        seeds.set(rva, bf);
    }
}
console.log(`seeds usable as virtual slots: ${seeds.size}${holdoutSet.size ? `, held out ${holdoutSet.size}` : ""}${heldOut ? `, held out ${heldOut.name.slice(0, 50)}` : ""}`);

// --- alignment --------------------------------------------------------------------
const multSim = (a, b) => { const r = Math.min(a, b) / Math.max(a, b); return r >= 1 - MULT_TOL ? 1 : r >= 0.5 ? 0.2 : -1; };
const MAXN = Math.max(...tTables.map(t => t.slots.length), ...bTables.map(t => t.slots.length)) + 1;
const S = new Float64Array(MAXN * MAXN), P = new Uint8Array(MAXN * MAXN);
const alignCache = new Map(); // "t:b" -> { tk, bk, result }: valid while neither table gained a known slot
const knownIn = tbl => { let k = 0; for (const f of tbl.slots) if (known.has(f) || knownRev.has(f)) k++; return k; };
function align(tt, bt, known) {
    const ck = tt.rva + ":" + bt.rva, tk = knownIn(tt), bk = knownIn(bt);
    const hit = alignCache.get(ck);
    if (hit && hit.tk === tk && hit.bk === bk) return hit.result;
    const result = alignRaw(tt, bt, known);
    alignCache.set(ck, { tk, bk, result });
    return result;
}
function alignRaw(tt, bt, known) {
    const n = tt.slots.length, m = bt.slots.length;
    const GAP = -0.6;
    for (let i = 1; i <= n; i++) { S[i * (m + 1)] = i * GAP; P[i * (m + 1)] = 1; }
    for (let j = 1; j <= m; j++) { S[j] = j * GAP; P[j] = 2; }
    for (let i = 1; i <= n; i++) {
        const tf = tt.slots[i - 1], kb = known.get(tf), mt = tMult.get(tf);
        for (let j = 1; j <= m; j++) {
            const bf = bt.slots[j - 1];
            let s;
            if (kb !== undefined) s = kb === bf ? 6 : -8;
            else if (knownRev.has(bf)) s = -4;
            else { s = multSim(mt, bMult.get(bf)); if (USE_SIZE) s += sizeSim(tf, bf); if (CALLEE_PAIRS) s += calleeSim(tf, bf); }
            const d = S[(i - 1) * (m + 1) + j - 1] + s, u = S[(i - 1) * (m + 1) + j] + GAP, l = S[i * (m + 1) + j - 1] + GAP;
            const k = i * (m + 1) + j;
            if (d >= u && d >= l) { S[k] = d; P[k] = 0; } else if (u >= l) { S[k] = u; P[k] = 1; } else { S[k] = l; P[k] = 2; }
        }
    }
    // traceback into gap-free diagonal runs; the result is two flat typed
    // arrays because the cache holds thousands of alignments across rounds
    const runs = [];
    let i = n, j = m, run = null;
    while (i > 0 && j > 0) {
        const p = P[i * (m + 1) + j];
        if (p === 0) { if (!run) runs.push(run = []); run.push(i - 1, j - 1); i--; j--; }
        else { run = null; if (p === 1) i--; else j--; }
    }
    const strictHere = STRICT || m > STRICT_ABOVE || uniformityOf(bt) >= STRICT_UNIFORM;
    const tfs = [], bfs = [];
    for (const r of runs) {
        // r is [ti, bj, ti, bj, ...] in reverse order; anchors are pairs already known
        let first = -1, last = -1;
        for (let k = 0; k < r.length; k += 2) if (known.get(tt.slots[r[k]]) === bt.slots[r[k + 1]]) { if (first < 0) first = k; last = k; }
        let lo = 0, hi = r.length - 2;
        if (strictHere) { if (first < 0 || first === last) continue; lo = first; hi = last; }
        for (let k = lo; k <= hi; k += 2) { tfs.push(tt.slots[r[k]]); bfs.push(bt.slots[r[k + 1]]); }
    }
    return { score: S[n * (m + 1) + m], tf: Int32Array.from(tfs), bf: Int32Array.from(bfs) };
}

const known = new Map(seeds);
const knownRev = new Map([...seeds].map(([t, b]) => [b, t]));
const rounds = [];
let pairings = new Map(); // tt -> [bt...] within margin
for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prop = new Map(), rev = new Map();
    pairings = new Map();
    let aligned = 0, multRejected = 0;
    for (const tt of tTables) {
        const cands = new Set();
        // a function in hundreds of tables (a folded stub, a shared default) says
        // nothing about which table this is, and would pair every table with
        // every table -- which is also what exhausted the heap on 1.26.51.1
        for (const tf of tt.slots) {
            const bf = known.get(tf);
            if (bf === undefined || bMult.get(bf) > MAX_PROMISCUITY || tMult.get(tf) > MAX_PROMISCUITY) continue;
            for (const o of bIndex.get(bf)) cands.add(o.t);
        }
        if (!cands.size) continue;
        const scored = [...cands].map(bt => ({ bt, ...align(tt, bt, known) })).sort((a, b) => b.score - a.score);
        const best = scored[0].score;
        const keep = scored.filter(s => s.score >= best - MARGIN);
        pairings.set(tt, keep.map(s => s.bt));
        aligned += keep.length;
        for (const { tf: tfa, bf: bfa } of keep) for (let k = 0; k < tfa.length; k++) {
            const tf = tfa[k], bf = bfa[k];
            if (known.has(tf) || knownRev.has(bf)) continue;
            // table-count compatibility is applied before the vote, so that a
            // slot where Level::foo (2 tables) and ServerLevel::foo (1 table)
            // both propose is settled by which one the target function's own
            // count matches rather than left ambiguous
            if (multSim(tMult.get(tf), bMult.get(bf)) < 1) { multRejected++; continue; }
            (prop.get(tf) ?? prop.set(tf, new Set()).get(tf)).add(bf);
            (rev.get(bf) ?? rev.set(bf, new Set()).get(bf)).add(tf);
        }
    }
    let added = 0, ambiguous = 0;
    for (const [tf, bfs] of prop) {
        if (bfs.size !== 1) { ambiguous++; continue; }
        const bf = [...bfs][0];
        if (rev.get(bf).size !== 1) { ambiguous++; continue; }
        known.set(tf, bf); knownRev.set(bf, tf); added++;
    }
    rounds.push({ round, tablesAligned: pairings.size, pairings: aligned, added, ambiguous, multRejected });
    console.log(`round ${round}: target tables aligned ${pairings.size} (${aligned} pairings), named +${added}, ambiguous ${ambiguous}, mult-rejected ${multRejected}, total ${known.size}`);
    if (!added) break;
}

// --- output -------------------------------------------------------------------------
const symbols = {};
for (const [tf, bf] of known) for (const n of B.names[bf] ?? []) symbols[n] = tf;
const vftables = {};
for (const [tt, bts] of pairings) if (bts.length === 1) for (const n of bts[0].names) vftables[n] = tt.rva;

if (heldOut) {
    const ours = knownRev.get(heldOut.bf);
    const trueNamed = known.get(heldOut.rva);
    console.log(`holdout ${heldOut.name.slice(0, 60)}: truth 0x${heldOut.rva.toString(16)}, walk ${ours === undefined ? "unresolved" : "0x" + ours.toString(16)} -> ${ours === heldOut.rva ? "CORRECT" : ours === undefined ? "NOT REACHED" : "WRONG"}${trueNamed !== undefined && trueNamed !== heldOut.bf ? `; true address was named ${nameOf(trueNamed)}` : ""}`);
}
if (holdoutSet.size) {
    let correct = 0, wrong = 0, unreached = 0; const wrongs = [], wrongByClass = {};
    for (const [bf, truth] of holdoutSet) {
        const ours = knownRev.get(bf);
        if (ours === undefined) unreached++;
        else if (ours === truth) correct++;
        else { wrong++; const cls = (nameOf(bf).match(/@([A-Za-z_0-9]+)@@/) || [])[1]; wrongByClass[cls] = (wrongByClass[cls] ?? 0) + 1; if (wrongs.length < 8) wrongs.push(`${nameOf(bf).slice(0, 70)} truth=0x${truth.toString(16)} walk=0x${ours.toString(16)}`); }
    }
    console.log(`HOLDOUT ${holdoutSet.size}: reached ${correct + wrong}, correct ${correct}, wrong ${wrong} (precision ${(correct / Math.max(1, correct + wrong) * 100).toFixed(1)}%), unreached ${unreached}`);
    console.log("  wrong by class:", Object.entries(wrongByClass).sort((a, b) => b[1] - a[1]).map(e => e.join("=")).join(" "));
    for (const w of wrongs) console.log("  wrong:", w);
}
if (opt.check) {
    // independent route: baseline fn rva -> target fn rva pairs from string anchoring / propagation
    const pairs = JSON.parse(fs.readFileSync(opt.check, "utf8")).pairs;
    let agree = 0, disagree = 0; const dis = [];
    for (const [bfs, tf] of Object.entries(pairs)) {
        const bf = Number(bfs), ours = knownRev.get(bf);
        if (ours === undefined) continue;
        if (ours === tf) agree++; else { disagree++; if (dis.length < 10) dis.push(`${nameOf(bf).slice(0, 70)} pairs=0x${tf.toString(16)} vft=0x${ours.toString(16)}`); }
    }
    console.log(`check vs ${opt.check}: overlap ${agree + disagree}, agree ${agree}, disagree ${disagree}`);
    for (const d of dis) console.log("  disagree:", d);
}
if (opt.out) {
    fs.writeFileSync(opt.out, JSON.stringify({ method: `vftable sequence alignment from seeds; unanimous-vote rule, multTol=${MULT_TOL}, margin=${MARGIN}${STRICT ? ", strict (between anchors)" : ""}${STRICT_ABOVE < Infinity ? `, strict above ${STRICT_ABOVE} slots` : ""}${STRICT_UNIFORM <= 1 ? `, strict when slot counts >= ${STRICT_UNIFORM} uniform` : ""}${USE_SIZE ? ", size feature" : ""}${CALLEE_PAIRS ? ", callee feature via " + CALLEE_PAIRS : ""}`, baseline: B.exe, target: T.exe, seeds: opt.seeds, rounds, symbols, vftables }, null, 1));
    console.log(`named target functions ${known.size} (${Object.keys(symbols).length} names), vftables identified ${Object.keys(vftables).length} -> ${opt.out}`);
}
