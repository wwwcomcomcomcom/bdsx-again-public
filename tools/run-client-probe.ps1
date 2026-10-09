<#
.SYNOPSIS
    Run BDS under a probe launcher, wait for a client to join, kill it, then stop.
.DESCRIPTION
    The player-dependent hooks (Player::respawn, Mob::die, ...) only fire with
    a client. A headless client (bedrock-protocol, driven from the analysis
    machine running BDS) joins once "Server started." appears; this script waits for the
    join in the output file, writes "kill @a" to the server's stdin so the
    player dies and respawns, waits, then writes "stop". Output is captured
    through cmd.exe redirection to files (tools/run-full.ps1 explains why).
    Environment for the launcher is passed as -Env @{ NAME = "value" }.
#>
[CmdletBinding()]
param(
    [string]    $Root       = "",     # default <lab>\inst40
    [string]    $Launcher   = "",     # default tools\instance-probe-launcher.js
    [string]    $Tag        = "cp",
    [int]       $JoinSecs   = 150,
    [int]       $AfterJoin  = 20,
    # sent after the join, 8 s apart, before the kill: experience (addLevels), a
    # direct hurt (_hurt), a zombie teleported onto the bot to attack (attack),
    # a dimension change (changeDimension)
    # (the smoketest world's spawn Y is the 32767 sentinel, so the bot first
    # goes to the ground, where the natural zombies were seen at y 66-69)
    [string[]]  $Commands   = @("tp @a 29 68 14", "xp 5L @a", "damage @a 1 entity_attack", "execute as @a at @s run summon zombie ~1 ~ ~1", "tp @e[type=zombie] @a", "damage @e[type=zombie] 1 entity_attack", "execute as @a in nether run tp @s 0 80 0"),
    [int]       $AfterKill  = 25,
    [int]       $ExitSecs   = 90,
    [string]    $Bot        = "",     # e.g. $env:BDSX_REPO\tools\livebot.cjs: started on this machine once the server is up
    [string]    $BotModules = "",     # default <lab>\bot\node_modules
    [int]       $BotSecs    = 120,
    [int]       $BotPort    = 19132,   # the instance's server-port (inst40 19132, inst51 19134)
    [hashtable] $Env        = @{}
)
# the lab (tools/host/lab.mjs): session.mjs sets $env:BDSX_LAB; run by hand, it defaults to <repo>\lab
$Lab = if ($env:BDSX_LAB) { $env:BDSX_LAB } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\lab")) }
$Runs = Join-Path $Lab "runs"; New-Item -ItemType Directory -Path $Runs -Force | Out-Null
if (-not $Root) { $Root = Join-Path $Lab "inst40" }
if (-not $Launcher) { $Launcher = Join-Path $PSScriptRoot "instance-probe-launcher.js" }
if (-not $BotModules) { $BotModules = Join-Path $Lab "bot\node_modules" }
$ErrorActionPreference = "Continue"
$bds = Join-Path $Root "bedrock_server"
# Two instances run at once, so only this instance's server may ever be killed: filter on the image path
# (Get-Process bedrock_server | Stop-Process would shoot the other instance down mid-probe).
function Stop-Mine { Get-Process bedrock_server -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($bds, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue }
$out = "$Runs\$Tag.out"; $err = "$Runs\$Tag.err"
Copy-Item (Join-Path $Root "launcher.js") (Join-Path $Root "launcher.js.bak") -Force -ErrorAction SilentlyContinue
Copy-Item $Launcher (Join-Path $Root "launcher.js") -Force
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
Stop-Mine
foreach ($k in $Env.Keys) { [Environment]::SetEnvironmentVariable($k, $Env[$k], "Process") }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c `"bedrock_server.exe .. > `"$out`" 2> `"$err`"`""
$psi.WorkingDirectory = $bds
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
$null = $p.Start()
$sw = [Diagnostics.Stopwatch]::StartNew()
$started = $false; $joined = $false
while ($sw.Elapsed.TotalSeconds -lt $JoinSecs -and -not $p.HasExited) {
    if ((Test-Path $out) -and -not $started -and (Select-String -Path $out -Pattern "Server started\." -Quiet)) {
        $started = $true; Write-Host "server started after $([int]$sw.Elapsed.TotalSeconds)s"
        if ($Bot) {
            [Environment]::SetEnvironmentVariable("NODE_PATH", $BotModules, "Process")
            $bot = Start-Process -FilePath "node" -ArgumentList "`"$Bot`" 127.0.0.1 $BotPort $BotSecs" -NoNewWindow -PassThru -RedirectStandardOutput "$Runs\$Tag.bot.log" -RedirectStandardError "$Runs\$Tag.bot.err"
            Write-Host "bot started (pid $($bot.Id))"
        }
    }
    if ((Test-Path $out) -and (Select-String -Path $out -Pattern "Player connected|Player Spawned" -Quiet)) { $joined = $true; break }
    Start-Sleep -Milliseconds 500
}
Write-Host "started: $started  joined: $joined  after $([int]$sw.Elapsed.TotalSeconds)s  exited early: $($p.HasExited)"
try {
    if ($joined) {
        Start-Sleep -Seconds $AfterJoin
        foreach ($c in $Commands) { Write-Host "sending '$c'"; $p.StandardInput.WriteLine($c); $p.StandardInput.Flush(); Start-Sleep -Seconds 8 }
        Write-Host "sending 'kill @a'"; $p.StandardInput.WriteLine("kill @a"); $p.StandardInput.Flush()
        Start-Sleep -Seconds $AfterKill
    }
    Write-Host "sending 'stop'"; $p.StandardInput.WriteLine("stop"); $p.StandardInput.Flush()
} catch {}
if (-not $p.WaitForExit($ExitSecs * 1000)) { Write-Host "did not exit ${ExitSecs}s after stop; killing"; Stop-Mine } else { Write-Host "exit code: $($p.ExitCode)" }
Stop-Mine
Copy-Item (Join-Path $Root "launcher.js.bak") (Join-Path $Root "launcher.js") -Force -ErrorAction SilentlyContinue
if ($Bot) { Write-Host "---- bot (attack lines omitted) ----"; Get-Content "$Runs\$Tag.bot.log", "$Runs\$Tag.bot.err" -ErrorAction SilentlyContinue | Select-String -NotMatch "attacked|entity minecraft" | Select-Object -First 60 | ForEach-Object { $_.Line } }
Write-Host "---- tagged / marker lines ----"
Get-Content $out, $err -ErrorAction SilentlyContinue | Select-String -Pattern "\[ip\]|Player connected|Player disconnected|Player Spawned|Server started|Quit correctly|stop requested" | Select-Object -First 120 | ForEach-Object { $_.Line }
