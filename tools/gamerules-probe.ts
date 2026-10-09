// Execution check for the names bdsx carries over the GameRules layout
// (docs/findings-slots.md, "The anchor that was wrong"): getRule, hasRule and
// nameToGameRuleIndex are bdsx code over symbols.json `layouts.GameRules`,
// GameRule::getBool/getInt/getFloat are emitted accessors, and
// bedrockServer.gameRules comes from Level::getGameRules. The values are
// compared with what the console was just told (`gamerule ...`).
// The second half is the weather seam: levelWeatherChange hooks
// WeatherManager::updateWeather, and Level.updateWeather() calls it through
// `layouts.Level.weatherManager`.
// Deployed beside example_and_test as zz-grprobe.ts and driven by
//   tools/run-full.ps1 -Commands @("grprobe", "gamerule randomtickspeed 7", "gamerule keepinventory true", "grprobe", "weather rain", "wxprobe", "weather query")
//
// "levelprobe" (Q4, docs/next-steps.md) checks the header+1 candidates for
// Level::getTime/setTime/explode (docs/findings-slots.md route 9) by calling
// them directly at their raw RVA -- LP_GETTIME/LP_SETTIME/LP_EXPLODE, hex,
// no 0x -- before either name is in symbols.json, so a wrong address fails
// loudly in this session and never reaches the shared table. getTime/setTime
// round-trip against themselves (no level.dat needed); explode is armed only
// by "levelprobe explode" and needs no player (Level.getDimension(0) and its
// accessor-backed getBlockSource() are both already resolved).
//
// "levelprobe cleanup arm" / "levelprobe cleanup" (Q4, docs/next-steps.md): does the engine ever call
// the route-9 candidate for ?levelCleanupQueueEntityRemoval@Level@@ at all? bdsx's own hook on this
// name (bds/implements.ts, Level$levelCleanupQueueEntityRemoval -> _removeActor/decay) never installs
// today because merge-symbols.mjs's HOOK_TRUST gate drops level-anchored hook targets, so the name has
// no address in the deployed table and the existing hook silently no-ops -- testing through it would
// prove nothing either way. This probe hooks the *raw* candidate RVA (LP_CLEANUP, hex, no 0x, via a
// private ProcHacker over a one-entry map so no name needs to be in symbols.json) with
// hookingRawWithCallOriginal: the moved original runs unmodified and every register is preserved, so a
// wrong address either crashes immediately (bad disassembly boundary) or silently never increments --
// it cannot make a right address behave wrong. The counter also prints on every fire (not only on
// "levelprobe cleanup" readback), because a kill-based test (pig/item/arrow) already came back 0/0 on
// both builds (docs/findings-slots.md, "Q4 continued") -- the next shape to try is a client
// *disconnecting* while the server stays up (the Endstone header lists this name right after
// forceFlushRemovedPlayers()/loadFunctionManager(), suggesting a deferred flush tied to player
// departure, not ordinary entity death), and that flush could land during the post-command wait or
// the shutdown sequence, after the last console command has any chance to run a readback.
//
// "levelprobe sleep 0|1" is a smoke test for ?setShouldSendSleepMessage@ServerLevel@@'s layouts
// (ServerLevel+0x880 -> ServerPlayerSleepManager, +0x1a9 the bool), not an independent confirmation:
// there is no console-driven way to make BDS itself read the flag (sleeping needs a real client, Q7),
// so this only proves the pointer is non-null, the write lands on exactly the intended byte and the
// neighbour byte (+0x1a8, always 0 in the 2024 body too) is untouched.
import { DimensionId } from "bdsx/bds/actor";
import { BlockSource } from "bdsx/bds/block";
import { Vec3 } from "bdsx/bds/blockpos";
import { GameRuleId } from "bdsx/bds/gamerules";
import { Level } from "bdsx/bds/level";
import { proc } from "bdsx/bds/symbols";
import { NativePointer, StaticPointer, VoidPointer } from "bdsx/core";
import { dllraw } from "bdsx/dllraw";
import { makefunc } from "bdsx/makefunc";
import { ProcHacker } from "bdsx/prochacker";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { bool_t, float32_t, int32_t, void_t } from "bdsx/nativetype";
import { pdbcache } from "bdsx/pdbcache";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[grprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
function attempt(label: string, f: () => [boolean | null, string]): void {
    try {
        const [ok, detail] = f();
        say(label, ok, detail);
    } catch (err) {
        say(label, false, `threw ${(err as Error).message}`);
    }
}
// `dayprobe <true|false>`: Dimension.isDay (derived on 1.26 over sky_darken_, docs/findings-layouts.md "Dimension::isDay")
// on the overworld after `time set noon` / `time set midnight` (the sky darkness updates on the next tick)
events.command.on(cmd => {
    const m = /^\/?dayprobe (true|false)$/.exec(cmd);
    if (m === null) return;
    attempt(`isDay ${m[1]}`, () => {
        const dim = bedrockServer.level.getDimension(DimensionId.Overworld);
        if (dim === null) return [false, "Level.getDimension(0) returned null"];
        const got = dim.isDay();
        const dark = (dim as any as StaticPointer).getUint8(pdbcache.layouts.Dimension?.skyDarken ?? 0x170);
        let time = "?";
        try {
            time = String(bedrockServer.level.getTime() % 24000);
        } catch (err) {
            time = `(getTime threw ${(err as Error).message})`;
        }
        // Dimension.getTimeOfDay / getSunAngle (derived over the dimension's getTimeOfDay slot): 0 at noon, 0.5 at
        // midnight, ~0.79 at tick 1000 (the cosine easing), and the sun angle 2pi times that
        // Dimension.getMinHeight / getHeight (accessors: height_range_ at +0xc8 / +0xca on both builds)
        const minH = dim.getMinHeight(), h = dim.getHeight();
        say("overworld height range", minH === -64 && h === 320, `getMinHeight() ${minH} (want -64), getHeight() ${h} (want 320)`);
        const tod = dim.getTimeOfDay(), sun = dim.getSunAngle();
        const t = Number(time);
        const want = t === 6000 ? 0 : t === 18000 ? 0.5 : null;
        const todOk = (want === null || Math.abs(tod - want) < 0.01 || (want === 0 && Math.abs(tod - 1) < 0.01)) && tod >= 0 && tod < 1 && Math.abs(sun - tod * 2 * Math.PI) < 1e-3;
        say(`getTimeOfDay at ${time}`, Number.isNaN(t) ? null : todOk, `getTimeOfDay() ${tod.toFixed(4)}${want === null ? "" : ` (want ${want})`}, getSunAngle() ${sun.toFixed(4)}`);
        return [got === (m[1] === "true"), `isDay() ${got} (want ${m[1]}); sky_darken_ ${dark}; time of day ${time}`];
    });
});
// `moonprobe <phase>`: Dimension.getMoonPhase / getMoonBrightness (derived on 1.26) after `time set <day * 24000 + 18000>`;
// the phase is also what the engine's own `time query day` implies (the day number mod 8)
events.command.on(cmd => {
    const m = /^\/?moonprobe (\d)$/.exec(cmd);
    if (m === null) return;
    attempt(`moon phase ${m[1]}`, () => {
        const dim = bedrockServer.level.getDimension(DimensionId.Overworld);
        if (dim === null) return [false, "Level.getDimension(0) returned null"];
        const want = +m[1];
        const phase = dim.getMoonPhase(), bright = dim.getMoonBrightness();
        const wantBright = [1, 0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75][want];
        return [phase === want && bright === wantBright, `getMoonPhase() ${phase} (want ${want}), getMoonBrightness() ${bright} (want ${wantBright}); time ${bedrockServer.level.getTime()}`];
    });
});
let round = 0;
events.command.on(cmd => {
    const c = cmd.replace(/^\//, "");
    if (c === "grprobe") {
        round++;
        const rules = bedrockServer.gameRules;
        attempt("object", () => {
            const p = rules as any as StaticPointer, l = pdbcache.layouts.GameRules;
            return [null, `${rules} vftable ${p.getPointer(0)} vector ${p.getPointer(l?.rules ?? 0x18)}..${p.getPointer((l?.rules ?? 0x18) + 8)} layout ${JSON.stringify(l)}`];
        });
        attempt("direct", () => {
            const out: string[] = [];
            for (const n of ["?getGameRules@Level@@UEAAAEAVGameRules@@XZ", "?getGameRules@Level@@UEBAAEBVGameRules@@XZ", "?getLevelData@Level@@UEAAAEAVLevelData@@XZ"]) {
                const fp = proc[n];
                const r = makefunc.js(fp, StaticPointer, null, VoidPointer)(bedrockServer.level);
                out.push(`${n.slice(1, 20)} fn ${fp} base ${dllraw.current} -> ${r} q0 ${r.getPointer(0)}`);
            }
            return [null, out.join(" | ")];
        });
        attempt("nameToGameRuleIndex", () => {
            const a = rules.nameToGameRuleIndex("doDaylightCycle"), b = rules.nameToGameRuleIndex("randomtickspeed"), n = rules.nameToGameRuleIndex("nosuchrule");
            return [a === GameRuleId.DoDaylightCycle && b === GameRuleId.RandomTickSpeed && n === -1, `doDaylightCycle ${a}, randomtickspeed ${b}, nosuchrule ${n}`];
        });
        attempt("hasRule", () => {
            const v = [rules.hasRule(0), rules.hasRule(GameRuleId.TntExplosionDropDecay), rules.hasRule(GameRuleId.TntExplosionDropDecay + 1), rules.hasRule(-1 as GameRuleId)];
            return [v[0] && v[1] && !v[2] && !v[3], `0 ${v[0]}, last ${v[1]}, last+1 ${v[2]}, -1 ${v[3]}`];
        });
        attempt("getRule out of range", () => {
            const r = rules.getRule(1000 as GameRuleId);
            return [r === null, String(r)];
        });
        // first round: a fresh world's defaults; second: what the console set in between
        const wantTick = round === 1 ? 1 : 7, wantKeep = round !== 1;
        attempt("getInt randomTickSpeed", () => {
            const v = rules.getRule(GameRuleId.RandomTickSpeed).getInt();
            return [v === wantTick, `${v} (want ${wantTick})`];
        });
        attempt("getBool keepInventory", () => {
            const v = rules.getRule(GameRuleId.KeepInventory).getBool();
            return [v === wantKeep, `${v} (want ${wantKeep})`];
        });
        attempt("getValue maxCommandChainLength", () => {
            const v = rules.getRule(GameRuleId.MaxCommandChainLength).getValue();
            return [v === 65535, String(v)];
        });
        attempt("getBool doDaylightCycle", () => {
            const v = rules.getRule(GameRuleId.DoDaylightCycle).getBool();
            return [v === true, String(v)];
        });
    } else if (c === "wxprobe") {
        attempt("Level.updateWeather", () => {
            const before = weatherEvents;
            bedrockServer.level.updateWeather(0, 1200, 0, 1200);
            return [weatherEvents === before + 1, `events ${before} -> ${weatherEvents}`];
        });
    } else if (c === "levelprobe" || c.startsWith("levelprobe ")) {
        const arg = c.slice("levelprobe".length).trim();
        const level = bedrockServer.level;
        attempt("getTime/setTime candidate", () => {
            const gt = rawAddr("LP_GETTIME"), st = rawAddr("LP_SETTIME");
            if (gt === null || st === null) return [null, "LP_GETTIME/LP_SETTIME not set"];
            const getTime = makefunc.js(gt, int32_t, { this: Level });
            const setTime = makefunc.js(st, void_t, { this: Level }, int32_t);
            const t = getTime.call(level);
            let advanceDetail = "first call";
            let advanceOk: boolean | null = null;
            if (lpFirstTime !== null) {
                const d = t - lpFirstTime;
                advanceOk = d > 0 && d < 100000;
                advanceDetail = `advanced ${d} since ${lpFirstTime}`;
            }
            lpFirstTime = t;
            const want = t + 4321;
            setTime.call(level, want);
            const back = getTime.call(level);
            setTime.call(level, t);
            const restored = getTime.call(level);
            const roundtrip = back === want && restored === t;
            const ok = advanceOk === null ? roundtrip : advanceOk && roundtrip;
            return [ok, `getTime=${t} (${advanceDetail}); roundtrip set ${want} -> read ${back}; restore -> ${restored}`];
        });
        if (arg === "explode") attempt("explode candidate", () => {
            const ex = rawAddr("LP_EXPLODE");
            if (ex === null) return [null, "LP_EXPLODE not set"];
            const explode = makefunc.js(ex, bool_t, { this: Level }, BlockSource, VoidPointer, Vec3, float32_t, bool_t, bool_t, float32_t, bool_t);
            const dim = level.getDimension(DimensionId.Overworld);
            if (dim === null) return [false, "Level.getDimension(0) returned null"];
            const region = dim.getBlockSource();
            const pos = Vec3.create(29.5, 67.5, 16.5);
            const r = explode.call(level, region, new VoidPointer(), pos, 1.5, false, true, 3.4e38, false);
            return [r === true, `explode(region, null, (29.5,67.5,16.5), r=1.5, fire=false, breaks=true) -> ${r}`];
        });
        else if (arg === "cleanup arm") attempt("levelCleanupQueueEntityRemoval arm", () => {
            if (cleanupHooked) return [null, `already armed, calls so far ${cleanupCalls}`];
            const addr = rawAddr("LP_CLEANUP");
            if (addr === null) return [null, "LP_CLEANUP not set"];
            const counter = makefunc.np(() => {
                cleanupCalls++;
                // printed immediately (not just on "levelprobe cleanup" readback) so a fire during
                // shutdown teardown, after the last console command, still lands in the raw .out log
                console.log(`[grprobe] INFO levelCleanupQueueEntityRemoval fired #${cleanupCalls}`);
            }, void_t, null);
            new ProcHacker<{ cleanup: NativePointer }>({ cleanup: addr as NativePointer }).hookingRawWithCallOriginal("cleanup", counter, [], []);
            cleanupHooked = true;
            return [true, `hooked ${addr}, register-preserving pass-through ahead of the moved original`];
        });
        else if (arg === "cleanup") attempt("levelCleanupQueueEntityRemoval count", () => {
            return [cleanupHooked ? null : false, `hooked=${cleanupHooked} calls=${cleanupCalls}`];
        });
        else if (arg === "sleep 0" || arg === "sleep 1") attempt("setShouldSendSleepMessage smoke", () => {
            const want = arg === "sleep 1";
            const L = pdbcache.layouts.ServerLevel ?? {};
            const M = pdbcache.layouts.ServerPlayerSleepManager ?? {};
            const mgrOff = L.mServerPlayerSleepManager ?? 0x880;
            const boolOff = M.sendSleepMessage ?? 0x1a9;
            const p = level as unknown as StaticPointer;
            const mgr = p.getPointer(mgrOff);
            if (mgr === null) return [false, `mgr pointer at +0x${mgrOff.toString(16)} is null`];
            const before: number[] = [mgr.getUint8(boolOff - 1), mgr.getUint8(boolOff), mgr.getUint8(boolOff + 1)];
            level.setShouldSendSleepMessage(want);
            const after: number[] = [mgr.getUint8(boolOff - 1), mgr.getUint8(boolOff), mgr.getUint8(boolOff + 1)];
            const ok = after[1] === (want ? 1 : 0) && after[0] === before[0] && after[2] === before[2];
            return [ok, `mgr=${mgr} before=[${before}] after=[${after}] want ${want ? 1 : 0} at +0x${boolOff.toString(16)}, neighbours unchanged`];
        });
    }
});
let lpFirstTime: number | null = null;
let cleanupCalls = 0;
let cleanupHooked = false;
function rawAddr(envName: string): VoidPointer | null {
    const s = process.env[envName];
    if (!s) return null;
    return dllraw.current.add(parseInt(s, 16));
}
let weatherEvents = 0;
// GR_NOHOOK=1 leaves the event uninstalled, to compare what `weather query` answers with and without the hook
if (!process.env.GR_NOHOOK) events.levelWeatherChange.on(ev => {
    weatherEvents++;
    say("levelWeatherChange", ev.level !== null && ev.level.equalsptr(bedrockServer.level), `#${weatherEvents} rain ${ev.rainLevel} for ${ev.rainTime}, lightning ${ev.lightningLevel} for ${ev.lightningTime}`);
});
console.log("[grprobe] loaded");
