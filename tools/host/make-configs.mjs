/**
 * The launcher configs the host drivers name, regenerated from work/vft/scan-<v>.json (tools/vftable-slots.mjs):
 *   instance-config-<40|51>.json   { tableStarts }              for tools/instance-probe-launcher.js (IP_CONFIG)
 *   rp-config-<version>.json       { tableStarts, slotCount }   for tools/reach-probe-launcher.js   (RP_CONFIG)
 *   lg-config-raw-<40|51>.json     { symbols: {}, levelDat }    for tools/level-getter-probe-launcher.js (LG_CONFIG)
 * They were first made by hand in a session; this makes them reproducible. The drivers read them
 * from the lab directory, which is where they are written unless <outDir> is given.
 *
 * Usage: node tools/host/make-configs.mjs [outDir]      (needs work/vft/scan-<v>.json: tools/vftable-scan.mjs)
 */
import * as fs from "fs";
import * as path from "path";
import { LAB } from "./lab.mjs";
const out = process.argv[2] || LAB;
fs.mkdirSync(out, { recursive: true });
for (const [v, short] of [["1.26.40.8", "40"], ["1.26.51.1", "51"]]) {
    const scan = JSON.parse(fs.readFileSync(`work/vft/scan-${v}.json`, "utf8")).vftables;
    const tableStarts = scan.map(t => t.rva), slotCount = Object.fromEntries(scan.map(t => [t.rva, t.slots.length]));
    fs.writeFileSync(`${out}/instance-config-${short}.json`, JSON.stringify({ tableStarts }));
    fs.writeFileSync(`${out}/rp-config-${v}.json`, JSON.stringify({ tableStarts, slotCount }));
    console.log(`${v}: ${tableStarts.length} tables`);
}
// one per instance: each build has its own installed tree (tools/host/setup-lab.mjs)
for (const short of ["40", "51"]) {
    fs.writeFileSync(`${out}/lg-config-raw-${short}.json`, JSON.stringify({ symbols: {}, levelDat: path.join(LAB, `inst${short}`, "bedrock_server", "worlds", "smoketest", "level.dat") }));
}
