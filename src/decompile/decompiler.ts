import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ServerConfig } from "../config.js";
import { listEntries, readBinaryEntry } from "../jar/jarReader.js";

export interface DecompileResult {
  source: string;
  fromCache: boolean;
}

function hashKey(parts: string[]): string {
  const h = crypto.createHash("sha1");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 24);
}

function entryToClassPath(entryPath: string): string {
  // pkg/Outer.class -> pkg/Outer ; also returns dir + simple name pieces
  return entryPath.replace(/\.class$/, "");
}

/** Inner-class entries that belong to the same top-level class as the given .class entry. */
function siblingClassEntries(jarPath: string, classEntry: string): string[] {
  const base = entryToClassPath(classEntry); // pkg/Outer
  const prefix = base + "$";
  const all = listEntries(jarPath);
  const result = [classEntry];
  for (const e of all) {
    if (e.path.endsWith(".class") && e.path.startsWith(prefix)) result.push(e.path);
  }
  return result;
}

function runVineflower(cfg: ServerConfig, srcDir: string, libJar: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-jar",
      cfg.vineflowerJar,
      "-dgs=1", // decompile generic signatures
      "-rsy=1", // hide synthetic members
      "--silent",
      `-e=${libJar}`, // owning jar as classpath context for better type resolution
      srcDir,
      outDir,
    ];
    const child = spawn("java", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Vineflower 退出码 ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * Decompile a single class (with its inner classes) from a binary jar to Java source.
 * Results are cached on disk keyed by jar path + mtime + fqcn.
 */
export async function decompileClass(
  cfg: ServerConfig,
  jarPath: string,
  fqcn: string,
  classEntry: string,
): Promise<DecompileResult> {
  const stat = fs.statSync(jarPath);
  const key = hashKey([jarPath, String(stat.mtimeMs), fqcn]);
  const cacheFile = path.join(cfg.cacheDir, "decompiled", `${key}.java`);

  if (fs.existsSync(cacheFile)) {
    return { source: fs.readFileSync(cacheFile, "utf8"), fromCache: true };
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcsrc-"));
  const srcDir = path.join(work, "in");
  const outDir = path.join(work, "out");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const entries = siblingClassEntries(jarPath, classEntry);
    for (const e of entries) {
      const data = readBinaryEntry(jarPath, e);
      if (!data) continue;
      const dest = path.join(srcDir, e);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }

    await runVineflower(cfg, srcDir, jarPath, outDir);

    const javaRel = classEntry.replace(/\.class$/, ".java");
    const produced = path.join(outDir, javaRel);
    let source: string;
    if (fs.existsSync(produced)) {
      source = fs.readFileSync(produced, "utf8");
    } else {
      // Fallback: locate any .java produced.
      const found = findFirstJava(outDir);
      if (!found) throw new Error(`反编译未产出 Java 源 (${fqcn})`);
      source = fs.readFileSync(found, "utf8");
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, source, "utf8");
    return { source, fromCache: false };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

function findFirstJava(dir: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFirstJava(full);
      if (r) return r;
    } else if (e.name.endsWith(".java")) {
      return full;
    }
  }
  return null;
}
