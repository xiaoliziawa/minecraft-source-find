import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const INIT_SCRIPT = `
gradle.projectsEvaluated {
  rootProject.allprojects { p ->
    p.configurations.findAll { it.canBeResolved }.each { c ->
      try {
        c.resolvedConfiguration.lenientConfiguration.allModuleDependencies.each { d ->
          d.allModuleArtifacts.each { a ->
            println "MCSRC_JAR\\t" + a.file.absolutePath
          }
        }
      } catch (ignored) {}
    }
  }
}
`;

function gradleWrapper(projectDir: string): string | null {
  const bat = path.join(projectDir, "gradlew.bat");
  const sh = path.join(projectDir, "gradlew");
  if (process.platform === "win32" && fs.existsSync(bat)) return bat;
  if (fs.existsSync(sh)) return sh;
  return null;
}

/**
 * Ask Gradle for the exact resolved jar paths across all resolvable configurations.
 * Repo-agnostic by nature. Returns absolute jar paths, or throws on failure.
 */
export function resolveJarPaths(projectDir: string, timeoutMs = 180000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const wrapper = gradleWrapper(projectDir);
    const initFile = path.join(os.tmpdir(), `mcsrc-init-${process.pid}.gradle`);
    fs.writeFileSync(initFile, INIT_SCRIPT, "utf8");

    const cmd = wrapper ?? "gradle";
    const args = ["--init-script", initFile, "-q", "help"];
    const child = spawn(cmd, args, {
      cwd: projectDir,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Gradle 解析超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      try { fs.rmSync(initFile, { force: true }); } catch { /* ignore */ }
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try { fs.rmSync(initFile, { force: true }); } catch { /* ignore */ }
      const paths = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const idx = line.indexOf("MCSRC_JAR\t");
        if (idx >= 0) {
          const p = line.slice(idx + "MCSRC_JAR\t".length).trim();
          if (p.endsWith(".jar")) paths.add(p);
        }
      }
      if (paths.size === 0 && code !== 0) {
        reject(new Error(`Gradle 解析失败 (退出码 ${code}): ${stderr.slice(0, 400)}`));
        return;
      }
      resolve([...paths]);
    });
  });
}
