// Execution check for command soft enums (docs/findings-scoreboard.md section 8).
//
// Deployed as zz-seprobe beside example_and_test and driven from the console (tools/run-full.ps1 -Commands):
//   seprobe before      no soft enum holds the probe's objective name yet
//   scoreboard objectives add seprobeobj dummy
//   seprobe after       the engine (ServerScoreboard::onObjectiveAdded -> addSoftEnumValues) put it in one
//   scoreboard objectives remove seprobeobj
//   seprobe removed     and took it out again
//   seprobe api         bdsx's own path: command.softEnum -> CommandRegistry::addSoftEnum, then add / remove /
//                       replace through CommandRegistry.updateSoftEnum, each read back from the registry's vector
//   seprobe register    command.register + overload with an int and a soft-enum parameter (docs/findings-scoreboard.md
//                       section 9): the engine's parse rules agree with the table's parse<T>, the registration
//                       goes through, and registerOverloadInternal filled the parameters as the engine does
//   seprobecmd 42 red   run from the console; the next step checks what the callback received:
//   seprobe ran 42 red  the callback ran with exactly these values (`seprobe ran none`: it did not run)
//   seprobe exec        the same command through bedrockServer.executeCommand; its callback calls output.success
//                       (docs/findings-scoreboard.md section 10.1), so the MCRESULT must be a success
//   seprobe types       registers `seprobetypes <f: float> <who: player selector> <at: x y z> <rest: raw text>` and
//                       `seprobeerr` (whose callback calls output.error) -- section 10.2/10.3
//   seprobetypes 1.5 @a 1 2.5 -3 hello raw world
//   seprobe typesran 1.5 1 2.5 -3 abs hello raw world   the callback got exactly these, `who` resolved to every player
//   seprobe typesexec   seprobetypes by the first player's name and seprobeerr, through bedrockServer.executeCommand
//   seprobe origin      registers `seprobeorigin`, whose callback reads the origin's getWorldPosition (bdsx's binding, by
//                       slot 4), getBlockPosition, and the OLD binding (procHacker.jsv's first-match slot search, which
//                       finds slot 3 because 1.26 folds the two zero-returning ServerCommandOrigin bodies into one);
//                       docs/findings-audit.md "Shared addresses"
//   seprobeorigin                                  from the console: a ServerCommandOrigin, both zero
//   seprobe originran server
//   execute as @a at @s run seprobeorigin          from the player's position
//   seprobe originran player                       getWorldPosition == the player's feet position (floats, x .5),
//                                                  getBlockPosition == its floor, the old binding != getWorldPosition
// Every line is tagged [seprobe] and states the expectation it checks.
import {
    ActorWildcardCommandSelector,
    Command,
    CommandFilePath,
    CommandIntegerRange,
    CommandItem,
    CommandMessage,
    CommandOutput,
    CommandOutputType,
    CommandPermissionLevel,
    CommandPosition,
    CommandPositionFloat,
    CommandRawText,
    CommandRegistry,
    CommandContext,
    CommandVersion,
    MCRESULT,
    MinecraftCommands,
    PlayerCommandSelector,
    ActorCommandSelector,
    CommandSelectionType,
    SoftEnumUpdateType,
} from "bdsx/bds/command";
import { DimensionId } from "bdsx/bds/actor";
import { JsonValue, JsonValueType } from "bdsx/bds/connreq";
import { dllraw } from "bdsx/dllraw";
import { NativePointer, StaticPointer } from "bdsx/core";
import { CANCEL } from "bdsx/common";
import { pdbcache } from "bdsx/pdbcache";
import { CommandEnum, EnumResult } from "bdsx/commandenum";
import { computeHashOf } from "bdsx/bds/hashedstring";
import { commandParseRules } from "bdsx/bds/engine/command";
import { translateText } from "bdsx/bds/engine/textobject";
import { CxxVector } from "bdsx/cxxvector";
import { proc } from "bdsx/bds/symbols";
import { command } from "bdsx/command";
import { CommandResultType } from "bdsx/commandresult";
import { events } from "bdsx/event";
import { bedrockServer } from "bdsx/launcher";
import { ActorCommandOrigin, CommandOrigin, ServerCommandOrigin } from "bdsx/bds/commandorigin";
import { GameRuleId } from "bdsx/bds/gamerules";
import { NetworkIdentifier } from "bdsx/bds/networkidentifier";
import { MinecraftPacketIds } from "bdsx/bds/packetids";
import { Player } from "bdsx/bds/player";
import { BlockPos, Vec3 } from "bdsx/bds/blockpos";
import { Block } from "bdsx/bds/block";
import { ItemStack } from "bdsx/bds/inventory";
import { procHacker } from "bdsx/prochacker";
import { bool_t, CxxString, float32_t, int32_t } from "bdsx/nativetype";

function say(label: string, ok: boolean | null, detail: string): void {
    console.log(`[seprobe] ${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

const OBJ = "seprobeobj";
const NAME = "seprobe_enum";
const RAW = "seprobe_raw";

/** every soft enum in the registry's vector as [name, values] */
function all(): [string, string[]][] {
    const r = bedrockServer.commandRegistry;
    const out: [string, string[]][] = [];
    const n = r.softEnums.size();
    for (let i = 0; i < n; i++) {
        const e = r.softEnums.get(i)!;
        out.push([e.name, e.list.toArray()]);
    }
    return out;
}
const holders = (value: string): string[] => all().filter(([, v]) => v.includes(value)).map(([n]) => n);
const same = (a: string[] | null, b: string[]): boolean => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);
const show = (a: string[] | null): string => (a === null ? "null" : `[${a.join(",")}]`);

const CMD = "seprobecmd";
const CMD_ENUM = "seprobe_cmdenum";
/** what the registered command's callback received last (null: not run since the last `seprobe ran`) */
let lastRun: { n: number; v: string; origin: string } | null = null;

interface OutputState {
    type: number;
    count: number;
    messages: number;
    last: { type: number; id: string; params: string[]; viaGetParams: string[] | string } | null;
}
/** what a CommandOutput holds: its type, success count and messages (2024's layout, kept by 1.26) */
function outputState(output: CommandOutput): OutputState {
    const n = output.messages.size();
    const m = n === 0 ? null : output.messages.get(n - 1)!;
    return { type: output.getType(), count: output.getSuccessCount(), messages: n, last:
            m === null
                ? null
                : {
                      type: m.type,
                      id: m.messageId,
                      params: m.params.toArray(),
                      // CommandOutputMessage::getParams through bdsx's binding (docs/findings-audit.md "The next audit batch")
                      viaGetParams: (() => {
                          try {
                              return m.getParams();
                          } catch (err) {
                              return `<${(err as Error).message}>`;
                          }
                      })(),
                  },
    };
}
const showOutput = (o: OutputState): string => `{type ${o.type}, successCount ${o.count}, ${o.messages} message(s)${o.last === null ? "" : `, last ${o.last.type === 0 ? "Success" : o.last.type === 1 ? "Error" : o.last.type} '${o.last.id}' [${o.last.params.join(",")}]`}}`;
let lastOutput: { before: OutputState; after: OutputState } | null = null;

const TYPES = "seprobetypes";
const ERR = "seprobeerr";
/** what seprobetypes' callback received last */
interface TypesRun {
    f: number;
    who: string[];
    at: [number, number, number, boolean, boolean, boolean];
    rest: string;
    out: { before: OutputState; after: OutputState };
}
let lastTypes: TypesRun | null = null;
let lastErr: { before: OutputState; after: OutputState } | null = null;

const PARSERS: Record<string, string> = {
    int: `??$parse@${int32_t.symbol}@CommandRegistry@@AEBA_NPEAXAEBUParseToken@0@AEBVCommandOrigin@@HAEAV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@AEAV?$vector@V?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@V?$allocator@V?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@2@@4@@Z`,
    "std::string": `??$parse@${CxxString.symbol}@CommandRegistry@@AEBA_NPEAXAEBUParseToken@0@AEBVCommandOrigin@@HAEAV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@AEAV?$vector@V?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@V?$allocator@V?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@2@@4@@Z`,
};
// HardNonTerminal values (Endstone command_registry.h): Int, Id, Val, RVal, WildcardInt, Position, PositionFloat, RawText,
// Selection, Selection, WildcardSelection, FullIntegerRange, FilePath, JsonObject, MessageRoot
const SYMBOLS: Record<string, number> = {
    int: 0x100001,
    "std::string": 0x100038,
    float: 0x100003,
    RelativeFloat: 0x100004,
    CommandWildcardInt: 0x100005,
    CommandPosition: 0x100040,
    CommandPositionFloat: 0x100041,
    CommandRawText: 0x100046,
    "CommandSelector<Actor>": 0x100008,
    "CommandSelector<Player>": 0x100008,
    "WildcardCommandSelector<Actor>": 0x10000a,
    // section 11: FullIntegerRange, FilePath, JsonObject, MessageRoot
    CommandIntegerRange: 0x100017,
    CommandFilePath: 0x100011,
    "Json::Value": 0x10004a,
    CommandMessage: 0x100044,
};
const hex = (n: number): string => `0x${(n >>> 0).toString(16)}`;

function register(r: CommandRegistry): void {
    // two routes to the same parser: the rule's first qword (filled by the engine's dynamic initializer, address
    // from the initializer scan) and the table's parse<T> address (body read)
    for (const [name, rule, fn, sym] of commandParseRules()) {
        // int and std::string also have their parse<T> in the table under the 2024 name: the rule must hold it. The
        // others are checked by the symbol the initializer wrote next to the parse function (and by parsing, below)
        const table = PARSERS[name] === undefined ? null : proc[PARSERS[name]];
        say(
            `ParseRuleFor<${name}>::instance`,
            rule !== null && fn !== null && fn.isNotNull() && (table === null || fn.equalsptr(table)) && sym === SYMBOLS[name],
            rule === null ? "no address" : `parse ${fn}${table === null ? "" : ` (table parse<${name}> ${table})`}, symbol ${hex(sym)} (want ${hex(SYMBOLS[name])})`,
        );
    }
    say(`findCommand('list') / findCommand('${CMD}') before`, r.findCommand("list") !== null && r.findCommand(CMD) === null, `${r.findCommand("list") !== null} / ${r.findCommand(CMD) !== null}`);
    const e = command.softEnum(CMD_ENUM, "red", "green");
    try {
        command.register(CMD, "soft enum probe command", CommandPermissionLevel.Operator).overload(
            (p, origin, output) => {
                lastRun = { n: p.n, v: p.v, origin: origin.getName() };
                // output.success(id, params) (docs/findings-scoreboard.md 10.1): the success count grows by one and,
                // unless the output is None/Silent, one Success message is added with the parameter as a string
                const out = outputState(output);
                output.success("commands.seprobe.ok", [p.n]);
                lastOutput = { before: out, after: outputState(output) };
                console.log(`[seprobe] INFO ${CMD} callback: n=${p.n} v=${p.v} origin=${lastRun.origin} output ${showOutput(lastOutput.before)} -> ${showOutput(lastOutput.after)}`);
            },
            { n: int32_t, v: e },
        );
        say(`command.register('${CMD}') + overload({ n: int32_t, v: softEnum('${CMD_ENUM}') })`, true, "no error");
    } catch (err) {
        say(`command.register('${CMD}') + overload({ n: int32_t, v: softEnum('${CMD_ENUM}') })`, false, `threw: ${(err as Error).stack}`);
        return;
    }
    const sig = r.findCommand(CMD);
    if (sig === null) {
        say(`findCommand('${CMD}') after`, false, "null");
        return;
    }
    const n = sig.overloads.size();
    say(`findCommand('${CMD}') after`, sig.command === CMD && n === 1, `name '${sig.command}', ${n} overload(s), symbol ${hex(sig.commandSymbol.value)}`);
    if (n !== 1) return;
    const ov = sig.overloads.get(0)!;
    const params = ov.parameters;
    say("overload", params.size() === 2 && ov.commandVersionOffset === -1 && ov.allocator !== null, `${params.size()} params, version ${ov.commandVersion}, allocator ${ov.allocator}, vtable ${ov.allocatorVftable}`);
    if (params.size() !== 2) return;
    const rules = commandParseRules();
    const p0 = params.get(0)!;
    const p1 = params.get(1)!;
    // registerOverloadInternal leaves a basic parameter alone (its symbol comes from the rule) and writes a soft
    // enum's symbol, index | 0x4100000, into enum_or_postfix_symbol
    say(
        "param 0 (int) after registerOverloadInternal",
        p0.name === "n" && p0.type === 0 && p0.enumOrPostfixSymbol === -1 && p0.parseRule !== null && p0.parseRule.equalsptr(rules[0][1]!),
        `name '${p0.name}', type ${p0.type}, symbol ${p0.enumOrPostfixSymbol}, offset ${p0.offset}, rule ${p0.parseRule}`,
    );
    const idx = r.softEnumLookup.get(CMD_ENUM);
    say(
        "param 1 (soft enum) after registerOverloadInternal",
        p1.name === "v" && p1.type === 2 && idx != null && p1.enumOrPostfixSymbol === (idx | 0x4100000) && p1.parseRule !== null && p1.parseRule.equalsptr(rules[1][1]!),
        `name '${p1.name}', type ${p1.type}, symbol ${hex(p1.enumOrPostfixSymbol)} (soft enum index ${idx}), offset ${p1.offset}, rule ${p1.parseRule}`,
    );
    say(`soft enum '${CMD_ENUM}' values`, same(r.getSoftEnumValues(CMD_ENUM), ["red", "green"]), show(r.getSoftEnumValues(CMD_ENUM)));
}

/** `seprobe ran <n> <v>` / `seprobe ran none`, optionally `info` last: report instead of judging */
function ran(args: string[]): void {
    const got = lastRun;
    lastRun = null;
    const info = args[args.length - 1] === "info";
    if (info) args = args.slice(0, -1);
    const shown = got === null ? "not run" : `ran with n=${got.n} v=${got.v} (origin ${got.origin})`;
    if (info) {
        say(`${CMD} ${args.join(" ")}`, null, shown);
    } else if (args[0] === "none") {
        say(`${CMD} with an argument that does not parse`, got === null, shown);
    } else {
        say(`${CMD} ${args.join(" ")} from the console`, got !== null && got.n === Number(args[0]) && got.v === args[1], shown);
        const o = lastOutput as { before: OutputState; after: OutputState } | null;
        lastOutput = null;
        if (got !== null) {
            // a console command's output keeps messages: output.success added one Success message carrying n
            const ok =
                o !== null &&
                o.after.count === o.before.count + 1 &&
                o.after.messages === o.before.messages + 1 &&
                o.after.last !== null &&
                o.after.last.type === 0 &&
                o.after.last.id === "commands.seprobe.ok" &&
                o.after.last.params.length === 1 &&
                o.after.last.params[0] === args[0];
            say(`output.success('commands.seprobe.ok', [${args[0]}]) from the console`, ok, o === null ? "not seen" : `${showOutput(o.before)} -> ${showOutput(o.after)}`);
            if (o !== null && o.after.last !== null) {
                const g = o.after.last.viaGetParams;
                say(
                    "CommandOutputMessage.getParams() on that message",
                    Array.isArray(g) && g.length === 1 && g[0] === args[0],
                    `getParams() ${JSON.stringify(g)}, the message's params field [${o.after.last.params.join(",")}]`,
                );
            }
        }
    }
}

let joined: string | null = null;
events.playerJoin.on(ev => {
    joined = ev.player.getName();
});

// CommandSelectorBase getName / hasName / setType / setIncludeDeadPlayers (docs/findings-scoreboard.md section 19):
// `seprobesel <who>` records what bdsx reads off the parsed selector, then what the engine's newResults returns before
// and after setType(Players); `seprobe selgot <hasName> <name|-> <after-count>` checks the last one
const SEL = "seprobesel";
let lastSel: { has: boolean; name: string; before: string[]; after: string[]; dead: boolean; explicit: boolean } | null = null;
function registerSel(): void {
    try {
        command.register(SEL, "selector probe", CommandPermissionLevel.Operator).overload(
            (p, origin) => {
                const has = p.who.hasName();
                const name = p.who.getName();
                const before = p.who.newResults(origin).map(a => a.getIdentifier() + ":" + a.getNameTag());
                p.who.setType(CommandSelectionType.Players);
                const after = p.who.newResults(origin).map(a => a.getIdentifier() + ":" + a.getNameTag());
                p.who.setIncludeDeadPlayers(true);
                lastSel = { has, name, before, after, dead: p.who.includeDeadPlayers, explicit: p.who.isExplicitIdSelector };
                console.log(`[seprobe] INFO ${SEL} callback: ${JSON.stringify(lastSel)}`);
            },
            { who: ActorCommandSelector },
        );
        say(`command.register('${SEL}', { who: ActorCommandSelector })`, true, "no error");
    } catch (err) {
        say(`command.register('${SEL}')`, false, `threw: ${(err as Error).stack}`);
    }
}
function selGot(args: string[]): void {
    const [hasS, nameS, countS] = args;
    const got = lastSel;
    lastSel = null;
    if (got === null) {
        say(`${SEL} ${args.join(" ")}`, false, "the callback did not run");
        return;
    }
    const wantName = nameS === "-" ? "" : nameS;
    const onlyPlayers = got.after.every(x => x.startsWith("minecraft:player:"));
    say(
        `${SEL} hasName ${hasS} getName '${wantName}'`,
        got.has === (hasS === "true") && got.name === wantName,
        `hasName ${got.has}, getName '${got.name}'`,
    );
    say(
        `${SEL} setType(Players) / setIncludeDeadPlayers`,
        onlyPlayers && got.after.length === Number(countS) && got.dead && !got.explicit,
        `newResults before [${got.before.join(", ")}], after setType(Players) [${got.after.join(", ")}] (want ${countS} player(s) only); includeDeadPlayers ${got.dead}, isExplicitIdSelector ${got.explicit}`,
    );
}

function registerTypes(): void {
    try {
        command.register(TYPES, "parameter type probe", CommandPermissionLevel.Operator).overload(
            (p, origin, output) => {
                const who = p.who.newResults(origin).map(a => a.getName());
                const before = outputState(output);
                output.success();
                lastTypes = {
                    f: p.f,
                    who,
                    at: [p.at.x, p.at.y, p.at.z, p.at.isXRelative, p.at.isYRelative, p.at.isZRelative],
                    rest: p.rest.text,
                    out: { before, after: outputState(output) },
                };
                console.log(`[seprobe] INFO ${TYPES} callback: f=${p.f} who=[${who.join(",")}] at=${JSON.stringify(lastTypes.at)} rest='${p.rest.text}' origin=${origin.getName()}`);
            },
            { f: float32_t, who: PlayerCommandSelector, at: CommandPositionFloat, rest: CommandRawText },
        );
        command.register(ERR, "output.error probe", CommandPermissionLevel.Operator).overload((p, origin, output) => {
            const before = outputState(output);
            output.error("commands.seprobe.err", ["x", 7]);
            lastErr = { before, after: outputState(output) };
            console.log(`[seprobe] INFO ${ERR} callback: output ${showOutput(before)} -> ${showOutput(lastErr.after)}`);
        }, {});
        say(`command.register('${TYPES}', { f: float32_t, who: PlayerCommandSelector, at: CommandPositionFloat, rest: CommandRawText }) and '${ERR}'`, true, "no error");
    } catch (err) {
        say(`command.register('${TYPES}') / '${ERR}'`, false, `threw: ${(err as Error).stack}`);
        return;
    }
    const r = bedrockServer.commandRegistry;
    const sig = r.findCommand(TYPES);
    const params = sig === null ? null : sig.overloads.get(0)!.parameters;
    const rules = new Map(commandParseRules().map(([n, rule]) => [n, rule]));
    const want = ["float", "CommandSelector<Player>", "CommandPositionFloat", "CommandRawText"];
    const got = params === null ? [] : params.toArray().map(q => q.parseRule);
    say(
        `${TYPES}'s parameters after registerOverloadInternal`,
        got.length === 4 && want.every((n, i) => got[i] !== null && rules.get(n) != null && got[i]!.equalsptr(rules.get(n)!)),
        params === null ? "no signature" : params.toArray().map((q, i) => `${q.name}: type ${q.type}, offset ${q.offset}, rule ${q.parseRule} (want ${want[i]} ${rules.get(want[i])})`).join("; "),
    );
}

/** `seprobe typesran <f> <x> <y> <z> abs|rel <rest...>` / `seprobe typesran none` */
function typesRan(args: string[]): void {
    const got = lastTypes;
    lastTypes = null;
    if (args[0] === "none") {
        say(`${TYPES} with a float that does not parse`, got === null, got === null ? "not run" : `ran with f=${got.f}`);
        return;
    }
    if (got === null) {
        say(`${TYPES} ${args.join(" ")}`, false, "not run");
        return;
    }
    const [f, x, y, z, rel, ...rest] = args;
    const relative = rel === "rel";
    // the engine centres an absolute whole-number x and z on the block (readRelativeCoordinate's centre flag is set
    // for x and z, clear for y: 2024's parse<CommandPosition> and 1.26's alike), as `tp 1 2 3` lands on 1.5 2 3.5
    const centre = (v: string): number => (!relative && /^-?\d+$/.test(v) ? Number(v) + 0.5 : Number(v));
    const players = bedrockServer.level.getPlayers().map(q => q.getName());
    const sameSet = got.who.length === players.length && players.every(n => got.who.includes(n));
    say(`${TYPES}: float parameter`, got.f === Number(f), `f=${got.f} (want ${f})`);
    say(`${TYPES}: player selector @a -> newResults`, sameSet && players.length > 0, `[${got.who.join(",")}] (level players [${players.join(",")}])`);
    say(
        `${TYPES}: position parameter`,
        got.at[0] === centre(x) && got.at[1] === Number(y) && got.at[2] === centre(z) && got.at[3] === relative && got.at[4] === relative && got.at[5] === relative,
        `${JSON.stringify(got.at)} (want ${centre(x)} ${y} ${centre(z)} ${relative ? "relative" : "absolute"})`,
    );
    say(`${TYPES}: raw text parameter`, got.rest === rest.join(" "), `'${got.rest}' (want '${rest.join(" ")}')`);
    say(`${TYPES}: output.success() with no message`, got.out.after.count === got.out.before.count + 1 && got.out.after.messages === got.out.before.messages, `${showOutput(got.out.before)} -> ${showOutput(got.out.after)}`);
}

function typesExec(): void {
    const name = joined ?? bedrockServer.level.getPlayers().map(q => q.getName())[0] ?? null;
    if (name === null) {
        say("typesexec", false, "(no player)");
        return;
    }
    lastTypes = null;
    const res = bedrockServer.executeCommand(`${TYPES} -0.25 "${name}" 3 4 5 by name`, CommandResultType.Data);
    const got = lastTypes as TypesRun | null;
    lastTypes = null;
    say(
        `bedrockServer.executeCommand('${TYPES} -0.25 "${name}" 3 4 5 by name')`,
        got !== null && got.f === -0.25 && got.who.length === 1 && got.who[0] === name && got.rest === "by name" && res.isSuccess(),
        `${got === null ? "not run" : `f=${got.f} who=[${got.who.join(",")}] rest='${got.rest}'`}, MCRESULT success ${res.isSuccess()}`,
    );
    lastErr = null;
    const res2 = bedrockServer.executeCommand(ERR, CommandResultType.Output);
    const e = lastErr as { before: OutputState; after: OutputState } | null;
    lastErr = null;
    // output.error: no success, one Error message with the parameters as strings (AllOutput keeps messages)
    const ok =
        e !== null &&
        !res2.isSuccess() &&
        e.after.count === e.before.count &&
        e.after.messages === e.before.messages + 1 &&
        e.after.last !== null &&
        e.after.last.type === 1 &&
        e.after.last.id === "commands.seprobe.err" &&
        e.after.last.params.join(",") === "x,7";
    say(`bedrockServer.executeCommand('${ERR}') -> output.error`, ok, `MCRESULT success ${res2.isSuccess()} (0x${(res2.getFullCode() >>> 0).toString(16)}), output ${e === null ? "not seen" : `${showOutput(e.before)} -> ${showOutput(e.after)}`}`);
}

// ---- CommandOrigin::getWorldPosition by slot (docs/findings-audit.md "Shared addresses") ----
const ORIGIN = "seprobeorigin";
/** the pre-fix binding, rebuilt here on purpose: procHacker.jsv's first slot holding the address */
const oldWorldPosition = procHacker.jsv("??_7ServerCommandOrigin@@6B@", "?getWorldPosition@ServerCommandOrigin@@UEBA?AVVec3@@XZ", Vec3, {
    this: CommandOrigin,
    structureReturn: true,
});
interface OriginRun {
    type: number;
    world: [number, number, number];
    block: [number, number, number];
    old: [number, number, number] | string;
    feet: [number, number, number] | null;
}
let lastOrigin: OriginRun | null = null;
const v3 = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z];
const showV = (v: [number, number, number] | string | null): string => (v === null ? "null" : typeof v === "string" ? v : `(${v.map(x => (Number.isInteger(x) ? String(x) : x.toPrecision(6))).join(", ")})`);
function registerOrigin(): void {
    try {
        // Normal: `execute as <player>` runs the command at the player's permission level, and the bot is not an operator
        command.register(ORIGIN, "command origin position probe", CommandPermissionLevel.Normal).overload((p, origin) => {
          try {
            let old: [number, number, number] | string;
            try {
                old = v3(oldWorldPosition.call(origin));
            } catch (err) {
                old = `threw ${(err as Error).message}`;
            }
            const ent = origin.getEntity();
            // Actor::getPosition (the table has no CommandUtils::getFeetPos): a player's is its eye, 1.62 above the feet
            lastOrigin = { type: origin.getOriginType(), world: v3(origin.getWorldPosition()), block: v3(origin.getBlockPosition()), old, feet: ent === null ? null : v3(ent.getPosition()) };
            console.log(
                `[seprobe] INFO ${ORIGIN} callback: originType ${lastOrigin.type}, vftable ${origin.vftable}, getWorldPosition ${showV(lastOrigin.world)}, getBlockPosition ${showV(lastOrigin.block)}, old binding ${showV(old)}, entity getPosition ${showV(lastOrigin.feet)}`,
            );
          } catch (err) {
            console.log(`[seprobe] FAIL ${ORIGIN} callback threw: ${(err as Error).stack}`);
          }
        }, {});
        say(`command.register('${ORIGIN}')`, true, "no error");
    } catch (err) {
        say(`command.register('${ORIGIN}')`, false, `threw: ${(err as Error).stack}`);
    }
}
function originRan(kind: string): void {
    const o = lastOrigin;
    lastOrigin = null;
    if (o === null) {
        say(`${ORIGIN} (${kind}) ran`, false, "the callback did not run");
        return;
    }
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;
    if (kind === "server") {
        say("ServerCommandOrigin: getWorldPosition == (0, 0, 0)", o.world.every(x => x === 0), showV(o.world));
        say("ServerCommandOrigin: getBlockPosition == (0, 0, 0)", o.block.every(x => x === 0), showV(o.block));
        return;
    }
    if (o.feet === null) {
        say(`${ORIGIN} (player): origin has an entity`, false, "getEntity() is null");
        return;
    }
    const f = o.feet;
    say(
        "player origin: getWorldPosition == the entity's position (x, z equal; y at most 2 below getPosition's eye height)",
        near(o.world[0], f[0]) && near(o.world[2], f[2]) && o.world[1] <= f[1] + 1e-3 && o.world[1] >= f[1] - 2,
        `${showV(o.world)} vs getPosition ${showV(f)}`,
    );
    say("player origin: x has a fraction (a Vec3, not a BlockPos read as floats)", !Number.isInteger(o.world[0]) && Math.abs(o.world[0]) > 1, showV(o.world));
    say("player origin: getBlockPosition == floor(getWorldPosition)", o.block.every((x, i) => x === Math.floor(o.world[i])), `${showV(o.block)} vs ${showV(o.world)}`);
    say(
        "player origin: the old first-match binding (slot 3) is NOT getWorldPosition",
        typeof o.old !== "string" && !o.old.every((x, i) => near(x, o.world[i])),
        `old ${showV(o.old)} (the BlockPos's int bits as floats) vs ${showV(o.world)}`,
    );
}

// ---- the rest of the parameter types (docs/findings-scoreboard.md section 11) ----
//   seprobe enums       INFO: the engine's enums whose names bdsx's typeid-pointer types could map to (Boolean, Block,
//                       Item, Entity...): name, type id, parse RVA, value count
//   seprobe params      registers one command per type: seprobebool <b: bool>, seproberange <r: CommandIntegerRange>,
//                       seprobepath <p: CommandFilePath>, seprobeenum <e: enum SeprobeEnum> <d: enum DimensionId>,
//                       seprobejson <j: Json::Value>, seprobewild <w: ActorWildcardCommandSelector>,
//                       seprobeopt <a: int> [b: string], seprobeblock <blk: Command.Block>, seprobepos <p: CommandPosition>,
//                       seprobemsg <m: CommandMessage>
//                       and checks what registerOverloadInternal made of each parameter
//   <command> <args>    then `seprobe got <kind> <expected...>` checks what the callback received
const PARAMS = {
    bool: "seprobebool",
    range: "seproberange",
    path: "seprobepath",
    enum: "seprobeenum",
    json: "seprobejson",
    wild: "seprobewild",
    opt: "seprobeopt",
    block: "seprobeblock",
    pos: "seprobepos",
    msg: "seprobemsg",
    item: "seprobeitem",
    entity: "seprobeentity",
    blockraw: "seprobeblockraw",
};

const hex64 = (p: StaticPointerLike, off = 0): string => `${p.getUint32(off + 4).toString(16).padStart(8, "0")}${p.getUint32(off).toString(16).padStart(8, "0")}`;
interface StaticPointerLike {
    getUint32(off?: number): number;
}
/** the engine's data for the value named `token` in enum `name` (Enum::values is { value index, data }) */
function enumData(name: string, token: string): string | null {
    const r = bedrockServer.commandRegistry;
    const e = r.getEnum(name);
    if (e === null) return null;
    const n = e.values.size();
    const base = (e as unknown as NativePointer).getPointer(0x30);
    for (let i = 0; i < n; i++) {
        const idx = base.getUint32(i * 16);
        if (r.enumValues.get(idx) === token) return hex64(base, i * 16 + 8);
    }
    return null;
}
/** the raw storage the "Block" enum's parse wrote (docs/findings-scoreboard.md 11.6) */
class RawBlockEnum extends CommandEnum<{ data: string; token: string }> {
    constructor() {
        super("Block");
    }
    mapValue(value: EnumResult): { data: string; token: string } {
        return { data: hex64(value as unknown as StaticPointerLike), token: value.token };
    }
}
let lastParam: { kind: string; v: any } | null = null;
function gotParam(kind: string, v: any): void {
    lastParam = { kind, v };
    console.log(`[seprobe] INFO ${kind} callback: ${JSON.stringify(v)}`);
}

function dumpEnums(): void {
    const r = bedrockServer.commandRegistry;
    const n = r.enums.size();
    const want = /^(Boolean|Block|Item|Entity.*|.*[Bb]lock.*|.*[Ii]tem.*|.*[Ee]ntity.*|DimensionId|SeprobeEnum)$/;
    const hits: string[] = [];
    for (let i = 0; i < n; i++) {
        const e = r.enums.get(i)!;
        if (!want.test(e.name)) continue;
        hits.push(`${e.name}#${i}(tid ${e.tid.id}, parse 0x${e.parser.subptr(dllraw.current).toString(16)}, ${e.values.size()} values)`);
    }
    say("enums", null, `${n} enums; ${hits.join(" ")}`);
}

function registerParams(): void {
    const r = bedrockServer.commandRegistry;
    const reg = (name: string, what: string, f: () => void): void => {
        try {
            f();
            say(`command.register('${name}') ${what}`, true, "no error");
        } catch (err) {
            say(`command.register('${name}') ${what}`, false, `threw: ${(err as Error).stack}`);
        }
    };
    const perm = CommandPermissionLevel.Operator;
    reg(PARAMS.bool, "{ b: bool_t }", () =>
        command.register(PARAMS.bool, "bool probe", perm).overload((p, o, out) => {
            gotParam("bool", p.b);
            out.success();
        }, { b: bool_t }),
    );
    reg(PARAMS.range, "{ r: CommandIntegerRange }", () =>
        command.register(PARAMS.range, "integer range probe", perm).overload((p, o, out) => {
            gotParam("range", { min: p.r.min, max: p.r.max, inverted: p.r.inverted, in5: p.r.isWithinRange(5), in8: p.r.isWithinRange(8) });
            out.success();
        }, { r: CommandIntegerRange }),
    );
    reg(PARAMS.path, "{ p: CommandFilePath }", () =>
        command.register(PARAMS.path, "file path probe", perm).overload((p, o, out) => {
            gotParam("path", p.p.text);
            out.success();
        }, { p: CommandFilePath }),
    );
    reg(PARAMS.enum, "{ e: enum SeprobeEnum(alpha, Beta), d: enum DimensionId }", () =>
        command.register(PARAMS.enum, "enum probe", perm).overload((p, o, out) => {
            gotParam("enum", { e: p.e, d: p.d });
            out.success();
        }, { e: command.enum("SeprobeEnum", "alpha", "Beta"), d: command.enum("DimensionId", DimensionId) }),
    );
    reg(PARAMS.json, "{ j: JsonValue }", () =>
        command.register(PARAMS.json, "json probe", perm).overload((p, o, out) => {
            gotParam("json", { type: p.j.type, value: p.j.value(), size: p.j.size() });
            out.success();
        }, { j: JsonValue }),
    );
    reg(PARAMS.wild, "{ w: ActorWildcardCommandSelector }", () =>
        command.register(PARAMS.wild, "wildcard selector probe", perm).overload((p, o, out) => {
            gotParam("wild", { names: p.w.newResults(o).map(a => a.getNameTag()) });
            out.success();
        }, { w: ActorWildcardCommandSelector }),
    );
    reg(PARAMS.opt, "{ a: int32_t, b?: CxxString }", () =>
        command.register(PARAMS.opt, "optional probe", perm).overload((p, o, out) => {
            gotParam("opt", { a: p.a, b: p.b === undefined ? null : p.b });
            out.success();
        }, { a: int32_t, b: [CxxString, true] }),
    );
    reg(PARAMS.block, "{ blk: Command.Block }", () =>
        command.register(PARAMS.block, "block probe", perm).overload((p, o, out) => {
            gotParam("block", { name: p.blk === null || p.blk === undefined ? null : p.blk.getName() });
            out.success();
        }, { blk: Command.Block }),
    );
    reg(PARAMS.pos, "{ p: CommandPosition }", () =>
        command.register(PARAMS.pos, "position probe", perm).overload((p, o, out) => {
            const v = p.p.getPosition(o);
            const b = p.p.getBlockPosition(o, Vec3.create(0, 4, 0));
            const w = o.getWorldPosition();
            gotParam("pos", { pos: [v.x, v.y, v.z], block: [b.x, b.y, b.z], world: [w.x, w.y, w.z] });
            out.success();
        }, { p: CommandPosition }),
    );
    reg(PARAMS.msg, "{ m: CommandMessage }", () =>
        command.register(PARAMS.msg, "message probe", perm).overload((p, o, out) => {
            gotParam("msg", { text: p.m.getMessage(o), components: p.m.data.size() });
            out.success();
        }, { m: CommandMessage }),
    );
    reg(PARAMS.item, "{ i: CommandItem }", () =>
        command.register(PARAMS.item, "item probe", perm).overload((p, o, out) => {
            gotParam("item", { raw: hex64(p.i as unknown as StaticPointerLike), version: p.i.version, id: p.i.id });
            out.success();
        }, { i: CommandItem }),
    );
    reg(PARAMS.entity, "{ e: Command.ActorDefinitionIdentifier }", () =>
        command.register(PARAMS.entity, "entity type probe", perm).overload((p, o, out) => {
            const ptr = p.e as unknown as NativePointer | null;
            const raw = ptr === null ? "null" : ptr.toString();
            let fullName: string | null = null;
            // read it as an ActorDefinitionIdentifier only when it looks like a user-space pointer
            if (ptr !== null && !ptr.isNull() && ptr.getAddressHigh() >= 0x10 && ptr.getAddressHigh() < 0x7fff) fullName = (p.e as any).fullName;
            gotParam("entity", { raw, fullName });
            out.success();
        }, { e: Command.ActorDefinitionIdentifier }),
    );
    reg(PARAMS.blockraw, "{ b: raw Block enum }", () =>
        command.register(PARAMS.blockraw, "block enum raw probe", perm).overload((p, o, out) => {
            const v = p.b as { data: string; token: string };
            const hashes: Record<string, string> = {};
            for (const n of [v.token, `minecraft:${v.token}`]) hashes[n] = computeHashOf(n).toString();
            gotParam("blockraw", { data: v.data, token: v.token, enumData: enumData("Block", v.token), hashes });
            out.success();
        }, { b: new RawBlockEnum() }),
    );
    // what registerOverloadInternal made of the parameters (type 0 basic, 1 enum; +0x40 the grammar symbol)
    for (const [kind, name] of Object.entries(PARAMS)) {
        const sig = r.findCommand(name);
        if (sig === null) continue;
        const params = sig.overloads.get(0)!.parameters.toArray();
        const show = params
            .map(q => {
                const en = q.enumNameOrPostfix === null ? "" : ` '${q.enumNameOrPostfix.as(NativePointer).getString()}'`;
                const po = q.parseOverride === null ? "none" : `0x${q.parseOverride.subptr(dllraw.current).toString(16)}`;
                return `${q.name}: type ${q.type}${en}, tid ${q.tid.id}, symbol 0x${(q.enumOrPostfixSymbol >>> 0).toString(16)}, override ${po}`;
            })
            .join("; ");
        if (kind === "bool") {
            const q = params[0];
            const e = r.getEnum("Boolean");
            say(
                `${name}: bool_t became the engine's Boolean enum parameter`,
                q.type === 1 && q.enumNameOrPostfix !== null && q.enumNameOrPostfix.as(NativePointer).getString() === "Boolean" && e !== null && q.tid.id === e.tid.id && q.parseOverride !== null && q.parseOverride.equalsptr(e.parser),
                show,
            );
        } else if (kind === "enum") {
            const ok = params.every(q => {
                const e = q.enumNameOrPostfix === null ? null : r.getEnum(q.enumNameOrPostfix.as(NativePointer).getString());
                return q.type === 1 && e !== null && q.parseOverride !== null && q.parseOverride.equalsptr(e.parser);
            });
            say(`${name}: enum parameters carry their enum's (hooked) parse`, ok, show);
        } else {
            say(`${name} parameters`, null, show);
        }
    }
}

/**
 * `seprobe blocks`: Block.create over the engine's block type registry (docs/findings-blocks.md "The block type
 * registry on 1.26"). Both sides of the lookup (a hit and a miss), a bare name, the 0x7fff default-state branch, and
 * getBlockItemId against the id the engine's own item registry gives the block's item, below and above 0x100.
 */
function blockLookups(): void {
    const stone = Block.create("minecraft:stone");
    say("Block.create('minecraft:stone')", stone !== null && stone.getName() === "minecraft:stone", stone === null ? "null" : `${stone} '${stone.getName()}'`);
    const bare = Block.create("stone");
    say("Block.create('stone'): the bare name finds the same block", bare !== null && stone !== null && bare.equalsptr(stone), bare === null ? "null" : `${bare}`);
    const planks = Block.create("minecraft:oak_planks");
    say("Block.create('minecraft:oak_planks')", planks !== null && planks.getName() === "minecraft:oak_planks", planks === null ? "null" : `'${planks.getName()}'`);
    const none = Block.create("minecraft:no_such_block_seprobe");
    say("Block.create('minecraft:no_such_block_seprobe') is null", none === null, none === null ? "null" : `${none} '${none.getName()}'`);
    const empty = Block.create("");
    say("Block.create('') is null", empty === null, empty === null ? "null" : `${empty}`);
    if (stone !== null) {
        const legacy = stone.blockLegacy;
        const def = Block.create("minecraft:stone", 0x7fff);
        say("Block.create('minecraft:stone', 0x7fff) is the default state", def !== null && def.equalsptr(legacy.getDefaultState()), def === null ? "null" : `${def} vs ${legacy.getDefaultState()}`);
    }
    // getBlockItemId (derived: BlockType::id_ at +0x17e) against ItemStack's id for the block's item, which the engine
    // looks up by name in its item registry -- a route that does not touch the block type
    for (const name of ["minecraft:stone", "minecraft:deepslate", "minecraft:oak_planks"]) {
        const b = Block.create(name);
        if (b === null) {
            say(`${name}: getBlockItemId`, false, "no block");
            continue;
        }
        const stack = ItemStack.constructWith(name);
        const itemId = stack.getId();
        stack.destruct();
        const blockItemId = b.blockLegacy.getBlockItemId();
        say(`${name}: getBlockItemId == the item's id`, blockItemId === itemId && itemId !== 0, `block ${blockItemId}, item ${itemId}`);
    }
    // repeated lookups: 1.26.40's result holds a weak reference bdsx must give back
    let same = 0;
    for (let i = 0; i < 500; i++) {
        const b = Block.create("minecraft:stone");
        if (b !== null && stone !== null && b.equalsptr(stone)) same++;
    }
    say("500 lookups of minecraft:stone", same === 500, `${same}/500 the same block`);
}

/** `seprobe got <kind> <json of what the callback should have received>` / `seprobe got <kind> none` */
function checkParam(args: string[]): void {
    const [kind, ...rest] = args;
    const got = lastParam;
    lastParam = null;
    const text = rest.join(" ");
    if (text === "none") {
        say(`${kind}: the command did not run`, got === null, got === null ? "not run" : `ran with ${JSON.stringify(got.v)}`);
        return;
    }
    if (got === null || got.kind !== kind) {
        say(`${kind} ${text}`, false, got === null ? "not run" : `last callback was ${got.kind}`);
        return;
    }
    let want: any;
    try {
        want = JSON.parse(text);
    } catch {
        want = text;
    }
    if (kind === "wild") {
        const players = bedrockServer.level.getPlayers().map(q => q.getNameTag());
        const names: string[] = got.v.names;
        const ok = want === "players" ? players.length > 0 && players.every(n => names.includes(n)) : names.length >= Number(want);
        say(`${kind}: newResults`, ok, `[${names.join(",")}] (want ${want === "players" ? `every player [${players.join(",")}]` : `at least ${want}`})`);
        return;
    }
    const norm = (h: string | null): string => (h === null ? "null" : h.replace(/^0x/, "").replace(/^0+(?=.)/, "").toLowerCase());
    if (kind === "item" || kind === "entity") {
        // the parse stored the enum's data for the token's value (Item / EntityType share the parse)
        const name = kind === "item" ? "Item" : "EntityType";
        const cands = [enumData(name, text), enumData(name, `minecraft:${text}`)].filter(x => x !== null) as string[];
        const raw = norm(got.v.raw);
        say(`${kind}: the parameter holds the ${name} enum's data for '${text}'`, cands.some(c => norm(c) === raw), `${JSON.stringify(got.v)} (enum data ${JSON.stringify(cands)})`);
        return;
    }
    if (kind === "blockraw") {
        const v = got.v as { data: string; token: string; enumData: string | null; hashes: Record<string, string> };
        say(`${kind}: the Block enum's parse stored the enum data for '${v.token}'`, v.enumData !== null && norm(v.enumData) === norm(v.data), JSON.stringify(v));
        const named = Object.entries(v.hashes).filter(([, h]) => norm(h) === norm(v.data)).map(([n]) => n);
        say(`${kind}: that data is HashedString::computeHash of the block's name (2024's CommandBlockName)`, named.length > 0, named.length > 0 ? `the hash of '${named[0]}'` : "no name hash matched");
        return;
    }
    if (kind === "pos" && want === "player") {
        // `execute as @a at @s run seprobepos ~ ~1 ~`: relative axes add the origin's world position (and, for the
        // block position, the (0, 4, 0) offset the callback passes), as 2024's getPosition / getBlockPos did
        const { pos, block, world } = got.v as { pos: number[]; block: number[]; world: number[] };
        const f = Math.fround;
        const wantPos = [world[0], f(world[1] + 1), world[2]];
        const wantBlock = [Math.floor(f(world[0] + 0.001)), Math.floor(f(f(world[1] + 5) + 0.001)), Math.floor(f(world[2] + 0.001))];
        const ok = pos.every((x, i) => Math.abs(x - wantPos[i]) < 1e-4) && block.every((x, i) => x === wantBlock[i]) && world.some(x => x !== 0);
        say(`${kind}: relative position from a player origin`, ok, `${JSON.stringify(got.v)} (want pos ${JSON.stringify(wantPos)}, block ${JSON.stringify(wantBlock)})`);
        return;
    }
    const a = JSON.stringify(got.v);
    const b = JSON.stringify(want);
    say(`${kind}: the callback received`, a === b, `${a} (want ${b})`);
}

// ---- CommandRegistry::Parser and getCommandName (docs/findings-scoreboard.md section 12) ----
//   seprobe parser      (after `seprobe register`) getCommandName on three lines; Parser: a good line parses,
//                       createCommand makes the plugin command and Command::run runs its callback; a bad argument and
//                       an unknown command fail with the engine's error message and parameters; 200 rounds;
//                       CommandOutput(AllOutput / DataSet), set_int, Command.run into each, 200 construct/destruct rounds
function parserChecks(r: CommandRegistry): void {
    for (const [line, want] of [
        [`${CMD} 42 red`, CMD],
        ["   tp @a 1 2 3", "tp"],
        ["", ""],
    ]) {
        const got = r.getCommandName(line);
        say(`getCommandName('${line}')`, got === want, `'${got}' (want '${want}')`);
    }
    const version = CommandVersion.CurrentVersion;
    say("CommandVersion.CurrentVersion", null, String(version));
    const origin = ServerCommandOrigin.constructWith("Server", bedrockServer.level, CommandPermissionLevel.Admin, null);
    try {
        // the good side: parse -> createCommand -> Command::run reaches the plugin callback
        const p = CommandRegistry.Parser.constructWith(r, version);
        const ok = p.parseCommand(`${CMD} 9 green`);
        say(`Parser.parseCommand('${CMD} 9 green')`, ok === true, `${ok}, error '${p.getErrorMessage()}' [${p.getErrorParams().join("|")}]`);
        const cmd = ok ? p.createCommand(origin) : null;
        say("Parser.createCommand(server origin)", cmd !== null, cmd === null ? "null" : `Command ${cmd} vftable ${(cmd as any as NativePointer).getPointer(0)}`);
        if (cmd !== null) {
            // CommandOutput(type) (docs/findings-scoreboard.md section 13): the engine's constructor writes the type and
            // zeros for every type, and builds the property bag for DataSet only; ~CommandOutput is bdsx's (inlined in 1.26)
            for (const type of [CommandOutputType.AllOutput, CommandOutputType.DataSet]) {
                const tname = type === CommandOutputType.DataSet ? "DataSet" : "AllOutput";
                const output = CommandOutput.constructWith(type);
                const raw = output as any as NativePointer;
                const bag = raw.getNullablePointer(8);
                const fresh = outputState(output);
                const bagText = bag === null ? "null" : `${bag}, vftable ${bag.getPointer(0)}, json type ${bag.getUint8(0x10)}, +0x18 ${bag.getInt32(0x18)}`;
                const tail = raw.getUint8(0x2c);
                say(
                    `CommandOutput.constructWith(${tname})`,
                    fresh.type === type && fresh.count === 0 && fresh.messages === 0 && tail === 0 &&
                        (type === CommandOutputType.DataSet ? bag !== null && bag.getPointer(0).isNotNull() && bag.getUint8(0x10) === 0 && bag.getInt32(0x18) === 0 : bag === null),
                    `${showOutput(fresh)}, +0x2c ${tail}, property bag ${bagText}`,
                );
                // set<int>: writes bag->json[key] = Value(int) for DataSet, nothing otherwise (2024 0xce8c60)
                output.set_int("seprobe_k", 42);
                const afterSet = raw.getNullablePointer(8);
                const json = afterSet === null ? null : output.propertyBag.json.value();
                say(
                    `CommandOutput.set_int('seprobe_k', 42) on ${tname}`,
                    type === CommandOutputType.DataSet ? JSON.stringify(json) === '{"seprobe_k":42}' : afterSet === null,
                    afterSet === null ? "property bag still null" : `property bag json ${JSON.stringify(json)}`,
                );
                lastRun = null;
                cmd.run(origin, output);
                const got = lastRun as { n: number; v: string; origin: string } | null;
                lastRun = null;
                const after = outputState(output);
                const json2 = type === CommandOutputType.DataSet ? output.propertyBag.json.value() : null;
                say(
                    `Command.run(origin, ${tname} output) of the created command`,
                    got !== null && got.n === 9 && got.v === "green" && after.count === 1 && after.messages === 1 && after.last !== null && after.last.type === 0 && after.last.id === "commands.seprobe.ok" &&
                        (type !== CommandOutputType.DataSet || JSON.stringify(json2) === '{"seprobe_k":42}'),
                    `${got === null ? "callback not run" : `callback n=${got.n} v=${got.v} origin=${got.origin}`}, output ${showOutput(after)}${json2 === null ? "" : `, json ${JSON.stringify(json2)}`}`,
                );
                output.destruct();
            }
            cmd.destruct();
        }
        p.destruct();

        // the bad side: a bad argument, then an unknown command
        for (const [line, bad] of [
            [`${CMD} abc red`, "abc"],
            ["seprobe_nosuch 1", "seprobe_nosuch"],
        ]) {
            const q = CommandRegistry.Parser.constructWith(r, version);
            const res = q.parseCommand(line);
            const msg = q.getErrorMessage();
            const params = q.getErrorParams();
            say(`Parser.parseCommand('${line}') fails with the engine's error`, res === false && msg.startsWith("commands.") && params.some(s => s.includes(bad)), `${res}, message '${msg}', params [${params.join("|")}]`);
            q.destruct();
        }

        // 200 rounds of construct / parse / (create + destroy) / destruct, alternating good and bad lines
        let made = 0;
        let failed = 0;
        for (let i = 0; i < 200; i++) {
            const q = CommandRegistry.Parser.constructWith(r, version);
            if (q.parseCommand(i % 2 === 0 ? `${CMD} ${i} red` : `${CMD} x${i} red`)) {
                const c = q.createCommand(origin);
                if (c !== null) {
                    made++;
                    c.destruct();
                }
            } else if (q.getErrorMessage() !== "") failed++;
            q.destruct();
        }
        say("200 Parser rounds", made === 100 && failed === 100, `${made} commands created and destroyed, ${failed} parse errors`);

        // 200 CommandOutput rounds, AllOutput and DataSet alternating: construct, set_int, success with a parameter, read
        // back, destruct (the message vector and, for DataSet, the property bag through its deleting destructor)
        let outGood = 0;
        const outBad: string[] = [];
        for (let i = 0; i < 200; i++) {
            const type = i % 2 === 0 ? CommandOutputType.AllOutput : CommandOutputType.DataSet;
            const o = CommandOutput.constructWith(type);
            o.set_int("seprobe_i", i);
            o.success("commands.seprobe.ok", [i]);
            const s = outputState(o);
            const hasBag = (o as any as NativePointer).getNullablePointer(8) !== null;
            const j = type === CommandOutputType.DataSet && hasBag ? o.propertyBag.json.value() : null;
            const ok =
                s.type === type && s.count === 1 && s.messages === 1 && s.last !== null && s.last.params[0] === String(i) &&
                (type === CommandOutputType.DataSet ? j !== null && j.seprobe_i === i : !hasBag);
            if (ok) outGood++;
            else if (outBad.length < 3) outBad.push(`#${i} ${showOutput(s)} bag ${hasBag} json ${JSON.stringify(j)}`);
            o.destruct();
        }
        say("200 CommandOutput rounds", outGood === 200, `${outGood}/200 construct/set_int/success/destruct as expected${outBad.length === 0 ? "" : `; ${outBad.join("; ")}`}`);
    } finally {
        origin.destruct();
    }
}

// ---- MinecraftCommands::handleOutput and getOutputType (docs/findings-scoreboard.md section 14) ----
//   seprobe outreg          registers `seprobeho` (Normal permission, no parameters): its callback records the output type
//                           the engine chose for it and adds one Success message
//   seprobe outtype <want>  getOutputType (derived()): a ServerCommandOrigin is AllOutput (3); the first player's
//                           PlayerCommandOrigin is <want> (3 with sendcommandfeedback true, 2 = Silent with it false); the
//                           engine's own choice for the same origin (executeCommand through a CommandContext: the type of
//                           the output its callback gets) is the same
//   seprobe handle          handleOutput (shipped) with an AllOutput output holding one Success message: from a server
//                           origin the text reaches events.serverLog; from the player's origin one CommandOutput packet
//                           goes to the player (the bot's log shows it as `command_output`)
const HO = "seprobeho";
let lastHo: { type: number; originType: number } | null = null;
/**
 * A PlayerCommandOrigin for a player. 1.26 has no constructor to call (inlined), but the class has ActorCommandOrigin's
 * 0x28-byte layout: getSourceId / getSourceSubId read the ActorUniqueID at +0x18 and the Level* at +0x20 (40
 * 0x12e72d0 / 0x12e7780, 51 0x12096d0 / 0x1209b80), and both classes share one deleting destructor (40 0xba750,
 * 51 0xbbbe0: a 0x28-byte free). So the probe builds bdsx's ActorCommandOrigin and swaps the table.
 */
function playerOrigin(p: Player): CommandOrigin {
    const o = ActorCommandOrigin.constructWith(p);
    o.vftable = proc["??_7PlayerCommandOrigin@@6B@"];
    return o;
}
function firstPlayer(): Player | null {
    const players = bedrockServer.level.getPlayers();
    return players.length === 0 ? null : players[0];
}
function registerHo(): void {
    try {
        command.register(HO, "handleOutput probe", CommandPermissionLevel.Normal).overload((p, origin, output) => {
            lastHo = { type: output.getType(), originType: origin.getOriginType() };
            output.success(`seprobe engine output for ${origin.getName()}`);
            console.log(`[seprobe] INFO ${HO} callback: origin type ${lastHo.originType} (${origin.getName()}), output type ${lastHo.type}`);
        }, {});
        say(`command.register('${HO}')`, true, "no error");
    } catch (err) {
        say(`command.register('${HO}')`, false, `threw: ${(err as Error).stack}`);
    }
}
function outputTypes(want: number): void {
    const server = ServerCommandOrigin.constructWith("Server", bedrockServer.level, CommandPermissionLevel.Admin, null);
    try {
        const t = MinecraftCommands.getOutputType(server);
        say("getOutputType(ServerCommandOrigin)", t === CommandOutputType.AllOutput, `${t} (want 3 AllOutput), origin type ${server.getOriginType()}`);
    } finally {
        server.destruct();
    }
    const player = firstPlayer();
    if (player === null) {
        say("getOutputType(PlayerCommandOrigin)", false, "(no player)");
        return;
    }
    const rule = bedrockServer.gameRules.getRule(GameRuleId.SendCommandFeedback) as any as NativePointer;
    const ruleText = `sendcommandfeedback variant index ${rule.getUint8(8)} value ${rule.getUint8(4)}`;
    const origin = playerOrigin(player);
    try {
        const t = MinecraftCommands.getOutputType(origin);
        say(`getOutputType(PlayerCommandOrigin of ${player.getName()})`, origin.getOriginType() === 0 && t === want, `${t} (want ${want}), origin type ${origin.getOriginType()}, ${ruleText}`);
        // the engine's own choice: executeCommand picks the type inline and constructs its output with it
        lastHo = null;
        const ctx = CommandContext.constructWith(HO, origin);
        const res: MCRESULT = (() => {
            try {
                return bedrockServer.minecraftCommands.executeCommand(ctx, false);
            } finally {
                ctx.destruct();
            }
        })();
        const got = lastHo as { type: number; originType: number } | null;
        lastHo = null;
        say(
            "executeCommand(player origin): the engine's output type == getOutputType",
            got !== null && got.originType === 0 && got.type === t,
            `${got === null ? "callback not run" : `callback origin type ${got.originType}, output type ${got.type}`}, derived ${t}, MCRESULT success ${res.isSuccess()} (0x${(res.getFullCode() >>> 0).toString(16)})`,
        );
    } finally {
        origin.destruct();
    }
}
/** lines events.serverLog saw while handleOutput ran */
let logSeen: string[] | null = null;
events.serverLog.on(line => {
    if (logSeen !== null) logSeen.push(line);
});
let packetsSeen: { toPlayer: boolean; ni: string }[] | null = null;
let hoTarget: NetworkIdentifier | null = null;
events.packetSend(MinecraftPacketIds.CommandOutput).on((pk, ni) => {
    if (packetsSeen !== null) packetsSeen.push({ toPlayer: hoTarget !== null && ni.equals(hoTarget), ni: String(ni) });
});
function handleOutputs(): void {
    const mc = bedrockServer.minecraftCommands;
    const nonce = Date.now().toString(36);
    // 1. a server origin: its source id is the local one, so the output goes to the CommandOutputSender (the console)
    const server = ServerCommandOrigin.constructWith("Server", bedrockServer.level, CommandPermissionLevel.Admin, null);
    const out1 = CommandOutput.constructWith(CommandOutputType.AllOutput);
    try {
        const text = `seprobe handleOutput server ${nonce}`;
        out1.success(text);
        // send's BedrockLog call is patched (hook-command-output, section 15): the text reaches events.commandOutput,
        // and bdsx prints it; events.serverLog sees it only when the patch is not installed
        const prevOut = outSeen;
        logSeen = [];
        outSeen = [];
        mc.handleOutput(server, out1);
        const seen = logSeen;
        const outs = outSeen;
        logSeen = null;
        outSeen = prevOut;
        const hit = seen.filter(l => l.includes(text)).concat(outs.filter(l => l.includes(text)));
        say("handleOutput(server origin, AllOutput + one Success message)", hit.length > 0, `events.serverLog saw ${seen.length} line(s), events.commandOutput ${outs.length}, ${hit.length} with the text: ${JSON.stringify(hit.length > 0 ? hit : seen.concat(outs).slice(0, 3))}`);
        say("the output after handleOutput", out1.getSuccessCount() === 1 && out1.messages.size() === 1, showOutput(outputState(out1)));
    } finally {
        out1.destruct();
        server.destruct();
    }
    // 2. the player's origin: a remote source id, so a CommandOutputPacket goes to that client
    const player = firstPlayer();
    if (player === null) {
        say("handleOutput(player origin)", false, "(no player)");
        return;
    }
    const origin = playerOrigin(player);
    const out2 = CommandOutput.constructWith(CommandOutputType.AllOutput);
    try {
        const text = `seprobe handleOutput player ${nonce}`;
        out2.success(text);
        hoTarget = player.getNetworkIdentifier();
        packetsSeen = [];
        mc.handleOutput(origin, out2);
        const seen = packetsSeen;
        packetsSeen = null;
        hoTarget = null;
        say(
            `handleOutput(PlayerCommandOrigin of ${player.getName()}, AllOutput + one Success message)`,
            seen.length === 1 && seen[0].toPlayer,
            `${seen.length} CommandOutput packet(s) sent: ${JSON.stringify(seen)}; the bot's log should show command_output with '${text}'`,
        );
    } finally {
        out2.destruct();
        origin.destruct();
    }
}

// ---- CommandOutputSender: send's console hook and sendToAdmins (docs/findings-scoreboard.md section 15) ----
//   seprobe sender          bedrockServer.commandOutputSender is the object at MinecraftCommands+0x18 and has the
//                           table's CommandOutputSender vftable, whose slot 1 is the table's send; the launcher's
//                           hook-command-output patch is in place at send + layouts["CommandOutputSender::send"].logCall
//   seprobe cmdout arm      start recording events.commandOutput; a line holding the cancel marker is CANCELed
//   list                    (console) the engine's own output for a console command
//   seprobe cmdout list     events.commandOutput saw list's lines
//   seprobe cmdout handle   handleOutput(server origin, two Success messages): one event per line, in order, and the
//                           BedrockLog call is gone (events.serverLog does not see them); a third output whose text
//                           holds the cancel marker is CANCELed by the listener, so bdsx does not print it (checked
//                           in the session log: the marker never appears there, the kept lines appear once each)
//   seprobe cmdout disarm
//   seprobe admins <want>   sendToAdmins: from a server origin nothing is sent (origin type 7); from the first
//                           player's own PlayerCommandOrigin nothing reaches that player (the source is skipped);
//                           from a player origin whose entity is not in the level, the player gets one Text packet
//                           exactly when its command permission level >= the requested level. <want> is `deop`
//                           (Normal: Operator gets nothing, Normal gets one) or `op` (MinecraftCommands+0x20, the
//                           operator level handleOutput passes, gets one)
//   seprobe text            translateText (engine/textobject.ts over TextObjectLocalizedTextWithParams' constructor and
//                           asString, docs/findings-scoreboard.md section 16) against the server's en_US.lang, and
//                           CommandOutputSender._toJson of a two-message output (statusMessage = the two texts)
//   seprobe sel / seprobesel <selector> / seprobe selgot <has> <name|-> <n>   CommandSelectorBase getName, hasName, setType,
//                           setIncludeDeadPlayers on a parsed selector (docs/findings-scoreboard.md section 19)
//   seprobe json            JsonValue inserting (engine/json.ts over the engine's operator[](unsigned) and
//                           _resolveReference, docs/findings-scoreboard.md section 17): new members, a nested object,
//                           an array grown to index 2, the proxy's set, read back with value(); 200 rounds after
const CANCEL_MARK = ["seprobe", "cancel"].join("-"); // never written whole in a probe line
let outSeen: string[] | null = null;
events.commandOutput.on(line => {
    if (outSeen === null) return;
    outSeen.push(line);
    if (line.includes(CANCEL_MARK)) return CANCEL;
});
const mask = (lines: string[]): string => JSON.stringify(lines.map(l => l.split(CANCEL_MARK).join("<cancel-marker>")));
function senderChecks(): void {
    const mc = bedrockServer.minecraftCommands as any as StaticPointer;
    const sender = bedrockServer.commandOutputSender;
    const at18 = mc.getPointer(0x18);
    say("bedrockServer.commandOutputSender == *(MinecraftCommands+0x18)", at18.equals(sender), `${sender} vs ${at18}`);
    const vft = proc["??_7CommandOutputSender@@6B@"];
    say("its vftable == ??_7CommandOutputSender@@6B@", sender.vftable.equals(vft), `${sender.vftable} vs ${vft}`);
    const send = proc["?send@CommandOutputSender@@UEAAXAEBVCommandOrigin@@AEBVCommandOutput@@@Z"];
    const slot1 = (vft as any as StaticPointer).getPointer(8);
    say("vftable slot 1 == ?send@CommandOutputSender@@...", slot1.equals(send), `${slot1} vs ${send}`);
    const off = pdbcache.layouts["CommandOutputSender::send"]?.logCall;
    if (typeof off !== "number") {
        say("hook-command-output patch", false, "no layouts[CommandOutputSender::send].logCall in this table");
        return;
    }
    const b = (send as any as StaticPointer).getBuffer(21, off);
    const bytes = Array.from(b, x => x.toString(16).padStart(2, "0")).join(" ");
    // hacktool.patch with call=true: mov rdx, imm64 (48 ba ..), call rdx (ff d2), the rest of the 21 bytes nop
    const ok = b[0] === 0x48 && b[1] === 0xba && b[10] === 0xff && b[11] === 0xd2 && b.slice(12).every(x => x === 0x90);
    say(`hook-command-output patch at send+${hex(off)}`, ok, bytes);
}
function cmdOut(args: string[]): void {
    const what = args[0] ?? "";
    if (what === "arm") {
        outSeen = [];
        say("cmdout arm", null, "recording events.commandOutput");
        return;
    }
    if (what === "disarm") {
        outSeen = null;
        say("cmdout disarm", null, "stopped");
        return;
    }
    if (outSeen === null) {
        say(`cmdout ${what}`, false, "not armed");
        return;
    }
    if (what === "list") {
        const seen = outSeen;
        outSeen = [];
        const hit = seen.filter(l => /players online/.test(l));
        say("events.commandOutput for the console's `list`", hit.length === 1, `${seen.length} line(s): ${mask(seen.slice(0, 6))}`);
        return;
    }
    if (what === "handle") {
        const mc = bedrockServer.minecraftCommands;
        const nonce = Date.now().toString(36);
        const keep1 = `seprobe cmdout keep1 ${nonce}`;
        const keep2 = `seprobe cmdout keep2 ${nonce}`;
        const server = ServerCommandOrigin.constructWith("Server", bedrockServer.level, CommandPermissionLevel.Admin, null);
        const out = CommandOutput.constructWith(CommandOutputType.AllOutput);
        const out2 = CommandOutput.constructWith(CommandOutputType.AllOutput);
        try {
            out.success(keep1);
            out.success(keep2);
            outSeen = [];
            logSeen = [];
            mc.handleOutput(server, out);
            const seen = outSeen;
            const logs = logSeen;
            say(
                "handleOutput(server origin, two Success messages) -> events.commandOutput",
                seen.length === 2 && seen[0] === keep1 && seen[1] === keep2,
                `${seen.length} event(s): ${JSON.stringify(seen.map(l => l.replace(nonce, "<nonce>")))} (nonce ${nonce}; the session log must show each text once, printed by bdsx)`,
            );
            say("the BedrockLog call is replaced: events.serverLog saw neither line", !logs.some(l => l.includes(nonce)), `${logs.length} serverLog line(s) during the call`);
            out2.success(`${CANCEL_MARK} ${nonce}`);
            outSeen = [];
            mc.handleOutput(server, out2);
            const seen2 = outSeen;
            say(
                "a CANCELed line: events.commandOutput fired",
                seen2.length === 1 && seen2[0].endsWith(nonce),
                `${seen2.length} event(s): ${mask(seen2)} (the session log must not hold the marker)`,
            );
        } finally {
            logSeen = null;
            outSeen = [];
            out.destruct();
            out2.destruct();
            server.destruct();
        }
        return;
    }
    say("cmdout", false, `unknown '${what}'`);
}
function jsonChecks(): void {
    const show = (v: unknown): string => JSON.stringify(v);
    const j = JsonValue.constructWith({ x: 1 });
    try {
        j.get("a").setValue(5);
        say("json member", show(j.value()) === show({ a: 5, x: 1 }) && j.size() === 2, `get("a").setValue(5) on {x:1}: ${show(j.value())}, size ${j.size()}`);
        const before = j.size();
        const again = j.get("a").value();
        say("json existing", again === 5 && j.size() === before, `get("a") again ${again}, size ${before} -> ${j.size()} (nothing inserted)`);
        j.get("o").get("b").setValue("s");
        say("json nested", show(j.get("o").value()) === show({ b: "s" }) && j.get("o").type === JsonValueType.Object, `get("o").get("b").setValue("s"): o = ${show(j.get("o").value())}, type ${j.get("o").type}`);
        const arr = j.get("arr");
        arr.get(2).setValue(true);
        say("json array", show(arr.value()) === show([null, null, true]) && arr.type === JsonValueType.Array && arr.size() === 3, `get("arr").get(2).setValue(true): ${show(arr.value())}, type ${arr.type}, size ${arr.size()}`);
        arr.get(0).setValue("first");
        say("json array in range", show(arr.value()) === show(["first", null, true]) && arr.size() === 3, `get(0).setValue("first"): ${show(arr.value())}, size ${arr.size()}`);
        const px = j.proxy();
        px.p = 7;
        const pa = arr.proxy();
        pa[4] = "z";
        say("json proxy set", j.isMember("p") && j.get("p").value() === 7 && arr.size() === 5 && arr.get(4).value() === "z", `proxy.p = 7 -> isMember ${j.isMember("p")} value ${j.get("p").value()}; array proxy [4] = "z" -> size ${arr.size()} [4] ${show(arr.get(4).value())}`);
        say("json proxy get", px.missing === undefined && !j.isMember("missing"), `reading proxy.missing gives ${show(px.missing)} and inserts nothing (isMember ${j.isMember("missing")})`);
        let threw = "";
        try {
            j.get("arr").get(-1);
        } catch (err) {
            threw = (err as Error).message;
        }
        say("json negative index", threw !== "", `get(-1) threw: ${threw || "(nothing)"}`);
        const whole = { a: 5, arr: ["first", null, true, null, "z"], o: { b: "s" }, p: 7, x: 1 };
        say("json whole", show(j.value()) === show(whole), show(j.value()));
    } finally {
        j.destruct();
    }
    let bad = 0;
    for (let i = 0; i < 200; i++) {
        const r = JsonValue.constructWith(null);
        try {
            r.get(`k${i}`).get("n").setValue(i);
            r.get("list").get(i % 7).setValue(`v${i}`);
            const v = r.value();
            if (v[`k${i}`].n !== i || v.list.length !== (i % 7) + 1 || v.list[i % 7] !== `v${i}`) bad++;
        } finally {
            r.destruct();
        }
    }
    say("json rounds", bad === 0, `200 rounds of null -> object with a nested member and an array element, read back and destroyed: ${bad} wrong`);
    // CommandOutput.set_Vec3 is bdsx's own `propertyBag.json.get(k).setValue({x, y, z})`: it threw on 1.26 before
    for (const type of [CommandOutputType.DataSet, CommandOutputType.AllOutput]) {
        const out = CommandOutput.constructWith(type);
        try {
            out.set_int("i", 1);
            out.set_Vec3("pos", Vec3.create(1, 2.5, -3));
            const hasBag = (out as any as NativePointer).getNullablePointer(8) !== null;
            const got = hasBag ? show(out.propertyBag.json.value()) : "no property bag";
            const want = type === CommandOutputType.DataSet ? show({ i: 1, pos: { x: 1, y: 2.5, z: -3 } }) : "no property bag";
            say(`json set_Vec3 ${type === CommandOutputType.DataSet ? "DataSet" : "AllOutput"}`, got === want, `set_int('i', 1), set_Vec3('pos', 1 2.5 -3): ${got}`);
        } finally {
            out.destruct();
        }
    }
    // the rest of CommandOutput::set<T> (docs/findings-scoreboard.md section 18): set<bool> and set<float> by address,
    // set_string through set<const char*>, set_BlockPos as {x, y, z}
    const LONG = "a string past the SSO limit of sixteen";
    for (const type of [CommandOutputType.DataSet, CommandOutputType.AllOutput]) {
        const tname = type === CommandOutputType.DataSet ? "DataSet" : "AllOutput";
        const out = CommandOutput.constructWith(type);
        try {
            out.set_bool("b", true);
            out.set_bool("f", false);
            out.set_float("x", 1.5);
            out.set_float("w", 2);
            out.set_string("s", "hi");
            out.set_string("l", LONG);
            out.set_BlockPos("p", BlockPos.create(1, -2, 300));
            out.set("g", "generic");
            const hasBag = (out as any as NativePointer).getNullablePointer(8) !== null;
            if (type === CommandOutputType.AllOutput) {
                say(`json set<T> ${tname}`, !hasBag, hasBag ? "a property bag appeared" : "no property bag, as set<int>");
                continue;
            }
            const json = out.propertyBag.json;
            const got = show(json.value());
            const want = show({ b: true, f: false, g: "generic", l: LONG, p: { x: 1, y: -2, z: 300 }, s: "hi", w: 2, x: 1.5 });
            const types = ["b", "w", "x", "s", "p"].map(k => `${k}:${json.get(k).type}`).join(" ");
            say(`json set<T> ${tname}`, got === want && types === "b:5 w:3 x:3 s:4 p:7", `${got}; types ${types} (want b:5 w:3 x:3 s:4 p:7)`);
        } finally {
            out.destruct();
        }
    }
    let setBad = 0;
    for (let i = 0; i < 200; i++) {
        const out = CommandOutput.constructWith(CommandOutputType.DataSet);
        try {
            out.set_string(`k${i}`, `v${i}`.repeat(i % 5 + 1));
            out.set_float("f", i / 4);
            out.set_bool("b", (i & 1) === 1);
            const v = out.propertyBag.json.value();
            if (v[`k${i}`] !== `v${i}`.repeat(i % 5 + 1) || v.f !== i / 4 || v.b !== ((i & 1) === 1)) setBad++;
        } finally {
            out.destruct();
        }
    }
    say("json set<T> rounds", setBad === 0, `200 rounds of set_string/set_float/set_bool on a DataSet output, read back and destroyed: ${setBad} wrong`);
}

function textChecks(): void {
    const t = (id: string, params: string[] | CxxVector<CxxString>): string => {
        try {
            return translateText(id, params);
        } catch (err) {
            return `<threw ${(err as Error).message}>`;
        }
    };
    // en_US.lang on both builds: commands.players.list=There are %1$d/%2$d players online:
    let got = t("commands.players.list", ["1", "10"]);
    say('translateText("commands.players.list", ["1","10"])', got === "There are 1/10 players online:", JSON.stringify(got));
    // a parameter past the SSO limit; commands.tag.add.success.single=Added tag '%1$s' to %2$s
    const long = "seprobe_tag_value_past_sso_limit";
    got = t("commands.tag.add.success.single", [long, "bdsxprobe"]);
    say("translateText(commands.tag.add.success.single, [a 32-char tag, bdsxprobe])", got === `Added tag '${long}' to bdsxprobe`, JSON.stringify(got));
    // a CxxVector<CxxString>, as CommandOutputMessage.params is; commands.kill.successful=Killed %1$s
    const vec = CxxVector.make(CxxString).construct();
    try {
        vec.push("Zombie");
        got = t("commands.kill.successful", vec);
        say("translateText(commands.kill.successful, CxxVector [Zombie])", got === "Killed Zombie" && vec.size() === 1 && vec.get(0) === "Zombie", `${JSON.stringify(got)}, vector after: [${vec.toArray().join(",")}]`);
    } finally {
        vec.destruct();
    }
    got = t("seprobe.no.such.key", []);
    say("translateText of an id the language does not have", null, JSON.stringify(got));
    // construct, asString, destroy 300 times
    let bad = 0;
    let firstBad = "";
    for (let i = 0; i < 300; i++) {
        const s = t("commands.players.list", [String(i), "10"]);
        if (s !== `There are ${i}/10 players online:`) {
            if (bad++ === 0) firstBad = `#${i}: ${JSON.stringify(s)}`;
        }
    }
    say("300 rounds of translateText(commands.players.list, [i, 10])", bad === 0, bad === 0 ? "all as expected" : `${bad} wrong, first ${firstBad}`);

    // CommandOutputSender._toJson: statusCode 0 when anything succeeded, statusMessage the translated messages joined
    // by \n, then the property bag's json (DataSet only)
    const sender = bedrockServer.commandOutputSender;
    const json = (o: CommandOutput): string => {
        const v = sender._toJson(o);
        try {
            return JSON.stringify(v.value());
        } finally {
            v.destruct();
        }
    };
    const two = CommandOutput.constructWith(CommandOutputType.AllOutput);
    const data = CommandOutput.constructWith(CommandOutputType.DataSet);
    const none = CommandOutput.constructWith(CommandOutputType.AllOutput);
    try {
        two.success("commands.players.list", ["1", "10"]);
        two.success("commands.kill.successful", ["Zombie"]);
        let j = json(two);
        say("_toJson(AllOutput, two Success messages)", j === JSON.stringify({ statusCode: 0, statusMessage: "There are 1/10 players online:\nKilled Zombie" }), j);
        const st = outputState(two);
        say("the output is unchanged after _toJson", st.count === 2 && st.messages === 2, showOutput(st));
        data.set_int("seprobe_k", 7);
        data.success("commands.time.set", ["6000"]);
        j = json(data);
        // Json::Value's object is a std::map, so the members come back in key order (seprobe_k first)
        say("_toJson(DataSet, set_int + one Success message)", j === JSON.stringify({ seprobe_k: 7, statusCode: 0, statusMessage: "Set the time to 6000" }), j);
        j = json(none);
        say("_toJson(an empty output)", j === JSON.stringify({ statusCode: -1, statusMessage: "" }), j);
    } finally {
        two.destruct();
        data.destruct();
        none.destruct();
    }
}
let textSeen: { toPlayer: boolean; type: number; message: string }[] | null = null;
let adminTarget: NetworkIdentifier | null = null;
events.packetSend(MinecraftPacketIds.Text).on((pk, ni) => {
    if (textSeen === null) return;
    let type = -1;
    let message = "?";
    try {
        type = pk.type;
        message = pk.message;
    } catch (err) {
        message = `(read threw ${(err as Error).message})`;
    }
    textSeen.push({ toPlayer: adminTarget !== null && ni.equals(adminTarget), type, message: message.slice(0, 200) });
});
function admins(want: string): void {
    const sender = bedrockServer.commandOutputSender;
    const player = firstPlayer();
    if (player === null) {
        say("sendToAdmins", false, "(no player)");
        return;
    }
    const nonce = Date.now().toString(36);
    let level = "?";
    try {
        level = String(player.getCommandPermissionLevel());
    } catch (err) {
        level = `(threw ${(err as Error).message})`;
    }
    const opLevel = (bedrockServer.minecraftCommands as any as StaticPointer).getUint8(0x20);
    say("sendToAdmins inputs", null, `${player.getName()} command permission level ${level}, MinecraftCommands+0x20 (operator level) ${opLevel}`);
    adminTarget = player.getNetworkIdentifier();
    const run = (label: string, origin: CommandOrigin, perm: number, expect: number): void => {
        const out = CommandOutput.constructWith(CommandOutputType.AllOutput);
        try {
            out.success(`seprobe admins ${label} ${nonce}`);
            textSeen = [];
            sender.sendToAdmins(origin, out, perm);
            const seen = textSeen;
            textSeen = null;
            const mine = seen.filter(s => s.toPlayer);
            say(
                `sendToAdmins(${label}, level ${perm})`,
                mine.length === expect && seen.length === expect && out.getSuccessCount() === 1,
                `${mine.length} Text packet(s) to ${player.getName()} (want ${expect}), ${seen.length} in all: ${JSON.stringify(seen)}`,
            );
        } finally {
            textSeen = null;
            out.destruct();
        }
    };
    const server = ServerCommandOrigin.constructWith("Server", bedrockServer.level, CommandPermissionLevel.Admin, null);
    try {
        run("server origin", server, CommandPermissionLevel.Normal, 0);
    } finally {
        server.destruct();
    }
    const own = playerOrigin(player);
    try {
        run("the player's own origin", own, CommandPermissionLevel.Normal, 0);
    } finally {
        own.destruct();
    }
    // a player origin whose ActorUniqueID (+0x18) names no entity: getEntity is null, so nobody is skipped
    const other = playerOrigin(player);
    (other as any as StaticPointer).setInt32(0x7ffe0001, 0x18);
    (other as any as StaticPointer).setInt32(0, 0x1c);
    try {
        if (want === "deop") {
            run("another player's origin", other, CommandPermissionLevel.Operator, 0);
            run("another player's origin", other, CommandPermissionLevel.Normal, 1);
        } else {
            run("another player's origin", other, opLevel, 1);
        }
    } finally {
        other.destruct();
        adminTarget = null;
    }
}

events.command.on(cmd => {
    const m = /^\/?seprobe(?=\s|$)\s*(.*)$/.exec(cmd);
    if (m === null) return;
    const [step = "", ...args] = m[1].trim().split(/\s+/);
    try {
        const r = bedrockServer.commandRegistry;
        if (step === "before" || step === "after" || step === "removed") {
            const list = all();
            if (step === "before") {
                say("registry", null, `${list.length} soft enums: ${list.map(([n, v]) => `${n}(${v.length})`).join(" ")}`);
                // every name the lookup map holds points at the vector entry of the same name
                let bad = 0;
                for (const [n] of list) {
                    const i = r.softEnumLookup.get(n);
                    if (i == null || r.softEnums.get(i)!.name !== n) bad++;
                }
                say("softEnumLookup -> softEnums", list.length > 0 && bad === 0, `${list.length - bad}/${list.length} names map to their own entry`);
            }
            const h = holders(OBJ);
            if (step === "after") say(`objective '${OBJ}' after 'scoreboard objectives add'`, h.length === 1, `held by [${h.join(",")}]`);
            else say(`objective '${OBJ}' ${step === "before" ? "before it exists" : "after 'scoreboard objectives remove'"}`, h.length === 0, `held by [${h.join(",")}]`);
            return;
        }
        if (step === "api") {
            say(`hasSoftEnum('${NAME}') before`, !r.hasSoftEnum(NAME), String(r.hasSoftEnum(NAME)));
            const e = command.softEnum(NAME, "alpha", "beta"); // addSoftEnum(name, []) + updateSoftEnum(Add, [alpha, beta])
            const idx = r.softEnumLookup.get(NAME);
            say(`command.softEnum('${NAME}', alpha, beta)`, r.hasSoftEnum(NAME) && idx != null && r.softEnums.get(idx)!.name === NAME, `lookup index ${idx}, vector size ${r.softEnums.size()}`);
            let v = r.getSoftEnumValues(NAME);
            say("values after create", same(v, ["alpha", "beta"]), show(v));
            e.addValues("gamma", "alpha"); // 1.26's addSoftEnumValues skips a value the list already has
            v = r.getSoftEnumValues(NAME);
            say("updateSoftEnum(Add, [gamma, alpha])", same(v, ["alpha", "beta", "gamma"]), show(v));
            e.removeValues("beta");
            v = r.getSoftEnumValues(NAME);
            say("updateSoftEnum(Remove, [beta])", same(v, ["alpha", "gamma"]), show(v));
            e.setValues("x", "y");
            v = r.getSoftEnumValues(NAME);
            say("updateSoftEnum(Replace, [x, y])", same(v, ["x", "y"]), show(v));
            say("CommandSoftEnum.getValues / getValueCount", same(e.getValues(), ["x", "y"]) && e.getValueCount() === 2, `${show(e.getValues())} ${e.getValueCount()}`);
            // CommandRegistry::addSoftEnum's two paths: a new name returns the enum's Symbol (index | 0x4100000),
            // a known one appends and returns the stored index
            const before = r.softEnums.size();
            const ret1 = r.addSoftEnum(RAW, ["r1"]);
            const i1 = r.softEnumLookup.get(RAW);
            say(
                `addSoftEnum('${RAW}', [r1]) new`,
                i1 === before && r.softEnums.size() === before + 1 && (ret1 & 0x4000000) !== 0 && (ret1 & 0xfffff) === i1 && same(r.getSoftEnumValues(RAW), ["r1"]),
                `returned 0x${(ret1 >>> 0).toString(16)}, lookup ${i1}, size ${before} -> ${r.softEnums.size()}, values ${show(r.getSoftEnumValues(RAW))}`,
            );
            const ret2 = r.addSoftEnum(RAW, ["r2"]);
            say(
                `addSoftEnum('${RAW}', [r2]) existing`,
                ret2 === i1 && r.softEnums.size() === before + 1 && same(r.getSoftEnumValues(RAW), ["r1", "r2"]),
                `returned 0x${(ret2 >>> 0).toString(16)}, size ${r.softEnums.size()}, values ${show(r.getSoftEnumValues(RAW))}`,
            );
            // an update for a name the registry does not have returns without touching anything
            const size = r.softEnums.size();
            r.updateSoftEnum(SoftEnumUpdateType.Add, "seprobe_absent", ["q"]);
            say("updateSoftEnum(Add) on an unknown name", !r.hasSoftEnum("seprobe_absent") && r.softEnums.size() === size, `size ${size} -> ${r.softEnums.size()}`);
            return;
        }
        if (step === "register") {
            register(r);
            return;
        }
        if (step === "ran") {
            ran(args);
            return;
        }
        if (step === "exec") {
            lastRun = null;
            const res = bedrockServer.executeCommand(`${CMD} 5 green`, CommandResultType.Data);
            const got = lastRun as { n: number; v: string } | null;
            lastRun = null;
            const o = lastOutput as { before: OutputState; after: OutputState } | null;
            lastOutput = null;
            say(
                `bedrockServer.executeCommand('${CMD} 5 green')`,
                got !== null && got.n === 5 && got.v === "green",
                `${got === null ? "not run" : `ran with n=${got.n} v=${got.v}`}`,
            );
            // the callback's output.success: the engine turns a success count above zero into a successful MCRESULT
            say(
                "output.success('commands.seprobe.ok', [5]) -> MCRESULT",
                res.isSuccess() && o !== null && o.after.count === o.before.count + 1,
                `MCRESULT success ${res.isSuccess()} (full code 0x${(res.getFullCode() >>> 0).toString(16)}), output ${o === null ? "not seen" : `${showOutput(o.before)} -> ${showOutput(o.after)}`}`,
            );
            return;
        }
        if (step === "types") {
            registerTypes();
            return;
        }
        if (step === "typesran") {
            typesRan(args);
            return;
        }
        if (step === "typesexec") {
            typesExec();
            return;
        }
        if (step === "enums") {
            dumpEnums();
            return;
        }
        if (step === "params") {
            registerParams();
            return;
        }
        if (step === "got") {
            checkParam(args);
            return;
        }
        if (step === "blocks") {
            blockLookups();
            return;
        }
        if (step === "origin") {
            registerOrigin();
            return;
        }
        if (step === "parser") {
            parserChecks(r);
            return;
        }
        if (step === "outreg") {
            registerHo();
            return;
        }
        if (step === "outtype") {
            outputTypes(Number(args[0]));
            return;
        }
        if (step === "handle") {
            handleOutputs();
            return;
        }
        if (step === "sender") {
            senderChecks();
            return;
        }
        if (step === "cmdout") {
            cmdOut(args);
            return;
        }
        if (step === "admins") {
            admins(args[0] ?? "deop");
            return;
        }
        if (step === "text") {
            textChecks();
            return;
        }
        if (step === "sel") {
            registerSel();
            return;
        }
        if (step === "selgot") {
            selGot(args);
            return;
        }
        if (step === "json") {
            jsonChecks();
            return;
        }
        if (step === "originran") {
            originRan(args[0] ?? "player");
            return;
        }
        say("usage", false, `unknown step '${step}'`);
    } catch (err) {
        say(`step '${step}'`, false, `threw: ${(err as Error).stack}`);
    }
});
