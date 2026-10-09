// Reach vftables from live objects: capture `this` at exact hooks, then scan
// each captured object for the polymorphic objects it holds, two levels deep.
//
// Where instance-probe-launcher.js reads one instance per hook and its direct
// members, this one keeps every distinct object a hook hands over (one pig,
// one arrow, one player: each a different class, told apart by vptr) and
// follows what they hold:
//
//   INLINE  a table start stored inside the object past its own bases: an
//           embedded polymorphic member (Player's PlayerUIContainer)
//   MEM     a pointer to an object whose first qword is a table start: a
//           unique_ptr/raw member (Player -> GameMode, -> PlayerInventory)
//   MEM2    a pointer to a block whose first qwords point at such an object: a
//           weak_ptr's SharedCounter (Actor -> WeakRef<Dimension>), an owner
//           pointer's control block
//
// Every object reached is scanned in turn (depth RP_DEPTH, default 2, a
// smaller range), which is how Dimension -> BlockSource and PlayerInventory
// -> Inventory -> ItemStack come out. A vptr read this way is exact; the
// name is decided offline from the reach (which member of which class) and
// the slot count (RP_CONFIG.slotCount, printed on every line).
//
// RP_CONFIG:   { tableStarts: [rva...], slotCount: { rva: n } }
// RP_CAPTURES: [[label, rva, "rcx"|"rdx"]]  raw captures (12-byte hook, .pdata >= 32 bytes)
// RP_TICKS:    report + READY tick (default 200); RP_EVERY: rescan period after that (default 100)
// RP_SCAN:     bytes scanned in a captured object (default 0x1800); RP_CHILD_SCAN for reached ones (0x600)
// RP_NO_LEVEL: 1 keeps the Level as a call source but does not scan it (its subtree is thousands of lines)
// RP_CALL:     [[label, sourceLabelPrefix, {rva|slot, pos:[x,y,z]?, after:tick?}]] -- call a getter on a
//              reached object at every sweep: `rva` a function, `slot` an index into the object's own
//              vftable (Endstone's header order gives it), `pos` a BlockPos passed by pointer in rdx,
//              `after` the first tick it may run (an untrusted candidate goes last). The result is
//              remembered and scanned like a captured object.
// RP_EXPAND:   [labelPrefix...] -- objects whose std::vector members are walked element by element
//              (BlockPalette -> every Block -> its BlockLegacy); each element's first 0x40 bytes are
//              followed one hop, and classes are deduplicated by vptr as everywhere else.
// STR lines:   any "minecraft:"-prefixed string inside a scanned object (inline SSO) or one pointer
//              away (heap string): the name a BlockLegacy or an Item carries, which names its table.
// Output lines are tagged [rp]. Old embedded node: no ??, ?., BigInt.
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
const { procHacker, ProcHacker } = require("bdsx/prochacker");
const { asmcode } = require("bdsx/asm/asmcode");

const INVOKE = "std::thread::_Invoke<std::tuple<<lambda_261fc769b4b17f58193d57d5f3ee7db9> >,0>";
const TICK_TARGET = Number(process.env.RP_TICKS || 200);
const EVERY = Number(process.env.RP_EVERY || 100);
const SCAN = Number(process.env.RP_SCAN || 0x1800);
const CHILD_SCAN = Number(process.env.RP_CHILD_SCAN || 0x600);
const DEPTH = Number(process.env.RP_DEPTH || 2);
// RP_RESCAN_EVERY=N: every N ticks after READY the captured (depth-0) objects
// are scanned again and only lines not seen before are printed, tagged NEW --
// a member swapped by a console command (gamemode creative replaces the
// player's GameMode object) shows up that way.
const RESCAN_EVERY = Number(process.env.RP_RESCAN_EVERY || 0);
const NO_LEVEL = process.env.RP_NO_LEVEL === "1";
const CALLS = process.env.RP_CALL ? JSON.parse(fs.readFileSync(process.env.RP_CALL, "utf8")) : [];
// RP_WATCH=[[labelPrefix, bytes]]: at every sweep the object's first `bytes` are
// read; the first time as a full hex DUMP, afterwards as DIFF lines of the
// 8-byte words that changed since the previous sweep. A console command
// issued between two sweeps names the field it changed (docs/findings-layouts.md).
const WATCH = process.env.RP_WATCH ? JSON.parse(fs.readFileSync(process.env.RP_WATCH, "utf8")) : [];
const watchPrev = new Map();
function watch(tick) {
    for (const [pfx, bytes] of WATCH) {
        const o = sourceOf(pfx); if (o === null) continue;
        let buf; try { buf = o.ptr.getBuffer(bytes); } catch (e) { console.log(`[rp] WATCH ${pfx}: unreadable`); continue; }
        const hex = Array.prototype.map.call(buf, b => (b < 16 ? "0" : "") + b.toString(16)).join("");
        const prev = watchPrev.get(pfx);
        if (prev === undefined) console.log(`[rp] DUMP ${pfx} tick ${tick} ${hex}`);
        else { const d = []; for (let i = 0; i + 16 <= hex.length; i += 16) if (hex.substr(i, 16) !== prev.substr(i, 16)) d.push(`+${hex_(i / 2)}:${prev.substr(i, 16)}>${hex.substr(i, 16)}`); if (d.length) console.log(`[rp] DIFF ${pfx} tick ${tick} ${d.join(" ")}`); }
        watchPrev.set(pfx, hex);
    }
}
const hex_ = n => "0x" + n.toString(16);
const EXPAND = process.env.RP_EXPAND ? JSON.parse(fs.readFileSync(process.env.RP_EXPAND, "utf8")) : [];
const cfg = JSON.parse(fs.readFileSync(process.env.RP_CONFIG, "utf8"));
const starts = new Set(cfg.tableStarts);
const slotCount = cfg.slotCount || {};
const base = dllraw.current;
const hex = p => "0x" + p.toString(16);
const rvaOf = ptr => { if (ptr === null) return -1; const d = ptr.subBin(base.getAddressBin()); return d.getAddressHigh() === 0 ? d.getAddressLow() : -1; };
const tab = r => hex(r) + "(" + (slotCount[r] === undefined ? "?" : slotCount[r]) + ")";

// --- captures ---------------------------------------------------------------------
const CAPTURES = JSON.parse(fs.readFileSync(process.env.RP_CAPTURES, "utf8"));
const rawMap = {}; CAPTURES.forEach(([label, rva], i) => { rawMap["c" + i] = base.add(rva); });
const rawHacker = new ProcHacker(rawMap);
const slots = capi.malloc(8 * CAPTURES.length);
for (let i = 0; i < CAPTURES.length * 2; i++) slots.setInt32(0, i * 4);
CAPTURES.forEach(([label, rva, reg], i) => {
    const r = { rcx: Register.rcx, rdx: Register.rdx, r8: Register.r8, r9: Register.r9 }[reg || "rcx"];
    try {
        rawHacker.hookingRaw("c" + i, original => asm().mov_r_c(Register.rax, slots.add(i * 8)).mov_rp_r(Register.rax, 1, 0, r).jmp64(original, Register.rax).alloc("capture " + label));
        console.log(`[rp] hooked ${label} at ${hex(rva)} (${reg || "rcx"})`);
    } catch (err) { console.log(`[rp] FAILED to hook ${label}: ${(err && err.message) || err}`); }
});

// --- objects ----------------------------------------------------------------------
// key: pointer string; value: { label, ptr, vft, scanned }
const objects = new Map();
const seenVft = new Map();   // vft rva -> first label, so a second pig is not scanned twice
function remember(label, ptr, force) {
    if (ptr === null || ptr.isNull()) return null;
    const key = ptr.toString();
    if (objects.has(key)) return objects.get(key);
    let v; try { v = ptr.getPointer(0); } catch (e) { return null; }
    const r = rvaOf(v);
    if (!(r >= 0 && starts.has(r))) return null;
    const dup = seenVft.has(r);
    const o = { label, ptr, vft: r, scanned: dup && !force, dup, depth0: force || !label.includes("+"), lines: new Set() };
    objects.set(key, o);
    if (!dup) seenVft.set(r, label);
    console.log(`[rp] OBJ ${label} ptr=${ptr} vft=${tab(r)}${dup ? " (class already seen as " + seenVft.get(r) + ")" : ""}`);
    return o;
}
function poll() {
    for (let i = 0; i < CAPTURES.length; i++) {
        const p = slots.getPointer(i * 8);
        if (p === null || p.isNull()) continue;
        remember(CAPTURES[i][0], p, false);
    }
}
function scan(o, depth, rescan) {
    o.scanned = true;
    const range = depth === 0 ? SCAN : CHILD_SCAN;
    const children = [];
    const say = line => { if (o.lines.has(line)) return; o.lines.add(line); console.log(rescan ? line.replace("[rp] ", "[rp] NEW ") : line); };
    // strings: "minecraft:" inline (std::string SSO, 8-aligned) anywhere in the object
    let strs = 0;
    try {
        const buf = o.ptr.getBuffer(range);
        for (let i = 0; i + 10 <= buf.length && strs < 6; i += 8) {
            if (buf[i] === 0x6d && buf[i + 1] === 0x69 && buf[i + 2] === 0x6e && buf[i + 3] === 0x65 && buf[i + 4] === 0x63 && buf[i + 5] === 0x72 && buf[i + 6] === 0x61 && buf[i + 7] === 0x66 && buf[i + 8] === 0x74 && buf[i + 9] === 0x3a) {
                let j = i; let t = ""; while (j < buf.length && buf[j] >= 0x20 && buf[j] < 0x7f && t.length < 48) t += String.fromCharCode(buf[j++]);
                say(`[rp] STR ${o.label} +${hex(i)} "${t}"`); strs++;
            }
        }
    } catch (e) { /* unreadable tail: the per-qword loop below reports it */ }
    // only the named object itself is walked, never what it reaches (the
    // palette reaches the whole world), and never past DEPTH
    const expand = depth < DEPTH && EXPAND.some(pfx => o.label === pfx);
    for (let off = 0; off < range; off += 8) {
        let q; try { q = o.ptr.getPointer(off); } catch (e) { console.log(`[rp]   ${o.label}: unreadable at +${hex(off)}`); break; }
        if (q === null || q.isNull()) continue;
        const r0 = rvaOf(q);
        if (r0 >= 0) {
            // a pointer into the image: a vftable stored inline (a base subobject or an embedded polymorphic member)
            if (starts.has(r0) && off >= 8) say(`[rp] INLINE ${o.label} +${hex(off)} vft=${tab(r0)}`);
            continue;
        }
        // a heap pointer: a long string (heap std::string, 16+ chars) with the game's prefix?
        if (strs < 6) { try { const t = q.getString(10); if (t === "minecraft:") { say(`[rp] STR ${o.label} +${hex(off)} -> "${q.getString(48).replace(/[^\x20-\x7e].*$/, "")}"`); strs++; } } catch (e) { /* not a string */ } }
        // a std::vector<T*> (begin, end) with T polymorphic: walk it (RP_EXPAND)
        if (expand && off + 8 < range) {
            let end = null; try { end = o.ptr.getPointer(off + 8); } catch (e) { end = null; }
            if (end !== null && !end.isNull() && rvaOf(end) < 0) {
                const d = end.subBin(q.getAddressBin());
                const n = d.getAddressHigh() === 0 ? d.getAddressLow() / 8 : -1;
                if (n >= 2 && n <= 65536 && Number.isInteger(n)) {
                    let elems = 0, classes = 0;
                    for (let k = 0; k < n; k++) {
                        let e; try { e = q.getPointer(k * 8); } catch (ex) { break; }
                        if (e === null || e.isNull() || rvaOf(e) >= 0) continue;
                        let ev; try { ev = e.getPointer(0); } catch (ex) { continue; }
                        const er = rvaOf(ev); if (!(er >= 0 && starts.has(er))) continue;
                        elems++;
                        const c = remember(`${o.label}+${hex(off)}[${k}]`, e, false);
                        if (c && !c.scanned) { classes++; scan(c, DEPTH, false); }
                        // one hop into the element: a Block holds its BlockLegacy by reference
                        for (let o3 = 8; o3 < 0x40; o3 += 8) {
                            let m; try { m = e.getPointer(o3); } catch (ex) { break; }
                            if (m === null || m.isNull() || rvaOf(m) >= 0) continue;
                            let mv; try { mv = m.getPointer(0); } catch (ex) { continue; }
                            const mr = rvaOf(mv); if (!(mr >= 0 && starts.has(mr))) continue;
                            const cc = remember(`${o.label}+${hex(off)}[${k}]+${hex(o3)}`, m, false);
                            if (cc && !cc.scanned) { classes++; scan(cc, DEPTH, false); }
                        }
                    }
                    if (elems) say(`[rp] VEC ${o.label} +${hex(off)}: ${n} elements, ${elems} polymorphic, ${classes} new classes scanned`);
                    continue;
                }
            }
        }
        let v; try { v = q.getPointer(0); } catch (e) { continue; }
        const r1 = rvaOf(v);
        if (r1 >= 0 && starts.has(r1)) { say(`[rp] MEM ${o.label} +${hex(off)} -> obj vft=${tab(r1)}`); children.push([`${o.label}+${hex(off)}`, q]); continue; }
        // a block (control block, SharedCounter, holder) whose first qwords point at such an object
        for (let o2 = 0; o2 < 32; o2 += 8) {
            let q2; try { q2 = q.getPointer(o2); } catch (e) { break; }
            if (q2 === null || q2.isNull() || rvaOf(q2) >= 0) continue;
            let v2; try { v2 = q2.getPointer(0); } catch (e) { continue; }
            const r2 = rvaOf(v2);
            if (r2 >= 0 && starts.has(r2)) { say(`[rp] MEM2 ${o.label} +${hex(off)} -> blk+${hex(o2)} -> obj vft=${tab(r2)}`); children.push([`${o.label}+${hex(off)}/${hex(o2)}`, q2]); }
        }
    }
    if (depth < DEPTH) for (const [label, q] of children) { const c = remember(label, q, false); if (c && !c.scanned) scan(c, depth + 1, false); }
}
// A source is an object label, or a path "label+0xOFF[/0xOFF2]" read from the
// pointer itself: the object at that member may have been reached first by
// another route and carry that route's label.
function sourceOf(spec) {
    for (const o of objects.values()) if (o.label === spec) return o;
    let m = spec.match(/^(.*)\+0x([0-9a-f]+)(?:\/0x([0-9a-f]+))?$/);
    if (!m) { for (const o of objects.values()) if (o.label.startsWith(spec)) return o; return null; }
    const parent = sourceOf(m[1]);
    if (parent === null) return null;
    try {
        let q = parent.ptr.getPointer(parseInt(m[2], 16));
        if (m[3] !== undefined) q = q.getPointer(parseInt(m[3], 16));
        if (q === null || q.isNull()) return null;
        const known = objects.get(q.toString());
        return known || { label: spec, ptr: q };
    } catch (e) { return null; }
}
const called = new Set();
function calls(tick) {
    for (const [label, src, spec] of CALLS) {
        if (spec.after && tick < spec.after) continue;
        if (called.has(label + "@" + (spec.once ? "" : tick))) continue;
        const s = sourceOf(src);
        if (s === null) continue;
        try {
            let fn;
            if (spec.rva !== undefined) fn = base.add(spec.rva);
            else { const vft = s.ptr.getPointer(0); fn = vft.getPointer(spec.slot * 8); }
            let r;
            if (spec.pos) { const pos = capi.malloc(16); pos.setInt32(spec.pos[0], 0); pos.setInt32(spec.pos[1], 4); pos.setInt32(spec.pos[2], 8); r = makefunc.js(fn, StaticPointer, null, StaticPointer, StaticPointer)(s.ptr, pos); }
            else r = makefunc.js(fn, StaticPointer, null, StaticPointer)(s.ptr);
            if (r === null || r.isNull()) { console.log(`[rp] CALL ${label}: ${src} -> null`); continue; }
            if (spec.add) r = r.add(spec.add);
            let o = remember(label, r, true);
            // a result without a vftable (LevelData) is still an object the
            // watch and later calls may address by label
            if (o === null && !objects.has(r.toString())) { o = { label, ptr: r, vft: -1, scanned: true, dup: false, depth0: true, lines: new Set() }; objects.set(r.toString(), o); }
            console.log(`[rp] CALL ${label}: ${s.label} ${spec.rva !== undefined ? "rva " + hex(spec.rva) : "slot " + spec.slot} -> ${r}${o ? " vft=" + tab(o.vft) : " (no vftable)"}`);
            if (o && !o.scanned) scan(o, 0, false);
            called.add(label + "@" + (spec.once ? "" : tick));
        } catch (e) { console.log(`[rp] CALL ${label}: ${e.message}`); }
    }
}
function rescanAll(tag) {
    let n = 0;
    for (const o of objects.values()) if (o.depth0 && o.scanned) { scan(o, 0, true); n++; }
    console.log(`[rp] RESCAN ${tag}: ${n} objects`);
}
function sweep(tag, tick) {
    poll();
    try { calls(tick || 0); } catch (e) { console.log(`[rp] calls: ${e.message}`); }
    try { watch(tick || 0); } catch (e) { console.log(`[rp] watch: ${e.message}`); }
    let n = 0;
    for (const o of objects.values()) if (!o.scanned) { console.log(`[rp] ---- scan ${o.label} (${tag}) ----`); scan(o, 0, false); n++; }
    console.log(`[rp] SWEEP ${tag}: ${n} new objects scanned, ${objects.size} objects, ${seenVft.size} classes`);
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
asmcode.gameThreadStart = makefunc.np(() => console.log("[rp] game loop on the node thread"), void_t);
asmcode.gameThreadFinish = makefunc.np(() => { finished = true; console.log(`[rp] game loop returned; ${objects.size} objects, ${seenVft.size} classes seen`); }, void_t);
const replacement = asm().push_r(Register.rbx).sub_r_c(Register.rsp, 0x20).call64(asmcode.gameThreadHook, Register.rax).add_r_c(Register.rsp, 0x20).pop_r(Register.rbx).ret().alloc("game thread _Invoke replacement");
procHacker.hookingRaw(INVOKE, original => { asmcode.gameThreadInner = original; return replacement; });

let jsTicks = 0;
const originalTick = procHacker.hooking("?tick@Level@@UEAAXXZ", void_t, null, StaticPointer)(level => {
    jsTicks++;
    if (jsTicks === 1) { const o = remember("Level", level, true); if (o && NO_LEVEL) o.scanned = true; }
    if (jsTicks < TICK_TARGET) poll();
    if (jsTicks === TICK_TARGET) { sweep(`tick ${jsTicks}`, jsTicks); console.log("[rp] READY"); }
    if (jsTicks > TICK_TARGET && jsTicks % EVERY === 0) { try { sweep(`tick ${jsTicks}`, jsTicks); } catch (e) { console.log(`[rp] sweep: ${e.message}`); } }
    if (RESCAN_EVERY && jsTicks > TICK_TARGET && jsTicks % RESCAN_EVERY === 0) { try { rescanAll(`tick ${jsTicks}`); } catch (e) { console.log(`[rp] rescan: ${e.message}`); } }
    originalTick(level);
});

const unlock = new MemoryUnlocker(bedrock_server_exe.main, 12);
bedrock_server_exe.main.add().copyFrom(bedrock_server_exe.mainOriginal12Bytes, 12);
unlock.done();
const thunk = asm().mov_r_c(Register.rcx, bedrock_server_exe.argc).mov_r_c(Register.rdx, bedrock_server_exe.args).mov_r_c(Register.r8, 0).jmp64(bedrock_server_exe.main, Register.rax).alloc("bds main thunk");
dll.kernel32.CreateThread(null, 0, thunk, null, 0, null);
console.log("[rp] BDS thread started");
setInterval(() => {}, 1 << 30);
let afterStop = 0;
setInterval(() => { if (!finished) return; afterStop += 2; if (afterStop >= 6) { console.log("[rp] DONE"); process.exit(0); } }, 2000);
