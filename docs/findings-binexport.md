# BinExport on a 172MB .text, and the pass that has to be removed

## What happened

The 1.26.40.8 BinExport ran for **4h45m** and was killed. It was not stuck --
the main thread was at 98% of one core the whole time -- but it had stopped
producing output two hours earlier, and the machine was out of swap.

The baseline 1.21.3.01 exported in **26 minutes** (analysis finished 15:16:02,
output written 15:43:21), so the target was expected to take a few times that.

## Where the time went

A thread dump gives the whole answer:

```
BinExport2Builder.build
  -> BinExport2Builder.promoteUndefinedFunctions
       -> UndefinedFunction.findFunction
            -> UndefinedFunction.getEntryBlock
                 -> SimpleBlockModel.getFirstCodeBlockContaining
                      -> CodeManager.getInstructionContaining
```

and the bytecode of that method gives the loop:

```java
for (CodeBlock block : bbModel.getCodeBlocks(monitor)) {   // every basic block
    if (functionManager.getFunctionContaining(block.getFirstStartAddress()) == null) {
        UndefinedFunction uf = UndefinedFunction.findFunction(program, addr, monitor);
        flatApi.createFunction(uf.getEntryPoint(), uf.getName());   // a database write
    }
}
```

It iterates **all 5,688,413 basic blocks**, and for each one not inside a
defined function it runs a backwards control-flow walk and then writes a new
function to the database. It is the last thing `build()` does, after
instructions, basic blocks and data references are already built -- which is
why every BinExport object count was frozen while the CPU stayed pinned:

| object | at 2h45m | at 4h33m |
|---|---|---|
| `Instruction$Builder` | 38,490,993 | 38,490,993 |
| `BasicBlock$Builder` | 5,688,413 | 5,688,413 |
| `Comment` | 8,325,099 | 8,325,099 |
| `FlowGraph`, `CallGraph` | none | none |

Meanwhile the JVM went from **0 full GCs to 10** (130s of them), heap use
reached 20.2GB of 24GB, process RSS reached 23.1GB on a 48GB machine, and swap
was 5.1GB of 6.1GB with 0.3GB free. Full GC on a partly-swapped 20GB heap costs
13 seconds each, so the run was heading for a thrash-to-OOM rather than a
finish.

## Two estimates, both wrong, and why

Predicting from **function count** (4.39x) gave 1h54m and from **.text size**
(3.79x) gave 1h39m. Both were refuted within the hour.

The second attempt modelled `T = a*I + b*U` with `U` = the 292,042 call targets
that are not function entries (8.07x the baseline's 36,186), and, constrained
by the run already having exceeded it, put the total at 3h05m-4h30m. Also
wrong.

The model was wrong, not its coefficients. The loop is not over undefined call
targets; it is over **every basic block**, and its expensive branch does a
**database write**, not just a read. Writes get slower as the table grows, so
the pass decelerates. No quantity derived from function counts predicts it.

## The fix

The pass is pure loss for this project. `.pdata` lists 681,076 exact function
boundaries and Ghidra has defined every one; function bodies cover 164.7MB of
the 172.6MB `.text`, so what the pass promotes is the remaining 4.6% --
padding, jump tables and data. Turning those into functions adds noise to the
diff rather than signal.

`BinExportExporter` exposes no option for it (only `subtractImagebase`,
`remapMnemonics`, `prependNamespace`), and restricting the exported
`AddressSetView` does not help, because the model is built as
`new BasicBlockModel(program, true)` over the whole program.

So `tools/PatchBinExport.java` replaces the method body with a bare `return`,
using `java.lang.classfile` -- final since JDK 24, so no dependency is needed.
The class keeps all 54 methods, its callers are untouched, and `build()` still
calls it; the call now returns immediately.

```
patched com/google/security/binexport/BinExport2Builder.class: 56,239 -> 55,842 bytes
  private void promoteUndefinedFunctions();
    Code:
         0: return
```

The original is kept beside it as `BinExport.jar.orig`.

## Heap

The re-run uses **20GB**, not 24GB. The 24GB figure is what drove the machine
into swap, and a heap that swaps is worse than a smaller one: the 5.4GB Ghidra
database is read randomly throughout, so it needs to stay in the page cache.
Before the promotion pass began the process was at 16.2GB RSS with zero full
GCs, so 20GB leaves headroom for the flow graph, call graph and serialisation
while leaving ~28GB for the OS.

## The export works; BinDiff 8 could not read it

With the pass removed the export finished in **29 minutes 48 seconds** and
wrote 1,208,945,990 bytes. Against 4h45m incomplete, that is the whole of the
patch's effect.

BinDiff then failed in two seconds:

```
E flow_graph.cc:85] Could not find basic block: 00000001400BD3D0   (7,600 times, 426 addresses)
Error: AttachFlowGraph: flow graph already attached 0000000140001000
```

The obvious reading was that the patch had produced a malformed file. It had
not. **The same failure occurs on the 1.21.3.01 export**, which was written
hours before the patch existed, **diffed against itself**, and **under
`--md_index`**, which does no diffing at all. The break is in BinDiff's reader.
BinDiff 8 is from September 2023 and is the newest release there is; the
extension logs itself as "BinExport 12 (c)2019-2026".

`tools/DumpBinExport.java` reads the file with BinExport's own generated
protobuf classes and the protobuf runtime Ghidra already ships, so the question
is answerable without downloading or building anything:

| | 1.21.3.01 |
|---|---|
| instructions / basic blocks / flow graphs | 10,438,285 / 1,461,584 / 156,666 |
| entry blocks claimed twice | **0** |
| basic-block indices out of range | **0** |
| flow graphs with no entry index | 10 |
| flow-graph edges | 2,067,992 |
| **edges naming a block outside their own flow graph** | **141,408 (6.8%)** |

Basic-block indices are global: 93.2% of edges resolve inside the graph that
owns them and *none* resolve only under a local reading, which settles that the
6.8% are genuinely cross-graph rather than misread. They are tail calls and
shared code that newer BinExport emits and BinDiff 8 rejects.

`tools/FilterBinExport.java` drops exactly those edges and the ten flow graphs
with no entry, and nothing else -- every function, basic block and instruction
survives. On the baseline that is 141,390 edges of 2,067,974, and BinDiff then
reads the file:

```
primary:   157259 functions, 621608 calls
matched:   157200 of 157259
Similarity: 99.172%
```

A self-diff scoring 99.17% rather than 100% is the cost of the dropped edges:
some functions become structurally indistinguishable without them. That is the
price of having a diff at all, and it has to be carried into how the real
result is read -- a few false pairings are expected even between identical
inputs.

## The diff: F2

`bindiff` on the filtered pair, 15m14s:

```
primary:   157259 functions, 621608 calls
secondary: 712739 functions, 1509680 calls
matched:   139414 of 157259
Similarity: 14.9468% (Confidence: 46.8463%)
```

### Precision, which is the only number that matters

Against the 21-symbol table, swept over the confidence threshold:

| conf | resolved | **correct / checkable** | of launcher.ts's 29 | of 82 vftables |
|---|---|---|---|---|
| 0.50 | 438 | **2 / 9** | 9 | 0 |
| 0.70 | 118 | 2 / 5 | 1 | 0 |
| 0.90 | 67 | 2 / 4 | 0 | 0 |
| 0.95 | 25 | 2 / 2 | 0 | 0 |

Per symbol, the result is unambiguous: **every one of the 19 game functions is
wrong, at every threshold.** The only two correct are `vsnprintf` and the
`basic_string` constructor, both at similarity 1.00 -- unchanged CRT code, which
is exactly what whole-function byte matching already resolves.

Confidence does not save it. These are all wrong:

| symbol | similarity | confidence |
|---|---|---|
| `ServerNetworkHandler::updateServerAnnouncement` | 0.54 | **0.94** |
| `basic_string::~basic_string` | 0.89 | **0.92** |
| `NetworkSystem::send` | 0.45 | **0.90** |

A confident wrong address is the failure this project cannot debug, and the gate
that was supposed to prevent it does not.

### A larger sample, and why it looks better than it is

21 symbols is a small sample, so the same comparison against the 1,826
mutual-best string-anchored pairs:

| conf | agree / disagree | agreement |
|---|---|---|
| **0.9+** | 176 / 14 | **92.6%** |
| 0.7+ | 26 / 80 | 24.5% |
| 0.5+ | 4 / 335 | 1.2% |
| <0.5 | 3 / 1046 | 0.3% |

92.6% at high confidence reads like the tool working. It is partly circular:
BinDiff anchors on string references too, so on functions that carry unique
literals both methods are reading the same signal. The unbiased sample is the
21, which are bdsx's actual hook targets and mostly carry no strings, and there
it resolves 2 -- both CRT.

What this does establish, independently, is that the 1,826 string-anchored
seeds are sound: a separate tool agrees with 92.6% of them.

### Verdict

Success required >=19/21 and >=20 of the 29. The result is 2 and 0. This is
**F2** in `docs/plan-bindiff.md`: call-graph structure does not survive this gap
either, and the structural family is closed.

That closes it for the 1.21.3.01 -> 1.26.40.8 gap specifically -- five minor
versions and a linker change. Nothing here says BinDiff would fail on an
adjacent hop; it says it cannot substitute for the PDB the project lost.

The 8.5% of edges dropped to make the file readable is a confound that cannot
be fully removed without a BinDiff that reads BinExport 12. Against it: the
call graph was not touched at all, the self-diff of the filtered baseline still
scores 99.17%, and the failure is total on game code rather than a degradation.
