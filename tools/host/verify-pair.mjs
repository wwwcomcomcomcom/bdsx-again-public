/**
 * Run the same check on both builds at once and say plainly whether it passed.
 *
 *   node tools/host/verify-pair.mjs <driver40.ps1> <driver51.ps1> [--grep='regex'] [--upload=src:dst ...] [--no-sync]
 *
 * The completion bar in this project is "verified by running it on BOTH builds", and the lab has
 * one instance per build, so the two sessions belong together and take the time of one. Whoever
 * calls this from an agent should already hold the `verify` ticket (tools/host/agent-lock.mjs) --
 * session.mjs's own inst40/inst51 locks are then uncontended.
 *
 * Exit 0 only if both sessions exited 0, no FAIL line came back, and each side printed at least
 * one PASS. Anything else prints which side failed and why.
 */
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { REPO, LOCKS } from "./lab.mjs";

const [D40, D51, ...rest] = process.argv.slice(2);
if (!D40 || !D51) { console.error("usage: node tools/host/verify-pair.mjs <driver40.ps1> <driver51.ps1> [session options]"); process.exit(2); }
for (const d of [D40, D51]) if (!fs.existsSync(d)) { console.error(`no such driver: ${d}`); process.exit(2); }
const info = path.join(LOCKS, "verify", "info");
const holder = fs.existsSync(info) ? (fs.readFileSync(info, "utf8").match(/^holder=(.*)$/m) || [])[1] : "";
if (!holder) console.log("!! warning: nobody holds the verify ticket (node tools/host/agent-lock.mjs acquire verify <you>)");

const session = (inst, driver) => new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(REPO, "tools", "host", "session.mjs"), inst, driver, ...rest], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (out += d));
    p.on("close", code => resolve({ code: code ?? 1, out }));
});
const [r40, r51] = await Promise.all([session("40", D40), session("51", D51)]);

const count = (s, w) => s.split("\n").filter(l => l.includes(w)).length;
for (const [b, r, d] of [["40", r40, D40], ["51", r51, D51]]) {
    console.log(`========== 1.26.${b} (${path.basename(d)}) -- session exit ${r.code}`);
    process.stdout.write(r.out);
    console.log(`---------- 1.26.${b}: PASS ${count(r.out, "PASS")} / FAIL ${count(r.out, "FAIL")}`);
}
if (r40.code === 0 && r51.code === 0) {
    const F = count(r40.out, "FAIL") + count(r51.out, "FAIL");
    if (F) { console.log(`== BOTH SESSIONS RAN, but ${F} FAIL line(s) came back -- this is a result, and it is a negative one`); process.exit(1); }
    // a session whose probe never ran has no FAIL either, and neither has one whose client never joined
    // (the probe loads and says so, then has nothing to check): it must not read as a pass
    for (const [b, r] of [["40", r40], ["51", r51]]) {
        if (!/^\[[a-z0-9]+\] /m.test(r.out)) { console.log(`== 1.26.${b} printed no probe line at all -- the probe did not run (tsc, a load error), NOT VERIFIED`); process.exit(1); }
        if (!count(r.out, "PASS")) { console.log(`== 1.26.${b} printed no PASS -- the probe loaded but checked nothing (did the client join?), NOT VERIFIED`); process.exit(1); }
        if (/Cannot find module|error TS/.test(r.out)) { console.log(`== 1.26.${b}: a TypeScript/module error is in the output -- do not trust this result`); process.exit(1); }
    }
    console.log("== both builds: ran clean, no FAIL");
    process.exit(0);
}
console.log(`== NOT VERIFIED: 1.26.40.8 exit ${r40.code}, 1.26.51.1 exit ${r51.code}. A session that did not run is not a result.`);
process.exit(1);
