/**
 * Cross-build agreement as the second route for gap propagation.
 *
 * tools/propagate-gaps.mjs proposes a target function for a baseline
 * function from call-edge gaps, at 96-97% on held-out virtuals, but the
 * proposals are mostly non-virtuals and a single route is never promoted.
 * The second route is the other build: the same rule run on 1.26.51.1 is
 * anchored by the same baseline, but the two proposals are made in two
 * different binaries, and whether they name the same function is decided by
 * a third thing, the 1.26.40.8 -> 1.26.51.1 pair set built by string
 * anchoring and propagation between the two builds (work/derived40to51).
 * A name survives when the 1.26.40.8 proposal, carried through that pair
 * set, is the 1.26.51.1 proposal; then the body-shape veto
 * (tools/slot-shape.mjs) is applied on both sides.
 *
 * Two modes:
 *   measure:  node tools/gaps-agree.mjs measure <ho40.json> <ho51.json>
 *             the --holdout outputs of both builds hidden on the same
 *             baseline set (--holdoutOut / --holdoutIn): precision of the
 *             agreeing, disagreeing and unpaired subsets against the truth
 *   promote:  node tools/gaps-agree.mjs promote <real40.json> <real51.json> <out40.json> <out51.json>
 *             the real proposals: writes the agreeing names for both builds.
 *             A name proposed on one build only is checked the same way
 *             against what the other build already knows from any source
 *             but gap propagation (merged-<v>.json minus gaps-agree): the
 *             cross-build pair set is still the independent judge.
 */
import * as fs from "fs";
import { shape, compatible } from "./slot-shape.mjs";
const [mode, a, b, out40, out51] = process.argv.slice(2);
const load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const X = load("work/derived40to51/pairs.json").pairs;    // 1.26.40.8 rva -> 1.26.51.1 rva
const cross = new Map(Object.entries(X).map(([k, v]) => [Number(k), v]));
const EXE = { b: "work/bin/1.21.3.01/bedrock_server.exe", "1.26.40.8": "work/bin/1.26.40.8/bedrock_server.exe", "1.26.51.1": "work/bin/1.26.51.1/bedrock_server.exe" };
const shapeCache = new Map();
const sh = (exe, rva) => { const k = exe + ":" + rva; if (!shapeCache.has(k)) shapeCache.set(k, shape(exe, rva)); return shapeCache.get(k); };

if (mode === "measure") {
    const H40 = load(a), H51 = load(b);
    const p40 = new Map(Object.entries(H40.proposals).map(([k, v]) => [Number(k), v]));
    const p51 = new Map(Object.entries(H51.proposals).map(([k, v]) => [Number(k), v]));
    const t40 = new Map(Object.entries(H40.heldOut).map(([k, v]) => [Number(k), v]));
    const t51 = new Map(Object.entries(H51.heldOut).map(([k, v]) => [Number(k), v]));
    const cls = { agree: [0, 0], disagree: [0, 0], unpaired: [0, 0], only40: [0, 0] };
    for (const [bf, truth] of t40) {
        const q40 = p40.get(bf); if (q40 === undefined) continue;
        const q51 = p51.get(bf);
        const right = q40 === truth ? 0 : 1;
        let k;
        if (q51 === undefined) k = "only40";
        else if (!cross.has(q40)) k = "unpaired";
        else k = cross.get(q40) === q51 ? "agree" : "disagree";
        cls[k][right]++;
    }
    for (const [k, [r, w]] of Object.entries(cls)) console.log(`${k.padEnd(9)} right ${String(r).padStart(4)} wrong ${String(w).padStart(3)}  precision ${(100 * r / Math.max(1, r + w)).toFixed(1)}%`);
    // the 1.26.51.1 side of the agreeing set, scored against its own truth
    let r51 = 0, w51 = 0;
    for (const [bf, truth] of t51) { const q40 = p40.get(bf), q51 = p51.get(bf); if (q40 === undefined || q51 === undefined || cross.get(q40) !== q51) continue; if (q51 === truth) r51++; else w51++; }
    console.log(`agree, 1.26.51.1 side: right ${r51} wrong ${w51}`);
} else if (mode === "promote") {
    const R40 = load(a), R51 = load(b);
    const merged40 = load("data/merged-1.26.40.8.json").symbols, merged51 = load("data/merged-1.26.51.1.json").symbols;
    const required = new Set(load("data/required-symbols.json").symbols.map(s => s.name));
    const full = load("data/baseline-symbols.json").symbols;
    const s40 = {}, s51 = {}, ev = {}; let agree = 0, disagree = 0, unpaired = 0, only = 0, vetoed = 0, req = 0;
    const origin40 = load("data/merged-1.26.40.8.json").origin, origin51 = load("data/merged-1.26.51.1.json").origin;
    const known51 = n => (n in merged51 && origin51[n] !== "gaps-agree") ? merged51[n] : undefined;
    const known40 = n => (n in merged40 && origin40[n] !== "gaps-agree") ? merged40[n] : undefined;
    const inv = new Map([...cross].map(([a, b]) => [b, a]));
    const one = { agree: 0, disagree: 0, unpaired: 0, vetoed: 0, req: 0, reqNames: [] };
    const veto = (n, q, exe) => { const bf = full[n]; return bf !== undefined && !compatible(sh(EXE.b, bf), sh(exe, q)); };
    // proposed on 1.26.40.8 only, known on 1.26.51.1
    for (const [n, q40] of Object.entries(R40.symbols)) {
        if (R51.symbols[n] !== undefined) continue;
        const k51 = known51(n); if (k51 === undefined) continue;
        if (!cross.has(q40)) { one.unpaired++; continue; }
        if (cross.get(q40) !== k51) { one.disagree++; continue; }
        if (veto(n, q40, EXE["1.26.40.8"])) { one.vetoed++; continue; }
        one.agree++; s40[n] = q40; ev[n] = { "1.26.40.8": q40, "1.26.51.1 known": k51, by: origin51[n] }; if (required.has(n)) { one.req++; one.reqNames.push(n.slice(0, 60)); }
    }
    // proposed on 1.26.51.1 only, known on 1.26.40.8
    for (const [n, q51] of Object.entries(R51.symbols)) {
        if (R40.symbols[n] !== undefined) continue;
        const k40 = known40(n); if (k40 === undefined) continue;
        if (!inv.has(q51)) { one.unpaired++; continue; }
        if (inv.get(q51) !== k40) { one.disagree++; continue; }
        if (veto(n, q51, EXE["1.26.51.1"])) { one.vetoed++; continue; }
        one.agree++; s51[n] = q51; ev[n] = { "1.26.51.1": q51, "1.26.40.8 known": k40, by: origin40[n] }; if (required.has(n)) { one.req++; one.reqNames.push(n.slice(0, 60)); }
    }
    console.log(`proposed on one build, known on the other: agree ${one.agree} (vetoed ${one.vetoed}), disagree ${one.disagree}, unpaired ${one.unpaired}; required ${one.req}${one.reqNames.length ? ": " + one.reqNames.join(", ") : ""}`);
    for (const [n, q40] of Object.entries(R40.symbols)) {
        const q51 = R51.symbols[n];
        if (q51 === undefined) { only++; continue; }
        if (!cross.has(q40)) { unpaired++; continue; }
        if (cross.get(q40) !== q51) { disagree++; continue; }
        const bf = full[n];
        if (bf !== undefined) {
            const sb = sh(EXE.b, bf);
            if (!compatible(sb, sh(EXE["1.26.40.8"], q40)) || !compatible(sb, sh(EXE["1.26.51.1"], q51))) { vetoed++; continue; }
        }
        agree++;
        if (!(n in merged40)) s40[n] = q40;
        if (!(n in merged51)) s51[n] = q51;
        ev[n] = { "1.26.40.8": q40, "1.26.51.1": q51 };
        if (required.has(n) && (!(n in merged40) || !(n in merged51))) req++;
    }
    console.log(`proposed on both builds: agree ${agree} (after shape veto; vetoed ${vetoed}), disagree ${disagree}, unpaired across builds ${unpaired}; only on 1.26.40.8 ${only}`);
    console.log(`new on 1.26.40.8: ${Object.keys(s40).length}, on 1.26.51.1: ${Object.keys(s51).length}; required among them ${req}`);
    const comment = v => `Gap propagation (tools/propagate-gaps.mjs) proposals that the other build's proposal confirms through the 1.26.40.8 -> 1.26.51.1 pair set, body-shape veto passed on both (tools/gaps-agree.mjs). Two routes: the baseline-anchored gap rule on this build, and the same rule on the other build joined by an independent cross-build pairing. Not hook-trusted. ${v}`;
    fs.writeFileSync(out40, JSON.stringify({ _comment: comment("1.26.40.8"), symbols: s40, evidence: ev }, null, 1));
    fs.writeFileSync(out51, JSON.stringify({ _comment: comment("1.26.51.1"), symbols: s51, evidence: ev }, null, 1));
    console.log(`-> ${out40}, ${out51}`);
}
