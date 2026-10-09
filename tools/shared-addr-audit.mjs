/**
 * The reading list for the "names that share an address but not a signature" audit (findings-audit.md, the
 * getArmor lesson): group data/merged-<v>.json by address and list every required name whose address it
 * shares with a name of a different ABI shape -- a free/static function vs an instance member (`YA`/`SA` vs
 * `QEAA`/`UEAA`), or a different parameter count, or one returning a class by value (hidden sret pointer)
 * where the other does not. Identical-code folding makes most shared addresses harmless (an empty virtual,
 * `return this+N`), so this is a reading list, not a verdict: every row still has to be read.
 *
 * Each row also prints the name's route (`origin` in the merged file) and flags the routes that never read
 * the body (propagation, gaps-agree, vftable-walk, cross-build, corroborated), which is where the three
 * wrong ones found so far came from.
 *
 * Usage: node tools/shared-addr-audit.mjs <version> [--all] [--json] [--merged=<file>] [--unread]
 *   --all       also list shared groups whose names agree in shape (the folding census)
 *   --json      machine-readable output
 *   --merged=   another merged table (e.g. `git show <rev>:data/merged-<v>.json > f`) -- to replay an old state
 *   --unread    instead: every required name in the table whose route never read the body, by route
 *               (the input for the next audit; not limited to shared addresses)
 *   --jsv       instead: every `procHacker.jsv(vftable, name)` site in bdsx/, replaying bdsx's slot search
 *               (bds/symbols.ts getVftableOffset: the FIRST slot within 4096 bytes whose pointer equals the
 *               name's address). With identical-code folding one address can fill several slots of the same
 *               table, and then the first one wins whether or not it is the name's own slot. Prints every
 *               site whose address appears in more than one slot of the scanned window, or in none, with the
 *               2024 build's answer for the same pair (work/vft/baseline-slots.json).
 * Needs llvm-undname (tools/llvm.mjs).
 */
import * as fs from "fs";
import { execFileSync } from "child_process";
import { functions } from "./pdata.mjs";
import { llvm } from "./llvm.mjs";

const [v, ...rest] = process.argv.slice(2);
if (!v) { console.error("usage: node tools/shared-addr-audit.mjs <version> [--all] [--json]"); process.exit(2); }
const ALL = rest.includes("--all"), JSONOUT = rest.includes("--json");
const UNDNAME = [llvm("llvm-undname")].find(p => { try { execFileSync(p, ["--help"], { stdio: "ignore" }); return true; } catch { return false; } });
if (!UNDNAME) { console.error("llvm-undname not found"); process.exit(2); }

const load = p => JSON.parse(fs.readFileSync(p, "utf8"));
const required = new Set(load("data/required-symbols.json").symbols.map(s => s.name));
const derived = load("data/derived.json").derived;
const MERGED = rest.find(a => a.startsWith("--merged="))?.slice(9) ?? `data/merged-${v}.json`;
const m = load(MERGED);
const base = load("data/baseline-symbols.json").symbols;
const size = new Map(functions(`work/bin/${v}/bedrock_server.exe`).map(e => [e.begin, e.end - e.begin]));
const READ = new Set(["resolved", "instances", "packets", "ctor-store", "netevent", "level-anchored", "endstone-slots"]);

if (rest.includes("--unread")) {
    const by = {};
    for (const n of required) {
        if (!(n in m.symbols) || READ.has(m.origin?.[n] ?? "?") || n.startsWith("??_7")) continue;
        (by[m.origin?.[n] ?? "?"] ??= []).push(n);
    }
    for (const [r, ns] of Object.entries(by).sort()) {
        console.log(`${r}: ${ns.length}`);
        for (const n of ns.sort()) console.log(`  0x${m.symbols[n].toString(16).padEnd(9)} ${n in derived ? "[derived fallback] " : ""}${n}`);
    }
    process.exit(0);
}

if (rest.includes("--jsv")) {
    const { loadPE } = await import("./pe.mjs");
    const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = `${d}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(q, o); }
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) o.push(q); } return o; };
    const sites = [];
    for (const f of walk("bdsx/bdsx")) {
        const t = fs.readFileSync(f, "utf8");
        for (const x of t.matchAll(/\.jsv\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g))
            sites.push({ file: `${f}:${t.slice(0, x.index).split("\n").length}`, vft: x[1], key: x[2] });
    }
    const pe = loadPE(`work/bin/${v}/bedrock_server.exe`);
    /** bdsx's scan: pointers until one is not an image RVA in [0x1000, 0x1000000000), at most 512 */
    const scan = (buf, off, imageBase) => { const r = [];
        for (let i = 0; i < 512 && off + i * 8 + 8 <= buf.length; i++) {
            const d = buf.readBigUInt64LE(off + i * 8) - imageBase;
            if (d < 0x1000n || d >= 0x1000000000n) break; r.push(Number(d)); } return r; };
    let bl = null;
    try { bl = load("work/vft/baseline-slots.json"); } catch { }
    const bpe = bl ? loadPE("work/bin/1.21.3.01/bedrock_server.exe") : null;
    let ok = 0, missing = 0; const bad = [];
    for (const st of sites) {
        const vr = m.symbols[st.vft], a = m.symbols[st.key];
        if (vr === undefined || a === undefined) { missing++; continue; }
        const slots = scan(pe.buf, pe.off(vr), pe.imageBase);
        const hits = slots.flatMap((x, i) => x === a ? [i] : []);
        let old = "";
        if (bl && base[st.vft] !== undefined && base[st.key] !== undefined) {
            const bs = scan(bpe.buf, bpe.off(base[st.vft]), bpe.imageBase);
            old = ` | 2024: slots ${JSON.stringify(bs.flatMap((x, i) => x === base[st.key] ? [i] : []))}`;
        }
        if (hits.length === 1) { ok++; continue; }
        bad.push(`${hits.length ? "AMBIGUOUS" : "NOT FOUND"} ${st.key}\n    in ${st.vft} at 0x${a.toString(16)}: slots ${JSON.stringify(hits)} of ${slots.length} scanned${old}\n    ${st.file}`);
    }
    console.log(`${v}: ${sites.length} jsv sites, ${missing} with a side missing from the table, ${ok} resolve to exactly one slot, ${bad.length} do not`);
    for (const b of bad) console.log(b);
    process.exit(0);
}

// ---- group by address ----
const byAddr = new Map();
for (const [n, a] of Object.entries(m.symbols)) { if (!byAddr.has(a)) byAddr.set(a, []); byAddr.get(a).push(n); }
const groups = [...byAddr].filter(([, ns]) => ns.length > 1 && ns.some(n => required.has(n)));

// ---- demangle every name in those groups in one llvm-undname run ----
const names = [...new Set(groups.flatMap(([, ns]) => ns))].filter(n => n.startsWith("?"));
const out = execFileSync(UNDNAME, [], { input: names.join("\n") + "\n", maxBuffer: 1 << 28 }).toString().split("\n");
// llvm-undname echoes each input line, then prints the demangled form, then a blank line
const dem = new Map();
for (let i = 0; i < out.length; i++) if (names.includes(out[i]) && i + 1 < out.length) { dem.set(out[i], out[i + 1]); i++; }

/** splits a parameter list at top-level commas */
function splitTop(s) {
    const r = []; let d = 0, cur = "";
    for (const c of s) {
        if ("<([".includes(c)) d++; else if (">)]".includes(c)) d--;
        if (c === "," && d === 0) { r.push(cur.trim()); cur = ""; } else cur += c;
    }
    if (cur.trim()) r.push(cur.trim());
    return r;
}
/** { kind: member|static|free|data|vftable|other, params, sret, text } from the demangled string */
function shape(name) {
    const t = dem.get(name);
    if (!t || t === name) return { kind: "other", text: t ?? name };
    if (/`vftable'/.test(t)) return { kind: "vftable", text: t };
    const acc = /^(public|private|protected): /.exec(t);
    // the parameter list: the last balanced (...) before trailing cv-qualifiers
    const tail = t.replace(/(\s+(const|volatile|__ptr64|&|&&))+$/, "");
    if (!tail.endsWith(")")) return { kind: "data", text: t };
    let d = 0, i = tail.length - 1;
    for (; i >= 0; i--) { if (tail[i] === ")") d++; else if (tail[i] === "(" && --d === 0) break; }
    const plist = tail.slice(i + 1, -1).trim();
    const params = plist === "void" || plist === "" ? 0 : splitTop(plist).length;
    const head = tail.slice(0, i);
    const cc = head.lastIndexOf("__cdecl");
    const ret = (cc >= 0 ? head.slice(0, cc) : head).replace(/^(public|private|protected): /, "").replace(/^(static|virtual) /, "").trim();
    const byValueUDT = /^(class|struct|union) /.test(ret) && !/[*&]\s*(const\s*)?$/.test(ret);
    let kind = "free";
    if (acc) kind = /^(public|private|protected): static /.test(t) ? "static" : "member";
    // MSVC x64: an instance member returning any class by value takes a hidden pointer; a free function
    // does for most classes (not for small PODs, which this cannot tell) -- recorded, marked with '?'
    const sret = byValueUDT ? (kind === "member" ? "yes" : "maybe") : "no";
    const virt = acc && / virtual /.test(t);
    return { kind, params, sret, virt, ret, text: t };
}
/** registers the callee actually reads for arguments: this + sret + params */
const abiArgs = s => (s.kind === "member" ? 1 : 0) + (s.sret === "yes" ? 1 : 0) + (s.params ?? 0);

const ROUTE = n => m.origin?.[n] ?? "?";
const rows = [];
let foldOk = 0;
for (const [a, ns] of groups) {
    const sh = new Map(ns.map(n => [n, shape(n)]));
    for (const n of ns.filter(x => required.has(x))) {
        const s = sh.get(n);
        if (s.kind === "other" || s.kind === "data" || s.kind === "vftable") continue;
        const why = [];
        for (const o of ns) {
            if (o === n) continue;
            const t = sh.get(o);
            if (t.kind === "vftable" || t.kind === "data") { why.push({ other: o, reason: `function shares with ${t.kind}` }); continue; }
            if (t.kind === "other") continue;
            const instA = s.kind === "member", instB = t.kind === "member";
            const r = [];
            if (instA !== instB) r.push(`kind ${s.kind} vs ${t.kind}`);
            if (s.params !== t.params) r.push(`params ${s.params} vs ${t.params}`);
            if ((s.sret === "yes") !== (t.sret === "yes") && instA === instB) r.push(`sret ${s.sret} vs ${t.sret}`);
            if (r.length) why.push({ other: o, reason: r.join(", "), otherText: t.text, otherRoute: ROUTE(o), otherRequired: required.has(o) });
        }
        if (!why.length) { foldOk++; if (!ALL) continue; }
        rows.push({
            name: n, addr: a, size: size.get(a) ?? 0, route: ROUTE(n), unread: !READ.has(ROUTE(n)),
            derived: n in derived, base: base[n], baseSize: undefined, text: s.text, abi: abiArgs(s), why,
        });
    }
}
const bsz = new Map(functions("work/bin/1.21.3.01/bedrock_server.exe").map(e => [e.begin, e.end - e.begin]));
for (const r of rows) if (r.base !== undefined) r.baseSize = bsz.get(r.base) ?? 0;
rows.sort((x, y) => x.addr - y.addr);

if (JSONOUT) { console.log(JSON.stringify({ version: v, groups: groups.length, agree: foldOk, rows }, null, 1)); process.exit(0); }
const hex = x => "0x" + x.toString(16);
console.log(`${v}: ${byAddr.size} addresses, ${[...byAddr.values()].filter(x => x.length > 1).length} shared, ${groups.length} shared with a required name;`
    + ` ${rows.filter(r => r.why.length).length} required names share with a different shape, ${foldOk} agree in shape`);
for (const r of rows) {
    console.log(`\n${hex(r.addr)} size ${r.size} (2024 ${r.base === undefined ? "-" : hex(r.base) + " size " + r.baseSize})  route=${r.route}${r.unread ? " [UNREAD ROUTE]" : ""}${r.derived ? " [derived fallback]" : ""}`);
    console.log(`  ${r.name}\n    ${r.text}`);
    // many folded groups are dozens of `return true` virtuals: print each distinct reason once, with a count
    const by = new Map();
    for (const w of r.why) { if (!by.has(w.reason)) by.set(w.reason, []); by.get(w.reason).push(w); }
    for (const [reason, ws] of by) {
        const req = ws.filter(w => w.otherRequired).length;
        console.log(`  ~ ${reason}: ${ws.length} name${ws.length > 1 ? "s" : ""}${req ? `, ${req} also required` : ""}`);
        for (const w of (ws.length > 3 ? [...ws.filter(w => w.otherRequired), ...ws.filter(w => !w.otherRequired)].slice(0, 2) : ws))
            console.log(`      [${w.otherRoute}] ${(w.otherText ?? w.other).slice(0, 200)}`);
    }
}
