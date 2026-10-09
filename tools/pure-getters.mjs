/**
 * List the slots of a vftable whose body is a pure getter, so a launcher can
 * call every one of them on the live server and match the values to what
 * they must be (docs/findings-slots.md, "by behaviour").
 *
 * Two shapes are recognised, from the first instructions with no analysis:
 *   direct:   [sub rsp] ; mov rax,[rcx] ; mov rax,[rax+8*S] ; call guard  (a
 *             virtual call through slot S of `this`, e.g. getLevelData) ;
 *             then a load from [rax+D] into eax/al/ax/rax ; ret
 *   lookup:   the same virtual call ; lea rdx,[rip+key] ; call F ; a tag
 *             compare `cmp byte [rax+32], T` ; a load from [rax] ; ret
 * plus the trivial `mov eax,[rcx+D] ; ret`. Anything that reads an argument
 * register, stores to memory, or calls more than the getter's own two
 * callees is not pure and is skipped.
 *
 * Output: { table, slots: [{ slot, rva, shape, via, width, tag, key, disp }] }
 *
 * Usage: node tools/pure-getters.mjs <exe> <scan.json> <tableRva> <out.json>
 */
import * as fs from "fs";
import { disas } from "./disas.mjs";

const [exe, scanPath, tableRvaStr, out] = process.argv.slice(2);
const tableRva = Number(tableRvaStr);
const scan = JSON.parse(fs.readFileSync(scanPath, "utf8")).vftables;
const table = Object.values(scan).find(t => t.rva === tableRva);
if (!table) throw new Error(`no scanned table at 0x${tableRva.toString(16)}`);

const ARG = /(?:^|[^\w])%(rdx|edx|dx|dl|r8[dwb]?|r9[dwb]?|xmm[1-3])\b/;
const norm = t => t.replace(/\s+/g, " ").trim();

function classify(rva) {
    let ins;
    try { ins = disas(exe, rva, 96); } catch { return null; }
    const lines = ins.map(i => ({ ...i, t: norm(i.text) }));
    // trivial: mov(zx) reg,[rcx+D] ; ret
    {
        const m = lines[0]?.t.match(/^mov(?:z[bw]l|q|l|zbl)? (-?\d+)?\(%rcx\), %(eax|rax|al|ax)$/);
        if (m && lines[1]?.t === "retq") return { shape: "trivial", disp: Number(m[1] ?? 0), width: m[2] };
    }
    let k = 0;
    if (/^subq \$\d+, %rsp$/.test(lines[k]?.t)) k++;
    if (lines[k]?.t !== "movq (%rcx), %rax") return null;
    k++;
    const vm = lines[k]?.t.match(/^movq (\d+)\(%rax\), %rax$/);
    if (!vm) return null;
    const via = Number(vm[1]) / 8;
    k++;
    if (!/^callq \*\d+\(%rip\)$/.test(lines[k]?.t)) return null;   // the CFG guard dispatch
    k++;
    // direct load
    {
        const m = lines[k]?.t.match(/^mov(?:z[bw]l|q|l|zbl|sbl)? (-?\d+)?\(%rax\), %(eax|rax|al|ax)$/);
        if (m) {
            let j = k + 1;
            if (/^addq \$\d+, %rsp$/.test(lines[j]?.t)) j++;
            if (lines[j]?.t === "retq") return { shape: "direct", via, disp: Number(m[1] ?? 0), width: m[2] };
        }
    }
    // lookup by key
    {
        const lea = lines[k]?.t.match(/^leaq (-?\d+)\(%rip\), %rdx$/);
        if (!lea) return null;
        const key = lines[k].rva + lines[k].size + Number(lea[1]);
        if (lines[k + 1]?.t !== "movq %rax, %rcx") return null;
        const call = lines[k + 2]?.t.match(/^callq (-?\d+)$/);
        if (!call) return null;
        const target = lines[k + 2].target;
        // what follows must be a tag check and a load, with no store, no
        // argument read and no further call before ret
        let tag = null, width = null;
        for (let j = k + 3; j < lines.length && j < k + 16; j++) {
            const t = lines[j].t;
            if (ARG.test(t)) return null;
            if (/^callq/.test(t)) return null;
            if (/^mov\S* %\w+, [^%]*\(/.test(t)) return null;   // store
            const tm = t.match(/^cmpb \$(\d+), 32\(%r(ax|cx)\)$/); if (tm) tag = Number(tm[1]);
            const lm = t.match(/^mov(?:z[bw]l|q|l|zbl)? (?:\d+)?\(%r(?:ax|cx)\), %(eax|rax|al|ax)$/); if (lm) width = lm[1];
            if (t === "retq") return tag === null ? null : { shape: "lookup", via, key, lookup: target, tag, width };
        }
        return null;
    }
}

const slots = [];
const seen = new Set();
table.slots.forEach((rva, slot) => {
    const c = classify(rva);
    if (!c) return;
    slots.push({ slot, rva, ...c, duplicateOf: seen.has(rva) ? table.slots.indexOf(rva) : undefined });
    seen.add(rva);
});
const byShape = {}; for (const s of slots) byShape[s.shape] = (byShape[s.shape] ?? 0) + 1;
fs.writeFileSync(out, JSON.stringify({ exe, table: tableRva, slots }, null, 1));
console.log(`table 0x${tableRva.toString(16)}: ${table.slots.length} slots, ${slots.length} pure getters ${JSON.stringify(byShape)} -> ${out}`);
