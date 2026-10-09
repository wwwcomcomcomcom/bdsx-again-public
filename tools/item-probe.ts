// Container::getItem and the hand container (docs/findings-containers.md, next-steps Q1-B).
//
// `Container.prototype.getItem` threw on both 1.26 builds until now -- neither
// `??_7SimpleContainer@@6B@` nor `?getItem@SimpleContainer@@` had an address -- so a plugin had no
// way to read an item at all. This checks the seam end to end, in the direction that cannot be
// faked: **BDS writes, bdsx reads**. The offhand is the slot to use, because it lives in the
// ActorEquipment hand container itself (two slots: 0 mainhand, 1 offhand) rather than in
// PlayerInventory, and because `replaceitem` and `clear` move it from the console.
//
// What each step would catch:
//   base   the vftable is wrong or slot 7 is not getItem  -> a fault or a nonsense pointer, and
//          getOffhandSlot() (bdsx's own derived getHandContainer(ctxbase)->getItem(1)) must be the
//          very same address as getItem(1)
//   shield the address is right but reads the wrong slot  -> isNull stays true after replaceitem
//   clear  it reads a stale copy rather than the container -> isNull stays false after clear
//   slots  `?getSlots@Container@@` was three slots late (it was firstEmptySlot, which takes no
//          argument and returns an int, so the sret vector came back uninitialised); the corrected
//          slot 25 must give a two-element vector of pointers equal to getItem(0) and getItem(1)
//   count  `?getItemCount@Container@@` was three slots late in the same way (it was
//          findFirstSlotForItem, which returns a slot index, not a count)
//
//   aux/blockaux  ItemStackBase::getAuxValue / getId / getItem, which 1.26 inlined away: bdsx reads
//          +32 aux_, +24 block_ -> Block::data_ (+288, was +40) and +8 item_ -> Item::id_ (+170, was
//          +162), and the id has to be the one BDS's own toString prints (next-steps Q1-B-2)
//   pinv/pinvwrite  the PlayerInventory forwarders bdsx now carries itself (next-steps Q1-B-3):
//          getItem/getSelectedItem/getContainerSize/getFirstEmptySlot/getHotbarSize reading, then
//          setItem/add/clearSlot/setSelectedItem writing, with BDS's Player::getSelectedItem reading back
//   pinvslots/pinvsel/pinvremove  the four Q1-B-3 left open: FillingContainer::getSlotWithItem
//          (both of its paths -- the selected slot first, then the scan -- and -1 for an item the
//          container does not hold), ::swapSlots, PlayerInventory::selectSlot (bdsx writes
//          selected_ and BDS's own Player::getSelectedItem reads it back, and the hotbar bound
//          check refuses 9 and -1), and ::removeResource with a template item held in the offhand
//
//   armor <n>  the armour container (a new address) and Mob::getArmorCoverPercentage (bdsx's own
//          code on it): <n> is how many pieces the console has just put on
//
//   damage <pre|hit>  ItemStackBase::getDamageValue (next-steps Q1-B-2), bdsx's own code now (no
//          1.26 address for it or for the helper it tail-called): reads the armour of the zombie
//          tagged bdsxdmgtest (found by walking the small test world, not an entityHurt hook --
//          see the case body), wants 0 before the console damages it and above 0 after
//
//   ui/uiender/uiset/uidead/device <id>  the three Player members bdsx declares, moved in 1.26
//          (playerUIContainer +2232, enderChestContainer +2064, deviceId +3208), and the UI-slot
//          functions on top of them (docs/findings-containers.md, 13): each member's vptr is its class's
//          table; BDS's `replaceitem ... slot.enderchest` is what bdsx reads; bdsx puts the inventory's
//          apples on the cursor through BDS's own setPlayerUIItem and empties the inventory, and after
//          `kill @a` BDS's own Player::die has read the cursor, dropped it (testfor @e[type=item] on the
//          console) and cleared it; the device id is the one the bot's login chain carried
//
//   stacksize <n>/damageable <true|false>  ItemStackBase::getMaxStackSize / isDamageableItem
//          (next-steps Q1-B-4, docs/findings-containers.md 10): both bdsx's own code now, Item
//          vtable slot 100/14 dispatched through the item_ chase, getMaxStackSize additionally
//          through ItemStackBase::getDescriptor (a new resolved address). Run after a
//          clear+give cycle through items with known values.
//
// Deployed as zz-itemprobe.ts; console: "itemprobe clone <full name|empty>|fromdesc <full name|empty>|descriptor <full name|empty>|base|shield|clear|slots|count|give|aux|blockaux|pinv|pinvwrite|pinvslots|pinvsel|pinvremove|armor <n>|ui|uiender|uiset|uidead|device <id>|compid|sendarmor <head|torso|chest|legs|feet>|sendarmortick <slot>|getarmorold (crashes on purpose)|stacksize <n>|damageable <true|false>|stackable|stackaux|stackmatch|stackcount|construct|constructcount|constructgone|creative|enchantbds|enchantcurse|enchant".
import { AllocatedPointer, NativePointer, VoidPointer } from "bdsx/core";
import { Actor, ActorType, Mob } from "bdsx/bds/actor";
import { bedrockServer } from "bdsx/launcher";
import { Player } from "bdsx/bds/player";
import { ArmorSlot, ComponentItem, ContainerId, CreativeItemCategory, ItemDescriptor, ItemStack, ItemStackBase, NetworkItemStackDescriptor, SimpleContainer } from "bdsx/bds/inventory";
import {
    ArmorItemComponent,
    CooldownItemComponent,
    DiggerItemComponent,
    DisplayNameItemComponent,
    DurabilityItemComponent,
    EntityPlacerItemComponent,
    FoodItemComponent,
    FuelItemComponent,
    IconItemComponent,
    OnUseItemComponent,
    PlanterItemComponent,
    ProjectileItemComponent,
    RecordItemComponent,
    RenderOffsetsItemComponent,
    RepairableItemComponent,
    ShooterItemComponent,
    ThrowableItemComponent,
    WeaponItemComponent,
    WearableItemComponent,
} from "bdsx/bds/item_component";
import { events } from "bdsx/event";
import { CommandResultType } from "bdsx/commandresult";
import { MinecraftPacketIds } from "bdsx/bds/packetids";
import type { InventorySlotPacket } from "bdsx/bds/packets";
import { procHacker } from "bdsx/prochacker";
import { bool_t, CxxString, int32_t, NativeType } from "bdsx/nativetype";
import { pdbcache } from "bdsx/pdbcache";
import { proc } from "bdsx/bds/symbols";
import { Block, BlockActor, BlockActorType, BlockLegacy } from "bdsx/bds/block";
import { blockFriction } from "bdsx/bds/engine/blocktype";
import { BlockPos, ChunkBlockPos, Vec3 } from "bdsx/bds/blockpos";
import { itemBlockType, itemFullName, itemRawNameId } from "bdsx/bds/engine/item";
import { CreativeItemCategoryFromString } from "bdsx/bds/implements";
import { makefunc } from "bdsx/makefunc";
import { dllraw } from "bdsx/dllraw";
import { asm, Register } from "bdsx/assembler";
import { EnchantmentNames, EnchantUtils, ItemEnchants } from "bdsx/bds/enchants";
import { CompoundTag, NBT } from "bdsx/bds/nbt";
import type { CxxVector } from "bdsx/cxxvector";
import type { StaticPointer } from "bdsx/core";

// BlockLegacy's HashedString name (docs/findings-blocks.md); its std::string is eight bytes in.
const BlockLegacy$name = (pdbcache.layouts.BlockLegacy?.name ?? 0x98) + 8;
function legacyNames(v: CxxVector<BlockLegacy>): string[] {
    const out: string[] = [];
    for (let i = 0; i < v.size(); i++) {
        const b = v.get(i);
        if (b === null) { out.push("<null>"); continue; }
        try { out.push((b as any as StaticPointer).getCxxString(BlockLegacy$name)); } catch (err) { out.push(`<${(err as Error).message}>`); }
    }
    return out;
}

let player: Player | null = null;
events.playerJoin.on(ev => {
    player = ev.player;
});
events.playerLeft.on(() => {
    player = null;
});

const TAG = "[item]";
// OffhandContainerValidation's vftable slot 2 (the "offhand" step): this, slot, unused, the stack (r9), through the object's own table
const OffhandValidation$valid = makefunc.js(
    asm().mov_r_rp(Register.rax, Register.rcx, 1, 0).jmp_rp(Register.rax, 1, 2 * 8).alloc("OffhandContainerValidation::valid via vft[2]"),
    bool_t,
    null,
    VoidPointer,
    int32_t,
    VoidPointer,
    ItemStackBase,
);
function check(step: string, cond: boolean, detail: string): void {
    console.log(`${TAG} ${cond ? "PASS" : "FAIL"} ${step}: ${detail}`);
}
/** The address. `${item}` would call ItemStackBase::toString, which is the game's, not the pointer's. */
function addr(p: VoidPointer | null): string {
    return p === null ? "null" : `0x${p.getAddressHigh().toString(16)}${p.getAddressLow().toString(16).padStart(8, "0")}`;
}
/** The first inventory slot whose item prints with `sub` in its name. */
function findSlot(p: Player, sub: string): ItemStack | null {
    const c = p.getInventory().container;
    for (let i = 0; i < 36; i++) {
        const it = c.getItem(i);
        if (!it.isNull() && it.toString().toLowerCase().includes(sub)) return it;
    }
    return null;
}
/** Whatever the item prints as, without letting a missing symbol fail the step. */
function describe(item: ItemStack | null): string {
    if (item === null) return "null";
    let s = addr(item);
    try {
        s += ` isNull=${item.isNull()}`;
    } catch (err) {
        s += ` isNull=<${(err as Error).message}>`;
    }
    try {
        s += ` "${item.toString()}"`;
    } catch (err) {
        s += ` toString=<${(err as Error).message}>`;
    }
    return s;
}

// ItemDescriptor (the "descriptor" step): getDescriptor as implements.ts binds it, and BaseDescriptor::getFullName, vftable
// slot 3 on both builds (40 0x2533ab0 / 51 0x1adacd0 for InternalItemDescriptor: copies Item::full_name_'s string into
// the sret -- by value in 1.26, where 2024 returned a const reference).
const ItemStackBase$getDescriptor = procHacker.js("?getDescriptor@ItemStackBase@@QEBA?AVItemDescriptor@@XZ", ItemDescriptor, {
    this: ItemStackBase,
    structureReturn: true,
});
const BaseDescriptor$getFullNameRaw = makefunc.js(
    asm().mov_r_rp(Register.rax, Register.rcx, 1, 0).jmp_rp(Register.rax, 1, 0x18).alloc("BaseDescriptor::getFullName via vft[3]"),
    CxxString,
    { this: VoidPointer, structureReturn: true },
);
// BlockSource::areChunksFullyLoaded(BlockPos const&, int): vftable slot 55 on both 1.26 builds (the "chunkloaded" step)
const BlockSource$areChunksFullyLoaded = makefunc.js(
    asm().mov_r_rp(Register.rax, Register.rcx, 1, 0).jmp_rp(Register.rax, 1, 55 * 8).alloc("BlockSource::areChunksFullyLoaded via vft[55]"),
    bool_t,
    null,
    VoidPointer,
    BlockPos,
    int32_t,
);
// IVanillaMainBlockActorComponent::isChanged, slot 23 of the interface's vftable on both builds (the "changed" step): the
// engine's own reader of the Changed bit, called on the interface sub-object (40 0x461c0b0 / 51 0x4885e10)
const VanillaMain$isChanged = makefunc.js(
    asm().mov_r_rp(Register.rax, Register.rcx, 1, 0).jmp_rp(Register.rax, 1, 23 * 8).alloc("IVanillaMainBlockActorComponent::isChanged via vft[23]"),
    bool_t,
    null,
    VoidPointer,
);
function BaseDescriptor$getFullName(impl: VoidPointer): string {
    return BaseDescriptor$getFullNameRaw.call(impl);
}

events.command.on(cmd => {
    const m = cmd.replace(/^\//, "").match(/^itemprobe(?:\s+(\S+))?(?:\s+(\S+))?$/);
    if (m === null) return;
    const step = m[1] ?? "base";
    const arg = m[2] ?? "";
    const p = player;
    if (p === null) {
        console.log(`${TAG} FAIL ${step}: no player has joined`);
        return;
    }
    let hc: SimpleContainer;
    try {
        hc = p.getHandContainer();
    } catch (err) {
        console.log(`${TAG} FAIL ${step}: getHandContainer threw ${(err as Error).message}`);
        return;
    }
    try {
        switch (step) {
            case "base": {
                console.log(`${TAG} INFO base container=${addr(hc)} vftable=${addr(hc.vftable)}`);
                const main = hc.getItem(0);
                const off = hc.getItem(1);
                console.log(`${TAG} INFO base slot0=${describe(main)}`);
                console.log(`${TAG} INFO base slot1=${describe(off)}`);
                check("base", !main.equalsptr(off), `getItem(0)=${addr(main)} and getItem(1)=${addr(off)} are two distinct slots`);
                const derivedOff = p.getOffhandSlot();
                check("base-offhand", derivedOff.equalsptr(off), `getOffhandSlot()=${addr(derivedOff)} vs the container's slot 1 ${addr(off)}`);
                break;
            }
            case "shield": {
                // after: replaceitem entity @a slot.weapon.offhand 0 shield 1
                const off = p.getOffhandSlot();
                console.log(`${TAG} INFO shield offhand=${describe(off)}`);
                check("shield", !off.isNull(), "the offhand BDS just filled reads as non-null");
                check("shield-empty", !hc.isEmpty(), "Container::isEmpty() is false while the hand container holds one item");
                break;
            }
            case "count": {
                const off = p.getOffhandSlot();
                const n = hc.getItemCount(off);
                check("count", n === 1, `Container::getItemCount(offhand) = ${n} (one shield in the two-slot hand container)`);
                break;
            }
            case "slots": {
                const v = hc.getSlots();
                const size = v.size();
                const list: string[] = [];
                for (let i = 0; i < size; i++) list.push(addr(v.get(i)));
                const first = size > 0 ? v.get(0) : null;
                const second = size > 1 ? v.get(1) : null;
                const ok = size === 2 && first !== null && second !== null && first.equalsptr(hc.getItem(0)) && second.equalsptr(hc.getItem(1));
                v.destruct();
                console.log(`${TAG} INFO slots size=${size} [${list.join(", ")}]`);
                check("slots", ok, `Container::getSlots() gives ${size} pointers and they are getItem(0) and getItem(1)`);
                break;
            }
            case "clear": {
                // after: clear @a
                const off = p.getOffhandSlot();
                console.log(`${TAG} INFO clear offhand=${describe(off)}`);
                check("clear", off.isNull(), "the offhand BDS just cleared reads as null");
                check("clear-empty", hc.isEmpty(), "Container::isEmpty() is true once the hand container is empty");
                break;
            }
            case "give": {
                // after: give @a diamond_sword 1 -- informational. For a player the mainhand is
                // kept by PlayerInventory, and whether the equipment container mirrors it is
                // exactly what has never been measured here.
                const main = hc.getItem(0);
                console.log(`${TAG} INFO give slot0=${describe(main)}`);
                try {
                    const carried = p.getCarriedItem();
                    console.log(`${TAG} INFO give carried=${describe(carried)} sameAsSlot0=${carried.equalsptr(main)}`);
                } catch (err) {
                    console.log(`${TAG} INFO give getCarriedItem threw ${(err as Error).message}`);
                }
                try {
                    console.log(`${TAG} INFO give selected=${describe(p.getSelectedItem())}`);
                } catch (err) {
                    console.log(`${TAG} INFO give getSelectedItem threw ${(err as Error).message}`);
                }
                break;
            }
            case "inv":
            case "invclear": {
                // PlayerInventory, reached through the `?getSupplies@Player@@` accessor (Player+1464)
                // and its `container` at +184 -- 2024's +192 minus the eight bytes sizeof(ItemStack)
                // lost. `inv` runs after `give @a diamond_sword 1`, `invclear` after `clear @a`.
                const filled = step === "inv";
                const inv = p.getInventory();
                const slot = inv.getSelectedSlot();
                const c = inv.container;
                console.log(`${TAG} INFO ${step} supplies=${addr(inv)} container=${addr(c)} vftable=${addr(c.vftable)} selectedSlot=${slot}`);
                const it = c.getItem(slot);
                console.log(`${TAG} INFO ${step} selected=${describe(it)}`);
                check(step, it.isNull() !== filled, `the selected inventory slot reads as ${filled ? "non-null after give" : "null after clear"}`);
                check(`${step}-empty`, c.isEmpty() !== filled, `Inventory::isEmpty() is ${!filled} ${filled ? "while it holds the sword" : "once it is cleared"}`);
                break;
            }
            case "can":
            case "cantagged": {
                // ItemStackBase's tail (next-steps Q1-B-1, docs/findings-containers.md 10).
                // 1.26 moved show_pick_up_/was_picked_up_ ahead of pick_up_time_, so can_place_on_
                // sits at +48 and can_destroy_ at +80 where 2024 had +56 and +88. Reading at the
                // 2024 offsets lands on the *next* vector member -- begin reads what is really
                // `end`, end reads `capacity`. `can` is the plain item (both vectors empty),
                // `cantagged` follows a replaceitem carrying can_destroy=["minecraft:dirt"] and
                // can_place_on=["minecraft:dirt","minecraft:stone"].
                const off = p.getOffhandSlot();
                const place = off.canPlaceOn;
                const destroy = off.canDestroy;
                const pn = legacyNames(place);
                const dn = legacyNames(destroy);
                console.log(`${TAG} INFO ${step} item=${describe(off)} canPlaceOn(${pn.length})=[${pn.join(", ")}] canDestroy(${dn.length})=[${dn.join(", ")}]`);
                if (step === "can") {
                    check("can", pn.length === 0 && dn.length === 0, `an item BDS gave no components has both vectors empty (${pn.length}, ${dn.length})`);
                    break;
                }
                // A count alone proves nothing here -- one command name expands to every legacy block
                // that answers to it ("dirt" is two, "stone" is seven). What the command does fix is
                // the *content*: can_destroy got ["dirt"], can_place_on got ["dirt","stone"], so the
                // second vector must contain the whole of the first and something more, and the
                // names must be the ones typed at the console. Reading either vector at 2024's
                // offset lands on the next member (begin reads `end`, end reads `capacity`) and
                // cannot produce that.
                const contained = dn.length > 0 && destroy.size() > 0 && (() => {
                    for (let i = 0; i < destroy.size(); i++) {
                        const d = destroy.get(i);
                        let found = false;
                        for (let j = 0; j < place.size(); j++) {
                            const q = place.get(j);
                            if (d !== null && q !== null && d.equalsptr(q)) { found = true; break; }
                        }
                        if (!found) return false;
                    }
                    return true;
                })();
                check("can-destroy", dn.length > 0 && dn.every(n => n.includes("dirt")), `can_destroy_ holds the blocks "minecraft:dirt" names and nothing else: [${dn.join(", ")}]`);
                check("can-placeon", contained && pn.length > dn.length && pn.some(n => n.includes("stone")), `can_place_on_ holds every block can_destroy_ holds plus the stone ones: [${pn.join(", ")}]`);
                break;
            }
            case "armor": {
                // next-steps Q1 0 A-2, docs/findings-armor.md. Two new things at once:
                // `?getArmorContainer@ActorEquipment@@` is an address (the one-instruction sibling
                // of the execution-confirmed getHandContainer -- the component's member at +8
                // rather than at +0), and Mob::getArmorCoverPercentage is bdsx's own code on top of
                // it, because 1.26 has no out-of-line copy of it at all.
                // The console says how many pieces it has just put on, and three things that do not
                // share a path have to agree with it: the slots bdsx reads out of the container,
                // the percentage bdsx computes, and **BDS's own Mob::getArmorValue**.
                const want = Number(arg);
                const ac = p.getArmorContainer();
                const slots = ac.getSlots();
                const size = slots.size();
                const list: string[] = [];
                let worn = 0;
                for (let i = 0; i < size; i++) {
                    const it = slots.get(i);
                    if (it === null) {
                        list.push(`${i}:<null pointer>`);
                        continue;
                    }
                    const empty = it.isNull();
                    if (!empty) worn++;
                    list.push(`${i}:${empty ? "empty" : it.toString()}`);
                }
                slots.destruct();
                const pct = p.getArmorCoverPercentage();
                const value = p.getArmorValue();
                console.log(`${TAG} INFO armor container=${addr(ac)} hand=${addr(hc)} vftable=${addr(ac.vftable)} size=${size} [${list.join(", ")}]`);
                console.log(`${TAG} INFO armor want=${want} worn=${worn} percentage=${pct} bdsArmorValue=${value}`);
                check(
                    "armor-container",
                    !ac.equalsptr(hc) && ac.vftable.equalsptr(hc.vftable),
                    `the armour container ${addr(ac)} is a different SimpleContainer from the hand container ${addr(hc)}, with the same vftable ${addr(ac.vftable)}`,
                );
                check("armor-slots", worn === want && size >= want, `the container holds the ${want} piece(s) the console just put on (${worn} non-empty of ${size} slots)`);
                check("armor-pct", Math.abs(pct - want * 0.25) < 1e-6, `getArmorCoverPercentage() is ${pct}, and ${want} piece(s) * 0.25 is ${want * 0.25}`);
                check(
                    "armor-bds",
                    want === 0 ? value === 0 : value > 0,
                    `BDS's own Mob::getArmorValue() is ${value}, ${want === 0 ? "zero with nothing worn" : "above zero with armour on"}`,
                );
                break;
            }
            case "size": {
                // sizeof(ItemStack) measured on BDS's own storage: SimpleContainer::getItem is
                // `items.begin() + index * sizeof(ItemStack)`, so the gap between slot 0 and slot 1
                // of the two-slot hand container is the stride the game compiled in.
                // Not the hand container: its slot 0 is the selected inventory item and slot 1 is
                // the equipment container's own, so the two are not one array. The player's
                // inventory is -- FillingContainer::getItem is `items.begin() + index * 152`.
                const inv = p.getInventory().container;
                const stride = inv.getItem(1).subptr(inv.getItem(0));
                const declaredStack = (ItemStack as any)[NativeType.size];
                const declaredBase = (ItemStackBase as any)[NativeType.size];
                console.log(`${TAG} INFO size bdsx sizeof(ItemStackBase)=${declaredBase} sizeof(ItemStack)=${declaredStack} live stride=${stride}`);
                check("size", stride === declaredStack, `the container's own element stride ${stride} is what bdsx declares for ItemStack (${declaredStack})`);
                check("size-base", declaredBase === 128, `sizeof(ItemStackBase) is 128 on 1.26 (2024: 136), got ${declaredBase}`);
                break;
            }
            case "aux": {
                // next-steps Q1-B-2. For a non-block item `block_` (+24) is null and getAuxValue() is
                // `aux_` (+32) itself; the step is run after several `give`s because 1.26's `give`
                // resolves most legacy data values into a block or item of their own and leaves aux 0.
                // getId() has to agree with the id BDS's own ItemStackBase::toString prints as
                // "Name(id)@aux" -- that is the compiled read of Item::id_, ours reads layouts.Item.id.
                const inv = p.getInventory();
                const it = inv.container.getItem(inv.getSelectedSlot());
                const text = it.toString();
                console.log(`${TAG} INFO aux selected=${describe(it)}`);
                const item = it.getItem();
                check("aux-getitem", item !== null, `ItemStackBase::getItem() returns an Item for the item BDS gave (${item === null ? "null" : addr(item as any)})`);
                const m2 = text.match(/\((-?\d+)\)@(-?\d+)/);
                if (m2 === null) {
                    check("aux", false, `toString() did not print "Name(id)@aux": ${text}`);
                } else {
                    check("aux", it.getAuxValue() === +m2[2], `getAuxValue() ${it.getAuxValue()} is the aux BDS's own toString prints (${m2[2]})`);
                    check("aux-id", it.getId() === +m2[1], `getId() ${it.getId()} is the id BDS's own toString prints (${m2[1]})`);
                }
                break;
            }
            case "blockaux": {
                // The other branch of the same body: for a block item `block_` is not null and
                // getAuxValue() reads `block_->data_`, the offset that moved 40 -> 288 in 1.26.
                // `give @a stone 1 1` is granite, legacy data 1.
                const inv = p.getInventory();
                const it = inv.container.getItem(inv.getSelectedSlot());
                const text = it.toString();
                const blk = (it as any as StaticPointer).getNullablePointer(24);
                console.log(`${TAG} INFO blockaux selected=${describe(it)} block=${blk === null ? "null" : addr(blk)}`);
                check("blockaux-block", blk !== null, "a block item carries a Block* in block_ (+24), so getAuxValue() takes the block branch");
                const m2 = text.match(/\((-?\d+)\)@(-?\d+)/);
                if (m2 === null) {
                    check("blockaux", false, `toString() did not print "Name(id)@aux": ${text}`);
                } else {
                    check("blockaux", it.getAuxValue() === +m2[2], `getAuxValue() ${it.getAuxValue()} reads Block::data_ and is the aux BDS prints (${m2[2]})`);
                    check("blockaux-id", it.getId() === +m2[1], `getId() ${it.getId()} is the id BDS prints (${m2[1]})`);
                }
                break;
            }
            case "damage": {
                // next-steps Q1-B-2: ItemStackBase::getDamageValue, now bdsx's own code (no 1.26
                // address exists for it or for the helper it used to tail-call -- see the comment
                // above the derived() call in bds/implements.ts). "Damage" is durability, driven
                // here by BDS's own damage pipeline against a mob wearing one armour piece, not by
                // anything bdsx wrote: `pre` wants a freshly-equipped, unhit piece at 0; `hit` wants
                // it above 0 after the console's own `/damage ... entity_attack` calls.
                //
                // The subject is found by tag (`bdsxdmgtest`, set by the driver right after
                // `summon`), not by an entityHurt hook: the smoketest world keeps its own
                // golem-vs-zombie combat going in the background (night, difficulty normal, left
                // over from other drivers), so a hook that captures "the last non-player hit" gets
                // overwritten by that combat and, worse, `@e[type=zombie,c=1]` in the driver's own
                // commands can address a *different* zombie than the one just summoned unless every
                // command anchors on the player's position (`execute as @a at @s run ...`). Walking
                // `level.getEntities()` once here is the same proven, small-world-only pattern
                // `actor-layout-probe.ts`'s `entityctx` step uses (never on a world-sized container,
                // docs/findings-reach.md).
                let mob: Actor | null = null;
                for (const e of bedrockServer.level.getEntities()) {
                    try {
                        if (e.getIdentifier() === "minecraft:zombie" && e.hasTag("bdsxdmgtest")) {
                            mob = e;
                            break;
                        }
                    } catch (err) {
                        /* an entity mid-removal can throw reading its own fields; skip it */
                    }
                }
                if (mob === null) {
                    console.log(`${TAG} FAIL damage: no zombie tagged bdsxdmgtest found in the world`);
                    break;
                }
                const ac = mob.getArmorContainer();
                const slots = ac.getSlots();
                let target: ItemStack | null = null;
                let targetSlot = -1;
                for (let i = 0; i < slots.size(); i++) {
                    const it = slots.get(i);
                    if (it !== null && !it.isNull()) {
                        target = it;
                        targetSlot = i;
                        break;
                    }
                }
                slots.destruct();
                if (target === null) {
                    console.log(`${TAG} FAIL damage: the captured mob wears nothing in its armour container`);
                    break;
                }
                const dv = target.getDamageValue();
                console.log(`${TAG} INFO damage mob=${addr(mob as any)} slot=${targetSlot} piece=${describe(target)} getDamageValue=${dv} arg=${arg}`);
                if (arg === "pre") {
                    check("damage-pre", dv === 0, `a freshly-equipped, unhit piece reads getDamageValue()=0`);
                } else if (arg === "hit") {
                    check("damage-hit", dv > 0, `after BDS's own damage pipeline the piece's getDamageValue() is ${dv} (want > 0)`);
                } else {
                    console.log(`${TAG} FAIL damage: unknown arg "${arg}", want pre|hit`);
                }
                break;
            }
            case "pinv": {
                // next-steps Q1-B-3, the PlayerInventory forwarders, reading. After `clear @a`,
                // `give @a diamond_sword 1 5` (slot 0, selected) and `give @a apple 3` (slot 1).
                const inv = p.getInventory();
                const slot = inv.getSelectedSlot();
                const viaContainer = inv.container.getItem(slot);
                const viaSelected = inv.getSelectedItem();
                const viaGetItem = inv.getItem(slot, ContainerId.Inventory);
                const viaBds = p.getSelectedItem();
                console.log(`${TAG} INFO pinv slot=${slot} container=${addr(viaContainer)} selected=${addr(viaSelected)} getItem=${addr(viaGetItem)} bds=${addr(viaBds)}`);
                check(
                    "pinv-selected",
                    viaSelected.equalsptr(viaContainer) && viaSelected.equalsptr(viaBds),
                    "PlayerInventory::getSelectedItem() is the container's selected slot and the address BDS's own Player::getSelectedItem returns",
                );
                check("pinv-getitem", viaGetItem.equalsptr(viaContainer), "PlayerInventory::getItem(slot, Inventory) is that same slot");
                const empty = inv.getItem(slot, ContainerId.Offhand);
                console.log(`${TAG} INFO pinv empty=${addr(empty)} isNull=${empty.isNull()}`);
                check("pinv-empty", !empty.equalsptr(viaContainer) && empty.isNull(), `a non-Inventory ContainerID gives ItemStack::EMPTY_ITEM (${addr(empty)}) and it reads as null`);
                const size = inv.getContainerSize(ContainerId.Inventory);
                console.log(`${TAG} INFO pinv size=${size} other=${inv.getContainerSize(ContainerId.Offhand)} hotbar=${inv.getHotbarSize()}`);
                check("pinv-size", size === 36, `getContainerSize(Inventory) is the survival inventory size 36, got ${size}`);
                check("pinv-size-other", inv.getContainerSize(ContainerId.Offhand) === 0, `a non-Inventory ContainerID gives 0, got ${inv.getContainerSize(ContainerId.Offhand)}`);
                check("pinv-hotbar", inv.getHotbarSize() === 9, `getHotbarSize() is 9, got ${inv.getHotbarSize()}`);
                const first = inv.getFirstEmptySlot();
                const prevFilled = first > 0 && !inv.container.getItem(first - 1).isNull();
                console.log(`${TAG} INFO pinv firstEmpty=${first} slot0null=${inv.container.getItem(0).isNull()} slot1null=${inv.container.getItem(1).isNull()}`);
                check("pinv-first", first > 0 && inv.container.getItem(first).isNull() && prevFilled, `getFirstEmptySlot() ${first} is empty and the slot before it is not`);
                break;
            }
            case "pinvwrite": {
                // The same forwarders writing, read back by BDS itself where it can be.
                const inv = p.getInventory();
                const sword = inv.container.getItem(0);
                const apple = inv.getItem(1, ContainerId.Inventory);
                const swordId = sword.getId();
                const appleId = apple.getId();
                check("pinvwrite-canadd", inv.canAdd(sword), "canAdd(sword) is true while the inventory still has room");
                inv.setItem(9, sword, ContainerId.Inventory, true);
                const at9 = inv.container.getItem(9);
                console.log(`${TAG} INFO pinvwrite slot9=${describe(at9)}`);
                check(
                    "pinvwrite-setitem",
                    !at9.isNull() && at9.getId() === swordId && at9.getAuxValue() === sword.getAuxValue(),
                    `setItem(9, sword, Inventory, true) put a copy of the sword in slot 9 (id ${at9.getId()}, aux ${at9.getAuxValue()})`,
                );
                // add() takes a non-const ItemStack& and moves it, so feed it the copy in slot 9:
                // it must land in the first empty slot and leave slot 9 empty.
                const target = inv.getFirstEmptySlot();
                inv.addItem(at9, true);
                const moved = inv.container.getItem(target);
                console.log(`${TAG} INFO pinvwrite target=${target} moved=${describe(moved)} slot9null=${inv.container.getItem(9).isNull()}`);
                check("pinvwrite-add", !moved.isNull() && moved.getId() === swordId, `add(copy, true) put it in the first empty slot ${target} (id ${moved.getId()})`);
                inv.clearSlot(target, ContainerId.Inventory);
                check("pinvwrite-clear", inv.container.getItem(target).isNull(), `clearSlot(${target}, Inventory) emptied it again`);
                // bdsx writes the selected slot; BDS's own Player::getSelectedItem reads it back
                inv.setSelectedItem(apple);
                const back = p.getSelectedItem();
                console.log(`${TAG} INFO pinvwrite selected=${describe(back)}`);
                check(
                    "pinvwrite-setselected",
                    appleId !== swordId && back.getId() === appleId,
                    `setSelectedItem(apple) put the apple where the sword was, and BDS's own Player::getSelectedItem reads it back (id ${back.getId()}, apple ${appleId}, sword ${swordId})`,
                );
                break;
            }
            case "pinvslots": {
                // next-steps Q1-B-3. After `clear @a`, `give @a diamond_sword 1` (slot 0, the
                // selected one), `give @a apple 3` (slot 1) and an emerald put in the offhand --
                // a live ItemStack that this container does not hold.
                const inv = p.getInventory();
                const sword = inv.container.getItem(0);
                const apple = inv.container.getItem(1);
                const swordId = sword.getId();
                const appleId = apple.getId();
                const other = p.getOffhandSlot();
                console.log(`${TAG} INFO pinvslots slot0=${describe(sword)} slot1=${describe(apple)} offhand=${describe(other)}`);
                check(
                    "pinvslots-setup",
                    !sword.isNull() && !apple.isNull() && !other.isNull() && swordId !== appleId && other.getId() !== swordId && other.getId() !== appleId,
                    `three distinct items: sword ${swordId}, apple ${appleId}, offhand ${other.getId()}`,
                );
                const sel = inv.getSelectedSlot();
                const atSword = inv.getSlotWithItem(sword, true, false);
                const atApple = inv.getSlotWithItem(apple, true, false);
                const atOther = inv.getSlotWithItem(other, true, false);
                console.log(`${TAG} INFO pinvslots selected=${sel} sword@${atSword} apple@${atApple} offhand@${atOther}`);
                check("pinvslots-selected", sel === 0 && atSword === 0, `getSlotWithItem(sword) takes the selected-slot path and answers 0, got ${atSword} with selected ${sel}`);
                check("pinvslots-scan", atApple === 1, `getSlotWithItem(apple) falls through to the scan and answers 1, got ${atApple}`);
                check("pinvslots-absent", atOther === -1, `getSlotWithItem(an item this container does not hold) is -1, got ${atOther}`);
                inv.swapSlots(0, 1);
                const a0 = inv.container.getItem(0);
                const a1 = inv.container.getItem(1);
                console.log(`${TAG} INFO pinvslots swapped slot0=${describe(a0)} slot1=${describe(a1)}`);
                check(
                    "pinvslots-swap",
                    a0.getId() === appleId && a0.getAmount() === 3 && a1.getId() === swordId,
                    `swapSlots(0,1) moved the three apples to slot 0 (id ${a0.getId()} x${a0.getAmount()}) and the sword to slot 1 (id ${a1.getId()})`,
                );
                const f0 = inv.getSlotWithItem(a0, true, false);
                const f1 = inv.getSlotWithItem(a1, true, false);
                check("pinvslots-follow", f0 === 0 && f1 === 1, `getSlotWithItem follows the swap: apples at ${f0}, sword at ${f1}`);
                inv.swapSlots(0, 1);
                const b0 = inv.container.getItem(0);
                const b1 = inv.container.getItem(1);
                check(
                    "pinvslots-swapback",
                    b0.getId() === swordId && b1.getId() === appleId && b1.getAmount() === 3,
                    `swapping back restored the sword to slot 0 (id ${b0.getId()}) and the three apples to slot 1 (id ${b1.getId()} x${b1.getAmount()})`,
                );
                break;
            }
            case "pinvsel": {
                // PlayerInventory::selectSlot: bdsx writes selected_, BDS reads it back.
                const inv = p.getInventory();
                const swordId = inv.container.getItem(0).getId();
                const appleId = inv.container.getItem(1).getId();
                const before = inv.getSelectedSlot();
                inv.selectSlot(1, ContainerId.Inventory);
                const after = inv.getSelectedSlot();
                const bds = p.getSelectedItem();
                console.log(`${TAG} INFO pinvsel before=${before} after=${after} bds=${describe(bds)}`);
                check("pinvsel", before === 0 && after === 1, `selectSlot(1, Inventory) moved selected_ from ${before} to ${after}`);
                check("pinvsel-bds", bds.getId() === appleId, `BDS's own Player::getSelectedItem now returns the apples (id ${bds.getId()}, apple ${appleId}, sword ${swordId})`);
                inv.selectSlot(9, ContainerId.Inventory);
                inv.selectSlot(-1, ContainerId.Inventory);
                const guarded = inv.getSelectedSlot();
                check("pinvsel-bounds", guarded === 1, `selectSlot(9) and selectSlot(-1) are both refused by the hotbar bound check, selected_ is still ${guarded}`);
                inv.selectSlot(0, ContainerId.Inventory);
                const back = p.getSelectedItem();
                check("pinvsel-back", inv.getSelectedSlot() === 0 && back.getId() === swordId, `selectSlot(0) put it back and BDS reads the sword again (id ${back.getId()})`);
                break;
            }
            case "pinvremove": {
                // FillingContainer::removeResource through PlayerInventory, with the template item
                // in the offhand: `replaceitem entity @a slot.weapon.offhand 0 apple 1`.
                const inv = p.getInventory();
                const template = p.getOffhandSlot();
                const slot1 = inv.container.getItem(1);
                const appleId = slot1.getId();
                const beforeCount = slot1.getAmount();
                console.log(`${TAG} INFO pinvremove template=${describe(template)} slot1=${describe(slot1)}`);
                check(
                    "pinvremove-setup",
                    !template.isNull() && template.getId() === appleId && beforeCount === 3,
                    `the offhand holds the same item as inventory slot 1 (id ${appleId}) and the slot holds ${beforeCount}`,
                );
                const left = inv.removeResource(template, true, false, 2);
                const after = inv.container.getItem(1);
                console.log(`${TAG} INFO pinvremove returned=${left} slot1=${describe(after)}`);
                check(
                    "pinvremove",
                    !after.isNull() && after.getId() === appleId && after.getAmount() === beforeCount - 2,
                    `removeResource(apple, true, false, 2) took exactly two of the ${beforeCount} (slot 1 now holds ${after.getAmount()} of id ${after.getId()})`,
                );
                break;
            }
            case "ui": {
                // Each member's vptr must be its own class's table -- a wrong offset lands on
                // something else. PlayerUIContainer's table is SimpleContainer's (the linker folds them).
                const ui = p.playerUIContainer;
                const uiTable = proc["??_7SimpleContainer@@6B@"];
                console.log(`${TAG} INFO ui container=${addr(ui)} vftable=${addr(ui.vftable)} table=${addr(uiTable)}`);
                check("ui-vft", ui.vftable.equalsptr(uiTable), `Player+playerUIContainer holds ??_7SimpleContainer@@6B@ (${addr(ui.vftable)})`);
                const ender = p.enderChestContainer;
                const enderTable = proc["??_7EnderChestContainer@@6B@"];
                console.log(`${TAG} INFO ui ender=${addr(ender)} vftable=${addr(ender.vftable)} table=${addr(enderTable)}`);
                check("ui-ender-vft", ender.vftable.equalsptr(enderTable), `*(Player+enderChestContainer) holds ??_7EnderChestContainer@@6B@ (${addr(ender.vftable)})`);
                const cursor = p.getCursorSelectedItem();
                check("ui-empty", cursor.isNull() && cursor.equalsptr(ui.getItem(0)), `the cursor slot is empty at join and is the container's slot 0 (${addr(cursor)})`);
                break;
            }
            case "uiender": {
                // after `replaceitem entity @a slot.enderchest 0 diamond 5`: BDS wrote, bdsx reads
                const ender = p.enderChestContainer;
                const s0 = ender.getItem(0);
                const s1 = ender.getItem(1);
                console.log(`${TAG} INFO uiender slot0=${describe(s0)} slot1=${describe(s1)}`);
                check("uiender", !s0.isNull() && s0.getAmount() === 5 && /diamond/i.test(s0.toString()) && s1.isNull(), `slot 0 is the five diamonds the console put in the ender chest and slot 1 is empty`);
                break;
            }
            case "uiset": {
                // after `clear @a` + `give @a apple 3`: the apples go on the cursor through BDS's own
                // setPlayerUIItem (bdsx:Player::setPlayerUIItem), then the inventory is emptied, so the
                // cursor is the only place in the player that holds an apple
                const inv = p.getInventory();
                const apples = inv.container.getItem(0);
                const appleId = apples.getId();
                console.log(`${TAG} INFO uiset source=${describe(apples)} via=${"bdsx:Player::setPlayerUIItem" in proc ? "bdsx:Player::setPlayerUIItem" : "SimpleContainer::setItem"}`);
                check("uiset-setup", !apples.isNull() && apples.getAmount() === 3, `inventory slot 0 holds the three apples the console gave (id ${appleId})`);
                p.setCursorSelectedItem(apples);
                inv.clearSlot(0, ContainerId.Inventory);
                const cursor = p.getCursorSelectedItem();
                const raw = p.playerUIContainer.getItem(0);
                console.log(`${TAG} INFO uiset cursor=${describe(cursor)} inv0=${describe(inv.container.getItem(0))}`);
                check("uiset", !cursor.isNull() && cursor.getId() === appleId && cursor.getAmount() === 3 && cursor.equalsptr(raw), `the cursor now holds apple x${cursor.getAmount()} (id ${cursor.getId()}), read through getPlayerUIItem and the container's own getItem alike`);
                check("uiset-inv", inv.container.getItem(0).isNull(), `and inventory slot 0 is empty again`);
                const anvil = p.getPlayerUIItem(1);
                check("uiset-other", anvil.isNull(), `slot 1 (AnvilInput) was not touched`);
                break;
            }
            case "uidead": {
                // after `kill @a`: 1.26's Player::die reads the cursor slot out of Player+2648 (the
                // container's items_), drops it and calls setPlayerUIItem(0, EMPTY_ITEM)
                const cursor = p.getCursorSelectedItem();
                console.log(`${TAG} INFO uidead cursor=${describe(cursor)}`);
                check("uidead", cursor.isNull(), `BDS's Player::die emptied the cursor slot bdsx filled (the drop is the console's testfor @e[type=item])`);
                break;
            }
            case "device": {
                const got = p.deviceId;
                console.log(`${TAG} INFO device got=${JSON.stringify(got)} sent=${JSON.stringify(arg)}`);
                check("device", got === arg, `Player+deviceId reads ${JSON.stringify(got)}; the bot's login chain sent DeviceId ${JSON.stringify(arg)}`);
                break;
            }
            case "compid": {
                // Q3 "다음에 할 것" (1): `<X>ItemComponent::getIdentifier()`, nineteen zero-argument
                // magic-statics accessors, none with a 1.26 out-of-line body -- shipped as derived()
                // (bds/implements.ts, itemComponentIdentifier): a HashedString built in JS from the
                // same literal disas-exact read out of each 2024 body, hashed by the already-derived
                // HashedString.set()/computeHash().
                //
                // route a (closed -- exercises only bdsx's own code): every one of the nineteen
                // statics returns the exact literal its 2024 body reads.
                //
                // route b (BDS is the witness): ItemStackBase::getComponentItem() and
                // ComponentItem::_getComponent() are both real 1.26 addresses (unrelated to this
                // family), and _getComponent looks a HashedString up in the component map BDS itself
                // built when the item type loaded, keyed by BDS's own hash of the component's real
                // name. ComponentItem.prototype.getComponent(str) builds that HashedString the same
                // way our derived() statics do (HashedString.construct() + .set()), so if our fnv1
                // hash of "minecraft:digger"/"minecraft:food" did not match the string BDS actually
                // registered the component under, the lookup would come back null even on an item
                // that has it. `give`'d slot 0 is a diamond_pickaxe (Digger, not Food), slot 1 an
                // apple (Food, not Digger).
                const table: [string, () => { str: string }][] = [
                    ["minecraft:cooldown", () => CooldownItemComponent.getIdentifier()],
                    ["minecraft:armor", () => ArmorItemComponent.getIdentifier()],
                    ["minecraft:durability", () => DurabilityItemComponent.getIdentifier()],
                    ["minecraft:digger", () => DiggerItemComponent.getIdentifier()],
                    ["minecraft:display_name", () => DisplayNameItemComponent.getIdentifier()],
                    ["minecraft:entity_placer", () => EntityPlacerItemComponent.getIdentifier()],
                    ["minecraft:food", () => FoodItemComponent.getIdentifier()],
                    ["minecraft:fuel", () => FuelItemComponent.getIdentifier()],
                    ["minecraft:icon", () => IconItemComponent.getIdentifier()],
                    ["minecraft:on_use", () => OnUseItemComponent.getIdentifier()],
                    ["minecraft:block_placer", () => PlanterItemComponent.getIdentifier()],
                    ["minecraft:projectile", () => ProjectileItemComponent.getIdentifier()],
                    ["minecraft:record", () => RecordItemComponent.getIdentifier()],
                    ["minecraft:render_offsets", () => RenderOffsetsItemComponent.getIdentifier()],
                    ["minecraft:repairable", () => RepairableItemComponent.getIdentifier()],
                    ["minecraft:shooter", () => ShooterItemComponent.getIdentifier()],
                    ["minecraft:throwable", () => ThrowableItemComponent.getIdentifier()],
                    ["minecraft:weapon", () => WeaponItemComponent.getIdentifier()],
                    ["minecraft:wearable", () => WearableItemComponent.getIdentifier()],
                ];
                let okCount = 0;
                const bad: string[] = [];
                for (const [literal, get] of table) {
                    try {
                        const hs = get();
                        if (hs.str === literal) okCount++;
                        else bad.push(`${literal} -> "${hs.str}"`);
                    } catch (err) {
                        bad.push(`${literal} threw ${(err as Error).message}`);
                    }
                }
                console.log(`${TAG} INFO compid route-a ${okCount}/${table.length} ok${bad.length > 0 ? ` bad=[${bad.join(", ")}]` : ""}`);
                check("compid-a", okCount === table.length, `all ${table.length} getIdentifier() statics return their disas-exact-read 2024 literal`);

                // route b needs ItemStackBase::getComponentItem(), which is a separate, already
                // flagged gap (docs/findings-audit.md "Q3 follow-up" (4): confirmed inlined on both
                // 1.26 builds, no address exists on either -- the fix is its own derived() over
                // item_+8 -> Item vtable slot 9 (isComponentBased), not attempted here). Until that
                // lands, route b cannot run at all (not "run and fail" -- the call throws "Symbol
                // not found" before it reaches BDS's component map), so it is its own try/catch and
                // reports SKIP rather than FAIL: a missing dependency is not a wrong answer from
                // this family's own code.
                try {
                    const inv = p.getInventory();
                    const pick = inv.container.getItem(0);
                    const apple = inv.container.getItem(1);
                    console.log(`${TAG} INFO compid slot0=${describe(pick)} slot1=${describe(apple)}`);
                    if (pick.isNull() || apple.isNull()) {
                        console.log(`${TAG} FAIL compid-b: expected a diamond_pickaxe in slot 0 and an apple in slot 1`);
                        break;
                    }
                    // 1.26 still has a native PickaxeItem (its vftable is ??_7PickaxeItem@@6B@ on both builds, read live by
                    // block-probe's cbprobe) whose isComponentBased (vftable slot 9) is the shared `xor eax,eax; ret`;
                    // the apple's Item answers `mov al,1; ret`. So getComponentItem must be null for the pickaxe and
                    // the Item itself for the apple (docs/findings-audit.md "getComponentItem").
                    const pickCi = pick.getComponentItem();
                    const appleCi = apple.getComponentItem();
                    const appleItem = (apple as any as StaticPointer).getPointer(8).getPointer(0);
                    const pickNull = pickCi === null || pickCi.isNull();
                    const appleSame = appleCi !== null && !appleCi.isNull() && (appleCi as any as StaticPointer).equalsptr(appleItem);
                    console.log(`${TAG} INFO compid-b pick=${pickCi === null ? "null" : addr(pickCi as any)} apple=${appleCi === null ? "null" : addr(appleCi as any)} apple item_=${appleItem}`);
                    check("compid-b", pickNull && appleSame, `getComponentItem() is null for the native PickaxeItem and the apple's own Item for the component-based apple`);
                    try {
                        const appleFood = appleCi!.getComponent("minecraft:food");
                        console.log(`${TAG} INFO compid-b apple.food=${appleFood === null ? "null" : addr(appleFood as any)}`);
                    } catch (err) {
                        console.log(`${TAG} INFO compid-b apple.food threw ${(err as Error).message}`);
                    }
                } catch (err) {
                    console.log(`${TAG} INFO compid-b SKIP: ${(err as Error).message} (getComponentItem@ItemStackBase has no address on this build yet -- Q3 follow-up (4), a separate gap)`);
                }
                break;
            }
            case "sendarmor": {
                // Q8 (agent-h, 2026-09-27). This step crashed both builds from the console, and the crash
                // was read as a console-context precondition of ServerPlayer::sendArmor. It was not: the
                // step called p.getArmor(slot) first, and `?getArmor@Actor@@` shipped the address of
                // ActorEquipment::getArmorContainer (a propagation mislabel; 1.26 inlines getArmor), so the
                // server died before sendArmorSlot ran. getArmor is derived() now; "getarmorold" below
                // replays the old binding on purpose. docs/findings-audit.md "sendArmor: the crash was getArmor".
                //
                // The driver fills head, chest, legs, feet in that order, one per step, after `clear @a`:
                // at the step for slot s, slots 0..s are worn and s+1..3 are empty -- both sides of getArmor.
                const names: Record<string, ArmorSlot> = { head: ArmorSlot.Head, torso: ArmorSlot.Torso, chest: ArmorSlot.Chest, legs: ArmorSlot.Legs, feet: ArmorSlot.Feet };
                const slot = names[arg];
                if (slot === undefined) {
                    console.log(`${TAG} FAIL sendarmor: unknown slot "${arg}" (want head|torso|chest|legs|feet)`);
                    break;
                }
                const ac = p.getArmorContainer();
                const got: string[] = [];
                let getOk = true;
                for (let i = 0; i <= ArmorSlot.Feet; i++) {
                    const it = p.getArmor(i);
                    const same = it.equalsptr(ac.getItem(i));
                    const worn = !it.isNull();
                    got.push(`${i}:${worn ? it.toString() : "empty"}${same ? "" : "(not the container's slot)"}`);
                    if (!same || worn !== i <= slot) getOk = false;
                }
                check("sendarmor-get", getOk, `getArmor(0..3) are the armor container's slots, worn exactly for 0..${slot}: [${got.join(", ")}]`);
                // BDS's own InventorySlotPacket for the armor container, seen by bdsx's packetSend while the
                // call runs (the MobArmorEquipmentPacket goes to the dimension's other players, not the bot).
                const sent: string[] = [];
                const onSend = (pk: InventorySlotPacket): void => {
                    sent.push(`container=${pk.containerId} slot=${pk.slot}`);
                };
                events.packetSend(MinecraftPacketIds.InventorySlot).on(onSend);
                try {
                    p.sendArmorSlot(slot);
                } finally {
                    events.packetSend(MinecraftPacketIds.InventorySlot).remove(onSend);
                }
                check("sendarmor", sent.length >= 1, `sendArmorSlot(${arg}) from the console returned, and BDS sent ${sent.length} InventorySlotPacket(s) during it: [${sent.join("; ")}]`);
                break;
            }
            case "getarmorold": {
                // Crashes the server ON PURPOSE (repro for Q8): the binding bdsx shipped for Actor::getArmor
                // until 2026-09-27 -- the address of ActorEquipment::getArmorContainer called as a member
                // (this=Actor, slot). Only for a driver whose last command it is.
                const slot = ArmorSlot.Head;
                const old = procHacker.js("?getArmorContainer@ActorEquipment@@YAAEBVSimpleContainer@@AEBVEntityContext@@@Z", ItemStack, { this: Actor }, int32_t);
                console.log(`${TAG} INFO getarmorold: calling getArmorContainer's address as getArmor(this=Actor ${addr(p)}, slot=${slot}) now`);
                const it = old.call(p, slot);
                console.log(`${TAG} INFO getarmorold: returned ${addr(it)} (no crash)`);
                break;
            }
            case "sendarmortick": {
                // The same call from inside events.levelTick. Kept as the other context: it passed while
                // "sendarmor" crashed, which is what made the crash look context-dependent (agent-p,
                // 2026-09-23). "sendarmortick" never called getArmor; that was the difference (Q8, 2026-09-27).
                const names: Record<string, ArmorSlot> = { head: ArmorSlot.Head, torso: ArmorSlot.Torso, chest: ArmorSlot.Chest, legs: ArmorSlot.Legs, feet: ArmorSlot.Feet };
                const slot = names[arg] ?? ArmorSlot.Head;
                console.log(`${TAG} INFO sendarmortick: arming one-shot levelTick call, slot=${arg || "head"}(${slot})`);
                events.levelTick.once(() => {
                    console.log(`${TAG} INFO sendarmortick: levelTick fired, calling sendArmorSlot(${slot}) now`);
                    p.sendArmorSlot(slot);
                    console.log(`${TAG} PASS sendarmortick: sendArmorSlot(${slot}) returned from inside levelTick without crashing`);
                });
                break;
            }
            case "stacksize": {
                // Q1-B-4 (docs/findings-containers.md 10, tail): ItemStackBase::getMaxStackSize is
                // now bdsx's own code -- Item vtable slot 100, reached through
                // ItemStackBase::getDescriptor (a new resolved address, no 1.26 out-of-line copy
                // exists for getMaxStackSize itself on either build). Run after a clear+give cycle
                // (the driver); <n> is the stack size BDS's own item data gives the item just given.
                const inv = p.getInventory();
                const it = inv.container.getItem(inv.getSelectedSlot());
                const size = it.getMaxStackSize();
                console.log(`${TAG} INFO stacksize selected=${describe(it)} getMaxStackSize=${size}`);
                const want = +arg;
                check("stacksize", size === want, `getMaxStackSize() is ${size}, want ${want} (arg=${arg})`);
                break;
            }
            case "damageable": {
                // The other half of the same pair: ItemStackBase::isDamageableItem, Item vtable
                // slot 14 (the same Item$isDamageable dispatch getMaxStackSize's descriptor build
                // also calls partway through, docs/findings-containers.md 10).
                const inv = p.getInventory();
                const it = inv.container.getItem(inv.getSelectedSlot());
                const d = it.isDamageableItem();
                console.log(`${TAG} INFO damageable selected=${describe(it)} isDamageableItem=${d}`);
                const want = arg === "true";
                check("damageable", d === want, `isDamageableItem() is ${d}, want ${want} (arg=${arg})`);
                break;
            }
            case "stackable": {
                // ItemStackBase::isStackable(), the no-argument overload (docs/findings-inventory.md
                // 14): upstream bdsx bound it to the one-argument name. Both answers from one run:
                // the log (64 per stack) is stackable, the sword (1 per stack) is not.
                const log = findSlot(p, "log");
                const sword = findSlot(p, "sword");
                if (log === null || sword === null) {
                    check("stackable", false, `the driver's log and sword are not in the inventory (log ${log !== null}, sword ${sword !== null})`);
                    break;
                }
                const l = log.isStackable(), w = sword.isStackable();
                check("stackable", l === true && w === false, `isStackable() log=${l} (max ${log.getMaxStackSize()}) sword=${w} (max ${sword.getMaxStackSize()}); want true/false`);
                break;
            }
            case "stackaux": {
                // Queue Q1-B, the getAuxValue doubt (docs/findings-inventory.md 14). The engine's own
                // getAuxValue survives only inlined; ItemStackBase::isStackable(other) is its cleanest
                // out-of-line consumer: when the item stacks by data it compares getAuxValue() of the two
                // stacks. Two oak_log stacks (inventory + offhand), both aux_ 0; their block_ (+24) is
                // swapped between the y/x/z states the log's own BlockLegacy gives for legacy DataIDs
                // 0/4/8. If the engine reads Block::data_ (+288) as bdsx does, isStackable(other) is true
                // exactly when bdsx's getAuxValue() agrees on both stacks, and false for mixed axes;
                // if it read aux_, it would say true every time. Restored before returning.
                const a = findSlot(p, "log");
                const b = p.getOffhandSlot();
                if (a === null || !/log/i.test(b.toString())) {
                    check("stackaux", false, `the driver's two oak_log stacks are not there (inventory ${a !== null}, offhand "${b.toString()}")`);
                    break;
                }
                const ap = a as any as StaticPointer, bp = b as any as StaticPointer;
                const aSave = ap.getPointer(24), bSave = bp.getPointer(24);
                const legacy = aSave.as(Block).blockLegacy;
                const Y = legacy.tryGetStateFromLegacyData(0) as any as StaticPointer;
                const X = legacy.tryGetStateFromLegacyData(4) as any as StaticPointer;
                const Z = legacy.tryGetStateFromLegacyData(8) as any as StaticPointer;
                const dataOff = pdbcache.layouts.Block?.data ?? 288;
                if (Y === null || X === null || Z === null) {
                    check("stackaux", false, `tryGetStateFromLegacyData(0/4/8) gave ${Y}/${X}/${Z}`);
                    break;
                }
                console.log(`${TAG} INFO stackaux legacy DataID 0/4/8 -> Block ${addr(Y)}/${addr(X)}/${addr(Z)}, Block+${dataOff} = ${Y.getUint16(dataOff)}/${X.getUint16(dataOff)}/${Z.getUint16(dataOff)}; the stack's own block ${addr(aSave)}`);
                // The compare only runs when the Item is stacked by data: Item::isStackedByData is bit 2
                // of Item+0x152 on both builds (2024: +0x14a), and a flattened log leaves it clear, so
                // the first run saw `true` five times and proved nothing. The bit is set for the
                // trials alone and put back with the pointers. The Item's slot 35 (+0x118) has to be
                // that very function, or the bit is not what the engine asks.
                const item = a.getItem() as any as StaticPointer;
                const vslot = item.getPointer(0).getPointer(0x118);
                const isbd = proc["?isStackedByData@Item@@UEBA_NXZ"];
                console.log(`${TAG} INFO stackaux Item ${addr(item)} slot 35 = ${addr(vslot)}, Item::isStackedByData = ${addr(isbd)}${vslot.equalsptr(isbd) ? " (same)" : " (NOT the same)"}, +0x152 = 0x${item.getUint8(0x152).toString(16)}`);
                const flagSave = item.getUint8(0x152);
                const auxSave = ap.getInt16(32), bAuxSave = bp.getInt16(32);
                const rows: string[] = [];
                const answers = new Set<boolean>();
                let agree = 0, total = 0, counting = false;
                // Each trial sets both stacks' block_ and aux_. bdsx's getAuxValue() says equal or not;
                // the engine's inlined getAuxValue inside isStackable(other) has to say the same. Reading
                // aux_ instead would flip x/y, x/z (same aux_, different blocks) and y/y 5/0 (same
                // block, different aux_); 0x7FFF is the wildcard branch, which reads aux_ on both sides.
                const trial = (label: string, ba: StaticPointer, bb: StaticPointer, xa: number, xb: number): void => {
                    ap.setPointer(ba, 24);
                    bp.setPointer(bb, 24);
                    ap.setInt16(xa, 32);
                    bp.setInt16(xb, 32);
                    const ea = a.getAuxValue(), eb = b.getAuxValue();
                    const eng = a.isStackable(b);
                    if (counting) {
                        answers.add(eng);
                        total++;
                        if (eng === (ea === eb)) agree++;
                    }
                    rows.push(`${label} aux_ ${xa}/${xb} getAuxValue ${ea}/${eb} engine=${eng}`);
                };
                try {
                    trial("as found y/y", Y, Y, 0, 0);
                    trial("as found x/y", X, Y, 0, 0);
                    rows.push(`^ with +0x152 as found (stacked by data: ${(flagSave & 4) !== 0}); the rest with bit 2 set`);
                    item.setUint8(flagSave | 4, 0x152);
                    counting = true;
                    trial("y/y", Y, Y, 0, 0);
                    trial("x/y", X, Y, 0, 0);
                    trial("x/x", X, X, 0, 0);
                    trial("x/z", X, Z, 0, 0);
                    trial("z/z", Z, Z, 0, 0);
                    trial("y/y", Y, Y, 5, 0);
                    trial("x/x", X, X, 5, 0);
                    trial("y/y", Y, Y, 0x7fff, 0);
                    trial("y/y", Y, Y, 0x7fff, 0x7fff);
                } finally {
                    item.setUint8(flagSave, 0x152);
                    ap.setPointer(aSave, 24);
                    bp.setPointer(bSave, 24);
                    ap.setInt16(auxSave, 32);
                    bp.setInt16(bAuxSave, 32);
                }
                for (const r of rows) console.log(`${TAG} INFO stackaux ${r}`);
                check("stackaux", agree === total && answers.size === 2, `the engine's isStackable(other) equals (getAuxValue() == getAuxValue()) in ${agree}/${total} trials, answers seen: ${[...answers].join(",")}`);
                break;
            }
            case "enchantbds":
            case "enchantcurse":
            case "enchant": {
                // EnchantUtils.applyEnchant (docs/findings-nbt.md "applyEnchant"): bdsx's own (type, level) overload over
                // 1.26's out-of-line EnchantmentInstance one, on the sword the console put in the bot's main hand.
                // enchantbds: the console's `enchant @a sharpness 3` wrote it -- BDS writes, bdsx reads (getEnchantLevel,
                // hasEnchant, the item's NBT through BDS's own ItemStackBase::save, constructItemEnchantsFromUserData),
                // then an edited copy goes back through saveEnchantsToUserData (level 3 -> 4).
                // enchantcurse: after the console's `enchant @a vanishing`: hasCurse true.
                // enchant: a fresh sword; every expectation below is read off the 1.26 body (ItemEnchants::addEnchant
                // inlined: the slot test unless allowUnsafe, the compatibility loop, an existing level >= the maximum
                // refuses, an equal level goes up by one, a lower one keeps the existing). Then a bdsx-written curse,
                // and an empty ItemEnchants saved back, which removes the "ench" list (docs/findings-nbt.md section 21).
                const held = hc.getItem(0);
                const ench = (): string => {
                    try {
                        const list = (held.save().tag?.ench ?? []) as any[];
                        return list.map(e => `${Number(e.id?.value ?? e.id)}:${Number(e.lvl?.value ?? e.lvl)}`).join(",");
                    } catch (err) {
                        return `<${(err as Error).message}>`;
                    }
                };
                const sorted = (s: string): string => (s === "" ? "" : s.split(",").sort().join(","));
                const lvl = (t: EnchantmentNames): number => EnchantUtils.getEnchantLevel(t, held);
                const guard = (f: () => boolean): string => {
                    try {
                        return String(f());
                    } catch (err) {
                        return `<${(err as Error).message}>`;
                    }
                };
                const has = (t: EnchantmentNames): string => guard(() => EnchantUtils.hasEnchant(t, held));
                const curse = (): string => guard(() => EnchantUtils.hasCurse(held));
                const enchanted = (): string => guard(() => held.isEnchanted());
                // constructItemEnchantsFromUserData: the three activation-group vectors as sorted "id:lvl", and whether
                // every entry's level is what getEnchantLevel reads for that id
                const fromUserData = (): { slot: number; list: string; agree: boolean } => {
                    try {
                        const ie = held.constructItemEnchantsFromUserData();
                        try {
                            const out: string[] = [];
                            let agree = true;
                            for (const v of [ie.enchants1, ie.enchants2, ie.enchants3]) {
                                for (let i = 0; i < v.size(); i++) {
                                    const e = v.get(i);
                                    out.push(`${e.type}:${e.level}`);
                                    if (lvl(e.type as EnchantmentNames) !== e.level) agree = false;
                                }
                            }
                            return { slot: ie.slot, list: out.sort().join(","), agree };
                        } finally {
                            ie.destruct();
                        }
                    } catch (err) {
                        return { slot: -1, list: `<${(err as Error).message}>`, agree: false };
                    }
                };
                const ud = (): string => {
                    const r = fromUserData();
                    return `slot ${r.slot}, [${r.list}], levels ${r.agree ? "agree" : "DISAGREE"} with getEnchantLevel`;
                };
                console.log(`${TAG} INFO ${step} held=${describe(held)} ench=[${ench()}]`);
                if (step === "enchantbds") {
                    check(
                        "enchantbds",
                        held.toString().toLowerCase().includes("sword") && lvl(EnchantmentNames.Sharpness) === 3 && ench() === "9:3",
                        `after the console's enchant sharpness 3: getEnchantLevel(Sharpness) ${lvl(EnchantmentNames.Sharpness)}, the NBT ench list [${ench()}]`,
                    );
                    check("enchantbds-has", has(EnchantmentNames.Sharpness) === "true" && has(EnchantmentNames.Smite) === "false", `hasEnchant: Sharpness ${has(EnchantmentNames.Sharpness)}, Smite ${has(EnchantmentNames.Smite)}`);
                    const r = fromUserData();
                    check("enchantbds-fromud", r.list === "9:3" && r.agree && r.slot > 0, `constructItemEnchantsFromUserData: ${ud()} (want [9:3], the NBT list)`);
                    check("enchantbds-flags", enchanted() === "true" && curse() === "false", `isEnchanted ${enchanted()} (want true), hasCurse ${curse()} (want false)`);
                    // an edited copy: Sharpness 3 -> 4 in the vector, then saveEnchantsToUserData
                    let edited = "no Sharpness entry";
                    try {
                        const ie = held.constructItemEnchantsFromUserData();
                        try {
                            for (const v of [ie.enchants1, ie.enchants2, ie.enchants3]) {
                                for (let i = 0; i < v.size(); i++) {
                                    const e = v.get(i);
                                    if (e.type === EnchantmentNames.Sharpness) {
                                        e.level = 4;
                                        edited = "edited";
                                    }
                                }
                            }
                            held.saveEnchantsToUserData(ie);
                        } finally {
                            ie.destruct();
                        }
                    } catch (err) {
                        edited = `<${(err as Error).message}>`;
                    }
                    check("enchantbds-saveud", edited === "edited" && ench() === "9:4" && lvl(EnchantmentNames.Sharpness) === 4, `saveEnchantsToUserData of the copy with Sharpness 4 (${edited}): BDS's save() writes ench [${ench()}], getEnchantLevel ${lvl(EnchantmentNames.Sharpness)} (want 9:4, 4)`);
                    break;
                }
                if (step === "enchantcurse") {
                    const r = fromUserData();
                    check(
                        "enchantcurse",
                        sorted(ench()) === "28:1,9:4" && r.list === "28:1,9:4" && r.agree && curse() === "true" && enchanted() === "true" && has(EnchantmentNames.VanishingCurse) === "true",
                        `after the console's enchant vanishing: ench [${ench()}], ${ud()}, hasCurse ${curse()}, isEnchanted ${enchanted()}, hasEnchant(VanishingCurse) ${has(EnchantmentNames.VanishingCurse)} (want 28:1,9:4 and true x3)`,
                    );
                    break;
                }
                check(
                    "enchant-fresh",
                    held.toString().toLowerCase().includes("sword") && ench() === "" && has(EnchantmentNames.Sharpness) === "false" && enchanted() === "false" && curse() === "false" && fromUserData().list === "",
                    `a fresh sword: ench [${ench()}], hasEnchant(Sharpness) ${has(EnchantmentNames.Sharpness)}, isEnchanted ${enchanted()}, hasCurse ${curse()}, constructItemEnchantsFromUserData ${ud()}`,
                );
                const apply = (name: string, t: EnchantmentNames, level: number, unsafe: boolean, wantRet: boolean, wantLevel: number): void => {
                    const ret = EnchantUtils.applyEnchant(held, t, level, unsafe);
                    const got = lvl(t);
                    check(`enchant-${name}`, ret === wantRet && got === wantLevel, `applyEnchant(${EnchantmentNames[t]}, ${level}, allowUnsafe ${unsafe}) returned ${ret} (want ${wantRet}), level now ${got} (want ${wantLevel}), ench [${ench()}], hasEnchant ${has(t)}`);
                };
                apply("new", EnchantmentNames.Sharpness, 2, false, true, 2);
                check("enchant-nbt", ench() === "9:2" && has(EnchantmentNames.Sharpness) === "true", `BDS's ItemStackBase::save writes ench [${ench()}] (want 9:2: id 9 = Sharpness, the instance's byte at +0, lvl the int at +4)`);
                apply("equal", EnchantmentNames.Sharpness, 2, false, true, 3);
                apply("lower", EnchantmentNames.Sharpness, 1, false, true, 3);
                apply("raise", EnchantmentNames.Sharpness, 5, false, true, 5);
                apply("atmax", EnchantmentNames.Sharpness, 1, false, false, 5);
                apply("wrongslot", EnchantmentNames.Protection, 1, false, false, 0);
                apply("incompatible", EnchantmentNames.Smite, 1, false, false, 0);
                apply("unsafeslot", EnchantmentNames.Protection, 1, true, true, 1);
                // A level past the maximum for an enchantment the item does not have yet: 1.26's addEnchant compares an
                // existing level with the maximum, not the new one (the command checks that itself).
                apply("pastmaxnew", EnchantmentNames.Unbreaking, 10, false, true, 10);
                check("enchant-final", sorted(ench()) === ["0:1", "17:10", "9:5"].join(","), `the NBT ench list at the end: [${ench()}]`);
                {
                    const r = fromUserData();
                    check("enchant-fromud", r.list === sorted(ench()) && r.agree && enchanted() === "true" && curse() === "false", `constructItemEnchantsFromUserData ${ud()} against the NBT [${sorted(ench())}]; isEnchanted ${enchanted()}, hasCurse ${curse()} (want true, false)`);
                }
                // a curse bdsx writes (Binding is for wearables: allowUnsafe skips the slot test)
                apply("binding", EnchantmentNames.BindingCurse, 1, true, true, 1);
                check("enchant-curse", curse() === "true" && enchanted() === "true", `after applyEnchant(BindingCurse): hasCurse ${curse()}, isEnchanted ${enchanted()} (want true, true)`);
                // an empty ItemEnchants saved back: the body removes "ench" when all three vectors are empty
                {
                    let saved = "saved";
                    try {
                        const slot = fromUserData().slot;
                        const empty = ItemEnchants.construct();
                        try {
                            empty.slot = slot;
                            held.saveEnchantsToUserData(empty);
                        } finally {
                            empty.destruct();
                        }
                    } catch (err) {
                        saved = `<${(err as Error).message}>`;
                    }
                    const tag = (held as any as StaticPointer).getNullablePointerAs(CompoundTag, 16)?.get("ench") ?? null;
                    check(
                        "enchant-emptysave",
                        saved === "saved" && ench() === "" && tag === null && enchanted() === "false" && curse() === "false" && lvl(EnchantmentNames.Sharpness) === 0,
                        `saveEnchantsToUserData(empty ItemEnchants) (${saved}): ench [${ench()}], the "ench" tag ${tag === null ? "gone" : "still there"}, isEnchanted ${enchanted()}, hasCurse ${curse()}, getEnchantLevel(Sharpness) ${lvl(EnchantmentNames.Sharpness)} (want [], gone, false, false, 0)`,
                    );
                }
                break;
            }
            case "descriptor": {
                // ItemDescriptor's constructors and destructor (docs/findings-nbt.md section 23): all three are
                // bdsx's own code on 1.26 (engine/itemdescriptor.ts) -- the vptr and a null impl_, the vptr and
                // impl_->clone() (BaseDescriptor vftable slot 0), and the vftable's deleting destructor with 0.
                // <arg> is the full name of the held item, or "empty" for an empty hand.
                const inv = p.getInventory();
                const it = inv.container.getItem(inv.getSelectedSlot());
                const vptr = proc["??_7ItemDescriptor@@6B@"];
                const internalVptr = proc["??_7InternalItemDescriptor@@6B@"];
                const def = ItemDescriptor.construct();
                const defVptr = (def as unknown as StaticPointer).getPointer(0);
                const defImpl = (def as unknown as StaticPointer).getNullablePointer(8);
                def.destruct();
                check("descriptor default", defVptr.equalsptr(vptr) && defImpl === null, `vptr ${addr(defVptr)} (want ${addr(vptr)}), impl ${addr(defImpl)} (want null)`);

                const src = ItemStackBase$getDescriptor.call(it);
                const copy = ItemDescriptor.construct(src);
                const s = src as unknown as StaticPointer, c = copy as unknown as StaticPointer;
                const sImpl = s.getNullablePointer(8), cImpl = c.getNullablePointer(8);
                const heldItem = (it as unknown as StaticPointer).getNullablePointer(8)?.getNullablePointer(0) ?? null;
                console.log(`${TAG} INFO descriptor held=${describe(it)} item=${addr(heldItem)} getId=${it.getId()} src vptr=${addr(s.getPointer(0))} impl=${addr(sImpl)} copy vptr=${addr(c.getPointer(0))} impl=${addr(cImpl)}`);
                if (arg === "empty") {
                    // an empty hand: whatever getDescriptor gives, the copy has to agree on it
                    const same = sImpl === null ? cImpl === null : cImpl !== null && !cImpl.equalsptr(sImpl) && cImpl.getPointer(8).equalsptr(sImpl.getPointer(8));
                    check("descriptor empty", c.getPointer(0).equalsptr(vptr) && same, `src impl ${addr(sImpl)}, copy impl ${addr(cImpl)}${sImpl !== null ? ` (items ${addr(sImpl.getPointer(8))} / ${cImpl === null ? "-" : addr(cImpl.getPointer(8))})` : ""}`);
                } else if (sImpl === null || cImpl === null || heldItem === null) {
                    check("descriptor copy", false, `null: src impl ${addr(sImpl)}, copy impl ${addr(cImpl)}, held item ${addr(heldItem)}`);
                } else {
                    // InternalItemDescriptor: vptr, ItemEntry { const Item* item (+8), int16 aux (+0x10) }
                    const cItem = cImpl.getPointer(8);
                    const cId = cItem.getInt16(170); // Item::id_ (+170, docs/findings-containers.md, the aux/blockaux step)
                    const name = BaseDescriptor$getFullName(cImpl);
                    check(
                        "descriptor copy",
                        c.getPointer(0).equalsptr(vptr) &&
                            !cImpl.equalsptr(sImpl) &&
                            cImpl.getPointer(0).equalsptr(internalVptr) &&
                            sImpl.getPointer(0).equalsptr(internalVptr) &&
                            cItem.equalsptr(sImpl.getPointer(8)) &&
                            cItem.equalsptr(heldItem) &&
                            cImpl.getInt16(0x10) === sImpl.getInt16(0x10) &&
                            cId === it.getId() &&
                            name === arg &&
                            name === itemFullName(heldItem),
                        `copy impl ${addr(cImpl)} (src ${addr(sImpl)}), impl vptrs ${addr(cImpl.getPointer(0))}/${addr(sImpl.getPointer(0))} (want ${addr(internalVptr)}), item ${addr(cItem)} (held ${addr(heldItem)}), aux ${cImpl.getInt16(0x10)}/${sImpl.getInt16(0x10)}, id ${cId} (getId ${it.getId()}), getFullName "${name}" (want "${arg}", Item::full_name_ "${itemFullName(heldItem)}")`,
                    );
                }
                copy.destruct();
                src.destruct();

                // 200 rounds of all three, and getMaxStackSize (which now destructs the descriptor it builds)
                let rounds = 0;
                let firstSize = -1;
                for (let i = 0; i < 200; i++) {
                    const d = ItemDescriptor.construct();
                    const g = ItemStackBase$getDescriptor.call(it);
                    const k = ItemDescriptor.construct(g);
                    const k2 = ItemDescriptor.construct(k);
                    g.destruct();
                    k.destruct();
                    k2.destruct();
                    d.destruct();
                    const size = it.getMaxStackSize();
                    if (firstSize === -1) firstSize = size;
                    if (size !== firstSize) break;
                    rounds++;
                }
                check("descriptor rounds", rounds === 200, `${rounds}/200 rounds of default + getDescriptor + two copies + four destructs + getMaxStackSize (${firstSize}), no fault`);
                break;
            }
            case "clone": {
                // ItemStack::clone (docs/findings-nbt.md section 24): 1.26 keeps it out of line (40 0x1bbef20 / 51
                // 0x1a51750): ItemStackBase's copy constructor into the sret, the ItemStack vptr, then the
                // ItemStackNetIdVariant (+0x80, its index byte at +0x90) copied. <arg> is the held item's full name, or
                // "empty". c1 = held.clone(), c2 = c1.clone(); both against the source: the Item*, name, count, aux, id,
                // the net id, and the whole NBT BDS's own save() writes. The user data must be deep: distinct pointers,
                // and a custom name bdsx sets on c1 reaches neither the source nor c2; c1 is destructed before c2 is
                // read again. Then 200 rounds of clone + clone + two destructs.
                const inv = p.getInventory();
                const it = inv.container.getItem(inv.getSelectedSlot());
                const vptr = proc["??_7ItemStack@@6B@"];
                const P = (x: ItemStack): StaticPointer => x as unknown as StaticPointer;
                const itemOf = (x: ItemStack): VoidPointer | null => P(x).getNullablePointer(8)?.getNullablePointer(0) ?? null;
                const nameOf = (x: ItemStack): string => {
                    const i = itemOf(x);
                    return i === null ? "" : itemFullName(i as unknown as StaticPointer);
                };
                const nbt = (x: ItemStack): string => {
                    try {
                        return JSON.stringify(x.save());
                    } catch (err) {
                        return `<${(err as Error).message}>`;
                    }
                };
                const netId = (x: ItemStack): string => {
                    const idx = P(x).getInt8(0x90);
                    return idx === 0 ? `server:${P(x).getInt32(0x80)}` : `idx${idx}:${addr(P(x).getNullablePointer(0x80))}:${P(x).getInt32(0x88)}`;
                };
                const customName = (x: ItemStack): string => {
                    const ud = P(x).getNullablePointerAs(CompoundTag, 16);
                    const d = ud?.get("display") ?? null;
                    if (!(d instanceof CompoundTag)) return "";
                    const n = d.get("Name");
                    return n === null ? "" : String(n.value());
                };
                const same = (x: ItemStack, what: string): string[] => {
                    const bad: string[] = [];
                    if (!P(x).getPointer(0).equalsptr(vptr)) bad.push(`${what} vptr ${addr(P(x).getPointer(0))}`);
                    if (P(x).equalsptr(it)) bad.push(`${what} is the source`);
                    const a = itemOf(x), b = itemOf(it);
                    if (a === null ? b !== null : b === null || !a.equalsptr(b)) bad.push(`${what} Item* ${addr(a)} vs ${addr(b)}`);
                    if (nameOf(x) !== nameOf(it)) bad.push(`${what} name "${nameOf(x)}" vs "${nameOf(it)}"`);
                    if (x.amount !== it.amount) bad.push(`${what} count ${x.amount} vs ${it.amount}`);
                    if (x.getAuxValue() !== it.getAuxValue()) bad.push(`${what} aux ${x.getAuxValue()} vs ${it.getAuxValue()}`);
                    if (x.getId() !== it.getId()) bad.push(`${what} id ${x.getId()} vs ${it.getId()}`);
                    if (x.isNull() !== it.isNull()) bad.push(`${what} isNull ${x.isNull()} vs ${it.isNull()}`);
                    if (netId(x) !== netId(it)) bad.push(`${what} net id ${netId(x)} vs ${netId(it)}`);
                    if (nbt(x) !== nbt(it)) bad.push(`${what} NBT ${nbt(x)} vs ${nbt(it)}`);
                    const ua = P(x).getNullablePointer(16), ub = P(it).getNullablePointer(16);
                    if (ub === null ? ua !== null : ua === null || ua.equalsptr(ub)) bad.push(`${what} user data ${addr(ua)} vs the source's ${addr(ub)} (want both null, or two pointers)`);
                    return bad;
                };
                const srcNbt = nbt(it);
                console.log(`${TAG} INFO clone held=${describe(it)} name="${nameOf(it)}" count=${it.amount} aux=${it.getAuxValue()} id=${it.getId()} net=${netId(it)} userData=${addr(P(it).getNullablePointer(16))} nbt=${srcNbt}`);
                const empty = arg === "empty";
                check("clone source", empty ? it.isNull() : nameOf(it) === arg, `the held item is "${nameOf(it)}" (want ${empty ? "an empty hand" : `"${arg}"`})`);

                const c1 = it.clone();
                const c2 = c1.clone();
                console.log(`${TAG} INFO clone c1=${describe(c1)} userData=${addr(P(c1).getNullablePointer(16))} c2=${describe(c2)} userData=${addr(P(c2).getNullablePointer(16))} nbt=${nbt(c2)}`);
                const b1 = same(c1, "c1"), b2 = same(c2, "c2");
                const ud1 = P(c1).getNullablePointer(16), ud2 = P(c2).getNullablePointer(16);
                if (ud1 !== null && ud2 !== null && ud1.equalsptr(ud2)) b2.push(`c2 shares c1's user data ${addr(ud1)}`);
                check("clone c1", b1.length === 0, b1.length === 0 ? `a new ItemStack at ${addr(c1)}: name "${nameOf(c1)}", count ${c1.amount}, aux ${c1.getAuxValue()}, id ${c1.getId()}, net ${netId(c1)}, NBT equal to the source's, user data ${addr(ud1)}` : b1.join("; "));
                check("clone c2", b2.length === 0, b2.length === 0 ? `c1.clone() at ${addr(c2)}: the same, user data ${addr(ud2)}` : b2.join("; "));

                // deep: a custom name on c1 only
                c1.setCustomName("bdsxclone");
                const n1 = customName(c1), n0 = customName(it), n2 = customName(c2);
                const want1 = empty ? "" : "bdsxclone"; // setCustomName does nothing without an item
                check("clone deep", n1 === want1 && n0 === "" && n2 === "" && nbt(it) === srcNbt && nbt(c2) === srcNbt, `after c1.setCustomName: c1 "${n1}" (want "${want1}"), source "${n0}", c2 "${n2}" (want ""), source and c2 NBT unchanged ${nbt(it) === srcNbt}/${nbt(c2) === srcNbt}`);
                c1.destruct();
                const after = nbt(c2);
                c2.destruct();
                check("clone destruct", after === srcNbt && nbt(it) === srcNbt, `c1 destructed, c2 still reads the source's NBT: ${after === srcNbt}; c2 destructed, the source still reads its own: ${nbt(it) === srcNbt}`);

                let rounds = 0;
                let why = "";
                for (let i = 0; i < 200; i++) {
                    const k = it.clone();
                    const k2 = k.clone();
                    const bad = same(k2, "k2");
                    k.destruct();
                    k2.destruct();
                    if (bad.length !== 0) {
                        why = bad.join("; ");
                        break;
                    }
                    rounds++;
                }
                check("clone rounds", rounds === 200 && nbt(it) === srcNbt, `${rounds}/200 rounds of clone + clone + compare + two destructs${why ? `: ${why}` : ""}; the source's NBT unchanged ${nbt(it) === srcNbt}`);
                break;
            }
            case "fromdesc": {
                // ItemStack::fromDescriptor (docs/findings-nbt.md section 26): out of line on both builds (40 0x1bbf280 /
                // 51 0x1a51b70), 2024's (sret, const NetworkItemStackDescriptor&, BlockPalette&, bool) with
                // ItemDescriptor::_resolve inlined and getItem<ItemStack> still called. <arg> is the held item's full name,
                // or "empty". d = NetworkItemStackDescriptor(held), s = fromDescriptor(d, level palette, false): s must be
                // the held stack (Item*, name, count, aux, id, net id, the NBT BDS's own save() writes, its own user data).
                // Then the move constructor (derived, bdsx's own code): m <- move(d), m's fields are d's old ones, d is
                // left with a null impl_ and an empty string, and fromDescriptor(m) is the held stack again. Then
                // ItemStack's ctor_copy (the engine's copy constructor, 40 0x1bbd390 / 51 0x1a4fbb0): ItemStack.construct
                // (held) is the held stack with its own user data, and a custom name on the copy stays on the copy.
                // Between them, NetworkItemStackDescriptor's ctor_copy (step 1b, section 27). Then 200 rounds of all of it.
                const inv = p.getInventory();
                const it = inv.container.getItem(inv.getSelectedSlot());
                const vptr = proc["??_7ItemStack@@6B@"];
                const nisdVptr = proc["??_7NetworkItemStackDescriptor@@6B@"];
                const palette = bedrockServer.level.getBlockPalette();
                const P = (x: VoidPointer): StaticPointer => x as unknown as StaticPointer;
                const itemOf = (x: ItemStack): VoidPointer | null => P(x).getNullablePointer(8)?.getNullablePointer(0) ?? null;
                const nameOf = (x: ItemStack): string => {
                    const i = itemOf(x);
                    return i === null ? "" : itemFullName(i as unknown as StaticPointer);
                };
                const nbt = (x: ItemStack): string => {
                    try {
                        return JSON.stringify(x.save());
                    } catch (err) {
                        return `<${(err as Error).message}>`;
                    }
                };
                const netId = (x: ItemStack): string => {
                    const idx = P(x).getInt8(0x90);
                    return idx === 0 ? `server:${P(x).getInt32(0x80)}` : `idx${idx}:${addr(P(x).getNullablePointer(0x80))}:${P(x).getInt32(0x88)}`;
                };
                const customName = (x: ItemStack): string => {
                    const ud = P(x).getNullablePointerAs(CompoundTag, 16);
                    const d = ud?.get("display") ?? null;
                    if (!(d instanceof CompoundTag)) return "";
                    const n = d.get("Name");
                    return n === null ? "" : String(n.value());
                };
                const same = (x: ItemStack, what: string): string[] => {
                    const bad: string[] = [];
                    if (!P(x).getPointer(0).equalsptr(vptr)) bad.push(`${what} vptr ${addr(P(x).getPointer(0))}`);
                    if (P(x).equalsptr(it)) bad.push(`${what} is the source`);
                    const a = itemOf(x), b = itemOf(it);
                    if (a === null ? b !== null : b === null || !a.equalsptr(b)) bad.push(`${what} Item* ${addr(a)} vs ${addr(b)}`);
                    if (nameOf(x) !== nameOf(it)) bad.push(`${what} name "${nameOf(x)}" vs "${nameOf(it)}"`);
                    if (x.amount !== it.amount) bad.push(`${what} count ${x.amount} vs ${it.amount}`);
                    if (x.getAuxValue() !== it.getAuxValue()) bad.push(`${what} aux ${x.getAuxValue()} vs ${it.getAuxValue()}`);
                    if (x.getId() !== it.getId()) bad.push(`${what} id ${x.getId()} vs ${it.getId()}`);
                    if (x.isNull() !== it.isNull()) bad.push(`${what} isNull ${x.isNull()} vs ${it.isNull()}`);
                    if (netId(x) !== netId(it)) bad.push(`${what} net id ${netId(x)} vs ${netId(it)}`);
                    if (nbt(x) !== nbt(it)) bad.push(`${what} NBT ${nbt(x)} vs ${nbt(it)}`);
                    const ua = P(x).getNullablePointer(16), ub = P(it).getNullablePointer(16);
                    if (ub === null ? ua !== null : ua === null || ua.equalsptr(ub)) bad.push(`${what} user data ${addr(ua)} vs the source's ${addr(ub)} (want both null, or two pointers)`);
                    return bad;
                };
                // NetworkItemStackDescriptor copy check: dst's fields against src's, per member, as the copy constructor
                // writes them (the variant is index byte +0x30 and, by index, an int at +0x20 or a vptr at +0x20 plus an
                // int at +0x28; the padding is not copied, so it is not compared).
                const nisdCopyBad = (src: NetworkItemStackDescriptor, dst: NetworkItemStackDescriptor, what: string): { bad: string[]; info: string } => {
                    const sp = P(src), tp = P(dst);
                    const bad: string[] = [];
                    if (tp.equalsptr(sp)) bad.push(`${what} is the source`);
                    if (!tp.getPointer(0).equalsptr(nisdVptr)) bad.push(`${what} vptr ${addr(tp.getPointer(0))} (want ${addr(nisdVptr)})`);
                    const si = sp.getNullablePointer(8), ti = tp.getNullablePointer(8);
                    let implInfo = "impl null in both";
                    if (si === null) {
                        if (ti !== null) bad.push(`${what} impl ${addr(ti)} (want null, as the source's)`);
                    } else if (ti === null) {
                        bad.push(`${what} impl null (source ${addr(si)})`);
                    } else if (ti.equalsptr(si)) {
                        bad.push(`${what} impl ${addr(ti)} is the source's`);
                    } else {
                        const sv = (si as unknown as StaticPointer).getPointer(0), tv = (ti as unknown as StaticPointer).getPointer(0);
                        const sn = BaseDescriptor$getFullName(si), tn = BaseDescriptor$getFullName(ti);
                        if (!tv.equalsptr(sv)) bad.push(`${what} impl vptr ${addr(tv)} vs ${addr(sv)}`);
                        if (tn !== sn) bad.push(`${what} impl full name "${tn}" vs "${sn}"`);
                        implInfo = `its own impl ${addr(ti)} (source ${addr(si)}), vptr ${addr(tv)}, "${tn}"`;
                    }
                    if (tp.getUint16(0x10) !== sp.getUint16(0x10)) bad.push(`${what} count ${tp.getUint16(0x10)} vs ${sp.getUint16(0x10)}`);
                    if (tp.getUint8(0x18) !== sp.getUint8(0x18)) bad.push(`${what} +0x18 ${tp.getUint8(0x18)} vs ${sp.getUint8(0x18)}`);
                    const idx = sp.getInt8(0x30);
                    let variant = `index ${idx}`;
                    if (tp.getInt8(0x30) !== idx) bad.push(`${what} variant index ${tp.getInt8(0x30)} vs ${idx}`);
                    else if (idx === 0) {
                        variant = `server:${sp.getInt32(0x20)}`;
                        if (tp.getInt32(0x20) !== sp.getInt32(0x20)) bad.push(`${what} server id ${tp.getInt32(0x20)} vs ${sp.getInt32(0x20)}`);
                    } else if (idx === 1 || idx === 2) {
                        variant = `idx${idx}:${addr(sp.getPointer(0x20))}:${sp.getInt32(0x28)}`;
                        if (!tp.getPointer(0x20).equalsptr(sp.getPointer(0x20)) || tp.getInt32(0x28) !== sp.getInt32(0x28)) bad.push(`${what} variant idx${idx}:${addr(tp.getPointer(0x20))}:${tp.getInt32(0x28)} vs ${variant}`);
                    }
                    if (tp.getInt32(0x38) !== sp.getInt32(0x38)) bad.push(`${what} runtime id ${tp.getInt32(0x38)} vs ${sp.getInt32(0x38)}`);
                    const ss = src._unknown, ts = dst._unknown;
                    if (ts !== ss) bad.push(`${what} user data ${ts.length} bytes, not equal to the source's ${ss.length}`);
                    const heap = sp.getInt64AsFloat(0x58) > 15;
                    if (heap && tp.getPointer(0x40).equalsptr(sp.getPointer(0x40))) bad.push(`${what} user-data buffer ${addr(tp.getPointer(0x40))} is the source's`);
                    const info = `${implInfo}, count ${tp.getUint16(0x10)}, +0x18 ${tp.getUint8(0x18)}, ${variant}, runtime id ${tp.getInt32(0x38)}, ${ts.length} user-data bytes equal (${heap ? `own buffer ${addr(tp.getPointer(0x40))}, source ${addr(sp.getPointer(0x40))}` : "SSO"})`;
                    return { bad, info };
                };
                const srcNbt = nbt(it);
                const empty = arg === "empty";
                console.log(`${TAG} INFO fromdesc held=${describe(it)} name="${nameOf(it)}" count=${it.amount} aux=${it.getAuxValue()} id=${it.getId()} net=${netId(it)} userData=${addr(P(it).getNullablePointer(16))} nbt=${srcNbt}`);
                check("fromdesc source", empty ? it.isNull() : nameOf(it) === arg, `the held item is "${nameOf(it)}" (want ${empty ? "an empty hand" : `"${arg}"`})`);

                // 1. NetworkItemStackDescriptor(held) -> fromDescriptor
                const d = NetworkItemStackDescriptor.constructWith(it);
                const dp = P(d);
                const udLen = d._unknown.length;
                console.log(`${TAG} INFO fromdesc desc vptr=${addr(dp.getPointer(0))} impl=${addr(dp.getNullablePointer(8))} count=${dp.getUint16(0x10)} netIdx=${dp.getInt8(0x30)} runtimeId=${dp.getInt32(0x38)} userData=${udLen} bytes`);
                const s1 = ItemStack.fromDescriptor(d, palette, false);
                console.log(`${TAG} INFO fromdesc s1=${describe(s1)} userData=${addr(P(s1).getNullablePointer(16))} net=${netId(s1)} nbt=${nbt(s1)}`);
                const b1 = same(s1, "s1");
                check("fromdesc stack", b1.length === 0, b1.length === 0 ? `a new ItemStack at ${addr(s1)}: name "${nameOf(s1)}", count ${s1.amount}, aux ${s1.getAuxValue()}, id ${s1.getId()}, net ${netId(s1)}, NBT equal to the source's, user data ${addr(P(s1).getNullablePointer(16))}` : b1.join("; "));
                s1.destruct();
                check("fromdesc after", nbt(it) === srcNbt, `s1 destructed, the source still reads its own NBT: ${nbt(it) === srcNbt}`);

                // 1b. NetworkItemStackDescriptor's ctor_copy: the engine's copy constructor (docs/findings-nbt.md section 27;
                // 40 0x2431a0 / 51 0x2dbb80). x = NetworkItemStackDescriptor.construct(d) must carry d's fields with its own
                // impl_ (the same InternalItemDescriptor table and full name) and its own string buffer when the string is
                // not SSO; fromDescriptor(x) must be the held stack, and still be after d and its moved-to copy are gone.
                const x = NetworkItemStackDescriptor.construct(d);
                const xc = nisdCopyBad(d, x, "x");
                check("fromdesc nisdcopy", xc.bad.length === 0, xc.bad.length === 0 ? `x at ${addr(x)}: ${xc.info}` : xc.bad.join("; "));
                const s3 = ItemStack.fromDescriptor(x, palette, false);
                const b4 = same(s3, "s3");
                check("fromdesc nisdcopied", b4.length === 0, b4.length === 0 ? `fromDescriptor(x) is the held stack: "${nameOf(s3)}" x${s3.amount}, NBT equal` : b4.join("; "));
                s3.destruct();

                // 2. the move constructor
                const before = { impl: dp.getNullablePointer(8), count: dp.getUint16(0x10), flag: dp.getUint8(0x18), variant: dp.getBin(9, 0x20), rid: dp.getInt32(0x38), ud: d._unknown };
                const m = new NetworkItemStackDescriptor(true);
                m[NativeType.ctor_move](d);
                const mp = P(m);
                const moveBad: string[] = [];
                if (!mp.getPointer(0).equalsptr(nisdVptr)) moveBad.push(`m vptr ${addr(mp.getPointer(0))} (want ${addr(nisdVptr)})`);
                const mImpl = mp.getNullablePointer(8);
                if (before.impl === null ? mImpl !== null : mImpl === null || !mImpl.equalsptr(before.impl)) moveBad.push(`m impl ${addr(mImpl)} (want d's ${addr(before.impl)})`);
                if (dp.getNullablePointer(8) !== null) moveBad.push(`d impl ${addr(dp.getNullablePointer(8))} (want null)`);
                if (mp.getUint16(0x10) !== before.count) moveBad.push(`m count ${mp.getUint16(0x10)} (want ${before.count})`);
                if (mp.getUint8(0x18) !== before.flag) moveBad.push(`m +0x18 ${mp.getUint8(0x18)} (want ${before.flag})`);
                if (mp.getBin(9, 0x20) !== before.variant) moveBad.push(`m net id variant differs`);
                if (mp.getInt32(0x38) !== before.rid) moveBad.push(`m runtime id ${mp.getInt32(0x38)} (want ${before.rid})`);
                if (m._unknown !== before.ud) moveBad.push(`m user data ${m._unknown.length} bytes (want ${before.ud.length})`);
                if (d._unknown !== "" || dp.getInt64AsFloat(0x58) !== 15) moveBad.push(`d user data "${d._unknown.length}" bytes, capacity ${dp.getInt64AsFloat(0x58)} (want an empty SSO string)`);
                check("fromdesc move", moveBad.length === 0, moveBad.length === 0 ? `m: the table's vptr, d's impl ${addr(mImpl)}, count ${before.count}, runtime id ${before.rid}, the variant, ${before.ud.length} user-data bytes; d: impl null, empty string` : moveBad.join("; "));
                const s2 = ItemStack.fromDescriptor(m, palette, false);
                const b2 = same(s2, "s2");
                check("fromdesc moved", b2.length === 0, b2.length === 0 ? `fromDescriptor(m) is the held stack again: "${nameOf(s2)}" x${s2.amount}, NBT equal` : b2.join("; "));
                s2.destruct();
                m.destruct();
                d.destruct();
                // x outlives d and m (whose impl_ is d's old one): its own impl_ and string still make the held stack.
                const s4 = ItemStack.fromDescriptor(x, palette, false);
                const b5 = same(s4, "s4");
                check("fromdesc nisdcopy alone", b5.length === 0, b5.length === 0 ? `d and m destructed, fromDescriptor(x) is still the held stack: "${nameOf(s4)}" x${s4.amount}, NBT equal` : b5.join("; "));
                s4.destruct();
                x.destruct();

                // 3. ItemStack's ctor_copy
                const c = ItemStack.construct(it);
                const b3 = same(c, "copy");
                check("fromdesc ctorcopy", b3.length === 0, b3.length === 0 ? `ItemStack.construct(held) at ${addr(c)}: "${nameOf(c)}" x${c.amount}, NBT equal, user data ${addr(P(c).getNullablePointer(16))} (source ${addr(P(it).getNullablePointer(16))})` : b3.join("; "));
                c.setCustomName("bdsxcopy");
                const want = empty ? "" : "bdsxcopy";
                check("fromdesc ctorcopy deep", customName(c) === want && customName(it) === "" && nbt(it) === srcNbt, `after copy.setCustomName: copy "${customName(c)}" (want "${want}"), source "${customName(it)}" (want ""), source NBT unchanged ${nbt(it) === srcNbt}`);
                c.destruct();
                check("fromdesc ctorcopy destruct", nbt(it) === srcNbt, `copy destructed, the source still reads its own NBT: ${nbt(it) === srcNbt}`);

                // 4. 200 rounds
                let rounds = 0;
                let why = "";
                for (let i = 0; i < 200; i++) {
                    const kd = NetworkItemStackDescriptor.constructWith(it);
                    const kx = NetworkItemStackDescriptor.construct(kd);
                    const kxc = nisdCopyBad(kd, kx, "kx");
                    const km = new NetworkItemStackDescriptor(true);
                    km[NativeType.ctor_move](kd);
                    const ks = ItemStack.fromDescriptor(km, palette, false);
                    const kc = ItemStack.construct(ks);
                    const bad = kxc.bad.concat(same(ks, "ks"), same(kc, "kc"));
                    kc.destruct();
                    ks.destruct();
                    km.destruct();
                    kd.destruct();
                    const kxs = ItemStack.fromDescriptor(kx, palette, false);
                    bad.push(...same(kxs, "kxs"));
                    kxs.destruct();
                    kx.destruct();
                    if (bad.length !== 0) {
                        why = bad.join("; ");
                        break;
                    }
                    rounds++;
                }
                check("fromdesc rounds", rounds === 200 && nbt(it) === srcNbt, `${rounds}/200 rounds of descriptor + descriptor copy + move + fromDescriptor + ctor_copy + fromDescriptor(copy) after the source is gone + compare + seven destructs${why ? `: ${why}` : ""}; the source's NBT unchanged ${nbt(it) === srcNbt}`);
                break;
            }
            case "audit": {
                // docs/findings-audit.md "The next audit batch" (2026-09-27): the fixes that audit made, each checked
                // against a value BDS computes itself or a vanilla constant.
                auditStep(p, arg);
                break;
            }
            case "construct": {
                // ItemStack.constructWith (next-steps Q9, docs/findings-nbt.md "createItemStack"): bdsx's own
                // CommandUtils::createItemStack over ItemStack::fromTag. After `clear @a` + `give @a diamond 1`:
                // slot 0 holds BDS's own diamond, the reference every check below is measured against.
                const inv = p.getInventory();
                const ref = inv.container.getItem(0);
                console.log(`${TAG} INFO construct ref=${describe(ref)} id=${ref.getId()}`);
                const made = ItemStack.constructWith("minecraft:diamond", 3);
                console.log(`${TAG} INFO construct made=${describe(made)} id=${made.getId()} amount=${made.getAmount()} aux=${made.getAuxValue()}`);
                check(
                    "construct-diamond",
                    !made.isNull() && made.getAmount() === 3 && made.getId() === ref.getId() && made.toString().toLowerCase().includes("diamond"),
                    `constructWith("minecraft:diamond", 3): not null, amount ${made.getAmount()}, id ${made.getId()} (BDS's give: ${ref.getId()}), BDS's toString "${made.toString()}"`,
                );
                check("construct-sameaux", ref.sameItemAndAux(made), "BDS's own sameItemAndAux(give's diamond, bdsx's) is true");
                const bare = ItemStack.constructWith("diamond");
                check("construct-bare", !bare.isNull() && bare.getId() === ref.getId() && bare.getAmount() === 1, `constructWith("diamond"): id ${bare.getId()}, amount ${bare.getAmount()} (no namespace, default count 1)`);
                const sword = ItemStack.constructWith("minecraft:diamond_sword", 5);
                check("construct-maxstack", !sword.isNull() && sword.getAmount() === 1 && sword.toString().toLowerCase().includes("sword"), `constructWith("minecraft:diamond_sword", 5) clamps to the max stack size: amount ${sword.getAmount()}, "${sword.toString()}"`);
                const many = ItemStack.constructWith("minecraft:apple", 100);
                check("construct-clamp64", many.getAmount() === 64, `constructWith("minecraft:apple", 100): amount ${many.getAmount()} (2024 clamps the count to 64)`);
                const potion = ItemStack.constructWith("minecraft:potion", 1, 22);
                check("construct-aux", !potion.isNull() && potion.getAuxValue() === 22, `constructWith("minecraft:potion", 1, 22): aux ${potion.getAuxValue()}, "${potion.toString()}"`);
                const stone = ItemStack.constructWith("minecraft:stone", 2);
                let stoneBlock = "?";
                try {
                    stoneBlock = String(stone.isBlock());
                } catch (err) {
                    stoneBlock = `<${(err as Error).message}>`;
                }
                check("construct-block", !stone.isNull() && stone.getAmount() === 2 && stone.toString().toLowerCase().includes("stone"), `constructWith("minecraft:stone", 2): "${stone.toString()}", isBlock ${stoneBlock}`);
                const bogus = ItemStack.constructWith("minecraft:not_an_item_bdsx");
                check("construct-unknown", bogus.isNull(), `constructWith("minecraft:not_an_item_bdsx") is null (isNull ${bogus.isNull()}, "${bogus.toString()}")`);
                // Item names and isBlock (next-steps Q9, docs/findings-nbt.md "Item names"): getName() goes through the
                // derived Item::getCommandNames (Item::full_name_, or the block type's name for a block item) and
                // isBlock() through the derived ItemStackBase::isBlock (Item::block_type_). The names are checked
                // against the engine's own lookup: each stack below was found by that name in the item registry.
                const nameOf = (s: ItemStackBase): string => {
                    try {
                        return s.getName();
                    } catch (err) {
                        return `<${(err as Error).message}>`;
                    }
                };
                const blockOf = (s: ItemStackBase): string => {
                    try {
                        return String(s.isBlock());
                    } catch (err) {
                        return `<${(err as Error).message}>`;
                    }
                };
                check("construct-name", nameOf(made) === "minecraft:diamond" && nameOf(ref) === "minecraft:diamond", `getName(): bdsx's constructWith "${nameOf(made)}", BDS's give "${nameOf(ref)}"`);
                const cn = made.getItem()!.getCommandNames2();
                const cnList = cn.toArray().map(c => `${c.name}/${c.inverted}`);
                cn.destruct();
                check("construct-cmdnames", cnList.join(",") === "minecraft:diamond/false,diamond/true", `Item::getCommandNames of the diamond: [${cnList.join(", ")}] (2024: the full name, then the raw name under "minecraft")`);
                const torch = ItemStack.constructWith("minecraft:torch");
                const log = ItemStack.constructWith("minecraft:oak_log");
                const named: [ItemStack, string][] = [
                    [made, "minecraft:diamond"],
                    [sword, "minecraft:diamond_sword"],
                    [many, "minecraft:apple"],
                    [potion, "minecraft:potion"],
                    [stone, "minecraft:stone"],
                    [torch, "minecraft:torch"],
                    [log, "minecraft:oak_log"],
                ];
                const nameRows = named.map(([s, want]) => `${want}->${nameOf(s)}`);
                check("construct-names", named.every(([s, want]) => nameOf(s) === want), `constructWith(name).getName() round-trips for ${named.length}: ${nameRows.join(" ")}`);
                const blocks: [ItemStackBase, string, boolean][] = [
                    [stone, "stone", true],
                    [torch, "torch", true],
                    [log, "oak_log", true],
                    [made, "diamond", false],
                    [ref, "give's diamond", false],
                    [sword, "diamond_sword", false],
                    [many, "apple", false],
                    [potion, "potion", false],
                    [bogus, "null stack", false],
                ];
                const blockRows = blocks.map(([s, what, want]) => `${what}=${blockOf(s)}${blockOf(s) === String(want) ? "" : "(want " + want + ")"}`);
                check("construct-isblock", blocks.every(([s, , want]) => blockOf(s) === String(want)), `isBlock(): ${blockRows.join(" ")}`);
                const stoneType = itemBlockType(stone.getItem()! as any as StaticPointer);
                let stoneLegacy = "<no block type>";
                if (stoneType !== null) {
                    try {
                        stoneLegacy = stoneType.as(BlockLegacy).getCommandName();
                    } catch (err) {
                        stoneLegacy = `<${(err as Error).message}>`;
                    }
                }
                check("construct-blocknames", stoneLegacy === "minecraft:stone", `BlockLegacy::getCommandNames of stone's block type: first "${stoneLegacy}"`);
                torch.destruct();
                log.destruct();
                // Into the bot's inventory: BDS's slot 0 diamond out, bdsx's three in, BDS counts them.
                inv.clearSlot(0, ContainerId.Inventory);
                const added = inv.addItem(made, true);
                const slot = inv.container.getItem(0);
                const one = ItemStack.constructWith("minecraft:diamond");
                const counted = inv.container.getItemCount(one);
                console.log(`${TAG} INFO construct added=${added} slot0=${describe(slot)} count=${counted}`);
                check("construct-inventory", !slot.isNull() && slot.getId() === ref.getId() && counted === 3, `PlayerInventory::add put bdsx's stack in slot 0 ("${slot.toString()}") and BDS's Container::getItemCount counts ${counted} diamonds`);
                for (const s of [made, bare, sword, many, potion, stone, bogus, one]) s.destruct();
                break;
            }
            case "constructcount":
            case "constructgone": {
                // constructcount: a console round later, the diamonds are still the inventory's; constructgone: after
                // the console's `clear @a diamond`, BDS removed what bdsx put there -- it is a diamond to BDS too.
                const one = ItemStack.constructWith("minecraft:diamond");
                const counted = p.getInventory().container.getItemCount(one);
                one.destruct();
                const want = step === "constructcount" ? 3 : 0;
                check(step, counted === want, `BDS's Container::getItemCount(diamond) is ${counted}, want ${want}`);
                break;
            }
            case "flags": {
                // ItemStackBase::getRawNameId / isExplodable / isFireResistant (docs/findings-containers.md section 19) on
                // items BDS's own `give` put in the inventory. The raw name is checked against the full name's second half
                // (Item::full_name_, confirmed), the flags against known items: netherite resists fire, a nether star
                // survives explosions, a diamond does neither
                const want: [string, boolean, boolean][] = [
                    ["minecraft:diamond", true, false],
                    ["minecraft:netherite_ingot", true, true],
                    ["minecraft:nether_star", false, false],
                    ["minecraft:oak_planks", true, false],
                    ["minecraft:stone", true, false],
                ];
                const c = p.getInventory().container;
                for (const [name, expl, fire] of want) {
                    let stack: ItemStack | null = null;
                    for (let i = 0; i < 36; i++) {
                        const it = c.getItem(i);
                        if (it.isNull()) continue;
                        const item = it.getItem();
                        if (item !== null && itemFullName(item as any as StaticPointer) === name) {
                            stack = it;
                            break;
                        }
                    }
                    if (stack === null) {
                        check(`flags ${name}`, false, "not in the inventory (the driver gives it)");
                        continue;
                    }
                    const raw = stack.getRawNameId();
                    const gotExpl = stack.isExplodable();
                    const gotFire = stack.isFireResistant();
                    const byte = (stack.getItem() as any as StaticPointer).getUint8(pdbcache.layouts.Item?.flags ?? 0x14a);
                    const block = itemBlockType(stack.getItem() as any as StaticPointer) !== null;
                    if (name === "minecraft:diamond") {
                        // ItemStackBase::setAuxValue (derived, 2024 `aux_ = max(value, 0)`): the engine's own toString prints aux_
                        stack.setAuxValue(7);
                        const s7 = stack.toString();
                        stack.setAuxValue(-3);
                        const sNeg = stack.toString();
                        stack.setAuxValue(0);
                        check("flags setAuxValue", s7.endsWith("@7") && sNeg.endsWith("@0") && stack.toString().endsWith("@0"), `setAuxValue(7) -> ${s7}, setAuxValue(-3) -> ${sNeg} (want @7, @0)`);
                    }
                    check(
                        `flags ${name}`,
                        raw === name.slice(name.indexOf(":") + 1) && gotExpl === expl && gotFire === fire,
                        `getRawNameId '${raw}' (${block ? "the block type's" : "the item's"}; want '${name.slice(name.indexOf(":") + 1)}'), isExplodable ${gotExpl} (${expl}), isFireResistant ${gotFire} (${fire}); flag byte 0x${byte.toString(16)}`,
                    );
                }
                break;
            }
            case "stackutil": {
                // ItemStackBase::isFullStack / isDamaged / isPotionItem (derived, docs/findings-containers.md section 19): items
                // from BDS's own give (64 diamonds, 5 stone, a potion, a splash potion, a sword) and a sword BDS's own
                // ItemStack::fromTag builds with 10 damage
                const find = (name: string): ItemStack | null => {
                    const c = p.getInventory().container;
                    for (let i = 0; i < 36; i++) {
                        const it = c.getItem(i);
                        if (it.isNull()) continue;
                        const item = it.getItem();
                        if (item !== null && itemFullName(item as any as StaticPointer) === name) return it;
                    }
                    return null;
                };
                const rows: [string, ItemStack | null, boolean, boolean, boolean][] = [
                    ["64 diamond", find("minecraft:diamond"), true, false, false],
                    ["5 stone", find("minecraft:stone"), false, false, false],
                    ["potion", find("minecraft:potion"), true, false, true],
                    ["splash_potion", find("minecraft:splash_potion"), true, false, true],
                    ["diamond_sword", find("minecraft:diamond_sword"), true, false, false],
                ];
                const worn = ItemStack.fromTag({ Name: "minecraft:diamond_sword", Count: NBT.byte(1), Damage: NBT.short(0), tag: { Damage: NBT.int(10) } });
                rows.push(["fromTag sword with 10 damage", worn, true, true, false]);
                for (const [label, st, full, dmg, pot] of rows) {
                    if (st === null) {
                        check(`stackutil ${label}`, false, "not in the inventory (the driver gives it)");
                        continue;
                    }
                    const f = st.isFullStack(), d = st.isDamaged(), q = st.isPotionItem();
                    check(`stackutil ${label}`, f === full && d === dmg && q === pot, `count ${st.amount} max ${st.getMaxStackSize()}: isFullStack ${f} (${full}), damage ${st.getDamageValue()} isDamaged ${d} (${dmg}), isPotionItem ${q} (${pot})`);
                }
                worn.destruct();
                break;
            }
            case "stackmatch": {
                // ItemStackBase::matchesItem (an address, 40 0x1bc5b80 / 51 0x1a57fd0) and ::matches (bdsx's own:
                // matchesItem plus the count byte, 2024 0x1b4d9b0), docs/findings-containers.md "matchesItem".
                // Every stack is one BDS or bdsx's constructWith over BDS's fromTag made; the engine answers.
                const dia3 = ItemStack.constructWith("minecraft:diamond", 3);
                const dia3b = ItemStack.constructWith("minecraft:diamond", 3);
                const dia5 = ItemStack.constructWith("minecraft:diamond", 5);
                const emerald3 = ItemStack.constructWith("minecraft:emerald", 3);
                const pot22 = ItemStack.constructWith("minecraft:potion", 1, 22);
                const pot5 = ItemStack.constructWith("minecraft:potion", 1, 5);
                const pot22b = ItemStack.constructWith("minecraft:potion", 1, 22);
                const named = ItemStack.constructWith("minecraft:diamond", 3);
                named.setCustomName("bdsx-match");
                const named2 = ItemStack.constructWith("minecraft:diamond", 3);
                named2.setCustomName("bdsx-match");
                const named3 = ItemStack.constructWith("minecraft:diamond", 3);
                named3.setCustomName("bdsx-other");
                const empty1 = ItemStack.constructWith("minecraft:bdsx_no_such_item");
                const empty2 = ItemStack.constructWith("minecraft:bdsx_no_such_item");
                check("stackmatch nulls", empty1.isNull() && empty2.isNull(), "an unknown name gives the null stack (the constructWith rule)");
                const inv = p.getInventory().container;
                let given: ItemStack | null = null;
                for (let i = 0; i < 36; i++) {
                    const it = inv.getItem(i);
                    if (it.isNull()) continue;
                    const item = it.getItem();
                    if (item !== null && itemFullName(item as any as StaticPointer) === "minecraft:diamond") given = it;
                }
                const rows: [string, ItemStack, ItemStack, boolean, boolean][] = [
                    ["same diamond x3", dia3, dia3b, true, true],
                    ["diamond x3 vs x5 (count only)", dia3, dia5, true, false],
                    ["diamond vs emerald", dia3, emerald3, false, false],
                    ["potion aux 22 vs 5", pot22, pot5, false, false],
                    ["potion aux 22 vs 22", pot22, pot22b, true, true],
                    ["name tag vs none", named, dia3, false, false],
                    ["none vs name tag", dia3, named, false, false],
                    ["same name tag", named, named2, true, true],
                    ["name tag vs another name", named, named3, false, false],
                    ["null vs null", empty1, empty2, true, true],
                    ["null vs diamond", empty1, dia3, false, false],
                    ["diamond vs null", dia3, empty1, false, false],
                ];
                if (given !== null) rows.push([`BDS's give (x${given.amount}) vs constructed x3`, given, dia3, true, given.amount === 3]);
                else check("stackmatch give", false, "no diamond in the inventory (the driver gives one)");
                for (const [label, a, b, wantItem, wantFull] of rows) {
                    const mi = a.matchesItem(b), mf = a.matches(b), ri = b.matchesItem(a), rf = b.matches(a);
                    check(
                        `stackmatch ${label}`,
                        mi === wantItem && mf === wantFull && ri === wantItem && rf === wantFull,
                        `matchesItem ${mi}/${ri} (want ${wantItem}), matches ${mf}/${rf} (want ${wantFull}), a=${describe(a)} b=${describe(b)}`,
                    );
                }
                for (const s of [dia3, dia3b, dia5, emerald3, pot22, pot5, pot22b, named, named2, named3, empty1, empty2]) s.destruct();
                break;
            }
            case "stackcount": {
                // ItemStackBase::add (bdsx: addAmount) / ::remove, bdsx's own code (2024 0x1b562c0 / 0x1b68590:
                // set(count +/- n); set clamps to getMaxStackSize and calls setNull when nothing is left)
                const apple = ItemStack.constructWith("minecraft:apple", 3);
                apple.addAmount(2);
                check("stackcount add 3+2", apple.amount === 5 && !apple.isNull(), `apple x3 +2 -> ${apple.amount}`);
                apple.addAmount(100);
                check("stackcount add clamps to 64", apple.amount === 64 && !apple.isNull(), `apple x5 +100 -> ${apple.amount} (max ${apple.getMaxStackSize()})`);
                apple.remove(4);
                check("stackcount remove 64-4", apple.amount === 60 && !apple.isNull(), `apple x64 -4 -> ${apple.amount}`);
                apple.remove(60);
                check("stackcount remove to zero nulls the stack", apple.amount === 0 && apple.isNull(), `apple x60 -60 -> amount ${apple.amount}, isNull ${apple.isNull()}, ${describe(apple)}`);
                const sword = ItemStack.constructWith("minecraft:diamond_sword", 1);
                sword.addAmount(1);
                check("stackcount unstackable add clamps to 1", sword.amount === 1 && !sword.isNull(), `sword x1 +1 -> ${sword.amount} (max ${sword.getMaxStackSize()})`);
                sword.remove(1);
                check("stackcount unstackable remove nulls", sword.amount === 0 && sword.isNull(), `sword x1 -1 -> amount ${sword.amount}, isNull ${sword.isNull()}`);
                const dia = ItemStack.constructWith("minecraft:diamond", 10);
                dia.addAmount(0);
                dia.remove(0);
                check("stackcount +0 -0 unchanged", dia.amount === 10 && !dia.isNull(), `diamond x10 +0 -0 -> ${dia.amount}`);
                // the stack BDS made itself: matches() sees the change BDS's own compare can see
                const twin = ItemStack.constructWith("minecraft:diamond", 10);
                dia.remove(3);
                check("stackcount remove seen by matches", !dia.matches(twin) && dia.matchesItem(twin) && twin.amount - dia.amount === 3, `diamond x10 -3 -> ${dia.amount}: matches ${dia.matches(twin)}, matchesItem ${dia.matchesItem(twin)}`);
                for (const s of [apple, sword, dia, twin]) s.destruct();
                break;
            }
            case "names": {
                // ItemStackBase getCustomName (buildDescriptionName slot 93 when unnamed) / hasCustomName / setCustomLore /
                // getCustomLore over display.Name / display.Lore, and the engine's own save() seeing what bdsx wrote
                const c = p.getInventory().container;
                let dia: ItemStack | null = null, planks: ItemStack | null = null;
                for (let i = 0; i < 36; i++) {
                    const it = c.getItem(i);
                    if (it.isNull()) continue;
                    const n = itemFullName(it.getItem()! as any as StaticPointer);
                    if (n === "minecraft:diamond") dia = it;
                    if (n === "minecraft:oak_planks") planks = it;
                }
                if (dia === null || planks === null) {
                    check("names", false, "diamond / oak_planks not in the inventory (the driver gives them)");
                    break;
                }
                const which = arg === "" ? "both" : arg;
                if (which === "vft") {
                    const base = (process as any).bdsxBase;
                    for (const [label, st] of [["diamond", dia], ["oak_planks", planks]] as [string, ItemStack][]) {
                        const it = st.getItem()! as any as StaticPointer;
                        const vt = it.getPointer(0), s93 = vt.getPointer(93 * 8), s94 = vt.getPointer(94 * 8);
                        console.log(`${TAG} INFO names vft ${label}: vftable ${vt} slot93 ${s93} slot94 ${s94}`);
                    }
                    break;
                }
                if (which === "blk") {
                    // slot 93 on block items other than the planks
                    for (const n of ["minecraft:stone", "minecraft:chest"]) {
                        for (let i = 0; i < 36; i++) {
                            const it = c.getItem(i);
                            if (!it.isNull() && itemFullName(it.getItem()! as any as StaticPointer) === n) console.log(`${TAG} INFO names blk ${n}: '${it.getCustomName()}'`);
                        }
                    }
                    break;
                }
                if (which === "desc") {
                    // the block type's description_id_ (+8, Endstone block_type.h) + ".name" through translateText, for block items
                    const { translateText } = require("bdsx/bds/engine/textobject");
                    for (const n of ["minecraft:oak_planks", "minecraft:stone", "minecraft:chest", "minecraft:dirt"]) {
                        let st: ItemStack | null = null;
                        for (let i = 0; i < 36; i++) {
                            const it = c.getItem(i);
                            if (!it.isNull() && itemFullName(it.getItem()! as any as StaticPointer) === n) st = it;
                        }
                        if (st === null) continue;
                        const bt = itemBlockType(st.getItem()! as any as StaticPointer)!;
                        const id = bt.getCxxString(8);
                        console.log(`${TAG} INFO names desc ${n}: description_id '${id}' -> '${translateText(id + ".name", [])}'`);
                    }
                    break;
                }
                if (which === "unnamed1") {
                    // only the diamond's buildDescriptionName, once
                    check("names unnamed1", dia.getCustomName() === "Diamond", `diamond: '${dia.getCustomName()}'`);
                    break;
                }
                if (which === "named") {
                    // skip the unnamed half (a crash bisect: buildDescriptionName vs the NBT writes)
                } else {
                const n0 = dia.getCustomName(), h0 = dia.hasCustomName(), l0 = dia.getCustomLore();
                // block items: the block type's description id translated (stone, chest); oak_planks has no such key and throws
                const blockName = (want: string): string => {
                    for (let i = 0; i < 36; i++) {
                        const it = c.getItem(i);
                        if (!it.isNull() && itemFullName(it.getItem()! as any as StaticPointer) === want) {
                            try {
                                return it.getCustomName();
                            } catch (err) {
                                return `threw: ${(err as Error).message}`;
                            }
                        }
                    }
                    return "(not given)";
                };
                const sn = blockName("minecraft:stone"), cn = blockName("minecraft:chest"), pn = blockName("minecraft:oak_planks");
                check("names unnamed", n0 === "Diamond" && !h0 && l0.length === 0 && sn === "Stone" && cn === "Chest" && pn.startsWith("threw:"), `diamond: getCustomName '${n0}' hasCustomName ${h0} lore [${l0.join(",")}]; stone '${sn}', chest '${cn}', oak_planks '${pn}' (want Diamond, false, [], Stone, Chest, a refusal)`);
                }
                if (which === "unnamed") break;
                dia.setCustomName("Probe Gem");
                dia.setCustomLore(["line one", "line two"]);
                const n1 = dia.getCustomName(), h1 = dia.hasCustomName(), l1 = dia.getCustomLore();
                const saved = dia.save() as any;
                const disp = saved?.tag?.display;
                const val = (v: any): any => (v !== null && typeof v === "object" && "_value" in v ? v._value : v);
                const savedName = disp ? val(disp.Name) : undefined;
                const savedLore = disp && Array.isArray(disp.Lore) ? disp.Lore.map(val) : disp?.Lore;
                check(
                    "names named",
                    n1 === "Probe Gem" && h1 && l1.join("|") === "line one|line two" && savedName === "Probe Gem" && JSON.stringify(savedLore) === JSON.stringify(["line one", "line two"]),
                    `after setCustomName / setCustomLore: getCustomName '${n1}' hasCustomName ${h1} lore [${l1.join(",")}]; the engine's save(): display.Name ${JSON.stringify(savedName)} Lore ${JSON.stringify(savedLore)}`,
                );
                break;
            }
            case "virt": {
                // the seven Item virtuals ItemStackBase forwards to (engine/item.ts ITEM_SLOTS), on items from BDS's own give
                const c = p.getInventory().container;
                const get = (name: string): ItemStack | null => {
                    for (let i = 0; i < 36; i++) {
                        const it = c.getItem(i);
                        if (!it.isNull() && itemFullName(it.getItem()! as any as StaticPointer) === name) return it;
                    }
                    return null;
                };
                const row = (name: string): string => {
                    const st = get(name);
                    if (st === null) return `${name}: not given`;
                    return `${name}: maxDamage ${st.getMaxDamage()} attack ${st.getAttackDamage()} enchantValue ${st.getEnchantValue()} glint ${st.isGlint()} pattern ${st.isPattern()} liquidClip ${st.isLiquidClipItem()} stackedByData ${st.isStackedByData()}`;
                };
                const names = ["minecraft:diamond_sword", "minecraft:golden_sword", "minecraft:bucket", "minecraft:creeper_banner_pattern", "minecraft:potion", "minecraft:diamond", "minecraft:nether_star"];
                for (const n of names) console.log(`${TAG} INFO virt ${row(n)}`);
                const S = (n: string) => get(n)!;
                const ok =
                    S("minecraft:diamond_sword").getMaxDamage() === 1561 && S("minecraft:golden_sword").getMaxDamage() === 32 && S("minecraft:diamond").getMaxDamage() === 0 &&
                    S("minecraft:diamond_sword").getEnchantValue() === 10 && S("minecraft:golden_sword").getEnchantValue() === 22 &&
                    S("minecraft:diamond_sword").getAttackDamage() > S("minecraft:golden_sword").getAttackDamage() && S("minecraft:diamond").getAttackDamage() === 0 &&
                    S("minecraft:bucket").isLiquidClipItem() && !S("minecraft:diamond").isLiquidClipItem() &&
                    S("minecraft:creeper_banner_pattern").isPattern() && !S("minecraft:diamond").isPattern() &&
                    S("minecraft:nether_star").isGlint() && !S("minecraft:diamond").isGlint() &&
                    S("minecraft:potion").isStackedByData() && !S("minecraft:diamond").isStackedByData();
                check("virt", ok, "maxDamage 1561 / 32 / 0, enchantValue 10 / 22, attack diamond > gold > 0 = diamond, bucket liquid-clip, pattern, nether star glints, potion stacks by data");
                break;
            }
            case "mine": {
                // ItemStack.getDestroySpeed (Item slot 88), ItemStackBase.canDestroySpecial (slot 33), setDamageValue (NBT)
                // on items from give and the stone / dirt the driver placed at 31 / 32, 68, 16
                const c = p.getInventory().container;
                const get = (name: string): ItemStack | null => {
                    for (let i = 0; i < 36; i++) {
                        const it = c.getItem(i);
                        if (!it.isNull() && itemFullName(it.getItem()! as any as StaticPointer) === name) return it;
                    }
                    return null;
                };
                const region = p.getRegion();
                const stone = region.getBlock(BlockPos.create(31, 68, 16)), dirt = region.getBlock(BlockPos.create(32, 68, 16));
                if (stone.getName() !== "minecraft:stone" || dirt.getName() !== "minecraft:dirt") {
                    check("mine", false, `blocks at 31/32,68,16 are ${stone.getName()} / ${dirt.getName()} (the driver places stone and dirt)`);
                    break;
                }
                const dp = get("minecraft:diamond_pickaxe"), wp = get("minecraft:wooden_pickaxe"), dia = get("minecraft:diamond"), sw = get("minecraft:iron_sword");
                if (dp === null || wp === null || dia === null || sw === null) {
                    check("mine", false, "items not given");
                    break;
                }
                const sp = (st: ItemStack, b: Block): number => Math.round(st.getDestroySpeed(b) * 100) / 100;
                const r = { dpStone: sp(dp, stone), dpDirt: sp(dp, dirt), wpStone: sp(wp, stone), diaStone: sp(dia, stone) };
                check("mine getDestroySpeed", r.dpStone === 8 && r.wpStone === 2 && r.dpDirt === 1 && r.diaStone === 1, `diamond_pickaxe on stone ${r.dpStone} (8) on dirt ${r.dpDirt} (1), wooden_pickaxe on stone ${r.wpStone} (2), diamond on stone ${r.diaStone} (1)`);
                const cs = { dp: dp.canDestroySpecial(stone), dia: dia.canDestroySpecial(stone) };
                check("mine canDestroySpecial", cs.dp && !cs.dia, `diamond_pickaxe on stone ${cs.dp} (true), diamond on stone ${cs.dia} (false)`);
                const before = sw.getDamageValue();
                sw.setDamageValue(100);
                const after = sw.getDamageValue();
                const saved = sw.save() as any;
                const dmg = saved?.tag?.Damage;
                const val = (v: any): any => (v !== null && typeof v === "object" && "_value" in v ? v._value : v);
                check("mine setDamageValue", before === 0 && after === 100 && val(dmg) === 100 && sw.isDamaged(), `iron_sword damage ${before} -> setDamageValue(100) -> ${after}, isDamaged ${sw.isDamaged()}, the engine's save() tag.Damage ${JSON.stringify(dmg)}`);
                break;
            }
            case "armor2": {
                // Item.isArmor / ItemStackBase isHumanoidWearableArmorItem / isHumanoidWearableItem (derived over the item's
                // isHumanoidArmor slot 10): items from BDS's own give
                const find = (name: string): ItemStack | null => {
                    const c = p.getInventory().container;
                    for (let i = 0; i < 36; i++) {
                        const it = c.getItem(i);
                        if (it.isNull()) continue;
                        const item = it.getItem();
                        if (item !== null && itemFullName(item as any as StaticPointer) === name) return it;
                    }
                    return null;
                };
                const rows: [string, boolean, boolean][] = [
                    ["minecraft:diamond_helmet", true, true],
                    ["minecraft:iron_chestplate", true, true],
                    ["minecraft:carved_pumpkin", false, true],
                    ["minecraft:diamond_sword", false, false],
                    ["minecraft:stone", false, false],
                ];
                for (const [name, armor, wearable] of rows) {
                    const st = find(name);
                    if (st === null) {
                        check(`armor2 ${name}`, false, "not in the inventory (the driver gives it)");
                        continue;
                    }
                    const a = st.getItem()!.isArmor(), b = st.isHumanoidWearableArmorItem(), w = st.isHumanoidWearableItem();
                    check(`armor2 ${name}`, a === armor && b === armor && w === wearable, `Item.isArmor ${a}, isHumanoidWearableArmorItem ${b} (${armor}), isHumanoidWearableItem ${w} (${wearable})`);
                }
                break;
            }
            case "chunkloaded": {
                // LevelChunk::isFullyLoaded (derived over engine/chunk.ts) against the engine's own inlined copy: BlockSource
                // vftable slot 55, areChunksFullyLoaded(BlockPos const&, int), with radius 0 asks exactly the chunk holding
                // the position (40 0x14f5ef0 / 51 0x15f6270 wrap the range function that inlines isFullyLoaded)
                const region = p.getRegion();
                const L = pdbcache.layouts.LevelChunk ?? {};
                const offState = L.loadState, offFlag = L.fullyLoadedFlag, offRs = L.redstoneSetUp, K = L.stateLoaded;
                if (offState === undefined || offFlag === undefined || offRs === undefined || K === undefined) {
                    check("chunkloaded", false, "the table has no LevelChunk load-state layout");
                    break;
                }
                const engine = (bp: BlockPos): boolean => BlockSource$areChunksFullyLoaded(region, bp, 0);
                const pp = p.getPosition();
                const pcx = Math.floor(pp.x) >> 4, pcz = Math.floor(pp.z) >> 4;
                // a square of chunks around the player: every one the region holds, derived vs engine, and the raw bytes
                const combos = new Map<string, number>();
                let seen = 0, agree = 0, trues = 0;
                for (let dx = -12; dx <= 12; dx++) {
                    for (let dz = -12; dz <= 12; dz++) {
                        const bp = BlockPos.create((pcx + dx) * 16 + 8, 64, (pcz + dz) * 16 + 8);
                        const chunk = region.getChunkAt(bp);
                        if (chunk === null) continue;
                        const c = chunk as any as StaticPointer;
                        const d = chunk.isFullyLoaded(), e = engine(bp);
                        seen++;
                        if (d === e) agree++;
                        if (d) trues++;
                        const k = `state ${c.getUint8(offState)} flag ${c.getUint8(offFlag)} redstone ${c.getUint8(offRs)} -> ${d}/${e}`;
                        combos.set(k, (combos.get(k) ?? 0) + 1);
                    }
                }
                console.log(`${TAG} INFO chunkloaded ${seen} chunks around (${pcx},${pcz}): ${[...combos].map(([k, n]) => `${n}x ${k}`).join("; ")}`);
                check("chunkloaded live", seen > 0 && agree === seen, `${seen} chunks, derived == engine for ${agree}, true for ${trues} (state byte ${K} is Loaded on this build)`);
                // Both sides on one chunk: each byte is set for the trial alone and put back, and bdsx and the engine must
                // answer the same. The redstone byte cleared -> false; then the state one below Loaded -> true; state back
                // and the flag set -> true. Wrong offsets or a wrong Loaded would split the two answers somewhere.
                const bp0 = BlockPos.create(pcx * 16 + 8, 64, pcz * 16 + 8);
                const chunk0 = region.getChunkAt(bp0);
                if (chunk0 === null) {
                    check("chunkloaded trials", false, "no chunk under the player");
                    break;
                }
                const c0 = chunk0 as any as StaticPointer;
                const sState = c0.getUint8(offState), sFlag = c0.getUint8(offFlag), sRs = c0.getUint8(offRs);
                const rows: string[] = [];
                let ok = sState === K;
                const trial = (label: string, st: number, fl: number, rs: number, want: boolean): void => {
                    c0.setUint8(st, offState);
                    c0.setUint8(fl, offFlag);
                    c0.setUint8(rs, offRs);
                    const d = chunk0.isFullyLoaded(), e = engine(bp0);
                    c0.setUint8(sState, offState);
                    c0.setUint8(sFlag, offFlag);
                    c0.setUint8(sRs, offRs);
                    if (d !== want || e !== want) ok = false;
                    rows.push(`${label} bdsx ${d} engine ${e} (want ${want})`);
                };
                trial("redstone 0", sState, 0, 0, false);
                trial(`state ${K - 1}`, K - 1, 0, 0, true);
                trial("flag 1", sState, 1, 0, true);
                trial("as found", sState, sFlag, sRs, sState < K || sFlag !== 0 || sRs !== 0);
                const back = c0.getUint8(offState) === sState && c0.getUint8(offFlag) === sFlag && c0.getUint8(offRs) === sRs;
                check("chunkloaded trials", ok && back, `chunk (${pcx},${pcz}) found as state ${sState} flag ${sFlag} redstone ${sRs}; ${rows.join("; ")}; restored ${back}`);
                break;
            }
            case "chunkents": {
                // LevelChunk::getChunkEntities on 1.26: find the vector<WeakEntityRef> (0x18-byte elements) in the chunk
                // holding the pig the driver summoned at 31 68 20, by an element that names that pig (EntityRegistry at
                // actor+8, entity id at actor+24) -- only compares memory, dereferences nothing it has not bounded
                const region = p.getRegion();
                const pigs = p.fetchNearbyActorsSorted(Vec3.create(16, 8, 16), ActorType.Pig);
                if (pigs.length === 0) {
                    check("chunkents", false, "no pig");
                    break;
                }
                const pig = pigs[0].entity as any as StaticPointer;
                const pp = pigs[0].entity.getPosition();
                const chunk = region.getChunkAt(BlockPos.create(Math.floor(pp.x), Math.floor(pp.y), Math.floor(pp.z)));
                if (chunk === null) {
                    check("chunkents", false, "no chunk");
                    break;
                }
                const ch = chunk as any as StaticPointer;
                const reg = pig.getPointer(8), eid = pig.getUint32(24);
                const hi = ch.getAddressHigh();
                const hits: string[] = [];
                // the scan found +0x1360 on both builds (chent40/51 2026-09-29); reading far past it once hit an unmapped page,
                // so only that offset is checked now
                for (let o = 0x1360; o <= 0x1360; o += 8) {
                    const b = ch.getPointer(o), e = ch.getPointer(o + 8), c2 = ch.getPointer(o + 16);
                    if (b.isNull() || b.getAddressHigh() !== hi || e.getAddressHigh() !== hi || c2.getAddressHigh() !== hi) continue;
                    const n = e.subptr(b), cap = c2.subptr(b);
                    if (n <= 0 || n > 0x18 * 256 || n % 0x18 !== 0 || cap < n || cap > 0x18 * 1024) continue;
                    for (let i = 0; i < n / 0x18; i++) {
                        const el = b.add(i * 0x18);
                        if (el.getPointer(0).equalsptr(reg) && el.getUint32(16) === eid) {
                            hits.push(`+0x${o.toString(16)} (${n / 0x18} entries, the pig at #${i})`);
                            break;
                        }
                    }
                }
                console.log(`${TAG} INFO chunkents pig at (${pp.x.toFixed(1)},${pp.z.toFixed(1)}), chunk ${chunk.getPosition().x},${chunk.getPosition().z}: ${hits.join("; ") || "no vector names it"}`);
                const off = pdbcache.layouts.LevelChunk?.entities;
                if (off !== undefined) {
                    const list = chunk.getChunkEntities();
                    const names = list.map(r => (r.tryUnwrapActor() ?? { getIdentifier: () => "?" }).getIdentifier());
                    const pigSeen = list.some(r => {
                        const a = r.tryUnwrapActor();
                        return a !== null && (a as any as StaticPointer).equalsptr(pig);
                    });
                    const asPlayer = list.map(r => r.tryUnwrapPlayer()).filter(x => x !== null).length;
                    // LevelChunk::getEntity(ActorUniqueID): the pig by its unique id, and a made-up id gives null
                    const pigActor = pigs[0].entity;
                    const found = chunk.getEntity(pigActor.getUniqueIdBin());
                    const none = chunk.getEntity(pigActor.getUniqueIdBin() === "\u0001\u0002\u0003\u0004" ? "\u0005\u0006\u0007\u0008" : "\u0001\u0002\u0003\u0004");
                    check("chunkents getEntity", found !== null && (found as any as StaticPointer).equalsptr(pig) && none === null, `getEntity(pig id) ${found === null ? "null" : found.getIdentifier()} (the same actor ${found !== null && (found as any as StaticPointer).equalsptr(pig)}), getEntity(a made-up id) ${none === null ? "null" : "an actor"}`);
                    check("chunkents getChunkEntities", pigSeen && names.every(n => n !== "?"), `getChunkEntities() -> [${names.join(", ")}]; the probed pig among them ${pigSeen}; tryUnwrapPlayer non-null for ${asPlayer}`);
                }
                break;
            }
            case "signal": {
                // Block getVariant / hasComparatorSignal / getComparatorSignal through the block type's slots 102 / 90 / 91, on
                // blocks the driver placed at x 30..35, y 68, z 16 (getDirectSignal / isSignalSource: `dsignal` below)
                const region = p.getRegion();
                const at = (x: number): [Block, BlockPos] => {
                    const bp = BlockPos.create(x, 68, 16);
                    return [region.getBlock(bp), bp];
                };
                const [stone, sp] = at(30), [juke] = at(31), [full, fp] = at(32), [leverOn, lp] = at(34), [leverOff, lop] = at(35);
                // the empty chest stands apart at z 18: next to the full one they pair and share one 54-slot container
                const ep = BlockPos.create(33, 68, 18), empty = region.getBlock(ep);
                const names = [stone, juke, full, empty, leverOn, leverOff].map(b => b.getName());
                console.log(`${TAG} INFO signal blocks ${names.join(", ")}`);
                check("signal hasComparatorSignal", juke.hasComparatorSignal() && full.hasComparatorSignal() && !stone.hasComparatorSignal(), `jukebox ${juke.hasComparatorSignal()}, chest ${full.hasComparatorSignal()}, stone ${stone.hasComparatorSignal()}`);
                const cFull = full.getComparatorSignal(region, fp, 0), cEmpty = empty.getComparatorSignal(region, ep, 0);
                check("signal getComparatorSignal", cFull > 0 && cEmpty === 0, `the chest holding 64 diamonds ${cFull} (> 0), the empty chest ${cEmpty} (0)`);
                const vOn = leverOn.getVariant(), dataOn = (leverOn as any as StaticPointer).getUint16(0x120), vStone = stone.getVariant();
                check("signal getVariant", vOn === dataOn && vStone === 0 && vOn !== 0, `powered lever getVariant ${vOn} (its data_ ${dataOn}), stone ${vStone}`);
                break;
            }
            case "dsignal": {
                // Block getDirectSignal / isSignalSource through BlockType slots 43 / 35 (docs/findings-blocks.md "getDirectSignal
                // and isSignalSource"), on blocks the driver placed on a stone floor at y 67: a repeater at (31, 68, 22) boxed in
                // by four redstone blocks (powered whichever way it faces), and the rest three blocks apart so nothing feeds them
                const region = p.getRegion();
                const at = (x: number, z: number): [Block, BlockPos] => {
                    const bp = BlockPos.create(x, 68, z);
                    return [region.getBlock(bp), bp];
                };
                const [rep, rp] = at(31, 22), [off, op] = at(35, 22), [lever, lp] = at(38, 22), [day] = at(41, 22), [comp] = at(44, 22);
                const [torch] = at(32, 26), [target] = at(35, 26), [observer] = at(38, 26), [rblock] = at(30, 22);
                const floorPos = BlockPos.create(35, 67, 26), floor = region.getBlock(floorPos);
                console.log(`${TAG} INFO dsignal blocks ${[rep, off, lever, day, comp, torch, target, observer, rblock, floor].map(b => b.getName()).join(", ")}`);
                // FacingID 0..5 = down, up, north, south, west, east
                const six = (b: Block, bp: BlockPos) => [0, 1, 2, 3, 4, 5].map(d => b.getDirectSignal(region, bp, d));
                const sRep = six(rep, rp), sOff = six(off, op), sLever = six(lever, lp), sFloor = six(floor, floorPos);
                check(
                    "dsignal getDirectSignal",
                    rep.getName() === "minecraft:powered_repeater" &&
                        sRep.filter(v => v !== 0).length === 1 &&
                        sRep.includes(15) &&
                        [sOff, sLever, sFloor].every(a => a.every(v => v === 0)),
                    `powered repeater [${sRep}] (15 in exactly one direction), unpowered repeater [${sOff}], powered lever [${sLever}], stone [${sFloor}] (all 0)`,
                );
                const src = (b: Block) => `${b.getName().replace("minecraft:", "")} ${b.isSignalSource()}`;
                console.log(`${TAG} INFO dsignal isSignalSource ${[rep, off, comp, day, lever, torch, target, observer, rblock, floor].map(src).join(", ")}`);
                check(
                    "dsignal isSignalSource",
                    rep.isSignalSource() && off.isSignalSource() && comp.isSignalSource() && day.isSignalSource() && !floor.isSignalSource(),
                    `repeater on/off ${rep.isSignalSource()}/${off.isSignalSource()}, comparator ${comp.isSignalSource()}, daylight detector ${day.isSignalSource()} (true), stone ${floor.isSignalSource()} (false)`,
                );
                break;
            }
            case "changed": {
                // BlockActor::setChanged on 1.26 (docs/findings-layouts.md "BlockActor::setChanged"): the Changed bit of
                // VanillaBlockActor's properties_, on block actors the driver placed with `setblock` three blocks apart at y 68
                // (adjacent chests pair): chests at (40, 30), (43, 30), (46, 30); furnace, barrel, hopper, jukebox, sign, beacon
                // at z 34. The engine's reader is the interface's isChanged, on the sub-object 0x1c below properties_.
                const off = pdbcache.layouts.BlockActor?.properties;
                if (typeof off !== "number") {
                    check("changed layout", false, "layouts.BlockActor.properties is missing");
                    break;
                }
                const iface = off - 0x1c;
                const bs = p.getDimensionBlockSource();
                const at = (x: number, z: number): StaticPointer | null => bs.getBlockEntity(BlockPos.create(x, 68, z)) as any as StaticPointer | null;
                const sub = (ba: StaticPointer): VoidPointer => (ba as any as VoidPointer).add(iface);
                const engine = (ba: StaticPointer): boolean => VanillaMain$isChanged(sub(ba));
                const slot22 = (ba: StaticPointer): string => {
                    const fn = ba.getPointer(iface).getPointer(22 * 8);
                    return "0x" + (fn as NativePointer).subptr(dllraw.current).toString(16);
                };
                const byte = (ba: StaticPointer): string => "0x" + ba.getUint8(off).toString(16);
                const others = ["furnace", "barrel", "hopper", "jukebox", "standing_sign", "beacon"];
                const actors = [at(40, 30), at(43, 30), at(46, 30), ...others.map((_, i) => at(40 + 3 * i, 34))];
                if (actors.some(a => a === null)) {
                    check("changed actors", false, `block actors ${actors.map(a => (a === null ? "null" : "ok")).join(",")} (the driver places them)`);
                    break;
                }
                const [a, b, c] = actors as StaticPointer[];
                console.log(`${TAG} INFO changed properties +${off} (interface +${iface}); ${["chest", "chest", "chest", ...others].map((n, i) => `${n} ${byte(actors[i]!)} engine ${engine(actors[i]!)} slot22 ${slot22(actors[i]!)}`).join("; ")}`);
                // every one of them is a VanillaBlockActor: the same out-of-line setChanged at slot 22 of its interface table
                const fns = new Set(actors.map(x => slot22(x!)));
                check("changed vanilla", fns.size === 1, `slot 22 of the interface table at +${iface}: ${[...fns].join(", ")} (one function for all nine)`);
                // (1) chest a: clear the bit so the start is known, the engine reads false; bdsx's setChanged; the engine reads true
                a.setUint8(a.getUint8(off) & ~1, off);
                const before = engine(a), byteBefore = byte(a);
                (a as any as BlockActor).setChanged();
                const after = engine(a), byteAfter = byte(a);
                check("changed setChanged", !before && after, `chest (40,68,30) engine isChanged ${before} (${byteBefore}) -> bdsx setChanged -> ${after} (${byteAfter})`);
                // (2) chest b: clear the bit, then let the engine set it: `replaceitem block` puts an item in the chest
                b.setUint8(b.getUint8(off) & ~1, off);
                const bBefore = engine(b), bByteBefore = byte(b);
                bedrockServer.executeCommand("replaceitem block 43 68 30 slot.container 0 diamond 3");
                const bAfter = engine(b), bByteAfter = byte(b);
                check("changed engine", !bBefore && bAfter && bByteAfter === byteAfter, `chest (43,68,30) ${bByteBefore} engine ${bBefore} -> replaceitem -> ${bByteAfter} engine ${bAfter}; the same byte as bdsx's chest (${byteAfter})`);
                // (3) chest c, untouched until now: what the engine left there since setblock
                console.log(`${TAG} INFO changed chest (46,68,30) untouched ${byte(c)} engine ${engine(c)}`);
                break;
            }
            case "blockfields": {
                // BlockType and Block fields on 1.26 (docs/findings-blocks.md "BlockType and Block fields on 1.26"): blocks
                // the driver placed with `setblock` at x 30..41, y 68, z 16 (rail and white_carpet at y 69, on stone the driver
                // puts under them: on 1.26.51's world the first run found them popped off), read through BlockSource::getBlock
                const L = pdbcache.layouts;
                console.log(`${TAG} INFO blockfields layouts.Block ${JSON.stringify({ e: L.Block?.explosionResistance, f: L.Block?.friction, d: L.Block?.destroySpeed, r: L.Block?.runtimeId })} BlockLegacy ${JSON.stringify({ t: L.BlockLegacy?.thickness, tr: L.BlockLegacy?.translucency })}`);
                // coarse_dirt, not dirt: grass spread onto the placed dirt once (bfield40 2026-09-29 15:5x)
                const names = ["stone", "obsidian", "bedrock", "ice", "glass", "oak_leaves", "chest", "furnace", "rail", "white_carpet", "coarse_dirt", "blast_furnace"];
                const region = p.getRegion();
                type Row = { name: string; hard: number; expl: number; fric: number; trans: number; thick: number; unb: boolean; bet: number; betL: number; has: boolean; rid: number; hash: number };
                const rows: Record<string, Row> = {};
                names.forEach((n, i) => {
                    const y = n === "rail" || n === "white_carpet" ? 69 : 68;
                    const block = region.getBlock(BlockPos.create(30 + i, y, 16));
                    const raw = block as any as StaticPointer;
                    const got = block.getName();
                    if (got !== `minecraft:${n}`) {
                        check(`blockfields ${n}`, false, `block at ${30 + i},${y},16 is "${got}" (the driver places it)`);
                        return;
                    }
                    const r: Row = {
                        name: n,
                        hard: block.getDestroySpeed(),
                        expl: block.getExplosionResistance(),
                        fric: blockFriction(raw),
                        trans: block.getTranslucency(),
                        thick: block.getThickness(),
                        unb: block.isUnbreakable(),
                        bet: block.getBlockEntityType(),
                        betL: block.blockLegacy.getBlockEntityType(),
                        has: block.hasBlockEntity(),
                        rid: block.getRuntimeId(),
                        hash: raw.getUint32(0x110),
                    };
                    rows[n] = r;
                    const f = (x: number): string => (Math.round(x * 1000) / 1000).toString();
                    console.log(`${TAG} INFO blockfields ${n}: destroySpeed ${f(r.hard)} explosionResistance ${f(r.expl)} friction ${f(r.fric)} translucency ${f(r.trans)} thickness ${f(r.thick)} unbreakable ${r.unb} blockEntityType ${r.bet}/${r.betL} has ${r.has} runtimeId 0x${r.rid.toString(16)} (+0x110 0x${r.hash.toString(16)})`);
                });
                const R = (n: string): Row | undefined => rows[n];
                const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-4;
                const all = names.every(n => R(n) !== undefined);
                if (!all) break;
                // Bedrock's obsidian hardness is 35 (Java's is 50): the first run (bfield40 13:1x) read 35, with its explosion
                // resistance 1200 and every other block's hardness at the known value
                check("blockfields destroySpeed", near(R("stone")!.hard, 1.5) && near(R("obsidian")!.hard, 35) && near(R("bedrock")!.hard, -1) && near(R("ice")!.hard, 0.5) && near(R("coarse_dirt")!.hard, 0.5),
                    `stone ${R("stone")!.hard} (1.5), obsidian ${R("obsidian")!.hard} (35), bedrock ${R("bedrock")!.hard} (-1), ice ${R("ice")!.hard} (0.5), coarse_dirt ${R("coarse_dirt")!.hard} (0.5)`);
                check("blockfields isUnbreakable", R("bedrock")!.unb && !R("stone")!.unb && !R("obsidian")!.unb, `bedrock ${R("bedrock")!.unb}, stone ${R("stone")!.unb}, obsidian ${R("obsidian")!.unb}`);
                check("blockfields explosionResistance", R("bedrock")!.expl > R("obsidian")!.expl && R("obsidian")!.expl > 100 * R("stone")!.expl && R("stone")!.expl > R("coarse_dirt")!.expl && R("coarse_dirt")!.expl > 0,
                    `bedrock ${R("bedrock")!.expl} > obsidian ${R("obsidian")!.expl} > 100 x stone ${R("stone")!.expl} > coarse_dirt ${R("coarse_dirt")!.expl} > 0`);
                check("blockfields friction", near(R("ice")!.fric, 0.98) && near(R("stone")!.fric, 0.6), `ice ${R("ice")!.fric} (0.98), stone ${R("stone")!.fric} (0.6)`);
                check("blockfields translucency", R("stone")!.trans === 0 && [R("glass")!, R("oak_leaves")!, R("ice")!].some(r => r.trans > 0),
                    `stone ${R("stone")!.trans} (0), glass ${R("glass")!.trans}, oak_leaves ${R("oak_leaves")!.trans}, ice ${R("ice")!.trans} (one of them > 0)`);
                check("blockfields thickness", R("stone")!.thick === 0 && (R("rail")!.thick > 0 || R("white_carpet")!.thick > 0), `stone ${R("stone")!.thick} (0), rail ${R("rail")!.thick}, white_carpet ${R("white_carpet")!.thick} (one > 0)`);
                check("blockfields blockEntityType",
                    R("chest")!.bet === BlockActorType.Chest && R("furnace")!.bet === BlockActorType.Furnace && R("blast_furnace")!.bet === BlockActorType.BlastFurnace && R("stone")!.bet === 0 && names.every(n => R(n)!.bet === R(n)!.betL),
                    `chest ${R("chest")!.bet} (Chest 2), furnace ${R("furnace")!.bet} (Furnace 1), blast_furnace ${R("blast_furnace")!.bet} (BlastFurnace 0x26), stone ${R("stone")!.bet} (0); Block and BlockLegacy agree`);
                check("blockfields hasBlockEntity", R("chest")!.has && R("furnace")!.has && !R("stone")!.has && !R("glass")!.has, `chest ${R("chest")!.has}, furnace ${R("furnace")!.has}, stone ${R("stone")!.has}, glass ${R("glass")!.has}`);
                // BlockActor::getType on the block actors BDS made for the placed chest / furnace / blast_furnace
                const actorType = (n: string): number | string => {
                    const be = p.getDimensionBlockSource().getBlockEntity(BlockPos.create(30 + names.indexOf(n), 68, 16));
                    return be === null ? "no block actor" : be.getType();
                };
                const at = { chest: actorType("chest"), furnace: actorType("furnace"), blast_furnace: actorType("blast_furnace") };
                check("blockfields BlockActor.getType", at.chest === BlockActorType.Chest && at.furnace === BlockActorType.Furnace && at.blast_furnace === BlockActorType.BlastFurnace,
                    `chest ${at.chest} (2), furnace ${at.furnace} (1), blast_furnace ${at.blast_furnace} (0x26)`);
                // LevelChunk min_ / max_ / position_ and toWorldPos, on the chunk that holds x 30, z 16 (chunk 1, 1)
                const chunk = region.getChunkAt(BlockPos.create(30, 68, 16));
                if (chunk === null) {
                    check("blockfields LevelChunk", false, "getChunkAt returned null");
                } else {
                    const cp = chunk.getPosition(), mn = chunk.getMin(), mx = chunk.getMax();
                    const world = chunk.toWorldPos(ChunkBlockPos.create(14, 68 - mn.y, 0));
                    const cpOk = cp.x === 1 && cp.z === 1;
                    const boxOk = mn.x === 16 && mn.z === 16 && mx.x === 31 && mx.z === 31 && mn.y === -64 && mx.y > 250;
                    const wOk = world.x === 30 && world.y === 68 && world.z === 16;
                    check("blockfields LevelChunk", cpOk && boxOk && wOk,
                        `getPosition (${cp.x},${cp.z}) (want 1,1); getMin (${mn.x},${mn.y},${mn.z}) (16,-64,16); getMax (${mx.x},${mx.y},${mx.z}) (31,>250,31); toWorldPos(14, ${68 - mn.y}, 0) (${world.x},${world.y},${world.z}) (30,68,16)`);
                }
                // BlockLegacy::asItemInstance (the block type's slot 77) and Block.getSilkTouchItemInstance over it: the item of
                // the block type's default state, count 1
                const asItem = names
                    .filter(n => n === "stone" || n === "chest" || n === "oak_leaves" || n === "furnace")
                    .map(n => {
                        const block = region.getBlock(BlockPos.create(30 + names.indexOf(n), 68, 16));
                        const it = block.blockLegacy.asItemInstance(block);
                        const item = it.getItem();
                        const got = `${item === null ? "null" : itemFullName(item as any as StaticPointer)} x${it.amount}`;
                        it.destruct();
                        const silk = block.getSilkTouchItemInstance();
                        const silkItem = silk.getItem();
                        const silkName = silkItem === null ? "null" : itemFullName(silkItem as any as StaticPointer);
                        silk.destruct();
                        return [n, got, silkName] as [string, string, string];
                    });
                // Block.asItemInstance(region, pos): the block type's asItemInstance with the block actor at the position
                const viaPos = ["chest", "stone"].map(n => {
                    const bp = BlockPos.create(30 + names.indexOf(n), 68, 16);
                    const it = region.getBlock(bp).asItemInstance(region, bp);
                    const item = it.getItem();
                    const name = item === null ? "null" : itemFullName(item as any as StaticPointer);
                    it.destruct();
                    return [n, name];
                });
                check("blockfields Block.asItemInstance(region, pos)", viaPos.every(([n, got]) => got === `minecraft:${n}`), viaPos.map(([n, got]) => `${n}: ${got}`).join("; "));
                check("blockfields asItemInstance", asItem.every(([n, got, silk]) => got === `minecraft:${n} x1` && silk === `minecraft:${n}`), asItem.map(([n, got, silk]) => `${n}: ${got}, silk ${silk}`).join("; "));
                const ids = names.map(n => R(n)!.rid);
                check("blockfields runtimeId", new Set(ids).size === ids.length && ids.every(x => x !== 0xffffffff && x !== 0xfffffffe),
                    `${names.length} blocks, ${new Set(ids).size} distinct ids, none unassigned (-1 / -2)`);
                break;
            }
            case "creative": {
                // Item::getCreativeCategory (A1, docs/findings-containers.md section 17): bdsx's derived read of
                // Item::creative_category_ (layouts.Item.creativeCategory, one byte) on items BDS's own `give` put in the
                // inventory -- no bdsx-built stack. After `clear @a` and `give @a <name>` for each name below.
                const want: [string, CreativeItemCategory, string][] = [
                    ["minecraft:diamond_sword", CreativeItemCategory.Equipment, "equipment"],
                    ["minecraft:oak_planks", CreativeItemCategory.Construction, "construction"],
                    // Bedrock files stone (the "itemGroup.name.stone" group, with granite/diorite/andesite) under Nature,
                    // not Construction: the first run (ccat40/51 22:05) read 2 here; creative-block checks the block type's own byte
                    ["minecraft:stone", CreativeItemCategory.Nature, "nature"],
                    ["minecraft:dirt", CreativeItemCategory.Nature, "nature"],
                    ["minecraft:diamond", CreativeItemCategory.Items, "items"],
                    // a block in a third category (Items, with the furnace and the chest); creative-block corroborates it
                    ["minecraft:crafting_table", CreativeItemCategory.Items, "items"],
                ];
                const off = pdbcache.layouts.Item?.creativeCategory;
                console.log(`${TAG} INFO creative layouts.Item.creativeCategory=${off}`);
                const c = p.getInventory().container;
                for (const [name, cat, catName] of want) {
                    let stack: ItemStack | null = null;
                    for (let i = 0; i < 36; i++) {
                        const it = c.getItem(i);
                        if (it.isNull()) continue;
                        const item = it.getItem();
                        if (item !== null && itemFullName(item as any as StaticPointer) === name) {
                            stack = it;
                            break;
                        }
                    }
                    if (stack === null) {
                        check(`creative ${name}`, false, "not in the inventory (the driver gives it)");
                        continue;
                    }
                    const item = stack.getItem()!;
                    const raw = typeof off === "number" ? [...(item as any as StaticPointer).getBuffer(16, off - 4)].map(b => b.toString(16).padStart(2, "0")).join(" ") : "?";
                    const got = item.getCreativeCategory();
                    const gotName = stack.getCategoryName();
                    // corroboration from a second engine field: a block item's BlockType has its own creative_category_
                    // (Endstone block_type.h +352, one byte), which 2024's Item::setCategory compared against the item's
                    const bt = itemBlockType(item as any as StaticPointer);
                    if (bt !== null) {
                        const btCat = bt.getUint8(352);
                        check(`creative-block ${name}`, btCat === got, `the item's BlockType creative_category_ (+352) ${btCat} vs the item's ${got}`);
                        // BlockLegacy::getCreativeCategory (A1, docs/findings-containers.md section 18): bdsx's derived
                        // read of layouts.BlockLegacy.creativeCategory on the same block type
                        const legacyCat = bt.as(BlockLegacy).getCreativeCategory();
                        check(`creative-legacy ${name}`, legacyCat === cat, `BlockLegacy.getCreativeCategory() of the item's block type ${legacyCat} (want ${cat} ${CreativeItemCategory[cat]})`);
                    }
                    check(`creative ${name}`, got === cat && gotName === catName, `Item.getCreativeCategory() ${got} (want ${cat} ${CreativeItemCategory[cat]}), ItemStack.getCategoryName() "${gotName}" (want "${catName}"); bytes at +${typeof off === "number" ? (off - 4).toString(16) : "?"}: ${raw}`);
                }
                // the same through the world: blocks the driver placed with `setblock` (x 31..34, y 70, z 14), read through
                // BlockSource::getBlock and Block.blockLegacy, then BlockLegacy.getCreativeCategory()
                console.log(`${TAG} INFO creative layouts.BlockLegacy.creativeCategory=${pdbcache.layouts.BlockLegacy?.creativeCategory}`);
                const placed: [number, string, CreativeItemCategory][] = [
                    [31, "minecraft:oak_planks", CreativeItemCategory.Construction],
                    [32, "minecraft:stone", CreativeItemCategory.Nature],
                    [33, "minecraft:dirt", CreativeItemCategory.Nature],
                    [34, "minecraft:crafting_table", CreativeItemCategory.Items],
                ];
                const region = p.getRegion();
                for (const [x, name, cat] of placed) {
                    const block = region.getBlock(BlockPos.create(x, 70, 14));
                    const blockName = block.getName();
                    const blockCat = block.blockLegacy.getCreativeCategory();
                    check(
                        `creative-world ${name}`,
                        blockName === name && blockCat === cat,
                        `block at ${x},70,14 "${blockName}" (want "${name}"), blockLegacy.getCreativeCategory() ${blockCat} (want ${cat} ${CreativeItemCategory[cat]})`,
                    );
                }
                break;
            }
            case "armoritem": {
                // ItemStackBase::isArmorItem / isHorseArmorItem (A1, docs/findings-containers.md section 24): bdsx's derived tests
                // over Item::tags_ and the humanoid-armor virtual, on stacks BDS's fromTag made (constructWith), both answers
                const rows: [string, boolean, boolean][] = [
                    ["minecraft:leather_horse_armor", true, true],
                    ["minecraft:iron_horse_armor", true, true],
                    ["minecraft:golden_horse_armor", true, true],
                    ["minecraft:diamond_horse_armor", true, true],
                    ["minecraft:netherite_horse_armor", true, true],
                    ["minecraft:copper_horse_armor", true, true],
                    ["minecraft:diamond_chestplate", true, false],
                    ["minecraft:leather_boots", true, false],
                    ["minecraft:wolf_armor", true, false],
                    ["minecraft:iron_nautilus_armor", true, false],
                    ["minecraft:copper_nautilus_armor", true, false],
                    ["minecraft:stone", false, false],
                    ["minecraft:apple", false, false],
                    ["minecraft:diamond_sword", false, false],
                    ["minecraft:diamond", false, false],
                    ["minecraft:saddle", false, false],
                ];
                for (const [name, wantArmor, wantHorse] of rows) {
                    const st = ItemStack.constructWith(name, 1);
                    if (st.isNull()) {
                        check(`armoritem ${name}`, false, "constructWith gave the null stack (no such item on this build)");
                        continue;
                    }
                    const a = st.isArmorItem(), h = st.isHorseArmorItem();
                    check(`armoritem ${name}`, a === wantArmor && h === wantHorse, `isArmorItem ${a} (want ${wantArmor}), isHorseArmorItem ${h} (want ${wantHorse})`);
                    st.destruct();
                }
                const nul = ItemStack.constructWith("minecraft:bdsx_no_such_item");
                check("armoritem null stack", !nul.isArmorItem() && !nul.isHorseArmorItem(), `null stack: ${nul.isArmorItem()}/${nul.isHorseArmorItem()}`);
                nul.destruct();
                const elytra = ItemStack.constructWith("minecraft:elytra", 1);
                console.log(`${TAG} INFO armoritem elytra isArmorItem=${elytra.isArmorItem()} isHorseArmorItem=${elytra.isHorseArmorItem()}`);
                elytra.destruct();
                // BDS's own give
                const inv = p.getInventory().container;
                for (const [name, wantArmor, wantHorse] of [
                    ["minecraft:iron_horse_armor", true, true],
                    ["minecraft:diamond_chestplate", true, false],
                    ["minecraft:wolf_armor", true, false],
                    ["minecraft:stone", false, false],
                ] as [string, boolean, boolean][]) {
                    let found: ItemStack | null = null;
                    for (let i = 0; i < 36; i++) {
                        const it = inv.getItem(i);
                        if (it.isNull()) continue;
                        const item = it.getItem();
                        if (item !== null && itemFullName(item as any as StaticPointer) === name) found = it;
                    }
                    if (found === null) {
                        check(`armoritem give ${name}`, false, "not in the inventory (the driver gives it)");
                        continue;
                    }
                    const a = found.isArmorItem(), h = found.isHorseArmorItem();
                    check(`armoritem give ${name}`, a === wantArmor && h === wantHorse, `BDS's give: isArmorItem ${a} (want ${wantArmor}), isHorseArmorItem ${h} (want ${wantHorse})`);
                }
                break;
            }
            case "sername": {
                // Item::getSerializedName (A1, docs/findings-containers.md section 27): bdsx's own namespace + ":" + raw name
                // (2024 0x1cae4b0), read off two fields, against the engine's full name (Item::full_name_, confirmed)
                const names = [
                    "minecraft:diamond", "minecraft:stone", "minecraft:oak_planks", "minecraft:apple", "minecraft:diamond_sword",
                    "minecraft:nether_star", "minecraft:torch", "minecraft:oak_sign", "minecraft:redstone",
                    "minecraft:wooden_door", "minecraft:bucket", "minecraft:bed", "minecraft:oak_hanging_sign", "minecraft:iron_door",
                ];
                for (const name of names) {
                    const st = ItemStack.constructWith(name, 1);
                    const item = st.isNull() ? null : st.getItem();
                    if (item === null) {
                        console.log(`${TAG} INFO sername ${name}: no such item on this build (a guessed name)`);
                        st.destruct();
                        continue;
                    }
                    const sp = item as any as StaticPointer;
                    const got = item.getSerializedName();
                    const full = itemFullName(sp);
                    const raw = itemRawNameId(sp);
                    check(`sername ${name}`, got === full && got === name, `getSerializedName "${got}", full name "${full}", raw "${raw}" (want "${name}")`);
                    if (raw.includes("tile.")) console.log(`${TAG} INFO sername ${name}: raw name "${raw}" carries tile.`);
                    st.destruct();
                }
                break;
            }
            case "offhand": {
                // Item::setAllowOffhand / allowOffhand (A1, section 27) against the engine's own reader of the rule:
                // OffhandContainerValidation's vftable slot 2 (40 0x8f48ce0 shr 7 of +0x152, 51 0x2f48d80 a two-bit state at
                // +0x210), called with a stack of the item. Also the real items the game data marks allow_off_hand
                const validate = (st: ItemStack): boolean => {
                    const obj = new AllocatedPointer(8);
                    obj.setPointer(proc["??_7OffhandContainerValidation@@6B@"]);
                    return OffhandValidation$valid(obj, 1, null, st);
                };
                const st = ItemStack.constructWith("minecraft:diamond", 1);
                const item = st.getItem()!;
                const sp = item as any as StaticPointer;
                const stateOff = pdbcache.layouts.Item?.allowOffhandState ?? 0;
                const flagOff = pdbcache.layouts.Item?.flags ?? 0x14a;
                const bytes = (): string => `flags 0x${sp.getUint8(flagOff).toString(16)}` + (stateOff !== 0 ? `, state 0x${sp.getUint8(stateOff).toString(16)}` : "");
                const before = bytes();
                const wasAllowed = validate(st);
                const flagsBefore = sp.getUint8(flagOff), stateBefore = stateOff !== 0 ? sp.getUint8(stateOff) : 0;
                try {
                    item.setAllowOffhand(false);
                    const v0 = validate(st), a0 = item.allowOffhand();
                    const afterFalse = bytes();
                    item.setAllowOffhand(true);
                    const v1 = validate(st), a1 = item.allowOffhand();
                    const afterTrue = bytes();
                    item.setAllowOffhand(false);
                    const v2 = validate(st), a2 = item.allowOffhand();
                    check("offhand engine validator", !v0 && v1 && !v2 && !a0 && a1 && !a2, `diamond (${before}, engine said ${wasAllowed}): set false -> engine ${v0}, bdsx ${a0} (${afterFalse}); set true -> engine ${v1}, bdsx ${a1} (${afterTrue}); false again -> engine ${v2}, bdsx ${a2} (want false/true/false from both)`);
                    const sideOk = stateOff === 0 ? (sp.getUint8(flagOff) & 0x7f) === (flagsBefore & 0x7f) : sp.getUint8(flagOff) === flagsBefore;
                    check("offhand other bits kept", sideOk, `flag byte 0x${flagsBefore.toString(16)} -> 0x${sp.getUint8(flagOff).toString(16)}${stateOff !== 0 ? ` (state byte 0x${stateBefore.toString(16)} -> 0x${sp.getUint8(stateOff).toString(16)}, upper bits ${(sp.getUint8(stateOff) & 0xfc) === (stateBefore & 0xfc)})` : ""}`);
                } finally {
                    sp.setUint8(flagsBefore, flagOff);
                    if (stateOff !== 0) sp.setUint8(stateBefore, stateOff);
                }
                st.destruct();
                const rows: string[] = [];
                let agree = true;
                const real: [string, boolean | null][] = [
                    ["minecraft:shield", true], ["minecraft:totem_of_undying", true], ["minecraft:diamond_sword", false], ["minecraft:stone", false],
                    ["minecraft:apple", false], ["minecraft:arrow", null], ["minecraft:torch", null], ["minecraft:diamond", false],
                ];
                let wantOk = true;
                for (const [name, want] of real) {
                    const s2 = ItemStack.constructWith(name, 1);
                    const it = s2.isNull() ? null : s2.getItem();
                    if (it === null) { rows.push(`${name}=none`); s2.destruct(); continue; }
                    const own = it.allowOffhand(), eng = validate(s2);
                    if (own !== eng) agree = false;
                    if (want !== null && own !== want) wantOk = false;
                    rows.push(`${name}=${own}/${eng}`);
                    s2.destruct();
                }
                check("offhand real items agree with the engine", agree, `bdsx/engine: ${rows.join(", ")}`);
                check("offhand real items: shield and totem yes, sword/stone/apple/diamond no", wantOk, rows.join(", "));
                break;
            }
            case "hbreak":
            case "hbreakp": {
                // ItemStackBase::hurtAndBreak (A1, section 27): the engine's own function at a new address (40 0x1bc47a0, 51
                // 0x1a56c80), on stacks ItemStack::fromTag built. No actor, or (hbreakp) the bot in <arg> mode
                const mk = (name: string, tag: NBT.Compound): ItemStack => ItemStack.fromTag({ Name: name, Count: NBT.byte(1), Damage: NBT.short(0), tag });
                const actor: Player | null = step === "hbreakp" ? p : null;
                const mode = step === "hbreakp" ? ` [${arg}]` : "";
                if (step === "hbreakp") {
                    const a = mk("minecraft:diamond_pickaxe", {});
                    const r1 = a.hurtAndBreak(1, actor);
                    const d1 = a.getDamageValue();
                    const r2 = a.hurtAndBreak(3, actor);
                    const d2 = a.getDamageValue();
                    if (arg === "creative") {
                        check(`hbreakp${mode} no damage`, !r1 && !r2 && d1 === 0 && d2 === 0, `hurtAndBreak(1) ${r1}, damage ${d1}; hurtAndBreak(3) ${r2}, damage ${d2} (want false/0, false/0)`);
                    } else {
                        check(`hbreakp${mode} damage`, r1 && r2 && d1 === 1 && d2 === 4, `hurtAndBreak(1) ${r1}, damage ${d1}; hurtAndBreak(3) ${r2}, damage ${d2} (want true/1, true/4)`);
                    }
                    a.destruct();
                    break;
                }
                const a = mk("minecraft:diamond_pickaxe", {});
                const max = a.getMaxDamage();
                const r1 = a.hurtAndBreak(1, null);
                const d1 = a.getDamageValue();
                const r2 = a.hurtAndBreak(3, null);
                const d2 = a.getDamageValue();
                check("hbreak damage", max > 100 && r1 && r2 && d1 === 1 && d2 === 4, `diamond_pickaxe max ${max}: hurtAndBreak(1) ${r1}, damage ${d1}; hurtAndBreak(3) ${r2}, damage ${d2} (want true/1, true/4)`);
                a.destruct();
                const u = mk("minecraft:diamond_pickaxe", { Unbreakable: NBT.byte(1) });
                const ur = u.hurtAndBreak(2, null);
                check("hbreak unbreakable", !ur && u.getDamageValue() === 0 && !u.isNull(), `Unbreakable tag: hurtAndBreak(2) ${ur}, damage ${u.getDamageValue()} (want false, 0)`);
                u.destruct();
                const d = ItemStack.constructWith("minecraft:diamond", 1);
                const dr = d.hurtAndBreak(1, null);
                check("hbreak not damageable", !dr && !d.isNull() && d.amount === 1, `diamond: hurtAndBreak(1) ${dr}, count ${d.amount} (want false, 1)`);
                d.destruct();
                const n = mk("minecraft:diamond_pickaxe", { Damage: NBT.int(max - 1) });
                const nd = n.getDamageValue();
                const nr = n.hurtAndBreak(1, null);
                const atMax = n.getDamageValue() === max && !n.isNull() && n.amount === 1;
                const nr2 = n.hurtAndBreak(1, null);
                check("hbreak breaks", nd === max - 1 && nr && atMax && nr2 && (n.isNull() || n.amount === 0), `damage ${nd} of ${max}: hurtAndBreak(1) ${nr} -> damage ${max} and still there: ${atMax}; hurtAndBreak(1) again ${nr2}, stack now ${n.isNull() ? "null" : n.toString()} count ${n.amount} (want true, at max but kept, true, gone)`);
                n.destruct();
                const o = mk("minecraft:diamond_pickaxe", { Damage: NBT.int(max - 2) });
                const or = o.hurtAndBreak(5, null);
                check("hbreak overshoot", or && (o.isNull() || o.amount === 0), `damage ${max - 2}: hurtAndBreak(5) ${or}, count ${o.amount} (want true, gone)`);
                o.destruct();
                const e = mk("minecraft:diamond_pickaxe", {});
                const ench = EnchantUtils.applyEnchant(e, EnchantmentNames.Unbreaking, 3, false);
                let hits = 0;
                for (let i = 0; i < 400; i++) { e.hurtAndBreak(1, null); hits++; }
                const ed = e.getDamageValue();
                check("hbreak unbreaking III", ench && ed > 50 && ed < 160, `applyEnchant ${ench}; 400 hurtAndBreak(1) on a pickaxe left damage ${ed} (Unbreaking III damages 1 in 4: want 50..160, not 0 and not 400)`);
                e.destruct();
                break;
            }
            case "catstring": {
                // CreativeItemCategoryFromString (A1, section 24): bdsx's own name table against the engine's categories of items
                const names: [string, CreativeItemCategory][] = [
                    ["all", CreativeItemCategory.All],
                    ["construction", CreativeItemCategory.Construction],
                    ["nature", CreativeItemCategory.Nature],
                    ["equipment", CreativeItemCategory.Equipment],
                    ["items", CreativeItemCategory.Items],
                    ["commands", CreativeItemCategory.Commands],
                    ["none", CreativeItemCategory.None],
                    ["Construction", CreativeItemCategory.Construction],
                    ["EQUIPMENT", CreativeItemCategory.Equipment],
                    ["bdsx_no_such_category", CreativeItemCategory.All],
                    ["", CreativeItemCategory.All],
                ];
                for (const [n, want] of names) {
                    const got = CreativeItemCategoryFromString(n);
                    check(`catstring "${n}"`, got === want, `-> ${got} (want ${want})`);
                }
                // the same names against the category the engine gave real items (Item::creative_category_)
                for (const [name, catName] of [
                    ["minecraft:diamond_sword", "equipment"],
                    ["minecraft:oak_planks", "construction"],
                    ["minecraft:stone", "nature"],
                    ["minecraft:diamond", "items"],
                ]) {
                    const st = ItemStack.constructWith(name, 1);
                    const engine = st.getItem()!.getCreativeCategory();
                    const own = CreativeItemCategoryFromString(catName);
                    check(`catstring engine ${name}`, engine === own, `engine category ${engine}, FromString("${catName}") ${own}`);
                    st.destruct();
                }
                for (const name of ["minecraft:command_block", "minecraft:barrier", "minecraft:structure_block", "minecraft:jigsaw", "minecraft:allow", "minecraft:light_block_0"]) {
                    const st = ItemStack.constructWith(name, 1);
                    if (st.isNull()) {
                        console.log(`${TAG} INFO catstring ${name}: no such item`);
                        continue;
                    }
                    console.log(`${TAG} INFO catstring ${name}: engine category ${st.getItem()!.getCreativeCategory()}`);
                    st.destruct();
                }
                break;
            }
            default:
                console.log(`${TAG} FAIL ${step}: unknown step`);
        }
    } catch (err) {
        console.log(`${TAG} FAIL ${step} threw ${(err as Error).message}`);
    }
});

// ---- itemprobe audit <armor|aux|stack|fake|hidden|unhidden> (docs/findings-audit.md "The next audit batch") ----
/** the newest mob of each identifier the level created (the driver summons them right before `audit hidden`) */
const auditMobs = new Map<string, string>(); // identifier -> the unique id (bin); the event's wrapper decays after the event
events.entityCreated.on(ev => {
    try {
        const a = ev.entity;
        if (a instanceof Mob) auditMobs.set(a.getIdentifier(), a.getUniqueIdBin());
    } catch {
        // an entity that cannot be resolved yet is not one the audit needs
    }
});
/** vanilla armour points and toughness per piece (the wiki's table), by the name the item prints */
const ARMOR_WANT: [string, number, number][] = [
    ["iron_helmet", 2, 0],
    ["diamond_chestplate", 8, 2],
    ["netherite_leggings", 6, 3],
    ["leather_boots", 1, 0],
];
function auditStep(p: Player, arg: string): void {
    switch (arg) {
        case "armor": {
            // Item::getArmorValue / getToughnessValue through ??_7HumanoidArmorItem@@6B@. The walk (40) and its carry
            // (51) had put both names one slot late: slot 59 is the toughness (material +0x14) and slot 60 the float
            // knockback resistance. Now 58 and 59, Endstone item.h's order and 2024's bodies.
            const slots = p.getArmorContainer().getSlots();
            let sum = 0;
            let tough = 0;
            let seen = 0;
            for (let i = 0; i < slots.size(); i++) {
                const st = slots.get(i);
                if (st === null || st.isNull()) continue;
                const item = st.getItem();
                if (item === null) continue;
                const name = st.toString().toLowerCase().replace(/ /g, "_");
                const armor = item.getArmorValue();
                const t = item.getToughnessValue();
                sum += armor;
                tough += t;
                const want = ARMOR_WANT.find(w => name.includes(w[0]));
                if (want === undefined) {
                    console.log(`${TAG} INFO audit armor slot ${i} "${name}": armor ${armor}, toughness ${t} (not in the table)`);
                    continue;
                }
                seen++;
                check(`audit armor ${want[0]}`, armor === want[1] && t === want[2], `Item.getArmorValue() ${armor} (want ${want[1]}), getToughnessValue() ${t} (want ${want[2]})`);
            }
            slots.destruct();
            const bds = p.getArmorValue();
            check("audit armor sum", seen === ARMOR_WANT.length && sum === bds, `${seen} pieces; the sum of bdsx's Item.getArmorValue() is ${sum}, BDS's own Mob::getArmorValue() is ${bds}`);
            const mobTough = p.getToughnessValue();
            check("audit armor toughness", mobTough === tough && tough === 5, `bdsx's Mob.getToughnessValue() over the pieces is ${mobTough} (vanilla: 0 + 2 + 3 + 0 = 5)`);
            const sword = ItemStack.constructWith("minecraft:diamond_sword");
            const si = sword.getItem();
            const sa = si === null ? -1 : si.getArmorValue();
            const stt = si === null ? -1 : si.getToughnessValue();
            check("audit armor non-armour", sa === 0 && stt === 0, `a diamond sword (base Item's slots): getArmorValue() ${sa}, getToughnessValue() ${stt}`);
            sword.destruct();
            break;
        }
        case "aux": {
            // ItemStackBase::isValidAuxValue(int): 2024's body is item_ ? item->isValidAuxValue(aux) : false; 1.26 keeps
            // no out-of-line copy (the propagation address was getMaxStackSize), so bdsx dispatches Item slot 67.
            const potion = ItemStack.constructWith("minecraft:potion", 1, 5);
            const diamond = ItemStack.constructWith("minecraft:diamond");
            const bogus = ItemStack.constructWith("minecraft:not_an_item_bdsx");
            const p5 = potion.isValidAuxValue(5);
            const p1000 = potion.isValidAuxValue(1000);
            const d1000 = diamond.isValidAuxValue(1000);
            const b0 = bogus.isValidAuxValue(0);
            check("audit aux potion", p5 === true && p1000 === false, `potion: isValidAuxValue(5) ${p5} (want true), isValidAuxValue(1000) ${p1000} (want false: PotionItem's own slot 67 bounds the id)`);
            check("audit aux base", d1000 === true, `diamond: isValidAuxValue(1000) ${d1000} (want true: the base Item's slot 67 returns true)`);
            check("audit aux null", b0 === false, `the null stack: isValidAuxValue(0) ${b0} (want false: no item)`);
            potion.destruct();
            diamond.destruct();
            bogus.destruct();
            break;
        }
        case "stack": {
            // ?getMaxStackSize@ItemStackBase@@ now ships as an address (40 0x1bba0d0, 51 0x1a54cf0), so derived() hands
            // the call to the binary instead of bdsx's own slot-100 dispatch.
            const inTable = "?getMaxStackSize@ItemStackBase@@QEBAEXZ" in proc;
            check("audit stack address", inTable, `getMaxStackSize has an address in this table: ${inTable}`);
            for (const [name, want] of [
                ["minecraft:diamond", 64],
                ["minecraft:ender_pearl", 16],
                ["minecraft:diamond_sword", 1],
            ] as [string, number][]) {
                const s = ItemStack.constructWith(name);
                const got = s.getMaxStackSize();
                check(`audit stack ${name}`, got === want, `getMaxStackSize() ${got} (want ${want})`);
                s.destruct();
            }
            break;
        }
        case "fake": {
            // IdentityDefinition::getFakePlayerName: 40's table had +0x100 (a fold with another class's leaf); now the
            // accessor at +0x28 (Endstone identity_definition.h: player_name_ after the id, the flag, the two ids)
            const sb = bedrockServer.level.getScoreboard();
            const id = sb.getFakePlayerScoreboardId("audit_fake");
            const name = id.isValid() ? id.identityDef.getFakePlayerName() : "<invalid id>";
            check("audit fake", name === "audit_fake", `the fake player's IdentityDefinition.getFakePlayerName() is "${name}" (want "audit_fake")`);
            const pid = sb.getPlayerScoreboardId(p);
            const pname = pid.isValid() ? pid.identityDef.getFakePlayerName() : "<invalid id>";
            check("audit fake player", pname === "", `the player's identity (type ${pid.isValid() ? pid.identityDef.getIdentityType() : -1}) has getFakePlayerName() "${pname}" (want "")`);
            break;
        }
        case "hidden":
        case "unhidden": {
            // bdsx:Player::isHiddenFrom (40 0x2a02680, 51 0x1c64330): 1.26 takes an ActorType, not a Mob&. With a
            // zombie head on, a zombie cannot see the player and a skeleton still can; with nothing on, neither.
            const zid = auditMobs.get("minecraft:zombie");
            const sid = auditMobs.get("minecraft:skeleton");
            const z = zid === undefined ? null : Actor.fromUniqueIdBin(zid);
            const s = sid === undefined ? null : Actor.fromUniqueIdBin(sid);
            if (!(z instanceof Mob) || !(s instanceof Mob)) {
                check(`audit ${arg}`, false, `no zombie/skeleton seen by entityCreated (${[...auditMobs.keys()].join(",")})`);
                break;
            }
            const hz = p.isHiddenFrom(z);
            const hs = p.isHiddenFrom(s);
            const wantZ = arg === "hidden";
            check(`audit ${arg}`, hz === wantZ && hs === false, `isHiddenFrom(zombie ${z.getEntityTypeId().toString(16)}) ${hz} (want ${wantZ}), isHiddenFrom(skeleton ${s.getEntityTypeId().toString(16)}) ${hs} (want false)`);
            break;
        }
        default:
            console.log(`${TAG} FAIL audit: unknown step "${arg}"`);
    }
}
