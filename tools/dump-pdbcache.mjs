/**
 * Milestone 1b — dump bdsx's pdbcache.bin to a flat, versioned JSON snapshot.
 *
 * pdbcache.bin is not a PDB: it is bdsx's own derived open-addressed hashmap of
 * decorated name -> RVA, produced once per BDS release by pdbcachegen.exe while
 * bedrock_server.pdb still shipped. Layout mirrors bdsx/pdbcache.ts:
 *
 *   u32 version | u8[16] md5(bedrock_server.exe) | u32 mainRva | u32 capacity
 *   { u32 hash, u32 nameOffset, u32 rva } * capacity
 *   utf8 null-terminated names
 */
import * as fs from "fs";
import * as path from "path";

const IN = process.argv[2];
const OUT = process.argv[3] ?? "data/baseline-symbols.json";
const BDS_VERSION = process.argv[4] ?? "unknown";
if (!IN) {
    console.error("usage: dump-pdbcache.mjs <pdbcache.bin> [out.json] [bdsVersion]");
    process.exit(2);
}

const buf = fs.readFileSync(IN);
const version = buf.readUInt32LE(0);
const md5 = buf.subarray(4, 20).toString("hex");
const mainRva = buf.readUInt32LE(20);
const capacity = buf.readUInt32LE(24);

const TABLE_OFFSET = 28;
const ENTRY_SIZE = 12;
const namesOffset = TABLE_OFFSET + ENTRY_SIZE * capacity;

const symbols = {};
let used = 0;
for (let i = 0; i < capacity; i++) {
    const off = TABLE_OFFSET + i * ENTRY_SIZE;
    const nameOffset = buf.readUInt32LE(off + 4);
    if (nameOffset === 0) continue;
    const end = buf.indexOf(0, nameOffset);
    symbols[buf.subarray(nameOffset, end).toString("utf8")] = buf.readUInt32LE(off + 8);
    used++;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
    OUT,
    JSON.stringify({ source: path.basename(IN), cacheFormatVersion: version, bdsVersion: BDS_VERSION, exeMd5: md5, mainRva, capacity, count: used, symbols }) + "\n",
);

console.log(`cache format v${version}  md5(bedrock_server.exe)=${md5}`);
console.log(`mainRva=0x${mainRva.toString(16)}  capacity=${capacity}  entries=${used} (load ${(used / capacity * 100).toFixed(1)}%)`);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
