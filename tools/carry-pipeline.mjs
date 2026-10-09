/**
 * Carry names from one stripped build to the next by vftable alignment.
 *
 *   node tools/carry-pipeline.mjs 1.26.40.8 1.26.51.1 work/derived40to51
 *
 * The previous build's named tables (tools/slots-from-named.mjs) stand in
 * for the PDB baseline: two builds weeks apart share a compiler and almost
 * every slot. Walk A is seeded from the new build's resolved table, walk B
 * from the string-anchored pairs between the two builds (<derived>/str-pairs.json);
 * the two are corroborated and vetoed with the full pair set (<derived>/pairs.json).
 * Output: data/candidates-carry-<to>.json. $WALK overrides the walk options.
 */
import * as fs from "fs";
import { spawnSync } from "child_process";

const [FROM, TO, D] = process.argv.slice(2);
if (!FROM || !TO || !D) { console.error("usage: node tools/carry-pipeline.mjs <from> <to> <derived-dir>"); process.exit(2); }
const WALK = (process.env.WALK || "--strictUniform=0.7").split(/\s+/).filter(Boolean);
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));

function node(args, filter) {
    const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
    const out = (r.stdout + r.stderr).split("\n").filter(Boolean);
    for (const l of filter ? filter(out) : out) console.log(l);
    if (r.status !== 0) { console.error(`!! ${args.find(a => a.startsWith("tools/"))} exited ${r.status}`); process.exit(1); }
}

fs.mkdirSync("work/vft", { recursive: true });
if (!fs.existsSync(`work/vft/scan-${TO}.json`)) node(["tools/vftable-scan.mjs", `work/bin/${TO}/bedrock_server.exe`, `work/vft/scan-${TO}.json`]);
node(["tools/slots-from-named.mjs", FROM, `work/vft/slots-${FROM}.json`]);
{
    const S = load(`work/vft/slots-${FROM}.json`).names;
    const sp = load(`${D}/str-pairs.json`);
    const pairs = sp.pairs ?? sp;
    const symbols = {};
    let n = 0;
    for (const [b, t] of Object.entries(pairs)) { const ns = S[b]; if (!ns) continue; for (const nm of ns) { symbols[nm] = t; n++; } }
    fs.writeFileSync(`work/vft/seeds-carry-B-${TO}.json`, JSON.stringify({ symbols }));
    console.log("walk B seeds:", n);
}
const walk = (seeds, out) => node(["--max-old-space-size=12288", "tools/vftable-match.mjs", `--baseline=work/vft/slots-${FROM}.json`, `--target=work/vft/scan-${TO}.json`, `--seeds=${seeds}`, ...WALK, `--out=${out}`], o => o.slice(-1));
console.log(`== walk A (${FROM} -> ${TO}, seeds: resolved-${TO})`); walk(`data/resolved-${TO}.json`, `work/vft/carry-A-${TO}.json`);
console.log(`== walk B (${FROM} -> ${TO}, seeds: string pairs)`); walk(`work/vft/seeds-carry-B-${TO}.json`, `work/vft/carry-B-${TO}.json`);
const PK = fs.existsSync(`data/candidates-packets-${TO}.json`) ? [`data/candidates-packets-${TO}.json`] : [];
console.log("== corroborate");
node(["tools/vftable-corroborate.mjs", `work/vft/carry-A-${TO}.json`, `work/vft/carry-B-${TO}.json`, `work/vft/carry-AB-${TO}.json`, "data/required-symbols.json", `${D}/pairs.json`, `work/vft/slots-${FROM}.json`, ...PK], o => o.slice(-2));
node(["tools/carry-candidates.mjs", FROM, TO, `work/vft/carry-AB-${TO}.json`, `data/candidates-carry-${TO}.json`]);
