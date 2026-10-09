# Host parallelisation: one connection, two instances, two workers

This is next-steps Q0. It adds no symbol. It makes one verification cheaper and,
more to the point, makes a failed verification *look* failed.

Measured on 2026-09-20 against the Windows host (`cores=1 logical=4`, RAM 16 GB).

## What a session cost before

`tools/host/session.mjs` opened a new ssh or scp connection for every step --
ten to fourteen of them, in a burst, at the start of every session. The host's
sshd (`MaxStartups` at its 10:30:100 default) dropped some of them: on
2026-09-19, four of six sessions lost at least one connection
(`scp: Connection closed`, `Connection closed by <host> port 22`), and the host
answered every one of those the moment it was idle. It was a burst, not a fault.

A dropped connection is worse than it sounds. The session left an empty
transcript, and an empty transcript is exactly what a probe that printed nothing
leaves. One commit that day claimed "`itemprobe` 11/11 PASS on both builds" when
1.26.40.8 had produced no `[item]` line at all, twice, because both of its
sessions had died on the way up.

A 1.26.51.1 session also moved `bedrock_server` aside, expanded an 85 MB zip and
moved it back. That is why the runbook ended every session by checking an MD5,
and why "restore by hand" was a documented step.

## What it costs now

| | before | after |
|---|---|---|
| ssh/scp connections per session | 10-14 | 1 (`ControlMaster`, `ControlPersist=120`) |
| `Connection closed` in 16 sessions | ~1 in 3 sessions | **0** |
| one 1.26.40.8 + one 1.26.51.1 session | serial, plus two zip swaps | **71 s, in parallel** |
| MD5 check afterwards | every session | gone |

`sad40`+`sad51` as a concurrent pair, four times in a row: 11/11 PASS on both
builds every time, `Quit correctly` and exit 0 every time, 71 s per pair.
`layout40`+`layout51` concurrently: 23/23 PASS on both. `gr40`+`gr51`
(`run-full`, no client) concurrently: both ready in 4 s, both `Quit correctly`.

## The two instances

`tools/host/setup-instances.ps1` renames the existing tree to
`C:\bdsx-again\inst40`, leaves `C:\bdsx-again\bdsx` behind as a junction to it so
stray absolute paths still resolve, and builds `inst51` from a copy of inst40's
sources and `node_modules` plus a freshly extracted 1.26.51.1. It is idempotent.

An instance owns everything that is per build or per track:

| | why |
|---|---|
| `bedrock_server\` (`symbols.json`, `pdbcache.bin`, `pdbcache.l2`, `worlds\`, `server.properties`) | the table is per build and is checked against the exe's MD5; the l2 cache is keyed on both |
| its ports | so both can be up at once |
| its compiled `.js`, `example_and_test\zz-*.ts`, `index.ts`, `full-launcher.js` | the probe list and the tsc output are per track |
| its VCRUNTIME proxy pair | bdsx-core attaches by DLL search order, which is per directory |

Two things had to be fixed for that to hold.

**`node_modules\bdsx` is a junction back to the instance's own `bdsx\`, and it
has to stay one.** robocopy copies a junction as a real directory; tsc then sees
`bdsx/launcher.ts` twice and reports `TS2451: Cannot redeclare block-scoped
variable 'brightCyan'`. inst51's first build exited 2 for that reason.
`Fix-SelfLink` in the setup script repairs it on both instances.

**`Get-Process bedrock_server | Stop-Process` had to go.** Both runners opened
and closed with it, which under two instances means shooting the other track's
server down mid-probe. They now filter on the image path (`Stop-Mine`).

## `server-port` is not the whole story

The first concurrent runs killed 1.26.40.8 about one time in three with a bare
`exit code: -1073741819` (0xC0000005) four seconds in. The stack was not the
cause and neither was the table. The server's own stdout said it:

```
[ERROR] Port [19132] may be in use by another process. ... Exiting program
```

**BDS opens 19132/19133 for LAN discovery whatever `server-port` says.** With
`server-port=19144` the log reads:

```
IPv4 supported, port: 19144: Used for gameplay
IPv6 supported, port: 19145: Used for gameplay
IPv4 supported, port: 19132 used for LAN discovery
IPv6 supported, port: 19133
```

and `netstat` confirms one pid holding both. Two instances therefore collide on
19132/19133 no matter how their gameplay ports are set, and the loser is
whichever booted second.

`enable-lan-visibility=false` drops that socket. Putting it on only one instance
does not work in either direction: the instance that keeps LAN discovery still
takes 19132/19133, and the instance that loses it stops answering RakNet
unconnected pings on its gameplay socket too -- which is what
`tools/probe-client.cjs` used under `BP_SPOOF=1` to read the server's protocol
number. With the ping unanswered the 1.26.51.1 bot never joined (four pairs,
`joined: False` after the full 120 s).

So both instances are LAN-invisible, and the bot takes the number outright:
`BP_PROTOCOL=2193` for 1.26.51.1 (1.26.40.8 is 2168, and its bot never pinged --
the library knows that protocol). The one tool that still needs the MOTD,
`tools/ping-protocol.cjs`, needs `enable-lan-visibility=true` put back for that
one run.

## Silence is not success, and neither is a status nobody read

`session.mjs` now exits non-zero, with the reason, when:

- the driver never reported an exit code (the connection dropped, or the runner died);
- the run produced no matching or marker line at all -- not even `Server started`;
- a crash marker (`Native Crash`, `JS Crash`, `EXCEPTION_`) is in the output;
- the exit code is non-zero and `Quit correctly` is absent.

The last one is not hypothetical: it is what caught the port collision. The run
had reached `Server started` and `Player connected`, so the peek output was not
empty, and the old script would have reported it as a session with no failures.
(`exit code: -1` *after* a `Quit correctly` stays a pass -- that is the known
late-GC `StructurePointer::finalize`, next-steps Q8.)

**`peek.ps1`'s cap (2026-10-02).** `peek.ps1` printed only the first 120 matching lines. With a wide `--grep`, a FAIL past
line 120 never reached the transcript, so `verify-pair.mjs`'s count read 0. The `item` pair did exactly that: it reported 66/0
while the host output had 84 PASS and 1 FAIL. Past the cap, peek now prints a `[peek] N more matching lines cut` note and
then every FAIL and marker line, `Quit correctly` included. The note avoids the words PASS and FAIL, so `verify-pair.mjs`
does not count it.

## Two at a time, and not three

`session.mjs` takes a per-instance lock (`work/locks/<inst>`, pid inside, stale
locks stolen) and waits up to 20 minutes for it. Two instances therefore mean at
most two workers. Verified: a third session launched against inst40 while
`layout40` was running printed `== waiting for the inst40 lock (held by pid N)`
and ran to 11/11 PASS after `layout40` finished.

Three would exceed the four logical cores -- each instance is a server thread
plus a bot thread -- and a timing-dependent check that wobbles cannot be told
apart from a wrong address. That distinction is the expensive one to lose here.
