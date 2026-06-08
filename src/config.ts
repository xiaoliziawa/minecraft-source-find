import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export type TransportKind = "stdio" | "http";
export type ResolveMode = "scan" | "gradle";

export interface ServerConfig {
  /** Bound mod project directory (where build.gradle / gradle.properties live). */
  projectDir: string;
  /** True when --project was given explicitly; otherwise the project may be auto-bound from MCP roots. */
  projectExplicit: boolean;
  /** Gradle user home that holds the dependency caches. */
  gradleHome: string;
  /** How to determine the in-scope jars: filesystem scan (default) or gradle classpath resolve. */
  resolveMode: ResolveMode;
  /** Path to the Vineflower decompiler jar. */
  vineflowerJar: string;
  /** Directory for decompiled-source and index caches. */
  cacheDir: string;
  /** Transport selection. */
  transport: TransportKind;
  /** HTTP host/port (only used when transport === "http"). */
  host: string;
  port: number;
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const packageRoot = path.resolve(here, "..");

/** Locate GRADLE_USER_HOME the same way Gradle itself does. */
export function detectGradleHome(): string {
  const fromEnv = process.env.GRADLE_USER_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".gradle");
}

export function defaultVineflowerJar(): string {
  return path.join(packageRoot, "vendor", "vineflower.jar");
}

export function defaultCacheDir(): string {
  return path.join(packageRoot, ".cache");
}

export function resolveConfig(partial: Partial<ServerConfig>): ServerConfig {
  // Claude Code injects CLAUDE_PROJECT_DIR (cwd is not guaranteed); fall back to it so a single
  // user-scoped server auto-binds to whichever project Claude Code is currently open in.
  const projectDir = path.resolve(partial.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const gradleHome = partial.gradleHome ? path.resolve(partial.gradleHome) : detectGradleHome();
  const cfg: ServerConfig = {
    projectDir,
    projectExplicit: partial.projectDir != null,
    gradleHome,
    resolveMode: partial.resolveMode ?? "scan",
    vineflowerJar: partial.vineflowerJar ? path.resolve(partial.vineflowerJar) : defaultVineflowerJar(),
    cacheDir: partial.cacheDir ? path.resolve(partial.cacheDir) : defaultCacheDir(),
    transport: partial.transport ?? "stdio",
    host: partial.host ?? "127.0.0.1",
    port: partial.port ?? 4799,
  };
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  return cfg;
}

export function validateConfig(cfg: ServerConfig): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(cfg.gradleHome)) {
    errors.push(`GradleHome 不存在: ${cfg.gradleHome}（设置 GRADLE_USER_HOME 或用 --gradle-home 指定）`);
  } else if (!fs.existsSync(path.join(cfg.gradleHome, "caches"))) {
    errors.push(`GradleHome 下没有 caches 目录: ${cfg.gradleHome}`);
  }
  if (!fs.existsSync(cfg.vineflowerJar)) {
    errors.push(`Vineflower 反编译器缺失: ${cfg.vineflowerJar}`);
  }
  return errors;
}
