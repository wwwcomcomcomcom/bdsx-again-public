/**
 * Veto a (baseline function, target function) pairing whose bodies cannot be
 * the same signature.
 *
 * The vftable walk and the call-edge pairs both place names by position, and
 * an equal-length gap between anchors can still be reordered or refilled: on
 * 1.26.40.8 the six ServerLevel slots between getSleepStatus and
 * getDefaultSpawn hold the right count of functions in a different order, and
 * neither table counts nor call edges can tell. The body can. Which argument
 * registers a function reads before writing them (rdx, r8, r9, xmm1..3) and
 * how it returns (ret / tail jump; last width written to rax) come from the
 * first instructions with no analysis, and `getTime` -- no arguments -- is
 * not a function that reads edx.
 *
 * A pairing is vetoed when the target reads an argument register the
 * baseline never reads. Precision is measured before use: applied to pairings
 * already checked by execution the rule must veto none; applied to the walk
 * names it reports how many it would veto.
 *
 * Usage:
 *   node tools/slot-shape.mjs <baselineExe> <targetExe> <pairs-as-names.json> [--verbose]
 *     pairs-as-names.json: { symbols: { decoratedName: targetRva } }, names resolved
 *     on the baseline through data/baseline-symbols.json
 */
import * as fs from "fs";
import { disas } from "./disas.mjs";
import { pathToFileURL } from "url";

// "%" is not a word character, so \b cannot anchor the register name
const REG = { rdx: /(?:^|[^\w])%(rdx|edx|dx|dl)\b/, r8: /(?:^|[^\w])%r8[dwb]?\b/, r9: /(?:^|[^\w])%r9[dwb]?\b/, xmm1: /(?:^|[^\w])%xmm1\b/, xmm2: /(?:^|[^\w])%xmm2\b/, xmm3: /(?:^|[^\w])%xmm3\b/ };
const WRITES = /^(mov|lea|xor|pop|cvt|movs|movz|movd|movq|movaps|movups|movss|movsd|set)/;

/** The shape of a function from its first instructions. */
export function shape(exe, rva, max = 96) {
    let ins;
    try { ins = disas(exe, rva, 400); } catch { return null; }
    const read = new Set(), written = new Set();
    let ret = "?", lastRax = "", complete = false;
    for (let k = 0; k < Math.min(ins.length, max); k++) {
        const t = ins[k].text.replace(/\s+/g, " ").trim();
        const mn = t.split(" ")[0];
        const ops = t.slice(mn.length).trim();
        // AT&T: src, dst -- split at the last comma outside parentheses
        let depth = 0, cut = -1;
        for (let i = ops.length - 1; i >= 0; i--) { const c = ops[i]; if (c === ")") depth++; else if (c === "(") depth--; else if (c === "," && depth === 0) { cut = i; break; } }
        const src = cut < 0 ? ops : ops.slice(0, cut), dst = cut < 0 ? "" : ops.slice(cut + 1);
        const twoOp = cut >= 0;
        for (const [name, re] of Object.entries(REG)) {
            if (written.has(name)) continue;
            const inSrc = re.test(src), inDstMem = re.test(dst) && /\(/.test(dst);
            const inDstReg = twoOp && re.test(dst) && !/\(/.test(dst);
            if (inSrc || inDstMem || (!twoOp && re.test(ops) && !WRITES.test(mn))) read.add(name);
            else if (inDstReg && WRITES.test(mn) && !(mn.startsWith("xor") && src === dst)) written.add(name);
            else if (inDstReg && mn.startsWith("xor") && src === dst) written.add(name);
        }
        if (/%(eax|rax|al|ax)\b/.test(dst) || (/^(xor|cvt|set)/.test(mn) && /%(eax|rax|al)\b/.test(ops))) lastRax = /%rax/.test(dst) ? "rax" : /%eax/.test(dst) ? "eax" : /%al\b/.test(dst) || /%al\b/.test(ops) ? "al" : "ax";
        if (mn === "retq") { ret = "ret"; complete = true; break; }
        if (/^jmp/.test(mn)) { ret = "tail"; complete = true; break; }
        // a conditional branch means the other path may read what this one
        // does not: the set is no longer known to be complete
        if (/^j/.test(mn)) { ret = "branch"; break; }
        // a call clobbers the argument registers, so a later read of one is
        // preceded by a write of it; the first-read set is complete once every
        // register is written, or at the function's end
        // (__chkstk -- `movl $N, %eax; callq __chkstk; subq %rax, %rsp` -- clobbers nothing)
        const chkstk = /^callq/.test(mn) && k > 0 && /^movl \$\d+, %eax$/.test(ins[k - 1].text.replace(/\s+/g, " ").trim()) && k + 1 < ins.length && /^subq %rax, %rsp$/.test(ins[k + 1].text.replace(/\s+/g, " ").trim());
        if (/^callq/.test(mn) && !chkstk) { for (const name of Object.keys(REG)) written.add(name); }
        if (Object.keys(REG).every(n => written.has(n) || read.has(n))) { ret = ret === "?" ? "call" : ret; complete = true; break; }
    }
    return { args: [...read].sort().join(","), ret, lastRax, complete };
}

export function compatible(a, b) {
    if (!a || !b) return true;   // unreadable: no opinion
    // the target reading an argument register the baseline never reads is a
    // different signature; the reverse is not held against it, since a read
    // the baseline makes early the target may make later or not at all
    // ...and only when the baseline's set is complete: read on a path with no
    // conditional branch before every argument register was read or clobbered.
    // Player::_shouldProvideFeedbackOnArmorSet reads its arguments only after
    // a branch on a field of `this`, and a linear scan would call it argless.
    if (!a.complete) return true;
    const A = new Set(a.args.split(",").filter(Boolean));
    for (const r of b.args.split(",").filter(Boolean)) if (!A.has(r)) return false;
    // ret vs tail jump is codegen, not signature (Level::getStructureManager
    // is a ret on 1.21.3.01 and a tail jump on 1.26.40.8), and so is the
    // width of the last write to rax: on void functions it is incidental and
    // vetoed 666 walk names that agree on everything else. Only the argument
    // registers are held against a pairing.
    return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const [baseExe, targetExe, pairFile] = process.argv.slice(2);
    const verbose = process.argv.includes("--verbose");
    const full = JSON.parse(fs.readFileSync("data/baseline-symbols.json", "utf8")).symbols;
    const symbols = JSON.parse(fs.readFileSync(pairFile, "utf8")).symbols;
    let ok = 0, veto = 0, skipped = 0;
    const vetoed = [];
    for (const [n, t] of Object.entries(symbols)) {
        const b = full[n];
        if (b === undefined || typeof t !== "number" || n.startsWith("??_7")) { skipped++; continue; }
        const sa = shape(baseExe, b), sb = shape(targetExe, t);
        if (compatible(sa, sb)) ok++;
        else { veto++; vetoed.push({ n, b, t, sa, sb }); }
    }
    console.log(`compatible ${ok}, vetoed ${veto}, skipped ${skipped}`);
    for (const v of vetoed.slice(0, verbose ? 1e9 : 25)) console.log(`  veto ${v.n.slice(0, 70)} base 0x${v.b.toString(16)} [${v.sa.args}|${v.sa.ret}|${v.sa.lastRax}] target 0x${v.t.toString(16)} [${v.sb.args}|${v.sb.ret}|${v.sb.lastRax}]`);
}
