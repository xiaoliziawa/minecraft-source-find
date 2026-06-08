import { resolveConfig } from "../dist/config.js";
import { SourceService } from "../dist/service/sourceService.js";

const projectDir = process.argv[2] ?? "F:/MyProjects/AE2 Pattern Find";
const cfg = resolveConfig({ projectDir, resolveMode: "scan", transport: "stdio" });
const svc = new SourceService(cfg);

const t0 = performance.now();
const status = await svc.status();
console.log("=== STATUS ===");
console.log(JSON.stringify(status, null, 2));
console.log(`index built in ${(performance.now() - t0).toFixed(0)}ms`);

for (const q of ["ItemStack", "AEItemKey", "net.minecraft.world.item.Item"]) {
  const r = await svc.searchClass(q, 6);
  console.log(`\n=== search_class "${q}" (${r.length}) ===`);
  for (const m of r) console.log(`  ${m.fqcn}  [${m.origin}/${m.artifact}] ${m.hasSource ? "src" : "DECOMP"}`);
}

// MC class from sources
try {
  const src = await svc.getClassSource("net.minecraft.world.item.ItemStack");
  console.log(`\n=== ItemStack source (decompiled=${src.decompiled}, ${src.source.length} chars) from ${src.artifact} ===`);
  console.log(src.source.split("\n").slice(0, 6).join("\n"));
} catch (e) {
  console.log("ItemStack source ERR:", e.message);
}

// text search
const ts = await svc.searchText("registerCapabilities", { limit: 5 });
console.log(`\n=== search_text "registerCapabilities" -> ${ts.matches.length} hits, scanned ${ts.scannedJars} src jars ===`);
for (const m of ts.matches) console.log(`  ${m.fqcn}:${m.line}  ${m.text.slice(0, 80)}`);
