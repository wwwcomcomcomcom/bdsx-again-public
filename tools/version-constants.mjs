/**
 * The per-build constants: SharedConstants' version integers.
 *
 * `?MajorVersion@SharedConstants@@3HB` and its three siblings are plain ints
 * that no route can find -- in 1.26 no code window anywhere in .text
 * references a 1, a 26 and a 40 within 512 bytes of each other (bdsx's
 * check.ts says the same). But they are not unknown: they are the build
 * number the table is already keyed to, so they ship as bytes like any other
 * constant (docs/findings-utils.md). Unlike data/constants.json these are
 * per-build, hence one file per version.
 *
 * `?NetworkProtocolVersion@SharedConstants@@3HB` is the one that has to be
 * measured rather than read off the version string: pass it with --protocol=N
 * from the number the server answers to an unconnected RakNet ping
 * (tools/ping-protocol.cjs).
 *
 * Usage: node tools/version-constants.mjs <version> [--protocol=N] [--out=data/constants-<v>.json]
 */
import * as fs from "fs";

const args = process.argv.slice(2);
const v = args.find(a => !a.startsWith("--"));
if (!v) {
    console.error("usage: version-constants.mjs <version> [--protocol=N] [--out=...]");
    process.exit(2);
}
const protocolArg = args.find(a => a.startsWith("--protocol="));
const protocol = protocolArg ? Number(protocolArg.slice(11)) : null;
const out = (args.find(a => a.startsWith("--out=")) ?? `--out=data/constants-${v}.json`).slice(6);

const parts = v.split(".").map(Number);
if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) {
    console.error(`${v}: expected four dotted integers, e.g. 1.26.40.8`);
    process.exit(2);
}
const int32 = n => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return b.toString("hex");
};
const constants = {};
const names = ["Major", "Minor", "Patch", "Revision"];
names.forEach((name, i) => {
    constants[`?${name}Version@SharedConstants@@3HB`] = {
        bytes: int32(parts[i]),
        size: 4,
        type: "int",
        value: String(parts[i]),
        via: `the build number this table is keyed to (${v}), which is what these four ints are`,
        site: "bdsx/check.ts",
        required: true,
    };
});
if (protocol !== null) {
    constants["?NetworkProtocolVersion@SharedConstants@@3HB"] = {
        bytes: int32(protocol),
        size: 4,
        type: "int",
        value: String(protocol),
        via: `read from BDS ${v}'s own answer to an unconnected RakNet ping (tools/ping-protocol.cjs)`,
        site: "bdsx/bds/implements.ts",
        required: true,
    };
}
fs.writeFileSync(out, JSON.stringify({
    _comment: `Per-build constants for BDS ${v} (tools/version-constants.mjs, docs/findings-utils.md). Merged after data/constants.json, which is the build-independent set.`,
    bdsVersion: v,
    generatedAt: new Date().toISOString(),
    constants,
}, null, 1) + "\n");
for (const [n, c] of Object.entries(constants)) console.log(`  ${n.padEnd(46)} ${c.value}`);
console.log(`${Object.keys(constants).length} per-build constants -> ${out}`);
