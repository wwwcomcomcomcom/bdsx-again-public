/**
 * Extract the static const data members bdsx reads through `proc[...]` and
 * ship them as bytes rather than as addresses (docs/findings-layouts.md,
 * "Constants").
 *
 * These names are not functions and not fields: `?ZERO@Vec3@@2V1@B` and its
 * kin are read-only storage that the compiler is free to fold, inline as an
 * immediate or drop entirely. In 1.21.3.01 eleven of the twelve Vec3
 * constants sit in one .rdata block at 0x2eef3c8, 16 bytes apart; in
 * 1.26.40.8 and 1.26.51.1 that block -- and every padded or unpadded variant
 * of it -- is gone, so there is no address to find. Endstone reached the same
 * conclusion from the other side: its symbol table holds no Vec3 name at all
 * and it defines `Vec3::ZERO` in its own binary.
 *
 * bdsx only ever reads through these pointers, so any address holding the
 * right bytes is correct. This reads the bytes from the last build that
 * shipped a PDB and writes them to data/constants.json, which is
 * build-independent: the value of ONE is (1,1,1) in every build.
 *
 * Two gates, both measured rather than assumed:
 *   1. width -- from bdsx's own @nativeClass for the type, which is exactly
 *      how many bytes bdsx will read through the pointer;
 *   2. no relocation inside the range -- a constant holding an address (a
 *      vftable pointer, a std::string body) is build-specific and must not be
 *      carried across. That gate is what rejects ItemStack::EMPTY_ITEM.
 * A third check is human: the decoded value must mean what the name says.
 *
 * Usage: node tools/extract-constants.mjs [--exe=work/bin/1.21.3.01/bedrock_server.exe]
 *                                         [--symbols=data/baseline-symbols.json]
 *                                         [--out=data/constants.json]
 */
import * as fs from "fs";

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const i = a.indexOf("=");
        return i < 0 ? [a.replace(/^--/, ""), true] : [a.slice(2, i), a.slice(i + 1)];
    }),
);
const exePath = args.exe ?? "work/bin/1.21.3.01/bedrock_server.exe";
const symbolsPath = args.symbols ?? "data/baseline-symbols.json";
const out = args.out ?? "data/constants.json";

// name -> what bdsx does with the pointer. `size` is the size of the bdsx
// @nativeClass, i.e. the bytes bdsx can read; `fmt` only decodes for review.
const f32 = (b, o) => b.readFloatLE(o);
const i32 = (b, o) => b.readInt32LE(o);
const FAMILIES = [
    {
        cls: "Vec3", size: 12, mangle: n => `?${n}@Vec3@@2V1@B`, site: "bdsx/bds/blockpos.ts",
        fmt: b => [0, 4, 8].map(o => f32(b, o)).join(", "),
        names: ["ZERO", "ONE", "TWO", "HALF", "MIN", "MAX", "UNIT_X", "UNIT_Y", "UNIT_Z", "NEG_UNIT_X", "NEG_UNIT_Y", "NEG_UNIT_Z"],
    },
    {
        cls: "BlockPos", size: 12, mangle: n => `?${n}@BlockPos@@2V1@B`, site: "bdsx/bds/blockpos.ts",
        fmt: b => [0, 4, 8].map(o => i32(b, o)).join(", "),
        names: ["ZERO", "ONE", "MIN", "MAX"],
    },
    {
        cls: "ActorUniqueID", size: 8, mangle: () => "?INVALID_ID@ActorUniqueID@@2U1@B", site: "bdsx/bds/actor.ts",
        fmt: b => "0x" + b.toString("hex").match(/../g).reverse().join(""),
        names: ["INVALID_ID"],
    },
    {
        // @nativeClass ScoreboardId is bin64_t id + IdentityDefinition.ref() = 16 bytes, and
        // ScoreboardId::isValid compares this->id against the id half of exactly this object
        cls: "ScoreboardId", size: 16, mangle: () => "?INVALID@ScoreboardId@@2U1@A", site: "bdsx/bds/scoreboard.ts",
        fmt: b => `id 0x${b.subarray(0, 8).toString("hex").match(/../g).reverse().join("")}, identityDef 0x${b.subarray(8).toString("hex").match(/../g).reverse().join("")}`,
        names: ["INVALID"],
    },
];
// Deliberately not extracted:
//   ?CurrentVersion@CommandVersion@@2HB  -- a version number, different in
//     every build; bdsx reads it through procConst with a default instead.
//   ?EMPTY_ITEM@ItemStack@@2V1@B, ?Invalid@IdentityDefinition@@2V1@B,
//   ?INVALID_ABILITY@Abilities@@2VAbility@@A
//     -- objects with pointers or strings inside; the relocation gate below
//     is what decides, and they are reported as rejected rather than shipped.
const REJECT_PROBE = [
    ["?EMPTY_ITEM@ItemStack@@2V1@B", 0x90],
    // IdentityDefinition is an AbstractClass in bdsx: no width, so no constant
    ["?Invalid@IdentityDefinition@@2V1@B", 0x40],
    ["?INVALID_ABILITY@Abilities@@2VAbility@@A", 0x20],
];

function pe(path) {
    const b = fs.readFileSync(path);
    const e = b.readUInt32LE(0x3c);
    const nsec = b.readUInt16LE(e + 6);
    const optSize = b.readUInt16LE(e + 20);
    const opt = e + 24;
    const secs = [];
    for (let i = 0; i < nsec; i++) {
        const o = opt + optSize + i * 40;
        secs.push({
            name: b.toString("ascii", o, o + 8).replace(/\0+$/, ""),
            va: b.readUInt32LE(o + 12), vsz: b.readUInt32LE(o + 8),
            ptr: b.readUInt32LE(o + 20), rawSize: b.readUInt32LE(o + 16),
        });
    }
    // data directory 5 is .reloc
    const dirs = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96);
    const reloc = { va: b.readUInt32LE(dirs + 5 * 8), size: b.readUInt32LE(dirs + 5 * 8 + 4) };
    return { b, secs, reloc };
}
const fileOffset = (p, rva) => {
    const s = p.secs.find(s => rva >= s.va && rva < s.va + Math.max(s.vsz, s.rawSize));
    if (!s) return { off: null, why: "no section" };
    if (rva - s.va >= s.rawSize) return { off: null, why: `past the raw data of ${s.name} (loader zero-fill)` };
    return { off: s.ptr + (rva - s.va), sec: s.name };
};

/** every RVA the loader will patch; a constant overlapping one holds an address */
function relocations(p) {
    const set = new Set();
    if (!p.reloc.size) return set;
    const { off } = fileOffset(p, p.reloc.va);
    let cur = off;
    const end = off + p.reloc.size;
    while (cur + 8 <= end) {
        const pageRva = p.b.readUInt32LE(cur);
        const blockSize = p.b.readUInt32LE(cur + 4);
        if (blockSize < 8) break;
        for (let i = cur + 8; i + 2 <= cur + blockSize; i += 2) {
            const e = p.b.readUInt16LE(i);
            const type = e >> 12;
            if (type === 0) continue; // ABSOLUTE: padding
            const rva = pageRva + (e & 0xfff);
            // a 64-bit relocation covers 8 bytes
            for (let k = 0; k < 8; k++) set.add(rva + k);
        }
        cur += blockSize;
    }
    return set;
}

const p = pe(exePath);
const relocs = relocations(p);
console.log(`${exePath}: ${p.secs.length} sections, ${relocs.size / 8} relocations`);
const table = JSON.parse(fs.readFileSync(symbolsPath, "utf8"));
const baseline = table.symbols ?? table;
const buildName = /(\d+\.\d+[\d.]*)/.exec(exePath)?.[1] ?? "the baseline build";
const required = new Set(JSON.parse(fs.readFileSync("data/required-symbols.json", "utf8")).symbols.map(s => s.name));

const constants = {};
const rejected = {};
function extract(name, size, fmt, cls, site) {
    const rva = baseline[name];
    if (typeof rva !== "number") return void (rejected[name] = "not in the baseline table");
    for (let k = 0; k < size; k++) if (relocs.has(rva + k)) return void (rejected[name] = `holds a relocated address at +${k}: build-specific, not a value`);
    const { off, why } = fileOffset(p, rva);
    let bytes, via;
    if (off === null) {
        if (!/zero-fill/.test(why ?? "")) return void (rejected[name] = why ?? "unmapped");
        bytes = Buffer.alloc(size); // the loader maps it as zeros; that is the value
        via = `zero-filled by the loader (0x${rva.toString(16)} is past the raw data of its section)`;
    } else {
        bytes = p.b.subarray(off, off + size);
        via = `read at RVA 0x${rva.toString(16)} of BDS ${buildName}`;
    }
    constants[name] = { bytes: bytes.toString("hex"), size, type: cls, value: fmt(bytes), via, site, required: required.has(name) };
}
for (const fam of FAMILIES) for (const n of fam.names) extract(fam.mangle(n), fam.size, fam.fmt, fam.cls, fam.site);
for (const [name, probe] of REJECT_PROBE) {
    const rva = baseline[name];
    if (typeof rva !== "number") { rejected[name] = "not in the baseline table"; continue; }
    let hit = -1;
    for (let k = 0; k < probe && hit < 0; k++) if (relocs.has(rva + k)) hit = k;
    rejected[name] = hit >= 0 ? `holds a relocated address at +${hit}: build-specific, not a value` : "no relocation in the first " + probe + " bytes, but bdsx's width for it is not established; left out";
}

const width = Math.max(...Object.keys(constants).map(n => n.length));
for (const [n, c] of Object.entries(constants)) console.log(`  ${n.padEnd(width)}  ${c.value.padEnd(28)} ${c.required ? "" : "(not required by bdsx)"}`);
for (const [n, why] of Object.entries(rejected)) console.log(`  rejected ${n.slice(0, 48)}: ${why}`);

fs.writeFileSync(out, JSON.stringify({
    _comment: "Static const data members shipped as bytes, not addresses (tools/extract-constants.mjs, docs/findings-layouts.md). Build-independent: the value of Vec3::ONE is (1,1,1) in every build, and the compiler no longer keeps storage for these in 1.26.",
    generatedFrom: `${exePath} (BDS ${buildName}, the last build with a PDB)`,
    generatedAt: new Date().toISOString(),
    constants,
    rejected,
}, null, 1) + "\n");
console.log(`${Object.keys(constants).length} constants (${Object.values(constants).filter(c => c.required).length} required by bdsx), ${Object.keys(rejected).length} rejected -> ${out}`);
