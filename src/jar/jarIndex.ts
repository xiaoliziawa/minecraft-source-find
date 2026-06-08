import fs from "node:fs";
import path from "node:path";
import { ServerConfig } from "../config.js";
import { ProjectInfo, Mappings } from "../project/gradleProject.js";
import { listEntries } from "./jarReader.js";

export type JarOrigin = "minecraft" | "loader" | "mod" | "library";

export interface JarInfo {
  jarPath: string;
  kind: "sources" | "binary";
  origin: JarOrigin;
  /** Display name (jar filename without -sources suffix). */
  artifactName: string;
  /** group:name when derivable (modules-2), else best-effort. */
  artifactId: string;
  mcVersion: string | null;
  mappings: Mappings | null;
  version: string | null;
  isCore: boolean;
}

export interface ClassEntry {
  fqcn: string;
  /** Entry path inside the jar (.java for sources, .class for binary). */
  entryPath: string;
  jar: JarInfo;
}

/** A non-source/non-class file inside a jar (json model, shader, mcmeta, texture, …). */
export interface ResourceEntry {
  /** Forward-slash path inside the jar. */
  path: string;
  jar: JarInfo;
}

export interface ClassIndex {
  /** fqcn -> best ClassEntry. */
  byFqcn: Map<string, ClassEntry>;
  /** simpleName(lower) -> fqcn[]. */
  bySimpleName: Map<string, string[]>;
  jars: JarInfo[];
  /** fqcn -> all entries (for showing alternatives). */
  allByFqcn: Map<string, ClassEntry[]>;
  /** jar-internal path -> best ResourceEntry (deduplicated across duplicate jars). */
  resourcesByPath: Map<string, ResourceEntry>;
}

const MC_TOKEN_RE = /1\.\d{1,2}(?:\.\d{1,2}){0,2}/g;
/** ModDevGradle (NeoForge/Forge) emits the patched MC(+loader) jar here, project-local, not in GradleHome. */
const MDG_ARTIFACTS_DIR = ["build", "moddev", "artifacts"];
const SKIP_SUFFIXES = [
  "-javadoc.jar",
  "-recomp.jar",
  "-universal.jar",
  "-userdev.jar",
  "-natives.jar",
  "-slim.jar",
  "-client-extra.jar",
];
const SKIP_NAMES = new Set(["client-extra.jar"]);

function detectMappingsToken(p: string): Mappings | null {
  const lower = p.toLowerCase();
  if (lower.includes("parchment")) return "parchment";
  if (lower.includes("mapped_official") || lower.includes("mojmap")) return "official";
  if (lower.includes("yarn")) return "yarn";
  if (lower.includes("mcp")) return "mcp";
  return null;
}

function lastMcToken(p: string): string | null {
  const matches = p.match(MC_TOKEN_RE);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

/** Derive group:name and version from a modules-2/files-2.1 path. */
function parseModulesCoord(jarPath: string): { artifactId: string; version: string } | null {
  const norm = jarPath.replace(/\\/g, "/");
  const marker = "/files-2.1/";
  const idx = norm.indexOf(marker);
  if (idx < 0) return null;
  const rest = norm.slice(idx + marker.length).split("/");
  // [...group, name, version, hash, file]
  if (rest.length < 5) return null;
  const file = rest[rest.length - 1];
  const hash = rest[rest.length - 2];
  const version = rest[rest.length - 3];
  const name = rest[rest.length - 4];
  const group = rest.slice(0, rest.length - 4).join(".");
  void file;
  void hash;
  return { artifactId: `${group}:${name}`, version };
}

function classifyOrigin(jarPath: string): { origin: JarOrigin; isCore: boolean } {
  const norm = jarPath.replace(/\\/g, "/");
  if (
    /\/forge_gradle\/minecraft_user_repo\/net\/minecraftforge\/forge\//.test(norm) ||
    /\/fabric-loom\/minecraftMaven\/net\/minecraft\//.test(norm)
  ) {
    return { origin: "loader", isCore: true };
  }
  if (/\/modules-2\/files-2\.1\//.test(norm)) {
    // Mods downloaded from any maven also land here; distinguish later by coordinate matching.
    return { origin: "library", isCore: false };
  }
  return { origin: "mod", isCore: false };
}

function shouldSkip(fileName: string): boolean {
  if (SKIP_NAMES.has(fileName)) return true;
  return SKIP_SUFFIXES.some((s) => fileName.endsWith(s));
}

function walkJars(root: string, out: string[], limit = 200000): void {
  if (!fs.existsSync(root)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      walkJars(full, out, limit);
    } else if (e.isFile() && e.name.endsWith(".jar") && !shouldSkip(e.name)) {
      out.push(full);
    }
  }
}

function toJarInfo(jarPath: string, coordVersions: Map<string, string>): JarInfo {
  const fileName = path.basename(jarPath);
  const isSources = fileName.endsWith("-sources.jar");
  const { origin, isCore } = classifyOrigin(jarPath);
  const modules = parseModulesCoord(jarPath);
  const artifactName = fileName.replace(/-sources\.jar$/, ".jar").replace(/\.jar$/, "");
  const artifactId = modules?.artifactId ?? artifactName.replace(/-sources$/, "");
  let resolvedOrigin = origin;
  // A modules-2 artifact that matches a project mod coordinate is a "mod", others stay "library".
  if (origin === "library" && coordVersions.has(artifactId)) {
    // Heuristic: keep as library; mods usually arrive via forge_gradle/loom. Coordinate match still scopes it in.
    resolvedOrigin = "library";
  }
  return {
    jarPath,
    kind: isSources ? "sources" : "binary",
    origin: resolvedOrigin,
    artifactName,
    artifactId,
    mcVersion: lastMcToken(jarPath.replace(/\\/g, "/")),
    mappings: detectMappingsToken(jarPath),
    version: modules?.version ?? null,
    isCore,
  };
}

function inScope(jar: JarInfo, project: ProjectInfo, coordIds: Set<string>): boolean {
  const mc = project.mcVersion;
  if (jar.isCore) {
    return mc ? jar.mcVersion === mc || jar.jarPath.includes(mc) : true;
  }
  if (jar.origin === "library") {
    // Plain libs (no MC token) only count if a project coordinate references them.
    if (jar.mcVersion && mc) return jar.mcVersion === mc;
    return coordIds.has(jar.artifactId);
  }
  // mods (forge_gradle/fabric-loom transformed)
  if (mc) return jar.jarPath.includes(mc);
  return true;
}

function versionRank(version: string | null): number {
  if (!version) return 0;
  const parts = version.match(/\d+/g);
  if (!parts) return 0;
  let rank = 0;
  for (let i = 0; i < Math.min(parts.length, 4); i++) {
    rank = rank * 1000 + Math.min(parseInt(parts[i], 10), 999);
  }
  return rank;
}

function entryScore(jar: JarInfo, project: ProjectInfo, coordVersions: Map<string, string>): number {
  let s = 0;
  if (jar.kind === "sources") s += 1_000_000;
  if (jar.mappings && project.mappings !== "unknown" && jar.mappings === project.mappings) s += 200_000;
  const wantVersion = coordVersions.get(jar.artifactId);
  if (wantVersion && jar.version && jar.version === wantVersion) s += 100_000;
  if (jar.isCore) {
    s += 50_000;
    if (project.loaderVersion && jar.jarPath.includes(project.loaderVersion)) s += 300_000;
  }
  s += versionRank(jar.version) % 50_000;
  return s;
}

export function discoverJars(cfg: ServerConfig, project: ProjectInfo): JarInfo[] {
  const caches = path.join(cfg.gradleHome, "caches");
  const roots = [
    path.join(caches, "forge_gradle", "minecraft_user_repo"),
    path.join(caches, "forge_gradle", "deobf_dependencies"),
    path.join(caches, "fabric-loom", "minecraftMaven"),
    path.join(caches, "fabric-loom"),
    path.join(caches, "modules-2", "files-2.1"),
  ];
  const seen = new Set<string>();
  const jarPaths: string[] = [];
  for (const root of roots) {
    const collected: string[] = [];
    walkJars(root, collected);
    for (const j of collected) {
      if (!seen.has(j)) {
        seen.add(j);
        jarPaths.push(j);
      }
    }
  }

  const coordVersions = new Map<string, string>();
  for (const c of project.coordinates) coordVersions.set(`${c.group}:${c.name}`, c.version);
  const coordIds = new Set(coordVersions.keys());

  const jars: JarInfo[] = [];
  for (const jp of jarPaths) {
    const info = toJarInfo(jp, coordVersions);
    if (inScope(info, project, coordIds)) jars.push(info);
  }
  return jars;
}

function projectJarInfo(jarPath: string, project: ProjectInfo): JarInfo {
  const fileName = path.basename(jarPath);
  const isSources = fileName.endsWith("-sources.jar");
  const artifactName = fileName.replace(/-sources\.jar$/, ".jar").replace(/\.jar$/, "");
  return {
    jarPath,
    kind: isSources ? "sources" : "binary",
    origin: "minecraft",
    artifactName,
    artifactId: artifactName,
    mcVersion: project.mcVersion,
    mappings: project.mappings === "unknown" ? null : project.mappings,
    version: project.loaderVersion,
    isCore: true,
  };
}

/**
 * Discover the patched Minecraft(+loader) jars that ModDevGradle generates under
 * <project>/build/moddev/artifacts. These are project-local and authoritative, so they are always
 * in scope (no version filtering). The "-merged" jar mixes .class and .java and is skipped to avoid
 * double-counting; the plain jar (binary) and the -sources jar (sources) cover both views.
 */
export function discoverProjectJars(project: ProjectInfo): JarInfo[] {
  const dir = path.join(project.projectDir, ...MDG_ARTIFACTS_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: JarInfo[] = [];
  for (const f of files) {
    if (!f.endsWith(".jar") || f.endsWith("-merged.jar") || shouldSkip(f)) continue;
    out.push(projectJarInfo(path.join(dir, f), project));
  }
  return out;
}

/** Find a sibling "<name>-sources.jar" for a resolved binary jar (modules-2 keeps it in a sibling hash dir). */
function findSiblingSources(binaryJar: string): string | null {
  const dir = path.dirname(binaryJar);
  const base = path.basename(binaryJar).replace(/\.jar$/, "");
  const direct = path.join(dir, `${base}-sources.jar`);
  if (fs.existsSync(direct)) return direct;
  // modules-2: sources sit under a sibling hash dir within the same version dir.
  const versionDir = path.dirname(dir);
  if (fs.existsSync(versionDir)) {
    try {
      for (const hashDir of fs.readdirSync(versionDir)) {
        const cand = path.join(versionDir, hashDir, `${base}-sources.jar`);
        if (fs.existsSync(cand)) return cand;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Gradle-mode: build JarInfo list from exact resolved paths, adding any sibling sources jars. */
export function discoverJarsFromPaths(paths: string[], project: ProjectInfo): JarInfo[] {
  const coordVersions = new Map<string, string>();
  for (const c of project.coordinates) coordVersions.set(`${c.group}:${c.name}`, c.version);

  const all = new Set<string>();
  for (const p of paths) {
    const fileName = path.basename(p);
    if (shouldSkip(fileName) || !p.endsWith(".jar")) continue;
    all.add(p);
    const sources = findSiblingSources(p);
    if (sources) all.add(sources);
  }
  return [...all].map((p) => toJarInfo(p, coordVersions));
}

function fqcnFromEntry(entryPath: string): { fqcn: string; simple: string } | null {
  let e = entryPath;
  if (e.endsWith(".java")) e = e.slice(0, -5);
  else if (e.endsWith(".class")) e = e.slice(0, -6);
  else return null;
  if (e.includes("$")) return null; // skip inner classes for the primary index
  const fqcn = e.replace(/\//g, ".");
  const simple = fqcn.slice(fqcn.lastIndexOf(".") + 1);
  if (!simple || simple === "package-info" || simple === "module-info") return null;
  return { fqcn, simple };
}

export interface JarEntries {
  jar: JarInfo;
  /** Top-level .java/.class entry paths (inner classes excluded; they are read on demand). */
  entries: string[];
  /** Every other file path (json/shader/mcmeta/png/…), for the resource index. */
  resources: string[];
}

/** Read the (expensive) zip central directories once; result is cacheable to disk. */
export function collectJarEntries(jars: JarInfo[]): JarEntries[] {
  const out: JarEntries[] = [];
  for (const jar of jars) {
    let entries;
    try {
      entries = listEntries(jar.jarPath);
    } catch {
      out.push({ jar, entries: [], resources: [] });
      continue;
    }
    const classes: string[] = [];
    const resources: string[] = [];
    for (const e of entries) {
      if (e.path.endsWith(".java") || e.path.endsWith(".class")) classes.push(e.path);
      else resources.push(e.path);
    }
    out.push({ jar, entries: classes, resources });
  }
  return out;
}

export function buildClassIndex(jarEntries: JarEntries[], project: ProjectInfo): ClassIndex {
  const coordVersions = new Map<string, string>();
  for (const c of project.coordinates) coordVersions.set(`${c.group}:${c.name}`, c.version);

  const byFqcn = new Map<string, ClassEntry>();
  const bestScore = new Map<string, number>();
  const allByFqcn = new Map<string, ClassEntry[]>();
  const bySimpleName = new Map<string, string[]>();
  const resourcesByPath = new Map<string, ResourceEntry>();
  const resBestScore = new Map<string, number>();
  const jars: JarInfo[] = [];

  for (const { jar, entries, resources } of jarEntries) {
    jars.push(jar);
    const score = entryScore(jar, project, coordVersions);
    for (const rpath of resources) {
      const prev = resBestScore.get(rpath);
      if (prev === undefined || score > prev) {
        resBestScore.set(rpath, score);
        resourcesByPath.set(rpath, { path: rpath, jar });
      }
    }
    for (const entryPath of entries) {
      const parsed = fqcnFromEntry(entryPath);
      if (!parsed) continue;
      const { fqcn, simple } = parsed;
      const ce: ClassEntry = { fqcn, entryPath, jar };

      const list = allByFqcn.get(fqcn);
      if (list) list.push(ce);
      else allByFqcn.set(fqcn, [ce]);

      const prev = bestScore.get(fqcn);
      if (prev === undefined || score > prev) {
        bestScore.set(fqcn, score);
        byFqcn.set(fqcn, ce);
      }

      const sk = simple.toLowerCase();
      const sl = bySimpleName.get(sk);
      if (sl) {
        if (!sl.includes(fqcn)) sl.push(fqcn);
      } else {
        bySimpleName.set(sk, [fqcn]);
      }
    }
  }

  return { byFqcn, bySimpleName, jars, allByFqcn, resourcesByPath };
}
