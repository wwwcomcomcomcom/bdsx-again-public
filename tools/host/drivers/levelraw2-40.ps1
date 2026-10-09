& "$env:BDSX_REPO\tools\run-client-probe.ps1" -Root "$env:BDSX_LAB\inst40" -Launcher "$env:BDSX_REPO\tools\level-getter-probe-launcher.js" -Tag levelraw2 -JoinSecs 25 -AfterJoin 2 -AfterKill 2 -ExitSecs 20 `
  -Env @{ LG_CONFIG = "$env:BDSX_LAB\lg-config-raw-40.json"; LG_RAW = "$env:BDSX_LAB\level-raw2-40.json"; LG_TICKS = "400"; LG_EVERY = "100" } `
  -Commands @("say marker")
