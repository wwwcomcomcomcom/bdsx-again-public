# Q8 fresh-boot loop under bdsx on 1.26.40.8 (inst40, all probes): does the other build die at its first join too? procdump attached (tools/run-join-loop.ps1)
& "$env:BDSX_REPO\tools\run-join-loop.ps1" -Bds "$env:BDSX_LAB\inst40\bedrock_server" -Root "$env:BDSX_LAB\inst40" -Launcher "$env:BDSX_LAB\inst40\full-launcher.js" -Tag jlf40 `
  -Joins 100 -Fresh -MaxCrashes 10 -ProcDump "$env:BDSX_LAB\procdump\procdump64.exe" -BotModules "$env:BDSX_LAB\bot\node_modules" -BotPort 19132 `
  -Env @{ BP_VERSION = "1.26.40"; BP_LIVE = "0" }
