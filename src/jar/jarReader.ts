import AdmZip from "adm-zip";

interface CachedZip {
  zip: AdmZip;
  atime: number;
}

const MAX_OPEN = 12;
const cache = new Map<string, CachedZip>();

function openZip(jarPath: string): AdmZip {
  const cached = cache.get(jarPath);
  if (cached) {
    cached.atime = performance.now();
    return cached.zip;
  }
  const zip = new AdmZip(jarPath);
  cache.set(jarPath, { zip, atime: performance.now() });
  if (cache.size > MAX_OPEN) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, val] of cache) {
      if (val.atime < oldest) {
        oldest = val.atime;
        oldestKey = key;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  return zip;
}

export interface ZipEntryInfo {
  /** Forward-slash path inside the jar. */
  path: string;
  isDirectory: boolean;
}

/** List all non-directory entry paths in a jar. */
export function listEntries(jarPath: string): ZipEntryInfo[] {
  const zip = openZip(jarPath);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => ({ path: e.entryName, isDirectory: false }));
}

/** Read a single text entry; returns null if absent. */
export function readTextEntry(jarPath: string, entryPath: string): string | null {
  const zip = openZip(jarPath);
  const entry = zip.getEntry(entryPath);
  if (!entry) return null;
  return zip.readAsText(entry, "utf8");
}

/** Read a single binary entry; returns null if absent. */
export function readBinaryEntry(jarPath: string, entryPath: string): Buffer | null {
  const zip = openZip(jarPath);
  const entry = zip.getEntry(entryPath);
  if (!entry) return null;
  return entry.getData();
}

export function clearZipCache(): void {
  cache.clear();
}
