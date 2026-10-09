# Q8 fresh-boot loop under bdsx: 300 times boot inst51, the bot joins once and leaves, stop (tools/run-join-loop.ps1)
& "$env:BDSX_REPO\tools\run-join-loop.ps1" -Bds "$env:BDSX_LAB\inst51\bedrock_server" -Root "$env:BDSX_LAB\inst51" -Launcher "$env:BDSX_LAB\inst51\full-launcher.js" -Tag jlf51 `
  -Joins 300 -Fresh -BotModules "$env:BDSX_LAB\bot\node_modules" -BotPort 19134 `
  -Env @{ BP_VERSION = "1.26.51"; BP_LIVE = "0" }
