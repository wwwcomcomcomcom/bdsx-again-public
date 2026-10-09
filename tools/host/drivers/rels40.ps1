# The release check on bdsx's own entry point (docs/findings-inventory.md section 29): tools/host/index-examples.ts as index.ts
# (pass --upload=tools/host/index-examples.ts:inst40/index.ts) is the stock "import ./example_and_test",
# whose import chain ends at the first example that throws. No client: the chain has loaded when the last examples'
# load-time lines (storage.ts's counter, test.ts's "[test] node version") are printed.
& "$env:BDSX_REPO\tools\run-full.ps1" -Root "$env:BDSX_LAB\inst40" -Tag rels40 -AfterReady 12 -Commands @("list", "aaa release check", "whoami")
