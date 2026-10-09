# bdsx revival

Reviving [bdsx](https://github.com/bdsx/bdsx) (MIT, archived 2024-11-14), a Node.js modding framework
for the Minecraft Bedrock Dedicated Server, after Mojang stopped shipping `bedrock_server.pdb`: runtime
PDB parsing is replaced by a static, offline-generated `name -> RVA` table. The layout, the seam, the
lab, the rules earned by measurement and the licence discipline are in `docs/HANDOFF.md`.

## Docs to read first (auto-loaded)

The three documents below are read automatically when a session starts (Claude Code's `@` import).
Any other tool or person reads them in this order.

@docs/HANDOFF.md
@docs/next-steps.md
@docs/lab-runbook.md

**Fixed workflow:** work the top item in `docs/next-steps.md`'s task queue -> when done, record it in
the relevant findings doc and in `docs/status.md` (`node tools/status-summary.mjs --write` regenerates
the numbers) -> **move the finished item out of the queue into `docs/completed-task.md` (top of its log)
and leave a concrete next task at the top of the queue** -> if bdsx itself was changed, commit it in the
`bdsx/` submodule and run `node tools/ship-tables.mjs check` -> `node tools/docs-check.mjs` (must exit
0) -> commit -> report to the user.
"Done" means confirmed by running it on both builds with bdsx's own code. Never write something as
confirmed if it was not actually run.

## Keeping the auto-loaded docs small

Every session pays for this file and the three imports before any work starts, so they hold only what
every session needs. `node tools/docs-check.mjs` enforces a byte budget on them and fails on hand-typed
coverage numbers.

- **Numbers live in one place**: the generated block at the top of `docs/status.md`
  (`tools/status-summary.mjs`). Other docs point there.
- **`docs/next-steps.md` holds open items only**, about ten lines each; the story goes to the findings
  doc, and a finished item goes to `docs/completed-task.md`.
- **Big docs are read by section, not whole**: `node tools/docs-check.mjs toc docs/<doc>.md` lists
  headings with line numbers and sizes; then read that range.

Not auto-loaded, read when needed: `docs/reference.md` (what each findings doc settled and its rule, and
every regeneration command), `docs/harness.md` (why the harness is built this way),
`docs/completed-task.md` (completion log), `docs/findings-*.md`. The full map is `docs/HANDOFF.md`
section 9.
