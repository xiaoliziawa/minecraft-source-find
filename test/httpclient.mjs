import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2] ?? "http://127.0.0.1:4799/mcp");
const transport = new StreamableHTTPClientTransport(url);
const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const status = await client.callTool({ name: "project_status", arguments: {} });
console.log("\nproject_status:\n" + status.content[0].text.split("\n").slice(0, 12).join("\n"));

const search = await client.callTool({ name: "search_class", arguments: { query: "AEItemKey", limit: 3 } });
console.log("\nsearch_class AEItemKey:\n" + search.content[0].text);

const src = await client.callTool({ name: "get_class_source", arguments: { fqcn: "appeng.api.stacks.AEItemKey", maxChars: 300 } });
console.log("\nget_class_source (head):\n" + src.content[0].text.split("\n").slice(0, 8).join("\n"));

await client.close();
console.log("\nOK: HTTP transport works end-to-end.");
