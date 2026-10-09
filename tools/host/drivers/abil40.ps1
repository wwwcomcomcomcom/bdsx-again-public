& "$env:BDSX_REPO\tools\run-client-probe.ps1" -Root "$env:BDSX_LAB\inst40" -Launcher "$env:BDSX_LAB\inst40\full-launcher.js" -Tag abil40 `
  -Bot "$env:BDSX_REPO\tools\livebot.cjs" -BotModules "$env:BDSX_LAB\bot\node_modules" -BotSecs 240 -JoinSecs 120 -AfterJoin 8 -AfterKill 4 `
  -Env @{ BP_VERSION = "1.26.40"; BP_LIVE = "0" } `
  -Commands @("tp @a 29.5 68 14.5 90 45", "gamemode survival @a", "abilprobe base", "abilprobe survival", "abilprobe names survival", "abilprobe abilities", "gamemode creative @a", "abilprobe creative", "abilprobe names creative", "abilprobe write", "op @a", "abilprobe perms op", "deop @a", "abilprobe perms member", "abilprobe sync", "abilprobe sync on", "abilprobe sync off", "gamemode survival @a", "abilprobe survival")
