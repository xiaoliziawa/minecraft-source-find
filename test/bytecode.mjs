import { resolveConfig } from "../dist/config.js";
import { SourceService } from "../dist/service/sourceService.js";
import { BytecodeService } from "../dist/service/bytecodeService.js";
const cfg = resolveConfig({ projectDir: "F:/MyProjects/AE2 Pattern Find", resolveMode: "scan" });
const svc = new SourceService(cfg);
const bc = new BytecodeService(cfg, svc);

let t = performance.now();
const refs = await bc.findReferences("net.minecraft.world.item.ItemStack", "class", null, "appeng");
console.log(`[find_references class ItemStack, caller=appeng] total=${refs.total} byKind=${JSON.stringify(refs.byKind)} (${(performance.now()-t).toFixed(0)}ms)`);
console.log("  sample:", refs.hits.slice(0,3).map(h=>`${h.kind} ${h.callerFqcn}#${h.method}:${h.line}`).join(" | "));

t = performance.now();
const impl = await bc.findImplementations("appeng.api.stacks.AEKey", true);
console.log(`\n[find_implementations AEKey] count=${impl.length} (${(performance.now()-t).toFixed(0)}ms incl. outline build)`);
console.log("  sample:", impl.slice(0,5).map(x=>`${x.kind}:${x.fqcn}`).join(" | "));

t = performance.now();
const out = await bc.classOutline("net.minecraft.world.item.ItemStack");
console.log(`\n[class_outline ItemStack] methods=${out?.methods.length} fields=${out?.fields.length} super=${out?.superName} (${(performance.now()-t).toFixed(0)}ms cached)`);
console.log("  first methods:", out?.methods.slice(0,6).map(m=>m.name+m.desc).join(" "));

t = performance.now();
const refsM = await bc.findReferences("net.minecraft.world.item.ItemStack", "method", {name:"m_41619_"}, "appeng");
console.log(`\n[find_references method ItemStack#m_41619_(isEmpty), caller=appeng] total=${refsM.total} (${(performance.now()-t).toFixed(0)}ms)`);
console.log("  sample:", refsM.hits.slice(0,3).map(h=>`${h.callerFqcn}#${h.method}:${h.line}`).join(" | "));
