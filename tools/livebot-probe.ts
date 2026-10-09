/**
 * The live-bot harness, server side (docs/findings-bot.md "The harness"). Deployed as zz-lbprobe.ts; active only when
 * LB_PORT is set (the lb40/lb51 drivers set it for both the server and tools/livebot.cjs). The bot connects to
 * 127.0.0.1:LB_PORT after it spawns, and this probe drives it one step at a time: it builds the scene with console
 * commands, tells the bot what to do as a client would, and checks what bdsx's own hooks and the engine saw.
 *
 *   lb status                bot link and the bot's own view of itself
 *   lb diag on|off           log the engine's InventoryTransactionError for every item-use / on-actor / release
 *                            transaction (raw hooks on the three handle functions, by RVA, investigation only)
 *   lb run <scenario ...>    run scenarios in order; `lb run all` runs every one (or LB_RUN="..." in the driver's -Env:
 *                            the same, started on its own 3 s after the bot connects)
 *   lbtimers start|check     whether node's loop runs while the server runs (no LB_PORT needed)
 *
 * Every check prints `[lb] PASS|FAIL|INFO <label>: <detail>`.
 *
 * bdsx on 1.26 has no update hook (the lambda the 2024 patch went into is inlined), so node's event loop only runs when
 * something pumps it: timers and sockets used to fire at shutdown (docs/findings-slots.md "Timers"). While LB_PORT is
 * set, every level tick pumps it once (cgate.nodeLoopOnce, a non-blocking uv_run), which is what makes the control
 * socket and the promises below work.
 */
import * as net from "net";
import { Actor } from "bdsx/bds/actor";
import { AttributeId } from "bdsx/bds/attribute";
import { BlockPos } from "bdsx/bds/blockpos";
import { ComplexInventoryTransaction } from "bdsx/bds/inventory";
import { Form } from "bdsx/bds/form";
import { NetworkIdentifier } from "bdsx/bds/networkidentifier";
import { ItemStackRequestActionTransferBase, ItemStackRequestActionType, ItemStackRequestPacket } from "bdsx/bds/packets";
import { MinecraftPacketIds } from "bdsx/bds/packetids";
import { Player } from "bdsx/bds/player";
import { CommandResultType } from "bdsx/commandresult";
import { cgate, StaticPointer, VoidPointer } from "bdsx/core";
import { dllraw } from "bdsx/dllraw";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { CANCEL } from "bdsx/common";
import { bool_t, int32_t } from "bdsx/nativetype";
import { pdbcache } from "bdsx/pdbcache";
import { ProcHacker } from "bdsx/prochacker";

const TAG = "[lb]";
const PORT = Number(process.env.LB_PORT || 0);
const BUILD = String(pdbcache.bdsVersion);
const BOT = process.env.LB_BOT_NAME || "bdsxprobe";
let npass = 0;
let nfail = 0;
function say(label: string, ok: boolean | null, detail: string): void {
    if (ok === true) npass++;
    if (ok === false) nfail++;
    console.log(`${TAG} ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}
const J = (v: unknown): string => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));
const r2 = (n: number): string => n.toFixed(2);

// ---------------------------------------------------------------------------------------------------------------
// ticks, and the node loop pump
let tickNo = 0;
const tickWaiters: { at: number; resolve: () => void }[] = [];
function waitTicks(n: number): Promise<void> {
    return new Promise(resolve => tickWaiters.push({ at: tickNo + Math.max(1, n), resolve }));
}
async function waitFor(cond: () => boolean, maxTicks: number): Promise<number> {
    for (let i = 0; i < maxTicks; i++) {
        if (cond()) return i;
        await waitTicks(1);
    }
    return cond() ? maxTicks : -1;
}
if (PORT) {
    events.levelTick.on(() => {
        tickNo++;
        try {
            cgate.nodeLoopOnce();
        } catch (err) {
            console.log(`${TAG} INFO pump threw ${(err as Error).message}`);
        }
        for (let i = tickWaiters.length - 1; i >= 0; i--) {
            if (tickWaiters[i].at <= tickNo) {
                const w = tickWaiters.splice(i, 1)[0];
                w.resolve();
            }
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------
// the control link: one bot, JSON lines
interface Reply {
    id: number;
    ok: boolean;
    error?: string;
    [k: string]: any;
}
class BotLink {
    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (r: Reply) => void; at: number }>();
    readonly evs: any[] = [];
    hello: any = null;
    constructor(private readonly sock: net.Socket) {
        let buf = "";
        sock.on("data", d => {
            buf += d.toString("utf8");
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (!line.trim()) continue;
                let msg: any;
                try {
                    msg = JSON.parse(line);
                } catch (err) {
                    console.log(`${TAG} INFO bad line from bot: ${line.slice(0, 120)}`);
                    continue;
                }
                if (msg.ev !== undefined) {
                    if (msg.ev === "hello") this.hello = msg;
                    msg.tick = tickNo;
                    this.evs.push(msg);
                    if (this.evs.length > 2000) this.evs.splice(0, 1000);
                    continue;
                }
                const p = this.pending.get(msg.id);
                if (p !== undefined) {
                    this.pending.delete(msg.id);
                    p.resolve(msg);
                }
            }
        });
        sock.on("error", err => console.log(`${TAG} INFO control socket error ${err.message}`));
        sock.on("close", () => {
            console.log(`${TAG} INFO bot control link closed`);
            if (link === this) link = null;
        });
    }
    /** one op; resolves with the bot's reply, or {ok:false, error:"timeout"} after `ticks` level ticks */
    async call(op: string, args: Record<string, unknown> = {}, ticks = 200): Promise<Reply> {
        const id = this.nextId++;
        const p = new Promise<Reply>(resolve => this.pending.set(id, { resolve, at: tickNo + ticks }));
        this.sock.write(J({ op, ...args, id }) + "\n"); // the request id last: an op argument named `id` must not clobber it
        void (async () => {
            while (this.pending.has(id)) {
                await waitTicks(1);
                const e = this.pending.get(id);
                if (e !== undefined && tickNo >= e.at) {
                    this.pending.delete(id);
                    e.resolve({ id, ok: false, error: `timeout after ${ticks} ticks (${op})` });
                }
            }
        })();
        return p;
    }
    eventsSince(t: number, ev?: string): any[] {
        return this.evs.filter(e => e.tick >= t && (ev === undefined || e.ev === ev));
    }
}
let link: BotLink | null = null;
let autoRan = false;
if (PORT) {
    // unref'd, and closed at stop: a listening socket keeps node's loop alive, and the process then never exits after
    // "Quit correctly" (the first session hung until the runner killed it)
    const socks: net.Socket[] = [];
    const server = net.createServer(sock => {
        sock.setNoDelay(true);
        sock.unref();
        socks.push(sock);
        link = new BotLink(sock);
        console.log(`${TAG} INFO bot connected to the control port ${PORT}`);
        // LB_RUN="<scenario ...>|all": run them on their own once the bot is in, so a driver needs no `lb run` line
        // (it only has to stay up long enough: `lb status` lines, or -AfterJoin)
        if (process.env.LB_RUN && !autoRan) {
            autoRan = true;
            const names = process.env.LB_RUN === "all" ? Object.keys(scenarios) : process.env.LB_RUN.split(/\s+/).filter(Boolean);
            installDiag();
            diagOn = true;
            void waitTicks(60)
                .then(() => runAll(names))
                .catch(err => say("LB_RUN", false, `threw ${(err as Error).stack}`));
        }
    });
    server.on("error", err => console.log(`${TAG} FAIL control server: ${err.message}`));
    server.listen(PORT, "127.0.0.1", () => console.log(`${TAG} INFO control server listening on 127.0.0.1:${PORT} (${BUILD})`));
    server.unref();
    const shut = (): void => {
        try {
            server.close();
            for (const s of socks) s.destroy();
        } catch (err) {
            // closing at shutdown is best effort
        }
    };
    events.serverStop.on(shut);
    events.serverClose.on(shut);
}
async function bot(op: string, args: Record<string, unknown> = {}, ticks = 200): Promise<Reply> {
    if (link === null) throw Error("the bot is not connected");
    const r = await link.call(op, args, ticks);
    if (!r.ok) console.log(`${TAG} INFO bot ${op} -> ${r.error}`);
    return r;
}

// ---------------------------------------------------------------------------------------------------------------
// the world
function cmd(c: string): boolean {
    return bedrockServer.executeCommand(c, CommandResultType.Data).isSuccess();
}
function botPlayer(): Player | null {
    for (const p of bedrockServer.level.getPlayers()) if (p.getName() === BOT) return p;
    return null;
}
function ridOf(a: Actor): string {
    const id = a.getRuntimeID();
    return String((id.getAddressHigh() >>> 0) * 0x100000000 + (id.getAddressLow() >>> 0)); // ChakraCore has no BigInt
}
function uidOf(a: Actor): string {
    return String(a.getUniqueIdBin());
}
function entitiesOf(type: string): Actor[] {
    const out: Actor[] = [];
    for (const e of bedrockServer.level.getEntities()) if (e.getIdentifier() === type) out.push(e);
    return out;
}
/** summon one entity and return it (the new one of its type, by unique id); `event` is the spawn event, e.g.
 * minecraft:spawn_adult -- a plain summon of a cow comes out a calf about one time in twenty, and a calf gives no milk */
async function summon(type: string, x: number, y: number, z: number, event?: string): Promise<Actor | null> {
    const before = new Set(entitiesOf(type).map(uidOf));
    if (!cmd(event === undefined ? `summon ${type} ${x} ${y} ${z}` : `summon ${type} ${x} ${y} ${z} 0 0 ${event}`)) return null;
    await waitTicks(2);
    for (const e of entitiesOf(type)) if (!before.has(uidOf(e))) return e;
    return null;
}
const vec = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });

// the arena: a stone floor at y=66 (feet at 67), air above, far from every other probe's blocks
const AX = -3000;
const AZ = 3000;
const FLOOR = 66;
async function arena(): Promise<boolean> {
    const p = botPlayer();
    if (p === null) {
        say("arena", false, "the bot is not in the level");
        return false;
    }
    cmd(`tickingarea add ${AX - 16} 60 ${AZ - 16} ${AX + 16} 80 ${AZ + 16} lbarena`);
    cmd(`tp @a[name=${BOT}] ${AX + 0.5} ${FLOOR + 1} ${AZ + 0.5} 0 0`);
    await waitTicks(60);
    // a fill that changes nothing reports failure, so the result is read back instead
    cmd(`fill ${AX - 12} ${FLOOR} ${AZ - 12} ${AX + 12} ${FLOOR} ${AZ + 12} stone`);
    cmd(`fill ${AX - 12} ${FLOOR + 1} ${AZ - 12} ${AX + 12} ${FLOOR + 6} ${AZ + 12} air`);
    const a = cmd(`testforblock ${AX} ${FLOOR} ${AZ} stone`) && cmd(`testforblock ${AX + 12} ${FLOOR} ${AZ - 12} stone`);
    const b = cmd(`testforblock ${AX} ${FLOOR + 1} ${AZ} air`) && cmd(`testforblock ${AX - 12} ${FLOOR + 6} ${AZ + 12} air`);
    cmd(`kill @e[type=!player,x=${AX},y=${FLOOR},z=${AZ},r=20]`);
    cmd(`gamemode survival @a[name=${BOT}]`);
    cmd(`clear @a[name=${BOT}]`);
    cmd(`effect @a[name=${BOT}] clear`);
    cmd(`difficulty peaceful`);
    cmd(`time set day`);
    cmd(`tp @a[name=${BOT}] ${AX + 0.5} ${FLOOR + 1} ${AZ + 0.5} 0 0`);
    await waitTicks(20);
    await bot("ground", { y: FLOOR + 1 });
    const st = await bot("state");
    say("arena", a && b && st.ok, `fill floor ${a}, air above ${b}; bot at ${J(st.pos)} onGround ${st.onGround} groundY ${st.groundY}`);
    return a && b && st.ok;
}

// ---------------------------------------------------------------------------------------------------------------
// what bdsx saw: every event a scenario may look at, recorded with the tick it fired on
interface Seen {
    ev: string;
    tick: number;
    detail: string;
    data?: any;
}
const seen: Seen[] = [];
function note(ev: string, detail: string, data?: any): void {
    seen.push({ ev, tick: tickNo, detail, data });
    if (seen.length > 5000) seen.splice(0, 2500);
}
function seenSince(t: number, ev: string): Seen[] {
    return seen.filter(s => s.tick >= t && s.ev === ev);
}
const isBot = (p: Actor | null | undefined): boolean => p != null && p instanceof Player && p.getName() === BOT;
function listen(name: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        say(`listen ${name}`, null, `not installed: ${(err as Error).message}`);
    }
}
if (PORT) {
    listen("playerAttack", () =>
        events.playerAttack.on(e => {
            if (isBot(e.player)) note("playerAttack", `${e.victim.getIdentifier()} rid ${ridOf(e.victim)}`, { rid: ridOf(e.victim) });
        }),
    );
    listen("playerCrit", () =>
        events.playerCrit.on(e => {
            if (isBot(e.player)) note("playerCrit", `${e.victim.getIdentifier()}`, { rid: ridOf(e.victim) });
        }),
    );
    listen("playerJump", () =>
        events.playerJump.on(e => {
            if (isBot(e.player)) note("playerJump", `at ${J(vec(e.player.getFeetPos()))}`);
        }),
    );
    listen("entityHurt", () =>
        events.entityHurt.on(e => {
            note("entityHurt", `${e.entity.getIdentifier()} damage ${e.damage}`, { rid: ridOf(e.entity), damage: e.damage });
        }),
    );
    listen("playerInteract", () =>
        events.playerInteract.on(e => {
            if (isBot(e.player)) note("playerInteract", `${e.victim.getIdentifier()}`, { rid: ridOf(e.victim) });
        }),
    );
    listen("attackBlock", () =>
        events.attackBlock.on(e => {
            if (isBot(e.player)) note("attackBlock", `${J(vec(e.blockPos))} ${e.block.getName()}`, { pos: vec(e.blockPos) });
        }),
    );
    listen("blockDestructionStart", () =>
        events.blockDestructionStart.on(e => {
            if (isBot(e.player)) note("blockDestructionStart", `${J(vec(e.blockPos))}`, { pos: vec(e.blockPos) });
        }),
    );
    listen("blockDestroy", () =>
        events.blockDestroy.on(e => {
            if (isBot(e.player)) note("blockDestroy", `${J(vec(e.blockPos))}`, { pos: vec(e.blockPos) });
        }),
    );
    listen("blockInteractedWith", () =>
        events.blockInteractedWith.on(e => {
            if (isBot(e.player)) note("blockInteractedWith", `${J(vec(e.blockPos))}`, { pos: vec(e.blockPos) });
        }),
    );
    listen("itemUse", () =>
        events.itemUse.on(e => {
            if (isBot(e.player)) note("itemUse", `${e.itemStack.getName()}`);
        }),
    );
    listen("itemUseOnBlock", () =>
        events.itemUseOnBlock.on(e => {
            if (isBot(e.actor)) note("itemUseOnBlock", `${e.itemStack.getName()} at ${e.x},${e.y},${e.z} face ${e.face}`);
        }),
    );
    listen("playerUseItem", () =>
        events.playerUseItem.on(e => {
            if (isBot(e.player)) note("playerUseItem", `${e.itemStack.getName()} method ${e.useMethod} consume ${e.consumeItem}`);
        }),
    );
    listen("playerSleepInBed", () =>
        events.playerSleepInBed.on(e => {
            if (isBot(e.player)) note("playerSleepInBed", `${J(vec(e.pos))}`);
        }),
    );
    listen("entityStartSwimming", () =>
        events.entityStartSwimming.on(e => {
            if (isBot(e.entity)) note("entityStartSwimming", "");
        }),
    );
    listen("chestOpen", () =>
        events.chestOpen.on(e => {
            if (isBot(e.player)) note("chestOpen", `${J(vec(e.blockPos))}`);
        }),
    );
    listen("playerDropItem", () =>
        events.playerDropItem.on(e => {
            if (isBot(e.player)) note("playerDropItem", `${e.itemStack.getName()} x${e.itemStack.getAmount()} inContainer ${e.inContainer} slot ${e.hotbarSlot}`);
        }),
    );
    listen("projectileShoot", () =>
        events.projectileShoot.on(e => {
            if (isBot(e.shooter)) note("projectileShoot", `${e.projectile.getIdentifier()}`);
        }),
    );
    listen("entitySneak", () =>
        events.entitySneak.on(e => {
            if (isBot(e.entity)) note("entitySneak", `${e.isSneaking}`, { on: e.isSneaking });
        }),
    );
    listen("text", () =>
        events.packetBefore(MinecraftPacketIds.Text).on((pk, ni) => {
            const a = ni.getActor();
            if (isBot(a)) note("text", pk.message);
        }),
    );
    listen("command", () =>
        events.command.on((c, origin) => {
            if (origin === BOT) note("command", c);
        }),
    );
    listen("blockPlace", () =>
        events.blockPlace.on(e => {
            if (isBot(e.player)) note("blockPlace", `${e.block.getName()} at ${J(vec(e.blockPos))}`);
        }),
    );
}

// ---------------------------------------------------------------------------------------------------------------
// diagnostics: the engine's verdict on each client transaction (InventoryTransactionError; StateMismatch is 7)
const HANDLERS: Record<string, Record<string, number>> = {
    "1.26.40.8": { ItemUseOnActor: 0x2596380, ItemUse: 0x2591460, ItemRelease: 0x258e130 },
    "1.26.51.1": { ItemUseOnActor: 0x2a71b60, ItemUse: 0x2a6c4a0, ItemRelease: 0x2a69040 },
};
let diagOn = false;
let diagInstalled = false;
function installDiag(): void {
    if (diagInstalled) return;
    const rvas = HANDLERS[BUILD];
    if (rvas === undefined) return say("diag", false, `no handler RVAs for ${BUILD}`);
    for (const [name, rva] of Object.entries(rvas)) {
        const fn = dllraw.current.add(rva) as any;
        const original = new ProcHacker<{ f: any }>({ f: fn }).hooking("f", int32_t, null, VoidPointer, VoidPointer, bool_t)(
            (self: VoidPointer, player: VoidPointer, senderAuthority: boolean): number => {
                const r = original(self, player, senderAuthority);
                note(`tx:${name}`, `error ${r} senderAuthority ${senderAuthority}`, { code: r });
                if (diagOn) console.log(`${TAG} INFO ${name}InventoryTransaction::handle -> ${r} (senderAuthority ${senderAuthority}) tick ${tickNo}`);
                return r;
            },
        );
    }
    diagInstalled = true;
    say("diag", null, `hooked ${Object.keys(rvas).join(", ")} on ${BUILD}`);
    // every other transaction type (the hotbar drop is a `normal` one): its handle is slot 4 of the transaction's own
    // table on both builds (ItemUseOnActor 40 0xa667eb0, ItemUse 0xa667e80, ItemRelease 0xa55d990 all hold their
    // handle there), so the first packet of each type hooks it
    events.packetBefore(MinecraftPacketIds.InventoryTransaction).on(pk => {
        const tx = pk.transaction;
        if (tx === null || tx.type === ComplexInventoryTransaction.Type.ItemUseTransaction) return;
        if (tx.type === ComplexInventoryTransaction.Type.ItemUseOnEntityTransaction || tx.type === ComplexInventoryTransaction.Type.ItemReleaseTransaction) return;
        const fn = (tx as any as StaticPointer).getPointer(0).getPointer(0x20);
        const key = fn.toString();
        if (txHooked.has(key)) return;
        txHooked.add(key);
        const name = ComplexInventoryTransaction.Type[tx.type] ?? `type${tx.type}`;
        const original = new ProcHacker<{ f: any }>({ f: fn as any }).hooking("f", int32_t, null, VoidPointer, VoidPointer, bool_t)(
            (self: VoidPointer, player: VoidPointer, senderAuthority: boolean): number => {
                const r = original(self, player, senderAuthority);
                note(`tx:${name}`, `error ${r}`, { code: r });
                if (diagOn) console.log(`${TAG} INFO ${name}::handle -> ${r} (senderAuthority ${senderAuthority}) tick ${tickNo}`);
                return r;
            },
        );
        say("diag", null, `hooked the ${name} handle at ${fn} (packet legacy request id ${pk.legacyRequestId})`);
    });
}
const txHooked = new Set<string>();

// ---------------------------------------------------------------------------------------------------------------
// scenarios
/** items in the bot's inventory as the server sees them: slot -> "name xN" */
function invOf(p: Player): Record<number, string> {
    const out: Record<number, string> = {};
    const c = p.getInventory().container;
    for (let i = 0; i < 36; i++) {
        const it = c.getItem(i);
        if (!it.isNull()) out[i] = `${it.getName()} x${it.getAmount()}`;
    }
    return out;
}
const block = (x: number, y: number, z: number, name: string): boolean => cmd(`testforblock ${x} ${y} ${z} ${name}`);
/** the server's block at a position: name, runtime id (Block+0x114) and the network hash (+0x110, what the wire carries
 * with block-network-ids-are-hashes=true), next to what the bot was last told about that position */
async function blockIds(x: number, y: number, z: number): Promise<string> {
    const p = botPlayer();
    if (p === null) return "(no player)";
    const b = p.getRegion().getBlock(BlockPos.create(x, y, z));
    const hash = (b as any as StaticPointer).getUint32(0x110);
    const seen = await bot("block", { x, y, z });
    return `${b.getName()} rid ${b.getRuntimeId()} hash ${hash} (bot knows ${seen.brid})`;
}
/** pigs leave the arena by the void: a pig killed in place drops porkchops at the end of its death animation, the bot
 * picks them up, and the next attack names a held item the server no longer agrees with (SourceItemMismatch, 3) */
function clearPigs(): void {
    cmd(`tp @e[type=pig,x=${AX},y=${FLOOR},z=${AZ},r=20] ${AX} -120 ${AZ}`);
}
async function pigAt(x: number, z: number): Promise<Actor | null> {
    clearPigs();
    await waitTicks(2);
    const pig = await summon("minecraft:pig", x, FLOOR + 1, z);
    if (pig !== null) cmd(`effect @e[type=pig,x=${AX},y=${FLOOR},z=${AZ},r=20] slowness 999 255 true`);
    return pig;
}
function mid(a: Actor, h: number): { x: number; y: number; z: number } {
    const f = a.getFeetPos();
    return { x: f.x, y: f.y + h / 2, z: f.z };
}
/** the bot back on its spot, looking along +z, nothing in hand */
async function home(): Promise<void> {
    cmd(`tp @a[name=${BOT}] ${AX + 0.5} ${FLOOR + 1} ${AZ + 0.5} 0 0`);
    await waitTicks(5);
    await bot("look", { yaw: 0, pitch: 0 });
}
const PIG_H = 0.9;
function exhaustion(p: Player): string {
    try {
        return p.getAttribute(AttributeId.PlayerExhaustion).toFixed(4);
    } catch (err) {
        return `(threw ${(err as Error).message})`;
    }
}

const scenarios: Record<string, () => Promise<void>> = {
    // an entity attack the way a client lands one: face the target's middle, then item_use_on_entity attack. The A/B on
    // interact_rotation: a pig straight ahead is hit whatever interact_rotation says, a pig to the side only when it
    // follows the look, if that is what the engine's view check reads (docs/findings-bot.md "Attacks")
    async attack() {
        const cases: [string, number, number, number][] = [
            ["ahead, interact_rotation 0", AX + 0.5, AZ + 2.5, 1],
            ["side, interact_rotation 0", AX + 2.5, AZ + 0.5, 1],
            ["side, aimed", AX + 2.5, AZ + 0.5, 0],
        ];
        for (const [name, x, z, zero] of cases) {
            await home();
            const pig = await pigAt(x, z);
            if (pig === null) return say(`attack ${name}`, false, "no pig");
            await waitTicks(10);
            const rid = ridOf(pig);
            const h0 = pig.getHealth();
            const t = tickNo;
            const r = await bot("attack", { rid, aim: mid(pig, PIG_H), zeroInteract: zero });
            await waitTicks(8);
            const atk = seenSince(t, "playerAttack").filter(e => e.data?.rid === rid);
            const hurt = seenSince(t, "entityHurt").filter(e => e.data?.rid === rid);
            const tx = seenSince(t, "tx:ItemUseOnActor").map(e => e.data.code);
            const h1 = pig.getHealth();
            const hit = h1 < h0;
            const detail = `dist ${r2(r.dist ?? -1)} yaw ${r2(r.yaw ?? 0)} pitch ${r2(r.pitch ?? 0)}; handle ${J(tx)} entityHurt ${J(hurt.map(e => e.data.damage))} health ${h0} -> ${h1}; playerAttack ${atk.length}`;
            if (name === "side, aimed") {
                say(`attack ${name}: the hit lands`, hit && tx[0] === 1, detail);
                say(`attack ${name}: playerAttack fires`, atk.length === 1, detail);
            } else say(`attack ${name}`, null, `${hit ? "HIT" : "no hit"}; ${detail}`);
        }
        // both sides of a cancel through bdsx's hook: cancelled, the pig keeps its health; allowed, it loses some
        for (const cancel of [true, false]) {
            await home();
            const pig = await pigAt(AX + 0.5, AZ + 2.5);
            if (pig === null) return say("attack cancel", false, "no pig");
            await waitTicks(10);
            const rid = ridOf(pig);
            const h0 = pig.getHealth();
            const t = tickNo;
            const veto = (e: { player: Player; victim: Actor }): CANCEL | void => {
                if (cancel && isBot(e.player)) return CANCEL;
            };
            events.playerAttack.on(veto);
            await bot("attack", { rid, aim: mid(pig, PIG_H) });
            await waitTicks(8);
            events.playerAttack.remove(veto);
            const h1 = pig.getHealth();
            const atk = seenSince(t, "playerAttack").filter(e => e.data?.rid === rid).length;
            say(`attack ${cancel ? "cancelled" : "allowed"} through playerAttack`, atk === 1 && (cancel ? h1 === h0 : h1 < h0), `playerAttack ${atk}; health ${h0} -> ${h1}; handle ${J(seenSince(t, "tx:ItemUseOnActor").map(e => e.data.code))}`);
        }
        // Strength II: bare hand 1 becomes 1.3^2 * 1 + (1.3^2 - 1) / 0.3 = 3.99 -- the 3.99 earlier runs saw on and off
        // was bdsx's stock actor-effects.ts example giving Strength II every other second (docs/findings-bot.md section 10)
        {
            await home();
            const pig = await pigAt(AX + 0.5, AZ + 2.5);
            if (pig === null) return say("attack with Strength II", false, "no pig");
            cmd(`effect @a[name=${BOT}] strength 10 1 true`);
            await waitTicks(10);
            const rid = ridOf(pig);
            const h0 = pig.getHealth();
            const t = tickNo;
            await bot("attack", { rid, aim: mid(pig, PIG_H) });
            await waitTicks(8);
            cmd(`effect @a[name=${BOT}] clear`);
            const hurt = seenSince(t, "entityHurt").filter(e => e.data?.rid === rid).map(e => e.data.damage as number);
            say("attack with Strength II: entityHurt damage 3.99", hurt.length === 1 && Math.abs(hurt[0] - 3.99) < 0.001, `entityHurt ${J(hurt)} health ${h0} -> ${pig.getHealth()}`);
        }
        clearPigs();
    },
    // walking: forward for 20 ticks; the server's position follows the bot's (no correction past the threshold)
    async walk() {
        await home();
        const p = botPlayer()!;
        const f0 = vec(p.getFeetPos());
        const t = tickNo;
        const r = await bot("walk", { forward: 1, ticks: 20 });
        await waitTicks(5);
        const f1 = vec(p.getFeetPos());
        const st = await bot("state");
        const moved = Math.hypot(f1.x - f0.x, f1.z - f0.z);
        const gap = Math.hypot(f1.x - st.pos.x, f1.z - st.pos.z);
        say("walk: the server moves the player", moved > 3 && gap < 0.5, `server feet ${J(f0)} -> ${J(f1)} (${r2(moved)} blocks); bot ${J(st.pos)} (gap ${r2(gap)}); corrections ${link!.eventsSince(t, "correction").length}; bot reply ${J(r.pos)}`);
        await home();
    },
    // right-click an entity: item_use_on_entity interact with a bucket on a cow milks it
    async interact() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        cmd(`give @a[name=${BOT}] bucket 1`);
        cmd(`kill @e[type=cow,x=${AX},y=${FLOOR},z=${AZ},r=20]`);
        const cow = await summon("minecraft:cow", AX + 0.5, FLOOR + 1, AZ + 2.5, "minecraft:spawn_adult");
        if (cow === null) return say("interact", false, "no cow");
        cmd(`effect @e[type=cow,x=${AX},y=${FLOOR},z=${AZ},r=20] slowness 999 255 true`);
        await waitTicks(10);
        const rid = ridOf(cow);
        const t = tickNo;
        await bot("attack", { rid, aim: mid(cow, 1.4), action: "interact" });
        await waitTicks(10);
        const ev = seenSince(t, "playerInteract").filter(e => e.data?.rid === rid);
        const hand = botPlayer()!.getMainhandSlot().getName();
        say("interact: playerInteract and the milk", ev.length === 1 && hand === "minecraft:milk_bucket", `playerInteract ${ev.length}; hand ${hand}; handle ${J(seenSince(t, "tx:ItemUseOnActor").map(e => e.data.code))}`);
        cmd(`tp @e[type=cow,x=${AX},y=${FLOOR},z=${AZ},r=20] ${AX} -120 ${AZ}`);
        cmd(`clear @a[name=${BOT}]`);
    },
    // sneak for a second: the auth input's sneak flags, bdsx's entitySneak both ways
    async sneak() {
        await home();
        const t = tickNo;
        await bot("sneak", { on: true });
        await waitTicks(20);
        const mid1 = botPlayer()!.isSneaking();
        await bot("sneak", { on: false });
        await waitTicks(10);
        const ev = seenSince(t, "entitySneak").map(e => e.data.on);
        say("sneak: entitySneak on and off", J(ev) === J([true, false]) && mid1, `entitySneak ${J(ev)}; isSneaking while held ${mid1}`);
    },
    // chat, a command typed as the player, and a form answered by the client
    async talk() {
        const t = tickNo;
        await bot("chat", { text: "lb chat check" });
        await waitTicks(10);
        const heard = seenSince(t, "text").map(e => e.detail);
        const echo = link!.eventsSince(t, "text").filter(e => /lb chat check/.test(e.message ?? ""));
        say("chat: the server reads it and echoes it", heard.includes("lb chat check") && echo.length >= 1, `packetBefore(Text) ${J(heard)}; the bot heard ${echo.length}`);
        const t2 = tickNo;
        // /me, which every player may run (a member gets commands.generic.error.permissions for /say)
        await bot("command", { text: "/me lb command check" });
        await waitTicks(10);
        const cmds = seenSince(t2, "command").map(e => e.detail);
        const out = link!.eventsSince(t2, "command_output");
        const said = link!.eventsSince(t2, "text").filter(e => /lb command check/.test(JSON.stringify(e)));
        say("command: run as the player", cmds.some(c => /me lb command check/.test(c)) && said.length >= 1, `events.command ${J(cmds)}; command_output ${J(out.map(e => e.output))}; the bot heard ${said.length}`);
        const p = botPlayer()!;
        const t3 = tickNo;
        let answer: unknown = "(none)";
        Form.sendTo(p.getNetworkIdentifier(), { type: "modal", title: "lb", content: "harness form", button1: "yes", button2: "no" }).then(r => {
            answer = r;
        });
        const got = await waitFor(() => link!.eventsSince(t3, "form").length > 0, 40);
        const form = link!.eventsSince(t3, "form")[0];
        if (got < 0 || form === undefined) return say("form: answered by the client", false, "no form reached the bot");
        await bot("form", { formId: form.id, data: "true" });
        await waitFor(() => answer !== "(none)", 40);
        say("form: answered by the client", answer === true, `the bot got form ${form.id}; Form.sendTo resolved ${J(answer)}`);
    },
    // the server-authoritative inventory from a client: open a chest, take two diamonds to the cursor, place them in the
    // hotbar -- two ItemStackRequests, each read back through bdsx's ItemStackRequestPacket reader
    async stack() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        const ch = { x: AX - 1, y: FLOOR + 1, z: AZ + 2 };
        cmd(`setblock ${ch.x} ${ch.y} ${ch.z} air`);
        cmd(`setblock ${ch.x} ${ch.y} ${ch.z} chest`);
        cmd(`replaceitem block ${ch.x} ${ch.y} ${ch.z} slot.container 0 diamond 5`);
        await waitTicks(5);
        const reads: string[] = [];
        const reader = (pk: ItemStackRequestPacket, ni: NetworkIdentifier): void => {
            if (!isBot(ni.getActor())) return;
            for (const r of pk.getRequests()) {
                for (const a of r.getActions()) {
                    if (!(a instanceof ItemStackRequestActionTransferBase)) {
                        reads.push(`#${r.clientRequestId} type ${a.type}`);
                        continue;
                    }
                    const src = a.getSrc();
                    const dst = a.getDst();
                    reads.push(`#${r.clientRequestId} ${ItemStackRequestActionType[a.type]} ${a.getAmount()} [${src.openContainerNetId}:${src.slot} id ${src.stackNetId}] -> ${dst === null ? "-" : `[${dst.openContainerNetId}:${dst.slot} id ${dst.stackNetId}]`}`);
                }
            }
        };
        events.packetBefore(MinecraftPacketIds.ItemStackRequest).on(reader);
        const t = tickNo;
        await bot("useItemOn", { ...ch, face: 2 });
        const opened = await waitFor(() => link!.eventsSince(t, "container_open").length > 0, 40);
        const open = link!.eventsSince(t, "container_open")[0];
        if (opened < 0 || open === undefined) {
            events.packetBefore(MinecraftPacketIds.ItemStackRequest).remove(reader);
            return say("stack: chest opened", false, "no container_open");
        }
        await waitTicks(5);
        const win = await bot("window", { win: open.id });
        const src = win.items?.["0"];
        if (src === undefined) {
            events.packetBefore(MinecraftPacketIds.ItemStackRequest).remove(reader);
            return say("stack: the chest's diamonds reached the client", false, `window ${J(win)}`);
        }
        const slotInfo = (container: string, slot: number, stack: number) => ({ slot_type: { container_id: container, dynamic_container_id: undefined }, slot, stack_id: stack });
        const take = await bot("stackRequest", { actions: [{ type_id: "take", legacy_type_id: 0, count: 2, source: slotInfo("container", 0, src.stack), destination: slotInfo("cursor", 0, 0) }] });
        const cursor = (take.containers ?? []).find((c: any) => c.slot_type?.container_id === "cursor")?.slots?.[0];
        const place = await bot("stackRequest", { actions: [{ type_id: "place", legacy_type_id: 1, count: 2, source: slotInfo("cursor", 0, cursor?.item_stack_id ?? 0), destination: slotInfo("hotbar", 0, 0) }] });
        await waitTicks(5);
        events.packetBefore(MinecraftPacketIds.ItemStackRequest).remove(reader);
        const inv = invOf(botPlayer()!);
        const left = cmd(`testforblock ${ch.x} ${ch.y} ${ch.z} chest`);
        say("stack: take and place answered ok", take.status === "ok" && place.status === "ok", `take ${take.status} (cursor ${J(cursor)}), place ${place.status}; chest slot 0 was ${J(src)}`);
        say("stack: the diamonds moved", inv["0"] === "minecraft:diamond x2", `hotbar ${J(inv)}; chest still there ${left}`);
        say("stack: bdsx reads the client's requests", reads.length === 2 && /Take 2 \[\d+:0 id \d+\] -> \[\d+:0 id 0\]/.test(reads[0]) && /Place 2/.test(reads[1]), J(reads));
        await bot("closeContainer", {});
        await waitTicks(5);
        cmd(`setblock ${ch.x} ${ch.y} ${ch.z} air`);
        cmd(`kill @e[type=item,x=${AX},y=${FLOOR},z=${AZ},r=20]`);
        cmd(`clear @a[name=${BOT}]`);
    },
    // a jump the server simulates from our input: the server's own feet position must rise
    async jump() {
        await home();
        const p = botPlayer()!;
        const y0 = p.getFeetPos().y;
        const t = tickNo;
        let top = y0;
        const watch = (async () => {
            for (let i = 0; i < 20; i++) {
                await waitTicks(1);
                top = Math.max(top, p.getFeetPos().y);
            }
        })();
        const ex0 = exhaustion(p);
        const r = await bot("jump", {});
        await watch;
        const ex1 = exhaustion(p);
        const corr = link!.eventsSince(t, "correction").length;
        say("jump: exhaustion", null, `${ex0} -> ${ex1} (a jump adds 0.05 in survival)`);
        say("jump: the server's player rises", top - y0 > 1.0, `server feet ${r2(y0)} -> top ${r2(top)} (bot rose ${r2(r.rose ?? 0)}); corrections ${corr}`);
        say("jump: playerJump", seenSince(t, "playerJump").length === 1, `playerJump ${seenSince(t, "playerJump").length} (bdsx:JumpExhaustionSystem::_tickEntity)`);
    },
    // a critical hit: attack while falling from a jump
    async crit() {
        await home();
        const pig = await pigAt(AX + 0.5, AZ + 2.5);
        if (pig === null) return say("crit", false, "no pig");
        await waitTicks(25);
        const rid = ridOf(pig);
        const h0 = pig.getHealth();
        const t = tickNo;
        const sp = botPlayer()!;
        const before = await bot("state");
        say("crit setup", null, `server: selected ${sp.getInventory().getSelectedSlot()} mainhand ${sp.getMainhandSlot().getName()} x${sp.getMainhandSlot().getAmount()}; bot: selected ${before.selected} inv ${J(before.inv)}`);
        await bot("jump", { wait: 0 });
        await waitTicks(6);
        const r = await bot("attack", { rid, aim: mid(pig, PIG_H), settle: 1 });
        await waitTicks(15);
        const crit = seenSince(t, "playerCrit");
        const hurt = seenSince(t, "entityHurt").filter(e => e.data?.rid === rid);
        say("crit: playerCrit fires", crit.length === 1, `playerCrit ${crit.length}; handle ${J(seenSince(t, "tx:ItemUseOnActor").map(e => e.data.code))} entityHurt ${J(hurt.map(e => e.data.damage))} health ${h0} -> ${pig.getHealth()}; dist ${r2(r.dist ?? -1)}`);
        clearPigs();
    },
    // survival block breaking, server-authoritative: start_break, continue_break every tick, predict_break, stop_break
    async break() {
        await home();
        const bx = AX, by = FLOOR + 1, bz = AZ + 2;
        cmd(`setblock ${bx} ${by} ${bz} dirt`);
        await waitTicks(5);
        const t = tickNo;
        let goneAt = -1;
        const watch = (async () => {
            for (let i = 0; i < 60 && goneAt < 0; i++) {
                await waitTicks(1);
                if (block(bx, by, bz, "air")) goneAt = tickNo - t;
            }
        })();
        await bot("breakBlock", { x: bx, y: by, z: bz, face: 2, ticks: 22 });
        await watch;
        const ab = seenSince(t, "attackBlock"), ds = seenSince(t, "blockDestructionStart"), bd = seenSince(t, "blockDestroy");
        say("break: the dirt is gone", goneAt >= 0, `air after ${goneAt} ticks; bot saw ${link!.eventsSince(t, "update_block").length} update_block`);
        say("break: attackBlock", ab.length === 1, `attackBlock ${ab.length} ${ab[0]?.detail ?? ""}`);
        say("break: blockDestroy", bd.length === 1, `blockDestroy ${bd.length} ${bd[0]?.detail ?? ""}`);
        say("break: blockDestructionStart", ds.length === 1, `blockDestructionStart ${ds.length} ${ds[0]?.detail ?? ""}`);
        cmd(`setblock ${bx} ${by} ${bz} air`);
        // the dirt drops as an item the bot would pick up: the next item use would then name a stale held item
        cmd(`kill @e[type=item,x=${AX},y=${FLOOR},z=${AZ},r=20]`);
        cmd(`clear @a[name=${BOT}]`);
        await waitTicks(5);
    },
    // right-click blocks: a crafting table (opens a workbench), the plain floor, and a chest
    async useon() {
        await home();
        const ct = { x: AX + 1, y: FLOOR + 1, z: AZ + 2 };
        cmd(`setblock ${ct.x} ${ct.y} ${ct.z} crafting_table`);
        await waitTicks(5);
        say("useon block ids", null, `crafting table ${await blockIds(ct.x, ct.y, ct.z)}`);
        let t = tickNo;
        await bot("useItemOn", { ...ct, face: 2 });
        await waitTicks(10);
        let opened = link!.eventsSince(t, "container_open");
        say("useon crafting table", opened.length === 1 ? true : false, `blockInteractedWith ${seenSince(t, "blockInteractedWith").length}, itemUseOnBlock ${seenSince(t, "itemUseOnBlock").length}, container_open ${J(opened)}; handle ${J(seenSince(t, "tx:ItemUse").map(e => e.data.code))}`);
        if (opened.length) await bot("closeContainer", {});
        await waitTicks(5);
        cmd(`setblock ${AX} ${FLOOR} ${AZ + 1} dirt`); // a block update, so the bot knows what it clicks
        await waitTicks(5);
        t = tickNo;
        await bot("useItemOn", { x: AX, y: FLOOR, z: AZ + 1, face: 1 });
        await waitTicks(10);
        say("useon floor", null, `blockInteractedWith ${seenSince(t, "blockInteractedWith").length}, itemUseOnBlock ${seenSince(t, "itemUseOnBlock").length}; handle ${J(seenSince(t, "tx:ItemUse").map(e => e.data.code))}`);
        const ch = { x: AX - 1, y: FLOOR + 1, z: AZ + 2 };
        cmd(`setblock ${ch.x} ${ch.y} ${ch.z} chest`);
        await waitTicks(5);
        t = tickNo;
        await bot("useItemOn", { ...ch, face: 2 });
        await waitTicks(10);
        opened = link!.eventsSince(t, "container_open");
        say("useon chest: blockInteractedWith", seenSince(t, "blockInteractedWith").length === 1, `blockInteractedWith ${J(seenSince(t, "blockInteractedWith").map(e => e.detail))}`);
        say("useon chest: chestOpen", seenSince(t, "chestOpen").length === 1 && opened.length === 1, `chestOpen ${seenSince(t, "chestOpen").length}, container_open ${J(opened)}, blockInteractedWith ${seenSince(t, "blockInteractedWith").length}; handle ${J(seenSince(t, "tx:ItemUse").map(e => e.data.code))}`);
        if (opened.length) {
            const c = await bot("closeContainer", {});
            await waitTicks(5);
            say("useon chest: closed", link!.eventsSince(t, "container_close").length >= 1 || c.ok, `close ${J(c)} server close events ${link!.eventsSince(t, "container_close").length}`);
        }
        cmd(`setblock ${ct.x} ${ct.y} ${ct.z} air`);
        cmd(`setblock ${ch.x} ${ch.y} ${ch.z} air`);
        cmd(`setblock ${AX} ${FLOOR} ${AZ + 1} stone`);
    },
    // place a block from the hotbar: the engine's own mayPlace, bdsx's blockPlace
    async place() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        cmd(`give @a[name=${BOT}] dirt 4`);
        await waitTicks(10);
        const at = { x: AX - 1, y: FLOOR + 1, z: AZ + 1 };
        cmd(`setblock ${at.x} ${at.y} ${at.z} air`);
        cmd(`setblock ${at.x} ${FLOOR} ${at.z} dirt`); // the block clicked, updated so the bot knows its id
        await waitTicks(5);
        const t = tickNo;
        await bot("useItemOn", { x: at.x, y: FLOOR, z: at.z, face: 1, consume: 1 });
        await waitTicks(10);
        const placed = block(at.x, at.y, at.z, "dirt");
        say("place: dirt placed", placed, `testforblock ${placed}; blockPlace ${seenSince(t, "blockPlace").length} ${seenSince(t, "blockPlace")[0]?.detail ?? ""}; itemUseOnBlock ${seenSince(t, "itemUseOnBlock").length}; handle ${J(seenSince(t, "tx:ItemUse").map(e => e.data.code))}; inv ${J(invOf(botPlayer()!))}`);
        say("place: blockPlace fires", seenSince(t, "blockPlace").length === 1, `blockPlace ${seenSince(t, "blockPlace").length}`);
        cmd(`setblock ${at.x} ${at.y} ${at.z} air`);
        cmd(`setblock ${at.x} ${FLOOR} ${at.z} stone`);
    },
    // drop one item from the hotbar (Q): bdsx reads it from the InventoryTransaction packet
    async drop() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        cmd(`give @a[name=${BOT}] dirt 5`);
        await waitTicks(10);
        const p = botPlayer()!;
        // bdsx's stock example (example_and_test/event-playerdropitem.ts, loaded in every session) cancels every other
        // drop, so two drops give both sides of bdsx's cancel: one stays in the hotbar (bdsx resends the inventory and
        // drops the packet), the other reaches the engine and becomes an item entity
        const outcomes: string[] = [];
        let cancelled = 0;
        let dropped = 0;
        for (let i = 0; i < 2; i++) {
            const before = J(invOf(p));
            const t = tickNo;
            await bot("drop", { slot: 0, count: 1 });
            await waitTicks(10);
            const ev = seenSince(t, "playerDropItem");
            const after = J(invOf(p));
            const items = link!.eventsSince(t, "item_entity").length;
            const moved = after !== before;
            if (ev.length === 1 && /inContainer false/.test(ev[0].detail)) {
                if (moved && items >= 1) dropped++;
                else if (!moved && items === 0) cancelled++;
            }
            outcomes.push(`#${i + 1}: playerDropItem ${J(ev.map(e => e.detail))}, inventory ${before} -> ${after}, item entities ${items}, normal handle ${J(seenSince(t, "tx:NormalTransaction").map(e => e.data.code))}`);
        }
        say("drop: playerDropItem on both hotbar drops", outcomes.every(o => o.includes("inContainer false")), outcomes.join(" | "));
        say("drop: one cancelled through playerDropItem, one dropped by the engine", cancelled === 1 && dropped === 1, `cancelled ${cancelled}, dropped ${dropped}`);
        // the inventory screen's drop: an ItemStackRequest drop action (bdsx reads drops from InventoryTransaction only)
        const t2 = tickNo;
        const r2s = await bot("stackDrop", { slot: 0, count: 1 });
        await waitTicks(10);
        say("drop via ItemStackRequest", null, `response ${J(r2s)}; playerDropItem ${J(seenSince(t2, "playerDropItem").map(e => e.detail))}; inventory -> ${J(invOf(p))}; item entities ${link!.eventsSince(t2, "item_entity").length}`);
        cmd(`kill @e[type=item,x=${AX},y=${FLOOR},z=${AZ},r=20]`);
    },
    // throw a snowball: click_air with the snowball in hand
    async use() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        cmd(`give @a[name=${BOT}] snowball 4`);
        await waitTicks(10);
        const p = botPlayer()!;
        // without, then with, the inventory action a client predicts for the snowball it throws
        for (const consume of [0, 1]) {
            const t = tickNo;
            await bot("useItem", { consume });
            await waitTicks(10);
            const codes = seenSince(t, "tx:ItemUse").map(e => e.data.code);
            say(`use snowball${consume ? " (predicted action)" : ""}`, seenSince(t, "playerUseItem").length >= 1 || seenSince(t, "itemUse").length >= 1, `playerUseItem ${J(seenSince(t, "playerUseItem").map(e => e.detail))} itemUse ${seenSince(t, "itemUse").length} projectileShoot ${seenSince(t, "projectileShoot").length}; handle ${J(codes)}; inv ${J(invOf(p))}`);
            await waitTicks(5);
        }
        cmd(`kill @e[type=snowball]`);
    },
    // draw a bow for a second and let go
    async bow() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        cmd(`give @a[name=${BOT}] bow 1`);
        cmd(`give @a[name=${BOT}] arrow 8`);
        await waitTicks(10);
        const p = botPlayer()!;
        // twice: a bare release (the engine shoots and answers BalanceMismatch, 2), then one that predicts the shot's
        // changes the way the snowball's use does -- the bow one durability down, one arrow gone from slot 1 -- (1)
        for (const predict of [false, true]) {
            const t = tickNo;
            await bot("useItem", { startUsing: true });
            await waitTicks(5);
            const using = p.isUsingItem();
            await waitTicks(20);
            await bot("release", predict ? { ammoSlot: 1 } : {});
            await waitTicks(10);
            const rel = seenSince(t, "tx:ItemRelease").map(e => e.data.code);
            const shot = seenSince(t, "projectileShoot").map(e => e.detail);
            const detail = `isUsingItem while drawing ${using}; projectileShoot ${J(shot)}; handle use ${J(seenSince(t, "tx:ItemUse").map(e => e.data.code))} release ${J(rel)}; inv ${J(invOf(p))}`;
            if (predict) say("bow, release with the predicted arrow and wear: no error", rel[0] === 1 && shot.length === 1, detail);
            else say("bow, bare release", null, detail);
            cmd(`kill @e[type=arrow]`);
            await waitTicks(5);
        }
    },
    // eat: hungry first, then hold click_air on food
    async eat() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        cmd(`give @a[name=${BOT}] cooked_beef 2`);
        cmd(`effect @a[name=${BOT}] hunger 3 255 true`);
        await waitTicks(70);
        const p = botPlayer()!;
        const t = tickNo;
        await bot("useItem", { startUsing: true });
        await waitTicks(5);
        const using = p.isUsingItem();
        await waitTicks(40);
        say("eat", null, `isUsingItem ${using}; playerUseItem ${J(seenSince(t, "playerUseItem").map(e => e.detail))}; handle ${J(seenSince(t, "tx:ItemUse").map(e => e.data.code))}; inv ${J(invOf(p))}`);
        cmd(`effect @a[name=${BOT}] clear`);
    },
    // sleep: right-click a bed at night
    async bed() {
        await home();
        cmd(`clear @a[name=${BOT}]`);
        cmd("time set 18000");
        const b = { x: AX + 2, y: FLOOR + 1, z: AZ + 2 };
        cmd(`setblock ${b.x} ${b.y} ${b.z} bed`);
        await waitTicks(10);
        const t = tickNo;
        await bot("useItemOn", { ...b, face: 1 });
        await waitTicks(20);
        say("bed: playerSleepInBed", seenSince(t, "playerSleepInBed").length === 1, `playerSleepInBed ${J(seenSince(t, "playerSleepInBed").map(e => e.detail))}; handle ${J(seenSince(t, "tx:ItemUse").map(e => e.data.code))}`);
        cmd("time set day");
        await waitTicks(5);
        cmd(`setblock ${b.x} ${b.y} ${b.z} air`);
        cmd(`kill @e[type=item,x=${AX},y=${FLOOR},z=${AZ},r=20]`);
    },
    // swim: deep water, sprint forward, start_swimming
    async swim() {
        await home();
        const x0 = AX + 5, x1 = AX + 11, z0 = AZ - 3, z1 = AZ + 3;
        cmd(`fill ${x0 - 1} ${FLOOR - 5} ${z0 - 1} ${x1 + 1} ${FLOOR - 5} ${z1 + 1} stone`);
        cmd(`fill ${x0} ${FLOOR - 4} ${z0} ${x1} ${FLOOR} ${z1} water`);
        await waitTicks(10);
        await bot("ground", { y: null });
        cmd(`effect @a[name=${BOT}] saturation 2 255 true`); // sprinting needs food above 6
        cmd(`tp @a[name=${BOT}] ${x0 + 1.5} ${FLOOR - 2} ${AZ + 0.5} -90 0`);
        await waitTicks(10);
        const sp = botPlayer()!;
        // twice from the same spot: with a veto on entityStartSwimming (the flag must stay off), then allowed
        // (the flag goes on, one event). The server starts the swim itself a few ticks into a sprint in deep water.
        for (const cancel of [true, false]) {
            cmd(`tp @a[name=${BOT}] ${x0 + 1.5} ${FLOOR - 2} ${AZ + 0.5} -90 0`);
            await waitTicks(10);
            const t = tickNo;
            let on = 0;
            let firstOn = -1;
            const sample = (): void => {
                if (sp.isSwimming()) {
                    on++;
                    if (firstOn < 0) firstOn = tickNo - t;
                }
            };
            const veto = (e: { entity: Actor }): CANCEL | void => {
                if (cancel && isBot(e.entity)) return CANCEL;
            };
            events.levelTick.on(sample);
            events.entityStartSwimming.on(veto);
            await bot("sprint", { on: true });
            await bot("move", { forward: 1 });
            await waitTicks(8);
            await bot("flags", { list: ["start_swimming"] });
            await waitTicks(16);
            await bot("move", { forward: 0 });
            await bot("sprint", { on: false });
            await bot("flags", { list: ["stop_swimming"] });
            await waitTicks(15);
            events.entityStartSwimming.remove(veto);
            events.levelTick.remove(sample);
            const evs = seenSince(t, "entityStartSwimming").length;
            if (cancel) say("swim cancelled through entityStartSwimming", evs >= 1 && on === 0, `entityStartSwimming ${evs} (cancelled each tick it was tried); Swimming flag on for ${on} ticks`);
            else say("swim allowed: entityStartSwimming and the flag", evs === 1 && on > 0, `entityStartSwimming ${evs}; Swimming flag on for ${on} ticks from tick ${firstOn}; corrections ${link!.eventsSince(t, "correction").length}`);
        }
        await bot("flags", { list: ["stop_swimming"] });
        cmd(`fill ${x0} ${FLOOR - 4} ${z0} ${x1} ${FLOOR} ${z1} stone`);
        cmd(`fill ${x0} ${FLOOR} ${z0} ${x1} ${FLOOR} ${z1} stone`);
        await home();
        await bot("ground", { y: FLOOR + 1 });
    },
};

async function runAll(names: string[]): Promise<void> {
    if (link === null) return say("run", false, "the bot is not connected to the control port");
    npass = 0;
    nfail = 0;
    if (!(await arena())) return;
    for (const name of names) {
        const fn = scenarios[name];
        if (fn === undefined) {
            say(`run ${name}`, false, "no such scenario");
            continue;
        }
        console.log(`${TAG} INFO --- ${name}`);
        try {
            await fn();
        } catch (err) {
            say(`run ${name}`, false, `threw ${(err as Error).stack}`);
        }
        await waitTicks(10);
    }
    // lower case: verify-pair.mjs counts the words PASS and FAIL in every line
    console.log(`${TAG} INFO done: ${npass} pass, ${nfail} fail`);
}

if (PORT) {
    events.command.on(c => {
        const m = /^\/?lb\s+(\S+)(?:\s+(.*))?$/.exec(c);
        if (m === null) return;
        const arg = (m[2] ?? "").trim();
        if (m[1] === "status") {
            if (link === null) return say("status", null, "no bot on the control port");
            void bot("state").then(r => say("status", null, J(r)));
        } else if (m[1] === "diag") {
            installDiag();
            diagOn = arg !== "off";
        } else if (m[1] === "run") {
            const names = arg === "all" || arg === "" ? Object.keys(scenarios) : arg.split(/\s+/);
            void runAll(names).catch(err => say("run", false, `threw ${(err as Error).stack}`));
        } else {
            say("lb", false, `unknown subcommand ${m[1]}`);
        }
        return 0;
    });
}

// `lbtimers start|check` (no LB_PORT needed): whether node's loop runs while the server runs, which on 1.26 depends on
// bdsx's update-hook at _Invoke+0xfd8 (docs/findings-bot.md section 7). `start` arms a 1 s timeout and a 250 ms interval
// and counts level ticks; `check`, a few seconds later, compares them with the wall clock.
let timers: { t0: number; timeoutAt: number; intervals: number; ticks: number; counter: () => void } | null = null;
events.command.on(c => {
    const m = /^\/?lbtimers\s+(start|check)\s*$/.exec(c);
    if (m === null) return;
    if (m[1] === "start") {
        const st = { t0: Date.now(), timeoutAt: -1, intervals: 0, ticks: 0, counter: (): void => void st.ticks++ };
        timers = st;
        events.levelTick.on(st.counter);
        setTimeout(() => {
            st.timeoutAt = Date.now() - st.t0;
        }, 1000);
        const iv = setInterval(() => {
            st.intervals++;
        }, 250);
        setTimeout(() => clearInterval(iv), 1900);
        console.log(`${TAG} INFO lbtimers armed`);
    } else if (timers !== null) {
        const st = timers;
        const wall = Date.now() - st.t0;
        events.levelTick.remove(st.counter);
        const tps = (st.ticks * 1000) / wall;
        say("lbtimers: a 1 s timeout fires while the server runs", st.timeoutAt >= 900 && st.timeoutAt <= 1600, `fired after ${st.timeoutAt} ms (-1 = not yet), ${wall} ms of wall clock`);
        say("lbtimers: a 250 ms interval keeps time", st.intervals >= 5 && st.intervals <= 8, `${st.intervals} runs before it was cleared at 1.9 s`);
        say("lbtimers: the level still ticks at 20 a second", tps >= 18 && tps <= 21, `${st.ticks} ticks in ${wall} ms = ${tps.toFixed(1)} a second`);
        timers = null;
    }
    return 0;
});

// the lint-free use of the imported types that only appear in casts
void BlockPos;
void StaticPointer;
