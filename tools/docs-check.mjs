/**
 * Keeps the documents every session loads small and consistent.
 *
 * CLAUDE.md is loaded at session start together with every file it imports
 * with a line of the form `@path`. That set is paid for by every session
 * before any work starts, so it has a byte budget; the big docs are read by
 * section instead (`toc`).
 *
 * Usage:
 *   node tools/docs-check.mjs                 budget + stale-number check (exit 1 on failure)
 *   node tools/docs-check.mjs toc <doc.md>    headings with line numbers and section sizes,
 *                                             to read one section with Read offset/limit
 *
 * The checks:
 *   - the auto-loaded set is within BUDGET bytes, and docs/next-steps.md within QUEUE_BUDGET
 *   - no auto-loaded doc hand-types a coverage pair ("351 / 348 ... by address"): the
 *     numbers live only in the generated block of docs/status.md (tools/status-summary.mjs)
 *   - that block is current (tools/status-summary.mjs --check)
 *   - every hand verdict in data/arch-classes.json still matches a name (tools/arch-inventory.mjs --dry):
 *     resolving a name drops it out of the inventory's set, and nothing else runs that tool
 */
import * as fs from "fs";
import { spawnSync } from "child_process";

const BUDGET = 64 * 1024;
const QUEUE_BUDGET = 24 * 1024;

const [cmd, arg] = process.argv.slice(2);

if (cmd === "toc") {
    const lines = fs.readFileSync(arg, "utf8").split("\n");
    const heads = [];
    lines.forEach((l, i) => { if (/^#{1,4} /.test(l)) heads.push({ i, l }); });
    heads.forEach((h, k) => {
        const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
        const bytes = lines.slice(h.i, end).join("\n").length;
        console.log(`${String(h.i + 1).padStart(5)}  ${String(end - h.i).padStart(4)} lines ${String((bytes / 1024).toFixed(1)).padStart(5)}KB  ${h.l.slice(0, 110)}`);
    });
    process.exit(0);
}

const imports = fs.readFileSync("CLAUDE.md", "utf8").split("\n").filter(l => /^@\S+$/.test(l.trim())).map(l => l.trim().slice(1));
const set = ["CLAUDE.md", ...imports];
let total = 0, fail = false;
for (const f of set) {
    const n = fs.statSync(f).size;
    total += n;
    console.log(`${String((n / 1024).toFixed(1)).padStart(6)}KB  ${f}`);
}
console.log(`${String((total / 1024).toFixed(1)).padStart(6)}KB  auto-loaded total (budget ${BUDGET / 1024}KB)`);
if (total > BUDGET) { console.log(`!! over budget by ${((total - BUDGET) / 1024).toFixed(1)}KB -- move finished or reference material out of the auto-loaded set`); fail = true; }
const queue = fs.statSync("docs/next-steps.md").size;
if (queue > QUEUE_BUDGET) { console.log(`!! docs/next-steps.md is ${(queue / 1024).toFixed(1)}KB (budget ${QUEUE_BUDGET / 1024}KB) -- finished items belong in docs/completed-task.md`); fail = true; }

const coverage = /\b\d{3}\s*\/\s*\d{3}\b[^|\n]{0,60}\b(by address|resolvable|addresses)\b|\b(by address|resolvable|addresses)\b[^|\n]{0,20}\*{0,2}\d{3}\s*\/\s*\d{3}\b/i;
for (const f of set) {
    fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
        if (coverage.test(l)) { console.log(`!! ${f}:${i + 1}: hand-typed coverage numbers -- point to the generated block in docs/status.md instead\n     ${l.trim().slice(0, 140)}`); fail = true; }
    });
}

const r = spawnSync(process.execPath, ["tools/status-summary.mjs", "--check"], { encoding: "utf8" });
process.stdout.write(r.stdout + r.stderr);
if (r.status !== 0) fail = true;

const inv = spawnSync(process.execPath, ["tools/arch-inventory.mjs", "--dry"], { encoding: "utf8" });
if (inv.status !== 0 && !fs.existsSync("work/endstone/src")) { console.log("!! tools/arch-inventory.mjs needs work/ prepared: node tools/prepare-work.mjs"); fail = true; }
else if (inv.status !== 0) { console.log(`!! tools/arch-inventory.mjs fails: ${(inv.stderr || inv.stdout).trim().split("\n")[0]}\n     a name with a hand verdict was resolved or dropped: delete the verdict (the table now says live) or mark it notRequired`); fail = true; }

process.exit(fail ? 1 : 0);
