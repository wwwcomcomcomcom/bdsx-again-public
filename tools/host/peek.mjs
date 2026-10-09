/**
 * Filter one run's stdout + stderr (<lab>/runs/<Tag>.out / .err) down to the lines that matter.
 * The crash markers are always included: silence must never look like success.
 *
 *   node tools/host/peek.mjs <Tag> ["PASS|FAIL"] [first=120]
 */
import { peek } from "./lab.mjs";

const [tag, pattern = "PASS|FAIL", first = "120"] = process.argv.slice(2);
if (!tag) { console.error('usage: node tools/host/peek.mjs <Tag> ["regex"] [first]'); process.exit(2); }
for (const l of peek(tag, pattern, Number(first))) console.log(l);
