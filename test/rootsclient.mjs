import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// 模拟 Claude Code：声明 roots 能力，提供工作区根，且不向子进程传 --project
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--stdio", "--gradle-home", "D:/GradleHome"],
  cwd: "F:/MyProjects/minecraft-source-find", // 故意把 cwd 设成本工具目录而非模组项目
});
const client = new Client(
  { name: "probe", version: "1.0.0" },
  { capabilities: { roots: {} } }
);
client.setRequestHandler(
  (await import("@modelcontextprotocol/sdk/types.js")).ListRootsRequestSchema,
  async () => ({ roots: [{ uri: "file:///F:/MyProjects/AE2 Pattern Find", name: "AE2 Pattern Find" }] })
);
await client.connect(transport);
const st = await client.callTool({ name: "project_status", arguments: {} });
const txt = st.content[0].text;
const j = JSON.parse(txt);
console.log("projectDir:", j.projectDir);
console.log("mcVersion:", j.minecraftVersion, "| loader:", j.loader, "| jars:", j.jarsInScope);
console.log("warnings:", JSON.stringify(j.warnings));
await client.close();
