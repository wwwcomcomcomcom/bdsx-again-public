/**
 * Fill work/ with what the analysis tools and tools/docs-check.mjs read besides the binaries:
 *
 *   work/endstone          Endstone at 0c7cf5e (targets BDS 1.26.51), shallow    -- endstone-slots, arch-inventory
 *   work/endstone-0.11.7   Endstone v0.11.7 (targets BDS 1.26.40), shallow         -- the same, for 1.26.40.8
 *   work/entt/typenames-<v>.json, image-names-<v>.json  (tools/entt-typenames.mjs, tools/image-names.mjs)
 *   work/derived/shape-cache-<v>.json                    (tools/merge-symbols.mjs's argument-shape check)
 *
 *   node tools/prepare-work.mjs
 *
 * Needs work/bin/<v>/bedrock_server.exe for both 1.26 builds and 1.21.3.01 (tools/host/setup-lab.mjs,
 * tools/fetch-baseline.mjs) and git; the shape cache also needs LLVM (tools/llvm.mjs) and is skipped, with a
 * note, without it (docs-check does not need it). Idempotent.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const BUILDS = ["1.26.40.8", "1.26.51.1"];
const ENDSTONE = "https://github.com/EndstoneMC/endstone.git";

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
    if (r.status !== 0) { console.error(`!! ${cmd} ${args.join(" ")} exited ${r.status}`); process.exit(1); }
}
for (const v of [...BUILDS, "1.21.3.01"]) {
    if (!fs.existsSync(`work/bin/${v}/bedrock_server.exe`)) { console.error(`work/bin/${v}/bedrock_server.exe is missing: node tools/host/setup-lab.mjs (or tools/fetch-baseline.mjs for 1.21.3.01)`); process.exit(2); }
}

// ---- Endstone, at the two exact revisions the candidate files were made from
if (!fs.existsSync("work/endstone/src")) {
    console.log("== Endstone 0c7cf5e -> work/endstone");
    fs.mkdirSync("work/endstone", { recursive: true });
    run("git", ["-C", "work/endstone", "init", "-q"]);
    run("git", ["-C", "work/endstone", "fetch", "-q", "--depth", "1", ENDSTONE, "0c7cf5ecf48a62c5d079626c6455e237c139c912"]);
    run("git", ["-C", "work/endstone", "checkout", "-q", "FETCH_HEAD"]);
}
if (!fs.existsSync("work/endstone-0.11.7/src")) {
    console.log("== Endstone v0.11.7 -> work/endstone-0.11.7");
    run("git", ["clone", "-q", "--depth", "1", "--branch", "v0.11.7", ENDSTONE, "work/endstone-0.11.7"]);
}

// ---- what the binaries say about themselves
fs.mkdirSync("work/entt", { recursive: true });
for (const v of [...BUILDS, "1.21.3.01"]) {
    if (!fs.existsSync(`work/entt/typenames-${v}.json`)) run(process.execPath, ["tools/entt-typenames.mjs", `work/bin/${v}/bedrock_server.exe`, `--out=work/entt/typenames-${v}.json`]);
    if (!fs.existsSync(`work/entt/image-names-${v}.json`)) run(process.execPath, ["tools/image-names.mjs", v]);
}

// ---- the argument-shape cache: a merge computes it (and rewrites data/merged-<v>.json identically)
const haveLlvm = spawnSync(process.execPath, ["-e", 'import("./tools/llvm.mjs").then(m => m.llvm("llvm-mc"))'], { stdio: "ignore" }).status === 0;
if (!haveLlvm) console.log("!! LLVM not found: skipping the shape cache (winget install LLVM.LLVM, then run this again)");
fs.mkdirSync("work/derived", { recursive: true });
for (const v of haveLlvm ? BUILDS : []) {
    if (fs.existsSync(`work/derived/shape-cache-${v}.json`)) continue;
    console.log(`== merge ${v} (fills work/derived/shape-cache-${v}.json)`);
    run(process.execPath, ["tools/merge-symbols.mjs", v, `data/merged-${v}.json`]);
}
console.log("work/ is ready: node tools/docs-check.mjs");
