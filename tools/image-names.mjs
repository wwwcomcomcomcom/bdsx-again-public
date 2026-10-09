/**
 * Two existence signals read straight off the image's strings, next to tools/entt-typenames.mjs.
 *
 * 1. Lambda scopes. BDS is built with RTTI off for its own classes (docs/findings-survey.md), but a
 *    lambda stored in a std::function still gets a type descriptor, and MSVC names a lambda after the
 *    function it is written in:
 *
 *        .?AV<lambda_47>@?0??newResults@CommandSelectorBase@@IEBA?AV?$shared_ptr@...@Z@
 *                            ^ the enclosing function's full decorated name
 *
 *    So every such descriptor proves that a function with *exactly that decoration* is in the 1.26
 *    source: the class, the method and the signature all survived. It does not prove an out-of-line
 *    copy (the enclosing function may be inlined into every caller), and it says nothing about the
 *    functions that hold no lambda. 1.21.3.01 carries 49 of these, 1.26.40.8 about 3,800.
 *
 * 2. EnTT pretty_function type names. `entt::internal::pretty_function() [Type = X]` is emitted for
 *    every type EnTT meta or type_id touches; it lists types entt-typenames.mjs misses (that scan only
 *    sees registry storage type_info), e.g. `ArmorItemComponent`, `DamageSensorComponent`.
 *
 *   node tools/image-names.mjs <version>              -> work/entt/image-names-<version>.json
 *   node tools/image-names.mjs <version> --grep=<re>  print matches only
 */
import * as fs from "fs";
import { pathToFileURL } from "url";

export function imageNames(exePath) {
    const s = fs.readFileSync(exePath).toString("latin1");
    const scopes = new Set(), types = new Set();
    // the scope runs from the `?` after `@?<n>?` to the `@` that closes the descriptor name
    for (const m of s.matchAll(/\.\?A[VU]<lambda_[0-9a-f_]+>@\?[0-9A-Z]+\?(\?[^\0]*?)@\0/g)) scopes.add(m[1]);
    for (const m of s.matchAll(/pretty_function\(\) \[Type = ([^\]\0]+)\]/g)) types.add(m[1]);
    return { lambdaScopes: [...scopes].sort(), prettyTypes: [...types].sort() };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const args = process.argv.slice(2);
    const v = args.find(a => !a.startsWith("--"));
    if (!v) {
        console.error("usage: node tools/image-names.mjs <version> [--grep=<regex>]");
        process.exit(2);
    }
    const r = imageNames(`work/bin/${v}/bedrock_server.exe`);
    const grep = args.find(a => a.startsWith("--grep="))?.slice(7);
    if (grep) {
        const re = new RegExp(grep);
        for (const n of r.lambdaScopes) if (re.test(n)) console.log(`scope  ${n}`);
        for (const n of r.prettyTypes) if (re.test(n)) console.log(`type   ${n}`);
    } else {
        fs.mkdirSync("work/entt", { recursive: true });
        const out = `work/entt/image-names-${v}.json`;
        fs.writeFileSync(out, JSON.stringify(r, null, 1));
        console.log(`${v}: ${r.lambdaScopes.length} lambda scopes, ${r.prettyTypes.length} pretty_function types -> ${out}`);
    }
}
