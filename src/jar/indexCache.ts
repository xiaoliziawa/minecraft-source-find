import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { JarInfo, JarEntries } from "./jarIndex.js";

interface CacheFile {
  version: 2;
  signature: string;
  jarEntries: JarEntries[];
}

const CACHE_VERSION = 2 as const;

/** Signature over the in-scope jar set + project identity; changes invalidate the cache. */
export function computeSignature(jars: JarInfo[], extra: string): string {
  const h = crypto.createHash("sha1");
  h.update(extra).update("\0");
  const sorted = [...jars].sort((a, b) => a.jarPath.localeCompare(b.jarPath));
  for (const j of sorted) {
    h.update(j.jarPath).update("\0");
    try {
      const st = fs.statSync(j.jarPath);
      h.update(String(st.size)).update(":").update(String(Math.floor(st.mtimeMs)));
    } catch {
      h.update("missing");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

function cachePath(cacheDir: string): string {
  return path.join(cacheDir, "index-cache.json.gz");
}

export function loadIndexCache(cacheDir: string, signature: string): JarEntries[] | null {
  const file = cachePath(cacheDir);
  if (!fs.existsSync(file)) return null;
  try {
    const json = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
    const parsed = JSON.parse(json) as CacheFile;
    if (parsed.version !== CACHE_VERSION || parsed.signature !== signature) return null;
    return parsed.jarEntries;
  } catch {
    return null;
  }
}

export function saveIndexCache(cacheDir: string, signature: string, jarEntries: JarEntries[]): void {
  const file = cachePath(cacheDir);
  const payload: CacheFile = { version: CACHE_VERSION, signature, jarEntries };
  try {
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 6 }));
  } catch {
    /* cache is best-effort */
  }
}
