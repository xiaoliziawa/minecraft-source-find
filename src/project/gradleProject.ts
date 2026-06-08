import fs from "node:fs";
import path from "node:path";

export type Loader = "forge" | "neoforge" | "fabric" | "unknown";
export type Mappings = "parchment" | "official" | "mojmap" | "yarn" | "mcp" | "unknown";

export interface Coordinate {
  group: string;
  name: string;
  version: string;
  raw: string;
}

export interface ProjectInfo {
  projectDir: string;
  mcVersion: string | null;
  loader: Loader;
  loaderVersion: string | null;
  mappings: Mappings;
  modId: string | null;
  /** Dependency coordinates discovered in build scripts (best effort, interpolation resolved). */
  coordinates: Coordinate[];
  /** Raw gradle.properties key/values, for diagnostics. */
  properties: Record<string, string>;
  /** Files actually read, for diagnostics. */
  sources: string[];
}

const MC_VERSION_RE = /^(1\.\d{1,2}(?:\.\d{1,2}){0,2})$/;
const MC_TOKEN_RE = /1\.\d{1,2}(?:\.\d{1,2}){0,2}/;

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

/** Resolve ${prop} / $prop using the property map (single pass, then a second to catch chained refs). */
function interpolate(value: string, props: Record<string, string>): string {
  const once = (s: string) =>
    s
      .replace(/\$\{([\w.]+)\}/g, (m, k) => props[k] ?? m)
      .replace(/\$([\w.]+)/g, (m, k) => props[k] ?? m);
  return once(once(value));
}

function detectMappings(text: string, props: Record<string, string>): Mappings {
  const channel = (props["mapping_channel"] ?? props["mappings_channel"] ?? "").toLowerCase();
  if (channel.includes("parchment")) return "parchment";
  if (channel.includes("official") || channel.includes("mojmap")) return "official";
  if (channel.includes("yarn")) return "yarn";
  if (channel.includes("mcp")) return "mcp";
  const lower = text.toLowerCase();
  if (lower.includes("parchment")) return "parchment";
  if (lower.includes("yarn")) return "yarn";
  if (lower.includes("mojmap")) return "official";
  if (lower.includes("mcp")) return "mcp";
  return "unknown";
}

/** Pull "group:name:version[:classifier]" style coordinates out of build script text. */
function extractCoordinates(text: string, props: Record<string, string>): Coordinate[] {
  const out: Coordinate[] = [];
  const seen = new Set<string>();
  // Match quoted dependency notation: 'g:n:v' or "g:n:v" possibly with ${} interpolation.
  const re = /["']([\w.\-]+(?:\.[\w.\-]+)*):([\w.\-]+):([^"':\s]+(?:\$\{[\w.]+\})?[^"':\s]*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const group = interpolate(m[1], props);
    const name = interpolate(m[2], props);
    const version = interpolate(m[3], props);
    const raw = `${group}:${name}:${version}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ group, name, version, raw });
  }
  return out;
}

function deriveMcVersion(props: Record<string, string>, scriptText: string, coords: Coordinate[]): string | null {
  // 1) From a property whose key clearly names the MC version.
  for (const [key, rawVal] of Object.entries(props)) {
    const k = key.toLowerCase();
    if (k === "minecraft" || k === "mc_version" || k === "mcversion" || /minecraft.*version|mc.*version/.test(k)) {
      const v = interpolate(rawVal, props);
      const mm = v.match(MC_TOKEN_RE);
      if (mm) return mm[0];
    }
  }
  // 2) From the mojang/minecraft or forge coordinate (forge: "1.20.1-47.3.7").
  for (const c of coords) {
    if (c.group === "com.mojang" && c.name === "minecraft") {
      const mm = c.version.match(/1\.\d{1,2}(?:\.\d{1,2})?/);
      if (mm) return mm[0];
    }
    if ((c.name === "forge" || c.name === "neoforge") && /^1\.\d/.test(c.version)) {
      const mm = c.version.match(/1\.\d{1,2}(?:\.\d{1,2})?/);
      if (mm) return mm[0];
    }
  }
  // 3) Any property value that is exactly an MC version.
  for (const rawVal of Object.values(props)) {
    const v = interpolate(rawVal, props);
    if (MC_VERSION_RE.test(v)) return v;
  }
  // 4) Last resort: scan the script for a minecraft coordinate version.
  const mm = scriptText.match(/com\.mojang:minecraft:\$?\{?[\w.]*?(1\.\d{1,2}(?:\.\d{1,2})?)/);
  return mm ? mm[1] : null;
}

function deriveLoader(scriptText: string, coords: Coordinate[], props: Record<string, string>): { loader: Loader; version: string | null } {
  const lower = scriptText.toLowerCase();
  // NeoForge
  for (const c of coords) {
    if (c.group === "net.neoforged" && (c.name === "neoforge" || c.name === "neoforge-moddev")) {
      return { loader: "neoforge", version: c.version };
    }
  }
  if (lower.includes("net.neoforged") || lower.includes("neoforge") || props["neo_version"] || props["neoforge_version"]) {
    return { loader: "neoforge", version: props["neo_version"] ?? props["neoforge_version"] ?? null };
  }
  // Forge
  for (const c of coords) {
    if (c.group === "net.minecraftforge" && c.name === "forge") {
      return { loader: "forge", version: c.version };
    }
  }
  // Fabric (loom plugin)
  if (lower.includes("fabric-loom") || lower.includes("net.fabricmc")) {
    return { loader: "fabric", version: props["loader_version"] ?? props["fabric_loader_version"] ?? null };
  }
  if (lower.includes("net.minecraftforge") || props["forge_version"]) {
    return { loader: "forge", version: props["forge_version"] ?? null };
  }
  return { loader: "unknown", version: null };
}

export function parseProject(projectDir: string): ProjectInfo {
  const sources: string[] = [];
  const props: Record<string, string> = {};

  // gradle.properties (root + any parent up to 2 levels for composite builds is overkill; keep root).
  const propsFile = path.join(projectDir, "gradle.properties");
  const propsText = readIfExists(propsFile);
  if (propsText !== null) {
    Object.assign(props, parseProperties(propsText));
    sources.push(propsFile);
  }

  // Build scripts.
  let scriptText = "";
  for (const name of ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"]) {
    const file = path.join(projectDir, name);
    const text = readIfExists(file);
    if (text !== null) {
      scriptText += "\n" + text;
      sources.push(file);
    }
  }

  const coordinates = extractCoordinates(scriptText, props);
  const mcVersion = deriveMcVersion(props, scriptText, coordinates);
  const { loader, version: loaderVersion } = deriveLoader(scriptText, coordinates, props);
  const mappings = detectMappings(scriptText, props);
  const modId =
    props["mod_id"] ?? props["modid"] ?? props["mod_name"] ?? props["archives_base_name"] ?? null;

  return {
    projectDir,
    mcVersion,
    loader,
    loaderVersion,
    mappings,
    modId,
    coordinates,
    properties: props,
    sources,
  };
}
