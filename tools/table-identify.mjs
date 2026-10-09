/**
 * Identify a live vftable (an exact address, read from an object's vptr)
 * among every baseline table of the same slot count, by comparing the
 * argument-register shape of each slot's body (tools/slot-shape.mjs).
 *
 * A candidate survives when every slot is compatible. The number of
 * survivors is the evidence: one survivor names the table; many say the
 * shapes cannot tell, whatever the getter that returned the object suggested.
 *
 * Usage: node tools/table-identify.mjs <version> <liveTableRva>... [--min=4]
 */
import * as fs from "fs";
import { shape, compatible } from "./slot-shape.mjs";
const args = process.argv.slice(2);
const v = args[0];
const MIN = Number((args.find(a => a.startsWith("--min=")) ?? "--min=4").slice(6));
const rvas = args.slice(1).filter(a => !a.startsWith("--")).map(Number);
const scan = JSON.parse(fs.readFileSync(`work/vft/scan-${v}.json`, "utf8")).vftables;
const byRva = new Map(Object.values(scan).map(t => [t.rva, t]));
const B = JSON.parse(fs.readFileSync("work/vft/baseline-slots.json", "utf8"));
const T = `work/bin/${v}/bedrock_server.exe`, BE = "work/bin/1.21.3.01/bedrock_server.exe";
const bShape = new Map();
const shapeB = f => { if (!bShape.has(f)) bShape.set(f, shape(BE, f)); return bShape.get(f); };
const req = new Set(JSON.parse(fs.readFileSync("data/required-symbols.json", "utf8")).symbols.map(s => s.name));
for (const r of rvas) {
    const t = byRva.get(r);
    if (!t) { console.log(`0x${r.toString(16)}: not a scanned table`); continue; }
    const n = t.slots.length;
    if (n < MIN) { console.log(`0x${r.toString(16)}: ${n} slots, below --min`); continue; }
    const live = t.slots.map(f => shape(T, f));
    const same = Object.entries(B.vftables).filter(([, bt]) => bt.slots.length === n);
    const survivors = [];
    for (const [name, bt] of same) {
        let ok = true;
        for (let i = 0; i < n && ok; i++) if (!compatible(shapeB(bt.slots[i]), live[i])) ok = false;
        if (ok) survivors.push(name);
    }
    // distinct bodies: identical-code-folded tables share slots, so count distinct slot vectors
    const distinct = new Set(survivors.map(s => B.vftables[s].slots.join(",")));
    console.log(`0x${r.toString(16)}: ${n} slots; baseline tables of that size ${same.length}; fully compatible ${survivors.length} (${distinct.size} distinct bodies)${survivors.length ? ": " + survivors.slice(0, 8).map(s => s + (req.has(s) ? " [REQ]" : "")).join(", ") + (survivors.length > 8 ? " ..." : "") : ""}`);
}
