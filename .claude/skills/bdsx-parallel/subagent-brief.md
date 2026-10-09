# Subagent brief template

The main agent fills in the `{{...}}` blanks and passes this **verbatim** as the `Agent` tool's `prompt`.
Blanks: `{{AGENT_ID}}` `{{RUN_DIR}}` `{{TASK_ID}}` `{{TASK_TEXT}}` `{{SIBLINGS}}`

---

You are `{{AGENT_ID}}`. In the bdsx revival repository (the current working directory) you own
**exactly one item, `{{TASK_ID}}` in `docs/next-steps.md`**, through to its commit. When it is done,
commit and stop. Do not move on to another item.

Other agents are working in the same repository right now: {{SIBLINGS}}.
So: **read anything, write only under a ticket.**

## Your item (copied from docs/next-steps.md)

{{TASK_TEXT}}

## Read first

`docs/HANDOFF.md` -> your section of `docs/next-steps.md` -> the `docs/findings-*.md` it points to.
Before running BDS, `docs/lab-runbook.md`. The project rules (`CLAUDE.md`) all apply.

## Two tickets -- breaking this protocol wrecks another agent's work

| ticket | covers |
|---|---|
| `verify` | the `bdsx/` working tree **+ inst40 + inst51** (both lab instances) |
| `repo` | `data/`, `docs/`, `git commit` |

```sh
node tools/host/agent-lock.mjs status
node tools/host/agent-lock.mjs acquire verify {{AGENT_ID}} --note='{{TASK_ID}}'   # only when needed
node tools/host/agent-lock.mjs acquire repo   {{AGENT_ID}} --note='{{TASK_ID}}'
node tools/host/agent-lock.mjs renew   verify {{AGENT_ID}}     # now and then, if you hold it long
node tools/host/agent-lock.mjs release repo   {{AGENT_ID}}
node tools/host/agent-lock.mjs release verify {{AGENT_ID}}
```

Four rules:

1. **`verify` first, `repo` second.** The reverse is a deadlock and the script refuses it.
2. **Edit files under `bdsx/` only after taking `verify`.** `session.mjs` copies `bdsx/` into both
   instances, so an edit made without it gets your half-finished code verified by another agent's session.
   Before you hold it, **only plan the edit** (which file, which lines, why).
3. If `acquire` exits 4 (BUSY), **do not wait: do other work** (read bodies, narrow candidates, write the
   probe's check), then try again. It only means another agent is using the ticket.
4. **Always `release`, however you finish** -- on failure too, and when you changed nothing.

## Order of work

1. **Static analysis (no ticket, in parallel).** Find candidate addresses and read the bodies. Read the
   body before promoting -- in this project a call count proves neither the address nor the prototype
   (`Mob::_hurt`, `Actor::hurt`). `node tools/disas-exact.mjs <v> 0x<rva>`, `node tools/component-hash.mjs`,
   `node tools/leaf-funcs.mjs` and so on. Build the candidates on **both builds**.
2. **Take `verify`.**
3. If needed, edit `bdsx/` and put the addresses and provenance in `data/resolved-<v>.json`.
   (`data/` is written under `repo` in step 5 as a rule, but the table must be built while you hold
   `verify` to run a session. Then take `repo` as well -- in the order verify -> repo.)
4. **Verify on both builds at once.** After adding a check to the probe:
   ```sh
   node tools/merge-symbols.mjs 1.26.40.8 data/merged-1.26.40.8.json
   node tools/make-table.mjs --exe=work/bin/1.26.40.8/bedrock_server.exe --bdsVersion=1.26.40.8 --symbols=data/merged-1.26.40.8.json --out=data/symbols-1.26.40.8.json
   node tools/merge-symbols.mjs 1.26.51.1 data/merged-1.26.51.1.json
   node tools/make-table.mjs --exe=work/bin/1.26.51.1/bedrock_server.exe --bdsVersion=1.26.51.1 --symbols=data/merged-1.26.51.1.json --out=data/symbols-1.26.51.1.json
   node tools/host/verify-pair.mjs tools/host/drivers/<d40>.ps1 tools/host/drivers/<d51>.ps1 --grep='\[tag\]'
   ```
   `verify-pair.mjs` runs both sessions at once and exits 0 **only when both are clean**.
5. **Take `repo` -> record -> commit -> release.**
   - `data/resolved-<v>.json` `provenance`: what was run, how, and what came out
   - the relevant `docs/findings-*.md` (a new doc for a new route)
   - `docs/status.md`: never type numbers; `node tools/status-summary.mjs --write`
   - `docs/next-steps.md`: **move the finished item to the top of `docs/completed-task.md`'s "Completion Log"
     and write the next thing to do in the queue, concretely**
   - if you changed `bdsx/`, commit inside it (English), and after a table rebuild `node tools/ship-tables.mjs`
   - `node tools/docs-check.mjs` must exit 0 (auto-loaded size budget, no hand-typed numbers)
   - commit: `type(scope): summary` (`add`/`fix`/`docs`), ending with the attribution lines your
     harness asks for
   - before `git add`, check `git status --short` for **changes unrelated to your item**. If there are
     any, commit by path. Never put another agent's work in your commit.

## When it fails -- that is a result too

If verification FAILs or the server dies, you have a **budget of two retries**, each narrowing the cause
(one hook only, `SIG_ONLY`, a minimal hook, which registers the first 20 instructions of the body read --
`docs/lab-runbook.md` section 5).

If it still does not work, **write it down honestly and stop**:

- in `docs/findings-*.md`, what you tried, how, and the output (verbatim)
- **leave the item in** `docs/next-steps.md`, with what to try next so the next worker can continue
- an address to withdraw goes in `retracted` of `data/candidates-instances-<v>.json`, with the reason
- commit, and report **FAILED** to the main agent

**Never write as confirmed what was not run.** If it worked on one build only, say so.
A session that ended in `!! SESSION FAILED` did not run: it is not a result.

## Progress log

Leave one line when you start and finish each long step (so the main agent knows where you were if you die):

```sh
node -e "require('fs').appendFileSync('{{RUN_DIR}}/{{AGENT_ID}}.log', new Date().toTimeString().slice(0,8)+' <what you are doing>\n')"
```

## Report to the main agent (your last message)

1. `{{TASK_ID}}` -- **DONE / FAILED / PARTIAL**
2. what was confirmed **by execution on which build** (or that the evidence is static only)
3. the commit hash and title
4. what did not work and why, and how you left it in the queue
5. whether you released every ticket you took (`node tools/host/agent-lock.mjs status` output)
