& "$env:BDSX_REPO\tools\run-client-probe.ps1" -Root "$env:BDSX_LAB\inst51" -Launcher "$env:BDSX_LAB\inst51\full-launcher.js" -Tag sig51 `
  -Bot "$env:BDSX_REPO\tools\livebot.cjs" -BotModules "$env:BDSX_LAB\bot\node_modules" -BotPort 19134 -BotSecs 200 -JoinSecs 120 -AfterJoin 8 -AfterKill 8 `
  -Env @{ BP_VERSION = "1.26.51"; BP_LIVE = "0" } `
  -Commands @("difficulty normal", "tp @a 29 68 14", "time set midnight", "execute as @a at @s run summon iron_golem ~2 ~ ~2", "execute as @a at @s run summon zombie ~3 ~ ~2", "execute as @a at @s run summon zombie ~2 ~ ~3", "say wait1", "say wait2", "say wait3", "kill @e[type=zombie]", "kill @e[type=iron_golem]", "execute as @a in nether run tp @s 0 80 0", "say wait4")
