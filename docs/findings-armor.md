# The armour seam: `getArmorContainer`, `getAllArmor`, `getArmorCoverPercentage`

Q1-0 A-2 (`docs/next-steps.md`). One address bdsx needed, one that corroborates
it, and one name that needs no address at all.

| name | how it ships | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `?getArmorContainer@ActorEquipment@@YAAEBVSimpleContainer@@AEBVEntityContext@@@Z` | **address** | `0x1acb8e0` (218B) | `0x1cd2170` (218B) |
| `?getAllArmor@ActorEquipment@@YA?AV?$vector@PEBVItemStack@@...@Z` | address (not required by bdsx; it is the corroboration) | `0x1acb9c0` (249B) | `0x1cd2250` (249B) |
| `?getArmorCoverPercentage@Mob@@QEBAMXZ` | `derived()` | — | — |

## What 2024 says the three are

`Mob::getArmorCoverPercentage` (`0x19119d0`, 201 bytes) is a loop and a
multiply, and nothing else:

```
getAllArmor(this->ctx)        # rcx = sret vector, rdx = Actor+8
for (p in vector)             # 8 bytes at a time
    if (!ItemStackBase::isNull(*p)) ++edi
cvtdq2ps  edi -> xmm0
mulss     [0x2bd9bfc]         # 0.25f
```

`ActorEquipment::getAllArmor` (`0x186a5b0`, 81 bytes) is
`try_get<ActorEquipmentComponent>(ctx)`, then the component's member at **+8**,
then a call through that object's vftable at **+0xc8**. The two functions either
side of it are the pair that names that member:

* `getArmorContainer` (`0x186a6e0`, 45 bytes) — the same `try_get`, then
  `movq 0x8(%rax),%rax`
* `getHandContainer` (`0x186aea0`, 44 bytes) — the same `try_get`, then
  `movq (%rax),%rax`

So the armour container is the component's member at +8, the hand container is
the one at +0, and `getAllArmor` is `getArmorContainer(ctx)->getSlots()`.

## Finding them in 1.26: caller intersection, then the pair

`getHandContainer` was already resolved on both builds (route 10, 2026-09-19,
and execution-confirmed through `getOffhandSlot`). `getArmorContainer` and
`getAllArmor` were not.

**Route 1 — caller intersection.** Of 2024's 17 callers of `getAllArmor`, four
are names this project already has on both builds:

| 2024 caller | 2024 | 1.26.40.8 | 1.26.51.1 |
|---|---|---|---|
| `?getAllEquipment@Mob@@` | `0x1911590` | `0x2405920` | `0x29ed290` |
| `?getArmorValue@Mob@@` | `0x1911e10` | `0x2405650` | `0x29ecfc0` |
| `?getAllEquipment@Player@@` | `0x19ddc30` | `0x21fc00` | `0x2ae9c0` |
| `?getRandomItemWith@EnchantUtils@@` | `0x1ae7590` | `0x1c73870` | `0x1b624f0` |

Run on 2024 first, as the control: those four have **exactly two** common
callees, `getAllArmor` and the stack-cookie check. On each 1.26 build they have
**exactly one**, and it is a 249-byte function at `0x1acb9c0` / `0x1cd2250`.

**Route 2 — the body.** That function is 2024's `getAllArmor` with the `try_get`
inlined, the same shape every other 1.26 component read has: the same `ctx+8`
(registry) and `ctx+0x10` (entity id), the pool map keyed on
`fnv1a("ActorEquipmentComponent") = 0xb06141a9` — the hash this project already
confirmed — the sparse-set walk, then `movq 0x8(%rax,%rdx),%rcx`, the vptr, and
`movq 0xc8(%rax),%rax`. Same member, same slot as 2024.

**Route 3 — the pair, which is what actually gives `getArmorContainer`.** In
`.pdata`, `getHandContainer` (`0x1acb800`, 217 bytes) is immediately followed by
a **218**-byte function, then by `getAllArmor`. The two differ in one
instruction and one byte, exactly as 2024's 44/45 pair does:

```
0x1acb800 (getHandContainer, confirmed)   ...  movq (%rax,%rdx),%rax     ; component+0
0x1acb8e0 (getArmorContainer)             ...  movq 0x8(%rax,%rdx),%rax  ; component+8
```

Their first 100 bytes are identical to each other, and each build's is identical
to the other build's.

## `getArmorCoverPercentage` has no out-of-line copy

Two searches, both empty on both builds:

* no caller of `getAllArmor` contains `cvtdq2ps` (the int-to-float the body
  needs) — on 2024 the same search picks `getArmorCoverPercentage` out of the 17
  immediately;
* no function in the whole image contains both `cvtdq2ps` (or `mulss`) and
  `fnv1a("ActorEquipmentComponent")`, which is what an inlined-`getAllArmor`
  version would look like.

So it ships as `derived()`: the slots of `getArmorContainer(ctx)`, 0.25 for each
one whose `isNull()` is false. That is the 2024 body written out, over the same
container the binary would have walked.

## What the console proved

`itemprobe armor <n>` in `tools/item-probe.ts`; drivers `armor40.ps1` /
`armor51.ps1`. Both builds **32/32 PASS, tsc 0, exit 0, `Quit correctly`**
(`work/host-runs/armor40-20260921-190351.txt`, `armor51-...`).

The console equips one piece at a time and tells the probe how many it has put
on. Three readings that do not share a path have to agree with that number:

| console | slots bdsx reads | `getArmorCoverPercentage()` | BDS's own `getArmorValue()` |
|---|---|---|---|
| `clear @a` | 0 of 5 | 0 | 0 |
| + diamond helmet | 1 | 0.25 | 3 |
| + chestplate | 2 | 0.5 | 11 |
| + leggings | 3 | 0.75 | 17 |
| + boots | 4 | 1.0 | 20 |
| + **shield in the offhand** | **4** | **1.0** | **20** |
| helmet off | 3 | 0.75 | 17 |
| `clear @a` | 0 | 0 | 0 |

Identical on both builds. The items read back by name and in slot order
(`Diamond Helmet(350)`, `Chestplate(351)`, `Leggings(352)`, `Boots(353)`), the
container is a different pointer from `getHandContainer`'s with the same
`SimpleContainer` vftable, and the shield row is the negative control that
separates the two members: a wrong `+0`/`+8` would have made the offhand count.

**1.26's armour container has five slots, not four.** Every reading above says
`of 5`. It changes nothing here — the 2024 body counts whatever `getSlots()`
returns, and so does bdsx — but a fifth piece would read 1.25, and that is what
the binary would have returned too.
