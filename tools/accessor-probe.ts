// Execution check for the field accessors symbols.json ships as offsets
// (docs/findings-layouts.md): `proc[name]` emits the body at load time and
// the value it returns is compared with what the server itself reports.
// The second command, `constprobe`, checks the static const data the table
// ships as bytes instead of as an address (same doc, "Constants").
// Deployed beside example_and_test and driven from the console by
// tools/run-full.ps1 -Commands @("accprobe", "difficulty hard", "accprobe", "constprobe").
import { proc } from "bdsx/bds/symbols";
import { StaticPointer, VoidPointer } from "bdsx/core";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { makefunc } from "bdsx/makefunc";
import { BlockPos, Vec3 } from "bdsx/bds/blockpos";
import { ActorUniqueID } from "bdsx/bds/actor";
import { bin } from "bdsx/bin";
import { float32_t, int32_t } from "bdsx/nativetype";
import { pdbcache } from "bdsx/pdbcache";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[accprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
const has = (n: string): boolean => n in proc;

events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "accprobe") return;
    say("table", null, `${pdbcache.accessorCount} accessors in symbols.json`);
    // Minecraft::getCommands: the thunk against the field launcher.ts reads through layouts
    const GC = "?getCommands@Minecraft@@QEAAAEAVMinecraftCommands@@XZ";
    if (has(GC)) {
        const get = makefunc.js(proc[GC], VoidPointer, null, VoidPointer);
        const r = get(bedrockServer.minecraft);
        say("Minecraft::getCommands", r.equalsptr(bedrockServer.minecraftCommands), `${r} vs ${bedrockServer.minecraftCommands}`);
    } else say("Minecraft::getCommands", false, "not in proc");
    // LevelData: difficulty and weather against the console
    const LD = "?getLevelData@Level@@UEAAAEAVLevelData@@XZ";
    if (!has(LD)) { say("Level::getLevelData", false, "missing"); return; }
    const levelData = makefunc.js(proc[LD], StaticPointer, null, VoidPointer)(bedrockServer.level);
    const intGetter = (n: string): number | null => (has(n) ? makefunc.js(proc[n], int32_t, null, VoidPointer)(levelData) : null);
    const floatGetter = (n: string): number | null => (has(n) ? makefunc.js(proc[n], float32_t, null, VoidPointer)(levelData) : null);
    say("LevelData::getGameDifficulty", null, String(intGetter("?getGameDifficulty@LevelData@@QEBA?AW4Difficulty@@XZ")));
    say("LevelData::getRainLevel", null, String(floatGetter("?getRainLevel@LevelData@@QEBAMXZ")));
    say("LevelData::getRainTime", null, String(intGetter("?getRainTime@LevelData@@QEBAHXZ")));
    say("LevelData::getLightningLevel", null, String(floatGetter("?getLightningLevel@LevelData@@QEBAMXZ")));
    say("LevelData::getLightningTime", null, String(intGetter("?getLightningTime@LevelData@@QEBAHXZ")));
});

// The constants the table ships as bytes (docs/findings-layouts.md,
// "Constants"): `proc` allocates them at load time, so by the time this runs
// bdsx's own Vec3 and BlockPos classes are already pointing at our memory.
// Checked against what the name says, which is the only thing they can be.
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "constprobe") return;
    say("table", null, `${pdbcache.constantCount} constants in symbols.json`);
    const v3 = (name: string, v: Vec3, x: number, y: number, z: number): void =>
        say(`Vec3::${name}`, v.x === x && v.y === y && v.z === z, `${v.x}, ${v.y}, ${v.z}`);
    v3("ZERO", Vec3.ZERO, 0, 0, 0);
    v3("ONE", Vec3.ONE, 1, 1, 1);
    v3("TWO", Vec3.TWO, 2, 2, 2);
    v3("HALF", Vec3.HALF, 0.5, 0.5, 0.5);
    v3("UNIT_X", Vec3.UNIT_X, 1, 0, 0);
    v3("UNIT_Y", Vec3.UNIT_Y, 0, 1, 0);
    v3("UNIT_Z", Vec3.UNIT_Z, 0, 0, 1);
    v3("NEG_UNIT_X", Vec3.NEG_UNIT_X, -1, 0, 0);
    v3("NEG_UNIT_Y", Vec3.NEG_UNIT_Y, 0, -1, 0);
    v3("NEG_UNIT_Z", Vec3.NEG_UNIT_Z, 0, 0, -1);
    v3("MAX", Vec3.MAX, 3.4028234663852886e38, 3.4028234663852886e38, 3.4028234663852886e38);
    v3("MIN", Vec3.MIN, -3.4028234663852886e38, -3.4028234663852886e38, -3.4028234663852886e38);
    const bp = (name: string, v: BlockPos, x: number, y: number, z: number): void =>
        say(`BlockPos::${name}`, v.x === x && v.y === y && v.z === z, `${v.x}, ${v.y}, ${v.z}`);
    bp("ZERO", BlockPos.ZERO, 0, 0, 0);
    bp("ONE", BlockPos.ONE, 1, 1, 1);
    bp("MAX", BlockPos.MAX, 0x7fffffff, 0x7fffffff, 0x7fffffff);
    bp("MIN", BlockPos.MIN, -0x80000000, -0x80000000, -0x80000000);
    // read through the table rather than through the procConst default
    say(
        "ActorUniqueID::INVALID_ID",
        has("?INVALID_ID@ActorUniqueID@@2U1@B") && ActorUniqueID.INVALID_ID === bin.make64(0xffffffff, 0xffffffff),
        `0x${bin.toString(ActorUniqueID.INVALID_ID, 16)} (from the table, not the procConst default)`,
    );
    // a constant is bdsx's own memory: there is no address for it in this build
    const ONE = "?ONE@Vec3@@2V1@B";
    say("Vec3::ONE has no address in the binary", pdbcache.search(ONE) === -1, `served as a constant at ${proc[ONE]}`);
});
console.log("[accprobe] loaded");
