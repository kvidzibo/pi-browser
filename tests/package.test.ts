import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("npm package includes native modules and launches its MCP executable from node_modules without Pi peers", async () => {
	const cache = mkdtempSync(join(tmpdir(), "pi-browser-pack-check-"));
	const client = new Client({ name: "packed-launch", version: "1" });
	let transport: StdioClientTransport | undefined;
	try {
		const result = JSON.parse(execFileSync("npm", ["pack", "--pack-destination", cache, "--ignore-scripts", "--json"], {
			cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: cache, npm_config_offline: "true" },
		})) as { filename: string; files: { path: string }[] }[];
		const paths = new Set(result[0].files.map((file) => file.path));
		assert.ok(paths.has("index.ts")); assert.ok(paths.has("README.md"));
		for (const file of paths) {
			assert.ok(!file.startsWith("tests/") && file !== "MEMORY.md");
			if (!/\.(?:ts|js|mjs)$/.test(file)) continue;
			const source = readFileSync(join(root, file), "utf8");
			for (const match of source.matchAll(/["'](\.\.?\/[^"']+\.(?:ts|js|mjs))["']/g)) {
				const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
				assert.ok(paths.has(target), `${file} requires unpacked module ${target}`);
			}
		}
		const installed = join(cache, "node_modules", "@kvidzibo", "pi-browser");
		mkdirSync(installed, { recursive: true });
		execFileSync("tar", ["-xzf", join(cache, result[0].filename), "-C", installed, "--strip-components=1"]);
		// Supply only declared runtime dependencies; no Pi peer packages.
		const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
		for (const dependency of Object.keys(manifest.dependencies)) {
			const dest = join(cache, "node_modules", dependency);
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(join(root, "node_modules", dependency), dest, "dir");
		}
		transport = new StdioClientTransport({ command: process.execPath, args: [join(installed, manifest.bin["pi-browser-mcp"])], env: { HOME: cache, PI_CODING_AGENT_DIR: join(cache, "agent") }, stderr: "pipe" });
		let diagnostics = "";
		transport.stderr?.on("data", (chunk) => { diagnostics += chunk; });
		try { await client.connect(transport, { timeout: 5000 }); }
		catch (error) { throw new Error(`Packed MCP executable failed: ${diagnostics}`, { cause: error }); }
		assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["browser"]);
		const denied = await client.callTool({ name: "browser", arguments: { action: "list_cookies" } });
		assert.equal(denied.isError, true);
		assert.match(JSON.stringify(denied), /interactive MCP form approval/);
	} finally {
		await client.close(); await transport?.close();
		rmSync(cache, { recursive: true, force: true });
	}
});
