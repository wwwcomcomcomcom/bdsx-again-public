/**
 * Exact-length disassembly of a PE range, with call/jump/rip targets named from our tables.
 *
 * tools/disas.mjs counts addresses with the length of the instruction llvm-mc *re-encodes*,
 * which is shorter than the original whenever the compiler padded with redundant prefixes
 * (`66 2e 0f 1f 84 00 ...` comes back as a 6-byte nopw) -- every address after the first such
 * instruction drifts, and branch targets land mid-instruction (docs/findings-packets.md). This
 * wraps the original bytes in an object file (`.byte` through llvm-mc -filetype=obj) and reads
 * it with llvm-objdump --adjust-vma, so each address is where the byte actually is.
 *
 *   node tools/disas-exact.mjs <version> <rva> [len]     (len defaults to the .pdata function)
 *
 * Names: data/merged-<v>.json for a 1.26 build, data/baseline-symbols.json for 1.21.3.01
 * (the first run for a version writes work/names-<v>.json, an rva -> name cache).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { functions, containing } from "./pdata.mjs";
import { readRva } from "./disas.mjs";
import { llvm } from "./llvm.mjs";

const [v, rvaS, lenS] = process.argv.slice(2);
if (!v || !rvaS) {
    console.error("usage: node tools/disas-exact.mjs <version> <rva> [len]");
    process.exit(2);
}
const exe = `work/bin/${v}/bedrock_server.exe`;
const rva = Number(rvaS);

function loadNames() {
    const cache = `work/names-${v}.json`;
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
    const names = {};
    if (v === "1.21.3.01") {
        const b = JSON.parse(fs.readFileSync("data/baseline-symbols.json", "utf8"));
        for (const [n, r] of Object.entries(b.symbols ?? b)) if (typeof r === "number" && (!(r in names) || n.startsWith("?"))) names[r] = n;
    } else {
        for (const [n, r] of Object.entries(JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8")).symbols)) names[r] = n;
    }
    fs.writeFileSync(cache, JSON.stringify(names));
    return names;
}
const names = loadNames();
const len = lenS ? Number(lenS) : containing(functions(exe), rva).end - rva;
const bytes = readRva(exe, rva, len);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "disas-exact-"));
const lines = [".text"];
for (let i = 0; i < bytes.length; i += 32) lines.push(".byte " + [...bytes.subarray(i, i + 32)].join(","));
fs.writeFileSync(`${tmp}/d.s`, lines.join("\n") + "\n");
execFileSync(llvm("llvm-mc"), ["-filetype=obj", "-triple=x86_64-pc-linux", "-o", `${tmp}/d.o`, `${tmp}/d.s`]);
const out = execFileSync(llvm("llvm-objdump"), ["-d", "--no-show-raw-insn", `--adjust-vma=0x${rva.toString(16)}`, `${tmp}/d.o`], { maxBuffer: 1 << 28 }).toString();
fs.rmSync(tmp, { recursive: true });

const insns = out.split("\n").filter(l => /^\s+[0-9a-f]+:/.test(l));
for (let i = 0; i < insns.length; i++) {
    let l = insns[i].replace(/<\.text\+0x[0-9a-f]+>/, "").replace(/\s+$/, "");
    const br = l.match(/\b(call\w*|j\w+)\s+0x([0-9a-f]+)/);
    if (br && names[parseInt(br[2], 16)]) l += "   ; " + names[parseInt(br[2], 16)].slice(0, 140);
    const rip = l.match(/(-?0x[0-9a-f]+)\(%rip\)/);
    if (rip && insns[i + 1]) {
        const target = parseInt(insns[i + 1], 16) + parseInt(rip[1], 16);
        l = l.replace(/\s+# 0x[0-9a-f]+/, "") + `  [=0x${target.toString(16)}${names[target] ? " " + names[target].slice(0, 100) : ""}]`;
    }
    console.log(l);
}
