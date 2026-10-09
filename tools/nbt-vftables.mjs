/**
 * Find the twelve NBT tag vftables of a build (docs/findings-nbt.md).
 *
 * Anchor: the known `??_7CompoundTag@@6B@` of the build. In 1.21.3.01 (PDB) every tag vftable is
 * eleven slots and slot 8 is the shared `Tag::print(std::string const&, PrintStream&)`; slot 5 is
 * `getId`, whose body is the tag's type constant. So: every scanned table whose slot 8 equals
 * CompoundTag's slot 8, keyed by the constant its slot-5 body returns.
 *
 *   node tools/nbt-vftables.mjs <version>          prints type -> vftable, with each slot-5 body
 */
import * as fs from "fs";
import { loadPE, pdataFunctions } from "./pe.mjs";

const v = process.argv[2];
const scan = JSON.parse(fs.readFileSync(`work/vft/scan-${v}.json`, "utf8")).vftables;
const merged = v === "1.21.3.01" ? {} : JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8"));
const pe = loadPE(`work/bin/${v}/bedrock_server.exe`);
let compound = merged.symbols?.["??_7CompoundTag@@6B@"];
if (process.argv[3]) compound = parseInt(process.argv[3], 16);
const anchor = scan.find(t => t.rva === compound);
if (!anchor) throw Error(`CompoundTag vftable 0x${compound?.toString(16)} not in the scan`);
const print2 = anchor.slots[8];
const names = ["End", "Byte", "Short", "Int", "Int64", "Float", "Double", "ByteArray", "String", "List", "Compound", "IntArray"];
const bytes = rva => pe.buf.subarray(pe.off(rva), pe.off(rva) + 8);
/** getId bodies: `mov al, imm8; ret` (b0 NN c3) or `mov eax, imm32; ret` (b8 NN 00 00 00 c3). */
function constOf(rva) {
    const b = bytes(rva);
    if (b[0] === 0xb0 && b[2] === 0xc3) return b[1];
    if (b[0] === 0xb8 && b[5] === 0xc3) return b.readUInt32LE(1);
    if (b[0] === 0x32 && b[1] === 0xc0 && b[2] === 0xc3) return 0; // xor al, al
    if ((b[0] === 0x33 || b[0] === 0x31) && b[1] === 0xc0 && b[2] === 0xc3) return 0; // xor eax, eax (either encoding)
    return null;
}
const hits = scan.filter(t => t.slots.length >= 11 && t.slots[8] === print2);
const out = {};
for (const t of hits) {
    const id = constOf(t.slots[5]);
    const tag = id != null && names[id] ? names[id] + "Tag" : "?";
    console.log(tag.padEnd(14), "0x" + t.rva.toString(16), "slots", t.slots.length, "getId 0x" + t.slots[5].toString(16), Buffer.from(bytes(t.slots[5])).toString("hex"));
    if (tag !== "?") (out[tag] ??= []).push(t.rva);
}
for (const n of names) if (!out[n + "Tag"]) console.log("MISSING", n + "Tag");
for (const [k, r] of Object.entries(out)) if (r.length > 1) console.log("AMBIGUOUS", k, r.map(x => "0x" + x.toString(16)).join(" "));

// Route 2: functions that load (lea) ten or more of these tables -- Tag::newTag(Type), a switch over the type that
// allocates each tag and stores its vftable. Printed as the order the stores appear in, with the constant the
// preceding `cmp`/case compares against being read by hand (disas-exact) -- the point is an independent type->table map.
{
    const want = new Map(); for (const [k, r] of Object.entries(out)) want.set(r[0], k);
    const { buf, text } = pe;
    const users = new Map();
    const end = text.rawPtr + text.rawSize - 7;
    for (let p = text.rawPtr; p < end; p++) {
        if ((buf[p] & 0xf8) !== 0x48 || buf[p + 1] !== 0x8d || (buf[p + 2] & 0xc7) !== 0x05) continue;
        const at = text.rva + (p - text.rawPtr);
        const t = at + 7 + buf.readInt32LE(p + 3);
        if (!want.has(t)) continue;
        const f = fnStart(at);
        if (f == null) continue;
        if (!users.has(f)) users.set(f, []);
        users.get(f).push([at, want.get(t)]);
    }
    for (const [f, l] of users) {
        const kinds = new Set(l.map(x => x[1]));
        if (kinds.size >= 10) console.log(`route2: 0x${f.toString(16)} loads ${kinds.size} tag vftables:`, l.map(([a, k]) => `${k}@0x${a.toString(16)}`).join(" "));
    }
}
function fnStart(rva) {
    fnStart.f ??= pdataSorted();
    const fs_ = fnStart.f; let lo = 0, hi = fs_.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (fs_[m].begin <= rva) lo = m + 1; else hi = m - 1; }
    return fs_[hi] && rva < fs_[hi].end ? fs_[hi].begin : null;
}
function pdataSorted() { return pdataFunctions(pe); }
