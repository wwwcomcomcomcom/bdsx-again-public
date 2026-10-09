/**
 * Fetch the baseline: BDS 1.21.3.01, the last build Mojang shipped with bedrock_server.pdb, and
 * the name -> RVA table bdsx published for it. Every route that compares a 1.26 function with its
 * 2024 self reads these (docs/findings-survey.md), and tools/merge-symbols.mjs reads the exe.
 *
 *   node tools/fetch-baseline.mjs
 *
 * Writes (all gitignored):
 *   work/bin/1.21.3.01/bedrock_server.exe, bedrock_server.pdb   from minecraft.net's archive
 *   work/pdbcache-1.21.3.01.bin                                  from github.com/bdsx/pdbcache (pdbcachegen output)
 *   data/baseline-symbols.json                                   tools/dump-pdbcache.mjs over it (713,055 names, 151MB)
 * Works on any OS with `tar` that reads zip (Windows 10+, macOS). About 95MB of downloads.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const V = "1.21.3.01";
const BIN = `work/bin/${V}`;
const BDS_ZIP = `https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-${V}.zip`;
const PDBCACHE_ZIP = `https://github.com/bdsx/pdbcache/releases/download/${V}/pdbcache.zip`;

async function download(url, to) {
    if (fs.existsSync(to)) return;
    console.log(`== ${url}`);
    // a plain browser user-agent: minecraft.net's CDN answered a descriptive one with headers and then no body
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const total = Number(r.headers.get("content-length")) || 0;
    const fd = fs.openSync(to + ".part", "w");
    let n = 0, shown = 0;
    for await (const chunk of r.body) {
        fs.writeSync(fd, chunk);
        n += chunk.length;
        if (n - shown > 16 << 20) { shown = n; console.log(`   ${(n / 1048576).toFixed(0)}MB${total ? ` of ${(total / 1048576).toFixed(0)}MB` : ""}`); }
    }
    fs.closeSync(fd);
    if (total && n !== total) throw new Error(`${url}: got ${n} of ${total} bytes`);
    fs.renameSync(to + ".part", to);
}
function untar(zip, dir, members) {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync("tar", ["-xf", zip, "-C", dir, ...members], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar could not extract ${members.join(", ")} from ${zip}`);
}

fs.mkdirSync("work/downloads", { recursive: true });
if (!fs.existsSync(`${BIN}/bedrock_server.exe`) || !fs.existsSync(`${BIN}/bedrock_server.pdb`)) {
    await download(BDS_ZIP, `work/downloads/bedrock-server-${V}.zip`);
    untar(`work/downloads/bedrock-server-${V}.zip`, BIN, ["bedrock_server.exe", "bedrock_server.pdb"]);
}
if (!fs.existsSync(`work/pdbcache-${V}.bin`)) {
    await download(PDBCACHE_ZIP, `work/downloads/pdbcache-${V}.zip`);
    untar(`work/downloads/pdbcache-${V}.zip`, "work/downloads", ["pdbcache.bin"]);
    fs.renameSync("work/downloads/pdbcache.bin", `work/pdbcache-${V}.bin`);
}
if (!fs.existsSync("data/baseline-symbols.json")) {
    const r = spawnSync(process.execPath, ["tools/dump-pdbcache.mjs", `work/pdbcache-${V}.bin`, "data/baseline-symbols.json", V], { stdio: "inherit" });
    if (r.status !== 0) process.exit(1);
}
for (const f of [`${BIN}/bedrock_server.exe`, `${BIN}/bedrock_server.pdb`, `work/pdbcache-${V}.bin`, "data/baseline-symbols.json"]) {
    console.log(`${String(fs.statSync(f).size).padStart(11)}  ${f}`);
}
