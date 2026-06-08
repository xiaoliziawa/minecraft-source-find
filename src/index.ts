import { randomUUID } from "node:crypto";
import { Command } from "commander";
import express, { Request, Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig, validateConfig, ServerConfig, ResolveMode, TransportKind } from "./config.js";
import { buildServer } from "./server.js";

function log(...args: unknown[]): void {
  // stderr only — stdout is reserved for the stdio MCP protocol.
  console.error("[minecraft-source-mcp]", ...args);
}

function parseCli(): ServerConfig {
  const program = new Command();
  program
    .name("minecraft-source-mcp")
    .description("MCP server serving Minecraft / mod sources (with on-demand decompilation) to AI assistants.")
    .option("--stdio", "使用 stdio 传输（默认）")
    .option("--http", "使用 HTTP(Streamable) 传输，开放本地端口")
    .option("--port <n>", "HTTP 端口", (v) => parseInt(v, 10))
    .option("--host <host>", "HTTP 监听地址，默认 127.0.0.1")
    .option("--project <dir>", "绑定的模组项目目录，默认当前工作目录")
    .option("--gradle-home <dir>", "GradleHome（默认取 GRADLE_USER_HOME 或 ~/.gradle）")
    .option("--resolve <mode>", "作用域解析方式: scan(默认) | gradle")
    .option("--vineflower <jar>", "Vineflower 反编译器 jar 路径")
    .option("--cache-dir <dir>", "反编译与索引缓存目录")
    .allowUnknownOption(true)
    .parse(process.argv);

  const opts = program.opts();
  const transport: TransportKind = opts.http ? "http" : "stdio";
  const resolveMode: ResolveMode = opts.resolve === "gradle" ? "gradle" : "scan";

  return resolveConfig({
    projectDir: opts.project,
    gradleHome: opts.gradleHome,
    resolveMode,
    vineflowerJar: opts.vineflower,
    cacheDir: opts.cacheDir,
    transport,
    host: opts.host,
    port: opts.port,
  });
}

async function runStdio(cfg: ServerConfig): Promise<void> {
  const server = buildServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`stdio 传输已就绪 | project=${cfg.projectDir} | resolve=${cfg.resolveMode}`);
}

async function runHttp(cfg: ServerConfig): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      const server = buildServer(cfg);
      await server.connect(transport);
    } else if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "缺少有效的 mcp-session-id，或首个请求不是 initialize" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send("无效或缺失的 mcp-session-id");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionRequest);
  app.delete("/mcp", sessionRequest);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, project: cfg.projectDir, resolveMode: cfg.resolveMode });
  });

  await new Promise<void>((resolve) => {
    app.listen(cfg.port, cfg.host, () => {
      log(`HTTP(Streamable) 已监听 http://${cfg.host}:${cfg.port}/mcp`);
      log(`健康检查: http://${cfg.host}:${cfg.port}/health`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const cfg = parseCli();
  const errors = validateConfig(cfg);
  for (const e of errors) log("配置警告:", e);

  log(`GradleHome=${cfg.gradleHome}`);
  if (cfg.transport === "http") await runHttp(cfg);
  else await runStdio(cfg);
}

main().catch((e) => {
  log("启动失败:", e);
  process.exit(1);
});
