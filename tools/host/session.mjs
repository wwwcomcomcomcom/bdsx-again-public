/**
 * One probing session on this machine, start to finish.
 *
 *   node tools/host/session.mjs <40|51|inst40|inst51> <driver.ps1> [--grep='regex'] [--upload=src:dst ...] [--no-sync]
 *
 * The first argument names a lab *instance*, not a build: <lab>/inst40 and inst51 are two complete
 * bdsx installs, one per BDS build (tools/host/lab.mjs, tools/host/setup-lab.mjs).
 *
 * What it does, in order (each step is something that used to be done by hand, and forgotten):
 *   1. takes the instance lock (one session per instance; at most two sessions at a time)
 *   2. copies the bdsx source files that differ between bdsx/ (the submodule, where edits are made)
 *      and the instance
 *   3. copies every probe plugin (PROBES below) into <inst>/example_and_test/zz-*.ts and
 *      tools/host/index-probes.ts to <inst>/index.ts, plus any --upload pairs (dst is relative to the lab),
 *      then compiles the instance (tsc) and refreshes its full-launcher.js
 *   4. installs this build's data/symbols-<v>.json and pdbcache.bin stub into <inst>/bedrock_server
 *   5. runs the driver (PowerShell) with $env:BDSX_REPO and $env:BDSX_LAB set, then prints the
 *      lines matching --grep plus the crash markers
 *   6. FAILS (exit 1) when the run is not a result: no exit code reported, no output at all, a crash
 *      marker, or a nonzero exit code without BDS's own "Quit correctly"
 * The transcript goes to work/host-runs/<tag>-<time>.txt.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { REPO, LAB, RUNS, instance, labEnv, lockInstance, peek } from "./lab.mjs";

// tools/<file>.ts -> <inst>/example_and_test/<name>.ts; tools/host/index-probes.ts imports them
const PROBES = [
    ["accessor-probe", "zz-accprobe"], ["origin-probe", "zz-originprobe"], ["gamerules-probe", "zz-grprobe"],
    ["entity-sig-probe", "zz-sigprobe"], ["actor-layout-probe", "zz-layoutprobe"], ["alloc-probe", "zz-allocprobe"],
    ["item-probe", "zz-itemprobe"], ["block-probe", "zz-blkprobe"], ["abilities-probe", "zz-abilprobe"],
    ["packet-probe", "zz-pktprobe"], ["packet-send-probe", "zz-pksprobe"], ["console-probe", "zz-conprobe"],
    ["structure-probe", "zz-stprobe"], ["softenum-probe", "zz-seprobe"], ["itemcomp-probe", "zz-icprobe"],
    ["container-probe", "zz-contprobe"], ["nav-probe", "zz-navprobe"], ["component-probe", "zz-compprobe"],
    ["simplayer-probe", "zz-simpprobe"], ["livebot-probe", "zz-lbprobe"],
];
// what the sync copies: sources and the few data files bdsx loads; never node_modules or compiled output it does not track
const SYNC_EXT = /\.(ts|js|json|asm|map)$/;
// files the session itself writes into the instance; bdsx/ has its own versions of them
const SESSION_OWNED = new Set(["index.ts", "index.js"]);

const args = process.argv.slice(2);
const [instArg, driverArg] = args;
if (!instArg || !driverArg) { console.error("usage: node tools/host/session.mjs <40|51> <driver.ps1> [--grep='regex'] [--upload=src:dst ...] [--no-sync]"); process.exit(2); }
let GREP = "PASS|FAIL", SYNC = true;
const uploads = [];
for (const a of args.slice(2)) {
    if (a.startsWith("--grep=")) GREP = a.slice(7).replace(/^'(.*)'$/, "$1");
    else if (a === "--no-sync") SYNC = false;
    else if (a.startsWith("--upload=")) {
        const v = a.slice(9), i = v.lastIndexOf(":");
        // a Windows source path has its own colon (C:\...); the separator is the last one
        uploads.push([v.slice(0, i), v.slice(i + 1).replace(/^[A-Za-z]:[\\/]bdsx-again[\\/]/, "")]);
    } else { console.error(`unknown option ${a}`); process.exit(2); }
}
const inst = instance(instArg);
const driver = path.resolve(driverArg);
if (!fs.existsSync(driver)) { console.error(`no such driver: ${driverArg}`); process.exit(2); }
const TAG = (fs.readFileSync(driver, "utf8").match(/-Tag ([A-Za-z0-9_-]+)/) || [])[1];
if (!TAG) { console.error(`${driverArg} has no -Tag`); process.exit(2); }
if (process.platform !== "win32") { console.error("BDS runs on Windows only: run this on the Windows machine that holds the lab (docs/lab-runbook.md)"); process.exit(2); }
if (!fs.existsSync(path.join(inst.dir, "bedrock_server", "bedrock_server.exe"))) { console.error(`${inst.dir} is not set up: node tools/host/setup-lab.mjs`); process.exit(2); }

process.chdir(REPO);
fs.mkdirSync(path.join(REPO, "work", "host-runs"), { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const LOG = path.join("work", "host-runs", `${TAG}-${stamp}.txt`);
const transcript = [];
const log = (...m) => { const l = m.join(" "); console.log(l); transcript.push(l); };

let failed = true; // fail closed: only a run that reports an exit code and passes the checks clears this
const release = lockInstance(inst.name, { log });
try {
    log(`== ${TAG} on ${inst.build} in ${inst.dir} (${new Date().toString()})`);

    // ---- 2. sync bdsx/ -> instance (before the probes: bdsx/index.ts must not replace the probe index)
    if (SYNC) {
        const git = a => spawnSync("git", ["-C", "bdsx", ...a], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout.split("\n").filter(Boolean);
        const files = new Set([...git(["ls-files"]), ...git(["ls-files", "--others", "--exclude-standard"])]);
        let n = 0;
        for (const f of files) {
            if (!SYNC_EXT.test(f) || SESSION_OWNED.has(f)) continue;
            const src = path.join("bdsx", f), dst = path.join(inst.dir, f);
            if (!fs.existsSync(src)) continue; // deleted in the working tree
            const a = fs.readFileSync(src);
            if (fs.existsSync(dst) && fs.readFileSync(dst).equals(a)) continue;
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst, a);
            log(`  synced ${f} -> ${inst.name}`); n++;
        }
        if (!n) log(`  ${inst.name} already matches bdsx/`);
    }
    // ---- 3. probes, index, uploads, then compile
    const ex = path.join(inst.dir, "example_and_test");
    for (const [src, dst] of PROBES) fs.copyFileSync(path.join("tools", `${src}.ts`), path.join(ex, `${dst}.ts`));
    fs.copyFileSync(path.join("tools", "host", "index-probes.ts"), path.join(inst.dir, "index.ts"));
    for (const [src, dst] of uploads) {
        const to = path.resolve(LAB, dst);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(src, to);
        log(`  copied ${src} -> ${to}`);
    }

    const tsc = spawnSync("npx tsc", { cwd: inst.dir, shell: true, encoding: "utf8", maxBuffer: 1 << 26 });
    for (const l of (tsc.stdout + tsc.stderr).split(/\r?\n/).filter(Boolean).slice(-30)) log(l);
    log(`tsc exit: ${tsc.status}`);
    fs.copyFileSync(path.join(inst.dir, "launcher.js"), path.join(inst.dir, "full-launcher.js"));

    // ---- 4. this build's table and stub
    const bds = path.join(inst.dir, "bedrock_server");
    fs.copyFileSync(path.join("data", `symbols-${inst.build}.json`), path.join(bds, "symbols.json"));
    const stub = fs.existsSync(path.join("work", `pdbcache-${inst.build}.bin`)) ? path.join("work", `pdbcache-${inst.build}.bin`) : path.join("bdsx", "symbols", inst.build, "pdbcache.bin");
    fs.copyFileSync(stub, path.join(bds, "pdbcache.bin"));

    // ---- 5. the driver
    fs.mkdirSync(RUNS, { recursive: true });
    const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], { env: labEnv(), encoding: "utf8", maxBuffer: 1 << 28 });
    const runText = (run.stdout || "") + (run.stderr || "");
    fs.writeFileSync(path.join(RUNS, `${TAG}.session.txt`), runText);
    for (const l of runText.split(/\r?\n/)) if (/started:|ready:|exit code|exited early|did not exit/.test(l)) log(l);
    const peeked = peek(TAG, GREP);
    for (const l of peeked) log(l);

    // ---- 6. silence is not success, and neither is a status nobody read
    const codes = [...runText.matchAll(/exit code: (-?\d+)/g)];
    const CODE = codes.length ? codes[codes.length - 1][1] : "";
    const text = peeked.join("\n");
    if (CODE === "") {
        log("!! SESSION FAILED: the driver never reported an exit code -- the runner died before BDS was started or stopped");
        for (const l of runText.split(/\r?\n/).slice(0, 20)) log(l);
    } else if (!peeked.length) {
        log("!! SESSION FAILED: the run produced no matching or marker lines at all (not even 'Server started')");
    } else if (/Native Crash|JS Crash|EXCEPTION_/.test(text)) {
        log("!! SESSION FAILED: a crash marker is in the output");
    } else if (CODE !== "0" && !/Quit correctly/.test(text)) {
        // -1073741819 is 0xC0000005; -1 after a "Quit correctly" is the known late-GC finalize
        log(`!! SESSION FAILED: exit code ${CODE} and no 'Quit correctly' -- the server died, the probe output is not a result`);
    } else {
        failed = false;
    }
} catch (e) {
    log(`!! SESSION FAILED: ${e.message}`);
} finally {
    release();
    fs.writeFileSync(LOG, transcript.join("\n") + "\n");
}
console.log(`transcript: ${LOG}`);
if (failed) { console.log(`!! ${TAG} FAILED (see ${LOG})`); process.exit(1); }
