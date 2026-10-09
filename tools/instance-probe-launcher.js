// Harvest instance pointers from the resolved hooks and read their vftables.
//
// Every resolved method that takes `this` hands over an instance of its class
// when it runs, and *(void**)instance is that class's vftable, exactly. The
// hooks are raw -- rcx and rdx are stored into a slot and the original is
// jumped to -- so nothing runs on the game thread that is not native.
//
//   CommandRegistry::registerCommand         rcx = CommandRegistry*      (startup)
//   ServerNetworkHandler::updateServerAnnouncement  rcx = ServerNetworkHandler* (periodic)
//   MinecraftCommands::executeCommand        rcx = MinecraftCommands*    (on a command)
//   Command::run                             rdx = CommandOrigin*        (on a command)
//   DedicatedServer::stop                    rcx = DedicatedServer*      (on stop)
//   Level::tick                              rcx = Level*                (every tick)
//
// For each captured pointer the first 16 qwords are read and every one that
// is a code-referenced pointer-table start (IP_CONFIG.tableStarts) is
// reported with its offset: a class with several bases has a vftable at each
// base subobject, and the offset is what tells them apart.
//
// Output lines are tagged [ip]. Prints "[ip] READY" after IP_TICKS ticks so
// run-shutdown.ps1 can drive a real "stop", which is when executeCommand,
// Command::run and DedicatedServer::stop fire.
"use strict";
const fs = require("fs");
const { bedrock_server_exe, uv_async, StaticPointer } = require("bdsx/core");
const { makefunc } = require("bdsx/makefunc");
const { void_t } = require("bdsx/nativetype");
const { MemoryUnlocker } = require("bdsx/unlocker");
const { asm, Register } = require("bdsx/assembler");
const { capi } = require("bdsx/capi");
const { dll } = require("bdsx/dll");
const { dllraw } = require("bdsx/dllraw");
const { procHacker } = require("bdsx/prochacker");
const { asmcode } = require("bdsx/asm/asmcode");

const INVOKE = "std::thread::_Invoke<std::tuple<<lambda_261fc769b4b17f58193d57d5f3ee7db9> >,0>";
const TICK_TARGET = Number(process.env.IP_TICKS || 200);
const cfg = JSON.parse(fs.readFileSync(process.env.IP_CONFIG, "utf8"));
const starts = new Set(cfg.tableStarts);
const base = dllraw.current;
const hex = p => "0x" + p.toString(16);
const rvaOf = ptr => { if (ptr === null) return -1; const d = ptr.subBin(base.getAddressBin()); return d.getAddressHigh() === 0 ? d.getAddressLow() : -1; };

// IP_CAPTURES=<json file of [label, rva, "rcx"|"rdx"]>: extra captures at raw
// addresses (candidates that have no symbol yet, e.g. the function that
// constructs MinecraftCommands, whose `this` is the Minecraft instance).
const EXTRA = process.env.IP_CAPTURES ? JSON.parse(fs.readFileSync(process.env.IP_CAPTURES, "utf8")) : [];
const CAPTURES = [
    ["?registerCommand@CommandRegistry@@QEAAXAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@PEBDW4CommandPermissionLevel@@UCommandFlag@@3@Z", "CommandRegistry (rcx)", Register.rcx],
    ["?updateServerAnnouncement@ServerNetworkHandler@@QEAAXXZ", "ServerNetworkHandler (rcx)", Register.rcx],
    ["?executeCommand@MinecraftCommands@@QEBA?AUMCRESULT@@AEAVCommandContext@@_N@Z", "MinecraftCommands (rcx)", Register.rcx],
    ["?run@Command@@QEBAXAEBVCommandOrigin@@AEAVCommandOutput@@@Z", "CommandOrigin (rdx of Command::run)", Register.rdx],
    ["?run@Command@@QEBAXAEBVCommandOrigin@@AEAVCommandOutput@@@Z", "Command (rcx of Command::run)", Register.rcx],
    ["?stop@DedicatedServer@@UEAA_NXZ", "DedicatedServer (rcx of stop)", Register.rcx],
    ...EXTRA.map(([label, rva, reg]) => ["raw:" + rva, label, { rcx: Register.rcx, rdx: Register.rdx, r8: Register.r8, r9: Register.r9 }[reg || "rcx"]]),
];
const rawMap = {}; for (const [label, rva] of EXTRA) rawMap["raw:" + rva] = base.add(rva);
const rawHacker = new (require("bdsx/prochacker").ProcHacker)(rawMap);
const slots = capi.malloc(8 * CAPTURES.length);
for (let i = 0; i < CAPTURES.length * 2; i++) slots.setInt32(0, i * 4);
const hooked = new Set();
for (let i = 0; i < CAPTURES.length; i++) {
    const [sym, label, reg] = CAPTURES[i];
    const slot = slots.add(i * 8);
    if (hooked.has(sym)) {
        // second capture from the same hook: chain it into the first one's code
        continue;
    }
    hooked.add(sym);
    const twins = CAPTURES.map((c, k) => [c, k]).filter(([c]) => c[0] === sym);
    try {
        (sym.startsWith("raw:") ? rawHacker : procHacker).hookingRaw(sym, original => {
            let code = asm();
            for (const [c, k] of twins) code = code.mov_r_c(Register.rax, slots.add(k * 8)).mov_rp_r(Register.rax, 1, 0, c[2]);
            return code.jmp64(original, Register.rax).alloc("capture " + label);
        });
        console.log(`[ip] hooked ${twins.map(([c]) => c[1]).join(" + ")}`);
    } catch (err) {
        console.log(`[ip] FAILED to hook ${label}: ${(err && err.message) || err}`);
    }
}

// IP_PROBES=<json file of [name, rva]>: counter probes, reported with the
// instances. Constructors count at startup, destructors only after "stop".
const PROBES = process.env.IP_PROBES ? JSON.parse(fs.readFileSync(process.env.IP_PROBES, "utf8")) : [];
const counters = capi.malloc(8 * Math.max(1, PROBES.length));
for (let i = 0; i < PROBES.length * 2; i++) counters.setInt32(0, i * 4);
const { ProcHacker } = require("bdsx/prochacker");
const { OperationSize } = require("bdsx/assembler");
{
    const map = {}; for (const [name, rva] of PROBES) map[name] = base.add(rva);
    const ph = new ProcHacker(map);
    PROBES.forEach(([name, rva], i) => {
        const slot = counters.add(i * 8);
        try { ph.hookingRaw(name, original => asm().mov_r_c(Register.rax, slot).inc_rp(Register.rax, 1, 0, OperationSize.qword).jmp64(original, Register.rax).alloc("probe " + name)); }
        catch (err) { console.log(`[ip] probe FAILED ${hex(rva)} ${name}: ${(err && err.message) || err}`); }
    });
    if (PROBES.length) console.log(`[ip] ${PROBES.length} counter probes installed`);
}
function describe(label, ptr) {
    if (ptr === null || ptr.isNull()) { console.log(`[ip] ${label}: not captured`); return; }
    const found = [];
    for (let off = 0; off < 16 * 8; off += 8) {
        let q; try { q = ptr.getPointer(off); } catch (e) { break; }
        const r = rvaOf(q);
        if (r >= 0 && starts.has(r)) found.push(`+0x${off.toString(16)}=${hex(r)}`);
    }
    console.log(`[ip] ${label}: instance ${ptr} vftables ${found.length ? found.join(" ") : "none in the first 16 qwords"}`);
    // IP_DUMP=N: the first N bytes as hex, 32 per line, for value-type captures
    // (a NetworkIdentifier has no vftable; its type field and GUID are what matter)
    const DUMP = Number(process.env.IP_DUMP || 0);
    for (let off = 0; off < DUMP; off += 32) {
        let line = ""; for (let i = 0; i < 32 && off + i < DUMP; i++) { let b; try { b = ptr.getUint8(off + i); } catch (e) { break; } line += (b < 16 ? "0" : "") + b.toString(16) + (i % 8 === 7 ? "  " : " "); }
        console.log(`[ip]   ${label.split(" ")[0]} +0x${off.toString(16).padStart(3, "0")}: ${line}`);
    }
    // members: every qword in the first IP_SCAN bytes that points at an object
    // whose first qword is a table start. MinecraftCommands holds a Minecraft*,
    // ServerNetworkHandler holds the GameCallbacks& that is the ServerInstance.
    const SCAN = Number(process.env.IP_SCAN || 0x300);
    const members = [];
    for (let off = 0; off < SCAN; off += 8) {
        let q; try { q = ptr.getPointer(off); } catch (e) { break; }
        if (q === null || q.isNull()) continue;
        if (rvaOf(q) >= 0) continue; // a pointer into the image, not an object
        let v; try { v = q.getPointer(0); } catch (e) { continue; }
        const r = rvaOf(v);
        if (r >= 0 && starts.has(r)) members.push(`+0x${off.toString(16)}->obj(vft ${hex(r)})`);
    }
    if (members.length) console.log(`[ip]   members of ${label.split(" ")[0]}: ${members.join(" ")}`);
}
// IP_FOLLOW=<json [[label, sourceLabelPrefix, offset]]>: dereference a member
// of a captured instance and describe the object it points to.
// IP_CALL=<json [[label, fnRva, sourceLabelPrefix, addOffset]]>: call fn(this)
// on a captured instance (a pointer-returning getter) and describe the result
// plus addOffset. "Level" as source is the Level from the tick hook.
const FOLLOW = process.env.IP_FOLLOW ? JSON.parse(fs.readFileSync(process.env.IP_FOLLOW, "utf8")) : [];
const CALL = process.env.IP_CALL ? JSON.parse(fs.readFileSync(process.env.IP_CALL, "utf8")) : [];
let levelPtr = null;
const followed = {};   // FOLLOW label -> pointer, so a CALL can start from a followed object
function sourceOf(prefix) {
    if (prefix === "Level") return levelPtr;
    for (const k of Object.keys(followed)) if (k.startsWith(prefix)) return followed[k];
    const i = CAPTURES.findIndex(c => c[1].startsWith(prefix));
    return i < 0 ? null : slots.getPointer(i * 8);
}
function extras() {
    for (const [label, src, off] of FOLLOW) {
        const s = sourceOf(src);
        if (s === null || s.isNull()) { console.log(`[ip] ${label}: source ${src} not captured`); continue; }
        try { const q = s.getPointer(off); followed[label] = q; describe(label, q); } catch (e) { console.log(`[ip] ${label}: ${e.message}`); }
    }
    // [label, rva, src, add, mode]: mode "hidden" calls the function as
    // `void f(this, ret*)` -- a struct such as NonOwnerPointer<T> returned
    // through a hidden pointer in rdx -- and takes the struct's first qword.
    for (const [label, rva, src, add, mode] of CALL) {
        const s = sourceOf(src);
        if (s === null || s.isNull()) { console.log(`[ip] ${label}: source ${src} not captured`); continue; }
        try {
            let r;
            if (mode === "hidden") { const buf = capi.malloc(32); for (let i = 0; i < 32; i += 4) buf.setInt32(0, i); makefunc.js(base.add(rva), void_t, null, StaticPointer, StaticPointer)(s, buf); r = buf.getPointer(0); console.log(`[ip] ${label}: hidden-return struct qwords ${buf.getPointer(0)} ${buf.getPointer(8)}`); }
            else r = makefunc.js(base.add(rva), StaticPointer, null, StaticPointer)(s);
            describe(label, r === null ? null : r.add(add || 0));
        } catch (e) { console.log(`[ip] ${label}: ${e.message}`); }
    }
}
// Which captured or followed object holds a pointer to which other: the
// first IP_SCAN bytes of every object are searched for every other object's
// address, which is how a getter's member offset is read rather than inferred.
function crossRefs() {
    const objs = [];
    for (let i = 0; i < CAPTURES.length; i++) { const p = slots.getPointer(i * 8); if (p !== null && !p.isNull()) objs.push([CAPTURES[i][1].split(" ")[0], p]); }
    if (levelPtr !== null) objs.push(["Level", levelPtr]);
    for (const [k, p] of Object.entries(followed)) if (p !== null && !p.isNull()) objs.push([k.split(" ")[0], p]);
    const SCAN = Number(process.env.IP_SCAN || 0x300);
    for (const [an, a] of objs) for (const [bn, b] of objs) {
        if (an === bn) continue;
        for (let off = 0; off < SCAN; off += 8) {
            let q; try { q = a.getPointer(off); } catch (e) { break; }
            if (q === null || q.isNull()) continue;
            if (q.equalsptr(b)) { console.log(`[ip] ${an} +0x${off.toString(16)} -> ${bn}`); continue; }
            // one level down: a holder block (an owner pointer's control block has
            // no vftable, so the member scan cannot see it) whose first qwords
            // point at the object
            if (rvaOf(q) >= 0) continue;
            for (let o2 = 0; o2 < 64; o2 += 8) {
                let q2; try { q2 = q.getPointer(o2); } catch (e) { break; }
                if (q2 !== null && q2.equalsptr(b)) console.log(`[ip] ${an} +0x${off.toString(16)} -> block, block +0x${o2.toString(16)} -> ${bn}`);
            }
        }
    }
}
function report(tag) {
    console.log(`[ip] ---- instances ${tag} ----`);
    for (let i = 0; i < CAPTURES.length; i++) describe(CAPTURES[i][1], slots.getPointer(i * 8));
    for (let i = 0; i < PROBES.length; i++) console.log(`[ip]   ${String(counters.getUint32(i * 8) + counters.getUint32(i * 8 + 4) * 0x100000000).padStart(6)}  ${hex(PROBES[i][1])}  ${PROBES[i][0]}`);
    extras();
}

// --- game thread hook ---------------------------------------------------------------
asmcode.evWaitGameThreadEnd = dll.kernel32.CreateEventW(null, 0, 0, null);
asmcode.SetEvent = dll.kernel32.SetEvent.pointer;
asmcode.CloseHandle = dll.kernel32.CloseHandle.pointer;
asmcode.CreateEventW = dll.kernel32.CreateEventW.pointer;
asmcode.WaitForSingleObject = dll.kernel32.WaitForSingleObject.pointer;
asmcode._Cnd_do_broadcast_at_thread_exit = dll.msvcp140._Cnd_do_broadcast_at_thread_exit;
asmcode.free = dll.ucrtbase.free.pointer;
uv_async.open();
let finished = false;
asmcode.gameThreadStart = makefunc.np(() => console.log("[ip] game loop on the node thread"), void_t);
asmcode.gameThreadFinish = makefunc.np(() => { finished = true; console.log("[ip] game loop returned"); report("after shutdown"); }, void_t);
const replacement = asm().push_r(Register.rbx).sub_r_c(Register.rsp, 0x20).call64(asmcode.gameThreadHook, Register.rax).add_r_c(Register.rsp, 0x20).pop_r(Register.rbx).ret().alloc("game thread _Invoke replacement");
procHacker.hookingRaw(INVOKE, original => { asmcode.gameThreadInner = original; return replacement; });

let jsTicks = 0;
const originalTick = procHacker.hooking("?tick@Level@@UEAAXXZ", void_t, null, StaticPointer)(level => {
    jsTicks++;
    if (jsTicks === 1) { levelPtr = level; describe("Level (rcx of tick)", level); }
    if (jsTicks === TICK_TARGET) { report(`at tick ${jsTicks}`); try { crossRefs(); } catch (e) { console.log(`[ip] crossRefs: ${e.message}`); } console.log("[ip] READY"); }
    // IP_REPORT_EVERY=N: the counters again every N ticks after READY, so a
    // probe's calls can be placed in time against the driver's commands
    const EVERY = Number(process.env.IP_REPORT_EVERY || 0);
    if (EVERY && jsTicks > TICK_TARGET && jsTicks % EVERY === 0) { const line = PROBES.map((p, i) => `${p[0].slice(1, p[0].indexOf("@@"))}=${counters.getUint32(i * 8)}`).join(" "); console.log(`[ip] COUNTS tick ${jsTicks}: ${line}`); }
    originalTick(level);
});

const unlock = new MemoryUnlocker(bedrock_server_exe.main, 12);
bedrock_server_exe.main.add().copyFrom(bedrock_server_exe.mainOriginal12Bytes, 12);
unlock.done();
const thunk = asm().mov_r_c(Register.rcx, bedrock_server_exe.argc).mov_r_c(Register.rdx, bedrock_server_exe.args).mov_r_c(Register.r8, 0).jmp64(bedrock_server_exe.main, Register.rax).alloc("bds main thunk");
dll.kernel32.CreateThread(null, 0, thunk, null, 0, null);
console.log("[ip] BDS thread started");
setInterval(() => {}, 1 << 30);
let afterStop = 0;
setInterval(() => { if (!finished) return; afterStop += 2; if (afterStop >= 6) { console.log("[ip] DONE"); process.exit(0); } }, 2000);
