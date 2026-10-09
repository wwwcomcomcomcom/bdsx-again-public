& "$env:BDSX_REPO\tools\run-client-probe.ps1" -Root "$env:BDSX_LAB\inst51" -Launcher "$env:BDSX_LAB\inst51\full-launcher.js" -Tag pk51 `
  -Bot "$env:BDSX_REPO\tools\livebot.cjs" -BotModules "$env:BDSX_LAB\bot\node_modules" -BotPort 19134 -BotSecs 150 -JoinSecs 120 -AfterJoin 8 -AfterKill 4 `
  -Env @{ BP_VERSION = "1.26.51"; BP_LIVE = "0"; BP_CHAT = "30000:bdsxpass1;38000:bdsxcancel2;46000:bdsxrawcut4;70000:bdsxafter3"; BP_FORM_REPLY = "true"; PK_ARM = "1" } `
  -Commands @("tp @a 29.5 68 14.5", "pkprobe arm", "say wait", "pkprobe form", "say wait", "say wait", "pkprobe sendtext", "say wait", "pkprobe report", "pkprobe disarm", "say wait", "say wait", "pkprobe after-disarm")
