/**
 * Where the LLVM command-line tools are (llvm-mc, llvm-objdump, llvm-undname).
 *
 * The disassembly tools and merge-symbols.mjs's argument-shape check need them. Looked up in order:
 * $LLVM_BIN, the default Windows install (`winget install LLVM.LLVM`), Homebrew's keg (macOS: Apple's
 * own llvm-objdump will not read these binaries), then PATH. A missing tool ends the process with a
 * message that says how to install it, rather than a spawn error.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const exe = process.platform === "win32" ? ".exe" : "";
const dirs = [
    process.env.LLVM_BIN,
    "C:\\Program Files\\LLVM\\bin",
    "/opt/homebrew/opt/llvm/bin",
    "/usr/local/opt/llvm/bin",
].filter(Boolean);
const found = new Map();

export function llvm(tool) {
    if (found.has(tool)) return found.get(tool);
    let p = dirs.map(d => path.join(d, tool + exe)).find(f => fs.existsSync(f));
    if (!p) {
        if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error) {
            console.error(`${tool} not found: install LLVM (Windows: winget install LLVM.LLVM; macOS: brew install llvm) or set LLVM_BIN to its bin directory`);
            process.exit(2);
        }
        p = tool; // on PATH
    }
    found.set(tool, p);
    return p;
}
