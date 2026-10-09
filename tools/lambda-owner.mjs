/**
 * From a lambda scope to the function that owns the lambda (docs/findings-inventory.md section 11 found that
 * 1.26 lambda type descriptors name their enclosing function's full decoration; this turns that name into an
 * address).
 *
 * A lambda stored in a std::function gets a TypeDescriptor even with RTTI off, because
 * std::_Func_impl_no_alloc<...>::_Target_type() returns &typeid(lambda). So:
 *   1. the descriptor name `.?AV<lambda_N>@?0??<enclosing decoration>@` sits in .data, 16 bytes into the
 *      TypeDescriptor { const void* vftable; void* spare; char name[]; }
 *   2. `lea reg, [rip+TypeDescriptor]` in .text is _Target_type() (a two-instruction leaf)
 *   3. that function's address sits in slot 3 of the _Func_impl vftable (_Copy, _Move, _Do_call, _Target_type,
 *      _Delete_this, _Get)
 *   4. whoever `lea`s that vftable builds the std::function: the enclosing function (and the impl's own
 *      _Copy/_Move, which store the same vptr into the copy -- listed, marked).
 *
 * Usage: node tools/lambda-owner.mjs <version> <substring of the enclosing decoration>
 */
import * as fs from "fs";
import { loadPE } from "./pe.mjs";
import { functions, containing } from "./pdata.mjs";

const [v, needle] = process.argv.slice(2);
if (!v || !needle) {
    console.error("usage: node tools/lambda-owner.mjs <version> <substring of the enclosing decoration>");
    process.exit(2);
}
const exe = `work/bin/${v}/bedrock_server.exe`;
const pe = loadPE(exe);
const fns = functions(exe);
const { buf, text } = pe;
const hex = n => "0x" + n.toString(16);

// every RIP-relative lea in .text, target -> [site]
const leas = new Map();
for (let p = text.rawPtr; p < text.rawPtr + text.rawSize - 7; p++) {
    if ((buf[p] & 0xf8) !== 0x48 || buf[p + 1] !== 0x8d || (buf[p + 2] & 0xc7) !== 0x05) continue;
    const at = text.rva + (p - text.rawPtr);
    const target = at + 7 + buf.readInt32LE(p + 3);
    let a = leas.get(target);
    if (a === undefined) leas.set(target, (a = []));
    a.push(at);
}
const qwordRefs = (va, sections) => {
    const out = [];
    for (const s of sections) {
        const sec = pe.sec(s);
        if (!sec) continue;
        for (let o = sec.rawPtr; o + 8 <= sec.rawPtr + Math.min(sec.rawSize, sec.vsize); o += 8) {
            if (buf.readBigUInt64LE(o) === va) out.push(o - sec.rawPtr + sec.rva);
        }
    }
    return out;
};

const data = pe.sec(".data");
const needleBuf = Buffer.from(needle, "latin1");
for (let o = data.rawPtr; ; ) {
    const i = buf.indexOf(needleBuf, o);
    if (i < 0 || i >= data.rawPtr + data.rawSize) break;
    o = i + 1;
    let start = i;
    while (start > data.rawPtr && buf[start - 1] !== 0) start--;
    const name = buf.toString("latin1", start, buf.indexOf(0, start));
    if (!name.startsWith(".?AV<lambda_")) continue;
    const td = start - data.rawPtr + data.rva - 16;
    console.log(`descriptor ${hex(td)}  ${name.slice(0, 140)}`);
    for (const site of leas.get(td) ?? []) {
        const tt = containing(fns, site);
        const ttStart = tt ? tt.begin : site; // _Target_type is usually a leaf with no .pdata entry
        for (const slot of qwordRefs(pe.imageBase + BigInt(ttStart), [".rdata"])) {
            const vft = slot - 3 * 8;
            console.log(`  _Target_type ${hex(ttStart)} in slot 3 of _Func_impl vftable ${hex(vft)}`);
            const users = new Map();
            for (const s of leas.get(vft) ?? []) {
                const f = containing(fns, s);
                if (f) users.set(f.begin, f.end - f.begin);
            }
            const own = new Set([0, 1].map(k => Number(buf.readBigUInt64LE(pe.off(vft + k * 8)) - pe.imageBase)));
            for (const [f, size] of users) console.log(`    builds it: ${hex(f)} (${size} B)${own.has(f) ? "  [the impl's own _Copy/_Move]" : ""}`);
        }
    }
}
