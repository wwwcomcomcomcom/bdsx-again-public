/**
 * Functions that look up an EnTT component, found by the component's type hash.
 *
 * 1.26 turned most Actor getters into component lookups, which is why call-edge propagation misplaces them
 * and why they no longer resemble their 2024 bodies. But the lookup carries its own label: the storage is
 * keyed by entt::type_hash, which in these builds is FNV-1a (32-bit) of the bare type name --
 * fnv1a("ActorTypeComponent") = 0x4F6BA419, the constant Actor::hasType masks and compares with. So the
 * functions that touch component X are exactly those containing fnv1a("X") as an immediate, and among
 * them the getter is picked by shape (arguments read, size, what it returns) and by agreement between
 * the two builds (docs/findings-components.md).
 *
 * Usage: node tools/component-hash.mjs <version> <ComponentName> [--max=400] [--near=0xRVA]
 *   lists every .pdata function containing the hash, smallest first, with any name the merged table has
 */
import * as fs from "fs";
import { functions } from "./pdata.mjs";
import { pathToFileURL } from "url";
export const fnv1a = s => { let h = 0x811c9dc5; for (const c of Buffer.from(s)) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
const sectionCache = new Map();
function textOf(exe) {
    if (sectionCache.has(exe)) return sectionCache.get(exe);
    const buf = fs.readFileSync(exe); const pe = buf.readUInt32LE(0x3c), ns = buf.readUInt16LE(pe + 6), sh = pe + 24 + buf.readUInt16LE(pe + 20);
    let t = null; for (let i = 0; i < ns; i++) { const o = sh + i * 40; if (buf.toString("latin1", o, o + 5) === ".text") t = { va: buf.readUInt32LE(o + 12), raw: buf.readUInt32LE(o + 20), size: buf.readUInt32LE(o + 16) }; }
    const r = { buf, t }; sectionCache.set(exe, r); return r;
}
/** RVAs of the functions containing `hash` as a little-endian dword, with the number of occurrences */
export function usersOf(exe, fns, hash) {
    const { buf, t } = textOf(exe); const pat = Buffer.alloc(4); pat.writeUInt32LE(hash);
    const hits = new Map(); let i = t.raw; const end = t.raw + t.size;
    // .pdata is sorted: binary search for the containing function
    const find = rva => { let lo = 0, hi = fns.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (fns[mid].begin > rva) hi = mid - 1; else if (fns[mid].end <= rva) lo = mid + 1; else return fns[mid]; } return null; };
    while ((i = buf.indexOf(pat, i)) !== -1 && i < end) { const e = find(i - t.raw + t.va); if (e) hits.set(e.begin, (hits.get(e.begin) ?? 0) + 1); i += 1; }
    return hits;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const [v, comp, ...rest] = process.argv.slice(2);
    const max = Number(rest.find(a => a.startsWith("--max="))?.slice(6) ?? 400);
    const exe = `work/bin/${v}/bedrock_server.exe`; const fns = functions(exe).slice().sort((a, b) => a.begin - b.begin);
    const hash = fnv1a(comp); const hits = usersOf(exe, fns, hash);
    const m = JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8")); const by = new Map(); for (const [n, r] of Object.entries(m.symbols)) (by.get(r) ?? by.set(r, []).get(r)).push(n);
    const rows = [...hits].map(([b, c]) => { const e = fns.find(x => x.begin === b); return [b, e.end - e.begin, c]; }).sort((a, b) => a[1] - b[1]);
    console.log(`${v}: fnv1a("${comp}") = 0x${hash.toString(16)}: ${rows.length} functions`);
    for (const [b, size, c] of rows) if (size <= max) console.log(`  0x${b.toString(16).padEnd(8)} ${String(size).padStart(5)}B x${c} ${(by.get(b) ?? []).map(n => n.slice(0, 70) + " [" + m.origin[n] + "]").join(" | ")}`);
}
