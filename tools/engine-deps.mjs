/**
 * Every per-build fact the engine layer depends on, and whether each build's table has it
 * (docs/plan-architecture.md A3; the checklist for a new build, docs/HANDOFF.md section 6 / Q6).
 *
 * The engine layer (bdsx/bdsx/bds/engine/) reads the build only through three calls with literal
 * arguments, so the dependency set is a static scan of bdsx's source:
 *
 *   engineLayout("Class", "field", fallback)   -> symbols-<v>.json layouts[Class][field]
 *   engineSymbol("?decorated@name")             -> symbols-<v>.json symbols / accessors / constants
 *   componentHash("Name") / enttTypeHash("Name") -> the build's EnTT type list (work/entt/typenames-<v>.json)
 *                                                  or its pretty_function names (image-names-<v>.json)
 *
 * The whole of bdsx/bdsx is scanned, not only engine/, so a call site outside the engine directory
 * that already uses the helpers is counted too.
 *
 *   node tools/engine-deps.mjs            the table, then a line per build: how many are missing
 *   node tools/engine-deps.mjs --missing  only what some build lacks
 *   node tools/engine-deps.mjs --json     machine-readable
 */
import * as fs from "fs";
import * as path from "path";

const BUILDS = ["1.26.40.8", "1.26.51.1"];
const ROOT = "bdsx/bdsx";
const args = process.argv.slice(2);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
}

const deps = new Map(); // key -> { kind, what, fallback?, sites: [] }
const add = (kind, what, site, fallback) => {
    const key = `${kind} ${what}`;
    if (!deps.has(key)) deps.set(key, { kind, what, fallback, sites: [] });
    deps.get(key).sites.push(site);
};
for (const f of walk(ROOT)) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((text, i) => {
        const site = `${path.relative(".", f)}:${i + 1}`;
        if (/^\s*(\/\/|\*)/.test(text)) return;
        for (const m of text.matchAll(/engineLayout\("([^"]+)",\s*"([^"]+)",\s*([^)]*)\)/g)) add("layout", `${m[1]}.${m[2]}`, site, m[3].trim());
        for (const m of text.matchAll(/engineSymbol\("([^"]+)"\)/g)) add("symbol", m[1], site);
        for (const m of text.matchAll(/(?:componentHash|enttTypeHash)\("([^"]+)"\)/g)) add("component", m[1], site);
    });
}

const load = f => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const tables = Object.fromEntries(BUILDS.map(v => [v, load(`data/symbols-${v}.json`)]));
const types = Object.fromEntries(BUILDS.map(v => {
    const set = new Set();
    const tl = load(`work/entt/typenames-${v}.json`);
    if (tl) for (const t of Object.keys(tl)) { set.add(t); set.add(t.split("::").pop()); }
    const im = load(`work/entt/image-names-${v}.json`);
    if (im) for (const t of im.prettyTypes) { set.add(t); set.add(t.split("::").pop()); }
    return [v, set];
}));

function status(d, v) {
    const t = tables[v];
    switch (d.kind) {
        case "layout": {
            const [cls, field] = d.what.split(".");
            const val = t?.layouts?.[cls]?.[field];
            return typeof val === "number" ? String(val) : null;
        }
        case "symbol":
            if (t?.symbols?.[d.what] != null) return "0x" + Number(t.symbols[d.what]).toString(16);
            if (t?.accessors?.[d.what]) return "accessor";
            if (t?.constants?.[d.what]) return "constant";
            return null;
        case "component":
            return types[v].has(d.what) ? "named" : null;
    }
}

const rows = [...deps.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.what.localeCompare(b.what));
for (const r of rows) r.builds = Object.fromEntries(BUILDS.map(v => [v, status(r, v)]));

if (args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 1));
    process.exit(0);
}
const onlyMissing = args.includes("--missing");
for (const r of rows) {
    const miss = BUILDS.filter(v => r.builds[v] === null);
    if (onlyMissing && miss.length === 0) continue;
    const cols = BUILDS.map(v => (r.builds[v] ?? `MISSING${r.kind === "layout" ? ` (fallback ${r.fallback})` : ""}`).padEnd(22)).join(" ");
    console.log(`${r.kind.padEnd(9)} ${r.what.slice(0, 70).padEnd(70)} ${cols} ${r.sites[0]}${r.sites.length > 1 ? ` +${r.sites.length - 1}` : ""}`);
}
const byKind = k => rows.filter(r => r.kind === k).length;
console.log(`\n${rows.length} dependencies (${byKind("layout")} layouts, ${byKind("symbol")} symbols, ${byKind("component")} component names)`);
for (const v of BUILDS) {
    const miss = rows.filter(r => r.builds[v] === null);
    console.log(`${v}: ${miss.length} missing${miss.length ? ": " + miss.map(r => r.what).slice(0, 12).join(", ") + (miss.length > 12 ? ", ..." : "") : ""}`);
}
