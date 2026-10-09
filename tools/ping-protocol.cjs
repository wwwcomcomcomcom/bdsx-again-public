/**
 * Ask a running BDS what protocol it speaks, with an unconnected RakNet ping.
 *
 * `SharedConstants::NetworkProtocolVersion` has no address we can find, and
 * unlike the four version integers it cannot be read off the build number.
 * The server publishes it in the MOTD it answers pings with -- the same string
 * a client reads before it connects -- so that is where the shipped value
 * comes from (docs/findings-utils.md). Run it on the host while the server is
 * up; the number goes into tools/version-constants.mjs --protocol=N.
 *
 * Usage: node tools/ping-protocol.cjs [host] [port]
 */
const dgram = require("dgram");

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3] || 19132);
const MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

const request = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(8), MAGIC, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
const socket = dgram.createSocket("udp4");
const timer = setTimeout(() => {
    console.error(`no answer from ${host}:${port} in 5s`);
    socket.close();
    process.exit(1);
}, 5000);

socket.on("message", msg => {
    clearTimeout(timer);
    if (msg[0] !== 0x1c) {
        console.error(`unexpected packet id 0x${msg[0].toString(16)}`);
        socket.close();
        process.exit(1);
    }
    const length = msg.readUInt16BE(33);
    const motd = msg.subarray(35, 35 + length).toString("utf8");
    const fields = motd.split(";");
    console.log(`motd     : ${motd}`);
    console.log(`protocol : ${fields[2]}`);
    console.log(`version  : ${fields[3]}`);
    socket.close();
});
socket.send(request, port, host, err => {
    if (err) {
        console.error(String(err));
        process.exit(1);
    }
});
