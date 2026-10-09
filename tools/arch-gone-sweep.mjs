/**
 * The `gone` sweep of A1 (docs/findings-inventory.md section 12): for every class that still has an
 * `unknown` name without a `notGone` reason, list every existence signal the build gives for the class --
 * the EnTT type-info list, pretty_function type names, the class in any mangled name in the image
 * (lambda descriptors and the like), names of the class in our merged tables, a class/struct in either
 * Endstone release -- and the plain-word count in each image. Classes with no signal come first; those
 * are the only ones worth reading by hand for `gone`. No signal is not evidence of `gone`: most such
 * classes are namespaces of free functions with no string footprint.
 *
 *   node tools/arch-gone-sweep.mjs      (needs work/entt/typenames-<v>.json and image-names-<v>.json)
 */
import fs from "fs";
const inv = JSON.parse(fs.readFileSync("data/arch-inventory.json", "utf8"));
const B = ["1.26.40.8", "1.26.51.1"];
const img = Object.fromEntries(B.map(v => [v, fs.readFileSync(`work/bin/${v}/bedrock_server.exe`).toString("latin1")]));
const tl = Object.fromEntries(B.map(v => [v, new Set(Object.keys(JSON.parse(fs.readFileSync(`work/entt/typenames-${v}.json`))).flatMap(t => [t, t.split("::").pop()]))]));
const pn = Object.fromEntries(B.map(v => { const x = JSON.parse(fs.readFileSync(`work/entt/image-names-${v}.json`)); return [v, new Set(x.prettyTypes.flatMap(t => [t, t.split("::").pop()]))]; }));
const merged = Object.fromEntries(B.map(v => [v, Object.keys(JSON.parse(fs.readFileSync(`data/merged-${v}.json`)).symbols)]));
const es = ["work/endstone/src", "work/endstone-0.11.7/src"];
// every source file of both Endstone releases, read once (was `grep -rlw ... | wc -l`, which needs a Unix shell)
const esFiles = es.flatMap(function walk(d) {
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : [fs.readFileSync(`${d}/${e.name}`, "latin1")]);
});
const classes = new Map();
for (const [n, v] of Object.entries(inv.names)) if (v.class === "unknown" && !v.notGone && v.cls) { if (!classes.has(v.cls)) classes.set(v.cls, []); classes.get(v.cls).push(n); }
const rows = [];
for (const [c, ns] of classes) {
    const sig = [];
    if (B.some(v => tl[v].has(c))) sig.push("typelist");
    if (B.some(v => pn[v].has(c))) sig.push("pretty");
    const mang = B.map(v => (img[v].match(new RegExp(`[?@]${c}@@`, "g")) || []).length);
    if (mang.some(x => x)) sig.push(`mangled ${mang.join("/")}`);
    const mt = B.map(v => merged[v].filter(k => k.includes(`@${c}@@`) || k.includes(`V${c}@@`)).length);
    if (mt.some(x => x)) sig.push(`tables ${mt.join("/")}`);
    const decl = new RegExp(`(^|\\W)(class|struct) ${c}(\\W|$)`);
    const e = esFiles.filter(s => decl.test(s)).length;
    if (e) sig.push(`endstone ${e}`);
    const plain = B.map(v => (img[v].match(new RegExp(`\\b${c}\\b`, "g")) || []).length);
    rows.push({ c, n: ns.length, sig, plain: plain.join("/") });
}
rows.sort((a, b) => a.sig.length - b.sig.length || b.n - a.n);
for (const r of rows) console.log(`${String(r.n).padStart(2)} ${r.c.padEnd(40)} plain ${r.plain.padEnd(9)} ${r.sig.join(", ") || "-- NONE --"}`);
