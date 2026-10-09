/**
 * Turn a corroborated cross-build walk (tools/vftable-corroborate.mjs over
 * two walks aligned against the previous build's named tables) into a
 * candidate file for tools/merge-symbols.mjs.
 *
 * Placeholder tables (`vft_0x...`, unnamed on the previous build) are
 * dropped. A previous-build address that carried several names (identical-
 * code folding) transfers only its virtual names, since table alignment can
 * vouch for nothing else. Every remaining name is scored against what the
 * new build already has from its own routes, and the agreement is written
 * into the file as the precision figure.
 *
 * Usage: node tools/carry-candidates.mjs <fromVersion> <toVersion> <corroborated.json> <out.json>
 */
import * as fs from "fs";
const [from, to, inPath, out] = process.argv.slice(2);
const load = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const C = load(inPath);
const S = load(`work/vft/slots-${from}.json`);
const known = {};
for (const f of [`data/resolved-${to}.json`, `data/candidates-instances-${to}.json`, `data/candidates-packets-${to}.json`, `data/candidates-vftable-${to}.json`]) { const j = load(f); for (const m of [j?.symbols, j?.vftables]) for (const [n, r] of Object.entries(m ?? {})) if (typeof r === "number" && !(n in known)) known[n] = r; }
const required = new Set(load("data/required-symbols.json").symbols.map(s => s.name));
const isVirtual = n => /^\?\?_[EG]/.test(n) || /^\?[^@]*(?:@[^@]+)*@@[EFMNUV]/.test(n);
const byName = new Map(); for (const [r, ns] of Object.entries(S.names)) for (const n of ns) byName.set(n, ns);
const symbols = {}, vftables = {};
let agree = 0, disagree = 0, folded = 0;
const dis = [];
for (const [n, r] of Object.entries(C.symbols)) {
    const siblings = byName.get(n) ?? [n];
    if (siblings.length > 1 && !isVirtual(n)) { folded++; continue; }
    if (n in known) { if (known[n] === r) agree++; else { disagree++; dis.push(n); continue; } }
    symbols[n] = r;
}
for (const [n, r] of Object.entries(C.vftables)) { if (n.startsWith("vft_")) continue; if (n in known) { if (known[n] === r) agree++; else { disagree++; dis.push(n); continue; } } vftables[n] = r; }
const req = Object.keys(symbols).filter(n => required.has(n)), newReq = req.filter(n => !(n in known));
fs.writeFileSync(out, JSON.stringify({
    _comment: `Names carried from ${from} to ${to} by aligning ${to}'s scanned vftables against ${from}'s named tables (tools/slots-from-named.mjs, two seed-independent walks of tools/vftable-match.mjs, tools/vftable-corroborate.mjs with the ${from}->${to} string/call-edge pairs as veto). Scored against what ${to} already had from its own routes: agree ${agree}, disagree ${disagree} (the disagreements are excluded). ${folded} non-virtual names riding on folded addresses dropped.`,
    from, to, precision: { agree, disagree }, excludedDisagreements: dis, symbols, vftables,
}, null, 1));
console.log(`carry ${from} -> ${to}: agree ${agree}, disagree ${disagree} (excluded), folded non-virtual dropped ${folded}; ${Object.keys(symbols).length} names, ${Object.keys(vftables).length} vftables; required ${req.length} (${newReq.length} not already known) -> ${out}`);
