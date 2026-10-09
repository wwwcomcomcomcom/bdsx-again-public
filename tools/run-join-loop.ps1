<#
.SYNOPSIS
    Boot one BDS, then let the headless bot join and leave it -Joins times; count the crashes.
.DESCRIPTION
    Q8's 0x3f800000 fault (docs/findings-gamethread.md "The `0x3f800000` fault, named") struck 3 of 364
    1.26.51.1 sessions, always ~1.5 s after "Player connected", before "Player Spawned". One session is
    one join, so a rate that low needs hundreds of joins: this runner does them against one server,
    under bdsx (-Launcher given) or vanilla (-Launcher "", -Bds a plain copy of the server).

    Per join: start tools/livebot.cjs with BP_LEAVE_AFTER_START=<-StayMs> (the bot leaves that long
    after start_game), wait for the next "Player connected", the bot's exit and the matching
    "Player disconnected". If the server exits instead, the join is a crash: the .out/.err/bot log are
    kept as <Tag>-crash<N>.*, the elapsed time since "Player connected" is noted, and a fresh server is
    booted so the count goes on. One line per join goes to <lab>\runs\<Tag>.joins.txt.
    Output ends with "exit code:" of the last server (tools/host/session.mjs reads it).

    -Fresh: stop and reboot the server after every join, so each join is the first one on a new
    server -- the condition all three Q8 crashes had (one session = one boot = one join). A stop that
    does not end in exit 0 is noted as "STOP FAILED" (the late-GC -1 after "Quit correctly" included).

    -ProcDump <procdump64.exe>: attach Sysinternals procdump (-e -ma) to each server once it has started,
    so a crash that bdsx's report cannot see (any thread but the node thread; docs/findings-gamethread.md
    "Why the report is empty") leaves a full dump in <lab>\runs\dumps\<Tag>. WER LocalDumps writes
    nothing for bdsx: bdsx-core's own unhandled-exception filter ends the process first, and an attached
    debugger is asked before that filter. A server that ignores `stop` gets an on-demand dump too.
    Read them with tools/minidump.mjs (node runs on the host, so the dump need not be copied). -mp is
    not usable: this procdump writes it with empty thread and module lists.
#>
[CmdletBinding()]
param(
    [string]    $Bds        = "",          # directory holding bedrock_server.exe; default <lab>\inst51\bedrock_server
    [string]    $Root       = "",          # bdsx instance root (its launcher.js is swapped like run-client-probe.ps1 does)
    [string]    $Launcher   = "",          # "" = vanilla: nothing to swap
    [string]    $ExeArgs    = "..",        # bdsx is started as `bedrock_server.exe ..`; vanilla gets ""
    [string]    $Tag        = "jl",
    [int]       $Joins      = 300,
    [int]       $StayMs     = 4500,        # after start_game, which reaches the bot shortly after "Player connected"
    [int]       $StartSecs  = 150,
    [int]       $MaxCrashes = 10,
    [string]    $Bot        = "",          # default tools\livebot.cjs
    [string]    $BotModules = "",          # default <lab>\bot\node_modules
    [int]       $BotPort    = 19134,
    [int]       $BotSecs    = 40,          # hard limit per bot process
    [hashtable] $Env        = @{},
    [switch]    $Fresh,
    [string]    $ProcDump   = "",
    [int]       $JoinDelaySecs = 0     # wait this long after "Server started" before the first bot (bisecting the fresh-boot deaths)
)
# the lab (tools/host/lab.mjs): session.mjs sets $env:BDSX_LAB; run by hand, it defaults to <repo>\lab
$Lab = if ($env:BDSX_LAB) { $env:BDSX_LAB } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\lab")) }
$Runs = Join-Path $Lab "runs"; New-Item -ItemType Directory -Path $Runs -Force | Out-Null
if (-not $Bds) { $Bds = Join-Path $Lab "inst51\bedrock_server" }
if (-not $Bot) { $Bot = Join-Path $PSScriptRoot "livebot.cjs" }
if (-not $BotModules) { $BotModules = Join-Path $Lab "bot\node_modules" }
$ErrorActionPreference = "Continue"
$base = $Runs
$out = "$base\$Tag.out"; $err = "$base\$Tag.err"; $botLog = "$base\$Tag.bot.log"; $botErr = "$base\$Tag.bot.err"
$joinsFile = "$base\$Tag.joins.txt"
$dumpDir = "$base\dumps\$Tag"
if ($ProcDump) { New-Item -ItemType Directory -Path $dumpDir -Force | Out-Null }
$script:pd = $null
function Get-Mine { Get-Process bedrock_server -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Bds, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 }
function Wait-ProcDump { if ($script:pd) { $null = $script:pd.WaitForExit(180000); $script:pd = $null } }
function Latest-Dump { if ($ProcDump) { (Get-ChildItem $dumpDir -Filter *.dmp -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1).Name } }
function Stop-Mine { Get-Process bedrock_server -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Bds, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue }
function Count($pattern) { if (Test-Path $out) { @(Select-String -Path $out -Pattern $pattern -SimpleMatch).Count } else { 0 } }
function Note($line) { Add-Content -Path $joinsFile -Value $line; Write-Host $line }

if ($Launcher) {
    Copy-Item (Join-Path $Root "launcher.js") (Join-Path $Root "launcher.js.bak") -Force -ErrorAction SilentlyContinue
    Copy-Item $Launcher (Join-Path $Root "launcher.js") -Force
}
foreach ($k in $Env.Keys) { [Environment]::SetEnvironmentVariable($k, $Env[$k], "Process") }
[Environment]::SetEnvironmentVariable("BP_LEAVE_AFTER_START", "$StayMs", "Process")
[Environment]::SetEnvironmentVariable("NODE_PATH", $BotModules, "Process")
Remove-Item $joinsFile, "$base\$Tag-crash*.*" -Force -ErrorAction SilentlyContinue

$script:p = $null
function Stop-Server {
    try { $script:p.StandardInput.WriteLine("stop"); $script:p.StandardInput.Flush() } catch {}
    if (-not $script:p.WaitForExit(90000)) {
        # a server that ignores `stop`: note whether it still burns CPU (busy loop vs a wait) before it is killed
        $bp = Get-Mine
        if ($bp) { $c1 = $bp.TotalProcessorTime.TotalSeconds; Start-Sleep -Seconds 3; $bp.Refresh(); Write-Host ("hung server: {0:N2}s CPU in 3s, {1} threads" -f ($bp.TotalProcessorTime.TotalSeconds - $c1), $bp.Threads.Count) }
        if ($bp -and $ProcDump) { & $ProcDump -accepteula -nobanner -ma $bp.Id "$dumpDir\hang-$(Get-Date -Format yyMMdd-HHmmss).dmp" | Out-Null }
        Stop-Mine
        Wait-ProcDump
        # cmd.exe holds the .out/.err redirections until it has seen its child die
        $null = $script:p.WaitForExit(30000)
        return "hung"
    }
    Wait-ProcDump
    return "$($script:p.ExitCode)"
}
function Start-Server {
    Stop-Mine
    for ($i = 0; $i -lt 60 -and ((Test-Path $out) -or (Test-Path $err)); $i++) { Remove-Item $out, $err -Force -ErrorAction SilentlyContinue; if ((Test-Path $out) -or (Test-Path $err)) { Start-Sleep -Milliseconds 500 } }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c `"bedrock_server.exe $ExeArgs > `"$out`" 2> `"$err`"`""
    $psi.WorkingDirectory = $Bds
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $script:p = New-Object System.Diagnostics.Process
    $script:p.StartInfo = $psi
    $null = $script:p.Start()
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $StartSecs -and -not $script:p.HasExited) {
        if ((Count "Server started.") -gt 0) {
            Write-Host "server started after $([int]$sw.Elapsed.TotalSeconds)s"
            $bp = Get-Mine
            if ($ProcDump -and $bp) { $script:pd = Start-Process -FilePath $ProcDump -ArgumentList "-accepteula -nobanner -e -ma $($bp.Id) `"$dumpDir`"" -NoNewWindow -PassThru -RedirectStandardOutput "$base\$Tag.procdump.log" }
            if ($JoinDelaySecs -gt 0) { Start-Sleep -Seconds $JoinDelaySecs }
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "server did not start (exited: $($script:p.HasExited))"; return $false
}

$total = [Diagnostics.Stopwatch]::StartNew()
$done = 0; $crashes = 0; $noConnect = 0; $attempt = 0
if (-not (Start-Server)) { Write-Host "exit code: boot-failed"; exit 1 }
while ($done -lt $Joins -and $crashes -le $MaxCrashes) {
    $attempt++
    $c0 = Count "Player connected"; $d0 = Count "Player disconnected"; $s0 = Count "Player Spawned"
    $botProc = Start-Process -FilePath "node" -ArgumentList "`"$Bot`" 127.0.0.1 $BotPort $BotSecs" -NoNewWindow -PassThru -RedirectStandardOutput $botLog -RedirectStandardError $botErr
    $sw = [Diagnostics.Stopwatch]::StartNew(); $tConn = $null
    while ($sw.Elapsed.TotalSeconds -lt ($BotSecs + 10) -and -not $script:p.HasExited) {
        if ($null -eq $tConn -and (Count "Player connected") -gt $c0) { $tConn = $sw.Elapsed.TotalSeconds }
        if ($botProc.HasExited -and ($null -eq $tConn -or (Count "Player disconnected") -gt $d0)) { break }
        Start-Sleep -Milliseconds 250
    }
    $spawned = (Count "Player Spawned") -gt $s0
    if (-not $botProc.HasExited) { Stop-Process -Id $botProc.Id -Force -ErrorAction SilentlyContinue }
    if ($null -ne $tConn) { $done++ } else { $noConnect++ }
    if ($script:p.HasExited) {
        Wait-ProcDump
        $crashes++
        $since = if ($null -ne $tConn) { "{0:N1}s after Player connected" -f ($sw.Elapsed.TotalSeconds - $tConn) } else { "no Player connected" }
        Note ("join {0} (attempt {1}, {2:N0}s in): SERVER EXITED {3}, exit code {4}, spawned {5}, dump {6}" -f $done, $attempt, $total.Elapsed.TotalSeconds, $since, $script:p.ExitCode, $spawned, (Latest-Dump))
        foreach ($f in @($out, $err, $botLog, $botErr)) { if (Test-Path $f) { Copy-Item $f ($f -replace "\\$Tag\.", "\$Tag-crash$crashes.") -Force } }
        if (-not (Start-Server)) { Write-Host "exit code: reboot-failed"; exit 1 }
        continue
    }
    $line = "join {0}: connected {1}, spawned {2}, took {3:N1}s" -f $done, ($(if ($null -ne $tConn) { "+{0:N1}s" -f $tConn } else { "NO" })), $spawned, $sw.Elapsed.TotalSeconds
    if ($Fresh) {
        $code = Stop-Server
        $line += ", stop exit $code"
        if ($code -ne "0") {
            $crashes++; $quit = (Count "Quit correctly") -gt 0
            Note ("{0}: STOP FAILED, quit correctly {1}" -f $line, $quit)
            foreach ($f in @($out, $err)) { if (Test-Path $f) { Copy-Item $f ($f -replace "\\$Tag\.", "\$Tag-crash$crashes.") -Force } }
        } else { Add-Content -Path $joinsFile -Value $line }
        if ($done -lt $Joins -and -not (Start-Server)) { Write-Host "exit code: reboot-failed"; exit 1 }
    } else { Add-Content -Path $joinsFile -Value $line }
    if ($attempt % 25 -eq 0) { Write-Host ("{0} ({1:N0}s in)" -f $line, $total.Elapsed.TotalSeconds) }
    if ($noConnect -gt 20 -and $done -eq 0) { Write-Host "the bot never connects; giving up"; break }
}
Write-Host ("joins: {0}  crashes: {1}  attempts without a connect: {2}  in {3:N0}s" -f $done, $crashes, $noConnect, $total.Elapsed.TotalSeconds)
if (-not $script:p.HasExited) { Write-Host "sending 'stop'"; $code = Stop-Server; if ($code -eq "hung") { Write-Host "did not exit 90s after stop; killing" } else { Write-Host "exit code: $code" } }
else { Write-Host "exit code: $($script:p.ExitCode)" }
Stop-Mine
if ($Launcher) { Copy-Item (Join-Path $Root "launcher.js.bak") (Join-Path $Root "launcher.js") -Force -ErrorAction SilentlyContinue }
Write-Host "---- crashes ----"
Get-Content $joinsFile -ErrorAction SilentlyContinue | Select-String "SERVER EXITED|STOP FAILED" | ForEach-Object { $_.Line }
