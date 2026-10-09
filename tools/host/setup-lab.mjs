/**
 * Build the lab on this Windows machine: two bdsx installs, one per BDS build, that can run at the
 * same time, plus the bot's node_modules. Idempotent: what is already in place is left alone.
 *
 *   node tools/host/setup-lab.mjs [--only=40|51] [--yes] [--no-bot] [--no-baseline]
 *
 * Per instance (<lab>/inst40, <lab>/inst51; tools/host/lab.mjs):
 *   1. clone bdsx/ (the submodule) into it, at the submodule's commit
 *   2. `npm i` with BDSX_BDS_VERSION=<build>. That is bdsx's own installer: it downloads BDS from
 *      minecraft.net and bdsx-core from GitHub, and copies the build's symbol table. It asks you to
 *      accept the Minecraft EULA; --yes answers for you (BDSX_YES=yes), which means you accept it.
 *   3. node_modules\bdsx must be a junction to the instance's own bdsx\ (a real directory makes
 *      tsc see bdsx twice: "Cannot redeclare block-scoped variable")
 *   4. server.properties: its own ports, LAN discovery off (BDS opens 19132/19133 for discovery
 *      whatever server-port says, and the second server to boot would die on them), and the world
 *      every probe and driver assumes: level "smoketest" from a fixed seed, online-mode and allow-list off, cheats on,
 *      transport=raknet
 *   5. copies bedrock_server.exe to work/bin/<build>/ for the analysis tools, and writes the vftable
 *      scan and launcher configs the counter-probe drivers read (tools/host/make-configs.mjs)
 * Then <lab>/bot gets `npm ci` from tools/host/bot/ (bedrock-protocol 3.60.1, pinned), and the
 * 1.21.3.01 baseline and the rest of work/ are prepared for the analysis tools (tools/fetch-baseline.mjs,
 * tools/prepare-work.mjs; --no-baseline skips both).
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
import { REPO, LAB, RUNS, INSTANCES } from "./lab.mjs";

// the world the drivers' coordinates were written against (`tp @a 29 68 14` is its spawn column)
// allow-list off: 1.26's default server.properties turns it on, and with online-mode off BDS refuses to start
// ("Using an allowlist without online authentication can be dangerous and is not allowed").
// transport raknet: 1.26.51.1 ships transport=nethernet, which the RakNet bot cannot join (it connects and
// then receives nothing); the NetherNet drivers set it for their own session
const WORLD = { "level-name": "smoketest", "level-seed": "1595589368296478387", "gamemode": "survival", "online-mode": "false", "allow-list": "false", "allow-cheats": "true", "transport": "raknet" };
const MD5 = { "1.26.40.8": "0fecd1f7b9e1e8bc7154f461e67d9fdc", "1.26.51.1": "a92cff3b1324d612219510582e9fb3da" };

const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith("--only=")) || "").slice(7);
const yes = args.includes("--yes"), noBot = args.includes("--no-bot"), noBaseline = args.includes("--no-baseline");
if (process.platform !== "win32") { console.error("the lab runs BDS, which is Windows-only: run this on the Windows machine (docs/lab-runbook.md)"); process.exit(2); }

const say = m => console.log(`== ${m}`);
function run(cmd, a, opts = {}) {
    // shell only where it is needed (npm is npm.cmd, which Node will not spawn without one); a path with a
    // space in it would be split by the shell
    const r = spawnSync(cmd, a, { stdio: "inherit", ...opts });
    if (r.status !== 0) { console.error(`!! ${cmd} ${a.join(" ")} exited ${r.status}`); process.exit(1); }
}
const md5 = f => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");
function setProps(file, pairs) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const seen = new Set();
    const out = lines.map(l => {
        const k = l.split("=")[0];
        if (k in pairs) { seen.add(k); return `${k}=${pairs[k]}`; }
        return l;
    });
    for (const k of Object.keys(pairs)) if (!seen.has(k)) out.push(`${k}=${pairs[k]}`);
    fs.writeFileSync(file, out.join("\r\n"));
}

process.chdir(REPO);
if (!fs.existsSync("bdsx/package.json")) { say("bdsx submodule"); run("git", ["submodule", "update", "--init", "bdsx"]); }
const pinned = spawnSync("git", ["-C", "bdsx", "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
fs.mkdirSync(RUNS, { recursive: true });

for (const [name, inst] of Object.entries(INSTANCES)) {
    if (only && name !== `inst${only}`) continue;
    const dir = path.join(LAB, name), bds = path.join(dir, "bedrock_server"), v = inst.build;
    say(`${name}: BDS ${v} in ${dir}`);
    if (!fs.existsSync(path.join(dir, "package.json"))) {
        run("git", ["clone", "-q", path.join(REPO, "bdsx"), dir]);
        run("git", ["-C", dir, "checkout", "-q", pinned]);
    }
    if (!fs.existsSync(path.join(bds, "bedrock_server.exe")) || !fs.existsSync(path.join(dir, "node_modules"))) {
        say(`${name}: npm i (bdsx's installer: BDS ${v}, bdsx-core, the symbol table)`);
        run("npm", ["i", "--no-audit", "--no-fund"], { shell: true, cwd: dir, env: { ...process.env, BDSX_BDS_VERSION: v, ...(yes ? { BDSX_YES: "yes" } : {}) } });
    }
    // 3. the self-link
    const link = path.join(dir, "node_modules", "bdsx"), want = path.join(dir, "bdsx");
    let st = null; try { st = fs.lstatSync(link); } catch {}
    const target = st && st.isSymbolicLink() ? path.resolve(path.dirname(link), fs.readlinkSync(link)).replace(/[\\/]$/, "") : null;
    if (!target || target.toLowerCase() !== want.toLowerCase()) {
        say(`${name}: relinking node_modules\\bdsx -> bdsx\\`);
        if (st) fs.rmSync(link, { recursive: true, force: true });
        fs.symlinkSync(want, link, "junction");
    }
    // 4. ports and the world
    setProps(path.join(bds, "server.properties"), { "server-name": `bdsx-lab-${name}`, "server-port": inst.port, "server-portv6": inst.port + 1, "enable-lan-visibility": "false", ...WORLD });
    // 5. the exe for the analysis tools
    const exe = path.join(bds, "bedrock_server.exe"), sum = md5(exe);
    console.log(`   bedrock_server.exe md5 ${sum} ${sum === MD5[v] ? "(the build the table was made for)" : `!! expected ${MD5[v]} -- symboltable.ts will refuse this exe`}`);
    const bin = path.join("work", "bin", v, "bedrock_server.exe");
    if (!fs.existsSync(bin) || md5(bin) !== sum) { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.copyFileSync(exe, bin); console.log(`   copied to ${bin}`); }
    if (!fs.existsSync(`work/vft/scan-${v}.json`)) { say(`${name}: vftable scan for the launcher configs`); fs.mkdirSync("work/vft", { recursive: true }); run(process.execPath, ["tools/vftable-scan.mjs", bin, `work/vft/scan-${v}.json`]); }
}
if (fs.existsSync("work/vft/scan-1.26.40.8.json") && fs.existsSync("work/vft/scan-1.26.51.1.json")) run(process.execPath, ["tools/host/make-configs.mjs"]);

if (!noBot) {
    const bot = path.join(LAB, "bot");
    if (!fs.existsSync(path.join(bot, "node_modules", "bedrock-protocol"))) {
        say(`bot: npm ci in ${bot}`);
        fs.mkdirSync(bot, { recursive: true });
        for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join("tools", "host", "bot", f), path.join(bot, f));
        run("npm", ["ci", "--no-audit", "--no-fund"], { shell: true, cwd: bot });
    } else say("bot: already installed");
}
if (!noBaseline) {
    say("baseline (1.21.3.01)");
    run(process.execPath, ["tools/fetch-baseline.mjs"]);
    say("work/: Endstone, EnTT names, the shape cache");
    run(process.execPath, ["tools/prepare-work.mjs"]);
}
say(`lab ready: ${LAB}. First run: node tools/host/session.mjs 51 tools/host/drivers/layout51.ps1 --grep='\\[layout\\]'`);
