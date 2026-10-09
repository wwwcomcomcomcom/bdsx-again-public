/**
 * Where a one-byte field moved to, read off the functions that use it.
 *
 * A getter that 1.26 inlined away leaves no body to compare, but the field it
 * read is still read -- by the same functions, which do still have names in our
 * tables. So the offset is recoverable without any signature matching:
 *
 *   shared   the byte displacements that N named functions have in common.
 *            Pick two functions that touch the field in the 2024 build and
 *            nothing else in common; if the intersection is a singleton in the
 *            baseline, run the same two names on 1.26 and read the answer.
 *            This is how Player::isSpawned moved 2904 -> 1801 (0x709)
 *            (docs/findings-layouts.md, "isSpawned").
 *
 *   users    every function that touches one displacement, by access kind.
 *            The shape of the set is the corroboration: the baseline's readers
 *            and its single `movb imm8` writer should have counterparts.
 *
 *   move     both of those at once, for one field, across builds. It takes the
 *            baseline displacement, finds the baseline functions that touch it,
 *            keeps the ones our tables name on the target build, and ranks the
 *            target's displacements by how many of them touch it. The answer is
 *            the displacement with the same support as the baseline's -- and a
 *            candidate that is top on one 1.26 build and not the other is a
 *            candidate to disbelieve, which is why it prints both.
 *
 * Only `[reg+disp32]` forms are considered (mod=10, no SIB, no RIP), which is
 * what a field access on `this` looks like once the offset is past 127. Which
 * widths are decoded is `--ops`, default `byte` (the set the isSpawned work
 * used): byte, word, dword (32/64, including lea-less loads and stores, the
 * immediate forms and the compares), lea, float (movss/movaps), or all.
 *
 * Usage:
 *   node tools/field-offset.mjs shared <exe> <rva-hex> <rva-hex> [...] [--ops=...]
 *   node tools/field-offset.mjs users  <exe> <disp-hex> [symbols.json|merged.json] [--ops=...]
 *   node tools/field-offset.mjs move   <disp-hex> [--ops=...] [--top=N] [--builds=a,b]
 */
import * as fs from "fs";
import { loadPE } from "./pe.mjs";
import { functions, containing } from "./pdata.mjs";

// One-byte opcodes, by group. The scan walks every offset rather than decoding
// instructions, so a prefix (REX, 0x66, 0xf3) needs no handling: the scan simply
// lands on the opcode byte itself. That over-generates, and the intersection is
// what filters it -- the same trade the byte-only version always made.
const OPS = {
    byte: new Map([
        [0xc6, "movb imm"],
        [0x88, "store8"],
        [0x8a, "load8"],
        [0x80, "cmpb/grp1"],
    ]),
    dword: new Map([
        [0x8b, "load"],
        [0x89, "store"],
        [0xc7, "mov imm"],
        [0x83, "grp1 imm8"],
        [0x81, "grp1 imm32"],
        [0x3b, "cmp r,m"],
        [0x39, "cmp m,r"],
        [0x03, "add"],
        [0x2b, "sub"],
        [0x85, "test"],
        [0xff, "grp5"],
    ]),
    lea: new Map([[0x8d, "lea"]]),
};
// two-byte (0f xx) forms, by group
const OPS_0F = {
    byte: new Map([
        [0xb6, "movzx8"],
        [0xbe, "movsx8"],
    ]),
    word: new Map([
        [0xb7, "movzx16"],
        [0xbf, "movsx16"],
    ]),
    float: new Map([
        [0x10, "movs/ups load"],
        [0x11, "movs/ups store"],
        [0x28, "movaps load"],
        [0x29, "movaps store"],
        [0x58, "adds"],
        [0x59, "muls"],
        [0x5c, "subs"],
    ]),
};
const ALL_GROUPS = ["byte", "word", "dword", "lea", "float"];

function opTables(groups) {
    const one = new Map(), two = new Map();
    for (const g of groups) {
        for (const [k, v] of OPS[g] ?? []) one.set(k, v);
        for (const [k, v] of OPS_0F[g] ?? []) two.set(k, v);
    }
    return { one, two };
}

/** every [reg+disp32] access in [begin, end) for the chosen widths, as disp -> [description] */
function accesses(pe, begin, end, tables) {
    const buf = pe.buf;
    const out = new Map();
    for (let rva = begin; rva < end - 6; rva++) {
        const i = pe.off(rva);
        if (i < 0) continue;
        const modrm = buf[i + 1];
        if (modrm >> 6 !== 2) continue;
        const rm = modrm & 7;
        if (rm === 4 || rm === 5) continue; // SIB and RIP-relative are not `this`
        let kind = buf[i - 1] === 0x0f ? tables.two.get(buf[i]) : undefined;
        if (kind === undefined && buf[i - 1] !== 0x0f) kind = tables.one.get(buf[i]);
        if (kind === undefined) continue;
        const disp = buf.readUInt32LE(i + 2);
        if (disp > 0x20000) continue; // not a field of an object this project deals with
        if (!out.has(disp)) out.set(disp, []);
        out.get(disp).push(`${kind}@0x${rva.toString(16)}`);
    }
    return out;
}

function reverseNames(path) {
    if (path === undefined) return null;
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    const map = parsed.symbols ?? parsed;
    const rev = new Map();
    for (const name of Object.keys(map)) {
        const rva = map[name] >>> 0;
        if (!rev.has(rva)) rev.set(rva, name);
    }
    return rev;
}

const argv = process.argv.slice(2);
const flags = new Map(argv.filter(a => a.startsWith("--")).map(a => { const i = a.indexOf("="); return i < 0 ? [a.slice(2), ""] : [a.slice(2, i), a.slice(i + 1)]; }));
const args = argv.filter(a => !a.startsWith("--"));
const groupArg = flags.get("ops") ?? "byte";
const groups = groupArg === "all" ? ALL_GROUPS : groupArg.split(",");
for (const g of groups) {
    if (!ALL_GROUPS.includes(g)) {
        console.error(`unknown --ops group "${g}" (want ${ALL_GROUPS.join(", ")} or all)`);
        process.exit(2);
    }
}
const tables = opTables(groups);
const mode = args[0];

if (mode !== "shared" && mode !== "users" && mode !== "move") {
    console.error(
        "usage: node tools/field-offset.mjs shared <exe> <rva-hex>... [--ops=...]\n" +
            "       node tools/field-offset.mjs users  <exe> <disp-hex> [symbols.json] [--ops=...]\n" +
            "       node tools/field-offset.mjs move   <disp-hex> [--ops=...] [--top=N] [--builds=a,b] [--callers-of=<rva>]",
    );
    process.exit(2);
}

/** the displacements a function touches, or null if it has no .pdata entry */
function fnAccesses(pe, funcs, rva) {
    const f = containing(funcs, rva);
    if (f === null) return null;
    return { f, map: accesses(pe, f.begin, f.end, tables) };
}

/** every function that contains a direct E8/E9 branch to `target` */
function callersOf(pe, funcs, target) {
    const buf = pe.buf, t = pe.text, out = new Set();
    for (let rva = t.rva; rva < t.rva + t.rawSize - 5; rva++) {
        const i = pe.off(rva);
        if (i < 0) continue;
        if (buf[i] !== 0xe8 && buf[i] !== 0xe9) continue;
        if (rva + 5 + buf.readInt32LE(i + 1) !== target) continue;
        const f = containing(funcs, rva);
        if (f !== null) out.add(f.begin);
    }
    return out;
}

if (mode === "move") {
    // One field, from the baseline to every 1.26 build, by the shape of its access set.
    const disp = parseInt(args[1], 16);
    const top = Number(flags.get("top") ?? 8);
    const builds = (flags.get("builds") ?? "1.26.40.8,1.26.51.1").split(",");
    const basePe = loadPE("work/bin/1.21.3.01/bedrock_server.exe");
    const baseFuncs = functions("work/bin/1.21.3.01/bedrock_server.exe");
    const baseSyms = JSON.parse(fs.readFileSync("data/baseline-symbols.json", "utf8")).symbols;
    const baseRev = new Map();
    for (const [n, v] of Object.entries(baseSyms)) if (!baseRev.has(v >>> 0)) baseRev.set(v >>> 0, n);

    // The baseline set is either the functions that touch the displacement, or -- when the field's
    // only baseline reader is a leaf the inliner took (`--callers-of`, which is the usual case for a
    // one-line getter) -- the functions that call that leaf, since those are where 1.26 put the read.
    const leaf = flags.get("callers-of");
    const users = new Set();
    if (leaf !== undefined) {
        for (const b of callersOf(basePe, baseFuncs, parseInt(leaf, 16))) users.add(b);
    } else {
        const bt = basePe.text;
        for (const [d, where] of accesses(basePe, bt.rva, bt.rva + bt.rawSize, tables)) {
            if (d !== disp) continue;
            for (const w of where) {
                const f = containing(baseFuncs, parseInt(w.slice(w.indexOf("@0x") + 3), 16));
                if (f !== null) users.add(f.begin);
            }
        }
    }
    const named = [...users].map(b => [b, baseRev.get(b >>> 0)]).filter(([, n]) => n !== undefined);
    console.log(
        `baseline: ${users.size} function(s) ${leaf === undefined ? `touch ${disp} (0x${disp.toString(16)})` : `call 0x${leaf}`}, ${named.length} of them named`,
    );

    for (const v of builds) {
        const exe = `work/bin/${v}/bedrock_server.exe`;
        const syms = JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8")).symbols;
        const pe = loadPE(exe);
        const fns = functions(exe);
        const mapped = [];
        for (const [b, n] of named) if (n in syms) mapped.push([n, b, syms[n] >>> 0]);
        const support = new Map();
        let usable = 0;
        for (const [n, , rva] of mapped) {
            const a = fnAccesses(pe, fns, rva);
            if (a === null) continue;
            usable++;
            for (const d of a.map.keys()) {
                if (!support.has(d)) support.set(d, []);
                support.get(d).push(n);
            }
        }
        const ranked = [...support.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
        console.log(`\n${v}: ${mapped.length} of the named users are in our table, ${usable} have a .pdata entry`);
        for (const [d, who] of ranked.slice(0, top)) {
            console.log(`  ${String(d).padStart(6)} (0x${d.toString(16)})  support ${who.length}/${usable}${who.length === usable ? "  <- all of them" : ""}`);
        }
    }
    process.exit(0);
}

const exe = args[1];
const rest = args.slice(2);
if (exe === undefined) {
    console.error("missing <exe>");
    process.exit(2);
}
const pe = loadPE(exe);
const funcs = functions(exe);

if (mode === "shared") {
    let shared = null;
    for (const arg of rest) {
        const rva = parseInt(arg, 16);
        const a = fnAccesses(pe, funcs, rva);
        if (a === null) {
            console.log(`0x${rva.toString(16)}: no .pdata entry`);
            process.exit(1);
        }
        console.log(`fn 0x${a.f.begin.toString(16)} ${a.f.end - a.f.begin}B: ${a.map.size} displacement(s)`);
        const keys = new Set(a.map.keys());
        shared = shared === null ? keys : new Set([...shared].filter(k => keys.has(k)));
    }
    const list = [...shared].sort((a, b) => a - b);
    console.log(`shared: ${list.map(d => `${d} (0x${d.toString(16)})`).join(", ") || "(none)"}`);
    process.exit(0);
}

const disp = parseInt(rest[0], 16);
const rev = reverseNames(rest[1]);
const byFunction = new Map();
const text = pe.text;
for (const [d, where] of accesses(pe, text.rva, text.rva + text.rawSize, tables)) {
    if (d !== disp) continue;
    for (const w of where) {
        const rva = parseInt(w.slice(w.indexOf("@0x") + 3), 16);
        const f = containing(funcs, rva);
        const key = f === null ? rva : f.begin;
        if (!byFunction.has(key)) byFunction.set(key, []);
        byFunction.get(key).push(w);
    }
}
for (const [begin, where] of [...byFunction].sort((a, b) => a[0] - b[0])) {
    const name = rev?.get(begin >>> 0) ?? "";
    console.log(`fn 0x${begin.toString(16)} ${name} ${where.join(" | ")}`);
}
console.log(`functions: ${byFunction.size}`);
