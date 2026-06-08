# Minecraft Source MCP

一个本地 MCP 服务器，把 **Minecraft 本体 / 加载器（Forge·NeoForge·Fabric）/ build.gradle 引入的各模组** 的源码开放给 AI 助手，辅助开发 Minecraft 模组。

- 有 `sources.jar` 的依赖：**直接读取**源码。
- 只有普通 `jar`（无 source）的依赖：**自动用 [Vineflower](https://github.com/Vineflower/vineflower) 反编译** class 后返回，结果落盘缓存。
- 同时支持 **stdio** 与 **HTTP(Streamable)** 两种传输。

## 工作原理

一旦 Gradle 把依赖下载下来，它来自 CurseMaven、Modrinth、作者自建仓库还是公共仓库就**不再重要**——所有产物都会落进同一个 `GRADLE_USER_HOME/caches` 目录变成本地文件。因此本工具直接**扫描缓存文件系统**来定位 jar，天然「仓库无关」。

覆盖的缓存落点：

| 类型 | 路径 |
|---|---|
| 普通依赖（任意 Maven） | `caches/modules-2/files-2.1/<group>/<name>/<ver>/<hash>/*.jar` |
| Forge 反混淆模组 | `caches/forge_gradle/...` |
| Forge 的 MC+Forge 合并源 | `caches/forge_gradle/minecraft_user_repo/.../forge-*-sources.jar` |
| NeoForge / Fabric (loom) | `caches/fabric-loom/...` |
| **ModDevGradle**（新版 NeoForge/Forge）的 MC+加载器合并 jar | `<项目>/build/moddev/artifacts/minecraft-patched-*.jar` 与 `-sources.jar` |

> **ModDevGradle (MDG)**：新版 `net.neoforged.moddev` 插件把「打补丁后的 Minecraft+加载器」源码与字节码生成在**项目本地** `build/moddev/artifacts/` 下，而非 GradleHome 缓存。本工具会一并扫描该目录并视为权威来源（不做版本筛选）；其中 `-sources.jar` 供读源码、`*.jar` 供字节码分析，`-merged.jar`（class+java 混装）自动跳过以免重复计数。
>
> **新版无混淆**：自 MC 1.21.11（NeoForge 26.x）起 Mojang 取消混淆，类/方法/字段均为 official 名，SRG↔official 割裂随之消失，引用分析更直接可靠。这类版本的字节码可能编译到很新的 Java（如 Java 25），分析器已做 class 版本兼容处理，**无需升级 ASM 即可解析任意 Java 版本的 class**。

## 两种作用域解析方式

| 模式 | 原理 | 适用 |
|---|---|---|
| `scan`（默认） | 解析项目 `gradle.properties`/`build.gradle` 得到 MC 版本、加载器、mappings，按 **MC 版本**筛选缓存中的 jar | 秒级、离线、无需构建。偶尔会带进同一 MC 版本下其他项目的 jar（按 build.gradle 版本去重缓解） |
| `gradle` | 对项目跑一个 init 脚本，让 Gradle 报出**精确**的已解析 classpath | 100% 精确、版本绝对正确。需项目可构建、要起 Gradle 守护进程（秒级）、首次可能联网 |

`scan` 模式下，重复的同名类在索引层按「源码优先 → mappings 匹配 → 版本匹配 → 核心 jar 匹配 loader 版本」择优，`get_class_source` 始终返回确定的一个。

## 安装

```bash
npm install
npm run build
```

`vendor/vineflower.jar` 已随仓库提供；如缺失会在启动时给出警告，可用 `--vineflower` 指定路径。

## 运行

GradleHome 默认取环境变量 `GRADLE_USER_HOME`，否则回退 `~/.gradle`，也可用 `--gradle-home` 覆盖。

```bash
# stdio（被 AI 客户端按需拉起）
node dist/index.js --stdio --project "F:/MyProjects/你的模组项目"

# HTTP，开放本地端口
node dist/index.js --http --port 4799 --project "F:/MyProjects/你的模组项目"

# 精确模式：让 Gradle 报出确切依赖
node dist/index.js --http --resolve gradle --project "F:/MyProjects/你的模组项目"
```

### 命令行参数

| 参数 | 说明 |
|---|---|
| `--stdio` | 使用 stdio 传输（默认） |
| `--http` | 使用 HTTP(Streamable) 传输 |
| `--port <n>` | HTTP 端口（默认 4799） |
| `--host <host>` | HTTP 监听地址（默认 127.0.0.1） |
| `--project <dir>` | 绑定的模组项目目录（默认当前工作目录） |
| `--gradle-home <dir>` | GradleHome 路径 |
| `--resolve <scan\|gradle>` | 作用域解析方式（默认 scan） |
| `--vineflower <jar>` | Vineflower 反编译器 jar 路径 |
| `--cache-dir <dir>` | 反编译与索引缓存目录（默认 `./.cache`） |

## MCP 工具

### 源码类

| 工具 | 作用 |
|---|---|
| `project_status` | 查看识别到的 MC 版本/加载器/mappings、作用域内 jar 与已索引类数量。排查问题先看它 |
| `list_sources` | 列出作用域内所有 jar，标注「源码」或「需反编译」，可按 `origin` 过滤 |
| `search_class` | 按简单类名（`ItemStack`）或全限定名片段（`net.minecraft.world.item`）搜索 |
| `get_class_source` | 按全限定名返回源码；无 source 的自动反编译（`decompiled=true`） |
| `search_text` | 在带 source 的 jar 的 `.java` 中做全文/正则检索，返回 `类名:行号:内容` |
| `reload_index` | 改了 build.gradle 或新增依赖后重建索引 |

### 符号关系类（字节码级，远胜 grep）

基于 **ASM 解析字节码**，对**只有 class（无 source）的模组同样有效**，能跨 mapping、区分调用与声明、处理子类型分派——这是 `search_text`(grep) 做不到的。

| 工具 | 作用 |
|---|---|
| `find_references` | 查某【类/方法/字段】在所有 jar 中被引用的位置（实例化/继承/实现/调用/字段读写/出现在签名里），含调用方类、方法、行号、引用种类 |
| `find_implementations` | 查所有继承某类或实现某接口的子类型（默认递归） |
| `find_overrides` | 查所有覆盖某方法的子类（可按 JVM 描述符精确匹配重载） |
| `class_outline` | 查某类的父类、接口、全部方法与字段签名（不取整份源码就能看 API） |

`find_references` 的 `target` 写法：类用全限定名 `net.minecraft.world.item.ItemStack`；成员用 `类全限定名#成员名`，如 `...ItemStack#getCount`（字段加 `kind:"field"`）。用 `callerPackage` 限定调用方包前缀可大幅加速并降噪。

**推荐用法**
- 看源码：`search_class` → `get_class_source`；按内容查：`search_text`。
- 查引用：类直接 `find_references`；查方法/字段引用前先 `class_outline` 看字节码里的真实成员名，再按该名 `find_references`。

> **mapping 提示**：MC 核心 jar 用 official 名（如 `getCount`），而模组 jar 调用 MC 时常用 SRG 名（如 `m_41619_`）。**类名不混淆**，故类级引用始终可靠；方法/字段级跨 mapping 时请用字节码里的真实名（`class_outline` 可查到）。
>
> `search_text` 只扫描带 source 的 jar；仅有 class 的 jar 需先 `get_class_source` 触发反编译（结果会缓存）。字节码类工具则不受此限。

## 在 Claude Code 中配置（推荐：用户级 + 自动绑定）

服务器会按 `--project` > MCP `roots`（Claude Code 自动提供当前工作区根）> `CLAUDE_PROJECT_DIR` > cwd 的顺序确定要绑定的项目。因此**不传 `--project`** 时，一份用户级配置即可在你所有模组项目里**自动绑定到当前打开的那个项目**。

```bash
claude mcp add --scope user minecraft-source -- \
  node F:/MyProjects/minecraft-source-find/dist/index.js --stdio --gradle-home D:/GradleHome
```

验证与移除：

```bash
claude mcp list                       # 应显示 minecraft-source ✓ Connected
claude mcp get minecraft-source
claude mcp remove minecraft-source -s user
```

> 添加后请**重启 Claude Code**（或重开会话）让其加载该 MCP。之后在任意模组项目里直接让 AI 用 `search_class` / `get_class_source` 即可。

## 客户端配置文件

见 [`examples/`](./examples)：

- `claude-stdio.json` — Claude Code / Cursor 等的 stdio 配置
- `claude-http.json` — HTTP 连接配置

> ⚠️ stdio 模式下，MCP 客户端拉起子进程时**不一定会继承** `GRADLE_USER_HOME` 环境变量。因此建议在 `args` 里**显式传 `--gradle-home`**（示例已这么做），不要只依赖环境变量。

## 缓存

- 反编译结果：`./.cache/decompiled/`（按 jar+mtime+类名 缓存）
- 类索引：`./.cache/index-cache.json.gz`（按作用域 jar 集签名失效，热启动 ~1s）
- 字节码分析器：首次用到时把 `tools/McpAnalyzer.java` 编译到 `./.cache/analyzer/`（用到 `vendor/asm-9.7.jar`）
- 类大纲/继承索引：`./.cache/outline-*.json.gz`（供 `find_implementations`/`find_overrides`/`class_outline` 用，首次构建约数秒，之后缓存）

删除 `.cache` 即可强制重建。

## 依赖的外部组件

- `vendor/vineflower.jar` — 反编译器（无 source 时用）
- `vendor/asm-9.7.jar` — 字节码分析（`find_references` 等）
- 本机 `java` / `javac`（Java 17+；本项目用 Java 21 验证）
