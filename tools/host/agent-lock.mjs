/**
 * The lock an *agent* holds, not a process.
 *
 *   node tools/host/agent-lock.mjs acquire <lock> <holder> [--wait=S] [--ttl=S] [--note='...']
 *   node tools/host/agent-lock.mjs renew   <lock> <holder>
 *   node tools/host/agent-lock.mjs release <lock> <holder>
 *   node tools/host/agent-lock.mjs status  [lock]
 *   node tools/host/agent-lock.mjs steal   <lock> <holder> --force
 *
 * tools/host/session.mjs locks an instance for the length of one process, so it can tell a dead
 * holder from a live one by pid. An agent cannot: it holds a lock across many tool calls, each a
 * separate process that exits. So a holder here is a NAME with a deadline, and the only way a lock
 * is released is `release`, or its ttl running out and somebody stealing it on purpose.
 *
 * Two locks, and the order between them is the whole deadlock story:
 *
 *   verify   bdsx/ (the working tree session.mjs syncs into the instances) AND inst40 AND inst51.
 *            Held for one whole "change bdsx, run both builds, record, commit" pass. One ticket,
 *            because session.mjs pushes bdsx/ into both instances: two agents editing bdsx while
 *            either one runs a session means each verifies half of the other's edit.
 *   repo     data/, docs/, and `git commit`. Short.
 *
 * **Always take `verify` before `repo`, never the reverse.** An agent that holds `repo` and then
 * waits for `verify` deadlocks against one doing the opposite, so `acquire verify` refuses to run
 * while the caller holds `repo`. An agent that only writes files takes `repo` alone.
 */
import * as fs from "fs";
import * as path from "path";
import { LOCKS, sleep } from "./lab.mjs";

fs.mkdirSync(LOCKS, { recursive: true });
const now = () => Math.floor(Date.now() / 1000);
const infoFile = l => path.join(LOCKS, l, "info");
function read(l) {
    if (!fs.existsSync(infoFile(l))) return null;
    return Object.fromEntries(fs.readFileSync(infoFile(l), "utf8").split("\n").filter(Boolean).map(x => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
}
const write = (l, holder, ttl, note) => fs.writeFileSync(infoFile(l), `holder=${holder}\nsince=${now()}\nttl=${ttl}\nnote=${note}\n`);
function describe(l) {
    if (!fs.existsSync(path.join(LOCKS, l))) return `${l}: free`;
    const i = read(l) || {};
    const age = now() - Number(i.since || 0), left = Number(i.ttl || 0) - age;
    const st = left <= 0 ? `EXPIRED ${age}s ago-held, stealable` : `held ${age}s, ${left}s of ttl left`;
    return `${l}: ${i.holder} (${st})${i.note ? " -- " + i.note : ""}`;
}
const holds = (l, h) => (read(l) || {}).holder === h;

const [cmd, lock, holder, ...opts] = process.argv.slice(2);
const opt = (k, d) => { const o = opts.find(a => a.startsWith(`--${k}=`)); return o ? o.slice(k.length + 3).replace(/^'(.*)'$/, "$1") : d; };
const need = (...v) => { if (v.some(x => !x)) { console.log("usage: see the header of tools/host/agent-lock.mjs"); process.exit(2); } };

switch (cmd) {
case "status":
    for (const l of lock ? [lock] : ["verify", "repo", "inst40", "inst51"]) {
        if (l.startsWith("inst")) {
            const p = path.join(LOCKS, l, "pid");
            console.log(fs.existsSync(path.join(LOCKS, l)) ? `${l}: taken by session.mjs pid ${fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "?"}` : `${l}: free`);
        } else console.log(describe(l));
    }
    break;
case "acquire": {
    need(lock, holder);
    if (!["verify", "repo"].includes(lock)) { console.log("lock must be verify or repo (inst40/inst51 belong to session.mjs)"); process.exit(2); }
    if (lock === "verify" && holds("repo", holder)) { console.log(`REFUSED: ${holder} already holds repo. Take verify FIRST, then repo -- release repo and start over.`); process.exit(2); }
    if (holds(lock, holder)) { console.log(`${lock}: already held by ${holder}`); break; }
    const ttl = Number(opt("ttl", 3600)), deadline = now() + Number(opt("wait", 540));
    for (;;) {
        try {
            fs.mkdirSync(path.join(LOCKS, lock));
            write(lock, holder, ttl, opt("note", ""));
            console.log(`${lock}: acquired by ${holder} (ttl ${ttl}s)`);
            break;
        } catch (e) { if (e.code !== "EEXIST") throw e; }
        if (now() >= deadline) { console.log(`BUSY: ${describe(lock)}`); console.log(`waited and gave up -- do other work and run this again (exit 4)`); process.exit(4); }
        sleep(10000);
    }
    break;
}
case "renew": {
    need(lock, holder);
    if (!holds(lock, holder)) { console.log(`${holder} does not hold ${lock}: ${describe(lock)}`); process.exit(1); }
    const i = read(lock);
    write(lock, holder, i.ttl, i.note || "");
    console.log(`${lock}: renewed by ${holder}`);
    break;
}
case "release":
    need(lock, holder);
    if (!fs.existsSync(path.join(LOCKS, lock))) { console.log(`${lock}: was already free`); break; }
    if (!holds(lock, holder)) { console.log(`REFUSED: ${lock} is held by ${(read(lock) || {}).holder}, not ${holder}`); process.exit(1); }
    fs.rmSync(path.join(LOCKS, lock), { recursive: true, force: true });
    console.log(`${lock}: released by ${holder}`);
    break;
case "steal": {
    need(lock, holder);
    if (!fs.existsSync(path.join(LOCKS, lock))) { console.log(`${lock}: free, nothing to steal`); break; }
    const i = read(lock) || {};
    if (now() - Number(i.since || 0) < Number(i.ttl || 0) && !opts.includes("--force")) {
        console.log(`REFUSED: ${describe(lock)} -- ttl has not run out. Pass --force only if you know that agent is gone.`); process.exit(1);
    }
    console.log(`STEALING ${describe(lock)} -> ${holder}`);
    write(lock, holder, i.ttl || 3600, "stolen");
    break;
}
default:
    console.log(`unknown command ${cmd ?? ""} (acquire|renew|release|status|steal)`); process.exit(2);
}
