/**
 * Match functions across builds by the string literals they reference.
 *
 * Every byte-level technique measured so far fails across a real version gap,
 * and tools/window-signature-match.mjs showed why: between 1.21.3.01 and
 * 1.26.40.8 corresponding functions share no 12-instruction run even with all
 * operands wildcarded. The generated code is not perturbed, it is different.
 *
 * Endstone's hand-written signatures survive because they are not really byte
 * patterns. Reading their comments, every one starts the same way: find a
 * unique string literal, follow its data xref into the function that uses it,
 * and work outward from there. The byte pattern is the last step, not the
 * anchor.
 *
 * Strings survive a rebuild because they come from the source, not from code
 * generation. So this anchors on them directly:
 *
 *   function -> the set of unique string literals it references
 *
 * computed for both builds without disassembling either, then matched set
 * against set. A baseline function whose strings land in exactly one target
 * function, and beat every rival, is resolved.
 *
 * Picking the best target for a baseline function is not enough on its own:
 * MobEffectInstance::load and ::save share their NBT tag literals, and both
 * claimed the same target. So a match must be mutual -- the target's own best
 * baseline function has to be the one claiming it -- which is the rule BinDiff
 * uses for the same reason. A target claimed by two baseline names is dropped
 * outright, since at most one of them can be right and nothing here says which.
 *
 * References are found the way tools/xref-scan.mjs finds them: an x86-64
 * RIP-relative operand is a disp32 whose target is (end of operand) + disp32.
 * Scanning every offset over-generates, so a candidate is kept only when the
 * preceding byte is a ModRM with mod=00 and r/m=101 -- the encoding that makes
 * the disp32 RIP-relative in the first place -- and when its target is exactly
 * the first byte of a known unique string.
 *
 * Usage: node tools/string-anchor-match.mjs <baselineExe> <targetExe> <baseline-table.json>
 * Env:   MIN_LEN MIN_SHARED MARGIN MAX_REF ONLY OUT
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";

const MIN_LEN = Number(process.env.MIN_LEN ?? 6);      // shortest literal worth trusting
const MIN_SHARED = Number(process.env.MIN_SHARED ?? 2); // strings a match must agree on
const MARGIN = Number(process.env.MARGIN ?? 1);         // how far the winner must beat the runner-up
// A literal used this widely anchors nothing. This is not a marginal filter:
// operator new is inlined into 50,656 functions in 1.26.40.8 and carries its
// four assert literals into every one of them, so without it five sixths of
// the "functions that reference a unique literal" are noise.
const MAX_REF = Number(process.env.MAX_REF ?? 8);
const ONLY = process.env.ONLY;

function sections(buf) {
    const peOff = buf.readUInt32LE(0x3c), coff = peOff + 4;
    const n = buf.readUInt16LE(coff + 2), secOff = coff + 20 + buf.readUInt16LE(coff + 16);
    const out = [];
    for (let i = 0; i < n; i++) {
        const o = secOff + i * 40;
        out.push({
            name: buf.toString("ascii", o, o + 8).replace(/\0+$/, ""),
            rva: buf.readUInt32LE(o + 12), vsize: buf.readUInt32LE(o + 8),
            rawSize: buf.readUInt32LE(o + 16), rawPtr: buf.readUInt32LE(o + 20),
        });
    }
    return out;
}

/**
 * Every NUL-terminated ASCII literal in the image, by RVA.
 *
 * A literal that occurs more than once is dropped rather than kept with two
 * addresses: the whole value of a string anchor is that it names one place,
 * and "vector" or "true" name thousands.
 */
function uniqueStrings(buf, secs) {
    const byText = new Map();
    for (const s of secs) {
        if (s.name === ".text" || s.rawSize === 0) continue;
        const start = s.rawPtr, end = s.rawPtr + Math.min(s.rawSize, buf.length - s.rawPtr);
        let run = -1;
        for (let i = start; i < end; i++) {
            const c = buf[i];
            if (c >= 0x20 && c < 0x7f) { if (run < 0) run = i; continue; }
            if (c === 0 && run >= 0 && i - run >= MIN_LEN) {
                const str = buf.toString("latin1", run, i);
                const rva = run - s.rawPtr + s.rva;
                const prev = byText.get(str);
                if (prev === undefined) byText.set(str, rva);
                else byText.set(str, -1);              // seen twice: unusable
            }
            run = -1;
        }
    }
    const byRva = new Map();
    for (const [str, rva] of byText) if (rva !== -1) byRva.set(rva, str);
    return byRva;
}

/** functionBegin -> Set(string), via RIP-relative references from .text. */
function stringsByFunction(path) {
    const buf = fs.readFileSync(path);
    const secs = sections(buf);
    const text = secs.find(s => s.name === ".text");
    const strRva = uniqueStrings(buf, secs);

    const funcs = functions(path).sort((a, b) => a.begin - b.begin);
    const begins = new Int32Array(funcs.length), ends = new Int32Array(funcs.length);
    for (let i = 0; i < funcs.length; i++) { begins[i] = funcs[i].begin; ends[i] = funcs[i].end; }
    const locate = rva => {
        let lo = 0, hi = funcs.length - 1, ans = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (begins[m] <= rva) { ans = m; lo = m + 1; } else hi = m - 1; }
        return ans >= 0 && rva < ends[ans] ? begins[ans] : null;
    };

    const mem = buf.subarray(text.rawPtr, text.rawPtr + text.rawSize);
    const out = new Map();
    let refs = 0;
    for (let p = 1; p + 4 <= mem.length; p++) {
        // mod=00, r/m=101 is the only ModRM that makes disp32 RIP-relative.
        if ((mem[p - 1] & 0xc7) !== 0x05) continue;
        const target = text.rva + p + 4 + mem.readInt32LE(p);
        const str = strRva.get(target);
        if (str === undefined) continue;
        const fn = locate(text.rva + p);
        if (fn === null) continue;
        let set = out.get(fn);
        if (set === undefined) out.set(fn, (set = new Set()));
        set.add(str);
        refs++;
    }
    return { byFunction: out, uniqueStrings: strRva.size, refs, textRva: text.rva };
}

const [baseExe, targetExe, tablePath] = process.argv.slice(2);
process.stderr.write("indexing baseline...");
const base = stringsByFunction(baseExe);
process.stderr.write("\rindexing target...  ");
const tgt = stringsByFunction(targetExe);
process.stderr.write("\r                    \r");

// Count shared literals for every (baseline function, target function) pair.
// A literal referenced from many functions on either side is a shared idiom,
// not an anchor, and pairing every user of it against every other is also what
// would make this quadratic.
const baseIndex = new Map(), tgtIndex = new Map();
for (const [fn, set] of base.byFunction) for (const s of set) {
    let a = baseIndex.get(s); if (a === undefined) baseIndex.set(s, (a = [])); a.push(fn);
}
for (const [fn, set] of tgt.byFunction) for (const s of set) {
    let a = tgtIndex.get(s); if (a === undefined) tgtIndex.set(s, (a = [])); a.push(fn);
}

const pairs = new Map();          // baseFn -> Map(tgtFn -> shared count)
const bestForTarget = new Map();  // tgtFn  -> { count, fn, ties }
let anchors = 0;
for (const [str, bfns] of baseIndex) {
    const tfns = tgtIndex.get(str);
    if (tfns === undefined) continue;
    if (bfns.length > MAX_REF || tfns.length > MAX_REF) continue;
    anchors++;
    for (const b of bfns) {
        let m = pairs.get(b); if (m === undefined) pairs.set(b, (m = new Map()));
        for (const t of tfns) m.set(t, (m.get(t) ?? 0) + 1);
    }
}
for (const [b, m] of pairs) for (const [t, c] of m) {
    const cur = bestForTarget.get(t);
    if (cur === undefined || c > cur.count) bestForTarget.set(t, { count: c, fn: b, ties: 0 });
    else if (c === cur.count) cur.ties++;
}

console.log(`literals anchoring both builds: ${anchors} (referenced by <=${MAX_REF} functions on each side)`);

// Every mutual-best pair, named or not. tools/propagate-match.mjs grows from
// these, and most of them are functions no symbol table has a name for -- the
// correspondence is what it needs, not the name.
if (process.env.PAIRS_OUT) {
    const all = {};
    for (const [b, m] of pairs) {
        const ranked = [...m].sort((x, y) => y[1] - x[1]);
        const [w, top] = ranked[0];
        if (top < MIN_SHARED || top - (ranked[1]?.[1] ?? 0) < MARGIN) continue;
        const rev = bestForTarget.get(w);
        if (rev.fn !== b || rev.ties > 0) continue;
        all[b] = w;
    }
    fs.writeFileSync(process.env.PAIRS_OUT, JSON.stringify({ baseline: baseExe, target: targetExe, pairs: all }) + "\n");
    console.log(`wrote ${process.env.PAIRS_OUT} (${Object.keys(all).length} mutual-best pairs)`);
}

const table = JSON.parse(fs.readFileSync(tablePath, "utf8"));
const shared = new Map();
for (const rva of Object.values(table.symbols)) shared.set(rva, (shared.get(rva) ?? 0) + 1);

const stats = { total: 0, folded: 0, noStrings: 0, probed: 0, resolved: 0, tooFew: 0, tied: 0, notMutual: 0, contested: 0 };
const accepted = [];

for (const [name, rva] of Object.entries(table.symbols)) {
    if (ONLY && name !== ONLY) continue;
    stats.total++;
    if (shared.get(rva) > 1) { stats.folded++; continue; }
    const mine = base.byFunction.get(rva);
    if (!mine || mine.size === 0) { stats.noStrings++; continue; }
    stats.probed++;

    const votes = pairs.get(rva);
    if (votes === undefined) { stats.tooFew++; continue; }
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    const [winner, top] = ranked[0];
    const second = ranked[1]?.[1] ?? 0;
    if (top < MIN_SHARED) { stats.tooFew++; continue; }
    if (top - second < MARGIN) { stats.tied++; continue; }
    // The target has to choose this baseline function back, and choose it alone.
    const rev = bestForTarget.get(winner);
    if (rev.fn !== rva) { stats.notMutual++; continue; }
    if (rev.ties > 0) { stats.tied++; continue; }
    accepted.push({ name, rva: winner, shared: top, runnerUp: second, baselineStrings: mine.size });
}

// One target function cannot be two symbols. Mutual-best already rules most of
// this out; anything left is a genuine ambiguity and is dropped, not guessed.
const claims = new Map();
for (const a of accepted) claims.set(a.rva, (claims.get(a.rva) ?? 0) + 1);
const resolved = {}, detail = {};
for (const a of accepted) {
    if (claims.get(a.rva) > 1) { stats.contested++; continue; }
    stats.resolved++;
    resolved[a.name] = a.rva;
    detail[a.name] = { rva: a.rva, shared: a.shared, runnerUp: a.runnerUp, baselineStrings: a.baselineStrings };
}

const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : "0.0");
console.log(`\nmin-len ${MIN_LEN}  min-shared ${MIN_SHARED}  margin ${MARGIN}  max-ref ${MAX_REF}`);
console.log(`symbols in table      : ${stats.total}`);
console.log(`  COMDAT-folded       : ${stats.folded}`);
console.log(`  no string reference : ${stats.noStrings}`);
console.log(`  probed              : ${stats.probed}`);
console.log(`    resolved          : ${stats.resolved}  (${pct(stats.resolved, stats.probed)}% of probed, ${pct(stats.resolved, stats.total)}% of table)`);
console.log(`    too few shared    : ${stats.tooFew}`);
console.log(`    tied              : ${stats.tied}`);
console.log(`    not mutual best   : ${stats.notMutual}`);
console.log(`    contested target  : ${stats.contested}`);

if (process.env.OUT) {
    fs.writeFileSync(process.env.OUT, JSON.stringify({
        method: `string-literal anchoring, >=${MIN_SHARED} shared unique literals, winner ahead by >=${MARGIN}`,
        baseline: baseExe, target: targetExe, symbols: resolved, detail,
    }, null, 1) + "\n");
    console.log(`wrote ${process.env.OUT} (${Object.keys(resolved).length} symbols)`);
}
