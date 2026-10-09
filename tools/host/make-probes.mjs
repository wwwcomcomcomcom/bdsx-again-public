/**
 * Counter-probe list for tools/instance-probe-launcher.js (IP_PROBES), written from HEX addresses.
 * Probe addresses typed by hand in decimal have cost four sessions: a wrong one hooks the middle of a
 * function. This refuses any address that is not the start of a .pdata function of 16+ bytes.
 *
 * Usage: node tools/host/make-probes.mjs <version> <out.json> "label=0xRVA" ["label=0xRVA" ...]
 */
import * as fs from "fs";
import { functions } from "../pdata.mjs";
const [v, out, ...pairs] = process.argv.slice(2);
if (!v || !out || !pairs.length) { console.error('usage: node tools/host/make-probes.mjs <version> <out.json> "label=0xRVA" ...'); process.exit(2); }
const fns = functions(`work/bin/${v}/bedrock_server.exe`);
const list = pairs.map(p => {
    const i = p.lastIndexOf("="); const label = p.slice(0, i), hex = p.slice(i + 1);
    if (!/^0x[0-9a-f]+$/i.test(hex)) throw Error(`${p}: the address must be hex with 0x`);
    const rva = parseInt(hex, 16), e = fns.find(x => x.begin === rva);
    if (!e) throw Error(`${label}: ${hex} is not the start of a .pdata function on ${v}`);
    if (e.end - e.begin < 16) throw Error(`${label}: ${hex} is ${e.end - e.begin} bytes; a hook needs 16`);
    console.log(`${label}: ${hex}, ${e.end - e.begin} bytes`);
    return [label, rva];
});
fs.writeFileSync(out, JSON.stringify(list) + "\n");
