// std::_Allocate over the ucrt heap (docs/findings-utils.md, "std::_Allocate and the heap
// underneath BDS"). 1.26 has no address for the name, so bdsx writes the body itself over
// capi.malloc; what has to be checked is not that it returns memory but that it returns memory
// **on BDS's heap**, laid out the way std::_Allocate lays it out. Three things can be wrong and
// only execution tells them apart:
//   - the heap: BDS frees what bdsx allocated, so a mismatch faults inside free()
//   - the >= 4096 path: the returned pointer must be 32-byte aligned with the real block at [-8],
//     or deallocate frees a pointer that is not an allocation
//   - the small path: plain malloc, freed by capi.free with no header
// Deployed as zz-allocprobe.ts; console: "allocprobe", then "allocprobe pk" and "allocprobe packet"
// (both need a player). "pk" builds and frees a packet without sending it; "packet" is the whole
// ServerPlayer::setAttribute, which also sends.
import { AttributeId } from "bdsx/bds/attribute";
import { AttributeData, UpdateAttributesPacket } from "bdsx/bds/packets";
import { Player } from "bdsx/bds/player";
import { CxxVector } from "bdsx/cxxvector";
import { events } from "bdsx/event";
import { NativeType, int32_t } from "bdsx/nativetype";
import { CxxStringWrapper } from "bdsx/pointer";
import { StaticPointer } from "bdsx/core";
import { asm, Register } from "bdsx/assembler";
import { procHacker } from "bdsx/bds/proc";
import "bdsx/makefunc"; // X64Assembler.prototype.alloc

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

const CxxVector$int32 = CxxVector.make(int32_t);

events.command.on(cmd => {
    const m = cmd.replace(/^\//, "").match(/^allocprobe(?:\s+(\S+))?$/);
    if (m === null) return;
    const step = m[1] ?? "heap";
    if (step === "pk0") {
        // The control: BDS creates the packet and BDS destroys it, with nothing of bdsx's inside.
        // If this dies, the packet path is broken on its own and the allocator is not implicated.
        try {
            const pk = UpdateAttributesPacket.allocate();
            // BDS built this one, so its bytes are the real 1.26 layout: what bdsx calls `actorId`
            // and `attributes` has to be found in here before a packet can be filled from JS
            // (next-steps Q1; `allocprobe pk2` / `pk` are the steps that die on it)
            let raw = "";
            for (let off = 0; off < 0x60; off += 8) raw += `+0x${off.toString(16)}=${(pk as any as StaticPointer).getPointer(off)} `;
            console.log(`[alloc] INFO pk0 allocated ${pk}`);
            console.log(`[alloc] INFO pk0 raw ${raw}`);
            pk.dispose();
            console.log("[alloc] PASS pk0: an untouched packet round-trips through BDS's own create and destroy");
        } catch (err) {
            console.log(`[alloc] FAIL pk0 threw ${(err as Error).message}`);
        }
        return;
    }
    if (step === "pk2") {
        // The bisection between the two things that can be wrong when BDS destroys what bdsx filled:
        // the heap the vector storage came from, or AttributeData's 1.26 layout. This pushes an
        // element with no heap string in it, so the only bdsx memory BDS frees is the vector itself.
        try {
            const pk = UpdateAttributesPacket.allocate();
            const data = AttributeData.construct();
            data.current = 20;
            data.min = 0;
            data.max = 20;
            data.default = 20;
            pk.attributes.push(data);
            const v = pk.attributes as any as StaticPointer;
            const begin = v.getPointer(0), end = v.getPointer(8), cap = v.getPointer(16);
            let raw = "";
            for (let i = 0; i < 0x60; i += 8) raw += begin.getPointer(i).toString() + " ";
            const stride = end.subptr(begin);
            console.log(`[alloc] INFO pk2 sizeof(AttributeData)=${(AttributeData as any)[NativeType.size]} stride(end-begin)=${stride} vector begin ${begin} end ${end} cap ${cap}`);
            console.log(`[alloc] INFO pk2 element head ${raw}`);
            // 1.26's element is 96 bytes: "Default Min Value" / "Default Max Value" went in at +0x10
            // and +0x14 and pushed the rest down by eight (docs/findings-layouts.md). BDS's destructor
            // strides by 96, so an 88-byte element runs past `end`.
            console.log(`[alloc] ${stride === 96 ? "PASS" : "FAIL"} pk2 stride: one pushed element measures ${stride} bytes (want 96)`);
            data.destruct();
            pk.dispose();
            console.log("[alloc] PASS pk2: BDS freed a vector bdsx allocated, element carrying no heap string");
        } catch (err) {
            console.log(`[alloc] FAIL pk2 threw ${(err as Error).message}`);
        }
        return;
    }
    if (step === "pk") {
        // The allocator's real test: build a packet, fill its std::string and std::vector through
        // msAlloc, and let BDS's own destructor free all three. Nothing is sent. Each step prints
        // before the next call runs, so a native crash names the step it died in.
        if (player === null) { console.log("[alloc] no player"); return; }
        try {
            const pk = UpdateAttributesPacket.allocate();
            console.log(`[alloc] INFO pk allocated ${pk}`);
            const data = AttributeData.construct();
            data.current = 20;
            data.min = 0;
            data.max = 20;
            data.default = 20;
            console.log("[alloc] INFO pk data constructed");
            data.name.set("minecraft:health");
            console.log(`[alloc] INFO pk name set "${data.name.str}"`);
            pk.attributes.push(data);
            const n = pk.attributes.size();
            console.log(`[alloc] INFO pk pushed, size ${n}`);
            data.destruct();
            console.log("[alloc] INFO pk local AttributeData destructed (bdsx freed what bdsx allocated)");
            pk.dispose();
            console.log("[alloc] INFO pk disposed (BDS freed the vector and strings bdsx allocated)");
            console.log(`[alloc] ${n === 1 ? "PASS" : "FAIL"} pk: packet built and freed by BDS, vector size ${n} (want 1)`);
        } catch (err) {
            console.log(`[alloc] FAIL pk threw ${(err as Error).message}`);
        }
        return;
    }
    if (step === "packet") {
        // ServerPlayer::setAttribute allocates an UpdateAttributesPacket, a std::string for the
        // attribute name and a std::vector for the attribute list, then hands all three to BDS to
        // free. This is the call that threw `Symbol not found: ??$_Allocate...` before.
        if (player === null) { console.log("[alloc] no player"); return; }
        try {
            const before = player.getHealth();
            player.setAttribute(AttributeId.Health, 15);
            const after = player.getHealth();
            player.setAttribute(AttributeId.Health, 20);
            const back = player.getHealth();
            const ok = before === 20 && after === 15 && back === 20;
            console.log(`[alloc] ${ok ? "PASS" : "FAIL"} packet: ServerPlayer.setAttribute 20 -> 15 -> 20 read back as ${before} -> ${after} -> ${back}`);
        } catch (err) {
            console.log(`[alloc] FAIL packet threw ${(err as Error).message}`);
        }
        return;
    }
    try {
        // the small path, then the >= 4096 path, then a free of the big block (reserve frees the
        // previous buffer through msAlloc.deallocate, which is where a bad [-8] would fault)
        const w = CxxStringWrapper.construct();
        w.reserve(100);
        const smallPtr = w.valueptr;
        w.reserve(6000);
        const bigPtr = w.valueptr;
        const aligned = (bigPtr.getAddressLow() & 31) === 0;
        w.reserve(9000); // frees the 6000 block: getPointer(-8) has to be the real allocation
        w.value = "z".repeat(8000);
        const roundTrip = w.value.length === 8000 && w.value.charCodeAt(7999) === 0x7a;
        w.destruct();
        console.log(`[alloc] ${aligned && roundTrip ? "PASS" : "FAIL"} heap: small ${smallPtr}, big ${bigPtr} 32-byte aligned ${aligned}, 8000-char round trip ${roundTrip}`);

        // a vector that grows across the threshold several times, then is freed
        const v = CxxVector$int32.construct();
        for (let i = 0; i < 3000; i++) v.push(i);
        const vecOk = v.size() === 3000 && v.get(0) === 0 && v.get(2999) === 2999;
        v.destruct();
        console.log(`[alloc] ${vecOk ? "PASS" : "FAIL"} vector: 3000 int32 pushed (12000 bytes, grown through 4096), read back ${vecOk}`);
    } catch (err) {
        console.log(`[alloc] FAIL heap threw ${(err as Error).message}`);
    }
});
console.log("[alloc] loaded");

// crashprobe arm -- crashes the server on purpose, to check what the native crash report now carries
// (bdsx/crashcapture.ts: faulting RIP, registers, stack). The address is the one the unexplained
// 1.26.51.1 crash read (next-steps Q8). The bad jump has to come from BDS's own code running in the game
// loop on the node thread, like that crash, because that thread is the only one under bdsx-core's
// exception filter (bdsx-core main.cpp, nodeStart). Measured on both builds, each of these instead ends
// the process with a bare 0xC0000005 and no report at all: a makefunc call from JavaScript, a console
// command (/tag -> Actor::addTag runs off the node thread), and a stub with its own frame and no unwind
// data (SEH dispatch cannot unwind through it). So `arm` raw-hooks ServerPlayer::normalTick -- called
// for the bot every tick -- with a bare jump to 0x3f800000: an execute fault whose only return address
// is BDS's, the case in which bdsx-core's stack walk loses the faulting frame.
// Only a driver that means to crash sends this.
events.command.on(cmd => {
    if (cmd.replace(/^\//, "") !== "crashprobe arm") return;
    const stub = asm().mov_r_c(Register.rax, 0x3f800000).jmp_r(Register.rax).alloc("crashprobe stub");
    procHacker.hookingRaw("?normalTick@ServerPlayer@@UEAAXXZ", stub);
    console.log("[crash] armed: ServerPlayer::normalTick now jumps to 0x3f800000");
});
