# Q8 join loop under bdsx: one inst51 server, the bot joins and leaves 300 times (tools/run-join-loop.ps1)
& "$env:BDSX_REPO\tools\run-join-loop.ps1" -Bds "$env:BDSX_LAB\inst51\bedrock_server" -Root "$env:BDSX_LAB\inst51" -Launcher "$env:BDSX_LAB\inst51\full-launcher.js" -Tag jl51 `
  -Joins 300 -BotModules "$env:BDSX_LAB\bot\node_modules" -BotPort 19134 `
  -Env @{ BP_VERSION = "1.26.51"; BP_LIVE = "0" }
