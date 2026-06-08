import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServerConfig } from "./config.js";
import { SourceService } from "./service/sourceService.js";
import { BytecodeService, TargetKind } from "./service/bytecodeService.js";
import { JarInfo } from "./jar/jarIndex.js";

const MAX_SOURCE_CHARS = 40000;

function text(obj: unknown): { content: { type: "text"; text: string }[] } {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text: body }] };
}

function jarLine(j: JarInfo): string {
  const tag = j.kind === "sources" ? "源码" : "需反编译";
  const map = j.mappings ? ` [${j.mappings}]` : "";
  return `- (${j.origin}) ${j.artifactName}${map} <${tag}>`;
}

export function buildServer(cfg: ServerConfig): McpServer {
  const server = new McpServer(
    { name: "minecraft-source-mcp", version: "1.0.0" },
    {
      instructions:
        "查询当前 Minecraft 模组项目作用域内的源码与符号关系：Minecraft / 加载器 / 各依赖模组。\n" +
        "源码：search_class 找全限定名 → get_class_source 取源码（无 sources 自动 Vineflower 反编译）；search_text 做源码全文检索。\n" +
        "符号关系（字节码级，远胜 grep）：find_references 查类/方法/字段被引用处，find_implementations 查子类/实现类，find_overrides 查方法覆盖，class_outline 看成员签名。\n" +
        "注意 mapping：MC 核心用 official 名，模组 jar 调用 MC 时常用 SRG 名（如 m_41619_）。查方法/字段引用前可先用 class_outline 看字节码里的真实成员名。",
    },
  );

  // Auto-bind the project from MCP roots when --project was not given explicitly.
  const service = new SourceService(cfg, async () => {
    const result = await server.server.listRoots();
    return (result.roots ?? []).map((r) => r.uri);
  });
  const bytecode = new BytecodeService(cfg, service);

  server.registerTool(
    "project_status",
    {
      title: "项目与作用域状态",
      description:
        "返回当前绑定项目解析出的 Minecraft 版本、加载器、mappings，以及作用域内 jar 数量、已索引类数量等。排查作用域问题时先看这个。",
      inputSchema: {},
    },
    async () => text(await service.status()),
  );

  server.registerTool(
    "list_sources",
    {
      title: "列出作用域内的依赖源",
      description:
        "列出当前项目作用域内的所有 jar（Minecraft、加载器、各模组、库），标注是否带 sources 还是需要反编译。可按 origin 过滤。",
      inputSchema: {
        origin: z
          .enum(["minecraft", "loader", "mod", "library"])
          .optional()
          .describe("只看某一类来源"),
      },
    },
    async ({ origin }) => {
      let jars = await service.listSources();
      if (origin) jars = jars.filter((j) => j.origin === origin);
      const lines = jars.map(jarLine);
      const header = `作用域内共 ${jars.length} 个 jar${origin ? `（origin=${origin}）` : ""}：`;
      return text([header, ...lines].join("\n"));
    },
  );

  server.registerTool(
    "search_class",
    {
      title: "按类名搜索",
      description:
        "按简单类名（如 ItemStack）或全限定名片段（如 net.minecraft.world.item）搜索作用域内的类，返回全限定名、所属构件、是否带源码。这是取源码前的第一步。",
      inputSchema: {
        query: z.string().min(1).describe("简单类名或全限定名片段"),
        limit: z.number().int().min(1).max(200).optional().describe("最多返回多少条，默认 50"),
      },
    },
    async ({ query, limit }) => {
      const results = await service.searchClass(query, limit ?? 50);
      if (results.length === 0) return text(`未找到匹配 "${query}" 的类。`);
      const lines = results.map(
        (r) => `${r.fqcn}  <${r.hasSource ? "源码" : "需反编译"}> (${r.origin}/${r.artifact})`,
      );
      return text([`匹配 ${results.length} 个类：`, ...lines].join("\n"));
    },
  );

  server.registerTool(
    "get_class_source",
    {
      title: "获取类源码",
      description:
        "按全限定名返回类的 Java 源码。带 sources 的直接读取；只有 class 的用 Vineflower 反编译（结果缓存）。返回里 decompiled=true 表示是反编译产物。",
      inputSchema: {
        fqcn: z.string().min(1).describe("完整全限定类名，如 net.minecraft.world.item.ItemStack"),
        maxChars: z
          .number()
          .int()
          .min(1000)
          .max(400000)
          .optional()
          .describe(`最大返回字符数，默认 ${MAX_SOURCE_CHARS}，超出会截断`),
      },
    },
    async ({ fqcn, maxChars }) => {
      const result = await service.getClassSource(fqcn);
      const cap = maxChars ?? MAX_SOURCE_CHARS;
      let source = result.source;
      let truncated = false;
      if (source.length > cap) {
        source = source.slice(0, cap);
        truncated = true;
      }
      const head = [
        `// 构件: ${result.artifact}  来源: ${result.origin}  ${result.decompiled ? "(Vineflower 反编译)" : "(原始 sources)"}`,
        result.alternatives.length
          ? `// 另有 ${result.alternatives.length} 个同名类来源，必要时可换 jar 查看`
          : null,
        truncated ? `// [已截断到 ${cap} 字符，可用 maxChars 调大]` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return text(`${head}\n\n${source}`);
    },
  );

  server.registerTool(
    "search_text",
    {
      title: "源码全文检索",
      description:
        "在作用域内带 sources 的 jar 的 .java 源码中做全文/正则检索，返回 类名:行号:内容。仅有 class 的 jar 不参与（需先 get_class_source 反编译）。",
      inputSchema: {
        query: z.string().min(1).describe("要搜索的文本或正则"),
        regex: z.boolean().optional().describe("是否按正则匹配，默认否"),
        ignoreCase: z.boolean().optional().describe("是否忽略大小写，默认否"),
        packagePrefix: z.string().optional().describe("限定包前缀，如 net.minecraft.world，缩小范围加速"),
        limit: z.number().int().min(1).max(500).optional().describe("最多返回多少条，默认 100"),
      },
    },
    async ({ query, regex, ignoreCase, packagePrefix, limit }) => {
      const r = await service.searchText(query, { regex, ignoreCase, packagePrefix, limit });
      const lines = r.matches.map((m) => `${m.fqcn}:${m.line}  ${m.text}`);
      const header =
        `命中 ${r.matches.length} 条（扫描 ${r.scannedJars} 个源码 jar，跳过 ${r.skippedBinaryJars} 个仅 class 的 jar）` +
        (r.truncated ? "，结果已截断" : "");
      return text([header, ...lines].join("\n"));
    },
  );

  server.registerTool(
    "find_references",
    {
      title: "查找标识符引用（字节码级）",
      description:
        "用 ASM 解析字节码，精确查找某个【类/方法/字段】在作用域内所有 jar 中被引用的位置（实例化、继承、实现、方法调用、字段读写、出现在签名里等），含调用方类、方法、行号。" +
        "这比 search_text(grep) 精确得多：能跨 mapping、区分调用/声明、处理子类型分派，且对只有 class 的模组同样有效。\n" +
        "target 写法：类用全限定名 `net.minecraft.world.item.ItemStack`；成员用 `全限定名#成员名`，如 `net.minecraft.world.item.ItemStack#getCount`。",
      inputSchema: {
        target: z.string().min(1).describe("目标类的全限定名，或 `类全限定名#成员名`"),
        kind: z
          .enum(["class", "method", "field"])
          .optional()
          .describe("目标种类。不填时：无 # 视为 class，有 # 默认 method（字段请显式填 field）"),
        callerPackage: z
          .string()
          .optional()
          .describe("只在该包前缀下的调用方里找（如 appeng），可大幅加速并降噪"),
        limit: z.number().int().min(1).max(1000).optional().describe("最多返回多少条，默认 80"),
      },
    },
    async ({ target, kind, callerPackage, limit }) => {
      const hashIdx = target.indexOf("#");
      let owner = target;
      let member: { name: string; desc?: string } | null = null;
      let resolvedKind: TargetKind;
      if (hashIdx >= 0) {
        owner = target.slice(0, hashIdx);
        const rest = target.slice(hashIdx + 1);
        const paren = rest.indexOf("(");
        const name = paren >= 0 ? rest.slice(0, paren) : rest;
        const desc = paren >= 0 ? rest.slice(paren) : undefined;
        member = { name, desc };
        resolvedKind = kind === "field" ? "field" : "method";
      } else {
        resolvedKind = "class";
      }
      const cap = limit ?? 80;
      const { hits, total, byKind } = await bytecode.findReferences(
        owner,
        resolvedKind,
        member,
        callerPackage ?? null,
      );
      const shown = hits.slice(0, cap);
      const head =
        `目标: ${target} (${resolvedKind}) | 命中 ${total} 处` +
        (total > cap ? `，显示前 ${cap}` : "") +
        `\n种类分布: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(", ") || "无"}`;
      const lines = shown.map((h) => {
        const at = h.line >= 0 ? `:${h.line}` : "";
        const tgt = resolvedKind === "class" ? "" : `  -> ${h.targetName}${h.targetDesc}`;
        return `[${h.kind}] ${h.callerFqcn}#${h.method}${at}  (${h.callerArtifact})${tgt}`;
      });
      return text([head, "", ...lines].join("\n"));
    },
  );

  server.registerTool(
    "find_implementations",
    {
      title: "查找子类/实现类（字节码级）",
      description:
        "查找作用域内所有【继承某类】或【实现某接口】的类（默认递归传递闭包）。基于字节码继承关系，对只有 class 的模组同样有效。",
      inputSchema: {
        fqcn: z.string().min(1).describe("父类或接口的全限定名"),
        transitive: z.boolean().optional().describe("是否递归包含间接子类，默认 true"),
        limit: z.number().int().min(1).max(2000).optional().describe("最多返回多少条，默认 200"),
      },
    },
    async ({ fqcn, transitive, limit }) => {
      const all = await bytecode.findImplementations(fqcn, transitive ?? true);
      const cap = limit ?? 200;
      const lines = all.slice(0, cap).map((x) => `(${x.kind}) ${x.fqcn}`);
      const head = `${fqcn} 的子类型共 ${all.length} 个` + (all.length > cap ? `，显示前 ${cap}` : "");
      return text([head, ...lines].join("\n"));
    },
  );

  server.registerTool(
    "class_outline",
    {
      title: "类大纲（成员签名）",
      description:
        "返回某个类的父类、接口、所有方法与字段签名（JVM 描述符）。用于在不取整份源码的情况下快速看 API。对只有 class 的模组同样有效。",
      inputSchema: {
        fqcn: z.string().min(1).describe("类的全限定名"),
      },
    },
    async ({ fqcn }) => {
      const o = await bytecode.classOutline(fqcn);
      if (!o) return text(`未找到类的字节码: ${fqcn}`);
      const sup = o.superName ? o.superName.replace(/\//g, ".") : "(无)";
      const ifaces = o.interfaces.length ? o.interfaces.map((i) => i.replace(/\//g, ".")).join(", ") : "(无)";
      const methods = o.methods.map((m) => `  ${m.name}${m.desc}`);
      const fields = o.fields.map((f) => `  ${f.name} : ${f.desc}`);
      return text(
        [
          `类: ${fqcn}`,
          `父类: ${sup}`,
          `接口: ${ifaces}`,
          ``,
          `字段 (${o.fields.length}):`,
          ...fields,
          ``,
          `方法 (${o.methods.length}):`,
          ...methods,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "find_overrides",
    {
      title: "查找方法的覆盖实现",
      description: "查找作用域内所有【覆盖/实现】了某类某方法的子类（按方法名，可选 JVM 描述符精确匹配）。",
      inputSchema: {
        fqcn: z.string().min(1).describe("声明该方法的类/接口全限定名"),
        method: z.string().min(1).describe("方法名"),
        desc: z.string().optional().describe("可选的 JVM 方法描述符，如 ()I，用于精确匹配重载"),
        limit: z.number().int().min(1).max(2000).optional().describe("最多返回多少条，默认 200"),
      },
    },
    async ({ fqcn, method, desc, limit }) => {
      const all = await bytecode.findOverrides(fqcn, method, desc);
      const cap = limit ?? 200;
      const lines = all.slice(0, cap).map((x) => `  ${x.fqcn}`);
      const head = `覆盖 ${fqcn}#${method}${desc ?? ""} 的类共 ${all.length} 个` + (all.length > cap ? `，显示前 ${cap}` : "");
      return text([head, ...lines].join("\n"));
    },
  );

  server.registerTool(
    "reload_index",
    {
      title: "重建索引",
      description: "重新解析项目并重建作用域索引。修改了 build.gradle 或新增了依赖后调用。",
      inputSchema: {},
    },
    async () => {
      service.reload();
      const status = await service.status();
      return text({ reloaded: true, status });
    },
  );

  return server;
}
