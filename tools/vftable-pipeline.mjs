/**
 * Regenerate data/candidates-vftable-<version>.json from scratch (docs/findings-vftable.md).
 *
 *   node tools/vftable-pipeline.mjs <version> <pairs.json> [extra-seeds.json]
 *
 * Two vftable walks from independent seeds (A: data/resolved-<v>.json, B: the call-edge pairs),
 * corroborated; the corroborated virtuals then seed call-edge propagation, whose pairs seed a
 * third walk (B2); A and B2 corroborated is the candidate file. A single walk is 90-95% right,
 * which is why nothing from one walk alone is kept. $WALK overrides the walk options
 * (default --strictUniform=0.7).
 *
 * Needs work/bin/<v>/bedrock_server.exe, work/bin/1.21.3.01/bedrock_server.exe and
 * data/baseline-symbols.json (docs/reference.md, "Commands").
 */
import * as fs from "fs";
import { spawnSync } from "child_process";

const [V, PAIRS, EXTRA] = process.argv.slice(2);
if (!V || !PAIRS) { console.error("usage: node tools/vftable-pipeline.mjs <version> <pairs.json> [extra-seeds.json]"); process.exit(2); }
const WALK = (process.env.WALK || "--strictUniform=0.7").split(/\s+/).filter(Boolean);
const EXE = `work/bin/${V}/bedrock_server.exe`;
const BASE = "work/bin/1.21.3.01/bedrock_server.exe";
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const save = (f, o) => fs.writeFileSync(f, JSON.stringify(o));

// run a node tool; `filter` keeps only the lines it accepts (the shell version piped through tail/grep)
function node(args, filter) {
    const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
    const out = (r.stdout + r.stderr).split("\n").filter(Boolean);
    for (const l of filter ? filter(out) : out) console.log(l);
    if (r.status !== 0) { console.error(`!! ${args[0]} exited ${r.status}`); process.exit(1); }
}
const last = out => out.slice(-1);

fs.mkdirSync("work/vft", { recursive: true });
if (!fs.existsSync("work/vft/baseline-slots.json")) node(["tools/vftable-slots.mjs", BASE, "data/baseline-symbols.json", "work/vft/baseline-slots.json"]);
if (!fs.existsSync(`work/vft/scan-${V}.json`)) node(["tools/vftable-scan.mjs", EXE, `work/vft/scan-${V}.json`]);
const B = load("work/vft/baseline-slots.json");
const SEEDS_A = `data/resolved-${V}.json${EXTRA ? "," + EXTRA : ""}`;

// baseline rva -> target rva pairs, as named seeds
const pairsToSeeds = (pairs, out) => {
    const symbols = {};
    for (const [b, t] of Object.entries(pairs)) { const ns = B.names[b]; if (ns) symbols[ns[0]] = t; }
    save(out, { symbols });
};
pairsToSeeds(load(PAIRS).pairs, `work/vft/seeds-pairs-${V}.json`);

const walk = (seeds, out) => node(["tools/vftable-match.mjs", "--baseline=work/vft/baseline-slots.json", `--target=work/vft/scan-${V}.json`, `--seeds=${seeds}`, ...WALK, `--out=${out}`], last);
console.log(`== walk A (${V})`); walk(SEEDS_A, `work/vft/match-A-${V}.json`);
console.log(`== walk B (${V})`); walk(`work/vft/seeds-pairs-${V}.json`, `work/vft/match-B-${V}.json`);

const PK = [];
if (fs.existsSync(`work/vft/vp-run-${V}.txt`)) {
    node(["tools/packet-vftables.mjs", `work/vft/vp-run-${V}.txt`, "bdsx/bdsx/bds/packetids.ts", "work/vft/baseline-slots.json", `data/candidates-packets-${V}.json`], out => out.slice(0, 1));
    PK.push(`data/candidates-packets-${V}.json`);
}
console.log("== corroborate A/B");
node(["tools/vftable-corroborate.mjs", `work/vft/match-A-${V}.json`, `work/vft/match-B-${V}.json`, `work/vft/corroborated-AB-${V}.json`, "data/required-symbols.json", PAIRS, "work/vft/baseline-slots.json", ...PK]);

console.log("== propagate with corroborated virtuals as extra seeds");
{
    const p = load(PAIRS), c = load(`work/vft/corroborated-AB-${V}.json`);
    const rvaOfName = new Map();
    for (const [r, ns] of Object.entries(B.names)) for (const n of ns) rvaOfName.set(n, Number(r));
    const pairs = { ...p.pairs };
    let added = 0;
    for (const [n, t] of Object.entries(c.symbols)) {
        const b = rvaOfName.get(n);
        if (b === undefined || pairs[b] !== undefined) continue;
        pairs[b] = t; added++;
    }
    save(`work/vft/seeds-prop-${V}.json`, { baseline: p.baseline, target: p.target, pairs });
    console.log("propagation seeds:", Object.keys(pairs).length, "(+" + added + " virtuals)");
}
process.env.PAIRS_OUT = `work/vft/pairs2-${V}.json`;
process.env.OUT = `work/vft/prop2-${V}.json`;
node(["tools/propagate-match.mjs", BASE, EXE, `work/vft/seeds-prop-${V}.json`, "data/baseline-1.21.3.01.json"], out => out.filter(l => /wrote|matched:/.test(l)));
pairsToSeeds(load(`work/vft/pairs2-${V}.json`).pairs, `work/vft/seeds-pairs2-${V}.json`);

console.log(`== walk B2 (${V})`); walk(`work/vft/seeds-pairs2-${V}.json`, `work/vft/match-B2-${V}.json`);
console.log(`== corroborate A/B2 -> data/candidates-vftable-${V}.json`);
node(["tools/vftable-corroborate.mjs", `work/vft/match-A-${V}.json`, `work/vft/match-B2-${V}.json`, `data/candidates-vftable-${V}.json`, "data/required-symbols.json", PAIRS, "work/vft/baseline-slots.json", ...PK]);
