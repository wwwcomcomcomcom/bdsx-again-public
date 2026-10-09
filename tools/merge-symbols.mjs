/**
 * Fold every candidate file for a build into one name -> rva map for
 * tools/make-table.mjs, in order of trust: the resolved table first, then
 * vftables read from live instances, packet vftables read from live packets,
 * names carried from the previous build, the corroborated vftable walk, and
 * call-edge propagation last. A name
 * already taken by a more trusted source is not overwritten; a conflict is
 * printed.
 *
 * Usage: node tools/merge-symbols.mjs <version> <out.json>
 */
import * as fs from "fs";
const [v, out] = process.argv.slice(2);
const load = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const sources = [
    ["resolved", load(`data/resolved-${v}.json`)?.symbols],
    ["instances", load(`data/candidates-instances-${v}.json`)?.vftables],
    ["packets", load(`data/candidates-packets-${v}.json`)?.vftables],
    // constructors and destructors found from the vftable they store, with a
    // body that matches the PDB-named baseline body (tools/ctor-from-vftable.mjs,
    // docs/findings-instances.md); exact where checked, never hook-trusted
    ["ctor-store", load(`data/candidates-ctors-${v}.json`)?.symbols],
    // packet handlers by the baseline's override pattern in the NetEventCallback
    // table, kept where both 1.26 builds agree two slots apart (tools/netevent-align.mjs)
    ["netevent", load(`data/candidates-netevent-${v}.json`)?.symbols],
    // Level virtuals from Endstone's header order anchored on the confirmed slots,
    // kept where the other build agrees on slot and size (docs/findings-slots.md, route 9)
    ["level-anchored", load(`data/candidates-level-${v}.json`)?.symbols],
    // data/candidates-pairs-in-tables-<v>.json is deliberately not merged: a
    // call-edge pair landing in the right vftable agreed with the walk on
    // 2,023 of 2,026 slots the walk had already named and was wrong on 4 of
    // the 9 new Level slots checked by execution (docs/findings-slots.md).
    // It is a candidate generator for execution checks, not a source.
    // virtual slots placed by Endstone's header order (tools/endstone-slots.mjs):
    // a human-maintained slot table applied to a table we hold; 27/27 agreed
    // with the walk and the resolved table on 1.26.51.1, 8/8 with the pairs
    ["endstone-slots", load(`data/candidates-endstone-slots-${v}.json`)?.symbols],
    // names carried from the previous build by aligning this build's vftables
    // against that build's named tables (tools/carry-pipeline.mjs): two builds
    // weeks apart share a compiler, and the carry agreed with this build's own
    // walk on 3,460 of 3,494 names, against the 90-95% of a single walk from
    // the 2024 baseline, so it ranks above the walk
    ["carry", (() => { const c = load(`data/candidates-carry-${v}.json`); return c ? { ...c.vftables, ...c.symbols } : null; })()],
    ["vftable-walk", (() => { const c = load(`data/candidates-vftable-${v}.json`); return c ? { ...c.vftables, ...c.symbols } : null; })()],
    ["propagation", load(`data/candidates-propagation-${v}.json`)?.symbols],
    // gap propagation confirmed by the other build (tools/gaps-agree.mjs):
    // 98% on the shared held-out set; API names, never hook targets
    ["gaps-agree", load(`data/candidates-gaps-agree-${v}.json`)?.symbols],
    // a required name the other 1.26 build ships and this one lacked, carried where the cross-build pair map
    // and the body agree (tools/cross-build-fill.mjs); as good as its source there, never a hook target
    ["cross-build", load(`data/candidates-crossbuild-${v}.json`)?.symbols],
    ["corroborated", (() => { const c = load(`data/candidates-corroborated-${v}.json`); if (!c) return null; const o = {}; for (const [n, e] of Object.entries(c.agree2 ?? c.symbols ?? {})) o[n] = typeof e === "number" ? e : e.rva; return o; })()],
];
const resolved = load(`data/resolved-${v}.json`);
const layouts = (() => { const o = load(`data/candidates-instances-${v}.json`)?.offsets; if (!o) return {}; const r = {}; for (const [k, val] of Object.entries(o)) if (typeof val === "object") r[k] = val; return r; })();
// static const data shipped as bytes, not as an address (docs/findings-layouts.md,
// "Constants"): build-independent values whose storage the compiler no longer
// keeps, from tools/extract-constants.mjs. One file for every build.
const constants = (() => {
    const r = {};
    // the build-independent set first, then this build's own (SharedConstants'
    // version integers, which are the build number, and the protocol number the
    // server answers pings with)
    for (const f of ["data/constants.json", `data/constants-${v}.json`]) {
        const c = load(f)?.constants;
        if (!c) continue;
        for (const [n, e] of Object.entries(c)) if (typeof e === "object" && typeof e.bytes === "string" && /^([0-9a-f]{2})+$/.test(e.bytes)) r[n] = { bytes: e.bytes };
    }
    return r;
})();
// field accessors (docs/findings-layouts.md): a name that has no address in
// this build but a two-route offset; shipped as `accessors`, emitted by bdsx
const accessors = (() => { const a = load(`data/candidates-instances-${v}.json`)?.accessors; if (!a) return {}; const r = {}; for (const [n, e] of Object.entries(a)) if (typeof e === "object" && typeof e.off === "number" && e.kind) r[n] = { kind: e.kind, width: e.width, off: e.off, ...(e.float ? { float: true } : {}), ...(e.sx ? { sx: true } : {}), ...(e.zx ? { zx: true } : {}) }; return r; })();
const symbols = {}, origin = {};
let conflicts = 0;
for (const [name, map] of sources) {
    if (!map) { console.log(`  (no ${name} file)`); continue; }
    let added = 0;
    for (const [n, rva] of Object.entries(map)) {
        if (typeof rva !== "number") continue;
        if (n in symbols) { if (symbols[n] !== rva) { conflicts++; console.log(`  conflict ${n.slice(0, 60)}: ${origin[n]} 0x${symbols[n].toString(16)} vs ${name} 0x${rva.toString(16)} (kept ${origin[n]})`); } continue; }
        symbols[n] = rva; origin[n] = name; added++;
    }
    console.log(`${name}: +${added}`);
}
// Names shown to be wrong by execution (data/candidates-instances-<v>.json `retracted`: name -> why). A
// lower-ranked route cannot be edited by hand -- it is regenerated -- so the retraction lives with the
// evidence and is applied here. It never removes a name a trusted source supplies.
const retracted = load(`data/candidates-instances-${v}.json`)?.retracted ?? {};
for (const n of Object.keys(retracted)) {
    if (!(n in symbols)) continue;
    if (["resolved", "instances", "packets"].includes(origin[n])) { console.log(`  retraction of ${n.slice(0, 60)} ignored: ${origin[n]} supplies it`); continue; }
    console.log(`  retracted ${n.slice(0, 60)} (from ${origin[n]})`);
    delete symbols[n]; delete origin[n];
}
// bdsx writes a 12-byte jump over every function it hooks. A target with no
// .pdata entry (a leaf, typically a few bytes) or under 16 bytes would have
// its neighbour overwritten, so hook targets of that shape are dropped from
// the table: better an event that never fires than a corrupted function.
const reqSyms = load("data/required-symbols.json").symbols;
const exe = `work/bin/${v}/bedrock_server.exe`;
// And a hook target must come from a source that is exact or execution-
// confirmed (HOOK_TRUST): a 90-95%-precise walk name is fine to *call* --
// a wrong call fails at the call -- but a hook on a wrong function corrupts
// that function for the whole process, which took the server down during
// level load on 1.26.40.8 with 16 such hooks installed.
const HOOK_TRUST = (process.env.HOOK_TRUST ?? "resolved,instances,packets,endstone-slots").split(",");
// a slot whose prototype changed since 1.21.3.01 (endstone-slots' shape check)
// keeps its address but is not hooked with bdsx's old prototype
const signatureChanged = new Set(load(`data/candidates-endstone-slots-${v}.json`)?.signatureChanged ?? []);
let droppedHooks = 0;
if (fs.existsSync(exe)) {
    const { functions, containing } = await import("./pdata.mjs");
    const fns = functions(exe);
    for (const s of reqSyms) {
        if (!(s.name in symbols) || !s.kinds.some(k => /hook|patch|write|nopping|jumping/.test(k))) continue;
        const f = containing(fns, symbols[s.name]);
        const sized = f && f.begin === symbols[s.name] && f.end - f.begin >= 16;
        // whatever supplied the address: a name whose prototype changed is never hooked under its 2024
        // decoration. Mob::_hurt came from `resolved`, execution-confirmed, and still killed the server at
        // the first hit, because it now returns a struct through a hidden pointer (docs/findings-slots.md)
        const trusted = HOOK_TRUST.includes(origin[s.name]) && !signatureChanged.has(s.name);
        if (sized && trusted) continue;
        console.log(`  dropped hook target ${s.name.slice(0, 60)} (${sized ? "" : (f ? f.end - f.begin + "B" : "no .pdata entry") + ", "}from ${origin[s.name]})`);
        delete symbols[s.name]; delete origin[s.name]; droppedHooks++;
    }
}
// A required name from a route that places by position or by call edges must at least take the arguments
// its 2024 namesake took (tools/slot-shape.mjs: which argument registers the first instructions read before
// writing). bdsx calls it with the 2024 prototype, so a function that reads a register the old one never
// read is either the wrong function or one whose signature changed, and unsafe to call in both cases:
// Actor::getRuntimeID from propagation read r8d; Mob::knockback under its 2024 name would be called with
// an int where a float and a struct pointer are expected. Measured 2026-09-19: 8 / 9 of ~210 such names.
// Results are cached by name and address (work/derived/shape-cache-<v>.json): each shape costs an llvm-mc run.
let shapeVetoed = 0;
const baseExe = "work/bin/1.21.3.01/bedrock_server.exe";
if (fs.existsSync(exe) && fs.existsSync(baseExe) && fs.existsSync("data/baseline-symbols.json")) {
    const { shape, compatible } = await import("./slot-shape.mjs");
    const base = load("data/baseline-symbols.json"); const bsyms = base.symbols ?? base;
    const cachePath = `work/derived/shape-cache-${v}.json`;
    const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
    for (const s of reqSyms) {
        const n = s.name;
        if (!(n in symbols) || n.startsWith("??_7") || ["resolved", "instances", "packets"].includes(origin[n]) || bsyms[n] === undefined) continue;
        const key = `${n}@${symbols[n]}`;
        if (cache[key] === undefined) { const a = shape(baseExe, bsyms[n]), b = shape(exe, symbols[n]); cache[key] = a === null || b === null ? true : compatible(a, b); }
        if (cache[key]) continue;
        console.log(`  shape veto ${n.slice(0, 70)} (0x${symbols[n].toString(16)} from ${origin[n]}): reads an argument the 2024 function never read`);
        delete symbols[n]; delete origin[n]; shapeVetoed++;
    }
    fs.mkdirSync("work/derived", { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(cache));
}
// and whatever Endstone's shape check already flagged (signatureChanged) is not callable under the old name either
for (const n of signatureChanged) if (n in symbols && !["resolved", "instances", "packets"].includes(origin[n])) { console.log(`  signature changed, not shipped under its 2024 name: ${n.slice(0, 70)}`); delete symbols[n]; delete origin[n]; shapeVetoed++; }
const req = reqSyms.map(s => s.name);
for (const n of Object.keys(accessors)) if (n in symbols) delete accessors[n];   // an address wins over an emitted body
for (const n of Object.keys(constants)) if (n in symbols) delete constants[n];   // ditto: real storage in this build beats our bytes
// a constant is data bdsx allocates, so there is nothing in the binary to hook:
// a name bdsx hooks or patches must never be served from here
for (const s2 of reqSyms) if (s2.name in constants && s2.kinds.some(k => /hook|patch|write|nopping|jumping/.test(k))) { console.log(`  dropped constant ${s2.name.slice(0, 60)}: bdsx hooks or patches it`); delete constants[s2.name]; }
console.log(`field accessors ${Object.keys(accessors).length} (${req.filter(n => n in accessors).length} required), constants ${Object.keys(constants).length} (${req.filter(n => n in constants).length} required)`);
fs.writeFileSync(out, JSON.stringify({ _comment: `Merged input for tools/make-table.mjs, by tools/merge-symbols.mjs: resolved > instances > packets > vftable walk > propagation > corroborated. ${Object.keys(symbols).length} names, ${req.filter(n => n in symbols).length} of bdsx's ${req.length} required.`, mainRva: resolved.mainRva, mainProvenance: resolved.mainProvenance, symbols, origin, layouts, accessors, constants, unresolved: resolved.unresolved }, null, 1));
const covered = req.filter(n => n in symbols).length;
const emitted = req.filter(n => !(n in symbols) && (n in accessors || n in constants)).length;
console.log(`total ${Object.keys(symbols).length} names, bdsx required covered ${covered}/${req.length} by address (+${emitted} emitted: ${covered + emitted} in all), conflicts ${conflicts}, hook targets dropped for size ${droppedHooks}, shape vetoes ${shapeVetoed} -> ${out}`);
