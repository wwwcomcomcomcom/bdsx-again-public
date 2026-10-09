/**
 * A1 of docs/plan-architecture.md: classify every required name that is missing on at least one 1.26
 * build, and every data/derived.json entry, as live / moved / absorbed / gone / unknown.
 *
 * The class of a name comes from, in order:
 *   1. data/arch-classes.json   hand-written verdicts, each with its evidence (findings docs, runs)
 *   2. mechanical rules          one build's table has it (live), a `bdsx:` key serves it (moved), a
 *                                derived() entry (moved when it forwards to one other 1.26 function or
 *                                slot, absorbed when it re-implements the body), merged `unresolved`
 *   3. Endstone                  the matching release's windows.h names it (live), or the class header
 *                                declares it `virtual` (live: Endstone's virtual order is what it calls
 *                                through). A plain declaration or an Endstone-side body is a hint only.
 *   4. the image's strings       the exact decoration is the scope of a lambda type descriptor (live:
 *                                tools/image-names.mjs; the function exists, its address is not shown)
 *   5. otherwise unknown         with the hints that were found.
 * Nothing mechanical ever produces `gone` (plan section 4: only a hand verdict with evidence can).
 * A hand verdict may leave a name `unknown` with `notGone` (the role is shown to exist in 1.26, but whether
 * a callable function survives is still a search); those are counted as `unknownNotGone`.
 *
 * The Endstone "not declared" signal is scored first against the names both tables resolve by
 * address (all live): the share of them Endstone does not declare is the false-`gone` rate that
 * signal would have (plan section 4, "precision before yield").
 *
 * Usage:
 *   node tools/arch-inventory.mjs            write data/arch-inventory.json, print the summary
 *   node tools/arch-inventory.mjs --dry      print the summary only
 *   node tools/arch-inventory.mjs --list=<class>   print the names of one class (e.g. unknown)
 */
import * as fs from "fs";
import * as path from "path";

const BUILDS = ["1.26.40.8", "1.26.51.1"];
// the Endstone release that targets each build (docs/HANDOFF.md section 6, "Restoring work/")
const ENDSTONE = { "1.26.40.8": "work/endstone-0.11.7", "1.26.51.1": "work/endstone" };
const OUT = "data/arch-inventory.json";
const CLASSES = ["live", "moved", "absorbed", "gone", "unknown"];

const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const args = process.argv.slice(2);
const opt = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a && a.slice(k.length + 3); };

const required = load("data/required-symbols.json").symbols;
const derived = load("data/derived.json").derived;
const manualKeys = fs.existsSync("data/arch-classes.json") ? load("data/arch-classes.json").names : {};
const merged = Object.fromEntries(BUILDS.map(v => [v, load(`data/merged-${v}.json`)]));
const inTable = (v, n) => { const m = merged[v]; return n in m.symbols || n in (m.accessors ?? {}) || n in (m.constants ?? {}); };

// ---- decorated name -> { cls, method, kind } (only as much MSVC as the required set uses) ----
function demangle(name) {
    let m;
    if ((m = /^\?\?_7(\w+)@@6B/.exec(name))) return { cls: m[1], method: null, kind: "vftable" };
    if ((m = /^\?\?_G(\w+)@@/.exec(name))) return { cls: m[1], method: `~${m[1]}`, kind: "dtor" };
    if ((m = /^\?\?0(\w+)@@/.exec(name))) return { cls: m[1], method: m[1], kind: "ctor" };
    if ((m = /^\?\?1(\w+)@@/.exec(name))) return { cls: m[1], method: `~${m[1]}`, kind: "dtor" };
    if ((m = /^\?\?\$(\w+)@[^@]*@(\w+)@@/.exec(name))) return { cls: m[2], method: m[1], kind: "template" };
    if ((m = /^\?\?\$(\w+)@/.exec(name))) return { cls: null, method: m[1], kind: "template" };
    if ((m = /^\?(\w+)@(\w+)@@([0-9])/.exec(name))) return { cls: m[2], method: m[1], kind: "data" };
    if ((m = /^\?(\w+)@(\w+)@(\w+)@@/.exec(name))) return { cls: m[2], outer: m[3], method: m[1], kind: "fn" };
    if ((m = /^\?(\w+)@(\w+)@@/.exec(name))) return { cls: m[2], method: m[1], kind: "fn" };
    if ((m = /^\?(\w+)@@/.exec(name))) return { cls: null, method: m[1], kind: "free" };
    if ((m = /^bdsx:(\w+)(?:::(\w+))?$/.exec(name))) return { cls: m[2] ? m[1] : null, method: m[2] ?? m[1], kind: "bdsx" };
    return { cls: null, method: null, kind: "other" };
}

// ---- Endstone index: class -> [{ file, line, body }], plus out-of-class definitions ----
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (/\.(h|cpp)$/.test(e.name)) out.push(p);
    }
    return out;
}
function indexEndstone(root) {
    const classes = new Map(), defs = new Set();
    const files = walk(path.join(root, "src/bedrock"));
    for (const f of files) {
        const t = fs.readFileSync(f, "utf8");
        // out-of-class definitions: `Ret Class::method(`
        for (const m of t.matchAll(/\b(\w+)::(~?\w+)\s*\([^;{]*\)[^;{]*\{/g)) defs.add(`${m[1]}::${m[2]}`);
        if (!f.endsWith(".h")) continue;
        const re = /\b(class|struct)\s+(?:\[\[[^\]]*\]\]\s*)?(?:ENDSTONE_\w+\s+)?(\w+)(?:\s+final)?\s*(?::[^{;]*)?\{/g;
        for (const m of t.matchAll(re)) {
            let depth = 0, i = m.index + m[0].length - 1, j = i;
            for (; j < t.length; j++) { if (t[j] === "{") depth++; else if (t[j] === "}" && --depth === 0) break; }
            const line = t.slice(0, m.index).split("\n").length;
            if (!classes.has(m[2])) classes.set(m[2], []);
            classes.get(m[2]).push({ file: path.relative(root, f), line, body: t.slice(i, j) });
        }
    }
    const symbols = new Set();
    const wh = path.join(root, "src/bedrock/symbols/windows.h");
    if (fs.existsSync(wh)) for (const m of fs.readFileSync(wh, "utf8").matchAll(/\{"([^"]+)",\s*\d+\}/g)) symbols.add(m[1]);
    return { classes, defs, symbols };
}
const endstone = Object.fromEntries(BUILDS.map(v => [v, indexEndstone(ENDSTONE[v])]));

// what Endstone says about one name, for one build
function endstoneFacts(v, name, d) {
    const es = endstone[v], r = { symbol: es.symbols.has(name) };
    if (!d.cls) return r;
    const bodies = es.classes.get(d.cls);
    r.cls = !!bodies;
    if (!bodies || !d.method) return r;
    const esc = d.method.replace(/[~]/g, "\\~");
    for (const b of bodies) {
        const lines = b.body.split("\n");
        for (let k = 0; k < lines.length; k++) {
            const L = lines[k];
            if (!new RegExp(`(^|[^\\w:~])${esc}\\s*\\(`).test(L)) continue;
            if (/^\s*\/\//.test(L)) { r.commented = r.commented ?? `${b.file}:${b.line + k}`; continue; }
            r.declared = `${b.file}:${b.line + k}`;
            r.text = L.trim().replace(/\s+/g, " ").slice(0, 160);
            if (/\bvirtual\b/.test(L) || /\boverride\b/.test(L)) r.virtual = true;
            if (/\)\s*(const\s*)?(noexcept\s*)?\{/.test(L)) r.inlineBody = true;
            break;
        }
        if (r.declared) break;
    }
    if (es.defs.has(`${d.cls}::${d.method}`)) r.defined = true;
    return r;
}

// MSVC access code after the scope: U/M/E are virtual (public/protected/private), Q/I/A plain,
// S/K/C static. null when the name is not a member function.
function virtual2024(name) {
    const m = /^\?\??[\w$]+@(?:[\w]+@)+@([A-Z])/.exec(name);
    if (!m) return null;
    return "UME".includes(m[1]) ? true : "QIASKC".includes(m[1]) ? false : null;
}

// ---- derived(): forwarders are `moved`, re-implemented bodies `absorbed` ----
// A forwarder hands the whole job to one other 1.26 function or vtable slot (the role has a new
// name or owner). Everything else re-implements the body on a layout, a component, or pure logic.
const FORWARDERS = new Set([
    "sendArmorSlot@Mob", "updateWeather@Level", "setStatusFlag@Actor",
    "isSneaking@Actor", "isSprinting@Mob", "isInLove@Actor", "isBaby@Actor", "isAngry@Actor", "isMoving@Actor",
    "isSwimming@Actor", "isInScaffolding@Actor", "getDimensionBlockSource@Actor", "getOffhandSlot@Actor",
    "setBlock@BlockSource", "setBedRespawnPosition@Player", "hasEffect@Actor", "hasTotemEquipped@Actor",
    "isFlying@Player", "setItem@PlayerInventory", "setSelectedItem@PlayerInventory", "add@PlayerInventory",
    "canAdd@PlayerInventory", "clearSlot@PlayerInventory", "getContainerSize@PlayerInventory",
    "getFirstEmptySlot@PlayerInventory", "getSlotWithItem@PlayerInventory", "swapSlots@PlayerInventory",
    "isRiding@Actor/0", "setCursorSelectedItem@Player", "setNameTagVisible@Actor", "getId@SetTitlePacket",
    "getName@LoginPacket", "getComponentItem@ItemStackBase", "isDamageableItem@ItemStackBase",
    "getBlockTarget@Actor",
]);
function derivedImpl(entry) {
    const w = `${entry.what ?? ""}`;
    if (/fnv1a|enttComponent|try_get|hasComponent|Component the|Component\)|FlagComponent|InsideBlockComponent/.test(w)) return "component";
    if (/\+0x|\+\d|layouts\.|at \+|offset/.test(w)) return "layout";
    if (/slot \d|vtable|vftable|thunk/.test(w)) return "call";
    return "util";
}
function derivedClass(name, entry) {
    const d = demangle(name);
    let key = `${d.method}@${d.cls}`;
    if (key === "isRiding@Actor") key += name.includes("QEBA_NXZ") ? "/0" : "/1";
    const impl = derivedImpl(entry);
    return FORWARDERS.has(key)
        ? { class: "moved", impl: "call", evidence: `derived(): forwards to another 1.26 function or slot -- ${entry.what ?? ""}`.slice(0, 400) }
        : { class: "absorbed", impl, evidence: `derived(): re-implemented on ${impl} -- ${entry.what ?? "(no description)"}`.slice(0, 400) };
}

// `bdsx:` keys that stand in for a decorated name whose 1.26 signature is not knowable
const BDSX_KEYS = {};
for (const v of BUILDS) for (const k of Object.keys(merged[v].symbols)) {
    const d = demangle(k);
    if (d.kind === "bdsx" && d.cls) (BDSX_KEYS[`${d.method}@${d.cls}`] ??= []).push(`${k} (${v})`);
}
// a `bdsx:` key spelled for the base class whose decorated name names an override (NetherDimension's getDefaultBiome is
// served as bdsx:Dimension::getDefaultBiome, a slot every dimension table carries)
const BDSX_KEY_ALIAS = { "getDefaultBiome@NetherDimension": "getDefaultBiome@Dimension" };
const bdsxKeyFor = (method, cls) => {
    const k = `${method}@${cls}`, list = BDSX_KEYS[BDSX_KEY_ALIAS[k] ?? k];
    // served only when every build's table carries the key
    return list && BUILDS.every(v => list.some(x => x.endsWith(`(${v})`))) ? list : null;
};

// ---- the set to classify ----
const reqByName = new Map(required.map(s => [s.name, s]));
const names = new Set();
for (const s of required) if (BUILDS.some(v => !inTable(v, s.name))) names.add(s.name);
for (const n of Object.keys(derived)) names.add(n);

// hand verdicts: a key is a full name or a prefix of one; a key that matches nothing is stale
const manual = {}, notRequired = {};
for (const [k, v] of Object.entries(manualKeys)) {
    const hit = [...names].filter(n => n === k || n.startsWith(k));
    if (!hit.length && v.notRequired) { notRequired[k] = v; continue; }
    if (!hit.length) { console.error(`data/arch-classes.json: "${k}" matches no name in the set (mark it notRequired if bdsx dropped it)`); process.exit(2); }
    if (v.notRequired) { console.error(`data/arch-classes.json: "${k}" is marked notRequired but is in the set again`); process.exit(2); }
    if (!CLASSES.includes(v.class)) { console.error(`data/arch-classes.json: "${k}" has class "${v.class}"`); process.exit(2); }
    for (const n of hit) manual[n] = v;
}

// per-build hints from the candidate files: an address some route proposed but the merge did not ship
const candidates = Object.fromEntries(BUILDS.map(v => {
    const m = new Map();
    for (const f of fs.readdirSync("data").filter(f => f.startsWith("candidates-") && f.endsWith(`-${v}.json`))) {
        const x = load(`data/${f}`), route = f.slice(11, -(v.length + 6));
        for (const [n, rva] of Object.entries(x.symbols ?? {})) if (!m.has(n)) m.set(n, `${route} 0x${Number(rva).toString(16)}`);
    }
    return [v, m];
}));
// Endstone marks these as changed signatures: the name exists, the decoration does not match
const sigChanged = new Set(BUILDS.flatMap(v => load(`data/candidates-endstone-slots-${v}.json`).signatureChanged ?? []));
// the argument-shape veto merge-symbols applies: 'wrong function or changed signature'
const shapeVetoed = Object.fromEntries(BUILDS.map(v => {
    const f = `work/derived/shape-cache-${v}.json`;
    return [v, new Set(fs.existsSync(f) ? Object.entries(load(f)).filter(([, ok]) => ok === false).map(([k]) => k.replace(/@\d+$/, "")) : [])];
}));
// EnTT type names the binary carries (tools/entt-typenames.mjs --out=work/entt/typenames-<v>.json):
// a class listed there exists in that build, whatever happened to its methods
const enttTypes = Object.fromEntries(BUILDS.map(v => {
    const f = `work/entt/typenames-${v}.json`, set = new Set();
    if (fs.existsSync(f)) for (const t of Object.keys(load(f))) { set.add(t); const m = /(?:::)(\w+)$/.exec(t); if (m) set.add(m[1]); }
    return [v, set];
}));
// strings in the image (tools/image-names.mjs -> work/entt/image-names-<v>.json): a decorated name that is
// the scope of a lambda type descriptor exists in that build's source with exactly that signature, and a
// `pretty_function() [Type = X]` names a type EnTT touches (it lists types the type_info scan misses)
const imageNames = Object.fromEntries(BUILDS.map(v => {
    const f = `work/entt/image-names-${v}.json`, x = fs.existsSync(f) ? load(f) : { lambdaScopes: [], prettyTypes: [] };
    const types = new Set();
    for (const t of x.prettyTypes) { types.add(t); const m = /(?:::)(\w+)$/.exec(t); if (m) types.add(m[1]); }
    return [v, { scopes: new Set(x.lambdaScopes), types }];
}));
// names the 1.21.3.01 PDB has (bdsx's own 2024 pdbcache); a required name missing there was already dead in 2024
const base2024 = load("data/baseline-1.21.3.01.json").symbols;
const leaf = new Map(Object.entries(load("data/leaf-accessors.json").accessors));

function classify(name) {
    const d = demangle(name), s = reqByName.get(name);
    const has = Object.fromEntries(BUILDS.map(v => [v, inTable(v, name)]));
    const es = Object.fromEntries(BUILDS.map(v => [v, endstoneFacts(v, name, d)]));
    const hints = [];
    for (const v of BUILDS) {
        const e = es[v];
        if (e.defined) hints.push(`Endstone (${v}) has a body for ${d.cls}::${d.method}`);
        else if (e.declared && !e.virtual) hints.push(`Endstone (${v}) declares it (non-virtual) at ${e.declared}`);
        if (e.commented) hints.push(`Endstone (${v}) has it commented out at ${e.commented}`);
        if (e.cls === false) hints.push(`class ${d.cls} not defined in Endstone (${v})`);
        if (!has[v] && candidates[v].has(name)) hints.push(`unshipped candidate on ${v}: ${candidates[v].get(name)}`);
        if (shapeVetoed[v].has(name)) hints.push(`argument-shape veto on ${v} (merge-symbols): wrong function or changed signature`);
    }
    if (s && d.kind !== "bdsx" && !(name in base2024)) hints.push("not in the 1.21.3.01 PDB: bdsx referenced it dead in 2024 already");
    const entt = BUILDS.filter(v => d.cls && enttTypes[v].has(d.cls));
    if (entt.length) hints.push(`class ${d.cls} is an EnTT type name in ${entt.join(", ")}: the class exists`);
    const pretty = BUILDS.filter(v => d.cls && !enttTypes[v].has(d.cls) && imageNames[v].types.has(d.cls));
    if (pretty.length) hints.push(`class ${d.cls} is named by an EnTT pretty_function string in ${pretty.join(", ")}: the class exists`);
    const scope = BUILDS.filter(v => imageNames[v].scopes.has(name));
    if (scope.length) hints.push(`this exact decoration is the scope of a lambda type descriptor in ${scope.join(", ")}: the function exists with this signature (tools/image-names.mjs)`);
    if (leaf.has(name)) { const a = leaf.get(name); hints.push(`2024 body is a leaf field access (${a.kind}, ${a.width}B at baseline +${a.off}), data/leaf-accessors.json`); }
    let verdict;
    if (manual[name]) verdict = { ...manual[name], source: "hand" };
    else if (name in derived && !BUILDS.every(v => has[v])) verdict = { ...derivedClass(name, derived[name]), source: "derived" };
    else if (BUILDS.some(v => has[v])) {
        const on = BUILDS.filter(v => has[v]);
        verdict = { class: "live", evidence: `resolved on ${on.join(", ")} (data/merged-<v>.json); missing on ${BUILDS.filter(v => !has[v]).join(", ") || "none"}`, source: "table" };
    } else if (d.kind === "fn" && bdsxKeyFor(d.method, d.cls)) {
        verdict = { class: "moved", evidence: `served under ${bdsxKeyFor(d.method, d.cls).join(", ")}: the 1.26 signature differs from the decorated name`, source: "bdsx-key" };
    } else if (BUILDS.some(v => name in (merged[v].unresolved ?? {}))) {
        verdict = { class: "absorbed", evidence: BUILDS.map(v => merged[v].unresolved?.[name]).find(Boolean), source: "unresolved" };
    } else if (sigChanged.has(name)) {
        verdict = { class: "moved", evidence: "Endstone's header gives this slot a different signature (candidates-endstone-slots signatureChanged): the function exists, the decorated name does not", source: "endstone" };
    } else if (d.kind === "vftable" && BUILDS.some(v => (endstone[v].classes.get(d.cls) ?? []).some(b => /\bvirtual\b/.test(b.body)))) {
        const v = BUILDS.find(x => (endstone[x].classes.get(d.cls) ?? []).some(b => /\bvirtual\b/.test(b.body)));
        verdict = { class: "live", evidence: `Endstone (${v}) defines ${d.cls} with virtual members (${endstone[v].classes.get(d.cls)[0].file}), so the class has a vftable in 1.26`, source: "endstone" };
    } else if (BUILDS.some(v => es[v].symbol)) {
        verdict = { class: "live", evidence: `listed in Endstone's windows.h for ${BUILDS.filter(v => es[v].symbol).join(", ")}`, source: "endstone" };
    } else if (BUILDS.some(v => es[v].virtual)) {
        const v = BUILDS.find(x => es[x].virtual);
        const at = `Endstone (${v}) ${es[v].declared}: \`${es[v].text}\``;
        verdict = virtual2024(name) === false
            ? { class: "moved", evidence: `non-virtual in 2024, declared virtual in 1.26 -- ${at}; the decorated name cannot match`, source: "endstone" }
            : { class: "live", evidence: `declared virtual, and Endstone calls through that vtable order -- ${at}; compare the prototype before promoting`, source: "endstone" };
    } else if (scope.length) {
        verdict = { class: "live", evidence: `the exact decoration is the scope of a lambda type descriptor in ${scope.join(", ")} (tools/image-names.mjs): the function exists with this signature; the address, or whether it was inlined into every caller, is the open question`, source: "lambda-scope" };
    } else verdict = { class: "unknown", evidence: null, source: "none" };
    return {
        name, ...verdict, hints: hints.length ? [...new Set(hints)] : undefined,
        missing: BUILDS.filter(v => !has[v]),
        api: s ? s.sites : [derived[name]?.site ?? "?"],
        cls: d.cls, method: d.method, kind: d.kind,
    };
}

const entries = [...names].sort().map(classify);

// ---- precision of the "Endstone does not declare it" signal, on names both tables resolve ----
function scoreSignal() {
    const live = required.filter(s => BUILDS.every(v => name_in_symbols(v, s.name))).map(s => s.name);
    const rows = { total: 0, noClass: 0, notDeclared: 0 };
    const byKind = {};
    for (const n of live) {
        const d = demangle(n);
        if (!d.cls || !d.method || !["fn", "ctor", "dtor", "template"].includes(d.kind)) continue;
        const e = endstone["1.26.51.1"].classes.has(d.cls) || endstone["1.26.40.8"].classes.has(d.cls);
        const decl = BUILDS.some(v => { const f = endstoneFacts(v, n, d); return f.declared || f.defined; });
        rows.total++;
        if (!e) rows.noClass++;
        if (!decl) rows.notDeclared++;
        const k = d.kind; byKind[k] ??= { total: 0, notDeclared: 0 }; byKind[k].total++; if (!decl) byKind[k].notDeclared++;
    }
    const pct = (a, b) => `${(100 * a / b).toFixed(1)}%`;
    return {
        population: "required names resolved by address on both builds (all live), functions only",
        total: rows.total,
        classAbsentFromEndstone: rows.noClass, classAbsentRate: pct(rows.noClass, rows.total),
        methodNotDeclaredInEndstone: rows.notDeclared, falseGoneRate: pct(rows.notDeclared, rows.total),
        byKind,
    };
}
function name_in_symbols(v, n) { return n in merged[v].symbols; }
const scoring = scoreSignal();

// ---- group by bdsx API area: file, then class ----
const areas = {};
for (const e of entries) {
    const file = (e.api[0] ?? "?").replace(/^bdsx\//, "").replace(/:\d+$/, "");
    ((areas[file] ??= {})[e.cls ?? "(free)"] ??= []).push(e.name);
}
const counts = Object.fromEntries(CLASSES.map(c => [c, entries.filter(e => e.class === c).length]));
// an `unknown` whose role is shown to exist in 1.26 (hand verdict `notGone`): a search, never a drop candidate
counts.unknownNotGone = entries.filter(e => e.class === "unknown" && e.notGone).length;
const bySource = {};
for (const e of entries) bySource[`${e.class}/${e.source}`] = (bySource[`${e.class}/${e.source}`] ?? 0) + 1;

const listCls = opt("list");
if (listCls) {
    for (const e of entries.filter(e => e.class === listCls)) console.log(`${e.name}\t${e.api[0]}\t${(e.hints ?? []).join(" | ")}`);
    process.exit(0);
}

console.log(`${entries.length} names: ${CLASSES.map(c => `${c} ${counts[c]}`).join(", ")} (${counts.unknownNotGone} of them shown not gone); plus ${Object.keys(notRequired).length} hand verdicts on names outside the required set (comment-only or replaced by a successor) (${Object.values(notRequired).filter(v => v.class === "gone").length} gone)`);
console.log("by source:", JSON.stringify(bySource));
console.log(`signal "Endstone does not declare it": ${scoring.methodNotDeclaredInEndstone}/${scoring.total} resolved names = ${scoring.falseGoneRate} false-gone; class absent ${scoring.classAbsentRate}`);

if (!args.includes("--dry")) {
    const out = {
        _comment: "Generated by tools/arch-inventory.mjs (A1, docs/plan-architecture.md). Hand verdicts live in data/arch-classes.json; edit there and regenerate.",
        generatedAt: new Date().toISOString().slice(0, 10),
        builds: BUILDS,
        counts, bySource, scoring,
        areas,
        notRequired,
        names: Object.fromEntries(entries.map(({ name, ...rest }) => [name, rest])),
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
    console.log(`wrote ${OUT}`);
}
