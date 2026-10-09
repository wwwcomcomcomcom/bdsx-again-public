// <lab>\<instance>\index.ts while probing: every probe plugin, then the stock examples.
// tools/host/session.mjs copies this there; a probe that is not deployed is simply commented out here.
import "./example_and_test/zz-accprobe"; // first: a probe that fails to load ends the chain after it
import "./example_and_test/zz-originprobe";
import "./example_and_test/zz-grprobe";
import "./example_and_test/zz-sigprobe";
import "./example_and_test/zz-layoutprobe";
import "./example_and_test/zz-allocprobe";
import "./example_and_test/zz-itemprobe";
import "./example_and_test/zz-blkprobe";
import "./example_and_test/zz-abilprobe";
import "./example_and_test/zz-pktprobe";
import "./example_and_test/zz-pksprobe";
import "./example_and_test/zz-conprobe";
import "./example_and_test/zz-stprobe";
import "./example_and_test/zz-seprobe";
import "./example_and_test/zz-icprobe";
import "./example_and_test/zz-contprobe";
import "./example_and_test/zz-navprobe";
import "./example_and_test/zz-simpprobe";
import "./example_and_test/zz-compprobe";
import "./example_and_test/zz-lbprobe";
// bdsx's stock examples, the ones that loaded before 2026-10-02: example_and_test/index.ts stops at lowlevel-asm, whose
// assembly throws at load, so nothing after it ever ran. Three of those set module-level intervals that never fired while
// bdsx had no update hook on 1.26 (players' health every 100 ms, effects every second, the MOTD every 5 s); with node's
// loop running again they would act on every session's players, so they stay out (docs/findings-bot.md section 7).
// event-playerdropitem's alternate-drop cancel stays: the lb drop scenario uses it for its cancelled side.
import "./example_and_test/blockcustomname";
import "./example_and_test/customcommand";
import "./example_and_test/event-blockdestroy";
import "./example_and_test/event-knockback";
import "./example_and_test/event-playerdropitem";
import "./example_and_test/executecommand";
import "./example_and_test/form";
import "./example_and_test/hidemapmarker";
import "./example_and_test/inventory";
import "./example_and_test/ipban";
import "./example_and_test/lowlevel-apihooking";
