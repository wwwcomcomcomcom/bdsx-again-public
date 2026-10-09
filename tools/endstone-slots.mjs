/**
 * Slot indices from Endstone's headers (Apache-2.0), applied to our exact
 * vftables.
 *
 * Endstone does not name Actor/Player virtuals: its headers declare them in
 * vtable order and MSVC compiles `player->attack(...)` into `call
 * [vft + 8*N]`. Those headers are layout-exact by necessity (a missing slot
 * would shift every call after it), so the declaration order is a slot table
 * maintained by people and tested by their plugins -- an oracle independent
 * of the 1.21.3.01 walk. This tool reads the order, emulates MSVC's layout
 * (a run of consecutively declared overloads of one name lands in reverse
 * order), maps bdsx's decorated names onto the slots by method name, and
 * reads the address out of a table we already hold exactly.
 *
 * A slot of a derived class's table holds the most-derived override, so a
 * name `?X@C@@` is read from C's own table (Player names from
 * ??_7Player@@6B@, Mob from ??_7Mob@@6B@, ServerPlayer from its table) and
 * Actor names are skipped until an Actor table is held.
 *
 * Usage: node tools/endstone-slots.mjs <endstoneDir> <version> <out.json>
 *   endstoneDir must be the release that targets the build (HEAD: 1.26.51; v0.11.7: 1.26.40)
 *   [--families=actor,scoreboard,...]  (default: every family that passed; see the note at ONLY)
 */
import * as fs from "fs";
import * as path from "path";
import { shape, compatible } from "./slot-shape.mjs";

const [dir, v, out, famArg] = process.argv.slice(2);
// --families=actor,level,... (default below). The level family is kept out of
// the merged candidates: Endstone's ILevel order is exact only where their
// plugins call it, and it put tick, getSeed and get/setDefaultSpawn one slot
// off against execution-confirmed addresses on both builds.
// scoreboard, commandorigin and connector passed the same checks on both
// builds (docs/findings-slots.md, route 8); packetsender fails the length gate.
const ONLY = (famArg ?? "--families=actor,scoreboard,commandorigin,connector,dimension,blocksource,gamemode,itemstack,container,blockactor,tag").replace(/^--families=/, "").split(",");
// Class families: the inheritance chain (base first, each header adding its
// new virtuals) and, per class bdsx names, the table its names are read from.
// A name's class may not hold a table of its own (Level implements ILevel's
// virtuals; its own table ??_7Level@@6BILevel@@@ exists only where the walk
// named it), so a fallback table is listed after it, flagged in the evidence.
const FAMILIES = {
    actor: { chain: [["Actor", "src/bedrock/world/actor/actor.h"], ["Mob", "src/bedrock/world/actor/mob.h"], ["Player", "src/bedrock/world/actor/player/player.h"], ["ServerPlayer", "src/bedrock/server/server_player.h"]],
             tables: { ServerPlayer: ["??_7ServerPlayer@@6B@"], Player: ["??_7Player@@6B@"], Mob: ["??_7Mob@@6B@"], Actor: ["??_7Actor@@6B@"] } },
    level: { chain: [["ILevel", "src/bedrock/world/level/level_interface.h"], ["Level", "src/bedrock/world/level/level.h"], ["ServerLevel", "src/bedrock/server/server_level.h"]],
             tables: { ServerLevel: ["??_7ServerLevel@@6BILevel@@@"], Level: ["??_7Level@@6BILevel@@@", "??_7ServerLevel@@6BILevel@@@"] } },
    // Families whose table was read from a live instance. A derived class
    // with no header of its own (ServerCommandOrigin) or one that only
    // overrides (ServerScoreboard, LoopbackPacketSender) adds no slots, and a
    // base outside the game's own hierarchy still lays out its virtuals first
    // (EnableNonOwnerReferences: the destructor at slot 0).
    scoreboard: { chain: [["Scoreboard", "src/bedrock/world/scores/scoreboard.h"], ["ServerScoreboard", "src/bedrock/world/scores/server_scoreboard.h"]],
                  tables: { ServerScoreboard: ["??_7ServerScoreboard@@6B@"] } },
    commandorigin: { chain: [["CommandOrigin", "src/bedrock/server/commands/command_origin.h"]],
                     tables: { ServerCommandOrigin: ["??_7ServerCommandOrigin@@6B@"] } },
    connector: { chain: [["Connector", "src/bedrock/network/connector.h"], ["RemoteConnector", "src/bedrock/network/remote_connector.h"], ["RakNetConnector", "src/bedrock/network/raknet_connector.h"]],
                 tables: { RakNetConnector: ["??_7RakNetConnector@@6BConnector@@@"] } },
    // Families reached from live objects by tools/reach-probe-launcher.js
    // (docs/findings-reach.md): the table is the vptr of an object a captured
    // actor or player holds, named by the reach and the slot count.
    dimension: { chain: [["IDimension", "src/bedrock/world/level/dimension/dimension.h"], ["Dimension", "src/bedrock/world/level/dimension/dimension.h"]],
                 tables: { Dimension: ["??_7Dimension@@6BIDimension@@@", "??_7OverworldDimension@@6BIDimension@@@"], OverworldDimension: ["??_7OverworldDimension@@6BIDimension@@@"], NetherDimension: ["??_7NetherDimension@@6BIDimension@@@"], TheEndDimension: ["??_7TheEndDimension@@6BIDimension@@@"] } },
    blocksource: { chain: [["IConstBlockSource", "src/bedrock/world/level/block_source.h"], ["IBlockSource", "src/bedrock/world/level/block_source.h"], ["BlockSource", "src/bedrock/world/level/block_source.h"]],
                   tables: { BlockSource: ["??_7BlockSource@@6B@"] } },
    gamemode: { chain: [["GameMode", "src/bedrock/world/gamemode/game_mode.h"]],
                tables: { GameMode: ["??_7GameMode@@6B@"], SurvivalMode: ["??_7SurvivalMode@@6B@"] } },
    itemstack: { chain: [["ItemStackBase", "src/bedrock/world/item/item_stack_base.h"]],
                 tables: { ItemStackBase: ["??_7ItemStackBase@@6B@", "??_7ItemStack@@6B@"], ItemStack: ["??_7ItemStack@@6B@"] } },
    container: { chain: [["Container", "src/bedrock/world/container.h"], ["FillingContainer", "src/bedrock/world/inventory/filling_container.h"], ["Inventory", "src/bedrock/world/actor/player/inventory.h"]],
                 // Container names are not read from Inventory's table: FillingContainer
                 // and Inventory override them (3 of 9 disagreed with the walk that way)
                 bases: { SimpleContainer: "Container", PlayerUIContainer: "Container" },
                 tables: { Container: ["??_7SimpleContainer@@6B@", "??_7PlayerUIContainer@@6B@"], SimpleContainer: ["??_7SimpleContainer@@6B@", "??_7PlayerUIContainer@@6B@"], PlayerUIContainer: ["??_7PlayerUIContainer@@6B@"], FillingContainer: ["??_7FillingContainer@@6B@"], Inventory: ["??_7Inventory@@6B@"] } },
    blockactor: { chain: [["BlockActor", "src/bedrock/world/level/block/actor/block_actor.h"]],
                  tables: { BlockActor: ["??_7BlockActor@@6B@"], ChestBlockActor: ["??_7ChestBlockActor@@6BRandomizableBlockActorContainerBase@@@"] } },
    // BlockLegacy is BlockType in 1.26 (block_type.h declares its virtuals in
    // vtable order; tick/randomTick/use are commented out there: gone from the
    // table, which is why ChestBlock::use never had a common slot). Each block
    // class reads from its own exact table (findings-reach.md). Not in the default
    // list: on 1.26.40.8 the 132-slot gate passes but transformOnFall's slot in
    // FarmBlock's table is the empty stub 0x76150 (the override is gone, like
    // use), so the family disagrees with the walk once and names one required
    // non-hook (asItemInstance@BlockLegacy, prototype changed). --families=block to run it.
    block: { chain: [["BlockType", "src/bedrock/world/level/block/block_type.h"]],
             tables: { BlockLegacy: ["??_7BlockLegacy@@6B@"], ChestBlock: ["??_7ChestBlock@@6B@"], ButtonBlock: ["??_7ButtonBlock@@6B@"], StoneButtonBlock: ["??_7StoneButtonBlock@@6B@"], FarmBlock: ["??_7FarmBlock@@6B@"], CampfireBlock: ["??_7CampfireBlock@@6B@"], SculkSensorBlock: ["??_7SculkSensorBlock@@6B@"], PistonBlock: ["??_7PistonBlock@@6B@"], StoneBlock: ["??_7StoneBlock@@6B@"] } },
    tag: { chain: [["Tag", "src/bedrock/nbt/tag.h"]],
           tables: { CompoundTag: ["??_7CompoundTag@@6B@"], ListTag: ["??_7ListTag@@6B@"], Tag: ["??_7CompoundTag@@6B@"] } },
    packetsender: { chain: [["EnableNonOwnerReferences", "src/bedrock/core/utility/enable_non_owner_references.h"], ["PacketSender", "src/bedrock/network/packet_sender.h"], ["LoopbackPacketSender", "src/bedrock/network/loopback_packet_sender.h"]],
                    tables: { LoopbackPacketSender: ["??_7LoopbackPacketSender@@6B@"] } },
};

/** The new virtual slots a class declares, in vtable order. */
function declaredVirtuals(file, cls) {
    const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const start = src.search(new RegExp(`^class ${cls}\\b[^;{]*\\{`, "m"));
    if (start < 0) throw new Error(`no class ${cls} in ${file}`);
    // the class body: brace-matched from the first '{'
    let i = src.indexOf("{", start), depth = 0, end = i;
    for (; end < src.length; end++) { if (src[end] === "{") depth++; else if (src[end] === "}") { depth--; if (depth === 0) break; } }
    const body = src.slice(i + 1, end);
    // declarations at the class's own depth, ended by ';' or by an inline
    // body's '{'; nested types (Connector::ConnectionCallbacks declares
    // virtuals of its own) and inline bodies are skipped. A brace inside
    // parentheses is a default argument, not a body.
    const decls = []; let cur = "", depth2 = 0, parens = 0;
    for (const l of body.split("\n").map(l => l.replace(/\/\/.*$/, ""))) {
        for (const ch of l) {
            if (depth2 === 0 && ch === "(") parens++;
            if (depth2 === 0 && ch === ")") parens--;
            if (ch === "{" && parens === 0) { if (depth2 === 0 && cur.trim()) { decls.push(cur.trim() + " {"); cur = ""; } depth2++; continue; }
            if (ch === "}" && parens === 0) { depth2--; continue; }
            if (depth2 > 0) continue;
            if (ch === ";") { if (cur.trim()) decls.push(cur.trim() + ";"); cur = ""; continue; }
            cur += ch;
        }
        cur += " ";
    }
    const out = [];
    for (const d of decls) {
        if (!/\bvirtual\b/.test(d)) continue;
        if (/\boverride\b/.test(d)) continue;   // an override keeps the base slot
        let name, params;
        const dt = d.match(/~\s*(\w+)\s*\(/);
        if (dt) { name = "~"; params = 0; }
        else {
            const m = d.match(/(\w+)\s*\(([^;]*)\)\s*(?:const)?\s*(?:noexcept)?\s*(?:=\s*0)?\s*;/) ?? d.match(/(\w+)\s*\(([\s\S]*)\)/);
            if (!m) continue;
            name = m[1];
            const inner = m[2].replace(/\([^()]*\)/g, "").replace(/<[^<>]*>/g, "").trim();
            params = inner === "" || inner === "void" ? 0 : inner.split(",").length;
        }
        out.push({ cls, name, params, decl: d.replace(/\s+/g, " ").slice(0, 120) });
    }
    // MSVC: consecutively declared overloads of the same name are laid out in reverse order
    const laid = [];
    for (let k = 0; k < out.length;) { let j = k; while (j + 1 < out.length && out[j + 1].name === out[k].name && out[k].name !== "~") j++; for (let q = j; q >= k; q--) laid.push(out[q]); k = j + 1; }
    return laid;
}

const required = JSON.parse(fs.readFileSync("data/required-symbols.json", "utf8")).symbols.map(s => s.name);
const merged = JSON.parse(fs.readFileSync(`data/merged-${v}.json`, "utf8"));
const scan = JSON.parse(fs.readFileSync(`work/vft/scan-${v}.json`, "utf8")).vftables;
// What the table knew before this tool: every merged source but its own
// output, which merged-<v>.json already contains (comparing against it would
// count a rerun's names as agreeing with themselves). The sources are read
// directly because the merge drops untrusted hook targets.
const load = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const known = {}, knownOrigin = {};
for (const [src, map] of [
    ["resolved", load(`data/resolved-${v}.json`)?.symbols],
    ["instances", load(`data/candidates-instances-${v}.json`)?.vftables],
    ["packets", load(`data/candidates-packets-${v}.json`)?.vftables],
    ["carry", (c => c && { ...c.vftables, ...c.symbols })(load(`data/candidates-carry-${v}.json`))],
    ["vftable-walk", (c => c && { ...c.vftables, ...c.symbols })(load(`data/candidates-vftable-${v}.json`))],
    ["propagation", load(`data/candidates-propagation-${v}.json`)?.symbols],
]) for (const [n, r] of Object.entries(map ?? {})) if (typeof r === "number" && !(n in known)) { known[n] = r; knownOrigin[n] = src; }
const EXACT = new Set(["resolved", "instances", "packets"]);
const walkByAddr = new Map(); for (const [n, r] of Object.entries(known)) (walkByAddr.get(r) ?? walkByAddr.set(r, []).get(r)).push(n);

/**
 * Which of a run of overloads a decorated name is. Only what tells the
 * overloads apart is compared: a method's constness (the cv letter after the
 * access code) and the type names one declaration mentions that the others do
 * not. Parameter names are lower-case and never decorated, so only capitalised
 * names and a few std templates count. One match or none: none stays ambiguous.
 */
const STD = { string: "basic_string", string_view: "basic_string_view", vector: "vector", optional: "optional", unique_ptr: "unique_ptr", shared_ptr: "shared_ptr", function: "function" };
function pickOverload(decorated, cands) {
    const isConst = /@@[A-Z]E(B)A/.test(decorated);
    const named = t => new RegExp(`(?:[VUT]|W4|\\?\\$|@)${t}@`).test(decorated);
    const toks = cands.map(s => new Set((s.decl.match(/\b[A-Za-z_]\w*\b/g) ?? []).filter(t => /^[A-Z]/.test(t) || t in STD).map(t => STD[t] ?? t)));
    const hits = cands.map((s, k) => {
        if (/\)\s*const\b/.test(s.decl) !== isConst) return false;
        const own = [...toks[k]].filter(t => !toks.every(o => o.has(t)));
        const others = toks.flatMap((o, j) => j === k ? [] : [...o].filter(t => !toks[k].has(t)));
        return own.every(named) && !others.some(named);
    });
    return hits.filter(Boolean).length === 1 ? hits.indexOf(true) : -1;
}
const symbols = {}, evidence = {}, families = {};
let agree = 0, disagree = 0, fresh = 0, ambiguous = 0, unmapped = 0;
const perFamily = {};
for (const [fam, spec] of Object.entries(FAMILIES)) {
    if (!ONLY.includes(fam)) continue;
    console.log(`== family ${fam}`);
    const slots = [];
    for (const [cls, rel] of spec.chain) { const own = declaredVirtuals(path.join(dir, rel), cls); console.log(`${cls}: ${own.length} new virtual slots`); slots.push(...own); }
    const tables = {};
    for (const [cls, names] of Object.entries(spec.tables)) for (const tn of names) { const r = merged.symbols[tn]; const t = r !== undefined ? Object.values(scan).find(t => t.rva === r) : null; if (t) { tables[cls] = { t, tn, fallback: tn !== names[0] }; console.log(`${cls}: ${tn} at 0x${r.toString(16)} (${merged.origin[tn]}), ${t.slots.length} slots in the scan${tn !== names[0] ? " (fallback)" : ""}`); break; } }
    console.log(`headers: ${slots.length} slots`);
    // The length gate: a table shorter than the slots the headers lay out up
    // to its class cannot be laid out as they say (LoopbackPacketSender: 9
    // slots against PacketSender's 11 on both builds), so none of its names
    // are read. A longer one is allowed: a derived class may add virtuals
    // its header does not declare (ServerPlayer: 247 against 245).
    for (const [cls, tb] of Object.entries(tables)) {
        // A class can hold a table and declare no virtuals of its own, so it is in `tables`
        // and not in `chain`: SimpleContainer only implements Container's pure virtuals, and
        // its table is as long as Container's, not as long as the whole chain down to
        // Inventory. `bases` names the chain class such a table belongs to; without it the
        // expected length stayed slots.length, which gated SimpleContainer's 44 slots against
        // Inventory's 55 and dropped every Container name. Families whose chain is one class
        // need no entry -- there slots.length is that class's own count.
        const k = spec.chain.findIndex(c => c[0] === (spec.bases?.[cls] ?? cls));
        tb.expected = k < 0 ? slots.length : slots.filter(s => spec.chain.findIndex(c => c[0] === s.cls) <= k).length;
        tb.short = tb.t.slots.length < tb.expected;
        if (tb.short) console.log(`${cls}: LENGTH GATE: ${tb.t.slots.length} slots in the table, ${tb.expected} in the headers; its names are not read`);
    }
    families[fam] = { headerSlots: slots.length, tables: Object.fromEntries(Object.entries(tables).map(([c, x]) => [c, x.tn])), slots };
    const byName = new Map(); slots.forEach((s, i) => (byName.get(s.name) ?? byName.set(s.name, []).get(s.name)).push(i));
    const classes = Object.keys(spec.tables).concat(spec.chain.map(c => c[0]));
    const re = new RegExp(`^\\?(\\w+)@(${[...new Set(classes)].join("|")})@@([A-Z])E`);
    const rows = [];
    const f0 = { agree, disagree, fresh, ambiguous, unmapped }; let exactAgree = 0, exactDisagree = 0;
    for (const n of required) {
        const m = n.match(re);
        if (!m || !"EFMNUV".includes(m[3])) continue;
        const idx = byName.get(m[1] === "??_E" ? "~" : m[1]);
        if (!idx) { unmapped++; rows.push(`  no slot   ${n.slice(0, 80)}`); continue; }
        let N = idx[0], overload = null;
        if (idx.length > 1) {
            const k = pickOverload(n, idx.map(i => slots[i]));
            if (k < 0) { ambiguous++; rows.push(`  overloads ${n.slice(0, 80)} -> slots ${idx.join(",")}`); continue; }
            N = idx[k]; overload = `${k + 1} of ${idx.length} overloads (slots ${idx.join(",")})`;
        }
        const tb = tables[m[2]];
        if (!tb) { rows.push(`  no table  ${n.slice(0, 80)} (slot ${N})`); continue; }
        if (N >= tb.t.slots.length) { rows.push(`  beyond    ${n.slice(0, 80)} slot ${N}`); continue; }
        if (tb.short) { rows.push(`  short     ${n.slice(0, 80)} slot ${N}: ${tb.tn} has ${tb.t.slots.length} slots, the headers lay out ${tb.expected}`); continue; }
        const addr = tb.t.slots[N];
        const walkHere = walkByAddr.get(addr) ?? [];
        const walkAddr = known[n];
        let verdict;
        if (walkAddr !== undefined) { const ex = EXACT.has(knownOrigin[n]); if (walkAddr === addr) { agree++; if (ex) exactAgree++; verdict = "AGREE with " + knownOrigin[n]; } else { disagree++; if (ex) exactDisagree++; verdict = `DISAGREE: ${knownOrigin[n]} says 0x${walkAddr.toString(16)}`; } }
        else { fresh++; verdict = walkHere.length ? `new; that slot is named ${walkHere[0].slice(0, 40)} by ${knownOrigin[walkHere[0]]}` : "new"; }
        if (overload) verdict += ` [${overload}]`;
        if (tb.fallback) verdict += " [fallback table: a derived override would show here]";
        symbols[n] = addr; evidence[n] = { family: fam, slot: N, table: tb.tn, fallbackTable: tb.fallback, declaredIn: slots[N].cls, decl: slots[N].decl, verdict };
        rows.push(`  #${String(N).padStart(3)} 0x${addr.toString(16).padStart(7, "0")} ${n.slice(0, 70).padEnd(70)} ${verdict}`);
    }
    for (const r of rows) console.log(r);
    perFamily[fam] = { agree: agree - f0.agree, disagree: disagree - f0.disagree, exactAgree, exactDisagree, new: fresh - f0.fresh, ambiguous: ambiguous - f0.ambiguous, noSlot: unmapped - f0.unmapped,
                       tableSlots: Object.fromEntries(Object.entries(tables).map(([c, x]) => [c, x.t.slots.length])) };
    Object.assign(families[fam], perFamily[fam]);
    console.log(`family ${fam}: header ${slots.length} slots, tables ${JSON.stringify(perFamily[fam].tableSlots)}; agree ${perFamily[fam].agree} (exact ${exactAgree}), disagree ${perFamily[fam].disagree} (exact ${exactDisagree}), new ${perFamily[fam].new}`);
}
console.log(`agree ${agree}, disagree ${disagree}, new ${fresh}, overload-ambiguous ${ambiguous}, no slot ${unmapped}`);
// Whose prototype changed: the body reads an argument register the
// 1.21.3.01 body never reads (tools/slot-shape.mjs). The address is still
// the slot's; bdsx's old prototype for it is not, so these are kept out of
// hook trust by tools/merge-symbols.mjs.
const full = JSON.parse(fs.readFileSync("data/baseline-symbols.json", "utf8")).symbols;
const signatureChanged = [];
for (const [n, a] of Object.entries(symbols)) { const b = full[n]; if (b === undefined) continue; if (!compatible(shape("work/bin/1.21.3.01/bedrock_server.exe", b), shape(`work/bin/${v}/bedrock_server.exe`, a))) signatureChanged.push(n); }
console.log(`signature changed (shape veto): ${signatureChanged.length}: ${signatureChanged.map(n => n.slice(0, 30)).join(", ")}`);
fs.writeFileSync(out, JSON.stringify({ _comment: `bdsx virtuals placed by Endstone's header order (tools/endstone-slots.mjs, ${dir}) into each class's own table on ${v}: agree ${agree} / disagree ${disagree} with the existing table, ${fresh} new. Families: ${ONLY.join(", ")}.`, endstone: dir, signatureChanged, symbols, evidence, families }, null, 1));
console.log(`-> ${out}`);
