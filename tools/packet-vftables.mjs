/**
 * Turn the runtime (packet id -> vftable) dump into named vftables.
 *
 * tools/vftable-probe-launcher.js calls MinecraftPackets::createPacket for
 * every id and records the vftable pointer of what comes back. bdsx's own
 * MinecraftPacketIds enum names each id, and the class is <Name>Packet, whose
 * vftable symbol is ??_7<Name>Packet@@6B@. Where the baseline PDB has that
 * symbol the pairing is checked to exist; the address itself is read from the
 * live object and involves no inference.
 *
 * Usage: node tools/packet-vftables.mjs <run-output.txt> <bdsx/bdsx/bds/packetids.ts> <baseline-slots.json> <out.json> [walk-candidates.json]
 */
import * as fs from "fs";
const [runPath, enumPath, slotsPath, outPath, walkPath] = process.argv.slice(2);
const line = fs.readFileSync(runPath, "utf8").split("\n").find(l => l.includes("[vp] PACKETS "));
if (!line) { console.error("no [vp] PACKETS line in " + runPath); process.exit(1); }
const dump = JSON.parse(line.slice(line.indexOf("[vp] PACKETS ") + 13));
const ids = new Map();
for (const m of fs.readFileSync(enumPath, "utf8").matchAll(/^\s*(\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+),/gm)) {
    const id = Number(m[2]);
    if (!ids.has(id)) ids.set(id, m[1]); // keep the first name; later duplicates are deprecated aliases
}
const baseline = JSON.parse(fs.readFileSync(slotsPath, "utf8")).vftables;
const walk = walkPath ? JSON.parse(fs.readFileSync(walkPath, "utf8")).vftables : {};
const vftables = {}, unnamed = [], notInBaseline = [];
let walkAgree = 0, walkDisagree = 0; const dis = [];
for (const [id, rva] of dump) {
    const name = ids.get(id);
    if (!name) { unnamed.push([id, rva]); continue; }
    const sym = `??_7${name.endsWith("Packet") ? name : name + "Packet"}@@6B@`;
    if (!(sym in baseline)) { notInBaseline.push([id, name, rva]); continue; }
    vftables[sym] = rva;
    if (sym in walk) { if (walk[sym] === rva) walkAgree++; else { walkDisagree++; dis.push(`${sym} walk=0x${walk[sym].toString(16)} runtime=0x${rva.toString(16)}`); } }
}
fs.writeFileSync(outPath, JSON.stringify({
    _comment: "Packet vftables read from live packet objects: tools/vftable-probe-launcher.js called MinecraftPackets::createPacket (Endstone-resolved, execution-confirmed) for every id and recorded *(void**)packet. Names come from bdsx's MinecraftPacketIds enum; only ids whose ??_7<Name>Packet@@6B@ exists in the 1.21.3.01 PDB are kept. No inference is involved in the address.",
    count: Object.keys(vftables).length, vftables, unnamedIds: unnamed, namedButNotInBaseline: notInBaseline,
}, null, 1));
console.log(`packets created ${dump.length}; named vftables ${Object.keys(vftables).length}; ids without an enum name ${unnamed.length}; enum names without a baseline vftable ${notInBaseline.length}`);
if (walkPath) { console.log(`vs walk: overlap ${walkAgree + walkDisagree}, agree ${walkAgree}, disagree ${walkDisagree}`); dis.forEach(d => console.log("  " + d)); }
console.log(`-> ${outPath}`);
