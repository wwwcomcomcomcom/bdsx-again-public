# The live-bot harness (docs/findings-bot.md "The harness"): tools/livebot.cjs is a client the probe tools/livebot-probe.ts
# drives over LB_PORT; the probe builds its arena at x=-3000 z=3000 and runs the scenarios LB_RUN names ("all", or a
# space-separated list: copy this driver and change only LB_RUN and the tag to run one scenario)
& "$env:BDSX_REPO\tools\run-client-probe.ps1" -Root "$env:BDSX_LAB\inst40" -Launcher "$env:BDSX_LAB\inst40\full-launcher.js" -Tag lb40 `
  -Bot "$env:BDSX_REPO\tools\livebot.cjs" -BotModules "$env:BDSX_LAB\bot\node_modules" -BotPort 19132 -BotSecs 380 -JoinSecs 120 -AfterJoin 8 -AfterKill 4 `
  -Env @{ BP_VERSION = "1.26.40"; LB_PORT = "19150"; LB_RUN = "all" } `
  -Commands @("lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "lb status", "tickingarea remove lbarena", "difficulty normal", "time set day", "gamemode survival @a", "clear @a")
