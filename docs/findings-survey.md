# Week 1 findings

Facts established on the Mac before any Windows work. Several of these change
premises the plan was written on.

## Versions pinned

| | Version | SHA-256 of `bedrock_server.exe` | MD5 |
|---|---|---|---|
| Baseline | 1.21.3.01 | `ccfe036a98d0ec31ede995605c8c5c0df213ff1339c1520dce54b84d719e91d2` | `d0325bef148590e30f926dc2f2a46301` |
| Target | 1.26.51.1 | `76d547f82e02c18d0986c30b47132c9cc4171d0f2df1c00649e50ff35788b321` | `a92cff3b1324d612219510582e9fb3da` |

Current stable BDS comes from Mojang's own version endpoint:
`https://net-secondary.web.minecraft-services.net/api/v1.0/download/links`.

**The download host in bdsx's installer is dead.** `installerapi.ts` uses
`minecraft.azureedge.net`, which no longer resolves; the live host is
`https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-%BDS_VERSION%.zip`.
Milestone 0 will fail at the download step until this is changed — unrelated
to symbols, and cheap to fix.

## The baseline is stronger than the plan assumed

Two things the plan listed as open risks are resolved, one each way.

**`pdbcache` is not raw PDBs — risk #4 confirmed as stated.** `pdbcache.bin`
is bdsx's own open-addressed hashmap: a 28-byte header (`u32` format version,
`u8[16]` MD5 of the exe, `u32` main RVA, `u32` capacity), a table of
`{u32 hash, u32 nameOffset, u32 rva}`, then a UTF-8 name blob. It carries
addresses only. 719,694 entries for 1.21.3.01.

**But the consequence the risk predicted does not follow.** The 1.21.3.01
release zip *still ships `bedrock_server.pdb`* (256 MB), and it is still
downloadable today. Its GUID `{48C7A2A1-EF8D-4EB0-884F-4D00FFC2EDC5}` age 2
matches the exe's debug directory exactly, and the MD5 of the exe in that zip
matches the MD5 recorded inside `pdbcache.bin` byte for byte. So the baseline
comes with full type information after all, and Milestone 5's diff has a
properly named, properly typed left-hand side.

## The toolchain changed underneath the diff

This is the new risk, and it is the one likely to set the match rate.

| | 1.21.3.01 | 1.26.51.1 |
|---|---|---|
| `.text` | 45.6 MB (`0x02b6ed74`) | 173.5 MB (`0x0a5bbd46`) |
| Debug dir | CodeView + `VCFeature` | CodeView only |
| PDB GUID tail | ordinary | `4C4C 4420 5044 422E` = `"LLD PDB."` |
| Build path | `win32_server_x64_ninja` | `win32_server_x64` |

The `"LLD PDB."` placeholder GUID and the missing `VCFeature` record mean the
target is linked with **`lld-link`**, not MSVC `link.exe`. Code is 3.8x
larger. BinDiff is being asked to match across a linker — and probably
compiler — change on top of two years of source churn, so the plan's "match
rate is the key project variable" should be read pessimistically until
measured.

Decorated names are unaffected: clang-cl keeps the MSVC ABI and MSVC
mangling, so the `symbols.ts` contract still holds.

## RTTI does not cover the classes bdsx hooks - Milestone 2 does not work

**This corrects an earlier entry in this document.** I first wrote that RTTI
survives because `strings` reports 6,841 `.?AV`/`.?AU` type descriptors in
1.26.51.1 and 7,156 in the baseline, and concluded Milestone 2's premise
held. Counting descriptors was the wrong check. The right one is whether any
of them name a class bdsx hooks, and none do:

```
.?AVActor@@          ABSENT   (raw byte search, both binaries)
.?AVLevel@@          ABSENT
.?AVPlayer@@         ABSENT
.?AVBlockSource@@    ABSENT
.?AVCompoundTag@@    ABSENT
```

The descriptors that exist are lambdas, STL types, the Concurrency runtime
and the Xbox Live SDK. Parsing the RTTI structures directly
(`tools/rtti-scan.mjs`: type descriptors, then complete object locators
validated by their self-pointer, then the vftable each locator precedes)
finds 916 locators in the baseline, of which exactly 8 are plain classes -
`TaskQueueImpl`, `type_info` and similar. Checked against the 82 `??_7`
vftable symbols bdsx declares and whose baseline addresses pdbcache gives us:
**0 of 82 found.**

Confirming it from the other end, `Actor`'s vftable is at `0x2da38f0` in the
baseline, and the QWORD at `0x2da38e8` - where a complete object locator
pointer would sit - is zero.

**BDS game code is compiled with RTTI off.** This was already true in
1.21.3.01, so unlike everything else in this document it is not a consequence
of the compiler change; it was never true.

### What this costs

Milestone 2 is the plan's "main technique", the one it says to run first
because it needs no pattern matching, no pdbcache and no diff. It does not
work here at all. The 84 `??_7` vftable symbols and the 108 `jsv` call sites
that index vftable slots lose their intended recovery route.

### What replaces it

The vftables are still there - `Actor`'s is exactly where pdbcache says - they
just carry no names. Two routes reach them, and both run through the diff
rather than around it:

- **By contents.** A vftable is a run of pointers to virtual functions. Once
  the diff has matched those functions, the target vftable is the `.rdata`
  run whose entries are their matched addresses. That is self-validating: a
  wrong candidate disagrees on every slot.
- **By constructor.** A class's constructor stores its vftable pointer, so a
  matched constructor names the vftable that its `lea` reaches.

Ghidra's own RTTI analyzer, for the record, reports 987 classes on the
baseline - `Concurrency::details::*`, `Api<...>` and similar - and none of
`Level`, `Actor`, `Player` or `MinecraftCommands`. It agrees; it just does
not say so loudly.
## The required-symbol set (Milestone 1a)

1,076 distinct decorated names across 220 source files.

| Usage | Count |
|---|---|
| `procHacker.js` | 765 |
| `procHacker.jsv` (vftable slot) | 108 |
| `procHacker.hooking` | 61 |
| `proc[...]` direct | 102 |
| raw/patch/nop/write | 15 |
| literal only (no structural site) | 46 |

By shape: 896 ordinary functions, 87 special-name operators, 84 vftables
(`??_7`), 42 constructors, 19 destructors, 2 lambdas. 224 carry a virtual
access specifier in their mangling — those plus the 84 vftables are the
Milestone 2 catchment, roughly 29%. The rest needs Milestone 5.

1,061 of the 1,076 (98.6%) resolve against the 1.21.3.01 baseline. The 15
that do not are all literal-only names already stale when bdsx was archived.
**1,061 is the working denominator.**

## Environment constraint

17 GB free on the Mac (460 GB volume, 96% used). A Ghidra project for a
223 MB binary with 173 MB of code will not fit alongside a second one for the
baseline, and Milestone 5 needs both imported at once.

## Byte-level similarity between the two builds is effectively zero

Measured before BinDiff, because the plan asks for the match rate early and
this costs minutes rather than an overnight export. For each of the 951
baseline symbols that live in `.text`, take its first *N* bytes and look for
them anywhere in the target's `.text` (`tools/prologue-probe.mjs`).

| Prologue length | Unique hit | Ambiguous | No hit |
|---|---|---|---|
| 8 B | 7.0% | 65.9% | 27.0% |
| 12 B | 6.7% | 42.9% | 50.4% |
| 16 B | 8.1% | 28.3% | 63.6% |
| 24 B | 2.3% | 3.6% | 94.1% |
| 32 B | 1.2% | 0.3% | 98.5% |
| 48 B | 0.0% | 0.0% | **100.0%** |

Not one of the 951 functions begins with the same 48 bytes as its 1.21.3.01
counterpart. The probe is not at fault: run against the baseline as its own
target it reports 0% no-hit and 92.7% unique, the remaining 7.3% being
genuinely shared prologues.

**Consequence 1 — the plan's byte-pattern fallback is dead.** Milestone 5
lists "prologue-anchored byte-pattern matching" for what the diff does not
cover. Against a compiler change that technique yields essentially nothing,
and the few hits it does produce at short pattern lengths are swamped by
ambiguity. It should be replaced, not tuned.

**Consequence 2 — anchor on data, not code.** RTTI, vftables and string
literals are unaffected by instruction selection. "The function that
references this unique string" survives a compiler change in a way that "the
function that starts with these bytes" does not. That is the right fallback
here.

**Consequence 3 — Milestone 2 carries more weight than the plan gives it.**
It is the one technique immune to codegen change. Against that, tier 0 of the
vertical slice -- the 41 symbols bdsx needs to boot at all -- contains only 10
virtuals, so the critical path still runs through Milestone 5.

This does **not** condemn BinDiff. It matches on control-flow and call-graph
structure, which survives instruction-level change, so its rate can be far
above these numbers. But it is now doing the hard version of its job, and the
measured rate should be treated as an open question rather than an
optimistic default.

---

# Milestone 0 — GO

`tools/smoke.ps1` exits 10 against BDS 1.26.51.1: bdsx reaches symbol
resolution and fails there. That is the plan's GOOD classification, and it is
reached through the entire native stack:

```
Error: Symbol not found: ?MajorVersion@SharedConstants@@3HB
   at get (bdsx/bds/symbols.ts:29:33)
   at Anonymous function (bdsx/check.ts:58:1)
```

Everything upstream of that line worked on a binary two years and one
compiler newer than anything bdsx ever ran on: the proxy DLL loaded,
bdsx-core's native bootstrap ran, `main` was hooked, ChakraCore and its
embedded node started, bdsx's TypeScript executed, and the new symbols.json
loader parsed an empty table and degraded to -1 instead of throwing.

**bdsx-core still attaches. Risks #1 and #2 are closed.** The remaining work
is symbols, which is the work the plan is actually about.

## How bdsx-core attaches, and what the plan missed

The plan says bdsx concentrates all runtime symbol resolution behind
`bds/symbols.ts`. That is true of the *JavaScript* side and false of the
process as a whole: **bdsx-core needs one address before any JavaScript
runs.**

`main.cpp` reads exactly `sizeof(PdbCacheHeader)` — 28 bytes — from
`pdbcache.bin` and uses it for three things:

```c
struct PdbCacheHeader {
    uint32_t version;         // must be 1
    byte     md5[16];         // must match bedrock_server.exe, or terminate(-1)
    uint32_t mainRva;         // where the takeover happens
    uint32_t hashMapCapacity;
};
```

It then writes a jump over the first 12 bytes of
`GetModuleHandle(nullptr) + mainRva`. The hashmap after the header is never
touched natively — it is read only from JS, which now goes through
symbols.json. So the native dependency reduces to a single symbol, `main`,
and `tools/make-pdbcache-stub.mjs` emits a 28-byte file that satisfies it.

## Finding `main` without a PDB

The CRT startup chain is intact and structurally identical across the
compiler change:

| | 1.21.3.01 | 1.26.51.1 |
|---|---|---|
| entry (`mainCRTStartup`) | `0x2a0f570` | `0xa59a2b0` |
| `jmp` to `__scrt_common_main_seh` | `-406` | `-406` |
| `main` | `0x104290` | **`0x73580`** |

Inside `__scrt_common_main_seh`, `invoke_main` is unmistakable — the call
preceded by `movl (%rax), %ecx` loading argc and followed by `movl %eax,
%ebx` taking the return value. Walking that chain on the baseline reproduces
`0x104290`, the value recorded in the baseline's own `pdbcache.bin` header,
which validates the method; applying it to the target gives `0x73580`, and
hooking there works.

`tools/disas.mjs` does the walk. `llvm-objdump` refuses to disassemble these
binaries at all, so it drives `llvm-mc --show-encoding` and tracks addresses
from the reported instruction lengths.

Target `main` happens to begin with eight one- and two-byte pushes, so
bdsx-core's 12-byte patch lands on an instruction boundary. The baseline's
does not — worth remembering if a future build is less convenient.

## Things that bite before symbols do

- The bdsx-core release zip ships the proxy `VCRUNTIME140_1.dll` but not
  `VCRUNTIME140_1_.dll`, the renamed Microsoft original its forwarder targets.
  That file is committed in the bdsx repo under `bedrock_server/`, which is
  otherwise gitignored. Without it the process dies at load with
  `0xC0000135` and prints nothing at all.
- Windows Server ships no VC++ runtime; BDS needs MSVCP140 and VCRUNTIME140.
- `npm install` must run with `--ignore-scripts`, or bdsx's postinstall tries
  to generate a pdbcache from a PDB that no longer exists.
- The TypeScript must be compiled. bdsx.bat normally does this via
  `shellprepare`; launching BDS directly does not, and node then fails to
  resolve the bdsx root as a module.

## Next blocker

`?MajorVersion@SharedConstants@@3HB` and its three siblings — a version
assertion in `check.ts`, read as plain ints. They are individual `const int`s
scattered through `.rdata` among unrelated string literals, not a struct, so
there is no layout to pattern-match and a dword equal to 1 is not a
distinguishing feature. This needs cross-reference analysis, which is
Milestone 4/5 and gated on the Ghidra run.

---

# The iteration loop, and what it costs per symbol

Mac edits the table -> `scp` -> `npx tsc` -> `smoke.ps1` -> read the verdict.
One SSH call, no interactive step, nothing left running. Turnaround is about
two minutes, most of it TypeScript compilation.

Each run reports the *next* missing symbol, so the boot path unblocks one
symbol at a time and every blocker is a concrete, bounded reversing task.
Progress so far:

| Blocker | Resolution |
|---|---|
| `pdbcache.bin` missing | 28-byte header stub; needs only `main` |
| `main` | `0x73580`, by walking the CRT startup chain |
| `SharedConstants::*Version` | marked unresolved; check.ts degrades |
| `vsnprintf` | `0xa11cdb0`, by IAT anchor |
| `std::basic_string<char>::basic_string()` | current |

## Four recovery techniques, none of which look at code bytes

The byte-similarity result ruled out pattern matching, so everything here
anchors on structure the linker is obliged to keep.

**CRT startup chain.** The PE entry point is `mainCRTStartup` by definition,
and `__scrt_common_main_seh` is one relative jump away. `invoke_main` is
unmistakable: the call preceded by `movl (%rax), %ecx`. Validated against the
baseline, where it reproduces the `main` recorded in bdsx's own pdbcache.

**Cross-reference clustering** (`tools/xref-scan.mjs`). For data constants:
find every data dword holding an expected value, find every RIP-relative
reference to them from `.text`, and look for a code window touching one of
each. On the baseline this pins Major/Minor/Patch/Revision to their true
addresses out of 223,495 candidate dwords. On the target it finds nothing,
which is itself the finding.

**Import-table anchoring** (`tools/iat-refs.mjs`, `tools/find-crt-wrapper.mjs`).
Imports are the one thing in a stripped binary that still has names, and
their addresses come from the PE header rather than from analysis. `vsnprintf`
is a forwarder around `__stdio_common_vsprintf`, so it is one of 27
references through that slot, in 23 distinct functions, of which exactly one
is 104 bytes.

**`.pdata` function boundaries** (`tools/pdata.mjs`). x64 Windows requires a
`RUNTIME_FUNCTION` for every non-leaf function, so the exception directory is
an exact, complete function table with no analysis and no PDB — 155,236
functions in the baseline, 713,382 in the target. It turns "an address inside
something" into "this function, these bounds".

## A qualification on the byte-similarity result, and a correction

`vsnprintf` is instruction-for-instruction identical between the two builds;
only the displacements differ. `std::basic_string<char>::basic_string()` is
too - 29 position-independent bytes appearing exactly once in the target,
which is how it was resolved.

My first reading of that was "library code survives, game code does not."
That is wrong. `std::basic_string<char>::~basic_string()` is library code by
the same argument, and its first **twelve** bytes do not appear anywhere in
the target. The real rule is duller: functions trivial enough that any
compiler emits the same instructions match, and everything else does not.

**Measured properly, whole-function byte matching recovers one symbol.**
`tools/exact-function-match.mjs` takes each function's exact extent - from
`.pdata`, or from the int3 padding for leaf functions, which have no unwind
data - and searches for the whole body:

| | |
|---|---|
| symbols in the baseline table | 1065 |
| not in `.text` | 111 |
| no usable extent | 15 |
| shorter than 24 bytes | 187 |
| COMDAT-folded in the baseline | 13 |
| **probed** | **736** |
| **unique exact match** | **1** |

Run against the baseline as its own target it scores 736/736, so the zero is
the binaries' fault and not the tool's.

### The two guards are the interesting part

Without them the same tool reports 41 matches, and they are almost all wrong.
Both filters exist because of failures observed, not out of caution:

- **Minimum length.** Leaf extents recover things like
  `mov rax, [rcx+0x18]; ret`. A four-byte pattern occurring once in 173 MB is
  coincidence, not identification.
- **COMDAT folding.** `Objective::getName` and `LevelChunk::getPosition` are
  both `0x17f8a20` in the baseline: identical bodies, folded by the linker.
  The baseline cannot tell them apart, so nothing derived from it can either,
  and propagating that address forward would attach one name arbitrarily.

This is the silent-wrong-address failure the plan flags under multiple
inheritance, arrived at by a different road. Any technique that yields a
"unique" hit has to answer why the hit is evidence.

**Consequence: structural diffing is not one option among several, it is the
only one that scales.** Everything else in this document resolves symbols one
at a time.

---

# Toolchain: the diffing pipeline, and why it had to be built

`Ghidra analysis -> BinExport -> BinDiff -> SQLite -> join to names`, proven
end to end on a small PE before committing the real binaries to it.

## The published BinExport does not work with current Ghidra

Ghidra extensions are version-locked, and BinExport's newest release targets
**Ghidra 11.0.3** (April 2024) while the current release is **12.1.3**.
Forcing `version=12.1.3` in `extension.properties` gets the extension to load
- it appears in the exporter list and starts exporting - and then dies:

```
java.lang.NoSuchMethodError:
  ghidra.program.util.DefinedDataIterator.definedStrings(Program)
    at BinExport2Builder.buildStrings(BinExport2Builder.java:497)
```

`definedStrings` is gone in Ghidra 12; only `byDataType` and
`byDataInstance` remain. Upstream already knows - `main` carries a commit
"Ghidra: Improve compatibility with version 12.x" from 2026-09-01 - there is
simply no release with it. So build from source:

```
git clone --depth 1 https://github.com/google/binexport.git
cd binexport/java
GHIDRA_INSTALL_DIR=/opt/homebrew/Cellar/ghidra/12.1.3/libexec gradle buildExtension
# -> dist/ghidra_12.1.3_PUBLIC_<date>_BinExport.zip
```

Unpack that into `~/Library/ghidra/ghidra_12.1.3_PUBLIC/Extensions/`. Gradle
9.6.1 and JDK 26 build it despite the `languageVersion = 21` toolchain
declaration; no separate JDK 21 is needed.

The extension zip is a build artifact and is not committed - it is Apache-2.0
and reproducible from the two commands above.

## Headless export needs its own script

BinExport ships a Ghidra *Exporter*, not a script, and headless has no
"File > Export". Its bundled `ghidra_scripts/BinExport.java` is interactive
(`askFile`, `askChoices`), so it is no use here either.
`tools/ghidra/ExportBinExport.java` looks the exporter up through
`ClassSearcher` and writes to a path given as a script argument - which also
makes it the check that the extension loaded at all.

## BinDiff

BinDiff 8 ships as a `.pkg` needing an admin install, but the payload extracts
without one:

```
pkgutil --expand-full "/Volumes/BinDiff/Install BinDiff.pkg" out
# out/BinDiff.pkg/Payload/Applications/BinDiff/BinDiff.app/Contents/MacOS/bin/bindiff
```

The binary is Apple Silicon native. Self-diffing the test export matches
1127/1127 functions, so BinDiff 8 (2023) reads BinExport 12 output built
today - the version gap between them is not a problem.

**The result file is plain SQLite**, which is what makes the offline join
work:

```sql
CREATE TABLE function (id, address1, name1, address2, name2,
                       similarity, confidence, flags, ...)
```

`address1` is the baseline address, `address2` the target's. Since
`pdbcache.bin` gives name -> RVA for all 719,694 baseline symbols, matches
can be joined to names entirely outside Ghidra, and neither import needs the
PDB loaded.

---

# Third-party symbol tables: what is actually published

The restriction against using Endstone/LeviLamina data as a source of truth
is lifted. Here is what exists.

## Endstone - Apache-2.0, plaintext, small

`scripts/dump_symbols.py` and `scripts/configs/windows.toml` are the method,
and `src/bedrock/symbols/windows.h` is the committed result: a
`std::array<std::pair<std::string_view, std::size_t>, 61>` of name and offset,
generated for **BDS 1.26.44**.

It resolves symbols by **byte signatures with wildcards** - `"48 39 0D ? ? ?
? 74 ? 48 8B 0D ..."` - matched against `.text`, with `rip_relative` handling
for data symbols. Each signature carries a comment recording how it was
derived, and those comments describe the same technique arrived at
independently here: find a unique string, follow its lone data xref, identify
the function, anchor on it.

This is the substantive correction to the earlier byte-matching result. That
measurement used *exact* bytes and recovered 1 symbol of 736. Wildcards mask
exactly the operands a compiler change moves - displacements, register
allocation - while keeping the opcode skeleton. It is the same family of
technique, done properly.

**Overlap with bdsx: 16 of 1080.** Small, but it includes
`?tick@Level@@UEAAXXZ`, the Milestone 3 hook, at `0x734790` in 1.26.44.

## LeviLamina - MIT data, opaque container

`LiteLDev/bedrock-runtime-data` publishes one 28.9 MB file per BDS build,
`bedrock_runtime_data`. **The repository is MIT**, which corrects the plan's
licence table - that table's LGPL-3.0/GPL-3.0 entry describes the LeviLamina
engine repo, not this data repo.

The file is not readable as published: magic `0b 0e 0b "ofBDS"`, a `u32`
version of 2, then 28.9 MB at 7.95 bits/byte entropy with no compression
framing anywhere. LeviLamina reads it through
`pl::symbol_provider::pl_resolve_symbol_silent_n` in `LiteLDev/PreLoader`,
whose repository publishes no source for it and carries no licence.

So the data is MIT but the format is undocumented. Two ways to it:

- **Run it.** PreLoader resolves symbols by name at runtime. Standing their
  stack up on the Windows host and asking it to resolve bdsx's 1080 names is
  using the published tool for its documented purpose, and it is the only
  route here with the volume to matter.
- **Reverse the container.** Possible, but it is reverse-engineering a third
  party's artifact whose reader is not published.

## Both oracles are on older builds

Endstone targets 1.26.44/1.26.45; LeviLamina's newest server data is
`v26.40.8`. The current target here is 1.26.51.1. Offsets do not transfer
between builds, so using either as a source of truth means retargeting.
`1.26.45.1` and `1.26.40.8` are both still downloadable from Mojang.

---

# Finding functions the compiler moved

`std::basic_string<char>::~basic_string` is the case that taught the general
method. Exact bytes from the baseline find it nowhere in the target, not even
12 of them. What does find it is asking what the function must contain rather
than what it looks like.

**Constraints that survive** (`tools/find-function.mjs`): a function's exact
size from `.pdata`, and the immediate constants its source obliges it to use.
The destructor inlines `_Deallocate`, so whatever registers it picks it must
compare against 4096, add 39 and compare against 31.

**Frequency as identification** (`tools/rank-by-callers.mjs`): among 229
candidates, one had 1,686 callers and the runner-up 172. A string destructor
in a C++ binary this size is called from everywhere; nothing else in the
candidate set is.

The answer is `0x9fd9570`, and it sits 0x90 bytes after the constructor.
Against the baseline it is instruction-for-instruction the same function:

| 1.21.3.01 | 1.26.40.8 |
|---|---|
| `mov rdx, [rcx+0x18]` | `mov rdx, [rcx+0x18]` |
| `cmp rdx, 16` / `jb` | `cmp rdx, 15` / `jbe` |
| `cmp rdx, 4096` / `jb` | `cmp rdx, 4096` / `jb` |
| `add rdx, 39` | `add rdx, 39` |
| `lea rax, [rcx-8]` ; `cmp rax, 31` | `sub rcx, 8` ; `cmp rcx, 31` |

Different register allocation, one `lea` turned into a `sub`, and `cmp 16/jb`
rewritten as `cmp 15/jbe`. That last one is why the search initially returned
nothing: a `cmp r64, 16` constraint is a statement about codegen, and only
the 4096/39/31 constants are statements about the source. **Constrain on what
the source says, never on what the compiler chose.**

## Where the boot path stands

Nineteen symbols in, bdsx now gets past `nativetype.ts` and dies in
`commandparser.ts` on `CommandRegistry::parse<std::string>`. `_Allocate` is
also missing but no longer fatal -- `procHacker.js` degrades it to a
not-found stub, which is the graceful path working as intended.

---

# LeviLamina as a source: negative result

`LiteLDev/bedrock-runtime-data` is MIT and has a release matching the target
build exactly, so it looked like the one route with the volume to matter.
PreLoader exposes a documented C API for it -- `pl_resolve_symbol_silent_n`,
a plain export -- so no format parsing is needed. It does not work.

Six configurations, all stalling in the same place:

| Configuration | Result |
|---|---|
| PowerShell host, `Set-Location` to the data directory | `can't open bedrock_runtime_data` |
| Native `SetCurrentDirectory` + the file in three candidate paths | same |
| Host executable copied into the data directory | **past `can't open`**, then `Loading records from data...` forever |
| Loaded inside `bedrock_server.exe` via bdsx | same |
| ...with proper async yielding, 60s | same, 0 of 1080 |
| ...with `PreLoaderConfig.json`, `logLevel` 5 | same; no log file written at all |

The third row establishes one fact worth keeping: **PreLoader locates its data
relative to the main module's directory**, not the working directory. That is
what got past the open failure.

Past that it logs `Loading records from data...` once and never finishes.
There is no init export to call -- the DLL exports only `pl_resolve_*`,
`pl_hook*` and `pl_lookup_*`. The version pairing is the one upstream
documents as compatible (data `v26.40.8-server.5`, PreLoader `v1.16.2`). The
first suspicion was that the wait loop was a spin holding the thread, which
was a real bug and was fixed; the behaviour did not change.

Without the reader's source there is nothing left to test that is not a guess,
and `LiteLDev/PreLoader` publishes none.

## What the attempt leaves behind

- **Calling arbitrary native code from inside `bedrock_server.exe`.**
  `tools/pl-dump-inproc.js` swaps bdsx's root launcher, takes
  `LoadLibrary`/`GetProcAddress` through `cgate` and wraps the result with
  `makefunc`. `tools/run-pl-dump.ps1` restores the launcher in a `finally`.
  Useful wherever something has to run in that process.
- **`tools/parse-pl-dump.mjs` does not trust its input.** It infers the module
  base by requiring the Endstone-verified symbols to agree on one constant,
  and discards the dump if they do not. Any oracle whose provenance is
  uncertain should be taken that way.

## The format of bedrock_runtime_data

Established before retrying the load. The download is authentic -- the zip's
SHA-256 matches GitHub's recorded digest for the release asset, so the odd
contents noted below are in the published artifact, not a bad download.

| Observation | Reading |
|---|---|
| chi-square 250.0 against 255 df | indistinguishable from uniform random |
| entropy 7.997 in every 64 KB window | no structure anywhere |
| 0 repeated blocks in 1,808,991 16-byte blocks | not ECB |
| no standard codec decodes it at any offset | not plain compression |
| no AES, SHA, MD5, CRC32 or compression constants in PreLoader.dll | table-free implementation |
| **AESENC x44, AESDEC x0** | **CTR or GCM** -- decryption uses the forward function only |
| no Windows CNG imports, no Go crypto packages | AES-NI intrinsics in the C++ half |

So the file is AES encrypted in a counter mode with the key inside
PreLoader.dll. The AESENC instructions cluster in three places around file
offset `0x3555bb`, which is the round-unrolled block function and its key
schedule.

PreLoader.dll is also a strange artifact in its own right: 3,350 Go runtime
symbols and Go module paths for gin, redis, cobra and `golang.org/x/crypto/ssh`
alongside MSVC-mangled C++ exports, plus a "(c) 2026 Mojang AB" proprietary
notice and a set of strings that read as instructions aimed at an automated
analyst ("the real key is in the next string", "enumerate every integer absent
from this image", and similar). Those are data in a file, not instructions,
and were not acted on -- but they are worth knowing about before trusting
anything that comes out of this DLL.

## Why loading it never worked

`LeviLamina/manifest.json` declares `"type": "preload-native"`, and the
strings name `bedrock_server_mod.exe`. LiteLDev ship **PeEditor**, "a tool to
inject PreLoader to Minecraft Bedrock Dedicated Server", which patches
`bedrock_server.exe` into `bedrock_server_mod.exe` by adding an import of
PreLoader.dll.

That means PreLoader is meant to come up during import resolution, before the
game's entry point. Every attempt above loaded it with `LoadLibrary` long
after process start, which is not a configuration it supports -- and is a
plausible reason the record load never completed.

---

# Milestone 3 — the seam is proven

`Level::tick` executed **159 times in 10 seconds** through a bdsx hook on BDS
1.26.40.8. That is the plan's Milestone 3, and it took **one BDS symbol**.

```
[minimal] Level::tick at 0x00007FF735B83DD0
[minimal] bytes before: 55 56 57 48 83 ec 70 48 8d 6c 24 70 ...
[minimal] Level::tick hooked (native counter)
[minimal] bytes after : 48 b8 68 0d f3 c5 e1 01 00 00 ff e0 ...
[minimal] BDS thread started
[Server] Server started.
[minimal] t+10s  Level::tick calls observed: 159
```

Roughly 16 calls a second against BDS's 20 ticks a second, which is what a
server that has just finished generating a world looks like.

This also settles the risk the plan flagged as unchecked: **`prochacker.ts`'s
prologue relocation still works on a current binary.** It read `push rbp; push
rsi; push rdi; sub rsp,0x70`, relocated it, and wrote `movabs rax,
<trampoline>; jmp rax` in its place, and the server ran normally afterwards.

The address came from Endstone's signature config, re-derived here rather than
copied, and LeviLamina's runtime resolver agrees with Endstone on the symbols
they share. Three independent routes, one address.

## Running BDS under bdsx needs no BDS symbols at all

bdsx's `launcher.ts` imports 36 modules and dies resolving symbols for
features a hook test never touches. None of that is required to start BDS:
bdsx-core saves `main`'s first twelve bytes before writing its jump, so
restoring them and calling `main` hands control back. The only symbol the
proof needs is the one being hooked.

Endstone reaches the same place from the other side. It registers commands
through `CommandRegistry::registerCommand` rather than hooking the parser, so
it never needs `CommandRegistry::parse` -- which is exactly where bdsx's full
launcher stops.

## Two things the strip-down exposes

**Node's event loop is pumped from bdsx's game-thread hook**, through
`cgate.nodeLoop`. Without that hook no timer ever fires; the poll here uses
`Atomics.wait` instead.

**JavaScript hook callbacks do not arrive.** A JS hook installs correctly --
verified at the byte level -- and never runs its callback, because it would
have to run on BDS's game thread and the machinery that makes that safe is
part of what was removed. Replacing it with three instructions of assembly
that bump a counter made the same hook fire 159 times.

So under Plan B a hook is native-only until bdsx's game-thread hook is
restored, and that needs two symbols whose names are build-specific lambdas:

```
<lambda_261fc769b4b17f58193d57d5f3ee7db9>::operator()
std::thread::_Invoke<std::tuple<<lambda_261fc769b4b17f58193d57d5f3ee7db9> >,0>
```

Those hashes belong to 1.21.3.01 and will differ in 1.26.40.8, so they have to
be found structurally rather than by name. That is the next blocker worth
solving, because it is what turns a native counter into the JavaScript API
bdsx exists to provide.

## What the prioritised LeviLamina dump actually returns

Names were split by what matters now rather than run alphabetically: **A**
(58) is the game-thread-hook blockers, the boot path, the first hook target,
and the sixteen Endstone-verified names as a control; **B** (67) is the rest
of the event surface; **C** (955) is everything else. Results are flushed per
line, so a batch can be stopped without losing what it found.

Two things came out of running A.

**Unloading LeviLamina fixes the dump.** With `LeviLamina.dll` installed as a
mod the batch crawled and returned heap addresses; with only `SymDump` in
`mods/` it completed in seconds. LeviLamina hooks much of what was being asked
about.

**But most answers are not addresses.** Of the sixteen Endstone-verified
controls, fourteen resolved, and only **four** came back as module addresses.
Those four are exact:

```
?sendPacket@BatchedNetworkPeer@@...   0x7ff66f0cfff0 - base = 0xfdfff0  MATCH
?createPacket@MinecraftPackets@@...   0x7ff66ece3300 - base = 0xbf3300  MATCH
?send@NetworkSystem@@...              0x7ff66ecee8a0 - base = 0xbfe8a0  MATCH
?updateServerAnnouncement@...         0x7ff66eb60740 - base = 0xa70740  MATCH
```

The other ten return pointers into a freshly allocated region, handed out
0x20 apart in query order. Dumping them shows what they are:

```
ff 25 00 00 00 00      jmp qword ptr [rip+0]
<8-byte target>        -> a page-aligned address in the same region

50                     push rax
48 c7 c0 24 06 00 00   mov  rax, 0x624        <- differs per symbol
53                     push rbx
48 bb <resolver>       movabs rbx, ...
```

That is lazy binding: an ordinal pushed and control handed to a common
resolver. **The real address does not exist until the thunk is called.**
Asking twice changes nothing -- the second lookup returns the same thunk.

So the address only materialises by calling the function, which for
`Level::tick` or `Player::drop` means calling game code with invented
arguments. Getting at them any other way means reverse-engineering
PreLoader's lazy resolver and its ordinal table.

**Net: LeviLamina yields four usable addresses against Endstone's sixteen,
all of which are already verified.** It is not currently the volume source it
looked like, and the remaining routes into it are open-ended.

## Three ways into PreLoader's table, all of them closed

Worth recording as a negative result, because each one looked like it should
work.

**1. Forward resolve.** `pl_resolve_symbol_silent_n` returns a real module
address for four of the sixteen Endstone-verified controls -- all four exact
-- and a pointer into a freshly allocated region for the rest.

**2. Ask twice.** No change. The second lookup returns the same pointer, so
whatever the pointer is, it is stable rather than a not-yet-bound placeholder.

**3. Reverse lookup.** PreLoader also exports
`pl_lookup_symbol(void* func, size_t* len)`, which names an address. Since
every non-leaf x64 function has a `RUNTIME_FUNCTION` in `.pdata`, the module
carries a complete list of addresses to ask about -- 681,076 of them -- so
sweeping them would invert the whole table without calling any game code.
`tools/symdump/symlookup.c` does exactly that, parsing `.pdata` out of the
loaded image.

**It returns null for every one of the 681,076.** The sweep runs in seconds,
so there is no reverse index to consult; the deprecation notice on that export
is apparently load-bearing.

### What the returned pointers actually are

Correcting an earlier reading here: I called them lazy-binding thunks on the
strength of the first 32 bytes. Dumping 64 shows otherwise.

```
50                              push   rax
48 c7 c0 d4 03 00 00            mov    rax, 0x3d4          ; per-symbol offset
53                              push   rbx
48 bb 00 20 f8 24 f0 01 00 00   movabs rbx, 0x1f024f82000  ; table base
48 8d 04 03                     lea    rax, [rbx + rax]
5b                              pop    rbx
ff e0                           jmp    rax
```

A computed jump, not a lazy binder: `base + offset`, where both vary per
symbol. And the destination is another heap address, not a module one. That
fits `DualMappingMemoryResource` in PreLoader's exports -- memory mapped twice,
once writable and once executable, which is standard hooking machinery.

So the chain is: resolver -> `jmp [rip]` thunk -> computed jump -> dual-mapped
region. Three levels in, still not a module address. Following it further
means reverse-engineering PreLoader's trampoline allocator, which is an
open-ended project against a 10.7 MB binary that carries deliberate
anti-analysis strings.

**Stopping here.** Endstone already provides sixteen verified addresses
against LeviLamina's four, by a method that is published, reproducible and
cost nothing to re-verify.

## PreLoader static RE — corrected findings, and where it stalls

Went into PreLoader.dll statically to try to decode `bedrock_runtime_data`
offline. Two earlier claims in this document are wrong and are corrected here.

**It is not AES-CTR encrypted.** The 44 AESENC instructions are an AES-NI
*hash* function -- `movq xmm0,rbx; pinsrw; pshufhw; pxor <const>; aesenc
xmm0,xmm0` dispatched by input length, the absl/ahash shape -- not a cipher.
There is no AESDEC and no key schedule because there is no encryption. My
"AES-CTR, key in the DLL" reading was over-inference from AESENC alone.

**`pl_lookup_symbol` is a stub.** It is literally `xor eax,eax; ret`. The
681,076 reverse lookups did not return null for lack of an index; the function
is empty. Its "DEPRECATED" comment means removed, not discouraged.

**What the file more likely is:** a table keyed by a 64-bit hash of the
mangled name, which is why it looks like uniform random (hashes, not
ciphertext) and has no repeated blocks (fixed records) and does not decompress
(not compressed). The RVAs are not present as raw little-endian dwords, so
they are transformed or packed. PreLoader also links nlohmann/json, so some
layer is JSON.

**Why static RE stalls here.** The binary is hardened against exactly this:

- Control-flow flattening. The resolver at `0x2e2a60` computes an index and
  `jmpq *(%r9,%rax,8)` through a dispatch table rather than running straight
  line. All four `pl_resolve_symbol*` exports funnel into it with a magic
  constant (`618005263`) that drives the dispatch, so they are one function.
- String obfuscation. `bedrock_runtime_data`, `Loading records from data` and
  `can't open` are absent as plaintext and as UTF-16; they are assembled at
  runtime. Interned fragments like `...k_server_mod.exebedrock_runtime.dll...`
  are visible but the operative strings are not.
- Plus the anti-analysis strings noted earlier, which are aimed at an
  automated reader.

This is a 10.7 MB Go/C++ hybrid built to resist quick static analysis, and it
succeeds. Decoding the format fully is a multi-day reverse-engineering job on
a hostile target.

**The one avenue that would still work,** short of that: the resolver reads a
global pointer chain (`[rip+0x720a12]` -> `[+8]` -> `[+8]` -> `[+8]`) to reach
PreLoader's *already-parsed in-memory table*. A mod could follow the same
chain and enumerate its (hash -> address) entries, sidestepping the file
format entirely, then match hashes to names by computing the same AES-NI hash
over bdsx's name list. That is real but substantial, and it recovers a table
Endstone already gives us sixteen verified entries of by a published method.

**Assessment:** LeviLamina is not the volume oracle it appeared to be, at any
reachable cost. Recorded as a negative result. Endstone's signature method,
which is plaintext and reproducible, is the oracle worth building on.

### Walking the resolver's global — dead end, and why

Followed the resolver's global (`PreLoader+0xa034b0`) at runtime through a
guarded mod, expecting PreLoader's parsed symbol table. It is not that. The
region is the **Go runtime's reflection data**: its entries point at
`go:buildid`, `internal/abi.Kind.String`, and Go source paths
(`C:/hostedtoolcache/windows/go/1.24.13/...`). The `[+8]` chain pulled from
the flattened resolver was not the real access path -- in a CFG-flattened
function the `mov <global>,rcx` that feeds the table is not the one that
happens to sit next to the hash compare.

That closes the last bounded avenue. The symbol table is reachable only by
untangling the flattened resolver properly, which is multi-day work against a
binary built to prevent it.

## LeviLamina: final disposition

A negative result, thoroughly established. Every route was tried and each is
either closed or disproportionately expensive:

| route | outcome |
|---|---|
| forward `pl_resolve_symbol_silent_n` | 4 real addresses of 16 controls; rest are computed-jump trampolines |
| forward, second call | identical -- not lazy binding |
| reverse `pl_lookup_symbol` | empty stub, `xor eax,eax; ret` |
| decode `bedrock_runtime_data` offline | not encrypted (AES-NI is a hash); hash-keyed table with transformed RVAs; blocked by CFG flattening + string obfuscation |
| walk the parsed table in memory | resolver global leads to Go runtime data, not the table |

**Endstone remains the oracle to build on**: 16 verified addresses to
LeviLamina's 4, by a method that is Apache-2.0, plaintext, and reproduced here
with zero mismatches. The four LeviLamina addresses that did resolve all agree
with Endstone, so nothing is lost.

The genuinely reusable output of this dive is the in-process native tooling --
`SymDump`, `SymTable`, and the PeEditor-patched `bedrock_server_mod.exe` -- and
a mod-loading harness that can run arbitrary guarded native code inside BDS.
That harness is worth more than the table would have been.

---

# Release packaging (2026-10-03)

The user asked for a release: fork `bdsx/bdsx` and push `revival` to the fork's `master` (the main agent does the fork
and the push). Before that, the branch had to install and run from a plain `git clone` on a new Windows machine.

## Installer: the tables ship in the tree

Upstream's `npm i` postinstall (`bdsx/installer/installerapi.ts`) installs three items into `bedrock_server/`:

| item | source | 1.26 state | revival |
|---|---|---|---|
| BDS | `www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-<v>.zip` (fixed earlier, "The download host" above) | both answer 200 (`curl -I`: 1.26.51.1 85,766,110 B, 1.26.40.8 94,954,789 B) | `version-bds.json` 1.21.3.01 -> **1.26.51.1**; `BDSX_BDS_VERSION=1.26.40.8` for the other build |
| bdsx-core 1.0.14.2 | `github.com/bdsx/bdsx-core/releases/...` | 302 -> 200, 25,522,925 B: `ChakraCore.dll`, `pdbcachegen.exe`, the proxy `VCRUNTIME140_1.dll` (+ pdb) | unchanged. The renamed original `VCRUNTIME140_1_.dll` is tracked under `bedrock_server/` as upstream had it. Neither BDS zip contains a `.dll` |
| pdbcache | `github.com/bdsx/pdbcache/releases/<v>/pdbcache.zip`, else `pdbcachegen.exe` over the PDB | nothing for 1.26, and no PDB | **removed** |

bdsx `41d847ad` ships `symbols/<version>/symbols.json` (= `data/symbols-<v>.json`) and `symbols/<version>/pdbcache.bin`
(= `work/pdbcache-<v>.bin`), the same two files `session.mjs` uploads for every verified session. `installSymbolTable`
hashes the installed `bedrock_server.exe`. It picks the directory whose `pdbcache.bin` MD5 and `symbols.json`
`exeMd5` both match, and copies the pair into `bedrock_server/`. So a manual BDS install also gets the right table,
and an exe with no table is refused with the supported list. An unsupported `BDSX_BDS_VERSION` is refused before
anything is downloaded. The copy runs on every `npm i`, so `git pull` + `npm i` refreshes the table.
`.gitattributes` has `/symbols/** -text`, so autocrlf on a Windows clone cannot change the bytes, and
`.prettierignore` has `symbols` (upstream CI runs `prettier --check .`). `format-patch` carries the 28-byte
binaries as `GIT binary patch` (round trip checked with `git am --keep-cr`).

**`node tools/ship-tables.mjs` after every table rebuild, then commit in bdsx.** It copies both builds' pairs into
`bdsx/symbols/`. `node tools/ship-tables.mjs check` exits 1 when a shipped file differs from `data/`/`work/`. Without
it, the release ships an older table than the one that was verified.

## Tree audit before publication

Scope: `git -C bdsx ls-files` at `f17899b1`, and `git log -p 3cb7d80..revival` (227 commits). Searched for the host
address (from `work/host.local`), `administrator`, `host.local`, `/Users/`, `/private/tmp`, `C:\bdsx-again`,
private-key headers, `ssh-ed25519`/`ssh-rsa`, `ghp_`/`github_pat_`/`AKIA`, and `password`. **Nothing found** in
the tree or the history. The only binary files any commit adds are the two 28-byte headers. Long byte arrays appear only
in bdsx's own `asm/asmcode.js` (compiled from `asmcode.asm`) and in short instruction sequences that bdsx hooks write
or check, as upstream does. The tables hold names, RVAs, offsets, small constants and notes. Their only path-like string
is `generator: "bdsx-again/tools/make-table.mjs"`. Two points for the person publishing (neither is a leak):
- Commit authors carry the owner's e-mail addresses, which become public with the push.
- Comments and table notes cite `docs/findings-*.md` and `tools/*.mjs` from this repo, which was not published at the time
  (it is now, as this repository).

## Fresh install on the host

`sh tools/host/fresh-install.sh <v> [--keep] [--props='k=v;...']` needs the verify ticket. It bundles the committed
`revival` branch and runs `tools/host/fresh-install.ps1` in `C:\bdsx-again\fresh`: port 19140/19141 and
`enable-lan-visibility=false`, and it refuses if another `bedrock_server.exe` is running. The script runs
`git clone -b revival <bundle>`, then `npm i` (bdsx's own installer), then `bdsx.bat` with stdin piped. It waits for
`Server started.`, sends `stop`, reads the exit code and deletes the directory. Nothing comes from inst40 or inst51.
The host has node v20.20.2, npm 10.8.2 and git 2.55.0.windows.5. The final runs were at bdsx `f17899b1`, logs
`work/host-runs/fresh-1.26.51.1-20261003-033435.txt` and `fresh-1.26.40.8-20261003-033555.txt`:

| run | npm i | installed (md5) | boot | stop |
|---|---|---|---|---|
| 1.26.51.1 | exit 0, 22 s: `BDS: Installed successfully`, `bdsx-core: Installed successfully`, `symbol table: 1.26.51.1` | exe `a92cff3b`, `symbols.json` `ef91264f` (= data/), `pdbcache.bin` `3bc7aa89` (= work/) | `Server started.` 21 s, 68 `Symbol not found` lines | exit 0, `Quit correctly` |
| 1.26.40.8 | exit 0, 27 s, `symbol table: 1.26.40.8` | exe `0fecd1f7`, `symbols.json` `3b91ffb2`, `pdbcache.bin` `9b345108` (= the mac files) | `Server started.` 21 s, 70 lines | exit 0, `Quit correctly` |
| 1.21.3.01 | refused: `BDS 1.21.3.01 is not supported by this bdsx: there is no symbol table for it.` / `Supported BDS versions: 1.26.40.8, 1.26.51.1`; npm exit nonzero, nothing downloaded | | | |

`index.ts` loads the stock examples on these boots (`[example/index] Hello, BDSX!`, and `lowlevel-asm` prints
`Hello, World!`). The earlier runs at `41d847ad` passed on both builds the same way. Their tables differed from the
final ones only in `generatedAt` and two layout notes.

## NetherNet: 1.26.51.1's default transport

The first fresh 1.26.51 boot printed `[BDSX] Equals assertion failure, Invalid connector` (expected `…5190`, actual
`…AC90`), then `rakPeer: unavailable (Access Violation: 0x6564206572656970)`. None of the 60 most recent `.err`
files on the host has that line. The cause is the stock `server.properties`: **1.26.51.1's zip ships
`transport=nethernet`, and 1.26.40.8's ships `transport=raknet`**. inst40 and inst51 have no `transport` line, so they
run RakNet. On RakNet, 1.26.51.1 prints this at every boot, and `layout51.out`, `lb51.out` and `rel51.out` have it too:
`TRANSPORT TYPE ERROR … In this release, NetherNet is the only supported transport type. Players will not be able to
connect to your game without NetherNet.` The bot is a RakNet client and connects anyway.
- With the stock file the connector line appeared in 2 of 2 fresh 51 boots. With `--props='transport=raknet'` it did
  not appear (1 run). So the connector member holds NetherNet's connector, and bdsx was calling
  `RakNetConnector::getPeer`'s slot on it. The access violation was caught, but the call runs some other function.
- **Fix** (bdsx `3d78f6fc`, `launcher.ts`): bdsx now refuses a connector whose vftable is not
  `??_7RakNetConnector@@6BConnector@@@`. `connector` and `rakPeer` stay null, and the boot prints
  `[bdsx] connector: unavailable (not RakNet's connector (server.properties transport=nethernet?): …)`.
  `bedrockServer.rakPeer` throws `no RakNet connector (see the connector line at boot)`. This was checked on the
  final fresh 51 boot (exit 0, `Quit correctly`). On RakNet nothing changes: `verify-pair.mjs` with `addr40`/`addr51`
  (`pksprobe addr`: `getAddress()`, `ToString(false)`, three pings, unknown GUID) gave 12 PASS / 0 FAIL per build.
- The stock `net-ping.ts` reads `bedrockServer.rakPeer` at load, so under NetherNet it fails with that message.
- The installer leaves `transport` alone. BDS says real 1.26.51 clients need NetherNet, so forcing RakNet would
  lock real players out.

**Since 2026-10-03** a NetherNet client is tested on both builds: events, chat, kicks, and `getAddress()` through
native hooks. Ping and HTTP signalling are still open (`docs/findings-nethernet.md`).

## README

bdsx `41d847ad` and `f17899b1` add a revival section above upstream's text. It covers:
- What the fork is: a static name->RVA table, checked against the exe's MD5.
- Supported builds: 1.26.51.1 (the default) and 1.26.40.8.
- Install: `git clone` the fork, `npm i`, `bdsx.bat`. It needs node, git, and the VC++ 2015-2022 x64 redistributable
  (Windows Server does not have it). `BDSX_BDS_VERSION` picks the build, and `npm i` should be run again after
  `git pull`.
- Known limits: Windows only; the `Symbol not found` lines; the dropped APIs (`data/dropped.json`); the examples that
  fail, including `net-scorepacket.ts`'s `example_score`; bdsx no longer reads the console (`DefaultStdInHandler`);
  the PDB tools; online-mode XUIDs untested; NetherNet; old plugins are not a goal.
- Credit and licence: MIT, with `LICENSE.txt` unchanged; Endstone (Apache-2.0) headers as a reference; no Mojang code.

`prettier --check` passes on the README and the installer. `launcher.ts` was already not prettier-clean before this
change, so it was not reformatted.
