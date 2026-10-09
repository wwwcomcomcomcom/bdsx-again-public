& "$env:BDSX_REPO\tools\run-client-probe.ps1" -Root "$env:BDSX_LAB\inst51" -Launcher "$env:BDSX_LAB\inst51\full-launcher.js" -Tag left51 `
  -Bot "$env:BDSX_REPO\tools\livebot.cjs" -BotModules "$env:BDSX_LAB\bot\node_modules" -BotPort 19134 -BotSecs 14 -JoinSecs 120 -AfterJoin 30 -AfterKill 5 `
  -Env @{ BP_VERSION = "1.26.51"; BP_LIVE = "0" } `
  -Commands @("say marker")
