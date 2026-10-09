<#
.SYNOPSIS
    Run BDS under bdsx's own compiled entry point (launcher.js), drive a real
    "stop" once the ready marker appears in the log or a time cap passes, and
    print the bdsx-tagged lines.

.DESCRIPTION
    stdout and stderr go to files through cmd.exe, which node writes
    synchronously, so the last line before a crash is really the last line;
    the PowerShell event-based capture used before silently stopped at about
    1,900 lines. stdin stays a pipe so "stop" can be written to it. Output:
    <lab>\runs\<Tag>.out and .err.
#>
[CmdletBinding()]
param(
    [string] $Root         = "",     # default <lab>\inst40
    [string] $Tag          = "full",
    [string] $ReadyPattern = "Server started\.",
    [int]    $ReadySecs    = 240,
    [int]    $AfterReady   = 20,
    [int]    $ExitSecs     = 90,
    # console lines written after the ready marker, two seconds apart, before "stop"
    [string[]] $Commands   = @(),
    # environment for the launched bedrock_server.exe, as -Env @{ NAME = "value" } (see run-client-probe.ps1)
    [hashtable] $Env       = @{}
)
# the lab (tools/host/lab.mjs): session.mjs sets $env:BDSX_LAB; run by hand, it defaults to <repo>\lab
$Lab = if ($env:BDSX_LAB) { $env:BDSX_LAB } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\lab")) }
$Runs = Join-Path $Lab "runs"; New-Item -ItemType Directory -Path $Runs -Force | Out-Null
if (-not $Root) { $Root = Join-Path $Lab "inst40" }
$ErrorActionPreference = "Continue"
foreach ($k in $Env.Keys) { [Environment]::SetEnvironmentVariable($k, $Env[$k], "Process") }
$bds = Join-Path $Root "bedrock_server"
# Two instances run at once, so only this instance's server may ever be killed: filter on the image path
# (Get-Process bedrock_server | Stop-Process would shoot the other instance down mid-probe).
function Stop-Mine { Get-Process bedrock_server -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($bds, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue }
$out = "$Runs\$Tag.out"
$err = "$Runs\$Tag.err"
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
Stop-Mine

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
$ready = $false
while ($sw.Elapsed.TotalSeconds -lt $ReadySecs) {
    if ($p.HasExited) { break }
    if ((Test-Path $out) -and (Select-String -Path $out -Pattern $ReadyPattern -Quiet)) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}
Write-Host "ready: $ready  after $([int]$sw.Elapsed.TotalSeconds)s  exited early: $($p.HasExited)"
if (-not $p.HasExited) {
    Start-Sleep -Seconds $AfterReady
    foreach ($c in $Commands) {
        Write-Host "sending '$c'"
        try { $p.StandardInput.WriteLine($c); $p.StandardInput.Flush() } catch {}
        Start-Sleep -Seconds 2
    }
    Write-Host "sending 'stop'"
    try { $p.StandardInput.WriteLine("stop"); $p.StandardInput.Flush() } catch {}
    if (-not $p.WaitForExit($ExitSecs * 1000)) { Write-Host "did not exit ${ExitSecs}s after stop; killing"; Stop-Mine }
    else { Write-Host "exit code: $($p.ExitCode)" }
} else { Write-Host "exit code: $($p.ExitCode)" }
Stop-Mine
Write-Host "---- bdsx / marker lines ----"
Get-Content $out, $err -ErrorAction SilentlyContinue | Select-String -Pattern "\[bdsx\]|BDSX\]|slotprobe|serverOpen|Server started|stop requested|Stopping server|Quit correctly|Native Crash|unavailable|game loop" | Select-Object -First 40 | ForEach-Object { $_.Line }
Write-Host "---- stdout last 6 ----"
Get-Content $out -Tail 6 -ErrorAction SilentlyContinue
Write-Host "---- stderr last 6 (non-symbol) ----"
Get-Content $err -ErrorAction SilentlyContinue | Select-String -NotMatch "Symbol not found|   at " | Select-Object -Last 6 | ForEach-Object { $_.Line }
