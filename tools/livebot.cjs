// The headless Bedrock client as a test harness: a bot that plays like a real 1.26 client, driven step by step
// by a server-side probe (tools/livebot-probe.ts) over a local TCP control channel. docs/findings-bot.md "The harness".
//
//   NODE_PATH=<bot-360>/node_modules node tools/livebot.cjs <host> [port] [seconds]
//   env: BP_VERSION=1.26.40|1.26.51 (bedrock-protocol 3.60.1 knows both), LB_PORT=<control port> (the probe listens on
//        127.0.0.1:LB_PORT; the bot connects after it spawns and retries until the probe is up)
//
// What it does on its own, like a real client: answers the loading screen, sends one PlayerAuthInput per 50 ms
// tick with the tick counting on from start_game, keeps its position with a small physics model (gravity, jump,
// walking on a flat floor) and adopts every server correction, acknowledges teleports, tracks its inventory,
// the selected hotbar slot, open containers and the entities around it, and respawns when killed.
// What it does when told (the control ops at the bottom): look, walk, jump, sneak, sprint, attack and interact
// with an entity, use an item on a block or in the air, release it, break a block with server-authoritative
// block actions, select a hotbar slot, drop from the hotbar, close a container, chat, or send any raw packet.
//
// The wire format is bedrock-protocol 3.60.1's minecraft-data schemas, checked field by field against
// Cloudburst Protocol (Geyser's codec, Apache-2.0) in docs/findings-bot.md. 1.26.40 (v2168) writes an extra
// presence bool, always true, in front of several optional fields; 1.26.51 (v2193) does not. Both keys are
// filled here and each schema reads only its own.
// (.cjs: this repo's package.json makes .js files ES modules)
"use strict";
const bp = require("bedrock-protocol");
const net = require("net");

const [host, portStr, secsStr] = process.argv.slice(2);
const port = Number(portStr || 19132), secs = Number(secsStr || 150);
const VERSION = process.env.BP_VERSION || "1.26.40";
const CTRL_PORT = Number(process.env.LB_PORT || 0);
const t0 = Date.now();
const J = v => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));
const log = (...a) => console.log(`[lb ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const EYE = 1.62; // a standing player's eye height: positions on the wire are eye positions
const AIR = { network_id: 0 }; // bedrock-protocol writes the rest of an air descriptor as zeros (Cloudburst's air)

// `node tools/livebot.cjs --selftest`: no server; every packet the actions build is encoded and decoded again with
// both builds' schemas (bedrock-protocol's own serializer), so a field-name mistake shows up before a host session
const SELFTEST = host === "--selftest";
// login values the server keeps on the Player (as the retired probe-client.cjs did): BP_DEVICE_OS, BP_SKIN_ID, BP_PLAYFAB_ID,
// BP_DEVICE_ID, and BP_SKIN_JSON for any other skin key; the library spreads skinData over its own defaults
const loginExtra = {};
if (process.env.BP_DEVICE_OS) loginExtra.deviceOS = Number(process.env.BP_DEVICE_OS);
if (process.env.BP_SKIN_ID || process.env.BP_PLAYFAB_ID || process.env.BP_DEVICE_ID || process.env.BP_SKIN_JSON) {
    loginExtra.skinData = {};
    if (process.env.BP_DEVICE_ID) loginExtra.skinData.DeviceId = process.env.BP_DEVICE_ID;
    if (process.env.BP_SKIN_ID) loginExtra.skinData.SkinId = process.env.BP_SKIN_ID;
    if (process.env.BP_PLAYFAB_ID) loginExtra.skinData.PlayFabId = process.env.BP_PLAYFAB_ID;
    if (process.env.BP_SKIN_JSON) Object.assign(loginExtra.skinData, JSON.parse(process.env.BP_SKIN_JSON));
}
// BP_TRANSPORT=nethernet: connect over NetherNet (WebRTC) instead of RakNet. bedrock-protocol's NetherNet client signals
// over BDS's LAN channel: a discovery request to <host>:7551 returns the server's network id, then the SDP offer/answer
// travel the same UDP channel (server.properties needs transport=nethernet; docs/findings-nethernet.md)
const TRANSPORT = process.env.BP_TRANSPORT || "raknet";
if (TRANSPORT === "nethernet" && !SELFTEST) {
    // 1.26.40.8 answers discovery with a version-6 advertisement, which bedrock-protocol 3.60.1 has no schema for, so
    // its ping drops the reply and never learns the server's network id. Only the sender id is needed to connect:
    // an unreadable advertisement becomes an empty one (nn40, docs/findings-nethernet.md)
    const { NethernetServerAdvertisement } = require("bedrock-protocol/src/nethernet/advertisement");
    const fromBuffer = NethernetServerAdvertisement.fromBuffer;
    NethernetServerAdvertisement.fromBuffer = buffer => {
        try {
            return fromBuffer.call(NethernetServerAdvertisement, buffer);
        } catch (e) {
            log(`advertisement v${buffer[0]} unreadable (${e.message}): connecting by the sender id alone`);
            return new NethernetServerAdvertisement({ version: buffer[0], motd: "?", levelName: "?", protocol: undefined });
        }
    };
}
// BP_SIGNALLING=http: NetherNet's HTTP signalling instead of LAN (the partner guide's GET/POST {server}/v1/join[/{id}]),
// served by BDS on TCP server-port. bedrock-protocol's client has no HTTP mode, so the offer is taken from its NetherNet
// client through an external signal handler and the answer fed back as a CONNECTRESPONSE. No discovery: the server's
// network id is not needed (a placeholder satisfies the options check, the answer carries no sender id)
const SIGNALLING = process.env.BP_SIGNALLING || "lan";
const transportOpts =
    TRANSPORT !== "nethernet"
        ? { skipPing: true }
        : SIGNALLING === "http"
          ? { transport: "nethernet", skipPing: true, nethernet: { networkId: 1n } }
          : { transport: "nethernet", skipPing: false, pingTimeout: 15000, nethernet: { signalling: "lan" } };
const client = SELFTEST ? selftestClient() : bp.createClient({ host, port, username: process.env.BP_NAME || "bdsxprobe", offline: true, raknetBackend: process.env.BP_RAKNET || "raknet-native", version: VERSION, connectTimeout: 30000, ...transportOpts, ...loginExtra });
if (!SELFTEST) client.conLog = (...a) => log("[conn]", ...a);
log("transport", TRANSPORT, TRANSPORT === "nethernet" ? `signalling ${SIGNALLING}` : "");
if (!SELFTEST && TRANSPORT === "nethernet" && SIGNALLING === "http") {
    const base = `http://${host}:${port}`;
    // an ES384 JWT naming the bot's own login key, signed by it (the shape of a multiplayer token, not its issuer)
    const selfSignedToken = () => {
        const crypto = require("crypto");
        const spki = crypto.createPublicKey(client.ecdhKeyPair.privateKey).export({ format: "der", type: "spki" }).toString("base64");
        const now = Math.floor(Date.now() / 1000);
        const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");
        const input = `${b64u({ alg: "ES384", typ: "JWT", x5u: spki })}.${b64u({ cpk: spki, xid: "", mid: "", tid: "", iss: "self", aud: "api://auth-minecraft-services/multiplayer", iat: now, nbf: now - 60, exp: now + 3600 })}`;
        const sig = crypto.sign("SHA384", Buffer.from(input), { key: client.ecdhKeyPair.privateKey, dsaEncoding: "ieee-p1363" });
        return `${input}.${sig.toString("base64url")}`;
    };
    const attach = () => {
        const nn = client.connection.nethernet;
        nn.signalHandler = signal => {
            if (signal.type !== "CONNECTREQUEST") return; // no trickle ICE over HTTP: the offer carries the candidates
            (async () => {
                const meta = await fetch(`${base}/v1/join`);
                log("http GET /v1/join", meta.status, meta.headers.get("content-type"), JSON.stringify((await meta.text()).slice(0, 300)));
                // Without an a=identity assertion the server answers "37" (ErrorCodeIdentityNotAllowed). A real client signs
                // the offer's DTLS fingerprints with the key named by its Minecraft-services multiplayer token's cpk claim;
                // an offline bot has no such token, so BP_NN_IDENTITY=self signs one itself with its login key
                let offer = signal.data;
                if ((process.env.BP_NN_IDENTITY || "self") === "self") {
                    offer = require("nethernet/src/identity").attachIdentity(offer, { privateKey: client.ecdhKeyPair.privateKey, token: selfSignedToken() });
                }
                log("http offer", `${offer.length} bytes`, JSON.stringify(offer.slice(0, 120)));
                const r = await fetch(`${base}/v1/join/${nn.networkId}`, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer });
                const answer = await r.text();
                log("http answer", r.status, r.headers.get("content-type"), `${answer.length} bytes`, JSON.stringify(answer.slice(0, 200)));
                if (!r.ok) return;
                nn.handleSignal({ type: "CONNECTRESPONSE", connectionId: signal.connectionId, data: answer, networkId: undefined });
            })().catch(e => log("http signalling error", e && e.message ? e.message : e));
        };
        // connect() may already have run and be waiting for a LAN discovery reply that never comes
        if (nn._pendingConnect) {
            nn._pendingConnect = false;
            nn.startOffer();
        }
    };
    if (client.connection) attach();
    else client.once("connect_allowed", attach);
}
if (process.env.BP_PROTOCOL) client.options.protocolVersion = Number(process.env.BP_PROTOCOL);

// ---------------------------------------------------------------------------------------------------------------
// State
const S = {
    rid: null, // our runtime id (bigint)
    uid: null, // our unique id
    pos: { x: 0, y: 0, z: 0 }, // eye position
    vel: { x: 0, y: 0, z: 0 }, // blocks per tick
    onGround: false,
    groundY: null, // feet y of the floor the physics stands on; null = unknown, so no vertical physics
    yaw: 0, // degrees, 0 = +z, 90 = -x
    pitch: 0, // degrees, > 0 looks down
    tick: 0n,
    spawned: false,
    dead: false,
    gamemode: null,
    speed: 0.1, // the minecraft:movement attribute
    selected: 0,
    windows: new Map(), // window id (number) -> Map(slot -> item); 0 = inventory, 119 offhand, 120 armor, 124 ui
    open: null, // {id, type, pos, rid} of the container the server opened
    blocks: new Map(), // "x,y,z" -> network block id (layer 0) from the server's block updates; a real client knows these from its chunks
    ents: new Map(), // runtime id string -> {type, pos (feet), uid}
    health: null,
    corrections: 0,
    authSent: 0,
    zeroInteract: false, // send interact_rotation as (0, 0) like the old bot did (an A/B switch for the attack check)
};
const W = { inventory: 0, offhand: 119, armor: 120, ui: 124 };
const winId = w => (typeof w === "number" ? w : W[w] ?? Number(w));
const slotItem = (win, slot) => S.windows.get(win)?.get(slot) ?? AIR;
const heldItem = () => slotItem(0, S.selected);
const feetY = () => S.pos.y - EYE;
const big = v => { try { return typeof v === "bigint" ? v : BigInt(v); } catch (e) { return 0n; } };

// movement intent and the input flags of the coming ticks
const intent = { forward: 0, strafe: 0, sprint: false, sneak: false, jumpTicks: 0, jumpQueued: false };
const once = []; // flags for the next auth input only
const heldFlags = new Set(); // extra flags sent on every auth input until cleared (the `flags` op's `hold`)
const nextTick = []; // functions run right after the next auth input is queued (actions that need the rotation sent first)
let pendingBlockActions = []; // block actions for the next auth input
let pendingAuthTx = null; // an item-use transaction carried by the next auth input (item_interact)

// ---------------------------------------------------------------------------------------------------------------
// What the server tells us
client.on("start_game", p => {
    S.rid = big(p.runtime_entity_id);
    S.uid = p.entity_id;
    S.pos = { ...p.player_position };
    S.tick = big(p.current_tick);
    S.gamemode = p.player_gamemode;
    if (p.rotation) { S.pitch = p.rotation.x ?? 0; S.yaw = p.rotation.z ?? 0; }
    log("start_game rid", String(S.rid), "pos", J(S.pos), "tick", String(S.tick), "gamemode", S.gamemode, "rewind", p.rewind_history_size, "sa-block-breaking", p.server_authoritative_block_breaking);
});
client.on("move_player", p => {
    if (big(p.runtime_id) !== S.rid) return;
    S.pos = { ...p.position };
    S.vel = { x: 0, y: 0, z: 0 };
    S.yaw = p.yaw; S.pitch = p.pitch;
    S.onGround = !!p.on_ground;
    if (S.onGround) S.groundY = feetY();
    if (p.mode === "teleport" || p.mode === "reset") once.push("handled_teleport");
    log("move_player", p.mode, J(S.pos), "on_ground", S.onGround);
    emit({ ev: "teleport", mode: p.mode, pos: S.pos, onGround: S.onGround });
});
client.on("correct_player_move_prediction", p => {
    if (p.prediction_type !== undefined && p.prediction_type !== "player" && p.prediction_type !== 0) return;
    S.corrections++;
    S.pos = { ...p.position };
    if (p.delta) S.vel = { ...p.delta };
    S.onGround = !!p.on_ground;
    if (S.onGround) { S.groundY = feetY(); S.vel.y = 0; }
    if (S.corrections <= 30) log("correction", J({ pos: p.position, delta: p.delta, on_ground: p.on_ground, tick: p.tick, ours: S.tick }));
    emit({ ev: "correction", pos: S.pos, onGround: S.onGround, tick: String(p.tick) });
});
client.on("set_entity_motion", p => {
    if (big(p.runtime_entity_id) !== S.rid) return;
    S.vel = { ...p.velocity };
    S.onGround = false;
    log("motion", J(p.velocity));
});
client.on("update_attributes", p => {
    const self = big(p.runtime_entity_id) === S.rid;
    for (const a of p.attributes || []) {
        const v = a.current ?? a.value; // PlayerAttributes carries `current` (an undefined `value` once made every speed NaN)
        if (!Number.isFinite(v)) continue;
        if (self && a.name === "minecraft:movement") S.speed = v;
        if (self && a.name === "minecraft:health") S.health = v;
        if (!self && a.name === "minecraft:health") { emit({ ev: "entity_health", rid: String(p.runtime_entity_id), health: v }); log("entity", String(p.runtime_entity_id), "health", v); }
    }
});
client.on("set_health", p => { S.health = p.health; log("health", p.health); });
client.on("inventory_content", p => {
    const id = winId(p.window_id);
    const m = new Map();
    (p.input || []).forEach((it, i) => m.set(i, it));
    S.windows.set(id, m);
    if (id !== 0) log("inventory_content window", id, "slots", m.size, "non-empty", [...m.values()].filter(i => i.network_id).length);
});
client.on("inventory_slot", p => {
    const id = winId(p.window_id);
    if (!S.windows.has(id)) S.windows.set(id, new Map());
    S.windows.get(id).set(p.slot, p.item);
});
client.on("player_hotbar", p => { if (p.select_slot) S.selected = p.selected_slot; log("player_hotbar", p.selected_slot); });
client.on("mob_equipment", p => { if (big(p.runtime_entity_id) === S.rid && (p.window_id === "inventory" || p.window_id === 0)) S.selected = p.selected_slot; });
client.on("container_open", p => {
    S.open = { id: winId(p.window_id), type: p.window_type, pos: p.coordinates, rid: String(p.runtime_entity_id) };
    log("container_open", J(S.open));
    emit({ ev: "container_open", ...S.open });
});
client.on("container_close", p => {
    log("container_close", J({ window_id: p.window_id, server: p.server }));
    if (S.open && S.open.id === winId(p.window_id)) S.open = null;
    emit({ ev: "container_close", id: winId(p.window_id) });
});
const track = (p, type) => {
    S.ents.set(String(p.runtime_id), { type: p.entity_type || type, pos: { ...p.position }, uid: String(p.unique_id ?? p.entity_id_self ?? "") });
};
client.on("add_entity", p => track(p));
client.on("add_player", p => track(p, "minecraft:player"));
client.on("add_item_entity", p => { track({ ...p, runtime_id: p.runtime_entity_id }, "minecraft:item"); emit({ ev: "item_entity", rid: String(p.runtime_entity_id), item: p.item?.network_id, count: p.item?.count }); });
client.on("remove_entity", p => { const u = String(p.entity_id_self); for (const [k, e] of S.ents) if (e.uid === u) S.ents.delete(k); });
client.on("move_entity", p => { const e = S.ents.get(String(p.runtime_entity_id)); if (e) e.pos = { ...p.position }; });
client.on("move_entity_delta", p => { const e = S.ents.get(String(p.runtime_entity_id)); if (!e) return; if (p.x !== undefined) e.pos.x = p.x; if (p.y !== undefined) e.pos.y = p.y; if (p.z !== undefined) e.pos.z = p.z; });
client.on("respawn", p => {
    // 0 = searching, 1 = server ready: the client answers 2 (client ready) and, after a death, the respawn action
    try { client.queue("respawn", { position: p.position, state: 2, runtime_entity_id: S.rid }); } catch (e) { log("respawn reply failed", e.message); }
    if (p.state === 1 && S.dead) {
        S.dead = false;
        try { client.queue("player_action", { runtime_entity_id: S.rid, action: "respawn", position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: -1 }); log("sent respawn action"); } catch (e) { log("respawn action failed", e.message); }
        emit({ ev: "respawn" });
    }
});
client.on("death_info", p => { S.dead = true; log("death_info", J(p).slice(0, 120)); emit({ ev: "death" }); });
client.on("text", p => { log("text", J({ type: p.type, source_name: p.source_name, message: (p.message || "").slice(0, 200) })); emit({ ev: "text", type: p.type, source: p.source_name, message: p.message }); });
client.on("command_output", p => { log("command_output", J(p).slice(0, 300)); emit({ ev: "command_output", output: p.output, success: p.success_count }); });
// forms: kept for the form op, or answered at once with BP_FORM_REPLY=<json> (bdsx's Form API resolves on ModalFormResponse)
client.on("modal_form_request", p => {
    S.form = { id: p.form_id, data: p.data };
    log("form request", String(p.form_id), (p.data || "").slice(0, 120));
    emit({ ev: "form", id: p.form_id, data: p.data });
    if (process.env.BP_FORM_REPLY !== undefined) formReply(p.form_id, process.env.BP_FORM_REPLY);
});
function formReply(id, data) {
    if (data === null) client.queue("modal_form_response", { form_id: id, has_response_data: false, has_cancel_reason: true, cancel_reason: "closed" });
    else client.queue("modal_form_response", { form_id: id, has_response_data: true, data, has_cancel_reason: false });
    log("form response", String(id), data === null ? "(closed)" : data);
}
client.on("item_stack_response", p => {
    log("item_stack_response", J(p).slice(0, 300));
    for (const r of p.responses || []) emit({ ev: "stack_response", id: r.request_id, status: r.status, containers: r.containers });
});
const bkey = p => `${p.x},${p.y},${p.z}`;
const blockSeen = (pos, brid, layer) => { if (!layer) S.blocks.set(bkey(pos), brid); emit({ ev: "update_block", pos, brid, layer }); };
client.on("update_block", p => blockSeen(p.position, p.block_runtime_id, p.layer));
client.on("update_block_synced", p => blockSeen(p.position, p.block_runtime_id, p.layer));
client.on("update_subchunk_blocks", p => { for (const b of p.blocks || []) blockSeen(b.position, b.runtime_id, 0); for (const b of p.extra || []) blockSeen(b.position, b.runtime_id, 1); });
client.on("level_event", p => { if (/block|destroy|particles_destroy|crack/i.test(String(p.event))) emit({ ev: "level_event", event: p.event, pos: p.position, data: p.data }); });
client.on("disconnect", p => { log("disconnected", J(p).slice(0, 200)); setTimeout(() => process.exit(0), 500); });
client.on("error", e => log("error", e && e.message ? e.message : e));
client.on("close", () => { log("closed"); setTimeout(() => process.exit(0), 500); });
client.on("join", () => log("joined"));

// ---------------------------------------------------------------------------------------------------------------
// Physics: a standing/walking/jumping player on a flat floor (the arena the probe builds). Java-style order:
// accelerate, move with the floor as the only collision, then gravity/drag and friction. The server simulates the
// same inputs (server-authoritative movement with rewind) and corrects us when we drift past its threshold;
// every correction is adopted above, so this only has to be close.
const GRAVITY = 0.08, DRAG = 0.98, JUMP_V = 0.42;
function physicsStep() {
    const ground = S.onGround;
    const slip = 0.6;
    const f = ground ? slip * 0.91 : 0.91;
    let speed = S.speed * (intent.sprint ? 1.3 : 1);
    const accel = ground ? speed * (0.16277136 / (f * f * f)) : (intent.sprint ? 0.026 : 0.02);
    let fw = intent.forward, st = intent.strafe;
    if (intent.sneak) { fw *= 0.3; st *= 0.3; }
    const len = Math.hypot(fw, st);
    if (len > 1e-4) {
        const k = accel / Math.max(1, len);
        const y = S.yaw * Math.PI / 180, sin = Math.sin(y), cos = Math.cos(y);
        // forward is the look direction on the ground plane (yaw 0 = +z), strafe left is +x at yaw 0
        S.vel.x += (st * cos - fw * sin) * k;
        S.vel.z += (fw * cos + st * sin) * k;
    }
    if (intent.jumpQueued && ground) {
        S.vel.y = JUMP_V;
        S.onGround = false;
        once.push("start_jumping");
        intent.jumpQueued = false;
        if (intent.sprint) { const y = S.yaw * Math.PI / 180; S.vel.x += -Math.sin(y) * 0.2; S.vel.z += Math.cos(y) * 0.2; }
    }
    const before = { ...S.pos };
    S.pos.x += S.vel.x; S.pos.z += S.vel.z;
    if (S.groundY !== null) {
        const ny = feetY() + S.vel.y;
        if (ny <= S.groundY && S.vel.y <= 0) { S.pos.y = S.groundY + EYE; S.vel.y = 0; S.onGround = true; }
        else { S.pos.y += S.vel.y; S.onGround = false; }
        S.vel.y = (S.vel.y - GRAVITY) * DRAG;
        if (S.onGround) S.vel.y = 0;
    }
    S.vel.x *= f; S.vel.z *= f;
    if (Math.abs(S.vel.x) < 0.003) S.vel.x = 0;
    if (Math.abs(S.vel.z) < 0.003) S.vel.z = 0;
    if (![S.pos.x, S.pos.y, S.pos.z, S.vel.x, S.vel.y, S.vel.z].every(Number.isFinite)) {
        log("physics produced a non-number, back to", J(before));
        S.pos = before; S.vel = { x: 0, y: 0, z: 0 };
    }
    return { x: S.pos.x - before.x, y: S.pos.y - before.y, z: S.pos.z - before.z };
}
const lookVector = () => {
    const y = S.yaw * Math.PI / 180, p = S.pitch * Math.PI / 180;
    return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) };
};
function lookAt(t) {
    const dx = t.x - S.pos.x, dy = t.y - S.pos.y, dz = t.z - S.pos.z;
    S.yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
    S.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    return Math.hypot(dx, dy, dz);
}

// ---------------------------------------------------------------------------------------------------------------
// The tick: one PlayerAuthInput per 50 ms, like a real client
function authInput() {
    const delta = physicsStep();
    const flags = new Set([...once.splice(0), ...heldFlags]);
    if (intent.jumpTicks > 0) { for (const f of ["jump_down", "jumping", "jump_current_raw"]) flags.add(f); if (--intent.jumpTicks === 0) once.push("jump_released_raw"); }
    if (intent.sneak) for (const f of ["sneaking", "sneak_down", "sneak_current_raw"]) flags.add(f);
    if (intent.sprint && (intent.forward > 0)) { flags.add("sprinting"); flags.add("sprint_down"); }
    if (intent.forward > 0) flags.add("up");
    if (intent.forward < 0) flags.add("down");
    if (intent.strafe > 0) flags.add("left");
    if (intent.strafe < 0) flags.add("right");
    if (S.onGround) flags.add("vertical_collision");
    const blockActions = pendingBlockActions.splice(0);
    if (blockActions.length) flags.add("block_action");
    const tx = pendingAuthTx; pendingAuthTx = null;
    if (tx) flags.add("item_interact");
    const mv = { x: intent.strafe, z: intent.forward };
    const pkt = {
        pitch: S.pitch, yaw: S.yaw, position: { ...S.pos }, move_vector: mv, head_yaw: S.yaw,
        input_data: [...flags], input_mode: "mouse", play_mode: "normal", interaction_model: "crosshair",
        interact_rotation: S.zeroInteract ? { x: 0, z: 0 } : { x: S.pitch, z: S.yaw }, tick: S.tick, delta,
        transaction_presence: true, transaction: tx ?? undefined,
        item_stack_request_presence: true, item_stack_request: undefined,
        block_action_presence: true, block_action: blockActions.length ? blockActions : undefined,
        vehicle_rotation_presence: true, vehicle_rotation: undefined,
        predicted_vehicle_presence: true, predicted_vehicle: undefined,
        analogue_move_vector: mv, camera_orientation: lookVector(), raw_move_vector: mv,
    };
    client.queue("player_auth_input", pkt);
    if (S.authSent++ === 0) log("auth input stream started at tick", String(S.tick));
    const shown = [...flags].filter(f => !["vertical_collision", "up", "down", "left", "right", "sneaking", "sneak_down", "sneak_current_raw", "jump_down", "jumping", "jump_current_raw", "sprinting", "sprint_down"].includes(f));
    if (shown.length || blockActions.length) log("tick", String(S.tick), shown.join("+"), blockActions.length ? J(blockActions) : "");
    S.tick++;
    for (const fn of nextTick.splice(0)) { try { fn(); } catch (e) { log("next-tick action failed", e.message); } }
}
function goLive() {
    for (const type of [1, 2]) {
        try { client.queue("serverbound_loading_screen", { type, loading_screen_id: undefined }); } catch (e) { log("loading screen", type, "failed", e.message); }
    }
    // 20 ticks a second without drift: Windows timers fire on a ~15.6 ms grid, so a plain 50 ms interval runs at
    // ~16 Hz and the client tick falls behind the server's; this sends however many ticks are due each wake-up
    let next = Date.now(), stopped = false, timer = null;
    const loop = () => {
        if (stopped) return;
        let n = 0;
        while (Date.now() >= next && n < 4) { try { authInput(); } catch (e) { log("auth input failed", e.stack); } next += 50; n++; }
        if (Date.now() >= next) next = Date.now() + 50; // more than 4 behind: resynchronise rather than burst
        timer = setTimeout(loop, Math.max(1, next - Date.now()));
    };
    loop();
    client.on("close", () => { stopped = true; clearTimeout(timer); });
}
// ---------------------------------------------------------------------------------------------------------------
// the retired probe-client.cjs's environment, so a driver can move to this client by changing -Bot (docs/findings-bot.md
// section 7). Differences: the client is live unless BP_LIVE=0 (the old one only with BP_LIVE=1), and the old default
// auto-attack is opt-in, BP_AUTO_ATTACK=1 (the old BP_NO_ATTACK=1 is then simply the default).
//   BP_LIVE=0                      stay on the loading screen: no loading-screen end, no auth input (the old idle peer)
//   BP_SNEAK=<ms>[,<ms>...]        sneak that long after spawning, for 2 s
//   BP_CHAT=<ms>:<text>;...        chat lines that long after spawning
//   BP_COMMAND=/x [BP_COMMAND_AFTER=<ms>]   a command as the player, 4 s (or that long) after spawning
//   BP_AUTO_ATTACK=1               attack every zombie/husk/pig/cow/sheep/chicken that appears, every 1.5 s for 15 s
//   BP_LEAVE_AFTER_START=<ms>      leave that long after start_game (the join loops)
//   BP_SPOOF=1                     take the protocol number from a raw RakNet ping (LAN-visible servers only)
const LIVE = process.env.BP_LIVE !== "0";
function afterSpawn() {
    // the old BP_AUTH_INPUT=1 meant live plus one sneak at 20 s
    for (const ms of (process.env.BP_SNEAK || (process.env.BP_AUTH_INPUT === "1" ? "20000" : "")).split(",").filter(Boolean).map(Number)) {
        setTimeout(() => { once.push("start_sneaking", "sneak_pressed_raw"); intent.sneak = true; log("sneak start"); }, ms);
        setTimeout(() => { once.push("stop_sneaking", "sneak_released_raw"); intent.sneak = false; log("sneak stop"); }, ms + 2000);
    }
    for (const item of (process.env.BP_CHAT || "").split(";").filter(Boolean)) {
        const i = item.indexOf(":"), ms = Number(item.slice(0, i)), text = item.slice(i + 1);
        setTimeout(() => { ops.chat({ text }).catch(e => log("chat failed", e.message)); log("sent chat", text); }, ms);
    }
    if (process.env.BP_COMMAND) setTimeout(() => { ops.command({ text: process.env.BP_COMMAND }).catch(e => log("command failed", e.message)); }, Number(process.env.BP_COMMAND_AFTER || 4000));
}
if (process.env.BP_AUTO_ATTACK === "1") {
    client.on("add_entity", p => {
        if (!/zombie|husk|pig|cow|sheep|chicken/.test(p.entity_type || "")) return;
        const rid = String(p.runtime_id);
        log("entity", p.entity_type, "runtime", rid, "at", J(p.position));
        for (let t = 1500; t <= 15000; t += 1500) setTimeout(() => {
            const e = S.ents.get(rid);
            if (!e || !S.spawned) return;
            ops.attack({ rid, aim: { x: e.pos.x, y: e.pos.y + 0.9, z: e.pos.z } }).catch(err => log("auto-attack failed", err.message));
        }, t);
    });
}
if (process.env.BP_LEAVE_AFTER_START) client.on("start_game", () => setTimeout(() => { log("leaving", process.env.BP_LEAVE_AFTER_START, "ms after start_game"); try { client.close(); } catch (e) {} setTimeout(() => process.exit(0), 1000); }, Number(process.env.BP_LEAVE_AFTER_START)));
if (process.env.BP_SPOOF === "1" && !SELFTEST && !process.env.BP_PROTOCOL) {
    const dgram = require("dgram");
    const sock = dgram.createSocket("udp4"); let done = false;
    const finish = () => { if (!done) { done = true; try { sock.close(); } catch (e) {} } };
    sock.on("message", m => { const f = m.subarray(35).toString("latin1").split(";"); if (f[0] === "MCPE") { log(`server says protocol ${f[2]} version ${f[3]}`); client.options.protocolVersion = Number(f[2]); } finish(); });
    const b = Buffer.alloc(33); b[0] = 1; Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex").copy(b, 9); b.writeUInt32BE(0x1234, 29);
    sock.send(b, port, host); setTimeout(finish, 3000);
}
// the old client's packet logs, which some probes' checks are read from (the transcripts and .bot.log)
const JB = v => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));
client.on("update_abilities", p => log("update_abilities", String(p.entity_unique_id), p.permission_level, p.command_permission, (p.abilities || []).map(a => `${a.type} set=0x${(a.allowed._value >>> 0).toString(16)} val=0x${(a.enabled._value >>> 0).toString(16)} fly=${a.fly_speed.toFixed(3)} vfly=${(a.vertical_fly_speed ?? 0).toFixed(3)} walk=${a.walk_speed.toFixed(3)}`).join(" | ")));
client.on("game_rules_changed", p => {
    const rules = p.rules || [];
    const pick = n => { const r = rules.find(x => String(x.name).toLowerCase() === n); return r ? JB(r) : "-"; };
    log("game_rules_changed", `n=${rules.length}`, "keepinventory", pick("keepinventory"), "pvp", pick("pvp"));
});
client.on("player_list", p => {
    const skip = new Set(["skin_data", "skin", "skinData"]);
    log("player_list", JSON.stringify(p, (k, v) => (skip.has(k) ? "<skin>" : typeof v === "bigint" ? v.toString() : typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "..." : v)).slice(0, 700));
});
client.on("mob_equipment", p => log("mob_equipment", JB(p).slice(0, 400)));
client.on("mob_armor_equipment", p => log("mob_armor_equipment", JB(p).slice(0, 400)));
client.on("inventory_slot", p => { if (p.window_id === "armor" || p.window_id === 120) log("inventory_slot", JB(p).slice(0, 300)); });
let chunkCount = 0;
client.on("level_chunk", () => { chunkCount++; });

client.on("spawn", () => {
    S.spawned = true;
    log("spawned", LIVE ? "" : "(BP_LIVE=0: staying on the loading screen)");
    if (LIVE) goLive();
    afterSpawn();
    if (CTRL_PORT) connectControl();
});

// ---------------------------------------------------------------------------------------------------------------
// Actions. Each returns a promise that resolves once its packets are queued (or with what it observed).
const waitTicks = n => new Promise(res => { let k = n; const step = () => { if (--k <= 0) res(); else nextTick.push(step); }; nextTick.push(step); });
const vec = v => ({ x: Number(v.x), y: Number(v.y), z: Number(v.z) });
const FACE_OFFSET = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]; // down up north south west east
function faceCenter(b, face) { const o = FACE_OFFSET[face] || [0, 1, 0]; return { x: b.x + 0.5 + o[0] * 0.5, y: b.y + 0.5 + o[1] * 0.5, z: b.z + 0.5 + o[2] * 0.5 }; }
function itemUse(action, extra) {
    const base = {
        action_type: action, trigger_type: "player_input", block_position: { x: 0, y: 0, z: 0 }, face: 255, hotbar_slot: S.selected, hand: "main_hand",
        held_item: heldItem(), player_pos: { ...S.pos }, click_pos: { x: 0, y: 0, z: 0 }, block_runtime_id: 0, client_prediction: "success", client_cooldown_state: "off",
    };
    return { ...base, ...extra };
}
let stackReqId = -1;
const stackWaiters = new Map();
client.on("item_stack_response", p => { for (const r of p.responses || []) { const w = stackWaiters.get(r.request_id); if (w) w(r); } });
/** StackRequestSlotInfo for an inventory slot as the client names it: hotbar 0-8, inventory 9-35 */
const slotInfo = slot => ({ slot_type: { container_id: slot < 9 ? "hotbar" : "inventory", dynamic_container_id: undefined }, slot, stack_id: slotItem(0, slot).stack_id ?? 0 });
/** the inventory action a client predicts when an item use takes `n` from the held stack (placing a block, throwing a
 * snowball): the slot's old stack and what is left. The engine checks it against what really changed and answers
 * BalanceMismatch (2) when it is missing, after doing the use anyway. */
function consumeAction(n) {
    const it = heldItem();
    if (!n || !it.network_id) return [];
    const left = it.count > n ? { ...it, count: it.count - n } : AIR;
    return [slotAction(S.selected, it, left)];
}
/** a slot's predicted change: the old stack and the new one */
const slotAction = (slot, old_item, new_item) => ({ source_type: "container", container_presence: true, window_id: 0, flag_presence: true, flags: undefined, slot, old_item, new_item });
/** a stack with `by` more durability used: the `Damage` int in its NBT, which the server writes the same way */
function damaged(it, by) {
    // bedrock-protocol's switch on has_nbt matches the boolean true (what it decodes too), not the mapped "true"
    const has = it.extra && (it.extra.has_nbt === true || it.extra.has_nbt === "true") && it.extra.nbt;
    const tags = has ? { ...it.extra.nbt.nbt.value } : {};
    tags.Damage = { type: "int", value: ((tags.Damage && tags.Damage.value) || 0) + by };
    return { ...it, extra: { can_place_on: [], can_destroy: [], ...it.extra, has_nbt: true, nbt: { version: 1, nbt: { type: "compound", name: "", value: tags } } } };
}
function sendTransaction(type, data, actions = []) {
    client.queue("inventory_transaction", { transaction: { legacy: { legacy_request_id: 0 }, transaction_type_presence: true, transaction_type: type, actions_presence: true, actions, transaction_data: data } });
}
const ops = {
    async block({ x, y, z }) { return { brid: S.blocks.get(bkey({ x, y, z })) ?? null }; },
    // a window's items as the client holds them (0 inventory, the id container_open named for a chest, ...)
    async window({ win }) {
        const out = {};
        for (const [slot, it] of S.windows.get(Number(win)) || []) if (it && it.network_id) out[slot] = { id: it.network_id, count: it.count, stack: it.stack_id };
        return { win: Number(win), items: out };
    },
    async state() {
        const inv = {};
        for (const [s, it] of S.windows.get(0) || []) if (it && it.network_id) inv[s] = { id: it.network_id, count: it.count, meta: it.metadata, stack: it.stack_id };
        return { rid: String(S.rid), pos: S.pos, vel: S.vel, onGround: S.onGround, groundY: S.groundY, yaw: S.yaw, pitch: S.pitch, tick: String(S.tick), selected: S.selected, inv, open: S.open, health: S.health, corrections: S.corrections, authSent: S.authSent, ents: S.ents.size };
    },
    async ground({ y }) { S.groundY = y === null ? null : Number(y); return { groundY: S.groundY }; },
    async look({ yaw, pitch }) { S.yaw = Number(yaw); S.pitch = Number(pitch); await waitTicks(1); return { yaw: S.yaw, pitch: S.pitch }; },
    async lookAt({ x, y, z }) { const d = lookAt(vec({ x, y, z })); await waitTicks(1); return { yaw: S.yaw, pitch: S.pitch, dist: d }; },
    async walk({ forward = 1, strafe = 0, ticks = 20, sprint = false }) {
        intent.forward = forward; intent.strafe = strafe; intent.sprint = !!sprint;
        if (sprint) once.push("start_sprinting");
        await waitTicks(ticks);
        if (intent.sprint) once.push("stop_sprinting");
        intent.forward = 0; intent.strafe = 0; intent.sprint = false;
        return { pos: S.pos };
    },
    async jump({ hold = 2, wait = 1 } = {}) {
        intent.jumpQueued = true; intent.jumpTicks = Math.max(1, hold);
        once.push("jump_pressed_raw");
        const y0 = feetY();
        if (!wait) { await waitTicks(1); return { started: true, pos: S.pos }; }
        let top = y0;
        for (let i = 0; i < 16; i++) { await waitTicks(1); top = Math.max(top, feetY()); if (i > 2 && S.onGround) break; }
        return { rose: top - y0, onGround: S.onGround, pos: S.pos };
    },
    async sneak({ on }) {
        if (on && !intent.sneak) { once.push("start_sneaking", "sneak_pressed_raw"); intent.sneak = true; }
        if (!on && intent.sneak) { once.push("stop_sneaking", "sneak_released_raw"); intent.sneak = false; }
        await waitTicks(1);
        return { sneak: intent.sneak };
    },
    async sprint({ on }) {
        if (on && !intent.sprint) { once.push("start_sprinting"); intent.sprint = true; }
        if (!on && intent.sprint) { once.push("stop_sprinting"); intent.sprint = false; }
        await waitTicks(1);
        return { sprint: intent.sprint };
    },
    // hold a movement intent until told otherwise (walk() is the timed form)
    async move({ forward = 0, strafe = 0 }) { intent.forward = forward; intent.strafe = strafe; await waitTicks(1); return { pos: S.pos }; },
    async flags({ list, hold }) {
        if (hold !== undefined) { heldFlags.clear(); for (const f of hold) heldFlags.add(f); }
        if (list) once.push(...list);
        await waitTicks(1);
        return { sent: list, held: [...heldFlags] };
    },
    async swing() { once.push("missed_swing"); await waitTicks(1); return {}; },
    // attack/interact an entity: face the aim point (the target's middle, from the probe) for a tick, then swing and
    // send the item_use_on_entity transaction with what we hold, from where we stand
    async attack({ rid, aim, action = "attack", swing = true, settle = 1, zeroInteract = 0 }) {
        const t = vec(aim);
        const dist = lookAt(t);
        S.zeroInteract = !!zeroInteract;
        await waitTicks(settle);
        const target = S.ents.get(String(rid));
        const base = target ? target.pos : t;
        const data = { entity_runtime_id: big(rid), action_type: action, hotbar_slot: S.selected, held_item: heldItem(), player_pos: { ...S.pos }, click_pos: { x: t.x - base.x, y: t.y - base.y, z: t.z - base.z } };
        if (swing && action === "attack") client.queue("animate", { action_id: "swing_arm", runtime_entity_id: S.rid, data: 0, has_swing_source: true, swing_source: "attack" });
        sendTransaction("item_use_on_entity", data);
        log(action, String(rid), "dist", dist.toFixed(2), "yaw", S.yaw.toFixed(1), "pitch", S.pitch.toFixed(1), "held", J(heldItem()).slice(0, 160), "slot", S.selected, "onGround", S.onGround, S.zeroInteract ? "interact_rotation 0" : "");
        await waitTicks(1);
        S.zeroInteract = false;
        return { dist, yaw: S.yaw, pitch: S.pitch };
    },
    // right-click a block face: face it for a tick, then the item_use click_block transaction (in its own packet, or
    // carried by the next auth input with via: "auth")
    async useItemOn({ x, y, z, face = 1, brid, click, via = "packet", settle = 1, consume = 0 }) {
        const b = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
        if (brid === undefined || brid === null) brid = S.blocks.get(bkey(b)) ?? 0; // the clicked block, as the server last told us
        const fc = faceCenter(b, face);
        const dist = lookAt(fc);
        await waitTicks(settle);
        const rel = click ? vec(click) : { x: fc.x - b.x, y: fc.y - b.y, z: fc.z - b.z };
        const data = itemUse("click_block", { block_position: b, face, click_pos: rel, block_runtime_id: Number(brid) });
        const actions = consumeAction(consume);
        if (via === "auth") pendingAuthTx = { legacy: { legacy_request_id: 0 }, actions_presence: true, actions, data };
        else sendTransaction("item_use", data, actions);
        log("useItemOn", J(b), "face", face, "via", via, "held", heldItem().network_id, "brid", brid, "dist", dist.toFixed(2), consume ? `consume ${consume}` : "");
        await waitTicks(1);
        return { dist, brid };
    },
    async useItem({ via = "packet", startUsing = false, consume = 0 } = {}) {
        const data = itemUse("click_air", {});
        if (startUsing) once.push("start_using_item");
        const actions = consumeAction(consume);
        if (via === "auth") pendingAuthTx = { legacy: { legacy_request_id: 0 }, actions_presence: true, actions, data };
        else sendTransaction("item_use", data, actions);
        log("useItem click_air via", via, "held", heldItem().network_id, consume ? `consume ${consume}` : "");
        await waitTicks(1);
        return {};
    },
    // releasing a drawn bow. With `ammoSlot` the bot also predicts what the shot changes, as for a snowball: the bow one
    // durability down (`wear`) and one arrow gone from that slot; without it the engine shoots and answers BalanceMismatch
    async release({ ammoSlot = null, wear = 1 } = {}) {
        const it = heldItem();
        const actions = [];
        if (ammoSlot !== null && it.network_id) {
            if (wear) actions.push(slotAction(S.selected, it, damaged(it, wear)));
            const ammo = slotItem(0, Number(ammoSlot));
            if (ammo.network_id) actions.push(slotAction(Number(ammoSlot), ammo, ammo.count > 1 ? { ...ammo, count: ammo.count - 1 } : AIR));
        }
        sendTransaction("item_release", { action_type: "release", hotbar_slot: S.selected, held_item: it, head_pos: { ...S.pos } }, actions);
        log("release held", it.network_id, ammoSlot !== null ? `predict ammo slot ${ammoSlot} wear ${wear}` : "");
        await waitTicks(1);
        return {};
    },
    // server-authoritative block breaking: block actions carried by the auth input, one list per tick
    async blockActions({ list }) {
        pendingBlockActions.push(...list.map(a => ({ action: a.action, position: { x: a.x, y: a.y, z: a.z }, face: a.face ?? 1 })));
        await waitTicks(1);
        return { sent: list.length };
    },
    // the sequence a client sends (Geyser's BlockBreakHandler reads the same): start_break, continue_break every tick, and on
    // the tick the client thinks the block is gone continue_break + predict_break together, with the break_block item-use
    // transaction carried by the same auth input; abort_break instead when it lets go early. No stop_break.
    async breakBlock({ x, y, z, face = 1, ticks = 20, predict = true, abort = false }) {
        const b = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
        lookAt(faceCenter(b, face));
        await waitTicks(1);
        const at = { position: b, face };
        pendingBlockActions.push({ action: "start_break", ...at });
        await waitTicks(1);
        for (let i = 0; i < ticks; i++) { pendingBlockActions.push({ action: "continue_break", ...at }); await waitTicks(1); }
        if (abort) { pendingBlockActions.push({ action: "abort_break", ...at }); await waitTicks(1); return { ticks, aborted: true }; }
        if (predict) {
            const brid = S.blocks.get(bkey(b)) ?? 0;
            pendingBlockActions.push({ action: "continue_break", ...at }, { action: "predict_break", ...at });
            pendingAuthTx = { legacy: { legacy_request_id: 0 }, actions_presence: true, actions: [], data: itemUse("break_block", { block_position: b, face, block_runtime_id: brid }) };
            await waitTicks(1);
        }
        return { ticks };
    },
    async select({ slot }) {
        S.selected = slot;
        client.queue("mob_equipment", { runtime_entity_id: S.rid, item: slotItem(0, slot), slot, selected_slot: slot, window_id: "inventory" });
        await waitTicks(1);
        return { selected: slot, item: slotItem(0, slot).network_id };
    },
    // the hotbar drop (Q): a normal transaction, the slot it came from and the world-interaction drop
    async drop({ slot = S.selected, count = 1 }) {
        const it = slotItem(0, slot);
        if (!it.network_id) return { error: `slot ${slot} is empty` };
        const n = Math.min(count, it.count);
        const dropped = { ...it, count: n, has_stack_id: false, stack_id: undefined }; // a new stack: no net id of its own yet
        const left = it.count > n ? { ...it, count: it.count - n } : AIR;
        // a client lists the slot first and the world-interaction drop second (Geyser reads them as actions[0] / [1])
        const actions = [
            { source_type: "container", container_presence: true, window_id: 0, flag_presence: true, flags: undefined, slot, old_item: it, new_item: left },
            { source_type: "world_interaction", container_presence: true, window_id: undefined, flag_presence: true, flags: 0, slot: 0, old_item: AIR, new_item: dropped },
        ];
        sendTransaction("normal", undefined, actions);
        log("drop slot", slot, "count", n, "of", it.count, "item", it.network_id);
        await waitTicks(1);
        return { dropped: n };
    },
    async closeContainer({ id } = {}) {
        const w = id ?? S.open?.id;
        if (w === undefined || w === null) return { error: "no open container" };
        client.queue("container_close", { window_id: w, window_type: S.open?.type ?? "none", server: false });
        log("container_close sent", w);
        await waitTicks(1);
        return { closed: w };
    },
    async chat({ text }) {
        client.queue("text", { needs_translation: false, category: "authored", type: "chat", source_name: client.username || "bdsxprobe", message: text, xuid: "", platform_chat_id: "", has_filtered_message: false });
        await waitTicks(1);
        return {};
    },
    // a command typed in chat: the origin is the player itself (PlayerCommandOrigin); version "latest" as a client sends it
    async command({ text }) {
        client.queue("command_request", { command: text.startsWith("/") ? text : `/${text}`, origin: { type: "player", uuid: "00000000-0000-0000-0000-000000000000", request_id: "", player_entity_id: 0n }, internal: false, version: "latest" });
        log("command", text);
        await waitTicks(1);
        return {};
    },
    // answer the last (or a given) form; data null closes it (formId, not id: `id` is the request's own)
    async form({ formId, data }) {
        const fid = formId ?? S.form?.id;
        if (fid === undefined) return { error: "no form" };
        formReply(fid, data === undefined ? null : data);
        await waitTicks(1);
        return { formId: fid };
    },
    // ItemStackRequest, the server-authoritative inventory: `actions` in minecraft-data form (type_id, legacy_type_id = the
    // engine's action type byte, body). Request ids count down by two from -1, as a client's do. Waits for the response.
    async stackRequest({ actions, names = [], wait = 20 }) {
        const id = (stackReqId -= 2);
        const got = new Promise(res => { stackWaiters.set(id, res); setTimeout(() => res(null), wait * 50 + 500); });
        client.queue("item_stack_request", { requests: [{ request_id: id, actions, custom_names: names, cause: "chat_public" }] });
        log("item_stack_request", id, J(actions).slice(0, 200));
        const r = await got;
        stackWaiters.delete(id);
        return r === null ? { requestId: id, error: "no item_stack_response" } : { requestId: id, status: r.status, containers: r.containers };
    },
    // drop from an inventory slot through the stack request (what the inventory screen does): hotbar slots are 0-8
    async stackDrop({ slot = S.selected, count = 1 }) {
        const it = slotItem(0, slot);
        if (!it.network_id) return { error: `slot ${slot} is empty` };
        return ops.stackRequest({ actions: [{ type_id: "drop", legacy_type_id: 3, count, source: slotInfo(slot), randomly: false }] });
    },
    async raw({ name, params }) { client.queue(name, params); await waitTicks(1); return {}; },
    async wait({ ticks = 1 }) { await waitTicks(ticks); return { tick: String(S.tick) }; },
};

// ---------------------------------------------------------------------------------------------------------------
// The control channel: JSON lines over TCP to the probe. Requests {id, op, ...args} -> replies {id, ok, ...};
// unsolicited {ev, ...} lines tell the probe what the client saw.
let ctrl = null;
function emit(obj) { if (ctrl && !ctrl.destroyed) { try { ctrl.write(J(obj) + "\n"); } catch (e) {} } }
function connectControl() {
    const sock = net.connect(CTRL_PORT, "127.0.0.1");
    let buf = "";
    sock.on("connect", () => { ctrl = sock; log("control connected on", CTRL_PORT); emit({ ev: "hello", rid: String(S.rid), name: client.username, version: VERSION }); });
    sock.on("data", d => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let req;
            try { req = JSON.parse(line); } catch (e) { log("bad control line", line.slice(0, 100)); continue; }
            const fn = ops[req.op];
            if (!fn) { emit({ id: req.id, ok: false, error: `unknown op ${req.op}` }); continue; }
            // the reply's id and ok last: an op result may carry fields of its own named `id`
            Promise.resolve().then(() => fn(req)).then(r => emit({ ...r, id: req.id, ok: !(r && r.error) }), e => emit({ id: req.id, ok: false, error: e.message }));
        }
    });
    sock.on("error", e => { if (!ctrl) setTimeout(connectControl, 1000); else log("control error", e.message); });
    sock.on("close", () => { if (ctrl === sock) { ctrl = null; log("control closed"); } });
}

// the old bot's witness line for chunk resends (actor-layout-probe.ts "chunks" reads the burst in .bot.log)
if (!SELFTEST) setInterval(() => log("chunk_count", chunkCount, ...(LIVE ? ["auth_input", S.authSent, "corrections", S.corrections] : [])), 2000);
if (!SELFTEST) setInterval(() => log("status", J({ pos: S.pos, onGround: S.onGround, tick: S.tick, auth: S.authSent, corrections: S.corrections, sel: S.selected, held: heldItem().network_id, chunks: chunkCount })), 5000);
if (!SELFTEST) setTimeout(() => { log("time is up, leaving"); try { client.close(); } catch (e) {} setTimeout(() => process.exit(0), 1000); }, secs * 1000);

// ---------------------------------------------------------------------------------------------------------------
function selftestClient() {
    const { createSerializer, createDeserializer } = require("bedrock-protocol/src/transforms/serializer");
    const codecs = ["1.26.40", "1.26.51"].map(v => ({ v, ser: createSerializer(v), des: createDeserializer(v) }));
    let bad = 0;
    const fake = {
        username: "bdsxprobe", options: {}, on() {}, close() {},
        queue(name, params) {
            for (const c of codecs) {
                try {
                    const buf = c.ser.createPacketBuffer({ name, params });
                    const back = c.des.parsePacketBuffer(buf).data;
                    console.log(`${c.v} ${name} ${buf.length}B ${buf.toString("hex").slice(0, 160)}`);
                    if (back.name !== name) { bad++; console.log("  decoded as", back.name); }
                } catch (e) { bad++; console.log(`${c.v} ${name} FAILED ${e.message.slice(0, 300)}`); }
            }
        },
    };
    setTimeout(async () => {
        S.rid = 1n; S.pos = { x: 29.5, y: 69.62, z: 14.5 }; S.groundY = 68; S.onGround = true; S.tick = 1000n;
        S.windows.set(0, new Map([[0, AIR], [1, { network_id: 380, count: 16, metadata: 0, has_stack_id: true, stack_id: 7, block_runtime_id: 0, extra: { has_nbt: "false", can_place_on: [], can_destroy: [] } }]]));
        S.ents.set("5", { type: "minecraft:pig", pos: { x: 31, y: 68, z: 14 }, uid: "-5" });
        const run = async (op, args) => { console.log(`-- ${op} ${J(args)}`); try { console.log("   ->", J(await ops[op](args))); } catch (e) { bad++; console.log("   threw", e.stack); } };
        const tick = setInterval(authInput, 1);
        await run("attack", { rid: "5", aim: { x: 31, y: 68.45, z: 14 } });
        await run("attack", { rid: "5", aim: { x: 31, y: 68.45, z: 14 }, action: "interact" });
        await run("useItemOn", { x: 30, y: 67, z: 14, face: 1 });
        await run("useItemOn", { x: 30, y: 67, z: 14, face: 1, via: "auth" });
        await run("useItem", {});
        S.windows.get(0).set(0, S.windows.get(0).get(1)); await run("useItem", { consume: 1 }); S.windows.get(0).set(0, AIR);
        await run("useItem", { via: "auth", startUsing: true });
        await run("release", {});
        S.windows.get(0).set(0, S.windows.get(0).get(1)); await run("release", { ammoSlot: 1 }); S.windows.get(0).set(0, AIR);
        await run("blockActions", { list: [{ action: "start_break", x: 30, y: 67, z: 14, face: 1 }] });
        await run("breakBlock", { x: 30, y: 67, z: 14, face: 1, ticks: 2 });
        await run("select", { slot: 1 });
        await run("drop", { slot: 1, count: 1 });
        await run("stackDrop", { slot: 1, count: 1, wait: 1 });
        await run("jump", {});
        S.open = { id: 2, type: "container" };
        await run("closeContainer", {});
        await run("chat", { text: "hello" });
        await run("command", { text: "say hi" });
        S.form = { id: 3 };
        await run("form", { data: "[true]" });
        await run("form", {});
        clearInterval(tick);
        console.log(bad ? `SELFTEST: ${bad} failure(s)` : "SELFTEST: all packets encode and decode on both builds");
        process.exit(bad ? 1 : 0);
    }, 10);
    return fake;
}
