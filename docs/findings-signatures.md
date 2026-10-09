# Signature matching: what Endstone actually does, and what it costs

Measured 2026-09-16, while the 1.26.40.8 BinExport was running.

## The question

`tools/auto-signature-match.mjs` generated one wildcard signature per baseline
function and recovered **2 symbols of 696**. Endstone resolves 61 symbols by
hand-written wildcard signatures and gets them all. The gap had to be
explained before deciding whether the technique is worth building on.

## Endstone's signatures are short

| | Endstone, hand-written | auto-generated |
|---|---|---|
| pattern length, median | **44 bytes** | whole function body (up to 2048) |
| fixed (non-`?`) bytes, median | 28 | hundreds to thousands |
| shortest | 10 bytes / 6 fixed | — |

Requiring an entire function body to match fails on essentially every function,
because a rebuild perturbs *something* almost everywhere. A 44-byte window
inside an untouched basic block could survive. That was the hypothesis.

## It is not the length. There is no surviving window at any length.

`tools/window-signature-match.mjs` slides a window across each baseline
function, keeps only windows that are unique within the baseline binary, and
matches each independently, then votes: windows cut from one baseline function
must land in one target function (found via the target's `.pdata`), so a window
that strays disagrees with its siblings and loses.

Against the 19-symbol ground truth, 1.21.3.01 → 1.26.40.8:

- 1,127 windows across 15 game functions were unique in the baseline
- **0 of them matched anywhere in the target**
- the one success, `vsnprintf`, is CRT code, not game code

Sweeping the window length, searching only inside the *known correct* target
function so a miss cannot be a lookup failure:

| window | 8B | 12B | 16B | 24B | 32B | 48B |
|---|---|---|---|---|---|---|
| game functions | 0–7% | 0–4% | 0–1% | **0%** | **0%** | **0%** |
| `vsnprintf` | 100% | 100% | 100% | 100% | 100% | 100% |

Then, to rule out masking being too timid — wildcarding *every* numeric operand,
leaving only opcodes and registers, and separately comparing mnemonic sequences
with operands ignored entirely:

| | aggressive mask, 24B | aggressive mask, 48B | 12 mnemonics | 20 mnemonics |
|---|---|---|---|---|
| game functions | **0%** | **0%** | **0%** | **0%** |
| `vsnprintf` | 100% | 100% | 100% | 100% |

Corresponding functions do not share twelve consecutive instructions even when
operands are ignored. The generated code is not perturbed, it is different.

`ItemStackBase::_setItem` is the clearest control: 682 bytes in the baseline,
674 in the target, and different from the first instruction.

```
1.21.3.01 @0x1b54020            1.26.40.8 @0x1bc1f70
  mov  [rsp+24], rbx              push rbp / rsi / rdi / rbx
  push rbp / rsi / rdi            sub  rsp, 72
  sub  rsp, 80                    lea  rbp, [rsp+64]
  mov  rax, [rip+...]             mov  qword [rbp], -2      <- EH state marker
  xor  rax, rsp                   ...
  mov  [rsp+72], rax   <- cookie  mov  eax, [rip+...]
  ...                             mov  rcx, gs:[88]         <- TLS
                                  mov  rax, [rcx+rax*8]
                                  cmp  byte [rax+8], 0      <- magic-static guard
```

The target grew a function-local static, so it reaches into thread-local
storage on entry; the stack cookie and EH frame placement also differ. Nothing
is shared to match on.

## Hand-written signatures do survive — for about one version

Endstone's 1.26.44 signatures, scanned against every build on hand
(`tools/sigscan.mjs`, Endstone's own resolution semantics):

| target | unique | not found | ambiguous |
|---|---|---|---|
| 1.26.40, 1.26.40.8 (1 step) | **58 / 61** | 0 | 3 |
| 1.26.36, 1.26.30 (2–3 steps) | 45 | 12 | 4 |
| 1.26.51.1 (forward) | 38 | 19 | 4 |
| 1.26.20 (pre-lld) | 22 | 36 | 3 |

So a hand-written signature is good for roughly one version step at 95%, and
decays from there. This is a maintenance cost, not a solution: every BDS
release needs the broken ones re-authored.

## Why the hand-written ones work: the anchor is a string, not a byte pattern

Reading the comments Endstone ships with each signature, every one begins the
same way. From `?getI18n@@YAAEAVI18n@@XZ`:

1. find the bytes of `"commands.give.success\0"` — unique
2. its lone data xref is inside `GiveCommand::execute`
3. inside that, find `mov rcx, 'item.air'` — the SSO literal being built for
   `getI18n().get("item.air.name", ...)`; the `call getI18n` sits 0x2d above
4. confirm the decoded target by the marker strings in its call closure
   (`"pack.description"`, `"pack.name"`, the locale table)

The byte pattern is the last step, not the anchor. And the same entry carries a
warning that names exactly the failure mode measured above:

> never by pattern shape, size or alignment, which all silently agreed with the
> wrong address.

String literals come from the source, so they survive code generation changes.

## String anchoring, automated

`tools/string-anchor-match.mjs` maps each function to the set of unique string
literals it references — via RIP-relative disp32 whose target is exactly the
first byte of a literal occurring once in the image — and matches the sets
across builds. Matches must be mutual (BinDiff's rule): the target's own best
baseline function must be the one claiming it.

Mutual-best mattered. Without it, `MobEffectInstance::load` and `::save` both
claimed 0x2c80600, sharing their NBT tag literals; at most one can be right.
Mutual-best rejects both.

1.21.3.01 → 1.26.40.8, over bdsx's 1,065 baseline symbols:

```
COMDAT-folded         46
no string reference  948     <- the real ceiling
probed                71
  resolved             7
```

Of the 7, two overlap the ground truth and **both are correct**. The other five
are new candidates, recorded in `data/candidates-string-anchor-1.26.40.8.json`
and not promoted into the resolved table without independent confirmation.

### Seeds are anonymous, and most "string-carrying" functions carry nothing

Two things have to be said plainly about the numbers below, because the first
version of this document got both wrong.

**A seed is an RVA-to-RVA pair, not a symbol.** Matching two builds by their
literals says "this function here is that function there" and nothing about
what either one is called. Names exist in exactly two places: the 1.21.3.01
table recovered from the last PDB-bearing build, and Endstone's. A seed between
two unnamed builds is a carrier — it moves names from a version that has them
to one that does not — and on its own resolves nothing.

**"61,128 functions reference a unique literal" is almost entirely an
artifact.** `operator new` is inlined into 50,656 functions and drags its four
assert literals in with it:

```
  50656  "We failed to allocate %zu bytes."
  50656  "pointer || size == 0"
  50656  "D:\a\_work\1\s\src/base/Core/src/Memory/MemoryOperators.cpp"
  50617  "void *operator new(size_t)"
```

A literal in fifty thousand functions anchors nothing, which is what `MAX_REF`
exists to discard. After discarding, the set of functions carrying a usable
anchor is far smaller, and the ones carrying the two that a match requires
smaller still:

| | >=1 usable anchor | >=2 (the seed ceiling) |
|---|---|---|
| 1.26.40.8 | 14,206 | **5,533** |
| 1.21.3.01 | 11,873 | **4,271** |

### Decay, measured against that ceiling

Comparing 1.26.40.8 **to itself** yields 4,847 seeds against a ceiling of
5,533 — 88%. The missing 12% is the margin and mutual-best rules refusing to
call a tie, so 88% is the practical maximum, not 100%. Every hop is worth
reading as a fraction of it. (`work/bin/1.26.40` and `1.26.40.8` are the same
file, md5 `0fecd1f7`, as are `1.26.10` and `1.26.10.4`; the first version of
this table listed that self-comparison as though it were a hop.)

| hop | seeds | ceiling | of ceiling |
|---|---|---|---|
| 1.26.40.8 → itself | 4,847 | 5,533 | **88%** |
| 1.26.30 → 1.26.36 | 4,783 | 5,414 | 88% |
| 1.26.40.8 → 1.26.51.1 | 4,676 | 5,533 | 85% |
| 1.21.132 → 1.26.0 | 4,754 | 5,826 | 82% |
| 1.26.36 → 1.26.40.8 | 4,408 | 5,414 | 81% |
| 1.26.20 → 1.26.30 | 3,652 | 5,212 | 70% |
| 1.26.10 → 1.26.20 (lld) | 3,401 | 5,212 | 65% |
| **1.21.3.01 → 1.26.40.8** | 1,826 | 4,271 | **43%** |

So it does decay — the earlier claim that it does not was an artifact of every
adjacent pair sitting against the ceiling, where no difference can show. What
is true, and is the point, is that an adjacent-version hop is indistinguishable
from comparing a binary to itself, and that 43% still survives the five-version
wall that closes every byte technique completely.

## How far the anchors reach

Only 6.7% of bdsx's symbols reference a unique string themselves. Endstone
navigates outward from the anchor along call edges, so the reachable set is
what matters. Undirected BFS over the baseline call graph
(`tools/callgraph.mjs`, 659,505 call sites) from the 15,540 string-carrying
functions:

| distance | symbols | cumulative |
|---|---|---|
| 0 hops | 71 | 6.7% |
| 1 hop | 318 | 36.5% |
| 2 hops | 197 | **55.0%** |
| 3–4 hops | 28 | 57.7% |
| unreachable within 4 | 451 | — |

**~58% of bdsx's symbol set is the ceiling for string-anchored navigation**, and
that assumes every hop is unambiguous, which Endstone's own twenty-line
cross-check comments show it is not.

## Import anchoring does not generalise

`tools/find-gamethread.mjs` found the game-thread hook by walking an *import* --
`_Cnd_do_broadcast_at_thread_exit`, named exactly in the import directory --
where no signature and no string could reach it. That is the same "named in the
file, not inferred from code" property strings have, so it was worth asking
whether it scales. `tools/imports.mjs` recovers each function's imports the way
that tool does: import directory to IAT slot, slot to its `jmp [rip+slot]`
thunk, thunk to the `E8`/`E9` calls reaching it, plus `FF 15` calls straight
through the IAT.

It does not scale. 1.21.3.01 imports 610 functions, and 33,911 functions call
at least one -- about 56 callers per import, so a single import is not an
anchor. Filtering to imports called by at most 8 functions leaves 427 rare
ones, but they are called by CRT and infrastructure code, not by the game
classes bdsx hooks:

| | count |
|---|---|
| bdsx symbols calling any import directly | 144 of 1,065 (13.5%) |
| ...calling a **rare** import (<=8 callers) | **11** |
| ...calling two | 3 |

And as an anchor set to navigate from, imports are almost entirely redundant
with strings — the same functions are reachable either way:

| seed | 0 hops | <=1 | <=2 | <=3 |
|---|---|---|---|---|
| strings (11,873 functions) | 6.1% | 35.8% | 54.5% | 57.6% |
| rare imports (624 functions) | 1.0% | 5.3% | 41.0% | 56.6% |
| **union (12,347)** | 6.8% | 36.0% | **54.8%** | **57.6%** |

Adding imports moves the two-hop figure by 0.3 points and the three-hop figure
by nothing. The 57.6% ceiling is the same one string anchoring alone gives; the
remaining 42% of bdsx's symbols sit in a region of the call graph with no named
anchor within reach at all.

So the game-thread result was not a general method. It worked because
`launcher.ts` records the exact bytes it patches, and those bytes name an
import -- a specific structural fact about one hook, not a technique that
finds arbitrary symbols. Applying it needs that kind of fact each time, which
is what `docs/findings-gamethread.md` demonstrates and what Endstone's
per-signature comments are.

## Conclusions

- Byte, wildcard and mnemonic matching are closed across a real version gap.
  Not hard: closed. This supersedes the "auto signatures: 2 of 696" entry in
  `docs/next-steps.md`.
- Hand-written signatures buy one version step. Budget re-authoring per release.
- String anchoring decays gently where every byte technique collapses: an
  adjacent-version hop is indistinguishable from comparing a binary to itself,
  and 43% of the ceiling survives the 1.21 -> 1.26 wall. It is also precise
  (2/2 on ground truth, and its one collision was caught by mutual-best rather
  than shipped).
- It tops out near 58% of the symbol set even with perfect navigation — which
  is far more than Plan B needs, since the game-critical hooks are a few dozen
  and are exactly the string-adjacent kind.
- Imports are exact where strings are exact, but they anchor almost nothing
  extra: the union reaches 57.6% at three hops, the same as strings alone.
  The technique that cracked the game-thread hook is not a bulk method.
