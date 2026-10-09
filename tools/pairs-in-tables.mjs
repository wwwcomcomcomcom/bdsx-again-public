/**
 * Name vftable slots where two independent routes agree: a call-edge pair
 * and table membership.
 *
 * The vftable walk (tools/vftable-match.mjs) leaves a slot open when the
 * table-count sequence around it is uniform -- a run of Level virtuals that
 * all sit in exactly two tables looks the same to it, so one insertion in
 * the run makes every slot ambiguous. Call-edge propagation
 * (tools/propagate-match.mjs) pairs functions by who they call, and knows
 * nothing about vftables. Where a propagation pair (b -> t) lands t in a
 * target table that is already paired with a baseline table holding b, the
 * two routes agree on the name and neither could have copied the other.
 *
 * The named target tables come from the sources that are exact or
 * corroborated (live instances, live packets, the two-walk agreement); the
 * pair files are the propagation outputs. Precision is measured before
 * anything is written: every rule hit whose target the walks already named
 * is scored against that name, and the resolved table is checked the same
 * way.
 *
 * A pair file whose baseline is another stripped build (the 1.26.40.8 ->
 * 1.26.51.1 correspondence, 19,203 pairs at 11/11) is accepted too: its left
 * side is translated to 1.21.3.01 through that build's own named table.
 *
 * A baseline function that carries several names (identical-code folding:
 * every `mov rax,[rcx+8]; ret` is one function) is named only by those that
 * are virtual, since table membership can vouch for nothing else.
 *
 * Usage: node tools/pairs-in-tables.mjs <version> <out.json> <pairs.json>...
 */
import * as fs from "fs";
const [v, out, ...pairFiles] = process.argv.slice(2);
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const B = load("work/vft/baseline-slots.json");
const T = load(`work/vft/scan-${v}.json`).vftables;
const walk = load(`data/candidates-vftable-${v}.json`);
const inst = load(`data/candidates-instances-${v}.json`);
const packets = load(`data/candidates-packets-${v}.json`);
const resolved = load(`data/resolved-${v}.json`).symbols;
const required = new Set(load("data/required-symbols.json").symbols.map(s => s.name));

// Named target tables: name -> target rva, most trusted source first.
const tableName = new Map();   // target table rva -> Set(baseline table name)
const tableSource = new Map();
for (const [src, map] of [["instances", inst.vftables], ["packets", packets.vftables], ["walk", walk.vftables]]) {
    for (const [n, r] of Object.entries(map ?? {})) {
        if (!(n in B.vftables)) continue;
        (tableName.get(r) ?? tableName.set(r, new Set()).get(r)).add(n);
        if (!tableSource.has(r)) tableSource.set(r, src);
    }
}
// Baseline: function -> [{table name, slot}]; target: function -> [{table rva, slot}]
const bIndex = new Map();
for (const [n, t] of Object.entries(B.vftables)) t.slots.forEach((f, i) => (bIndex.get(f) ?? bIndex.set(f, []).get(f)).push({ n, i }));
const tIndex = new Map();
for (const t of Object.values(T)) t.slots.forEach((f, i) => (tIndex.get(f) ?? tIndex.set(f, []).get(f)).push({ r: t.rva, i }));

const nameToBaseline = new Map();
for (const [r, ns] of Object.entries(B.names)) for (const n of ns) nameToBaseline.set(n, Number(r));
const isVirtual = n => /^\?\?_[EG]/.test(n) || /^\?[^@]*(?:@[^@]+)*@@[EFMNUV]/.test(n);

// Which pair files hold each pair. A pair file from another stripped build
// is translated: its left rva -> that build's names -> baseline rva.
const pairs = new Map();   // baseline fn -> Map(target fn -> [file])
for (const pf of pairFiles) {
    const j = load(pf);
    let translate = null;
    const bv = (j.baseline ?? "").match(/work\/bin\/([^/]+)\//)?.[1];
    if (bv && bv !== "1.21.3.01") {
        const byRva = new Map();
        for (const f of [`data/merged-${bv}.json`, `data/candidates-pairs-in-tables-${bv}.json`]) {
            if (!fs.existsSync(f)) continue;
            for (const [n, r] of Object.entries(load(f).symbols)) { const b = nameToBaseline.get(n); if (b !== undefined) (byRva.get(r) ?? byRva.set(r, new Set()).get(r)).add(b); }
        }
        translate = r => [...(byRva.get(r) ?? [])];
        console.log(`${pf}: baseline is ${bv}, translating through ${byRva.size} named functions`);
    }
    let used = 0;
    for (const [l, t] of Object.entries(j.pairs)) {
        for (const b of translate ? translate(Number(l)) : [Number(l)]) {
            const m = pairs.get(b) ?? pairs.set(b, new Map()).get(b);
            (m.get(t) ?? m.set(t, []).get(t)).push(pf); used++;
        }
    }
    console.log(`${pf}: ${used} pairs`);
}

const walkByTarget = new Map();
for (const [n, r] of Object.entries(walk.symbols)) (walkByTarget.get(r) ?? walkByTarget.set(r, []).get(r)).push(n);
const resolvedByTarget = new Map();
for (const [n, r] of Object.entries(resolved)) (resolvedByTarget.get(r) ?? resolvedByTarget.set(r, []).get(r)).push(n);

const symbols = {}, evidence = {};
let hits = 0, walkAgree = 0, walkDisagree = 0, resAgree = 0, resDisagree = 0, conflicts = 0, newNames = 0, newRequired = 0;
const disagreements = [];
for (const [b, targets] of pairs) {
    const bTables = bIndex.get(b);
    if (!bTables) continue;
    for (const [t, files] of targets) {
        const tTables = tIndex.get(t);
        if (!tTables) continue;
        // Every (baseline table, target table) pair where the target table is
        // named as that baseline table and both hold the function.
        const matches = [];
        for (const { r, i } of tTables) {
            const names = tableName.get(r);
            if (!names) continue;
            for (const { n, i: bi } of bTables) if (names.has(n)) matches.push({ table: n, targetTable: r, slot: i, baselineSlot: bi, source: tableSource.get(r) });
        }
        if (!matches.length) continue;
        hits++;
        const all = B.names[b] ?? [];
        const names = all.length > 1 ? all.filter(isVirtual) : all;
        if (!names.length) continue;
        // Precision proxies: the walks' name for this target, and the resolved table's.
        const w = walkByTarget.get(t);
        if (w) { if (w.some(n => names.includes(n))) walkAgree++; else { walkDisagree++; disagreements.push({ pair: names[0], walk: w[0], t }); } }
        const rs = resolvedByTarget.get(t);
        if (rs) { if (rs.some(n => names.includes(n))) resAgree++; else resDisagree++; }
        // Also: the resolved/walk name for the *baseline* function must not point elsewhere.
        let elsewhere = false;
        for (const n of names) { if (n in resolved && resolved[n] !== t) elsewhere = true; if (n in walk.symbols && walk.symbols[n] !== t) elsewhere = true; }
        if (elsewhere) { conflicts++; continue; }
        for (const n of names) {
            if (n in symbols && symbols[n] !== t) { conflicts++; continue; }
            if (!(n in walk.symbols) && !(n in resolved)) { if (!(n in symbols)) { newNames++; if (required.has(n)) newRequired++; } }
            symbols[n] = t;
            evidence[n] = { pairFiles: files.map(f => f.replace(/^work\//, "")), tables: matches.length, in: matches.slice(0, 3).map(m => `${m.table}#${m.slot} (baseline #${m.baselineSlot}, table from ${m.source})`) };
        }
    }
}
const req = Object.keys(symbols).filter(n => required.has(n));
console.log(`rule hits ${hits}; vs walk names: agree ${walkAgree}, disagree ${walkDisagree}; vs resolved: agree ${resAgree}, disagree ${resDisagree}; conflicts dropped ${conflicts}`);
for (const d of disagreements.slice(0, 10)) console.log(`  disagree: pair says ${d.pair.slice(0, 60)}, walk says ${d.walk.slice(0, 60)} at 0x${d.t.toString(16)}`);
console.log(`names ${Object.keys(symbols).length} (${newNames} not already walk/resolved), required ${req.length} (${newRequired} new)`);
fs.writeFileSync(out, JSON.stringify({
    _comment: `Slots named where a call-edge pair and vftable membership agree (tools/pairs-in-tables.mjs): the propagation pair (b -> t) lands t in a target table already paired with a baseline table that holds b. Two routes that share nothing but the baseline. Measured before writing: of the ${walkAgree + walkDisagree} hits the walks also named, ${walkAgree} agree; of the ${resAgree + resDisagree} the resolved table holds, ${resAgree} agree.`,
    target: `work/bin/${v}/bedrock_server.exe`, pairFiles, precision: { walkAgree, walkDisagree, resolvedAgree: resAgree, resolvedDisagree: resDisagree, conflictsDropped: conflicts },
    symbols, evidence,
}, null, 1));
console.log(`-> ${out}`);
