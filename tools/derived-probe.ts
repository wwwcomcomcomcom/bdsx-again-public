// Execution check for the names bdsx carries itself because this build has no
// address for them (docs/findings-utils.md): the value-type helpers whose
// behaviour is fixed by the type rather than by the binary.
//
// Deployed beside example_and_test and driven from the console by
// tools/run-full.ps1 -Commands @("derivedprobe").
import { Facing, BlockPos, Vec2, Vec3 } from "bdsx/bds/blockpos";
import { CommandIntegerRange } from "bdsx/bds/command";
import { computeHashOf, HashedString } from "bdsx/bds/hashedstring";
import { ScoreboardId } from "bdsx/bds/scoreboard";
import { events } from "bdsx/event";
import { bin } from "bdsx/bin";
import { AllocatedPointer } from "bdsx/core";
import { bedrockServer } from "bdsx/launcher";
import { pdbcache } from "bdsx/pdbcache";
import { procConst } from "bdsx/bds/symbols";
import * as dgram from "dgram";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[derived] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;

events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "derivedprobe") return;

    // HashedString::computeHash -- FNV-1 over the bytes. The expected values are
    // Endstone's published test vectors (tests/bedrock/test_hashed_string.cpp,
    // Apache-2.0), which come from a 1.26 build, not from ours.
    const vectors: [string, string][] = [
        ["minecraft:air", "bd584baf00003448"],
        ["minecraft:player.exhaustion", "8afb6992bde84d57"],
        ["minecraft:player.experience", "d5c6a6b9319a39cb"],
        ["minecraft:player.hunger", "3c90c06ed4382c12"],
        ["minecraft:player.level", "82284d95df87fac7"],
        ["minecraft:player.saturation", "5185acc9f6e9a50b"],
    ];
    for (const [text, expected] of vectors) {
        const got = bin.reversedHex(computeHashOf(text).getAddressBin()).toLowerCase();
        say(`computeHash("${text}")`, got === expected, `0x${got}${got === expected ? "" : " expected 0x" + expected}`);
    }
    // and through the class, which is how bdsx reaches it
    const hs = HashedString.construct();
    hs.set("minecraft:air");
    say("HashedString.set", bin.reversedHex(hs.hash!.getAddressBin()).toLowerCase() === "bd584baf00003448", `${hs.str} -> 0x${bin.reversedHex(hs.hash!.getAddressBin())}`);
    hs.destruct();

    // Vec3::directionFromRotation -- pitch in x, yaw in y, degrees. Yaw 0 faces +Z.
    const dir = (pitch: number, yaw: number): Vec3 => Vec3.directionFromRotation(Vec2.create(pitch, yaw));
    const checkDir = (pitch: number, yaw: number, x: number, y: number, z: number): void => {
        const d = dir(pitch, yaw);
        say(`directionFromRotation(${pitch}, ${yaw})`, near(d.x, x) && near(d.y, y) && near(d.z, z), `${d.x.toFixed(4)}, ${d.y.toFixed(4)}, ${d.z.toFixed(4)}`);
    };
    checkDir(0, 0, 0, 0, 1);
    checkDir(0, 90, -1, 0, 0);
    checkDir(0, 180, 0, 0, -1);
    checkDir(0, 270, 1, 0, 0);
    checkDir(-90, 0, 0, 1, 0);
    checkDir(90, 0, 0, -1, 0);

    // Vec3::rotationFromDirection -- the inverse, normalised to the same conventions
    const checkRot = (x: number, y: number, z: number, pitch: number, yaw: number): void => {
        const r = Vec3.rotationFromDirection(Vec3.create(x, y, z));
        const sameYaw = near(((r.y - yaw) % 360 + 540) % 360 - 180, 0, 1e-3);
        say(`rotationFromDirection(${x}, ${y}, ${z})`, near(r.x, pitch, 1e-3) && sameYaw, `pitch ${r.x.toFixed(4)}, yaw ${r.y.toFixed(4)}`);
    };
    checkRot(0, 0, 1, 0, 0);
    checkRot(-1, 0, 0, 0, 90);
    checkRot(0, 0, -1, 0, 180);
    // straight up has no yaw to speak of: atan2(0, 0) is 0, so the build's
    // `atan2 * 57.2957763671875 - 90` answers -90, and so does this
    checkRot(0, 1, 0, -90, -90);

    // and the round trip, which is what a plugin actually leans on
    let worst = 0;
    for (let pitch = -80; pitch <= 80; pitch += 20) {
        for (let yaw = -180; yaw < 180; yaw += 15) {
            const back = Vec3.rotationFromDirection(dir(pitch, yaw));
            const dYaw = Math.abs(((back.y - yaw) % 360 + 540) % 360 - 180);
            worst = Math.max(worst, Math.abs(back.x - pitch), dYaw);
        }
    }
    say("rotation round trip (117 angles)", worst < 0.02, `worst error ${worst.toFixed(5)} degrees`);

    // Facing::convertYRotationToFacingDirection -- the quadrant a yaw falls in
    const facings: [number, Facing][] = [
        [0, Facing.South],
        [44, Facing.South],
        [46, Facing.West],
        [90, Facing.West],
        [135, Facing.North],
        [180, Facing.North],
        [225, Facing.East],
        [270, Facing.East],
        [315, Facing.South],
        [-90, Facing.East],
    ];
    for (const [yaw, want] of facings) {
        const got = Facing.convertYRotationToFacingDirection(yaw);
        say(`convertYRotationToFacingDirection(${yaw})`, got === want, `${Facing[got] ?? got} (want ${Facing[want]})`);
    }

    // BlockPos::relative -- one step along each facing
    const base = BlockPos.create(10, 20, 30);
    const steps: [Facing, number, number, number][] = [
        [Facing.Down, 10, 17, 30],
        [Facing.Up, 10, 23, 30],
        [Facing.North, 10, 20, 27],
        [Facing.South, 10, 20, 33],
        [Facing.West, 7, 20, 30],
        [Facing.East, 13, 20, 30],
    ];
    for (const [facing, x, y, z] of steps) {
        const r = base.relative(facing, 3);
        say(`relative(${Facing[facing]}, 3)`, r.x === x && r.y === y && r.z === z, `${r.x}, ${r.y}, ${r.z}`);
    }
    say("relative leaves the receiver alone", base.x === 10 && base.y === 20 && base.z === 30, `${base.x}, ${base.y}, ${base.z}`);

    // ScoreboardId::isValid -- the id half against the INVALID constant
    const sid = ScoreboardId.construct();
    sid.id = ScoreboardId.INVALID.id;
    say("ScoreboardId(INVALID).isValid", sid.isValid() === false, String(sid.isValid()));
    sid.idAsNumber = 7;
    say("ScoreboardId(7).isValid", sid.isValid() === true, String(sid.isValid()));
    sid.destruct();

    // CommandIntegerRange::isWithinRange -- inclusive/exclusive by the byte after
    // `inverted`, which bdsx's class does not model, so the struct is laid out by hand
    const buf = new AllocatedPointer(12);
    const range = buf.as(CommandIntegerRange);
    const layout = (min: number, max: number, inverted: boolean, inclusive: boolean): CommandIntegerRange => {
        buf.setInt32(min, 0);
        buf.setInt32(max, 4);
        buf.setUint8(inverted ? 1 : 0, 8);
        buf.setUint8(inclusive ? 1 : 0, 9);
        return range;
    };
    say("range [3,7] contains 3", layout(3, 7, false, true).isWithinRange(3) === true, String(range.isWithinRange(3)));
    say("range [3,7] contains 7", layout(3, 7, false, true).isWithinRange(7) === true, String(range.isWithinRange(7)));
    say("range [3,7] rejects 8", layout(3, 7, false, true).isWithinRange(8) === false, String(range.isWithinRange(8)));
    say("inverted [3,7] rejects 5", layout(3, 7, true, true).isWithinRange(5) === false, String(range.isWithinRange(5)));
    say("range (3,7) rejects 3", layout(3, 7, false, false).isWithinRange(3) === false, String(range.isWithinRange(3)));
    say("range (3,7) contains 5", layout(3, 7, false, false).isWithinRange(5) === true, String(range.isWithinRange(5)));
});

// SharedConstants' version integers ship as per-build constants
// (docs/findings-utils.md): the four version ints are the build number the
// table is keyed to, and the protocol number is what the server answers pings
// with -- so the check is the server's own MOTD against the shipped value.
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "versionprobe") return;
    const ints = ["Major", "Minor", "Patch", "Revision"].map(name => procConst(`?${name}Version@SharedConstants@@3HB`, p => p.getInt32(), -1));
    const version = ints.join(".");
    say("SharedConstants version", version === pdbcache.bdsVersion, `${version} (table says ${pdbcache.bdsVersion})`);
    const shipped = bedrockServer.serverInstance.getNetworkProtocolVersion();
    const socket = dgram.createSocket("udp4");
    const magic = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");
    const timer = setTimeout(() => {
        say("NetworkProtocolVersion", null, `${shipped} shipped, but the server did not answer its own ping`);
        socket.close();
    }, 4000);
    socket.on("message", msg => {
        clearTimeout(timer);
        const motd = msg.subarray(35, 35 + msg.readUInt16BE(33)).toString("utf8").split(";");
        say("NetworkProtocolVersion", Number(motd[2]) === shipped, `${shipped} shipped, ${motd[2]} in the server's own MOTD (${motd[3]})`);
        socket.close();
    });
    socket.send(Buffer.concat([Buffer.from([0x01]), Buffer.alloc(8), magic, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]), 19132, "127.0.0.1");
});
console.log("[derived] loaded");
