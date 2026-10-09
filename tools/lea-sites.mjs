/**
 * RVAs of every `lea r64,[rip+disp]` in .text that lands on a NUL-terminated literal (the lea site, not the function).
 *   node tools/lea-sites.mjs <version> <string> [<string> ...]
 */
import { loadPE } from "./pe.mjs";
const [v, ...strs] = process.argv.slice(2);
const pe = loadPE(`work/bin/${v}/bedrock_server.exe`);
const { buf, text } = pe;
const rdata = pe.sec(".rdata");
const textEnd = text.rawPtr + text.rawSize;
for (const s of strs) {
    const lit = Buffer.from(s + "\0");
    const locs = new Set();
    for (let i = rdata.rawPtr; (i = buf.indexOf(lit, i)) >= 0 && i < rdata.rawPtr + rdata.rawSize; i++) locs.add(rdata.rva + i - rdata.rawPtr);
    const out = [];
    for (let p = text.rawPtr + 3; p < textEnd - 4; p++) {
        if (buf[p - 2] !== 0x8d) continue;
        const t = text.rva + (p - text.rawPtr) + 4 + buf.readInt32LE(p);
        if (locs.has(t)) out.push("0x" + (text.rva + p - 3 - text.rawPtr).toString(16));
    }
    console.log(`${s}: ${out.join(" ")}`);
}
