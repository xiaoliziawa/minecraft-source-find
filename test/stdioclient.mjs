import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--stdio", "--project", "F:/MyProjects/AE2 Pattern Find"],
});
const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map(t => t.name).join(", "));
const r = await client.callTool({ name: "search_class", arguments: { query: "ItemStack", limit: 2 } });
console.log("search_class ItemStack:", r.content[0].text.replace(/\s+/g," ").slice(0,160));
await client.close();
console.log("OK: stdio transport works.");
