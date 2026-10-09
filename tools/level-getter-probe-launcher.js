// Confirm newly named Level virtuals by calling them, not hooking them.
//
// tools/pairs-in-tables.mjs names a slot when a call-edge pair and vftable
// membership agree. For a getter the answer can be checked outright: the
// world's level.dat holds RandomSeed, SpawnX/Y/Z and Time, so getSeed,
// getDefaultSpawn and getTime have known values; setTime/getTime and
// setDefaultSpawn/getDefaultSpawn round-trip; getActiveUsers is an empty
// vector on a server with no players; the reference-returning getters must
// hand back a readable object, and its first qword is reported so a vftable
// it carries can be named offline.
//
// A call to a wrong address fails at the call, inside a try, on the game
// thread that already runs on the node thread; nothing is hooked except
// Level::tick, which is resolved. Output lines are tagged [lg].
// LG_CONFIG: { symbols: { decoratedName: rva }, levelDat: path }
// (bdsx-core embeds an old node: no ??, no ?. in this file)
"use strict";
const fs = require("fs");
const { bedrock_server_exe, uv_async, VoidPointer, StaticPointer, AllocatedPointer } = require("bdsx/core");
const { makefunc } = require("bdsx/makefunc");
const { void_t, int32_t, uint32_t } = require("bdsx/nativetype");
// pointer-returning getters come back as StaticPointer so the object can be read
const { MemoryUnlocker } = require("bdsx/unlocker");
const { asm, Register } = require("bdsx/assembler");
const { capi } = require("bdsx/capi");
const { dll } = require("bdsx/dll");
const { dllraw } = require("bdsx/dllraw");
const { procHacker } = require("bdsx/prochacker");
const { asmcode } = require("bdsx/asm/asmcode");

const INVOKE = "std::thread::_Invoke<std::tuple<<lambda_261fc769b4b17f58193d57d5f3ee7db9> >,0>";
const cfg = JSON.parse(fs.readFileSync(process.env.LG_CONFIG || require("path").join(process.env.BDSX_LAB || ".", "lg-config.json"), "utf8"));
const TICK_TARGET = Number(process.env.LG_TICKS || 200);
const base = dllraw.current;
const hex = p => "0x" + p.toString(16);
const rvaOf = ptr => { const d = ptr.subBin(base.getAddressBin()); return d.getAddressHigh() === 0 ? d.getAddressLow() : -1; };
const fn = (name, ret, ...params) => {
    const rva = cfg.symbols[name];
    if (rva === undefined) return null;
    return makefunc.js(base.add(rva), ret, null, VoidPointer, ...params);
};
const fnp = (name, ret, ...params) => fn(name, StaticPointer, ...params);

// --- level.dat: 8-byte header, then little-endian NBT; find a named tag ---------------
function datTag(buf, name, type) {
    const nb = Buffer.from(name, "latin1");
    let at = -1;
    while ((at = buf.indexOf(nb, at + 1)) >= 0) {
        if (at < 3 || buf.readUInt16LE(at - 2) !== nb.length || buf[at - 3] !== type) continue;
        const p = at + nb.length;
        if (type === 3) return buf.readInt32LE(p);
        if (type === 4) return { lo: buf.readUInt32LE(p), hi: buf.readUInt32LE(p + 4) };   // a double cannot hold a 64-bit seed
        if (type === 1) return buf[p];
    }
    return undefined;
}
let dat = {};
try {
    const buf = fs.readFileSync(cfg.levelDat);
    dat = { seed: datTag(buf, "RandomSeed", 4), spawnX: datTag(buf, "SpawnX", 3), spawnY: datTag(buf, "SpawnY", 3), spawnZ: datTag(buf, "SpawnZ", 3), time: datTag(buf, "Time", 4) };
    console.log(`[lg] level.dat: seed=${show64(dat.seed)} spawn=(${dat.spawnX},${dat.spawnY},${dat.spawnZ}) time=${show64(dat.time)}`);
} catch (err) { console.log(`[lg] level.dat unreadable: ${err.message}`); }

const G = {
    getTime: fn("?getTime@Level@@UEBAHXZ", int32_t),
    setTime: fn("?setTime@Level@@UEAAXH@Z", void_t, int32_t),
    getSeed: fn("?getSeed@Level@@UEAAIXZ", uint32_t),
    // a newer getSeed may return a 64-bit seed object through a hidden pointer in rdx
    getSeedHidden: fn("getSeed:hidden", uint32_t, VoidPointer),
    getDefaultSpawn: fnp("?getDefaultSpawn@Level@@UEBAAEBVBlockPos@@XZ", VoidPointer),
    setDefaultSpawn: fn("?setDefaultSpawn@Level@@UEAAXAEBVBlockPos@@@Z", void_t, VoidPointer),
    getActiveUsers: fnp("?getActiveUsers@Level@@UEBAAEBV?$vector@VWeakEntityRef@@V?$allocator@VWeakEntityRef@@@std@@@std@@XZ", VoidPointer),
    getAdventureSettings: fnp("?getAdventureSettings@Level@@UEAAAEAUAdventureSettings@@XZ", VoidPointer),
    getActorFactory: fnp("?getActorFactory@Level@@UEAAAEAVActorFactory@@XZ", VoidPointer),
    getBlockPalette: fnp("?getBlockPalette@Level@@UEAAAEAVBlockPalette@@XZ", VoidPointer),
    getActorInfoRegistry: fnp("?getActorInfoRegistry@Level@@UEAAPEAVActorInfoRegistry@@XZ", VoidPointer),
};
console.log(`[lg] functions configured: ${Object.entries(G).filter(([, f]) => f).map(([n]) => n).join(" ")}`);
const results = {};
const say = (name, ok, detail) => { results[name] = ok; console.log(`[lg] ${ok === true ? "PASS" : ok === false ? "FAIL" : "info"} ${name}: ${detail}`); };
const tryCall = (name, f) => { try { return f(); } catch (err) { say(name, false, `threw ${(err && err.message) || err}`); return undefined; } };
const low32 = b => typeof b === "object" ? b.lo : ((b % 4294967296) + 4294967296) % 4294967296;   // no BigInt in the embedded node
const show64 = b => typeof b === "object" ? `hi ${b.hi} lo ${b.lo}` : String(b);
const sameLow32 = (a, b) => (a >>> 0) === low32(b);

let firstTime = null, firstTick = 0;
function probe(level, tick) {
    if (!firstTick) firstTick = tick;
    if (G.getTime) {
        const t = tryCall("getTime", () => G.getTime(level));
        if (t !== undefined) {
            if (firstTime === null) { firstTime = t; say("getTime", dat.time === undefined ? undefined : (dat.time.hi === 0 && t >= dat.time.lo), `${t} (level.dat had ${show64(dat.time)})`); }
            else { const d = t - firstTime, dt = tick - firstTick; say("getTime advances per tick", Math.abs(d - dt) <= 2, `+${d} over ${dt} ticks (${firstTime} -> ${t})`); }
        }
        if (G.setTime && t !== undefined && firstTick === tick) {
            const want = t + 12345;
            tryCall("setTime", () => G.setTime(level, want));
            const back = tryCall("getTime after setTime", () => G.getTime(level));
            say("setTime/getTime round trip", back === want, `set ${want}, read ${back}`);
            tryCall("setTime restore", () => G.setTime(level, t));
            const again = tryCall("getTime", () => G.getTime(level)); firstTime = again === undefined ? t : again;
        }
    }
    if (G.getSeed && firstTick === tick) {
        const s = tryCall("getSeed", () => G.getSeed(level));
        if (s !== undefined) say("getSeed", dat.seed === undefined ? undefined : sameLow32(s, dat.seed), `${s} (level.dat RandomSeed ${show64(dat.seed)})`);
    }
    if (G.getSeedHidden && firstTick === tick) {
        const buf = capi.malloc(32); for (let i = 0; i < 32; i += 4) buf.setInt32(0, i);
        const eax = tryCall("getSeed:hidden", () => G.getSeedHidden(level, buf));
        if (eax !== undefined) { const lo = buf.getUint32(0), hi = buf.getUint32(4); say("getSeed:hidden", dat.seed === undefined ? undefined : (lo === dat.seed.lo && hi === dat.seed.hi), `buffer lo ${lo} hi ${hi}, eax ${eax} (level.dat RandomSeed ${show64(dat.seed)})`); }
    }
    if (G.getDefaultSpawn && firstTick === tick) {
        const p = tryCall("getDefaultSpawn", () => G.getDefaultSpawn(level));
        if (p) {
            let x, y, z; try { x = p.getInt32(0); y = p.getInt32(4); z = p.getInt32(8); } catch (err) { say("getDefaultSpawn", false, `unreadable ${err.message}`); }
            if (x !== undefined) {
                say("getDefaultSpawn", dat.spawnX === undefined ? undefined : x === dat.spawnX && z === dat.spawnZ, `(${x},${y},${z}) (level.dat (${dat.spawnX},${dat.spawnY},${dat.spawnZ}))`);
                if (G.setDefaultSpawn) {
                    const tmp = capi.malloc(12); tmp.setInt32(x + 7, 0); tmp.setInt32(y, 4); tmp.setInt32(z - 3, 8);
                    tryCall("setDefaultSpawn", () => G.setDefaultSpawn(level, tmp));
                    const q = tryCall("getDefaultSpawn after set", () => G.getDefaultSpawn(level));
                    const rx = q && q.getInt32(0), rz = q && q.getInt32(8);
                    say("setDefaultSpawn/getDefaultSpawn round trip", rx === x + 7 && rz === z - 3, `set (${x + 7},${y},${z - 3}), read (${rx},${q && q.getInt32(4)},${rz})`);
                    tmp.setInt32(x, 0); tmp.setInt32(z, 8);
                    tryCall("setDefaultSpawn restore", () => G.setDefaultSpawn(level, tmp));
                }
            }
        }
    }
    if (G.getActiveUsers && firstTick === tick) {
        const v = tryCall("getActiveUsers", () => G.getActiveUsers(level));
        if (v) try {
            const b = v.getPointer(0), e = v.getPointer(8), c = v.getPointer(16);
            const size = e.subBin(b.getAddressBin()).getAddressLow(), cap = c.subBin(b.getAddressBin()).getAddressLow();
            say("getActiveUsers", size === 0 && cap >= 0 && cap < 0x100000, `vector bytes used ${size}, capacity bytes ${cap} (no players connected)`);
        } catch (err) { say("getActiveUsers", false, `unreadable ${err.message}`); }
    }
    for (const name of ["getAdventureSettings", "getActorFactory", "getBlockPalette", "getActorInfoRegistry"]) {
        if (!G[name] || firstTick !== tick) continue;
        const p = tryCall(name, () => G[name](level));
        if (p === undefined) continue;
        if (p === null) { say(name, false, "returned null"); continue; }
        try {
            const first = p.getPointer(0);
            const r = first ? rvaOf(first) : -1;
            const pr = rvaOf(p);
            say(name, true, `object at ${pr >= 0 ? "image rva " + hex(pr) : "heap " + hex(p.getAddressHigh()) + hex(p.getAddressLow()).slice(2)}, first qword ${first ? hex(first.getAddressHigh()) + hex(first.getAddressLow()).slice(2) : "null"}${r >= 0 ? ` = image rva ${hex(r)}` : ""}`);
        } catch (err) { say(name, false, `unreadable ${err.message}`); }
    }
}

// --- game thread on the node thread (as the other probe launchers) ----------------------
asmcode.evWaitGameThreadEnd = dll.kernel32.CreateEventW(null, 0, 0, null);
asmcode.SetEvent = dll.kernel32.SetEvent.pointer;
asmcode.CloseHandle = dll.kernel32.CloseHandle.pointer;
asmcode.CreateEventW = dll.kernel32.CreateEventW.pointer;
asmcode.WaitForSingleObject = dll.kernel32.WaitForSingleObject.pointer;
asmcode._Cnd_do_broadcast_at_thread_exit = dll.msvcp140._Cnd_do_broadcast_at_thread_exit;
asmcode.free = dll.ucrtbase.free.pointer;
uv_async.open();
asmcode.gameThreadStart = makefunc.np(() => console.log("[lg] game loop on the node thread"), void_t);
asmcode.gameThreadFinish = makefunc.np(() => console.log("[lg] game loop returned"), void_t);
const replacement = asm().push_r(Register.rbx).sub_r_c(Register.rsp, 0x20).call64(asmcode.gameThreadHook, Register.rax).add_r_c(Register.rsp, 0x20).pop_r(Register.rbx).ret().alloc("game thread _Invoke replacement");
procHacker.hookingRaw(INVOKE, original => { asmcode.gameThreadInner = original; return replacement; });

// LG_RAW=[[label, slotIndex, "int"|"ptr", dumpBytes?, followOffset?]]: call a slot of the live Level's own
// table by index (no address needed), every LG_EVERY ticks from tick 60 on, and
// print what comes back -- an int, or a pointer with its first two qwords (the
// first as an RVA too, so a vftable it carries can be named). For settling
// which of two adjacent slots is a getter by the value it returns under a
// console command (difficulty, time). Only for slots whose body is a getter.
const RAW = process.env.LG_RAW ? JSON.parse(fs.readFileSync(process.env.LG_RAW, "utf8")) : [];
const RAW_EVERY = Number(process.env.LG_EVERY || 100);
const rawFns = new Map();
function rawProbe(level, tick) {
    const vt = level.getPointer(0);
    for (const e of RAW) {
        const label = e[0], slot = e[1], kind = e[2];
        try {
            const fp = vt.getPointer(slot * 8);
            // [label, slot, "sret", intArg]: a slot that returns a 16-byte value through a hidden pointer and
            // takes one int -- getDimension(id) and its kin. Prints the two qwords written (a WeakRef that
            // found nothing stays zero); the reference it may hold is leaked, which a probe can afford.
            if (kind === "sret") {
                const k2 = slot + "sret";
                if (!rawFns.has(k2)) rawFns.set(k2, makefunc.js(fp, VoidPointer, null, VoidPointer, StaticPointer, int32_t));
                const buf = new AllocatedPointer(32); buf.fill(0, 32);
                rawFns.get(k2)(level, buf, e[3]);
                console.log(`[lg] RAW tick ${tick} slot ${slot} ${label} (fn ${hex(rvaOf(fp))}) arg ${e[3]}: ${buf.getPointer(0)} ${buf.getPointer(8)}`);
                continue;
            }
            const key = slot + kind;
            if (!rawFns.has(key)) rawFns.set(key, makefunc.js(fp, kind === "int" ? int32_t : StaticPointer, null, VoidPointer));
            const r = rawFns.get(key)(level);
            let out;
            if (kind === "int") out = String(r);
            else if (r === null || r.isNull()) out = "null";
            else { let q0 = "?", q1 = "?", i0 = "?"; try { const p0 = r.getPointer(0); q0 = hex(rvaOf(p0)) + "/" + p0; i0 = r.getInt32(0) + "," + r.getInt32(4); q1 = String(r.getPointer(8)); } catch (err) { q0 = "unreadable"; } out = `${r} q0=${q0} int32x2=${i0} q1=${q1}`; }
            console.log(`[lg] RAW tick ${tick} slot ${slot} ${label} (fn ${hex(rvaOf(fp))}): ${out}`);
            // a fourth element dumps that many bytes of the returned object, once (every time if 32 or fewer:
            // a vector's three pointers, to watch it grow when a client joins)
            if (kind === "ptr" && e[3] > 0 && r !== null && !r.isNull() && (!e.dumped || e[3] <= 32)) {
                e.dumped = true;
                // a fifth element is an offset to follow first: the dump is of *(r + e[4])
                const src = e[4] === undefined ? r : r.getPointer(e[4]);
                for (let o = 0; o < e[3]; o += 16) { const b = []; let t = ""; for (let i = 0; i < 16; i++) { const c = src.getUint8(o + i); b.push(c.toString(16).padStart(2, "0")); t += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "."; } console.log(`[lg] DUMP slot ${slot} +0x${o.toString(16).padStart(3, "0")} ${b.join(" ")}  ${t}`); }
            }
        } catch (err) { console.log(`[lg] RAW tick ${tick} slot ${slot} ${label} threw ${(err && err.message) || err}`); }
    }
}
let jsTicks = 0;
const originalTick = procHacker.hooking("?tick@Level@@UEAAXXZ", void_t, null, StaticPointer)(level => {
    jsTicks++;
    if (jsTicks === 1) console.log("[lg] first Level::tick reached JavaScript");
    if (jsTicks === 60 || jsTicks === TICK_TARGET - 20) try { probe(level, jsTicks); } catch (err) { console.log(`[lg] ERROR in probe: ${(err && err.stack) || err}`); }
    if (RAW.length && jsTicks >= 60 && jsTicks % RAW_EVERY === 0) try { rawProbe(level, jsTicks); } catch (err) { console.log(`[lg] ERROR in rawProbe: ${(err && err.stack) || err}`); }
    if (jsTicks === TICK_TARGET) {
        const names = Object.keys(results), pass = names.filter(n => results[n] === true).length, fail = names.filter(n => results[n] === false).length;
        console.log(`[lg] SUMMARY pass ${pass} fail ${fail} info ${names.length - pass - fail}`);
        console.log("[lg] DONE"); process.exit(0);
    }
    originalTick(level);
});

const unlock = new MemoryUnlocker(bedrock_server_exe.main, 12);
bedrock_server_exe.main.add().copyFrom(bedrock_server_exe.mainOriginal12Bytes, 12);
unlock.done();
const thunk = asm().mov_r_c(Register.rcx, bedrock_server_exe.argc).mov_r_c(Register.rdx, bedrock_server_exe.args).mov_r_c(Register.r8, 0).jmp64(bedrock_server_exe.main, Register.rax).alloc("bds main thunk");
dll.kernel32.CreateThread(null, 0, thunk, null, 0, null);
console.log("[lg] BDS thread started");
setInterval(() => {}, 1 << 30);
