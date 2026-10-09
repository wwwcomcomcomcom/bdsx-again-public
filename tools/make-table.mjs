/**
 * Emit a symbols.json for a given BDS build.
 *
 * With no resolved symbols this produces the empty-but-valid table Milestone 0
 * needs: bdsx-core still attaches and every lookup fails cleanly, which is
 * exactly the experiment -- if the process reaches "Symbol not found" the
 * takeover machinery works, and if it dies before that the real first problem
 * is not symbols at all.
 */
import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const i = a.indexOf("=");
        return i < 0 ? [a.replace(/^--/, ""), true] : [a.slice(2, i), a.slice(i + 1)];
    }),
);

if (!args.exe || !args.bdsVersion) {
    console.error("usage: make-table.mjs --exe=<bedrock_server.exe> --bdsVersion=<x.y.z.w> [--symbols=<resolved.json>] [--out=<symbols.json>]");
    process.exit(2);
}

// --md5 lets the table target a binary that only exists on the other host,
// e.g. one PeEditor has patched to import PreLoader.
const exeMd5 = args.md5 ?? crypto.createHash("md5").update(fs.readFileSync(args.exe)).digest("hex");
const resolved = args.symbols ? JSON.parse(fs.readFileSync(args.symbols, "utf8")) : {};
const symbols = resolved.symbols ?? resolved;
const unresolved = resolved.unresolved ?? {};

const out = args.out ?? "data/symbols.json";
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
    out,
    JSON.stringify(
        {
            formatVersion: 1,
            bdsVersion: args.bdsVersion,
            exeMd5,
            generator: "bdsx-again/tools/make-table.mjs",
            generatedAt: new Date().toISOString(),
            symbols,
            unresolved,
            layouts: resolved.layouts ?? {},
            accessors: resolved.accessors ?? {},
            constants: resolved.constants ?? {},
        },
        null,
        1,
    ) + "\n",
);

console.log(`${out}: BDS ${args.bdsVersion}  md5 ${exeMd5}  ${Object.keys(symbols).length} resolved, ${Object.keys(unresolved).length} explicitly unresolved`);
