import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--stdio", "--gradle-home", "D:/GradleHome", "--project", "F:/MyProjects/AE2 Pattern Find"],
});
const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("TOOLS (" + tools.tools.length + "):", tools.tools.map(t=>t.name).join(", "));
const r = await client.callTool({ name: "find_references", arguments: { target: "appeng.api.stacks.AEItemKey", callerPackage: "appeng", limit: 4 } });
console.log("\nfind_references AEItemKey:\n" + r.content[0].text.split("\n").slice(0,8).join("\n"));
const i = await client.callTool({ name: "find_implementations", arguments: { fqcn: "appeng.api.stacks.AEKey" } });
console.log("\nfind_implementations AEKey:\n" + i.content[0].text);
await client.close();
console.log("\nOK");
