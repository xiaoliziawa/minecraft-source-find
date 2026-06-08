import { ServerConfig } from "../config.js";
import { ProjectInfo, parseProject } from "../project/gradleProject.js";
import { resolveJarPaths } from "../project/gradleResolver.js";
import {
  JarInfo,
  ClassIndex,
  discoverJars,
  discoverJarsFromPaths,
  discoverProjectJars,
  collectJarEntries,
  buildClassIndex,
} from "../jar/jarIndex.js";
import { computeSignature, loadIndexCache, saveIndexCache } from "../jar/indexCache.js";
import fs from "node:fs";
import path from "node:path";
import { listEntries, readTextEntry, readBinaryEntry } from "../jar/jarReader.js";
import { decompileClass } from "../decompile/decompiler.js";

/** Convert a file:// URI (or a plain path) to a local filesystem path, Windows-aware. */
function uriToPath(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  // "/F:/foo" -> "F:/foo" on Windows
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p;
}

/** Choose the workspace root most likely to be the mod project (one that has a gradle build). */
function pickProjectRoot(roots: string[]): string | null {
  const paths = roots.map(uriToPath).filter(Boolean);
  for (const p of paths) {
    if (
      fs.existsSync(path.join(p, "build.gradle")) ||
      fs.existsSync(path.join(p, "build.gradle.kts")) ||
      fs.existsSync(path.join(p, "gradle.properties")) ||
      fs.existsSync(path.join(p, "settings.gradle"))
    ) {
      return p;
    }
  }
  return paths[0] ?? null;
}

export interface ClassMatch {
  fqcn: string;
  packageName: string;
  simpleName: string;
  artifact: string;
  origin: string;
  hasSource: boolean;
  needsDecompile: boolean;
}

export interface SourceResult {
  fqcn: string;
  artifact: string;
  jarPath: string;
  origin: string;
  decompiled: boolean;
  source: string;
  alternatives: { artifact: string; jarPath: string; kind: string }[];
}

export interface TextMatch {
  fqcn: string;
  artifact: string;
  line: number;
  text: string;
}

export interface ResourceMatch {
  path: string;
  artifact: string;
  origin: string;
  binary: boolean;
}

export interface ResourceTextMatch {
  path: string;
  artifact: string;
  line: number;
  text: string;
}

export interface ResourceContent {
  path: string;
  artifact: string;
  origin: string;
  binary: boolean;
  size: number;
  content: string | null;
}

/** Extensions whose bytes are not meaningfully searchable/readable as text. */
const BINARY_RESOURCE_EXTS = new Set([
  "png", "nbt", "ogg", "jpg", "jpeg", "gif", "ico", "webp", "bin", "dat", "zip", "jar",
  "class", "ttf", "otf", "wav", "mp3", "rsa", "sf", "kotlin_module",
]);

function resourceExt(p: string): string {
  const slash = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  return dot > slash ? p.slice(dot + 1).toLowerCase() : "";
}

function isBinaryResource(p: string): boolean {
  return BINARY_RESOURCE_EXTS.has(resourceExt(p));
}

export type RootsProvider = () => Promise<string[]>;

export class SourceService {
  private project: ProjectInfo;
  private index: ClassIndex | null = null;
  private buildError: string | null = null;
  private warnings: string[] = [];
  private projectResolved = false;

  constructor(private cfg: ServerConfig, private rootsProvider?: RootsProvider) {
    this.project = parseProject(cfg.projectDir);
  }

  /** When --project was not given, try to auto-bind to the workspace root advertised via MCP roots. */
  private async resolveProjectFromRoots(): Promise<void> {
    if (this.projectResolved) return;
    this.projectResolved = true;
    if (this.cfg.projectExplicit || !this.rootsProvider) return;
    try {
      const roots = await this.rootsProvider();
      const best = pickProjectRoot(roots);
      if (best && best !== this.project.projectDir) {
        this.project = parseProject(best);
        this.warnings.push(`已通过 MCP roots 自动绑定项目: ${best}`);
      }
    } catch {
      // Client may not support roots; keep the CLAUDE_PROJECT_DIR / cwd fallback.
    }
  }

  getProject(): ProjectInfo {
    return this.project;
  }

  getConfig(): ServerConfig {
    return this.cfg;
  }

  /** Build (if needed) and return the class index; used by the bytecode analysis layer. */
  async getIndex(): Promise<ClassIndex> {
    return this.ensureIndex();
  }

  reload(): void {
    this.project = parseProject(this.cfg.projectDir);
    this.index = null;
    this.buildError = null;
    this.warnings = [];
    this.projectResolved = false;
  }

  /** Merge two jar lists, deduplicating by absolute path (first wins). */
  private mergeJars(primary: JarInfo[], extra: JarInfo[]): JarInfo[] {
    const seen = new Set(primary.map((j) => j.jarPath));
    const merged = [...primary];
    for (const j of extra) {
      if (!seen.has(j.jarPath)) {
        seen.add(j.jarPath);
        merged.push(j);
      }
    }
    return merged;
  }

  private async discover(): Promise<JarInfo[]> {
    // ModDevGradle puts the patched MC(+loader) jars in <project>/build/moddev/artifacts, not in
    // GradleHome; they are project-local and authoritative regardless of resolve mode.
    const projectJars = discoverProjectJars(this.project);
    if (this.cfg.resolveMode === "gradle") {
      try {
        const paths = await resolveJarPaths(this.cfg.projectDir);
        if (paths.length > 0) return this.mergeJars(discoverJarsFromPaths(paths, this.project), projectJars);
        this.warnings.push("Gradle 解析未返回 jar，回退到文件系统扫描模式。");
      } catch (e) {
        this.warnings.push(`Gradle 解析失败，回退到扫描模式: ${(e as Error).message}`);
      }
    }
    if (!this.project.mcVersion) {
      this.warnings.push("未能从项目识别 Minecraft 版本，作用域可能偏大（无法按版本收窄）。");
    }
    return this.mergeJars(discoverJars(this.cfg, this.project), projectJars);
  }

  async ensureIndex(): Promise<ClassIndex> {
    if (this.index) return this.index;
    if (this.buildError) throw new Error(this.buildError);
    await this.resolveProjectFromRoots();
    const jars = await this.discover();

    const sigExtra = [
      this.cfg.resolveMode,
      this.project.projectDir,
      this.project.mcVersion ?? "",
      this.project.mappings,
      this.project.loaderVersion ?? "",
    ].join("|");
    const signature = computeSignature(jars, sigExtra);

    let jarEntries = loadIndexCache(this.cfg.cacheDir, signature);
    if (!jarEntries) {
      jarEntries = collectJarEntries(jars);
      saveIndexCache(this.cfg.cacheDir, signature, jarEntries);
    }

    this.index = buildClassIndex(jarEntries, this.project);
    if (this.index.jars.length === 0) {
      this.warnings.push("作用域内未发现任何 jar，检查 GradleHome 路径与项目依赖是否已下载。");
    }
    return this.index;
  }

  getWarnings(): string[] {
    return this.warnings;
  }

  async status(): Promise<Record<string, unknown>> {
    const idx = await this.ensureIndex();
    const byOrigin: Record<string, number> = {};
    let withSource = 0;
    for (const j of idx.jars) {
      byOrigin[j.origin] = (byOrigin[j.origin] ?? 0) + 1;
      if (j.kind === "sources") withSource++;
    }
    return {
      projectDir: this.project.projectDir,
      minecraftVersion: this.project.mcVersion,
      loader: this.project.loader,
      loaderVersion: this.project.loaderVersion,
      mappings: this.project.mappings,
      modId: this.project.modId,
      resolveMode: this.cfg.resolveMode,
      gradleHome: this.cfg.gradleHome,
      jarsInScope: idx.jars.length,
      jarsWithSource: withSource,
      jarsBinaryOnly: idx.jars.length - withSource,
      indexedClasses: idx.byFqcn.size,
      dependencyCoordinates: this.project.coordinates.length,
      jarsByOrigin: byOrigin,
      warnings: this.warnings,
    };
  }

  async listSources(): Promise<JarInfo[]> {
    const idx = await this.ensureIndex();
    return [...idx.jars].sort((a, b) => {
      if (a.origin !== b.origin) return a.origin.localeCompare(b.origin);
      return a.artifactName.localeCompare(b.artifactName);
    });
  }

  async searchClass(query: string, limit = 50): Promise<ClassMatch[]> {
    const idx = await this.ensureIndex();
    const q = query.trim();
    const ql = q.toLowerCase();
    const scored: { fqcn: string; rank: number }[] = [];

    const simpleHits = idx.bySimpleName.get(ql);
    const seen = new Set<string>();
    if (simpleHits) {
      for (const f of simpleHits) {
        scored.push({ fqcn: f, rank: 0 });
        seen.add(f);
      }
    }
    if (q.includes(".")) {
      for (const fqcn of idx.byFqcn.keys()) {
        if (seen.has(fqcn)) continue;
        if (fqcn.toLowerCase().includes(ql)) {
          scored.push({ fqcn, rank: fqcn.toLowerCase() === ql ? 0 : 2 });
          seen.add(fqcn);
        }
      }
    } else {
      for (const [simple, fqcns] of idx.bySimpleName) {
        if (simple === ql) continue;
        if (simple.includes(ql)) {
          for (const fqcn of fqcns) {
            if (seen.has(fqcn)) continue;
            scored.push({ fqcn, rank: simple.startsWith(ql) ? 1 : 3 });
            seen.add(fqcn);
          }
        }
      }
    }

    scored.sort((a, b) => a.rank - b.rank || a.fqcn.length - b.fqcn.length || a.fqcn.localeCompare(b.fqcn));
    return scored.slice(0, limit).map(({ fqcn }) => this.toMatch(idx, fqcn));
  }

  private toMatch(idx: ClassIndex, fqcn: string): ClassMatch {
    const entry = idx.byFqcn.get(fqcn)!;
    const dot = fqcn.lastIndexOf(".");
    return {
      fqcn,
      packageName: dot >= 0 ? fqcn.slice(0, dot) : "",
      simpleName: dot >= 0 ? fqcn.slice(dot + 1) : fqcn,
      artifact: entry.jar.artifactName,
      origin: entry.jar.origin,
      hasSource: entry.jar.kind === "sources",
      needsDecompile: entry.jar.kind === "binary",
    };
  }

  async getClassSource(fqcn: string): Promise<SourceResult> {
    const idx = await this.ensureIndex();
    const entries = idx.allByFqcn.get(fqcn);
    if (!entries || entries.length === 0) {
      throw new Error(`未找到类: ${fqcn}（先用 search_class 确认全限定名）`);
    }
    const best = idx.byFqcn.get(fqcn)!;
    const alternatives = entries
      .filter((e) => e.jar.jarPath !== best.jar.jarPath)
      .map((e) => ({ artifact: e.jar.artifactName, jarPath: e.jar.jarPath, kind: e.jar.kind }));

    let source: string;
    let decompiled = false;
    if (best.jar.kind === "sources") {
      const text = readTextEntry(best.jar.jarPath, best.entryPath);
      if (text === null) throw new Error(`源文件读取失败: ${best.entryPath}`);
      source = text;
    } else {
      const result = await decompileClass(this.cfg, best.jar.jarPath, fqcn, best.entryPath);
      source = result.source;
      decompiled = true;
    }

    return {
      fqcn,
      artifact: best.jar.artifactName,
      jarPath: best.jar.jarPath,
      origin: best.jar.origin,
      decompiled,
      source,
      alternatives,
    };
  }

  /** Search across source (.java) entries of in-scope sources jars. Binary-only jars are skipped. */
  async searchText(
    query: string,
    opts: { regex?: boolean; ignoreCase?: boolean; limit?: number; packagePrefix?: string } = {},
  ): Promise<{ matches: TextMatch[]; scannedJars: number; skippedBinaryJars: number; truncated: boolean }> {
    const idx = await this.ensureIndex();
    const limit = opts.limit ?? 100;
    const matcher = opts.regex
      ? new RegExp(query, opts.ignoreCase ? "i" : "")
      : null;
    const needle = opts.ignoreCase ? query.toLowerCase() : query;

    const matches: TextMatch[] = [];
    let scannedJars = 0;
    let skippedBinaryJars = 0;
    let truncated = false;
    const pkgPath = opts.packagePrefix ? opts.packagePrefix.replace(/\./g, "/") : null;

    outer: for (const jar of idx.jars) {
      if (jar.kind !== "sources") {
        skippedBinaryJars++;
        continue;
      }
      scannedJars++;
      let entries;
      try {
        entries = listEntries(jar.jarPath);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.path.endsWith(".java")) continue;
        if (pkgPath && !e.path.startsWith(pkgPath)) continue;
        const text = readTextEntry(jar.jarPath, e.path);
        if (text === null) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const hay = opts.ignoreCase ? lines[i].toLowerCase() : lines[i];
          const hit = matcher ? matcher.test(lines[i]) : hay.includes(needle);
          if (hit) {
            matches.push({
              fqcn: e.path.replace(/\.java$/, "").replace(/\//g, "."),
              artifact: jar.artifactName,
              line: i + 1,
              text: lines[i].trim().slice(0, 240),
            });
            if (matches.length >= limit) {
              truncated = true;
              break outer;
            }
          }
        }
      }
    }
    return { matches, scannedJars, skippedBinaryJars, truncated };
  }

  private matchResource(
    path: string,
    ext: string | null,
    prefix: string | null,
    query: string | null,
    ignoreCase: boolean,
  ): boolean {
    if (ext && resourceExt(path) !== ext) return false;
    if (prefix && !path.startsWith(prefix)) return false;
    if (query) {
      const hay = ignoreCase ? path.toLowerCase() : path;
      if (!hay.includes(query)) return false;
    }
    return true;
  }

  /** Locate resource files (json/shader/mcmeta/png/…) by extension, path prefix, or name fragment. */
  async findResources(opts: {
    query?: string;
    ext?: string;
    pathPrefix?: string;
    ignoreCase?: boolean;
    limit?: number;
  }): Promise<{ matches: ResourceMatch[]; total: number; truncated: boolean }> {
    const idx = await this.ensureIndex();
    const limit = opts.limit ?? 100;
    const ext = opts.ext ? opts.ext.replace(/^\./, "").toLowerCase() : null;
    const prefix = opts.pathPrefix ? opts.pathPrefix.replace(/\\/g, "/") : null;
    const query = opts.query ? (opts.ignoreCase ? opts.query.toLowerCase() : opts.query) : null;

    const matches: ResourceMatch[] = [];
    let total = 0;
    for (const r of idx.resourcesByPath.values()) {
      if (!this.matchResource(r.path, ext, prefix, query, opts.ignoreCase ?? false)) continue;
      total++;
      if (matches.length < limit) {
        matches.push({
          path: r.path,
          artifact: r.jar.artifactName,
          origin: r.jar.origin,
          binary: isBinaryResource(r.path),
        });
      }
    }
    matches.sort((a, b) => a.path.localeCompare(b.path));
    return { matches, total, truncated: total > matches.length };
  }

  /** Full-text/regex search inside text resources (json, shaders, …). Binary files are skipped. */
  async grepResources(
    content: string,
    opts: {
      ext?: string;
      pathPrefix?: string;
      regex?: boolean;
      ignoreCase?: boolean;
      limit?: number;
      maxFiles?: number;
    } = {},
  ): Promise<{ matches: ResourceTextMatch[]; scannedFiles: number; truncated: boolean }> {
    const idx = await this.ensureIndex();
    const limit = opts.limit ?? 100;
    const maxFiles = opts.maxFiles ?? 3000;
    const ext = opts.ext ? opts.ext.replace(/^\./, "").toLowerCase() : null;
    const prefix = opts.pathPrefix ? opts.pathPrefix.replace(/\\/g, "/") : null;
    const matcher = opts.regex ? new RegExp(content, opts.ignoreCase ? "i" : "") : null;
    const needle = opts.ignoreCase ? content.toLowerCase() : content;

    const matches: ResourceTextMatch[] = [];
    let scannedFiles = 0;
    let truncated = false;
    outer: for (const r of idx.resourcesByPath.values()) {
      if (isBinaryResource(r.path)) continue;
      if (!this.matchResource(r.path, ext, prefix, null, false)) continue;
      if (scannedFiles >= maxFiles) {
        truncated = true;
        break;
      }
      scannedFiles++;
      const text = readTextEntry(r.jar.jarPath, r.path);
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const hay = opts.ignoreCase ? lines[i].toLowerCase() : lines[i];
        const hit = matcher ? matcher.test(lines[i]) : hay.includes(needle);
        if (hit) {
          matches.push({
            path: r.path,
            artifact: r.jar.artifactName,
            line: i + 1,
            text: lines[i].trim().slice(0, 240),
          });
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    return { matches, scannedFiles, truncated };
  }

  /** Read a single resource by its exact jar-internal path; binary files return size only. */
  async getResource(resPath: string): Promise<ResourceContent> {
    const idx = await this.ensureIndex();
    const norm = resPath.replace(/\\/g, "/");
    const r = idx.resourcesByPath.get(norm);
    if (!r) throw new Error(`未找到资源: ${resPath}（先用 search_resources 确认完整路径）`);
    const base = { path: r.path, artifact: r.jar.artifactName, origin: r.jar.origin };
    if (isBinaryResource(r.path)) {
      const buf = readBinaryEntry(r.jar.jarPath, r.path);
      return { ...base, binary: true, size: buf?.length ?? 0, content: null };
    }
    const text = readTextEntry(r.jar.jarPath, r.path);
    if (text === null) throw new Error(`资源读取失败: ${resPath}`);
    return { ...base, binary: false, size: Buffer.byteLength(text, "utf8"), content: text };
  }
}
