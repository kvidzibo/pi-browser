import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("npm package includes and factory-loads the native Pi extension from node_modules", async () => {
	const cache = mkdtempSync(join(tmpdir(), "pi-browser-pack-check-"));
	try {
		const result = JSON.parse(execFileSync("npm", ["pack", "--pack-destination", cache, "--ignore-scripts", "--json"], {
			cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: cache, npm_config_offline: "true" },
		})) as { filename: string; files: { path: string }[] }[];
		const paths = new Set(result[0].files.map((file) => file.path));
		assert.ok(paths.has("index.ts")); assert.ok(paths.has("README.md"));
		for (const file of paths) {
			assert.ok(!file.startsWith("tests/") && file !== "MEMORY.md");
			assert.ok(!file.startsWith("mcp/") && !file.startsWith("dist-mcp/") && file !== "docs/mcp.md");
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
		const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
		assert.equal(manifest.bin, undefined);
		assert.deepEqual(Object.keys(manifest.dependencies), ["patchright-core"]);
		assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
		// Supply declared runtime dependencies and the native host's optional peers.
		for (const dependency of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)]) {
			const dest = join(cache, "node_modules", dependency);
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(join(root, "node_modules", dependency), dest, "dir");
		}
		const loader = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core", "extensions", "loader.js");
		const { loadExtensions } = await import(pathToFileURL(loader).href);
		const loaded = await loadExtensions(manifest.pi.extensions.map((file: string) => join(installed, file)), cache);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		assert.deepEqual([...loaded.extensions[0].tools.keys()], ["browser"]);
		assert.deepEqual([...loaded.extensions[0].commands.keys()], ["browser", "pi-browser"]);
		const tool = loaded.extensions[0].tools.get("browser").definition;
		await assert.rejects(tool.execute("packed", { action: "list_cookies" }, undefined, undefined, { hasUI: false, mode: "print" }), /interactive approval/);
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});
