/**
 * Milestone 1a — extract the decorated-name symbol set bdsx requires.
 *
 * Walks the bdsx source with the TypeScript compiler API and records every
 * MSVC decorated name it asks the seam for, together with how it is used.
 * The result is the denominator for the coverage metric: a target list that
 * can be measured without ever launching BDS.
 */
import ts from "typescript";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.argv[2] ?? "bdsx";
const OUT = process.argv[3] ?? "data/required-symbols.json";

/** Arg index holding the decorated name, per ProcHacker method. */
const HACKER_KEY_ARG = {
    js: 0,
    hooking: 0,
    hookingRaw: 0,
    hookingRawWithOriginal: 0,
    hookingRawWithCallOriginal: 0,
    hookingRawWithoutOriginal: 0,
    write: 0,
    nopping: 1,
    patching: 1,
    jsv: [0, 1], // (vftable, key)
};

const SKIP_DIRS = new Set(["node_modules", ".git", "bedrock_server", "build", "images"]);

function* walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(ent.name)) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) yield* walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) yield p;
    }
}

/**
 * Shape of an MSVC decorated name. Only the regex catch-all needs this --
 * anything reached through `proc` structurally is a symbol whatever it looks
 * like, and bdsx does ask for undecorated C names such as `vsnprintf`.
 */
// the game thread entry is an undecorated template instantiation bdsx names through a constant; a `bdsx:` key is a
// function whose present signature has no decoration we can know (docs/findings-slots.md, "Changed signatures")
const isDecorated = s => (s.startsWith("?") && s.includes("@")) || s.startsWith("<lambda_") || s.startsWith("std::thread::_Invoke<") || s.startsWith("bdsx:");

/** Members of `proc` that are not symbol lookups. */
const NOT_A_SYMBOL = new Set(["vftable", "__proto__", "constructor", "hasOwnProperty"]);

const symbols = new Map();
function record(name, kind, file, line) {
    if (!name || NOT_A_SYMBOL.has(name)) return;
    let e = symbols.get(name);
    if (!e) symbols.set(name, (e = { name, kinds: new Set(), sites: [] }));
    e.kinds.add(kind);
    e.sites.push(`${file}:${line}`);
}

/**
 * The text with every comment replaced by spaces (newlines kept). Comment ranges come from the parsed
 * tree (leading/trailing trivia of every node), not a raw scan, which loses its place at the first regex
 * literal.
 */
function blankProse(sf) {
    const text = sf.text, out = text.split("");
    const blank = r => { for (let i = r.pos; i < r.end; i++) if (out[i] !== "\n") out[i] = " "; };
    const seen = new Set();
    const visit = node => {
        for (const r of [...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? [])]) {
            if (!seen.has(r.pos)) { seen.add(r.pos); blank(r); }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const r of ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()) ?? []) blank(r);
    // A message handed to an error constructor is prose, even when it opens with a decorated name
    // (`throw Error("??_7X@@6B@: no address in this build")`). Only the string-literal arguments of a
    // `(new) Error(...)`/`TypeError(...)`/... call are blanked; the lookup itself stays visible.
    const errArgs = node => {
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text)) {
            for (const a of node.arguments ?? []) if (literalOf(a) !== null) blank({ pos: a.getStart(sf), end: a.getEnd() });
        }
        ts.forEachChild(node, errArgs);
    };
    errArgs(sf);
    return out.join("");
}

const literalOf = node =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

let fileCount = 0;
for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    fileCount++;
    const rel = path.relative(".", file);
    const lineOf = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    // `proc` is an ordinary local name in places like assembler.ts, so only
    // trust it in files that actually import the symbol proxy.
    const importsProc =
        /import\s*\{[^}]*\bproc2?\b[^}]*\}\s*from\s*["'][^"']*bds\/symbols["']/.test(text) ||
        file.endsWith("bds/symbols.ts");

    const visit = node => {
        // proc["..."] and proc.vftable["A\\B"]
        if (ts.isElementAccessExpression(node)) {
            const lit = literalOf(node.argumentExpression);
            const obj = node.expression.getText(sf);
            if (lit !== null) {
                if (importsProc && (obj === "proc" || obj === "proc2")) record(lit, "proc", rel, lineOf(node));
                else if (obj.endsWith("proc.vftable") || obj.endsWith("vftable")) {
                    for (const part of lit.split("\\")) record(part, "vftable-pair", rel, lineOf(node));
                }
            }
        }
        // proc.vsnprintf and friends -- bdsx reaches undecorated C symbols this way
        if (ts.isPropertyAccessExpression(node)) {
            const obj = node.expression.getText(sf);
            if (importsProc && (obj === "proc" || obj === "proc2")) record(node.name.text, "proc", rel, lineOf(node));
        }
        // procHacker.<method>(...)
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            const recv = node.expression.expression.getText(sf);
            if (/procHacker$|hacker$/.test(recv) && method in HACKER_KEY_ARG) {
                const idxs = [HACKER_KEY_ARG[method]].flat();
                for (const i of idxs) record(literalOf(node.arguments[i]), method, rel, lineOf(node));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    // Catch-all: any decorated-looking literal the structural pass missed. It reads the text with the
    // comments and error-message arguments blanked out (same length, newlines kept): upstream parks dead calls as
    // `// procHacker.js("?...")`, and those are not requirements (docs/findings-inventory.md section 7).
    const code = blankProse(sf);
    for (const m of code.matchAll(/"((?:\?|<lambda_|std::thread::_Invoke<|bdsx:)[^"\n]*)"/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        if (isDecorated(m[1]) && !symbols.get(m[1])?.sites.includes(`${rel}:${line}`)) {
            record(m[1], "literal", rel, line);
        }
    }
}

const out = [...symbols.values()]
    .map(e => ({ name: e.name, kinds: [...e.kinds].sort(), count: e.sites.length, sites: e.sites.slice(0, 8) }))
    .sort((a, b) => a.name.localeCompare(b.name));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
    OUT,
    JSON.stringify({ generatedFrom: ROOT, fileCount, total: out.length, symbols: out }, null, 2) + "\n",
);

const byKind = {};
for (const s of out) for (const k of s.kinds) byKind[k] = (byKind[k] ?? 0) + 1;
console.log(`scanned ${fileCount} files -> ${out.length} distinct decorated names`);
console.log("by usage kind:", byKind);
console.log(`wrote ${OUT}`);
