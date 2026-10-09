/**
 * Promote vftable-walk names that two independently seeded walks agree on.
 *
 * Walk A is seeded from the resolved table (Endstone-derived, execution
 * confirmed). Walk B is seeded from the string-anchor / call-propagation
 * pairs, which share nothing with A but the baseline. Where both name a
 * target function the same, it is accepted; where they differ, both are
 * recorded and neither is promoted.
 *
 * The two walks share the alignment algorithm, so they can share an error
 * (Level::getSavedData: both walks put it one slot off, at a one-instruction
 * setter). A veto file of independently derived pairs -- the string-anchor /
 * call-propagation correspondence, baseline rva -> target rva -- removes any
 * entry it contradicts, and the number it confirms is reported as the
 * precision figure.
 *
 * A runtime packet table (tools/packet-vftables.mjs) can be given last; its
 * entries are exact and override the walks' packet vftables, which were 3 of
 * 9 wrong on those look-alike tables.
 *
 * Usage: node tools/vftable-corroborate.mjs <walkA.json> <walkB.json> <out.json> [required-symbols.json] [veto-pairs.json] [baseline-slots.json] [packets.json]
 */
import * as fs from "fs";
const [aPath, bPath, outPath, reqPath, vetoPath, slotsPath, packetsPath] = process.argv.slice(2);
const A = JSON.parse(fs.readFileSync(aPath, "utf8")), Bw = JSON.parse(fs.readFileSync(bPath, "utf8"));
const symbols = {}, vftables = {}, disagree = {};
let veto = null;
if (vetoPath) {
    const pairs = JSON.parse(fs.readFileSync(vetoPath, "utf8")).pairs;
    const names = JSON.parse(fs.readFileSync(slotsPath, "utf8")).names;
    veto = new Map();
    for (const [b, t] of Object.entries(pairs)) for (const n of names[b] ?? []) veto.set(n, t);
}
let vetoAgree = 0, vetoed = 0;
for (const [n, v] of Object.entries(A.symbols)) {
    if (!(n in Bw.symbols)) continue;
    if (Bw.symbols[n] !== v) { disagree[n] = { walkA: v, walkB: Bw.symbols[n] }; continue; }
    if (veto && veto.has(n)) {
        if (veto.get(n) === v) vetoAgree++;
        else { vetoed++; disagree[n] = { walks: v, independentPairs: veto.get(n) }; continue; }
    }
    symbols[n] = v;
}
for (const [n, v] of Object.entries(A.vftables)) {
    if (!(n in Bw.vftables)) continue;
    if (Bw.vftables[n] === v) vftables[n] = v; else disagree[n] = { walkA: v, walkB: Bw.vftables[n] };
}
let packetsOverridden = 0, packetsAdded = 0;
if (packetsPath) {
    const pk = JSON.parse(fs.readFileSync(packetsPath, "utf8")).vftables;
    for (const n of Object.keys(vftables)) if (/Packet@@6B@$/.test(n) && !(n in pk)) { delete vftables[n]; packetsOverridden++; }
    for (const [n, v] of Object.entries(pk)) { if (n in vftables && vftables[n] !== v) packetsOverridden++; else if (!(n in vftables)) packetsAdded++; vftables[n] = v; delete disagree[n]; }
}
const onlyA = Object.keys(A.symbols).filter(n => !(n in Bw.symbols)).length;
const onlyB = Object.keys(Bw.symbols).filter(n => !(n in A.symbols)).length;
let req = null;
if (reqPath) {
    const names = JSON.parse(fs.readFileSync(reqPath, "utf8")).symbols.map(s => s.name);
    req = { names: names.filter(n => n in symbols || n in vftables).length, of: names.length, vftables: names.filter(n => n in vftables).length };
}
fs.writeFileSync(outPath, JSON.stringify({
    _comment: `Virtual functions and vftables named by tools/vftable-match.mjs in two walks with independent seeds (A: ${A.seeds}; B: ${Bw.seeds}) that agree on the address. Both walks align vftable slot sequences from the 1.21.3.01 PDB against the target's code-referenced pointer tables. Entries where the walks disagree are listed under "disagree" and are not candidates.`,
    target: A.target, runtimePackets: packetsPath ? { file: packetsPath, added: packetsAdded, walkEntriesReplacedOrDropped: packetsOverridden } : null, independentCheck: veto ? { overlap: vetoAgree + vetoed, agree: vetoAgree, vetoed } : null, agree: { symbols: Object.keys(symbols).length, vftables: Object.keys(vftables).length }, onlyInA: onlyA, onlyInB: onlyB, requiredCoverage: req, symbols, vftables, disagree,
}, null, 1));
if (packetsPath) console.log(`runtime packets: added ${packetsAdded}, walk packet entries replaced or dropped ${packetsOverridden}`);
if (veto) console.log(`independent pairs: overlap ${vetoAgree + vetoed}, agree ${vetoAgree}, vetoed ${vetoed}`);
console.log(`agree: ${Object.keys(symbols).length} names, ${Object.keys(vftables).length} vftables; disagree ${Object.keys(disagree).length}; only A ${onlyA}, only B ${onlyB}${req ? `; bdsx required covered ${req.names}/${req.of} (${req.vftables} vftables)` : ""} -> ${outPath}`);
