/**
 * Where the lab is, shared by the scripts that run BDS on this machine.
 *
 * The lab is two complete bdsx installs, one per BDS build, that run side by side (ports differ,
 * LAN discovery off), plus the bot's node_modules and the run outputs:
 *
 *   <lab>/inst40/     bdsx + BDS 1.26.40.8   server-port 19132/19133, live-bot control port 19150
 *   <lab>/inst51/     bdsx + BDS 1.26.51.1   server-port 19134/19135, live-bot control port 19152
 *   <lab>/bot/        node_modules for tools/livebot.cjs (bedrock-protocol 3.60.1, pinned by its lockfile)
 *   <lab>/runs/       <Tag>.out / .err / .bot.log / .bot.err of the last run of each driver tag
 *
 * <lab> is $BDSX_LAB, or lab/ in the repository (gitignored). tools/host/setup-lab.mjs builds it.
 * Drivers and runners read the same two variables, which session.mjs sets: $env:BDSX_REPO (this
 * repository; tools are run from here) and $env:BDSX_LAB.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LAB = process.env.BDSX_LAB ? path.resolve(process.env.BDSX_LAB) : path.join(REPO, "lab");
export const RUNS = path.join(LAB, "runs");
export const LOCKS = path.join(REPO, "work", "locks");

export const INSTANCES = {
    inst40: { build: "1.26.40.8", port: 19132, lbPort: 19150 },
    inst51: { build: "1.26.51.1", port: 19134, lbPort: 19152 },
};

/** "40" | "51" | "inst40" | "inst51" -> { name, dir, build, ... } */
export function instance(arg) {
    const name = /^\d+$/.test(String(arg)) ? `inst${arg}` : String(arg);
    const i = INSTANCES[name];
    if (!i) throw new Error(`instance must be 40/51 (= inst40/inst51), not ${arg}`);
    return { name, dir: path.join(LAB, name), ...i };
}

/** The environment drivers and runners expect. */
export function labEnv(extra = {}) {
    return { ...process.env, BDSX_REPO: REPO, BDSX_LAB: LAB, ...extra };
}

export function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * The per-process instance lock: one session per instance. A holder that died is detected by pid,
 * so a crashed session never leaves the instance locked. Returns the release function.
 */
export function lockInstance(name, { waitSecs = 1200, log = console.log } = {}) {
    fs.mkdirSync(LOCKS, { recursive: true });
    const dir = path.join(LOCKS, name);
    const deadline = Date.now() + waitSecs * 1000;
    let said = false;
    for (;;) {
        try {
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
            return () => fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
        }
        const owner = Number(fs.readFileSync(path.join(dir, "pid"), "utf8").trim() || 0);
        if (owner && !pidAlive(owner)) { log(`== stealing stale ${name} lock (pid ${owner} gone)`); fs.rmSync(dir, { recursive: true, force: true }); continue; }
        if (Date.now() > deadline) throw new Error(`${name} is busy (pid ${owner}) -- gave up after ${waitSecs}s`);
        if (!said) { log(`== waiting for the ${name} lock (held by pid ${owner})`); said = true; }
        sleep(10000);
    }
}

/**
 * One run's stdout + stderr filtered down to the lines that matter. The crash markers are always
 * included: silence must never look like success. Past `first` lines, FAIL lines and markers are
 * still printed after one note that avoids the words PASS and FAIL (so verify-pair does not count it).
 */
export const ALWAYS = "Native Crash|JS Crash|EXCEPTION_|Quit correctly|Server started|error TS|Player connected|Player disconnected";
export function peek(tag, pattern = "PASS|FAIL", first = 120) {
    const re = new RegExp(`${pattern}|${ALWAYS}`);
    const keepRe = new RegExp(`FAIL|${ALWAYS}`);
    const all = [];
    for (const ext of ["out", "err"]) {
        const f = path.join(RUNS, `${tag}.${ext}`);
        if (!fs.existsSync(f)) continue;
        for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/)) if (re.test(l)) all.push(l);
    }
    const lines = all.slice(0, first);
    if (all.length > first) {
        const rest = all.slice(first), keep = rest.filter(l => keepRe.test(l));
        lines.push(`[peek] ${rest.length} more matching lines cut at ${first}; ${keep.length} failure or marker lines among them follow`, ...keep);
    }
    return lines;
}
