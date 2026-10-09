/**
 * Emit the minimal pdbcache.bin that bdsx-core's native bootstrap needs.
 *
 * bdsx-core does not read the symbol table before handing control to JS. At
 * startup main.cpp reads exactly sizeof(PdbCacheHeader) -- 28 bytes -- and
 * uses it for three things: reject a mismatched format version, check the MD5
 * against the running bedrock_server.exe, and hook `main` at
 * GetModuleHandle(nullptr) + mainRva. The hashmap that follows is only ever
 * read from JS, which now goes through symbols.json instead.
 *
 * So the whole native dependency reduces to one address: main.
 *
 *   struct PdbCacheHeader {
 *       uint32_t version;        // must be 1
 *       byte     md5[16];        // of bedrock_server.exe
 *       uint32_t mainRva;
 *       uint32_t hashMapCapacity;
 *   };
 */
import * as fs from "fs";
import * as crypto from "crypto";

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const i = a.indexOf("=");
        return i < 0 ? [a.replace(/^--/, ""), true] : [a.slice(2, i), a.slice(i + 1)];
    }),
);
if (!args.exe || !args.mainRva) {
    console.error("usage: make-pdbcache-stub.mjs --exe=<bedrock_server.exe> --mainRva=0x... [--out=pdbcache.bin]");
    process.exit(2);
}

const out = args.out ?? "work/pdbcache.bin";
const mainRva = Number(args.mainRva);
// --md5 lets the stub target a binary that only exists on the other host,
// e.g. one PeEditor has patched to import PreLoader.
const md5 = args.md5
    ? Buffer.from(args.md5, "hex")
    : crypto.createHash("md5").update(fs.readFileSync(args.exe)).digest();

const buf = Buffer.alloc(28);
buf.writeUInt32LE(1, 0);
md5.copy(buf, 4);
buf.writeUInt32LE(mainRva, 20);
buf.writeUInt32LE(0, 24); // empty hashmap; the JS side reads symbols.json
fs.writeFileSync(out, buf);

console.log(`${out}: version 1, md5 ${md5.toString("hex")}, mainRva 0x${mainRva.toString(16)}, capacity 0`);
