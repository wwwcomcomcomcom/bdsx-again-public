# Item component vftables and FreezeOnHitSubcomponent (docs/findings-nbt.md section 22). tools/itemcomp-probe.ts
# "icprobe <step>". No client: the sweep builds its item stacks with ItemStack.constructWith; "synth <c>" builds the
# components no vanilla item holds in bdsx memory (EntityPlacer last: the largest zeroed object).
& "$env:BDSX_REPO\tools\run-full.ps1" -Root "$env:BDSX_LAB\inst40" -Tag icomp40 -AfterReady 12 -Commands @("icprobe sweep", "icprobe freeze", "icprobe synth armor", "icprobe synth render_offsets", "icprobe synth digger", "icprobe synth repairable", "icprobe synth entity_placer")
