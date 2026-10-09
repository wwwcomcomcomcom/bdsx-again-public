/**
 * Build a propagation seed file (baseline rva -> target rva) from everything
 * a build's table already knows: the merged table plus any candidate file,
 * mapped to 1.21.3.01 through the full PDB names, unioned with an existing
 * pair file. Propagation is a mutual-best vote, so a larger seed set moves
 * its marginal pairs; tools/pairs-in-tables.mjs then keeps only those that
 * vftable membership independently supports.
 *
 * Usage: node tools/seeds-from-known.mjs <version> <out.json> <pairs.json> [candidates.json...]
 */
import * as fs from "fs";
const [v, out, pairFile, ...extra] = process.argv.slice(2);
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const full = load("data/baseline-symbols.json").symbols;
const p = load(pairFile);
const pairs = { ...p.pairs };
let added = 0, conflicts = 0;
for (const f of [`data/merged-${v}.json`, ...extra]) {
    for (const [n, t] of Object.entries(load(f).symbols)) {
        const b = full[n]; if (b === undefined || typeof t !== "number") continue;
        if (pairs[b] === undefined) { pairs[b] = t; added++; } else if (pairs[b] !== t) conflicts++;
    }
}
fs.writeFileSync(out, JSON.stringify({ baseline: p.baseline, target: p.target, pairs }));
console.log(`${pairFile}: ${Object.keys(p.pairs).length} pairs + ${added} from named functions (${conflicts} conflicts kept the pair) -> ${out}`);
