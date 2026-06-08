# Minecraft Source MCP

一个本地 MCP 服务器，把当前 Minecraft 模组项目作用域内的 **源码、资源文件、符号关系** 开放给 AI 助手：Minecraft 本体、加载器（Forge / NeoForge / Fabric）、以及 `build.gradle` 引入的各依赖模组。

三类能力：

- **源码** —— 有 `sources.jar` 的直接读；只有 class 的用 [Vineflower](https://github.com/Vineflower/vineflower) 反编译后返回（落盘缓存）。
- **资源** —— 模型 / 方块状态 / 配方等 `.json`、shader 的 `.fsh`/`.vsh`/`.glsl`、`.mcmeta`、纹理 `.png` 等。
- **符号关系** —— 字节码级查引用、子类、覆盖、成员签名，远胜 grep。

传输支持 **stdio** 与 **HTTP (Streamable)**。

## 工作原理

依赖一旦被 Gradle 下载，无论来自 CurseMaven、Modrinth 还是自建仓库，都会落进 `GRADLE_USER_HOME/caches`。本工具直接扫描这些缓存定位 jar，因此**与仓库无关**。覆盖的落点：

| 来源 | 路径 |
|---|---|
| 普通依赖（任意 Maven） | `caches/modules-2/files-2.1/<group>/<name>/<ver>/<hash>/*.jar` |
| Forge（含 MC+Forge 合并源） | `caches/forge_gradle/...` |
| NeoForge / Fabric (loom) | `caches/fabric-loom/...` |
| ModDevGradle（新版 NeoForge/Forge） | `<项目>/build/moddev/artifacts/minecraft-patched-*.jar` 及 `-sources.jar` |

> **ModDevGradle**：新版 `net.neoforged.moddev` 把 MC+加载器的源码和字节码生成在**项目本地** `build/moddev/artifacts/`，不进 GradleHome；本工具会一并扫描（`-sources.jar` 读源码、`*.jar` 做字节码分析，`-merged.jar` 跳过）。
>
> **新版变化（MC 1.21.11 / NeoForge 26.x 起）**：Mojang 取消混淆，类/方法/字段全是 official 名；版本号改成 `26.1.2` 这种写法（不再以 `1.` 开头）。两者均已兼容。字节码可能用很新的 Java（如 25）编译，Rust 分析器自行解析 class，不受 Java 版本限制。

### 两种作用域解析

| 模式 | 原理 | 适用 |
|---|---|---|
| `scan`（默认） | 读项目 `gradle.properties` / `build.gradle` 得到 MC 版本、加载器、mappings，按 MC 版本筛选缓存里的 jar | 秒级、离线、无需构建。同名重复 jar 在索引层按「源码 > mappings 匹配 > 版本匹配 > 核心 jar」择优 |
| `gradle` | 跑一个 init 脚本让 Gradle 报出精确 classpath | 100% 精确。需项目可构建、起 Gradle 守护进程、首次可能联网 |

## 安装

```bash
npm install
npm run build      # 编译 TypeScript + cargo build 字节码分析器
```

- 字节码分析器是 Rust 写的（`analyzer/`），`npm run build` 会一并编译；若构建机没装 Rust，会在首次用到 `find_references` 等工具时自动 `cargo build`（需 `cargo`）。
- 反编译器 `vendor/vineflower.jar` 已随仓库提供，需本机 `java`（17+）。

## 运行

```bash
# stdio（被 AI 客户端按需拉起）
node dist/index.js --stdio --project "F:/路径/你的模组项目"

# HTTP，开放本地端口（端点 /mcp，健康检查 /health）
node dist/index.js --http --port 4799 --project "F:/路径/你的模组项目"

# 精确模式：让 Gradle 报出确切依赖
node dist/index.js --stdio --resolve gradle --project "F:/路径/你的模组项目"
```

GradleHome 默认取 `GRADLE_USER_HOME`，否则回退 `~/.gradle`。

| 参数 | 说明 |
|---|---|
| `--stdio` / `--http` | 传输方式（默认 stdio） |
| `--port <n>` / `--host <host>` | HTTP 端口（默认 4799）/ 地址（默认 127.0.0.1） |
| `--project <dir>` | 绑定的模组项目目录（默认当前工作目录） |
| `--gradle-home <dir>` | GradleHome 路径 |
| `--resolve <scan\|gradle>` | 作用域解析方式（默认 scan） |
| `--vineflower <jar>` | Vineflower 反编译器 jar 路径 |
| `--cache-dir <dir>` | 缓存目录（默认 `./.cache`） |

## 在 Claude Code 中配置

服务器按 `--project` > MCP `roots`（Claude Code 自动提供工作区根）> `CLAUDE_PROJECT_DIR` > cwd 的顺序确定绑定项目。所以**不传 `--project`** 时，一份用户级配置就能在所有模组项目里**自动绑定到当前打开的那个**：

```bash
claude mcp add --scope user minecraft-source -- \
  node F:/MyProjects/minecraft-source-find/dist/index.js --stdio --gradle-home D:/GradleHome
```

```bash
claude mcp list                          # 应显示 minecraft-source ✓ Connected
claude mcp remove minecraft-source -s user
```

> 添加或更新后请**重启 Claude Code 会话**让其重新加载。stdio 模式下子进程不一定继承 `GRADLE_USER_HOME`，建议在 args 里显式传 `--gradle-home`。
>
> 其它客户端见 [`examples/`](./examples)：`claude-stdio.json`、`claude-http.json`。

## MCP 工具

### 源码

| 工具 | 作用 |
|---|---|
| `project_status` | MC 版本/加载器/mappings、作用域内 jar 数与已索引类数。排查问题先看它 |
| `list_sources` | 列出作用域内所有 jar，标注「源码 / 需反编译」，可按 `origin` 过滤 |
| `search_class` | 按简单类名（`ItemStack`）或全限定名片段（`net.minecraft.world.item`）搜索 |
| `get_class_source` | 按全限定名取源码；无 source 的自动反编译 |
| `search_text` | 在带 source 的 jar 的 `.java` 中做全文/正则检索 |
| `reload_index` | 改了 build.gradle 或新增依赖后重建索引 |

### 资源

| 工具 | 作用 |
|---|---|
| `search_resources` | 按 `ext` / `pathPrefix` / `query` 定位资源；带 `content` 时在文本资源里做全文/正则检索（png/nbt 等二进制只定位不搜内容） |
| `get_resource` | 按 jar 内完整路径取资源文本（json / shader 等）；二进制只返回大小 |

### 符号关系

基于 Rust 字节码分析器（`analyzer/`，自带精简 zip 读取器、多核并行），对**只有 class 的模组同样有效**，能跨 mapping、区分调用与声明、处理子类型分派——这是 grep 做不到的。

| 工具 | 作用 |
|---|---|
| `find_references` | 查某【类/方法/字段】被引用处（实例化/继承/实现/调用/字段读写/出现在签名里），含调用方、行号、引用种类 |
| `find_implementations` | 查所有继承某类或实现某接口的子类型（默认递归） |
| `find_overrides` | 查所有覆盖某方法的子类（可按 JVM 描述符精确匹配重载） |
| `class_outline` | 查某类的父类、接口、全部方法与字段签名（不取整份源码就能看 API） |

`find_references` 的 `target`：类用全限定名 `net.minecraft.world.item.ItemStack`；成员用 `类#成员`，如 `...ItemStack#getCount`（字段加 `kind:"field"`）。`callerPackage` 限定调用方包前缀可大幅加速降噪。

> **mapping 提示（仅老版本相关）**：1.21.11 之前 MC 是混淆的，模组调用 MC 常用 SRG 名（如 `m_41619_`）。类名从不混淆，故类级引用始终可靠；查方法/字段引用前先用 `class_outline` 看字节码里的真实成员名。新版（1.21.11+）无混淆，不存在此问题。

## 缓存

| 内容 | 位置 |
|---|---|
| 反编译结果 | `./.cache/decompiled/`（按 jar+mtime+类名） |
| 类与资源索引 | `./.cache/index-cache.json.gz`（按作用域 jar 集签名失效，热启动 ~1s） |
| 类大纲/继承索引 | `./.cache/outline-*.json.gz`（供 `find_implementations`/`find_overrides`/`class_outline`） |
| Rust 分析器二进制 | `analyzer/target/release/`（缺失时自动 `cargo build`） |

删除 `.cache` 即可强制重建。

## 技术栈

- TypeScript / Node.js（≥20）+ `@modelcontextprotocol/sdk`
- Rust 字节码分析器（`analyzer/`）——自写 class 解析与精简 zip 读取，多核并行；不依赖 ASM，不受 Java 版本限制
- Vineflower（反编译，需 `java`）
