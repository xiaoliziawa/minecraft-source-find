import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { ServerConfig } from "../config.js";
import { computeSignature } from "../jar/indexCache.js";
import { SourceService } from "./sourceService.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const packageRoot = path.resolve(here, "..", "..");

export interface RefHit {
  callerFqcn: string;
  callerArtifact: string;
  method: string;
  line: number;
  kind: string;
  targetOwner: string;
  targetName: string;
  targetDesc: string;
}

export interface OutlineClass {
  internal: string;
  superName: string;
  interfaces: string[];
  access: number;
  methods: { name: string; desc: string; access: number }[];
  fields: { name: string; desc: string; access: number }[];
}

const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;

export type TargetKind = "class" | "method" | "field";

interface OutlineDb {
  byInternal: Map<string, OutlineClass>;
  children: Map<string, string[]>; // internal -> direct subtypes (super or interface)
}

function toInternal(fqcn: string): string {
  return fqcn.replace(/\./g, "/");
}
function toFqcn(internal: string): string {
  return internal.replace(/\//g, ".");
}

export class BytecodeService {
  private outline: OutlineDb | null = null;
  private outlineSig: string | null = null;
  private jarPathsCache: { sig: string; paths: string[] } | null = null;

  constructor(private cfg: ServerConfig, private source: SourceService) {}

  private analyzerCrateDir(): string {
    return path.join(packageRoot, "analyzer");
  }
  private analyzerBin(): string {
    const exe = process.platform === "win32" ? "mcp-analyzer.exe" : "mcp-analyzer";
    return path.join(this.analyzerCrateDir(), "target", "release", exe);
  }

  /** Build the Rust analyzer on first use (cargo fetches crates once); no-op once the binary exists. */
  private ensureBuilt(): void {
    if (fs.existsSync(this.analyzerBin())) return;
    const crate = this.analyzerCrateDir();
    if (!fs.existsSync(path.join(crate, "Cargo.toml"))) throw new Error(`缺少 Rust 分析器项目: ${crate}`);
    const r = spawnSync("cargo", ["build", "--release"], { cwd: crate, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`编译 mcp-analyzer 失败: ${(r.stderr || r.stdout || "").slice(0, 800)}`);
  }

  private async jarPaths(): Promise<string[]> {
    const idx = await this.source.getIndex();
    const sig = computeSignature(idx.jars, "jarpaths|" + this.cfg.resolveMode);
    if (this.jarPathsCache && this.jarPathsCache.sig === sig) return this.jarPathsCache.paths;
    const project = this.source.getProject();
    const loaderVer = project.loaderVersion ?? "";
    const wantMap = project.mappings;
    // Reference analysis needs bytecode (.class). Pick exactly ONE binary jar per class — the one the
    // index would prefer (matching loader version / mappings) — so duplicate cached versions of the
    // same dependency are not double-counted.
    const prefScore = (e: { jar: { jarPath: string; mappings: string | null; isCore: boolean } }): number =>
      (loaderVer && e.jar.jarPath.includes(loaderVer) ? 4 : 0) +
      (e.jar.mappings && e.jar.mappings === wantMap ? 2 : 0) +
      (e.jar.isCore ? 1 : 0);

    const chosen = new Set<string>();
    for (const entries of idx.allByFqcn.values()) {
      let best: (typeof entries)[number] | null = null;
      for (const e of entries) {
        if (e.jar.kind !== "binary") continue;
        if (!best || prefScore(e) > prefScore(best)) best = e;
      }
      if (best) chosen.add(best.jar.jarPath);
    }
    const paths = [...chosen];
    this.jarPathsCache = { sig, paths };
    return paths;
  }

  private writeOptions(lines: string[]): string {
    const file = path.join(this.cfg.cacheDir, `analyzer-opts-${process.pid}-${lines.length}.txt`);
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }

  private runAnalyzer(optionLines: string[], timeoutMs = 180000): Promise<string> {
    this.ensureBuilt();
    const optFile = this.writeOptions(optionLines);
    return new Promise((resolve, reject) => {
      const child = spawn(this.analyzerBin(), [optFile], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`分析器超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        try { fs.rmSync(optFile, { force: true }); } catch { /* ignore */ }
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try { fs.rmSync(optFile, { force: true }); } catch { /* ignore */ }
        if (code === 0) resolve(stdout);
        else reject(new Error(`分析器退出码 ${code}: ${stderr.slice(0, 400)}`));
      });
    });
  }

  // ---------- outline / hierarchy ----------

  private outlineCacheFile(sig: string): string {
    return path.join(this.cfg.cacheDir, `outline-${sig.slice(0, 16)}.json.gz`);
  }

  async ensureOutline(): Promise<OutlineDb> {
    const idx = await this.source.getIndex();
    const sig = computeSignature(idx.jars, "outline|" + this.cfg.resolveMode);
    if (this.outline && this.outlineSig === sig) return this.outline;
    const cacheFile = this.outlineCacheFile(sig);

    let raw: OutlineClass[] | null = null;
    if (fs.existsSync(cacheFile)) {
      try {
        raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile)).toString("utf8"));
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      const jars = await this.jarPaths();
      const text = await this.runAnalyzer(["CMD=outline", "THREADS=8", ...jars.map((j) => "JAR=" + j)]);
      raw = parseOutline(text);
      try {
        fs.writeFileSync(cacheFile, zlib.gzipSync(Buffer.from(JSON.stringify(raw), "utf8"), { level: 6 }));
      } catch {
        /* best effort */
      }
    }

    const byInternal = new Map<string, OutlineClass>();
    const children = new Map<string, string[]>();
    for (const c of raw) byInternal.set(c.internal, c);
    for (const c of raw) {
      const parents = [c.superName, ...c.interfaces].filter(Boolean);
      for (const p of parents) {
        const list = children.get(p);
        if (list) list.push(c.internal);
        else children.set(p, [c.internal]);
      }
    }
    this.outline = { byInternal, children };
    this.outlineSig = sig;
    return this.outline;
  }

  /** Transitive subtypes (descendants) of an internal type name. */
  private descendants(db: OutlineDb, internal: string, limit = 5000): Set<string> {
    const out = new Set<string>();
    const stack = [internal];
    while (stack.length && out.size < limit) {
      const cur = stack.pop()!;
      for (const ch of db.children.get(cur) ?? []) {
        if (!out.has(ch)) {
          out.add(ch);
          stack.push(ch);
        }
      }
    }
    return out;
  }

  /** Transitive supertypes (ancestors) of an internal type name. */
  private ancestors(db: OutlineDb, internal: string): Set<string> {
    const out = new Set<string>();
    const stack = [internal];
    while (stack.length) {
      const cur = stack.pop()!;
      const c = db.byInternal.get(cur);
      if (!c) continue;
      for (const p of [c.superName, ...c.interfaces].filter(Boolean)) {
        if (!out.has(p)) {
          out.add(p);
          stack.push(p);
        }
      }
    }
    return out;
  }

  async findImplementations(
    fqcn: string,
    transitive = true,
  ): Promise<{ fqcn: string; kind: "interface" | "abstract" | "class" }[]> {
    const db = await this.ensureOutline();
    const internal = toInternal(fqcn);
    const set = transitive ? this.descendants(db, internal) : new Set(db.children.get(internal) ?? []);
    return [...set]
      .map((i) => {
        const c = db.byInternal.get(i);
        const acc = c?.access ?? 0;
        const kind = (acc & ACC_INTERFACE) !== 0 ? "interface" : (acc & ACC_ABSTRACT) !== 0 ? "abstract" : "class";
        return { fqcn: toFqcn(i), kind: kind as "interface" | "abstract" | "class" };
      })
      .sort((a, b) => a.fqcn.localeCompare(b.fqcn));
  }

  async classOutline(fqcn: string): Promise<OutlineClass | null> {
    const db = await this.ensureOutline();
    return db.byInternal.get(toInternal(fqcn)) ?? null;
  }

  async findOverrides(fqcn: string, methodName: string, desc?: string): Promise<{ fqcn: string }[]> {
    const db = await this.ensureOutline();
    const subs = this.descendants(db, toInternal(fqcn));
    const out: { fqcn: string }[] = [];
    for (const i of subs) {
      const c = db.byInternal.get(i);
      if (!c) continue;
      if (c.methods.some((m) => m.name === methodName && (!desc || m.desc === desc))) {
        out.push({ fqcn: toFqcn(i) });
      }
    }
    return out.sort((a, b) => a.fqcn.localeCompare(b.fqcn));
  }

  // ---------- references ----------

  async findReferences(
    targetFqcn: string,
    kind: TargetKind,
    member: { name: string; desc?: string } | null,
    callerPackage: string | null,
  ): Promise<{ hits: RefHit[]; total: number; byKind: Record<string, number> }> {
    const idx = await this.source.getIndex();
    const jars = await this.jarPaths();

    const opts = [
      "CMD=refs",
      "THREADS=8",
      `TKIND=${kind}`,
      `TOWNER=${toInternal(targetFqcn)}`,
    ];
    if (member) {
      opts.push(`TNAME=${member.name}`);
      if (member.desc) opts.push(`TDESC=${member.desc}`);
    }
    if (callerPackage) opts.push(`PKG=${toInternal(callerPackage)}`);
    opts.push(...jars.map((j) => "JAR=" + j));

    const text = await this.runAnalyzer(opts);

    // For member targets, restrict to owners along the type hierarchy for precision.
    let ownerFilter: Set<string> | null = null;
    if (kind !== "class") {
      const db = await this.ensureOutline();
      const internal = toInternal(targetFqcn);
      ownerFilter = new Set<string>([internal, ...this.descendants(db, internal), ...this.ancestors(db, internal)]);
    }

    const byKind: Record<string, number> = {};
    const hits: RefHit[] = [];
    let total = 0;
    for (const line of text.split("\n")) {
      if (!line.startsWith("R\t")) continue;
      const p = line.split("\t");
      // R, caller, method, mdesc, line, kind, owner, name, desc
      const owner = p[6] ?? "";
      if (ownerFilter && !ownerFilter.has(owner)) continue;
      total++;
      const k = p[5] ?? "";
      byKind[k] = (byKind[k] ?? 0) + 1;
      const callerFqcn = toFqcn(p[1] ?? "");
      const idxEntry = idx.byFqcn.get(callerFqcn);
      hits.push({
        callerFqcn,
        callerArtifact: idxEntry?.jar.artifactName ?? "?",
        method: p[2] ?? "",
        line: parseInt(p[4] ?? "-1", 10),
        kind: k,
        targetOwner: toFqcn(owner),
        targetName: p[7] ?? "",
        targetDesc: p[8] ?? "",
      });
    }
    return { hits, total, byKind };
  }
}

function parseOutline(text: string): OutlineClass[] {
  const out: OutlineClass[] = [];
  let cur: OutlineClass | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const p = line.split("\t");
    if (p[0] === "C") {
      cur = {
        internal: p[1] ?? "",
        superName: p[2] ?? "",
        interfaces: p[3] ? p[3].split(",").filter(Boolean) : [],
        access: parseInt(p[4] ?? "0", 10),
        methods: [],
        fields: [],
      };
      out.push(cur);
    } else if (p[0] === "m" && cur) {
      cur.methods.push({ name: p[1] ?? "", desc: p[2] ?? "", access: parseInt(p[3] ?? "0", 10) });
    } else if (p[0] === "f" && cur) {
      cur.fields.push({ name: p[1] ?? "", desc: p[2] ?? "", access: parseInt(p[3] ?? "0", 10) });
    }
  }
  return out;
}
