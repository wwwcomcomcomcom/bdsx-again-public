/**
 * The bdsx fork ships each supported build's symbol table and pdbcache.bin stub inside its tree,
 * at bdsx/symbols/<version>/, where bdsx's installer copies them into bedrock_server/ (matched by the
 * exe's MD5). They must be byte-identical to what the sessions verified: data/symbols-<v>.json, and
 * work/pdbcache-<v>.bin when a stub was regenerated (tools/make-pdbcache-stub.mjs).
 *
 *   node tools/ship-tables.mjs          copy both builds' files into bdsx/symbols/ (then commit in bdsx/)
 *   node tools/ship-tables.mjs check    exit 1 if a shipped file differs from its source
 */
import * as fs from "fs";

const BUILDS = ["1.26.40.8", "1.26.51.1"];
const mode = process.argv[2] ?? "";
if (mode !== "" && mode !== "check") { console.error("usage: node tools/ship-tables.mjs [check]"); process.exit(2); }
let bad = false;
for (const v of BUILDS) {
    for (const [src, name, optional] of [[`data/symbols-${v}.json`, "symbols.json", false], [`work/pdbcache-${v}.bin`, "pdbcache.bin", true]]) {
        const dst = `bdsx/symbols/${v}/${name}`;
        if (!fs.existsSync(src)) {
            if (optional) continue; // the stub only changes with the exe; the shipped one stands
            console.error(`missing source ${src}`); process.exit(2);
        }
        if (mode === "check") {
            if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) { console.log(`differs: ${dst} (from ${src})`); bad = true; }
        } else {
            fs.mkdirSync(`bdsx/symbols/${v}`, { recursive: true });
            fs.copyFileSync(src, dst);
            console.log(`shipped ${dst}`);
        }
    }
}
if (mode === "check") { if (bad) process.exit(1); console.log("bdsx/symbols is current"); }
