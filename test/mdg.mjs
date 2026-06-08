// ModDevGradle (新版 NeoForge/Forge) 项目本地产物 + 新版去混淆 jar 回归测试。
import { resolveConfig } from "../dist/config.js";
import { SourceService } from "../dist/service/sourceService.js";
import { BytecodeService } from "../dist/service/bytecodeService.js";

const cfg = resolveConfig({ projectDir: "F:/MyProjects/NBTExporter-26.1.2", gradleHome: "D:/GradleHome", resolveMode: "scan" });
const svc = new SourceService(cfg);
const bc = new BytecodeService(cfg, svc);

const st = await svc.status();
console.log("status:", JSON.stringify({ mc: st.minecraftVersion, loader: st.loader, loaderVersion: st.loaderVersion, mappings: st.mappings, jars: st.jarsInScope, withSource: st.jarsWithSource, classes: st.indexedClasses }));

const src = await svc.getClassSource("net.minecraft.world.item.ItemStack");
console.log(`source: decompiled=${src.decompiled} from=${src.artifact} lines=${src.source.split("\n").length}`);

const ol = await bc.classOutline("net.minecraft.world.item.ItemStack");
console.log(`outline: super=${ol?.superName} methods=${ol?.methods.length} fields=${ol?.fields.length}`);

const refs = await bc.findReferences("net.minecraft.world.item.ItemStack", "class", null, "net/minecraft/world/entity/player");
console.log(`references(player->ItemStack): total=${refs.total} byKind=${JSON.stringify(refs.byKind)}`);

const impl = await bc.findImplementations("net.minecraft.world.level.ItemLike");
console.log(`implementations(ItemLike): count=${impl.length}`);
